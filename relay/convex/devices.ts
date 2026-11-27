import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { enqueueDisplacedActivityEnd } from "./delivery";
import type { ActivityMode } from "./lib/model";
import {
  activityModeValidator,
  apsEnvironmentValidator,
  preferencesValidator,
} from "./lib/validators";

const revocationBatchSize = 128;
const activityReplacementLimit = 10;

function findDevice(ctx: MutationCtx, userId: string, deviceId: string) {
  return ctx.db.query("devices")
    .withIndex("by_user_id_and_device_id", (query) => query.eq("userId", userId).eq("deviceId", deviceId))
    .unique();
}

function openDeviceActivities(ctx: MutationCtx, userId: string, deviceId: string, mode: ActivityMode) {
  return ctx.db.query("liveActivities")
    .withIndex("by_user_id_and_device_id_and_mode_and_ended_at", (query) =>
      query.eq("userId", userId).eq("deviceId", deviceId).eq("mode", mode).eq("endedAt", undefined),
    );
}

async function endDeviceActivitiesBatch(ctx: MutationCtx, device: Doc<"devices">, endedAt: number) {
  let moreActivities = false;
  for (const mode of ["per_session", "all_running"] as const) {
    const activities = await openDeviceActivities(ctx, device.userId, device.deviceId, mode)
      .take(revocationBatchSize);
    for (const activity of activities) {
      await ctx.db.patch(activity._id, { endedAt, updatedAt: endedAt });
    }
    moreActivities ||= activities.length === revocationBatchSize;
  }
  return moreActivities;
}

export async function revokeDeviceRegistration(ctx: MutationCtx, device: Doc<"devices">, now: number) {
  let activityCleanupAt = device.activityCleanupAt;
  if (activityCleanupAt === undefined && await endDeviceActivitiesBatch(ctx, device, now)) {
    activityCleanupAt = now;
    await ctx.scheduler.runAfter(0, internal.devices.finishActivityRevocation, {
      deviceRowId: device._id, endedAt: now,
    });
  }
  await ctx.db.patch(device._id, {
    revokedAt: now,
    pushToken: undefined,
    pushToStartToken: undefined,
    pushToStartIssuedAt: undefined,
    activityCleanupAt,
    updatedAt: now,
  });
}

