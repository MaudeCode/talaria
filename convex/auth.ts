import { v } from "convex/values";

import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";

export async function revokeDevicesForSession(
  ctx: MutationCtx,
  userId: string,
  sessionId: string,
  now: number,
): Promise<void> {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_id_and_session_id", (query) =>
      query.eq("userId", userId).eq("sessionId", sessionId),
    )
    .collect();
  for (const device of devices) {
    await ctx.db.patch(device._id, { revokedAt: now, pushToken: undefined, updatedAt: now });
    const activities = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_device_id_and_mode_and_ended_at", (query) =>
        query.eq("userId", userId).eq("deviceId", device.deviceId),
      )
      .collect();
    for (const activity of activities) {
      if (activity.endedAt === undefined) {
        await ctx.db.patch(activity._id, { endedAt: now, updatedAt: now });
      }
    }
  }
}

export const acceptAppleSignIn = internalMutation({
  args: {
    appleSubjectHash: v.string(),
    appleTokenHash: v.string(),
    appleTokenExpiresAt: v.number(),
    userId: v.string(),
    sessionId: v.string(),
    sessionTokenHash: v.string(),
    sessionExpiresAt: v.number(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.literal("replay") }),
    v.object({ ok: v.literal(true), userId: v.string() }),
  ),
  handler: async (ctx, args) => {
    const replay = await ctx.db
      .query("appleIdentityTokens")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.appleTokenHash))
      .unique();
    if (replay) return { ok: false as const, reason: "replay" as const };

    const existingUser = await ctx.db
      .query("relayUsers")
      .withIndex("by_apple_subject_hash", (query) =>
        query.eq("appleSubjectHash", args.appleSubjectHash),
      )
      .unique();
    if (existingUser?.disabledAt !== undefined) {
      throw new Error("apple_user_disabled");
    }
    const userId = existingUser?.userId ?? args.userId;
    if (existingUser) {
      await ctx.db.patch(existingUser._id, { updatedAt: args.now });
    } else {
      await ctx.db.insert("relayUsers", {
        userId,
        appleSubjectHash: args.appleSubjectHash,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await ctx.db.insert("appleIdentityTokens", {
      tokenHash: args.appleTokenHash,
      expiresAt: args.appleTokenExpiresAt,
      createdAt: args.now,
    });
    await ctx.db.insert("userSessions", {
      userId,
      sessionId: args.sessionId,
      tokenHash: args.sessionTokenHash,
      expiresAt: args.sessionExpiresAt,
      createdAt: args.now,
    });
    return { ok: true as const, userId };
  },
});

export const consumeAppleAuthBudget = internalMutation({
  args: { now: v.number() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("authRateLimits")
      .withIndex("by_key", (query) => query.eq("key", "apple-auth-global"))
      .unique();
    if (!row || args.now - row.windowStartedAt >= 60_000) {
      if (row) await ctx.db.patch(row._id, { windowStartedAt: args.now, attempts: 1 });
      else await ctx.db.insert("authRateLimits", {
        key: "apple-auth-global",
        windowStartedAt: args.now,
        attempts: 1,
      });
      return { ok: true };
    }
    if (row.attempts >= 300) return { ok: false };
    await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
    return { ok: true };
  },
});

export const claimAppleJwks = internalMutation({
  args: { now: v.number() },
  returns: v.union(
    v.object({ status: v.literal("cached"), keysJson: v.string(), expiresAt: v.number() }),
    v.object({ status: v.literal("refresh") }),
    v.object({ status: v.literal("wait") }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("appleJwksCache")
      .withIndex("by_key", (query) => query.eq("key", "apple"))
      .unique();
    if (row?.keysJson && row.expiresAt > args.now) {
      return { status: "cached" as const, keysJson: row.keysJson, expiresAt: row.expiresAt };
    }
    if (row && row.refreshLeaseUntil > args.now) return { status: "wait" as const };
    if (row) {
      await ctx.db.patch(row._id, { refreshLeaseUntil: args.now + 10_000, updatedAt: args.now });
    } else {
      await ctx.db.insert("appleJwksCache", {
        key: "apple",
        expiresAt: 0,
        refreshLeaseUntil: args.now + 10_000,
        updatedAt: args.now,
      });
    }
    return { status: "refresh" as const };
  },
});

export const saveAppleJwks = internalMutation({
  args: { keysJson: v.string(), expiresAt: v.number(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("appleJwksCache")
      .withIndex("by_key", (query) => query.eq("key", "apple"))
      .unique();
    if (!row) throw new Error("apple_jwks_cache_missing");
    await ctx.db.patch(row._id, {
      keysJson: args.keysJson,
      expiresAt: args.expiresAt,
      refreshLeaseUntil: 0,
      updatedAt: args.now,
    });
    return null;
  },
});

export const getSession = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({ userId: v.string(), sessionId: v.string(), expiresAt: v.number() }),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("userSessions")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.revokedAt !== undefined || session.expiresAt <= args.now) return null;
    const user = await ctx.db
      .query("relayUsers")
      .withIndex("by_user_id", (query) => query.eq("userId", session.userId))
      .unique();
    if (!user || user.disabledAt !== undefined) return null;
    return { userId: session.userId, sessionId: session.sessionId, expiresAt: session.expiresAt };
  },
});

export const revokeSession = internalMutation({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("userSessions")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.revokedAt !== undefined) return { ok: false };
    await ctx.db.patch(session._id, { revokedAt: args.now });
    await revokeDevicesForSession(ctx, session.userId, session.sessionId, args.now);
    return { ok: true };
  },
});
