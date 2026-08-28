import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  aggregateFingerprint,
  alertForTransition,
  makeAggregate,
  rowForState,
  shouldUpdateAggregate,
} from "./lib/aggregate";
import {
  makeLiveActivityEnd,
  makeLiveActivityUpdate,
  makeNotification,
  type ApnsRequest,
} from "./lib/apnsPayload";
import type { ActivityAggregate, ActivityAlert, SessionPhase, SessionState } from "./lib/model";
import {
  aggregateValidator,
  apnsDeliveryResultValidator,
  apnsRequestValidator,
  sessionPhaseValidator,
} from "./lib/validators";
import { apnsPool } from "./workpool";

const MAX_STATE_ROWS = 500;

function asSessionState(state: DataModel["sessionStates"]["document"]): SessionState {
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
  };
}

async function currentStates(ctx: MutationCtx, userId: string, now: number): Promise<SessionState[]> {
  const states = await ctx.db
    .query("sessionStates")
    .withIndex("by_user_id_and_expires_at", (query) =>
      query.eq("userId", userId).gt("expiresAt", now),
    )
    .take(MAX_STATE_ROWS);
  return states.map(asSessionState).filter((state) => !state.deleted);
}

async function hasPendingActivityJob(
  ctx: MutationCtx,
  userId: string,
  activityId: string,
  fingerprint: string,
): Promise<boolean> {
  const [queued, running] = await Promise.all([
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_user_id_and_activity_id_and_status", (query) =>
        query.eq("userId", userId).eq("activityId", activityId).eq("status", "queued"),
      )
      .take(20),
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_user_id_and_activity_id_and_status", (query) =>
        query.eq("userId", userId).eq("activityId", activityId).eq("status", "running"),
      )
      .take(20),
  ]);
  return [...queued, ...running].some((job) => job.stateFingerprint === fingerprint);
}

async function hasPendingDeviceJob(
  ctx: MutationCtx,
  userId: string,
  deviceId: string,
  fingerprint: string,
): Promise<boolean> {
  const [queued, running] = await Promise.all([
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_user_id_and_device_id_and_status", (query) =>
        query.eq("userId", userId).eq("deviceId", deviceId).eq("status", "queued"),
      )
      .take(20),
    ctx.db
      .query("deliveryJobs")
      .withIndex("by_user_id_and_device_id_and_status", (query) =>
        query.eq("userId", userId).eq("deviceId", deviceId).eq("status", "running"),
      )
      .take(20),
  ]);
  return [...queued, ...running].some((job) => job.stateFingerprint === fingerprint);
}