export const finishActivityRevocation = internalMutation({
  args: { deviceRowId: v.id("devices"), endedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceRowId);
    if (!device || device.activityCleanupAt !== args.endedAt) return null;
    if (await endDeviceActivitiesBatch(ctx, device, args.endedAt)) {
      await ctx.scheduler.runAfter(0, internal.devices.finishActivityRevocation, args);
    } else {
      await ctx.db.patch(device._id, { activityCleanupAt: undefined });
    }
    return null;
  },
});

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
  returns: v.object({ ok: v.boolean(), activityCleanupPending: v.optional(v.literal(true)) }),
  handler: async (ctx, args) => {
    const device = await findDevice(ctx, args.userId, args.deviceId);
    if (device?.revokedAt !== undefined && device.sessionId === args.sessionId) {
      return { ok: false };
    }
    const pushTokenOwner = args.pushToken
      ? await ctx.db
        .query("devices")
        .withIndex("by_push_token", (query) => query.eq("pushToken", args.pushToken))
        .unique()
      : null;
    const pushToStartTokenOwner = args.pushToStartToken
      ? await ctx.db
        .query("devices")
        .withIndex("by_push_to_start_token", (query) =>
          query.eq("pushToStartToken", args.pushToStartToken),
        )
        .unique()
      : null;
    const transfers = [pushTokenOwner, pushToStartTokenOwner]
      .map((owner) => (owner && owner._id !== device?._id ? owner : null));
    if (transfers.some((owner) => owner && owner.userId !== args.userId)) return { ok: false };
    // A replacement session must not reactivate registrations that revocation is still ending.
    if (device?.activityCleanupAt !== undefined &&
        await endDeviceActivitiesBatch(ctx, device, device.activityCleanupAt)) {
      return { ok: false, activityCleanupPending: true as const };
    }
    const [pushTokenTransfer, pushToStartTokenTransfer] = transfers;
    if (pushTokenTransfer) {
      await ctx.db.patch(pushTokenTransfer._id, { pushToken: undefined, updatedAt: args.now });
    }
    if (pushToStartTokenTransfer) {
      await ctx.db.patch(pushToStartTokenTransfer._id, {
        pushToStartToken: undefined,
        pushToStartIssuedAt: undefined,
        updatedAt: args.now,
      });
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
      activityCleanupAt: undefined,
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
    streamId: v.optional(v.string()),
    attributesType: v.string(),
    schemaVersion: v.number(),
    activityPushToken: v.string(),
    seededLocally: v.boolean(),
    now: v.number(),
  },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const device = await findDevice(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt !== undefined) {
      return { ok: false, reason: "unauthorized" };
    }
    if (args.mode === "per_session" && (!args.publisherId || !args.sessionId)) {
      return { ok: false, reason: "session_required" };
    }
    if (args.mode === "per_session") {
      const [grant, exclusion] = await Promise.all([
        ctx.db.query("publisherGrants")
          .withIndex("by_user_id_and_publisher_id", (query) =>
            query.eq("userId", args.userId).eq("publisherId", args.publisherId!),
          ).unique(),
        ctx.db.query("devicePublisherExclusions")
          .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
            query.eq("userId", args.userId).eq("deviceId", args.deviceId).eq("publisherId", args.publisherId!),
          ).unique(),
      ]);
      if (!grant) return { ok: false, reason: "publisher_not_enrolled" };
      if (exclusion) return { ok: false, reason: "publisher_unsubscribed" };
    }

    const existing = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId).eq("activityId", args.activityId),
      )
      .unique();
    if (existing?.endedAt !== undefined) {
      return { ok: false, reason: "ended" };
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
      if (tokenOwner.endedAt !== undefined) {
        return { ok: false, reason: "ended" };
      }
      const sourceDevice = tokenOwner.deviceId === args.deviceId
        ? device
        : await findDevice(ctx, args.userId, tokenOwner.deviceId);
      if (sourceDevice?.activityCleanupAt !== undefined) {
        return { ok: false, reason: "ended" };
      }
      await ctx.db.delete(tokenOwner._id);
    }

    const sameMode = await openDeviceActivities(ctx, args.userId, args.deviceId, args.mode)
      .take(activityReplacementLimit);
    const streamId = args.mode === "per_session" ? args.streamId : undefined;
    let superseded = sameMode;
    if (streamId !== undefined) {
      // Keep the legacy replacement window for streamless cards. A known run
      // can have retained neighbors, so look up its cards directly.
      const sameRun = await ctx.db.query("liveActivities")
        .withIndex("by_open_device_run", (query) => query
          .eq("userId", args.userId).eq("deviceId", args.deviceId).eq("mode", args.mode)
          .eq("endedAt", undefined).eq("publisherId", args.publisherId).eq("sessionId", args.sessionId)
          .eq("streamId", streamId))
        .take(activityReplacementLimit);
      superseded = [...sameMode.filter((activity) => activity.streamId === undefined), ...sameRun];
    }
    for (const activity of superseded) {
      if (activity.activityId === args.activityId) continue;
      await enqueueDisplacedActivityEnd(ctx, activity, device, args.now);
      await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
    }

    const sameRegistration = existing?.activityPushToken === args.activityPushToken;
    const value = {
      userId: args.userId,
      deviceId: args.deviceId,
      activityId: args.activityId,
      mode: args.mode,
      publisherId: args.mode === "per_session" ? args.publisherId : undefined,
      sessionId: args.mode === "per_session" ? args.sessionId : undefined,
      streamId,
      attributesType: args.attributesType,
      schemaVersion: args.schemaVersion,
      activityPushToken: args.activityPushToken,
      lastAggregate: sameRegistration ? existing.lastAggregate : undefined,
      lastDeliveryAt: sameRegistration ? existing.lastDeliveryAt : undefined,
      emptyStateLeaseUntil: args.seededLocally ? args.now + 30_000 : undefined,
      endedAt: undefined,
      // A card rebound to its session's next run times that run when the publisher omits its start.
      createdAt: existing && existing.streamId === streamId ? existing.createdAt : args.now,
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
      await ctx.db.patch(device._id, { pushToStartIssuedAt: undefined, pushToStartDeferredAt: undefined, updatedAt: args.now });
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
      findDevice(ctx, args.userId, args.deviceId),
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
    const device = await findDevice(ctx, args.userId, args.deviceId);
    if (!device) return { ok: false };
    await revokeDeviceRegistration(ctx, device, args.now);
    const exclusions = await ctx.db
      .query("devicePublisherExclusions")
      .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
        query.eq("userId", args.userId).eq("deviceId", args.deviceId),
      )
      .take(500);
    for (const exclusion of exclusions) await ctx.db.delete(exclusion._id);
    return { ok: true };
  },
});
