import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { longestBudgetWindowMs, revokeDevicesForSession } from "./auth";
import { grantMatches } from "./completions";
import { deleteAttachments, deleteBlob } from "./feedback";
import { activityPhase, isTerminalPhase } from "./lib/model";

const batchSize = 100;

/** Walks every completion one batch per run, returning rows whose grant is gone or now belongs to another enrollment. */
async function orphanedCompletionsPage(ctx: MutationCtx): Promise<Doc<"completions">[]> {
  const sweep = await ctx.db.query("pruneCursors")
    .withIndex("by_table", (query) => query.eq("table", "completions")).unique();
  const page = await ctx.db.query("completions").paginate({ cursor: sweep?.cursor ?? null, numItems: batchSize });
  if (page.isDone) {
    if (sweep) await ctx.db.delete(sweep._id);
  } else if (sweep) {
    await ctx.db.patch(sweep._id, { cursor: page.continueCursor });
  } else {
    await ctx.db.insert("pruneCursors", { table: "completions", cursor: page.continueCursor });
  }
  const grants = new Map<string, Doc<"publisherGrants"> | null>();
  const orphans: Doc<"completions">[] = [];
  for (const completion of page.page) {
    if (!grants.has(completion.grantId)) grants.set(completion.grantId, await ctx.db.get(completion.grantId));
    const grant = grants.get(completion.grantId);
    if (!grant || !grantMatches(grant, completion)) orphans.push(completion);
  }
  return orphans;
}

/** Deletes one bounded batch per expiration category; `full` means some category may still hold eligible rows. */
async function prunePass(ctx: MutationCtx) {
  const now = Date.now();
  const oldJobCutoff = now - 7 * 24 * 60 * 60 * 1_000;
  const retiredCutoff = now - 30 * 24 * 60 * 60 * 1_000;
  const [nonces, userSessions, appleTokens, invitations, sessions, expiredActivities, doneJobs, keys, pendingKeys, devices, activities, deadJobs, staleJobs, acknowledgedCompletions, deliveredFeedback, pendingFeedback, staleAttachments, rateLimits] = await Promise.all([
    ctx.db
      .query("publisherNonces")
      .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
      .take(batchSize),
    ctx.db
      .query("userSessions")
      .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
      .take(batchSize),
    ctx.db
      .query("appleIdentityTokens")
      .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
      .take(batchSize),
    ctx.db
      .query("publisherInvitations")
      .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
      .take(batchSize),
    ctx.db
      .query("sessionStates")
      .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
      .take(batchSize),
    ctx.db
      .query("sessionStates")
      .withIndex("by_activity_expires_at", (query) => query.gt("activityExpiresAt", 0).lt("activityExpiresAt", now))
      .take(batchSize),
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "done").lt("updatedAt", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("publisherKeys")
      .withIndex("by_revoked_at", (query) =>
        query.gt("revokedAt", 0).lt("revokedAt", retiredCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("publisherKeys")
      .withIndex("by_activated_at_and_created_at", (query) =>
        query.eq("activatedAt", undefined).lt("createdAt", retiredCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("devices")
      .withIndex("by_revoked_at", (query) =>
        query.gt("revokedAt", 0).lt("revokedAt", retiredCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("liveActivities")
      .withIndex("by_ended_at", (query) =>
        query.gt("endedAt", 0).lt("endedAt", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "dead").lt("updatedAt", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "stale").lt("updatedAt", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("completions")
      .withIndex("by_acknowledged", (query) =>
        query.eq("acknowledged", true).lt("_creationTime", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("feedbackReports")
      .withIndex("by_status_and_delivered_at", (query) =>
        query.eq("status", "delivered").lt("deliveredAt", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("feedbackReports")
      .withIndex("by_status_and_created_at", (query) =>
        query.eq("status", "pending").lt("createdAt", retiredCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("feedbackAttachments")
      .withIndex("by_status_and_created_at", (query) =>
        query.eq("status", "stored").lt("createdAt", oldJobCutoff),
      )
      .take(batchSize),
    ctx.db
      .query("authRateLimits")
      .withIndex("by_window_started_at", (query) => query.lt("windowStartedAt", now - longestBudgetWindowMs))
      .take(batchSize),
  ]);
  const full = [nonces, userSessions, appleTokens, invitations, sessions, expiredActivities, doneJobs, keys, pendingKeys, devices, activities, deadJobs, staleJobs, acknowledgedCompletions, deliveredFeedback, pendingFeedback, staleAttachments, rateLimits]
    .some((rows) => rows.length === batchSize);
  let revokedDevices = 0;
  for (const state of expiredActivities) {
    await ctx.db.patch(state._id, { activityExpiresAt: undefined,
      ...(!state.deleted && !isTerminalPhase(activityPhase(state, now)) ? { activityPhase: "stale" as const } : {}) });
  }
  // An undelivered report keeps its text for 30 days but its files for seven.
  for (const attachment of staleAttachments) {
    await deleteBlob(ctx, attachment);
    await ctx.db.patch(attachment._id, { status: "missing", storageId: undefined });
  }
  for (const report of [...deliveredFeedback, ...pendingFeedback]) await deleteAttachments(ctx, report._id);
  for (const session of userSessions) {
    revokedDevices += await revokeDevicesForSession(ctx, session.userId, session.sessionId, now);
  }
  const documents = [
    ...nonces,
    ...userSessions,
    ...appleTokens,
    ...invitations,
    ...sessions,
    ...doneJobs,
    ...deadJobs,
    ...staleJobs,
    ...keys,
    ...pendingKeys,
    ...devices,
    ...activities,
    ...acknowledgedCompletions,
    ...deliveredFeedback,
    ...pendingFeedback,
    ...rateLimits,
    ...(await orphanedCompletionsPage(ctx)),
  ];
  const uniqueDocuments = [...new Map(documents.map((document) => [document._id, document])).values()];
  for (const document of uniqueDocuments) await ctx.db.delete(document._id);
  const affectedUsers = new Set(
    [...sessions, ...expiredActivities].flatMap((session) => session.userId ? [session.userId] : []),
  );
  for (const userId of affectedUsers) {
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId });
  }
  return { deleted: uniqueDocuments.length, revokedDevices, full };
}

async function drainOwnerIsLive(ctx: MutationCtx, drain: Doc<"pruneDrains"> | null) {
  if (!drain?.scheduledId) return false;
  const state = (await ctx.db.system.get(drain.scheduledId))?.state.kind;
  return state === "pending" || state === "inProgress";
}

export const prune = internalMutation({
  args: { generation: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), revokedDevices: v.number() }),
  handler: async (ctx, args) => {
    const drain = await ctx.db.query("pruneDrains").first();
    // A continuation runs only while it holds the current lease; a cron trigger yields to a live owner
    // and takes over one that failed or was canceled.
    const skip = args.generation === undefined
      ? await drainOwnerIsLive(ctx, drain)
      : drain?.generation !== args.generation;
    if (skip) return { deleted: 0, revokedDevices: 0 };
    const { full, ...result } = await prunePass(ctx);
    if (full) {
      const generation = (drain?.generation ?? 0) + 1;
      const scheduledId = await ctx.scheduler.runAfter(0, internal.cleanup.prune, { generation });
      if (drain) await ctx.db.patch(drain._id, { generation, scheduledId });
      else await ctx.db.insert("pruneDrains", { generation, scheduledId });
    } else if (drain?.scheduledId) {
      await ctx.db.patch(drain._id, { scheduledId: undefined });
    }
    return result;
  },
});
