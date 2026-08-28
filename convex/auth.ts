import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

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
    return { ok: true };
  },
});
