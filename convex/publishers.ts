import { v } from "convex/values";

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
    receivedAt: state.receivedAt,
  };
}

async function authorizePublisherMutation(
  ctx: MutationCtx,
  args: {
    publisherId: string;
    keyId: string;
    nonce: string;
    nonceExpiresAt: number;
    receivedAt: number;
  },
): Promise<{ label: string } | null | "replay"> {
  const [publisher, key, nonce] = await Promise.all([
    ctx.db.query("publishers")
      .withIndex("by_version_and_publisher_id", (query) =>
        query.eq("version", 2).eq("publisherId", args.publisherId),
      ).unique(),
    ctx.db.query("publisherKeys")
      .withIndex("by_version_and_key_id", (query) =>
        query.eq("version", 2).eq("keyId", args.keyId),
      ).unique(),
    ctx.db.query("publisherNonces")
      .withIndex("by_version_and_publisher_id_and_nonce", (query) =>
        query.eq("version", 2).eq("publisherId", args.publisherId).eq("nonce", args.nonce),
      ).unique(),
  ]);
  if (!publisher?.enabled || !key || key.publisherId !== args.publisherId || key.revokedAt !== undefined) {
    return null;
  }
  if (nonce) return "replay";
  if (key.activatedAt === undefined) {
    const keys = await ctx.db.query("publisherKeys")
      .withIndex("by_version_and_publisher_id", (query) =>
        query.eq("version", 2).eq("publisherId", args.publisherId),
      ).take(500);
    for (const candidate of keys) {
      if (candidate._id === key._id) await ctx.db.patch(candidate._id, { activatedAt: args.receivedAt });
      else if (candidate.revokedAt === undefined) await ctx.db.patch(candidate._id, { revokedAt: args.receivedAt });
    }
  }
  await ctx.db.insert("publisherNonces", {
    version: 2,
    publisherId: args.publisherId,
    nonce: args.nonce,
    expiresAt: args.nonceExpiresAt,
    createdAt: args.receivedAt,
  });
  return { label: publisher.label };
}

async function grantsForProfile(ctx: MutationCtx, publisherId: string, profileId: string) {
  return await ctx.db.query("publisherGrants")
    .withIndex("by_publisher_id_and_profile_id", (query) =>
      query.eq("publisherId", publisherId).eq("profileId", profileId),
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
    for (const grant of await grantsForProfile(ctx, args.publisherId, args.profileId)) {
      const existing = await ctx.db.query("sessionStates")
        .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("version", 2).eq("userId", grant.userId)
            .eq("publisherId", args.publisherId).eq("sessionId", args.sessionId),
        ).unique();
      if (existing?.eventId === args.eventId) {
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

      const previousPhase = existing?.deleted ? undefined : existing?.phase;
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
      if (existing) await ctx.db.replace(existing._id, next);
      else await ctx.db.insert("sessionStates", next);
      await ctx.scheduler.runAfter(0, internal.delivery.recompute, {
        userId: grant.userId,
        publisherId: args.publisherId,
        sessionId: args.sessionId,
        previousPhase,
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

    for (const grant of await grantsForProfile(ctx, args.publisherId, args.profileId)) {
      const existing = await ctx.db.query("sessionStates")
        .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("version", 2).eq("userId", grant.userId).eq("publisherId", args.publisherId),
        ).take(500);
      const bySessionId = new Map(existing.map((state) => [state.sessionId, state]));
      const transitions: {
        publisherId: string;
        sessionId: string;
        previousPhase: SessionPhase;
        state: ReturnType<typeof exposedState>;
      }[] = [];
      for (const state of args.states) {
        const current = bySessionId.get(state.sessionId);
        if (current && state.revision < current.revision) continue;
        if (current && state.revision === current.revision) {
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
          ...expiryForState(current, state, args.receivedAt),
          receivedAt: args.receivedAt,
        };
        if (current && current.phase !== state.phase) {
          transitions.push({
            publisherId: args.publisherId,
            sessionId: state.sessionId,
            previousPhase: current.phase,
            state: exposedState(next as Doc<"sessionStates">),
          });
        }
        if (current) await ctx.db.replace(current._id, next);
        else await ctx.db.insert("sessionStates", next);
      }
      await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: grant.userId, transitions });
    }
    return { status: "accepted" as const };
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
    return states.filter((state) => !state.deleted).map(exposedState);
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
