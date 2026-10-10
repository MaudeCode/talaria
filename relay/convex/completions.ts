import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { isTerminalPhase, type SessionState } from "./lib/model";
import { rowForState } from "./lib/aggregate";
import { aggregateRowValidator } from "./lib/validators";

export async function recordCompletion(
  ctx: MutationCtx, grant: Doc<"publisherGrants">, state: SessionState, runKey: string,
): Promise<void> {
  if (state.deleted || !isTerminalPhase(state.phase)) return;
  const key = JSON.stringify([grant.publisherOwnerUserId, grant.profileId, state.sessionId, runKey]);
  const existing = await ctx.db.query("completions")
    .withIndex("by_grant_id_and_run_key", (q) => q.eq("grantId", grant._id).eq("runKey", key))
    .unique();
  if (existing) {
    if (state.revision <= (existing.revision ?? -1)) return;
    const changed = state.phase !== existing.row.phase || state.title !== existing.row.title
      || state.publisherLabel !== existing.row.publisherLabel || state.deepLink !== existing.row.deepLink;
    // Advance source ordering without turning heartbeat timestamps into new outcomes.
    // A corrected result keeps the same run identity and acknowledgement.
    await ctx.db.patch(existing._id, {
      revision: state.revision,
      ...(changed ? { row: rowForState(state) } : {}),
    });
    return;
  }
  await ctx.db.insert("completions", {
    userId: grant.userId, grantId: grant._id, profileId: grant.profileId, publisherOwnerUserId: grant.publisherOwnerUserId,
    runKey: key, revision: state.revision, acknowledged: false, row: rowForState(state),
  });
}

export function grantMatches(grant: Doc<"publisherGrants">, row: Doc<"completions">): boolean {
  return grant.userId === row.userId && grant.profileId === row.profileId
    && grant.publisherId === row.row.publisherId && grant.publisherOwnerUserId === row.publisherOwnerUserId;
}

async function visibleCompletions(
  ctx: QueryCtx | MutationCtx, rows: Doc<"completions">[],
): Promise<Doc<"completions">[]> {
  const grants = new Map<string, Doc<"publisherGrants"> | null>();
  const enabled = new Map<string, boolean>();
  const visible: Doc<"completions">[] = [];
  for (const row of rows) {
    if (!grants.has(row.grantId)) grants.set(row.grantId, await ctx.db.get(row.grantId));
    const grant = grants.get(row.grantId);
    if (grant && grantMatches(grant, row)) {
      if (!enabled.has(grant._id)) {
        const publisher = await ctx.db.query("publishers")
          .withIndex("by_version_and_owner_user_id_and_publisher_id", (q) => q.eq("version", 2)
            .eq("ownerUserId", grant.publisherOwnerUserId).eq("publisherId", grant.publisherId)).unique();
        enabled.set(grant._id, publisher?.enabled === true);
      }
      if (enabled.get(grant._id)) visible.push(row);
    }
  }
  return visible;
}

export async function retainedStates(ctx: QueryCtx | MutationCtx, userId: string): Promise<SessionState[]> {
  // ponytail: the activity considers the latest 500 pending outcomes; the paginated inbox retains access to every run.
  const rows = await ctx.db.query("completions")
    .withIndex("by_user_id_and_acknowledged", (q) => q.eq("userId", userId).eq("acknowledged", false))
    .order("desc").take(500);
  return (await visibleCompletions(ctx, rows)).map((record) => {
    const { status: _status, ...row } = record.row;
    return { ...row, deleted: false, receivedAt: row.updatedAt,
      completionId: record._id, eventId: record.runKey, revision: 0,
      expiresAt: Number.MAX_SAFE_INTEGER, terminalExpiresAt: Number.MAX_SAFE_INTEGER };
  });
}

async function deviceExclusions(ctx: QueryCtx | MutationCtx, userId: string, deviceId: string) {
  const device = await ctx.db.query("devices")
    .withIndex("by_user_id_and_device_id", (q) => q.eq("userId", userId).eq("deviceId", deviceId)).unique();
  if (!device || device.revokedAt !== undefined || (device.sessionExpiresAt ?? Infinity) <= Date.now()) return null;
  const excluded = await ctx.db.query("devicePublisherExclusions")
    .withIndex("by_user_id_and_device_id_and_publisher_id", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .take(1_001);
  if (excluded.length > 1_000) return null;
  return new Set(excluded.map((row) => row.publisherId));
}

export const list = internalQuery({
  args: { userId: v.string(), deviceId: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.union(v.null(), v.object({
    completions: v.array(v.object({ id: v.id("completions"), row: aggregateRowValidator })),
    cursor: v.union(v.string(), v.null()),
  })),
  handler: async (ctx, args) => {
    const excluded = await deviceExclusions(ctx, args.userId, args.deviceId);
    if (!excluded) return null;
    const page = await ctx.db.query("completions")
      .withIndex("by_user_id_and_acknowledged", (q) => q.eq("userId", args.userId).eq("acknowledged", false))
      .order("desc").paginate({ ...args.paginationOpts, numItems: Math.min(100, args.paginationOpts.numItems) });
    const rows = await visibleCompletions(ctx, page.page);
    return {
      completions: rows.filter((r) => !excluded.has(r.row.publisherId)).map((r) => ({ id: r._id, row: r.row })),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const acknowledge = internalMutation({
  args: { userId: v.string(), deviceId: v.string(), ids: v.array(v.string()) },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.ids.length > 100) return { ok: false };
    const excluded = await deviceExclusions(ctx, args.userId, args.deviceId);
    if (!excluded) return { ok: false };
    const normalized = [...new Set(args.ids)].map((id) => ctx.db.normalizeId("completions", id));
    if (normalized.some((id) => id === null)) return { ok: false };
    const records = await Promise.all(normalized.map((id) => ctx.db.get(id!)));
    if (records.some((r) => !r || r.userId !== args.userId || excluded.has(r.row.publisherId))) return { ok: false };
    const rows = records as Doc<"completions">[];
    if ((await visibleCompletions(ctx, rows)).length !== rows.length) return { ok: false };
    for (const row of rows) if (!row.acknowledged) await ctx.db.patch(row._id, { acknowledged: true });
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: args.userId });
    return { ok: true };
  },
});
