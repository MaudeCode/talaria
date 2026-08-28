import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

export const createPublisherInvitation = internalMutation({
  args: {
    userId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("relayUsers")
      .withIndex("by_user_id", (query) => query.eq("userId", args.userId))
      .unique();
    if (!user || user.disabledAt !== undefined) return { ok: false };
    await ctx.db.insert("publisherInvitations", {
      userId: args.userId,
      tokenHash: args.tokenHash,
      expiresAt: args.expiresAt,
      createdAt: args.now,
    });
    return { ok: true };
  },
});

export const redeemPublisherInvitation = internalMutation({
  args: {
    tokenHash: v.string(),
    publisherId: v.string(),
    keyId: v.string(),
    label: v.string(),
    publicKey: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({ ok: v.literal(true), userId: v.string(), publisherId: v.string(), keyId: v.string() }),
  ),
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("publisherInvitations")
      .withIndex("by_token_hash", (query) => query.eq("tokenHash", args.tokenHash))
      .unique();
    if (!invitation) return { ok: false as const, reason: "invalid_invitation" };
    if (invitation.consumedAt !== undefined || invitation.expiresAt <= args.now) {
      return { ok: false as const, reason: "expired_invitation" };
    }
    const user = await ctx.db
      .query("relayUsers")
      .withIndex("by_user_id", (query) => query.eq("userId", invitation.userId))
      .unique();
    if (!user || user.disabledAt !== undefined) {
      return { ok: false as const, reason: "unauthorized" };
    }

    const publisher = await ctx.db
      .query("publishers")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", invitation.userId).eq("publisherId", args.publisherId),
      )
      .unique();
    if (publisher) {
      await ctx.db.patch(publisher._id, {
        label: args.label,
        enabled: true,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("publishers", {
        userId: invitation.userId,
        publisherId: args.publisherId,
        label: args.label,
        enabled: true,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await ctx.db.insert("publisherKeys", {
      userId: invitation.userId,
      publisherId: args.publisherId,
      keyId: args.keyId,
      publicKey: args.publicKey,
      createdAt: args.now,
    });
    await ctx.db.patch(invitation._id, { consumedAt: args.now });
    return {
      ok: true as const,
      userId: invitation.userId,
      publisherId: args.publisherId,
      keyId: args.keyId,
    };
  },
});

export const getPublisherKey = internalQuery({
  args: { publisherId: v.string(), keyId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      userId: v.string(),
      publisherId: v.string(),
      label: v.string(),
      enabled: v.boolean(),
      publicKey: v.string(),
      revokedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("publisherKeys")
      .withIndex("by_key_id", (query) => query.eq("keyId", args.keyId))
      .unique();
    if (!key?.userId || key.publisherId !== args.publisherId) return null;
    const publisher = await ctx.db
      .query("publishers")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", key.userId).eq("publisherId", args.publisherId),
      )
      .unique();
    if (!publisher) return null;
    return {
      userId: key.userId,
      publisherId: publisher.publisherId,
      label: publisher.label,
      enabled: publisher.enabled,
      publicKey: key.publicKey,
      revokedAt: key.revokedAt,
    };
  },
});