async function enqueueJob(
  ctx: MutationCtx,
  input: {
    userId: string;
    deviceId: string;
    activityId?: string;
    sourcePublisherId?: string;
    sourceSessionId?: string;
    kind: "live_activity_update" | "live_activity_end" | "notification";
    request: ApnsRequest;
    aggregate?: ActivityAggregate;
    stateFingerprint: string;
    now: number;
  },
): Promise<void> {
  const duplicate = input.activityId
    ? await hasPendingActivityJob(ctx, input.userId, input.activityId, input.stateFingerprint)
    : await hasPendingDeviceJob(ctx, input.userId, input.deviceId, input.stateFingerprint);
  if (duplicate) return;

  const jobId = await ctx.db.insert("deliveryJobs", {
    userId: input.userId,
    deviceId: input.deviceId,
    activityId: input.activityId,
    sourcePublisherId: input.sourcePublisherId,
    sourceSessionId: input.sourceSessionId,
    kind: input.kind,
    expectedToken: input.request.token,
    stateFingerprint: input.stateFingerprint,
    request: {
      token: input.request.token,
      topic: input.request.topic,
      environment: input.request.environment,
      pushType: input.request.pushType,
      priority: input.request.priority,
      payloadJson: JSON.stringify(input.request.payload),
    },
    aggregate: input.aggregate,
    status: "queued",
    attemptCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await apnsPool.enqueueAction(ctx, internal.apns.sendJob, { jobId }, {
    onComplete: internal.delivery.completeJob,
    context: { jobId },
  });
}

export const recompute = internalMutation({
  args: {
    userId: v.string(),
    publisherId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    previousPhase: v.optional(sessionPhaseValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const states = await currentStates(ctx, args.userId, now);
    const aggregate = makeAggregate(states, now);
    const [activities, devices] = await Promise.all([
      ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_mode_and_ended_at", (query) =>
          query.eq("userId", args.userId).eq("mode", "all_running").eq("endedAt", undefined),
        )
        .take(100),
      ctx.db
        .query("devices")
        .withIndex("by_user_id_and_updated_at", (query) => query.eq("userId", args.userId))
        .order("desc")
        .take(100),
    ]);
    const perSessionActivities = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_mode_and_ended_at", (query) =>
        query.eq("userId", args.userId).eq("mode", "per_session").eq("endedAt", undefined),
      )
      .take(100);
    const allActivities = [...activities, ...perSessionActivities];
    const devicesById = new Map(devices.map((device) => [device.deviceId, device]));
    const changedState =
      args.publisherId && args.sessionId
        ? states.find(
            (state) =>
              state.publisherId === args.publisherId && state.sessionId === args.sessionId,
          ) ?? null
        : null;
    const alertedDevices = new Set<string>();

    for (const activity of allActivities) {
      const device = devicesById.get(activity.deviceId);
      if (
        !device ||
        device.revokedAt !== undefined ||
        !device.bundleId ||
        !device.apsEnvironment ||
        !device.preferences.liveActivitiesEnabled
      ) {
        continue;
      }
      const nextAggregate =
        activity.mode === "all_running"
          ? aggregate
          : makeAggregate(
              states.filter(
                (state) =>
                  state.publisherId === activity.publisherId && state.sessionId === activity.sessionId,
              ),
              now,
            );
      const alert =
        changedState &&
        (activity.mode === "all_running" ||
          (activity.publisherId === changedState.publisherId &&
            activity.sessionId === changedState.sessionId))
          ? alertForTransition(
              args.previousPhase
                ? ({ ...changedState, phase: args.previousPhase as SessionPhase } satisfies SessionState)
                : null,
              changedState,
              device.preferences,
            )
          : null;

      if (nextAggregate === null) {
        if (!activity.lastAggregate) continue;
        const request = makeLiveActivityEnd({
          token: activity.activityPushToken,
          bundleId: device.bundleId,
          environment: device.apsEnvironment,
          aggregate: activity.lastAggregate,
          nowEpochSeconds: Math.floor(now / 1_000),
          alert,
        });
        await enqueueJob(ctx, {
          userId: args.userId,
          deviceId: activity.deviceId,
          activityId: activity.activityId,
          kind: "live_activity_end",
          sourcePublisherId: changedState?.publisherId,
          sourceSessionId: changedState?.sessionId,
          request,
          aggregate: activity.lastAggregate,
          stateFingerprint: "end:null",
          now,
        });
        if (alert) alertedDevices.add(activity.deviceId);
        continue;
      }
      if (
        !shouldUpdateAggregate(
          activity.lastAggregate ?? null,
          nextAggregate,
          activity.lastDeliveryAt ?? null,
          now,
        )
      ) {
        continue;
      }
      const request = makeLiveActivityUpdate({
        token: activity.activityPushToken,
        bundleId: device.bundleId,
        environment: device.apsEnvironment,
        aggregate: nextAggregate,
        nowEpochSeconds: Math.floor(now / 1_000),
        alert,
      });
      await enqueueJob(ctx, {
        userId: args.userId,
        deviceId: activity.deviceId,
        activityId: activity.activityId,
        kind: "live_activity_update",
        sourcePublisherId: changedState?.publisherId,
        sourceSessionId: changedState?.sessionId,
        request,
        aggregate: nextAggregate,
        stateFingerprint: aggregateFingerprint(nextAggregate),
        now,
      });
      if (alert) alertedDevices.add(activity.deviceId);
    }

    if (changedState && aggregate) {
      const row = rowForState(changedState);
      for (const device of devices) {
          if (
            alertedDevices.has(device.deviceId) ||
            device.revokedAt !== undefined ||
            !device.preferences.notificationsEnabled ||
            !device.pushToken ||
            !device.bundleId ||
            !device.apsEnvironment
          ) {
            continue;
          }
          const alert: ActivityAlert | null = alertForTransition(
            args.previousPhase
              ? ({ ...changedState, phase: args.previousPhase as SessionPhase } satisfies SessionState)
              : null,
            changedState,
            device.preferences,
          );
          if (!alert) continue;
          await enqueueJob(ctx, {
            userId: args.userId,
            deviceId: device.deviceId,
            kind: "notification",
            sourcePublisherId: changedState.publisherId,
            sourceSessionId: changedState.sessionId,
            request: makeNotification({
              token: device.pushToken,
              bundleId: device.bundleId,
              environment: device.apsEnvironment,
              alert,
              row,
            }),
            stateFingerprint: `notification:${changedState.eventId}:${device.deviceId}`,
            now,
          });
      }
    }
    return null;
  },
});

export const claimJob = internalMutation({
  args: { jobId: v.id("deliveryJobs"), now: v.number() },
  returns: v.union(
    v.object({ status: v.literal("stale") }),
    v.object({
      status: v.literal("ready"),
      kind: v.union(
        v.literal("live_activity_update"),
        v.literal("live_activity_end"),
        v.literal("notification"),
      ),
      request: apnsRequestValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job?.userId || (job.status !== "queued" && job.status !== "running")) {
      return { status: "stale" as const };
    }
    if (job.activityId) {
      const activityId = job.activityId;
      const activity = await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", job.userId).eq("deviceId", job.deviceId).eq("activityId", activityId),
        )
        .unique();
      if (!activity || activity.activityPushToken !== job.expectedToken) {
        await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
        return { status: "stale" as const };
      }
      const states = await currentStates(ctx, job.userId, args.now);
      const currentAggregate =
        activity.mode === "all_running"
          ? makeAggregate(states, args.now)
          : makeAggregate(
              states.filter(
                (state) =>
                  state.publisherId === activity.publisherId && state.sessionId === activity.sessionId,
              ),
              args.now,
            );
      const stateIsCurrent =
        job.kind === "live_activity_end"
          ? currentAggregate === null
          : aggregateFingerprint(currentAggregate) === job.stateFingerprint;
      if (!stateIsCurrent) {
        await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
        return { status: "stale" as const };
      }
    } else {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", job.userId).eq("deviceId", job.deviceId),
        )
        .unique();
      if (!device || device.pushToken !== job.expectedToken) {
        await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
        return { status: "stale" as const };
      }
      if (job.sourcePublisherId && job.sourceSessionId) {
        const state = await ctx.db
          .query("sessionStates")
          .withIndex("by_user_id_and_publisher_id_and_session_id", (query) =>
            query
              .eq("userId", job.userId)
              .eq("publisherId", job.sourcePublisherId!)
              .eq("sessionId", job.sourceSessionId!),
          )
          .unique();
        if (
          !state ||
          state.deleted ||
          !job.stateFingerprint.includes(`:${state.eventId}:`)
        ) {
          await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
          return { status: "stale" as const };
        }
      }
    }
    await ctx.db.patch(job._id, {
      status: "running",
      attemptCount: job.attemptCount + 1,
      updatedAt: args.now,
    });
    return { status: "ready" as const, kind: job.kind, request: job.request };
  },
});

