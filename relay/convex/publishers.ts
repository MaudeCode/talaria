import { v } from "convex/values";

import { recordCompletion, retainedStates } from "./completions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { isTerminalPhase, type SessionPhase } from "./lib/model";
import {
  sessionStateContentValidator,
  sessionStateInputValidator,
  storedSessionStateValidator,
} from "./lib/validators";

const publisherRequestArgs = {
  publisherOwnerUserId: v.string(),
  publisherId: v.string(),
  profileId: v.string(),
  keyId: v.string(),
  nonce: v.string(),
  nonceExpiresAt: v.number(),
  receivedAt: v.number(),
};

const acceptResultValidator = v.object({
  status: v.union(
    v.literal("accepted"),
    v.literal("duplicate"),
    v.literal("stale"),
    v.literal("replay"),
    v.literal("unauthorized"),
  ),
});

function expiryForPhase(phase: SessionPhase, now: number) {
  if (isTerminalPhase(phase)) {
    const terminalExpiresAt = now + 15 * 60 * 1_000;
    return { expiresAt: terminalExpiresAt, terminalExpiresAt };
  }
  return { expiresAt: now + 3 * 60 * 1_000 };
}

function expiryForState(
  current: Doc<"sessionStates"> | null | undefined,
  next: { phase: SessionPhase; streamId?: string },
  now: number,
) {
  if (
    current &&
    !current.deleted &&
    isTerminalPhase(current.phase) &&
    current.phase === next.phase &&
    next.streamId !== undefined &&
    next.streamId === current.streamId &&
    current.terminalExpiresAt !== undefined
  ) {
    return { expiresAt: current.expiresAt, terminalExpiresAt: current.terminalExpiresAt };
  }
  return expiryForPhase(next.phase, now);
}

// Ineligibility belongs to the phase transition that carried it, so same-phase updates of the same run inherit it
// until the phase changes. A new stream is a new run and starts from its own value.
function alertEligibleForState(
  current: Doc<"sessionStates"> | null | undefined,
  next: { phase: SessionPhase; streamId?: string; alertEligible?: boolean },
): boolean | undefined {
  return current && !current.deleted && current.phase === next.phase && current.streamId === next.streamId
    && current.alertEligible === false ? false : next.alertEligible;
}

// The phase a delivery transition starts from. A first publication, a re-created session, or a new run that begins in
// the same phase has none: it never alerts, but it still carries eligibility to delivery.
function previousPhaseFor(current: Doc<"sessionStates"> | null | undefined, next: { phase: SessionPhase; streamId?: string }): SessionPhase | undefined {
  if (!current || current.deleted) return undefined;
  return current.phase === next.phase && current.streamId !== next.streamId ? undefined : current.phase;
}

function stateRunKey(current: Doc<"sessionStates"> | null | undefined, next: { streamId?: string; phase: SessionPhase; eventId: string }): string {
  return next.streamId ?? (current && !(isTerminalPhase(current.phase) && !isTerminalPhase(next.phase))
    ? current.runKey ?? current.eventId : next.eventId);
}

async function backfillCompletion(ctx: MutationCtx, grant: Doc<"publisherGrants">, state: Doc<"sessionStates">): Promise<boolean> {
  if (state.deleted || state.profileId !== grant.profileId || !isTerminalPhase(state.phase)) return false;
  const runKey = stateRunKey(state, state);
  await recordCompletion(ctx, grant, state, runKey);
  if (state.runKey === undefined) await ctx.db.patch(state._id, { runKey });
  return state.runKey === undefined;
}

function exposedState(state: Doc<"sessionStates">) {
  return {
    deleted: state.deleted,
    publisherId: state.publisherId,
    publisherLabel: state.publisherLabel,
    sessionId: state.sessionId,
    streamId: state.streamId,
    eventId: state.eventId,
    revision: state.revision,
    title: state.title,
    phase: state.phase,
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
    expiresAt: state.expiresAt,
    terminalExpiresAt: state.terminalExpiresAt,
    alertEligible: state.alertEligible,
    receivedAt: state.receivedAt,
  };
}

