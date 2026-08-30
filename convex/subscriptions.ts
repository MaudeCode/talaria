import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

const MAX_PUBLISHERS = 500;
const MAX_PUBLISHER_KEYS = 100;

const subscriptionValidator = v.object({
  publisherId: v.string(),
  label: v.string(),
  subscribed: v.boolean(),
});

export const listForDevice = internalQuery({
  args: { userId: v.string(), deviceId: v.string() },
  returns: v.union(
    v.null(),
    v.array(subscriptionValidator),
  ),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_id_and_device_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (!device || device.revokedAt !== undefined) return null;
    const [publishers, exclusions] = await Promise.all([
      ctx.db
        .query("publishers")
        .withIndex("by_user_id_and_publisher_id", (query) => query.eq("userId", args.userId))
        .take(MAX_PUBLISHERS),
      ctx.db
        .query("devicePublisherExclusions")
        .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
          query.eq("userId", args.userId).eq("deviceId", args.deviceId),
        )
        .take(MAX_PUBLISHERS),
    ]);
    const excluded = new Set(exclusions.map((item) => item.publisherId));
    return publishers
      .filter((publisher) => publisher.enabled)
      .map((publisher) => ({
        publisherId: publisher.publisherId,
        label: publisher.label,
        subscribed: !excluded.has(publisher.publisherId),
      }));
  },
});

export const excludedPublisherIds = internalQuery({
  args: { userId: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_id_and_device_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (!device || device.revokedAt !== undefined) return null;
    const exclusions = await ctx.db
      .query("devicePublisherExclusions")
      .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .take(MAX_PUBLISHERS);
    return exclusions.map((item) => item.publisherId);
  },
});

export const setForDevice = internalMutation({
  args: {
    userId: v.string(),
    deviceId: v.string(),
    publisherId: v.string(),
    subscribed: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const [device, publisher, exclusion] = await Promise.all([
      ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", args.userId).eq("deviceId", args.deviceId),
        )
        .unique(),
      ctx.db
        .query("publishers")
        .withIndex("by_user_id_and_publisher_id", (query) =>
          query.eq("userId", args.userId).eq("publisherId", args.publisherId),
        )
        .unique(),
      ctx.db
        .query("devicePublisherExclusions")
        .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
          query
            .eq("userId", args.userId)
            .eq("deviceId", args.deviceId)
            .eq("publisherId", args.publisherId),
        )
        .unique(),
    ]);
    if (!device || device.revokedAt !== undefined || !publisher?.enabled) return { ok: false };
    if (args.subscribed) {
      if (exclusion) await ctx.db.delete(exclusion._id);
    } else if (!exclusion) {
      await ctx.db.insert("devicePublisherExclusions", {
        userId: args.userId,
        deviceId: args.deviceId,
        publisherId: args.publisherId,
        createdAt: args.now,
      });
    }
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: args.userId });
    return { ok: true };
  },
});

export const revokePublisher = internalMutation({
  args: { userId: v.string(), publisherId: v.string(), now: v.number() },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const publisher = await ctx.db
      .query("publishers")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", args.userId).eq("publisherId", args.publisherId),
      )
      .unique();
    if (!publisher) return { ok: false };
    const [keys, states] = await Promise.all([
      ctx.db
        .query("publisherKeys")
        .withIndex("by_user_id_and_publisher_id", (query) =>
          query.eq("userId", args.userId).eq("publisherId", args.publisherId),
        )
        .take(MAX_PUBLISHER_KEYS + 1),
      ctx.db
        .query("sessionStates")
        .withIndex("by_user_id_and_publisher_id_and_session_id", (query) =>
          query.eq("userId", args.userId).eq("publisherId", args.publisherId),
        )
        .take(MAX_PUBLISHERS + 1),
    ]);
    await ctx.db.patch(publisher._id, { enabled: false, updatedAt: args.now });
    for (const key of keys) {
      if (key.revokedAt === undefined) await ctx.db.patch(key._id, { revokedAt: args.now });
    }
    for (const state of states) {
      if (!state.deleted) {
        await ctx.db.patch(state._id, {
          deleted: true,
          expiresAt: args.now,
          terminalExpiresAt: undefined,
          receivedAt: args.now,
        });
      }
    }
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: args.userId });
    return { ok: true };
  },
});