export const markDelivered = internalMutation({
  args: {
    jobId: v.id("deliveryJobs"),
    apnsStatus: v.number(),
    apnsId: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job?.userId) return null;
    await ctx.db.patch(job._id, {
      status: "done",
      apnsStatus: args.apnsStatus,
      apnsId: args.apnsId,
      updatedAt: args.now,
    });
    if (job.activityId) {
      const activityId = job.activityId;
      const activity = await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", job.userId).eq("deviceId", job.deviceId).eq("activityId", activityId),
        )
        .unique();
      if (activity && activity.activityPushToken === job.expectedToken) {
        await ctx.db.patch(activity._id, {
          lastAggregate: job.aggregate,
          lastDeliveryAt: args.now,
          endedAt: job.kind === "live_activity_end" ? args.now : undefined,
          updatedAt: args.now,
        });
      }
    }
    return null;
  },
});

export const markPermanentFailure = internalMutation({
  args: {
    jobId: v.id("deliveryJobs"),
    apnsStatus: v.number(),
    error: v.string(),
    invalidateToken: v.boolean(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job?.userId) return null;
    await ctx.db.patch(job._id, {
      status: "dead",
      apnsStatus: args.apnsStatus,
      lastError: args.error,
      updatedAt: args.now,
    });
    if (!args.invalidateToken) return null;
    if (job.activityId) {
      const activityId = job.activityId;
      const activity = await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", job.userId).eq("deviceId", job.deviceId).eq("activityId", activityId),
        )
        .unique();
      if (activity?.activityPushToken === job.expectedToken) {
        await ctx.db.patch(activity._id, { endedAt: args.now, updatedAt: args.now });
      }
    } else {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", job.userId).eq("deviceId", job.deviceId),
        )
        .unique();
      if (device?.pushToken === job.expectedToken) {
        await ctx.db.patch(device._id, { pushToken: undefined, updatedAt: args.now });
      }
    }
    return null;
  },
});

const completionContextValidator = v.object({ jobId: v.id("deliveryJobs") });

export const completeJob = apnsPool.defineOnComplete<
  DataModel,
  typeof completionContextValidator,
  typeof apnsDeliveryResultValidator
>({
  context: completionContextValidator,
  returnValue: apnsDeliveryResultValidator,
  handler: async (ctx, { context, result }) => {
    const job = await ctx.db.get(context.jobId);
    if (!job || job.status === "done" || job.status === "dead" || job.status === "stale") return;
    if (result.kind === "success") return;
    await ctx.db.patch(job._id, {
      status: "dead",
      lastError: result.kind === "failed" ? result.error : "canceled",
      updatedAt: Date.now(),
    });
  },
});