async function authorizePublisherMutation(
  ctx: MutationCtx,
  args: {
    publisherOwnerUserId: string;
    publisherId: string;
    keyId: string;
    nonce: string;
    nonceExpiresAt: number;
    receivedAt: number;
  },
): Promise<{ label: string } | null | "replay"> {
  const [publisher, key, nonce] = await Promise.all([
    ctx.db.query("publishers")
      .withIndex("by_version_and_owner_user_id_and_publisher_id", (query) =>
        query.eq("version", 2).eq("ownerUserId", args.publisherOwnerUserId).eq("publisherId", args.publisherId),
      ).unique(),
    ctx.db.query("publisherKeys")
      .withIndex("by_version_and_key_id", (query) =>
        query.eq("version", 2).eq("keyId", args.keyId),
      ).unique(),
    ctx.db.query("publisherNonces")
      .withIndex("by_version_and_owner_user_id_and_publisher_id_and_nonce", (query) =>
        query.eq("version", 2).eq("ownerUserId", args.publisherOwnerUserId)
          .eq("publisherId", args.publisherId).eq("nonce", args.nonce),
      ).unique(),
  ]);
  if (
    !publisher?.enabled
    || !key
    || key.ownerUserId !== args.publisherOwnerUserId
    || key.publisherId !== args.publisherId
    || key.revokedAt !== undefined
  ) {
    return null;
  }
  if (nonce) return "replay";
  if (key.activatedAt === undefined) {
    const keys = await ctx.db.query("publisherKeys")
      .withIndex("by_version_and_owner_user_id_and_publisher_id", (query) =>
        query.eq("version", 2).eq("ownerUserId", args.publisherOwnerUserId).eq("publisherId", args.publisherId),
      ).take(500);
    for (const candidate of keys) {
      if (candidate._id === key._id) await ctx.db.patch(candidate._id, { activatedAt: args.receivedAt });
      else if (candidate.revokedAt === undefined) await ctx.db.patch(candidate._id, { revokedAt: args.receivedAt });
    }
  }
  await ctx.db.insert("publisherNonces", {
    version: 2,
    ownerUserId: args.publisherOwnerUserId,
    publisherId: args.publisherId,
    nonce: args.nonce,
    expiresAt: args.nonceExpiresAt,
    createdAt: args.receivedAt,
  });
  return { label: publisher.label };
}

async function grantsForProfile(
  ctx: MutationCtx,
  publisherOwnerUserId: string,
  publisherId: string,
  profileId: string,
) {
  return await ctx.db.query("publisherGrants")
    .withIndex("by_publisher_owner_user_id_and_publisher_id_and_profile_id", (query) =>
      query.eq("publisherOwnerUserId", publisherOwnerUserId)
        .eq("publisherId", publisherId).eq("profileId", profileId),
    ).take(500);
}

