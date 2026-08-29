import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { enqueueDisplacedActivityEnd } from "./delivery";
import {
  activityModeValidator,
  apsEnvironmentValidator,
  preferencesValidator,
} from "./lib/validators";

export const upsertDevice = internalMutation({
  args: {
    userId: v.string(),
    sessionId: v.string(),
    sessionExpiresAt: v.number(),
    deviceId: v.string(),
    label: v.string(),
    bundleId: v.string(),
    apsEnvironment: apsEnvironmentValidator,
    pushToken: v.optional(v.string()),
    clearPushToken: v.boolean(),
    pushToStartToken: v.optional(v.string()),
    clearPushToStartToken: v.boolean(),
    preferences: preferencesValidator,
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_id_and_device_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (device?.revokedAt !== undefined && device.sessionId === args.sessionId) {
      return { ok: false };
    }
    if (args.pushToken) {
      const owner = await ctx.db
        .query("devices")
        .withIndex("by_push_token", (query) => query.eq("pushToken", args.pushToken))
        .unique();
      if (owner && (!device || owner._id !== device._id)) {
        if (owner.userId !== args.userId) return { ok: false };
        await ctx.db.patch(owner._id, { pushToken: undefined, updatedAt: args.now });
      }
    }
    if (args.pushToStartToken) {
      const owner = await ctx.db
        .query("devices")
        .withIndex("by_push_to_start_token", (query) =>
          query.eq("pushToStartToken", args.pushToStartToken),
        )
        .unique();
      if (owner && (!device || owner._id !== device._id)) {
        if (owner.userId !== args.userId) return { ok: false };
        await ctx.db.patch(owner._id, {
          pushToStartToken: undefined,
          pushToStartIssuedAt: undefined,
          updatedAt: args.now,
        });
      }
    }
    const pushToStartToken = args.pushToStartToken
      ?? (args.clearPushToStartToken ? undefined : device?.pushToStartToken);
    const value = {
      userId: args.userId,
      sessionId: args.sessionId,
      sessionExpiresAt: args.sessionExpiresAt,
      deviceId: args.deviceId,
      label: args.label,
      bundleId: args.bundleId,
      apsEnvironment: args.apsEnvironment,
      ...(args.pushToken
        ? { pushToken: args.pushToken }
        : args.clearPushToken
          ? { pushToken: undefined }
          : {}),
      pushToStartToken,
      pushToStartIssuedAt: pushToStartToken === device?.pushToStartToken
        ? device?.pushToStartIssuedAt
        : undefined,
      preferences: args.preferences,
      revokedAt: undefined,
      createdAt: device?.createdAt ?? args.now,
      updatedAt: args.now,
    };
    if (device) await ctx.db.patch(device._id, value);
    else await ctx.db.insert("devices", value);
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: args.userId });
    return { ok: true };
  },
});

export const registerActivity = internalMutation({
  args: {
    userId: v.string(),
    deviceId: v.string(),
    activityId: v.string(),
    mode: activityModeValidator,
    publisherId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    attributesType: v.string(),
    schemaVersion: v.number(),
    activityPushToken: v.string(),
    seededLocally: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_id_and_device_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (!device || device.revokedAt !== undefined) {
      return { ok: false, reason: "unauthorized" };
    }
    if (args.mode === "per_session" && (!args.publisherId || !args.sessionId)) {
      return { ok: false, reason: "session_required" };
    }

    const tokenOwner = await ctx.db
      .query("liveActivities")
      .withIndex("by_activity_push_token", (query) =>
        query.eq("activityPushToken", args.activityPushToken),
      )
      .unique();
    if (tokenOwner && (tokenOwner.deviceId !== args.deviceId || tokenOwner.activityId !== args.activityId)) {
      if (tokenOwner.userId !== args.userId) {
        return { ok: false, reason: "token_owned" };
      }
      await ctx.db.delete(tokenOwner._id);
    }

    const sameMode = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_device_id_and_mode_and_ended_at", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId).eq("mode", args.mode).eq("endedAt", undefined),
      )
      .take(10);
    for (const activity of sameMode) {
      if (activity.activityId !== args.activityId) {
        await enqueueDisplacedActivityEnd(ctx, activity, device, args.now);
        await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
      }
    }

    const existing = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId).eq("activityId", args.activityId),
      )
      .unique();
    const sameRegistration = existing?.activityPushToken === args.activityPushToken;
    const value = {
      userId: args.userId,
      deviceId: args.deviceId,
      activityId: args.activityId,
      mode: args.mode,
      publisherId: args.mode === "per_session" ? args.publisherId : undefined,
      sessionId: args.mode === "per_session" ? args.sessionId : undefined,
      attributesType: args.attributesType,
      schemaVersion: args.schemaVersion,
      activityPushToken: args.activityPushToken,
      lastAggregate: sameRegistration ? existing.lastAggregate : undefined,
      lastDeliveryAt: sameRegistration ? existing.lastDeliveryAt : undefined,
      emptyStateLeaseUntil: args.seededLocally ? args.now + 30_000 : undefined,
      endedAt: undefined,
      createdAt: existing?.createdAt ?? args.now,
      updatedAt: args.now,
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("liveActivities", value);
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, {
      userId: args.userId,
      publisherId: args.publisherId,
      sessionId: args.sessionId,
    });
    if (args.mode === "all_running") {
      await ctx.db.patch(device._id, { pushToStartIssuedAt: undefined, updatedAt: args.now });
    }
    return { ok: true };
  },
});

export const endActivity = internalMutation({
  args: {
    userId: v.string(),
    deviceId: v.string(),
    activityId: v.string(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const [device, activity] = await Promise.all([
      ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", args.userId).eq("deviceId", args.deviceId),
        )
        .unique(),
      ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", args.userId).eq("deviceId", args.deviceId).eq("activityId", args.activityId),
        )
        .unique(),
    ]);
    if (!device || !activity) return { ok: false };
    await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
    return { ok: true };
  },
});

export const revokeDevice = internalMutation({
  args: { userId: v.string(), deviceId: v.string(), now: v.number() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_id_and_device_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (!device) return { ok: false };
    await ctx.db.patch(device._id, {
      revokedAt: args.now,
      pushToken: undefined,
      pushToStartToken: undefined,
      pushToStartIssuedAt: undefined,
      updatedAt: args.now,
    });
    const activities = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_device_id_and_mode_and_ended_at", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .take(100);
    for (const activity of activities) {
      if (activity.endedAt === undefined) {
        await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
      }
    }
    return { ok: true };
  },
});
