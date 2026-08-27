import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import {
  sessionStateContentValidator,
  sessionStateInputValidator,
  storedSessionStateValidator,
} from "./lib/validators";

const publisherRequestArgs = {
  publisherId: v.string(),
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

function expiryForPhase(
  phase: "starting" | "running" | "waiting_for_approval" | "waiting_for_input" | "completed" | "failed" | "cancelled" | "stale",
  now: number,
): { expiresAt: number; terminalExpiresAt?: number } {
  if (phase === "completed" || phase === "failed" || phase === "cancelled") {
    const terminalExpiresAt = now + 15 * 60 * 1_000;
    return { expiresAt: terminalExpiresAt, terminalExpiresAt };
  }
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") {
    return { expiresAt: now + 24 * 60 * 60 * 1_000 };
  }
  return { expiresAt: now + 2 * 60 * 60 * 1_000 };
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
    ctx.db
      .query("publishers")
      .withIndex("by_publisher_id", (query) => query.eq("publisherId", args.publisherId))
      .unique(),
    ctx.db
      .query("publisherKeys")
      .withIndex("by_publisher_id_and_key_id", (query) =>
        query.eq("publisherId", args.publisherId).eq("keyId", args.keyId),
      )
      .unique(),
    ctx.db
      .query("publisherNonces")
      .withIndex("by_publisher_id_and_nonce", (query) =>
        query.eq("publisherId", args.publisherId).eq("nonce", args.nonce),
      )
      .unique(),
  ]);
  if (!publisher?.enabled || !key || key.revokedAt !== undefined) return null;
  if (nonce) return "replay";
  await ctx.db.insert("publisherNonces", {
    publisherId: args.publisherId,
    nonce: args.nonce,
    expiresAt: args.nonceExpiresAt,
    createdAt: args.receivedAt,
  });
  return { label: publisher.label };
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

    const existing = await ctx.db
      .query("sessionStates")
      .withIndex("by_publisher_id_and_session_id", (query) =>
        query.eq("publisherId", args.publisherId).eq("sessionId", args.sessionId),
      )
      .unique();
    if (existing?.eventId === args.eventId) return { status: "duplicate" as const };
    if (existing && args.revision <= existing.revision) return { status: "stale" as const };

    const previousPhase = existing?.deleted ? undefined : existing?.phase;
    const next = args.state
      ? {
          deleted: false,
          publisherId: args.publisherId,
          publisherLabel: authorization.label,
          eventId: args.eventId,
          revision: args.revision,
          ...args.state,
          ...expiryForPhase(args.state.phase, args.receivedAt),
          receivedAt: args.receivedAt,
        }
      : {
          deleted: true,
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
      publisherId: args.publisherId,
      sessionId: args.sessionId,
      previousPhase,
    });
    return { status: "accepted" as const };
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

    const existing = await ctx.db
      .query("sessionStates")
      .withIndex("by_publisher_id_and_session_id", (query) =>
        query.eq("publisherId", args.publisherId),
      )
      .take(500);
    const bySessionId = new Map(existing.map((state) => [state.sessionId, state]));
    const present = new Set<string>();
    for (const state of args.states) {
      present.add(state.sessionId);
      const current = bySessionId.get(state.sessionId);
      if (current && state.revision <= current.revision) continue;
      const next = {
        deleted: false,
        publisherId: args.publisherId,
        publisherLabel: authorization.label,
        ...state,
        ...expiryForPhase(state.phase, args.receivedAt),
        receivedAt: args.receivedAt,
      };
      if (current) await ctx.db.replace(current._id, next);
      else await ctx.db.insert("sessionStates", next);
    }
    for (const state of existing) {
      if (state.deleted || present.has(state.sessionId)) continue;
      await ctx.db.patch(state._id, {
        deleted: true,
        eventId: `snapshot:${args.snapshotId}`,
        updatedAt: args.receivedAt,
        expiresAt: args.receivedAt,
        receivedAt: args.receivedAt,
      });
    }

    await ctx.scheduler.runAfter(0, internal.delivery.recompute, {});
    return { status: "accepted" as const };
  },
});

export const listCurrentStates = internalQuery({
  args: { now: v.number() },
  returns: v.array(storedSessionStateValidator),
  handler: async (ctx, args) => {
    const states = await ctx.db
      .query("sessionStates")
      .withIndex("by_expires_at", (query) => query.gt("expiresAt", args.now))
      .take(500);
    return states.filter((state) => !state.deleted).map(exposedState);
  },
});

export const getState = internalQuery({
  args: { publisherId: v.string(), sessionId: v.string() },
  returns: v.union(v.null(), storedSessionStateValidator),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("sessionStates")
      .withIndex("by_publisher_id_and_session_id", (query) =>
        query.eq("publisherId", args.publisherId).eq("sessionId", args.sessionId),
      )
      .unique();
    return state && !state.deleted ? exposedState(state) : null;
  },
});
