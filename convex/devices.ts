import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  activityModeValidator,
  apsEnvironmentValidator,
  preferencesValidator,
} from "./lib/validators";

export const upsertDevice = internalMutation({
  args: {
    deviceId: v.string(),
    credentialHash: v.string(),
    label: v.string(),
    bundleId: v.string(),
    apsEnvironment: apsEnvironmentValidator,
    pushToken: v.optional(v.string()),
    clearPushToken: v.boolean(),
    preferences: preferencesValidator,
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_device_id", (query) => query.eq("deviceId", args.deviceId))
      .unique();
    if (!device || device.revokedAt !== undefined || device.credentialHash !== args.credentialHash) {
      return { ok: false };
    }
    if (args.pushToken) {
      const owner = await ctx.db
        .query("devices")
        .withIndex("by_push_token", (query) => query.eq("pushToken", args.pushToken))
        .unique();
      if (owner && owner._id !== device._id) {
        await ctx.db.patch(owner._id, { pushToken: undefined, updatedAt: args.now });
      }
    }
    await ctx.db.patch(device._id, {
      label: args.label,
      bundleId: args.bundleId,
      apsEnvironment: args.apsEnvironment,
      ...(args.pushToken
        ? { pushToken: args.pushToken }
        : args.clearPushToken
          ? { pushToken: undefined }
          : {}),
      preferences: args.preferences,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, {});
    return { ok: true };
  },
});

export const registerActivity = internalMutation({
  args: {
    deviceId: v.string(),
    credentialHash: v.string(),
    activityId: v.string(),
    mode: activityModeValidator,
    publisherId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    attributesType: v.string(),
    schemaVersion: v.number(),
    activityPushToken: v.string(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_device_id", (query) => query.eq("deviceId", args.deviceId))
      .unique();
    if (!device || device.revokedAt !== undefined || device.credentialHash !== args.credentialHash) {
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
      await ctx.db.delete(tokenOwner._id);
    }

    const sameMode = await ctx.db
      .query("liveActivities")
      .withIndex("by_device_id_and_mode_and_ended_at", (query) =>
        query.eq("deviceId", args.deviceId).eq("mode", args.mode).eq("endedAt", undefined),
      )
      .take(10);
    for (const activity of sameMode) {
      if (activity.activityId !== args.activityId) {
        await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
      }
    }

    const existing = await ctx.db
      .query("liveActivities")
      .withIndex("by_device_id_and_activity_id", (query) =>
        query.eq("deviceId", args.deviceId).eq("activityId", args.activityId),
      )
      .unique();
    const value = {
      deviceId: args.deviceId,
      activityId: args.activityId,
      mode: args.mode,
      publisherId: args.mode === "per_session" ? args.publisherId : undefined,
      sessionId: args.mode === "per_session" ? args.sessionId : undefined,
      attributesType: args.attributesType,
      schemaVersion: args.schemaVersion,
      activityPushToken: args.activityPushToken,
      lastAggregate: undefined,
      lastDeliveryAt: undefined,
      endedAt: undefined,
      createdAt: existing?.createdAt ?? args.now,
      updatedAt: args.now,
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("liveActivities", value);
    await ctx.scheduler.runAfter(0, internal.delivery.recompute, {
      publisherId: args.publisherId,
      sessionId: args.sessionId,
    });
    return { ok: true };
  },
});

export const endActivity = internalMutation({
  args: {
    deviceId: v.string(),
    credentialHash: v.string(),
    activityId: v.string(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const [device, activity] = await Promise.all([
      ctx.db
        .query("devices")
        .withIndex("by_device_id", (query) => query.eq("deviceId", args.deviceId))
        .unique(),
      ctx.db
        .query("liveActivities")
        .withIndex("by_device_id_and_activity_id", (query) =>
          query.eq("deviceId", args.deviceId).eq("activityId", args.activityId),
        )
        .unique(),
    ]);
    if (!device || device.credentialHash !== args.credentialHash || !activity) return { ok: false };
    await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
    return { ok: true };
  },
});

export const revokeDevice = internalMutation({
  args: { deviceId: v.string(), credentialHash: v.string(), now: v.number() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_device_id", (query) => query.eq("deviceId", args.deviceId))
      .unique();
    if (!device || device.credentialHash !== args.credentialHash) return { ok: false };
    await ctx.db.patch(device._id, {
      revokedAt: args.now,
      pushToken: undefined,
      updatedAt: args.now,
    });
    const activities = await ctx.db
      .query("liveActivities")
      .withIndex("by_device_id_and_mode_and_ended_at", (query) =>
        query.eq("deviceId", args.deviceId),
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