export const acceptState = internalMutation({
  args: {
    ...publisherRequestArgs,
    sessionId: v.string(),
    eventId: v.string(),
    revision: v.number(),
    state: v.union(v.null(), sessionStateContentValidator),
  },
  returns: acceptResultValidator,
  handler: async (ctx, args) => {
    const authorization = await authorizePublisherMutation(ctx, args);
    if (authorization === null) return { status: "unauthorized" as const };
    if (authorization === "replay") return { status: "replay" as const };

    let accepted = false;
    let duplicate = false;
    for (const grant of await grantsForProfile(
      ctx,
      args.publisherOwnerUserId,
      args.publisherId,
      args.profileId,
    )) {
      const existing = await ctx.db.query("sessionStates")
        .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("version", 2).eq("userId", grant.userId)
            .eq("publisherId", args.publisherId).eq("sessionId", args.sessionId),
        ).unique();
      if (existing?.eventId === args.eventId) {
        if (await backfillCompletion(ctx, grant, existing)) {
          await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: grant.userId });
        }
        duplicate = true;
        continue;
      }
      if (existing && args.revision <= existing.revision) continue;
      if (!existing) {
        const states = await ctx.db.query("sessionStates")
          .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
            query.eq("version", 2).eq("userId", grant.userId).eq("publisherId", args.publisherId),
          ).take(500);
        if (states.length >= 500) continue;
      }

      const previousPhase = args.state ? previousPhaseFor(existing, args.state) : existing?.deleted ? undefined : existing?.phase;
      const next = args.state
        ? {
            deleted: false,
            version: 2,
            userId: grant.userId,
            profileId: args.profileId,
            publisherId: args.publisherId,
            publisherLabel: authorization.label,
            eventId: args.eventId,
            revision: args.revision,
            ...args.state,
            alertEligible: alertEligibleForState(existing, args.state),
            runKey: stateRunKey(existing, { ...args.state, eventId: args.eventId }),
            ...expiryForState(existing, args.state, args.receivedAt),
            receivedAt: args.receivedAt,
          }
        : {
            deleted: true,
            version: 2,
            userId: grant.userId,
            profileId: args.profileId,
            publisherId: args.publisherId,
            publisherLabel: authorization.label,
            sessionId: args.sessionId,
            eventId: args.eventId,
            revision: args.revision,
            title: existing?.title ?? "Session",
            phase: existing?.phase ?? ("stale" as const),
            updatedAt: args.receivedAt,
            deepLink: existing?.deepLink ?? "/",
            expiresAt: args.receivedAt,
            receivedAt: args.receivedAt,
          };
      if (args.state) await recordCompletion(ctx, grant, next, stateRunKey(existing, { ...args.state, eventId: args.eventId }));
      if (existing) await ctx.db.replace(existing._id, next);
      else await ctx.db.insert("sessionStates", next);
      await ctx.scheduler.runAfter(0, internal.delivery.recompute, {
        userId: grant.userId,
        transitions: args.state
          ? [{ publisherId: args.publisherId, sessionId: args.sessionId, previousPhase, state: exposedState(next as Doc<"sessionStates">) }]
          : previousPhase === undefined ? [] : [{ publisherId: args.publisherId, sessionId: args.sessionId, previousPhase }],
      });
      accepted = true;
    }
    return { status: accepted ? "accepted" as const : duplicate ? "duplicate" as const : "stale" as const };
  },
});

export const acceptSnapshot = internalMutation({
  args: {
    ...publisherRequestArgs,
    snapshotId: v.string(),
    states: v.array(sessionStateInputValidator),
  },
  returns: acceptResultValidator,
  handler: async (ctx, args) => {
    if (args.states.length > 500) throw new Error("snapshot_too_large");
    if (new Set(args.states.map((state) => state.sessionId)).size !== args.states.length) {
      throw new Error("duplicate_snapshot_session");
    }
    const authorization = await authorizePublisherMutation(ctx, args);
    if (authorization === null) return { status: "unauthorized" as const };
    if (authorization === "replay") return { status: "replay" as const };

    for (const grant of await grantsForProfile(
      ctx,
      args.publisherOwnerUserId,
      args.publisherId,
      args.profileId,
    )) {
      const existing = await ctx.db.query("sessionStates")
        .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("version", 2).eq("userId", grant.userId).eq("publisherId", args.publisherId),
        ).take(500);
      const bySessionId = new Map(existing.map((state) => [state.sessionId, state]));
      const transitions: {
        publisherId: string;
        sessionId: string;
        previousPhase?: SessionPhase;
        state: ReturnType<typeof exposedState>;
      }[] = [];
      for (const state of args.states) {
        const current = bySessionId.get(state.sessionId);
        if (current && state.revision < current.revision) continue;
        if (current && state.revision === current.revision) {
          await backfillCompletion(ctx, grant, current);
          await ctx.db.patch(current._id, {
            ...(isTerminalPhase(current.phase) ? {} : expiryForPhase(current.phase, args.receivedAt)),
            receivedAt: args.receivedAt,
          });
          continue;
        }
        const next = {
          deleted: false,
          version: 2,
          userId: grant.userId,
          profileId: args.profileId,
          publisherId: args.publisherId,
          publisherLabel: authorization.label,
          ...state,
          alertEligible: alertEligibleForState(current, state),
          runKey: stateRunKey(current, state),
          ...expiryForState(current, state, args.receivedAt),
          receivedAt: args.receivedAt,
        };
        // A newly suppressed same-phase update is also delivered as a (non-alerting) transition so delivery can
        // record the deferral and revalidate any queued alert for it.
        if (!current || current.phase !== state.phase || current.streamId !== state.streamId
          || (next.alertEligible === false && current.alertEligible !== false)) {
          transitions.push({
            publisherId: args.publisherId,
            sessionId: state.sessionId,
            previousPhase: previousPhaseFor(current, state),
            state: exposedState(next as Doc<"sessionStates">),
          });
        }
        await recordCompletion(ctx, grant, next, next.runKey);
        if (current) await ctx.db.replace(current._id, next);
        else await ctx.db.insert("sessionStates", next);
      }
      await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: grant.userId, transitions });
    }
    return { status: "accepted" as const };
  },
});

