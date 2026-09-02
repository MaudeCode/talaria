import { v } from "convex/values";

import { internal } from "./_generated/api";
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
    profileId: v.string(),
    keyId: v.string(),
    label: v.string(),
    publicKey: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      protocolVersion: v.literal(2),
      userId: v.string(),
      publisherId: v.string(),
      profileId: v.string(),
      profileIdPreserved: v.boolean(),
      keyId: v.string(),
    }),
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

    const [publisher, ownerGrant] = await Promise.all([
      ctx.db.query("publishers")
        .withIndex("by_version_and_owner_user_id_and_publisher_id", (query) =>
          query.eq("version", 2).eq("ownerUserId", invitation.userId).eq("publisherId", args.publisherId),
        ).unique(),
      ctx.db.query("publisherGrants")
        .withIndex("by_user_id_and_publisher_id", (query) =>
          query.eq("userId", invitation.userId).eq("publisherId", args.publisherId),
        ).unique(),
    ]);
    if (publisher && publisher.ownerUserId !== invitation.userId) {
      return { ok: false as const, reason: "publisher_already_registered" };
    }
    if (publisher) {
      await ctx.db.patch(publisher._id, { label: args.label, enabled: true, updatedAt: args.now });
    } else {
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: invitation.userId,
        publisherId: args.publisherId,
        label: args.label,
        enabled: true,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await ctx.db.insert("publisherKeys", {
      version: 2,
      ownerUserId: invitation.userId,
      publisherId: args.publisherId,
      keyId: args.keyId,
      publicKey: args.publicKey,
      createdAt: args.now,
    });
    const preservesGrant = ownerGrant?.publisherOwnerUserId === invitation.userId;
    const profileId = preservesGrant ? ownerGrant.profileId : args.profileId;
    if (ownerGrant && !preservesGrant) {
      const states = await ctx.db.query("sessionStates")
        .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("version", 2).eq("userId", invitation.userId).eq("publisherId", args.publisherId),
        ).take(501);
      if (states.length > 500) return { ok: false as const, reason: "too_many_states" };
      for (const state of states) await ctx.db.delete(state._id);
      await ctx.db.patch(ownerGrant._id, {
        publisherOwnerUserId: invitation.userId,
        profileId,
        updatedAt: args.now,
      });
    } else if (!ownerGrant) await ctx.db.insert("publisherGrants", {
      userId: invitation.userId,
      publisherOwnerUserId: invitation.userId,
      publisherId: args.publisherId,
      profileId,
      createdAt: args.now,
      updatedAt: args.now,
    });
    await ctx.db.patch(invitation._id, { consumedAt: args.now });
    return {
      ok: true as const,
      protocolVersion: 2 as const,
      userId: invitation.userId,
      publisherId: args.publisherId,
      profileId,
      profileIdPreserved: preservesGrant,
      keyId: args.keyId,
    };
  },
});

export const redeemProfileInvitation = internalMutation({
  args: {
    tokenHash: v.string(),
    publisherOwnerUserId: v.string(),
    publisherId: v.string(),
    profileId: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      protocolVersion: v.literal(2),
      userId: v.string(),
      publisherId: v.string(),
      profileId: v.string(),
    }),
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
    const [user, publisher, grant] = await Promise.all([
      ctx.db
        .query("relayUsers")
        .withIndex("by_user_id", (query) => query.eq("userId", invitation.userId))
        .unique(),
      ctx.db
        .query("publishers")
        .withIndex("by_version_and_owner_user_id_and_publisher_id", (query) =>
          query.eq("version", 2).eq("ownerUserId", args.publisherOwnerUserId).eq("publisherId", args.publisherId),
        )
        .unique(),
      ctx.db
        .query("publisherGrants")
        .withIndex("by_user_id_and_publisher_id", (query) =>
          query.eq("userId", invitation.userId).eq("publisherId", args.publisherId),
        )
        .unique(),
    ]);
    if (!user || user.disabledAt !== undefined) return { ok: false as const, reason: "unauthorized" };
    if (!publisher?.enabled) return { ok: false as const, reason: "publisher_not_registered" };

    if (grant) {
      if (
        grant.publisherOwnerUserId !== args.publisherOwnerUserId
        || grant.profileId !== args.profileId
      ) {
        const states = await ctx.db
          .query("sessionStates")
          .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
            query.eq("version", 2).eq("userId", invitation.userId).eq("publisherId", args.publisherId),
          )
          .take(501);
        if (states.length > 500) throw new Error("too_many_states");
        for (const state of states) await ctx.db.delete(state._id);
      }
      await ctx.db.patch(grant._id, {
        publisherOwnerUserId: args.publisherOwnerUserId,
        profileId: args.profileId,
        updatedAt: args.now,
      });
    } else {
      const states = await ctx.db
        .query("sessionStates")
        .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("version", 2).eq("userId", invitation.userId).eq("publisherId", args.publisherId),
        )
        .take(501);
      if (states.length > 500) return { ok: false as const, reason: "too_many_states" };
      for (const state of states) await ctx.db.delete(state._id);
      await ctx.db.insert("publisherGrants", {
        userId: invitation.userId,
        publisherOwnerUserId: args.publisherOwnerUserId,
        publisherId: args.publisherId,
        profileId: args.profileId,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }
    await ctx.db.patch(invitation._id, { consumedAt: args.now });
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: invitation.userId });
    return {
      ok: true as const,
      protocolVersion: 2 as const,
      userId: invitation.userId,
      publisherId: args.publisherId,
      profileId: args.profileId,
    };
  },
});

export const getPublisherKey = internalQuery({
  args: { publisherId: v.string(), keyId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerUserId: v.string(),
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
      .withIndex("by_version_and_key_id", (query) => query.eq("version", 2).eq("keyId", args.keyId))
      .unique();
    if (!key?.ownerUserId || key.publisherId !== args.publisherId) return null;
    const publisher = await ctx.db
      .query("publishers")
      .withIndex("by_version_and_owner_user_id_and_publisher_id", (query) =>
        query.eq("version", 2).eq("ownerUserId", key.ownerUserId).eq("publisherId", args.publisherId),
      )
      .unique();
    if (!publisher?.ownerUserId) return null;
    return {
      ownerUserId: publisher.ownerUserId,
      publisherId: publisher.publisherId,
      label: publisher.label,
      enabled: publisher.enabled,
      publicKey: key.publicKey,
      revokedAt: key.revokedAt,
    };
  },
});