export const acknowledgeViewedSession = internalMutation({
  args: { ...publisherRequestArgs, sessionId: v.string(), through: v.number() },
  returns: v.object({
    status: v.union(v.literal("accepted"), v.literal("replay"), v.literal("unauthorized")),
    acknowledged: v.number(),
  }),
  handler: async (ctx, args) => {
    const authorization = await authorizePublisherMutation(ctx, args);
    if (authorization === null) return { status: "unauthorized" as const, acknowledged: 0 };
    if (authorization === "replay") return { status: "replay" as const, acknowledged: 0 };
    // `through` and each row's `updatedAt` share the publisher's clock, so relay time never bounds them.
    let acknowledged = 0;
    for (const grant of await grantsForProfile(ctx, args.publisherOwnerUserId, args.publisherId, args.profileId)) {
      // ponytail: one session holds far fewer than 500 pending runs; page here if that changes.
      const viewed = (await ctx.db.query("completions")
        .withIndex("by_grant_id_and_session_id_and_acknowledged", (query) =>
          query.eq("grantId", grant._id).eq("row.sessionId", args.sessionId).eq("acknowledged", false))
        .take(500)).filter((completion) => completion.row.updatedAt <= args.through);
      for (const completion of viewed) await ctx.db.patch(completion._id, { acknowledged: true });
      if (viewed.length > 0) await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: grant.userId });
      acknowledged += viewed.length;
    }
    return { status: "accepted" as const, acknowledged };
  },
});

// The event is authorized only for a profile this publisher has enrolled; delivery is not implemented yet.
export const acceptSessionStarted = internalMutation({
  args: { ...publisherRequestArgs, sessionId: v.string(), eventId: v.string(), startedAt: v.number() },
  returns: acceptResultValidator,
  handler: async (ctx, args) => {
    const authorization = await authorizePublisherMutation(ctx, args);
    if (authorization === null) return { status: "unauthorized" as const };
    if (authorization === "replay") return { status: "replay" as const };
    const grants = await grantsForProfile(ctx, args.publisherOwnerUserId, args.publisherId, args.profileId);
    return { status: grants.length > 0 ? "accepted" as const : "unauthorized" as const };
  },
});

export const listCurrentStates = internalQuery({
  args: { userId: v.string(), now: v.number() },
  returns: v.array(storedSessionStateValidator),
  handler: async (ctx, args) => {
    const states = await ctx.db.query("sessionStates")
      .withIndex("by_version_and_user_id_and_expires_at", (query) =>
        query.eq("version", 2).eq("userId", args.userId).gt("expiresAt", args.now),
      ).take(500);
    return [
      ...states.filter((state) => !state.deleted && (!isTerminalPhase(state.phase) || state.runKey === undefined)).map(exposedState),
      ...(await retainedStates(ctx, args.userId)).map((state) => ({ ...state, deleted: false, receivedAt: state.updatedAt })),
    ];
  },
});

export const getState = internalQuery({
  args: { userId: v.string(), publisherId: v.string(), sessionId: v.string() },
  returns: v.union(v.null(), storedSessionStateValidator),
  handler: async (ctx, args) => {
    const state = await ctx.db.query("sessionStates")
      .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
        query.eq("version", 2).eq("userId", args.userId)
          .eq("publisherId", args.publisherId).eq("sessionId", args.sessionId),
      ).unique();
    return state && !state.deleted ? exposedState(state) : null;
  },
});
