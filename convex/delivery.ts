import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import {
  aggregateFingerprint,
  alertForTransition,
  makeAggregate,
  rowForState,
  shouldUpdateAggregate,
} from "./lib/aggregate";
import {
  makeLiveActivityEnd,
  makeLiveActivityStart,
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
  storedSessionStateValidator,
} from "./lib/validators";

export const healthSummary = internalQuery({
  args: { since: v.number() },
  returns: v.object({ recentPermanentFailure: v.boolean() }),
  handler: async (ctx, args) => {
    const failure = await ctx.db
      .query("deliveryJobs")
      .withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "dead").gt("updatedAt", args.since),
      )
      .first();
    return { recentPermanentFailure: failure !== null };
  },
});
import { apnsPool } from "./workpool";

const MAX_STATE_ROWS = 500;
const PUSH_TO_START_LEASE_MS = 15 * 60_000;

function semanticAggregateFingerprint(
  value: ActivityAggregate,
  includeStreamIdentity: boolean,
): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    activeCount: value.activeCount,
    title: value.title,
    subtitle: value.subtitle,
    rows: [...value.rows]
      .sort((left, right) =>
        `${left.publisherId}\u0000${left.sessionId}${includeStreamIdentity ? `\u0000${left.streamId ?? ""}` : ""}`.localeCompare(
          `${right.publisherId}\u0000${right.sessionId}${includeStreamIdentity ? `\u0000${right.streamId ?? ""}` : ""}`,
        ),
      )
      .map((row) => ({
        publisherId: row.publisherId,
        sessionId: row.sessionId,
        streamId: includeStreamIdentity ? row.streamId : undefined,
        title: row.title,
        phase: row.phase,
        status: row.status,
        deepLink: row.deepLink,
      })),
  });
}

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
    kind: "live_activity_update" | "live_activity_end" | "live_activity_start" | "notification";
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

export async function enqueueDisplacedActivityEnd(
  ctx: MutationCtx,
  activity: Doc<"liveActivities">,
  device: Doc<"devices">,
  now: number,
): Promise<void> {
  if (!device.bundleId || !device.apsEnvironment) return;
  await enqueueJob(ctx, {
    userId: activity.userId,
    deviceId: activity.deviceId,
    activityId: activity.activityId,
    kind: "live_activity_end",
    request: makeLiveActivityEnd({
      token: activity.activityPushToken,
      bundleId: device.bundleId,
      environment: device.apsEnvironment,
      aggregate: null,
      nowEpochSeconds: Math.floor(now / 1_000),
      dismissalDelaySeconds: 0,
    }),
    stateFingerprint: `end:displaced:${activity.activityId}`,
    now,
  });
}

export const recompute = internalMutation({
  args: {
    userId: v.string(),
    publisherId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    previousPhase: v.optional(sessionPhaseValidator),
    transitions: v.optional(v.array(v.object({
      publisherId: v.string(),
      sessionId: v.string(),
      previousPhase: sessionPhaseValidator,
      state: v.optional(storedSessionStateValidator),
    }))),
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
    const transitions = args.transitions ?? (
      args.publisherId && args.sessionId && args.previousPhase
        ? [{
            publisherId: args.publisherId,
            sessionId: args.sessionId,
            previousPhase: args.previousPhase,
          }]
        : []
    );
    const changed = transitions.flatMap((transition) => {
      const state = transition.state ?? states.find(
        (candidate) =>
          candidate.publisherId === transition.publisherId &&
          candidate.sessionId === transition.sessionId,
      );
      return state ? [{ state, previousPhase: transition.previousPhase }] : [];
    });
    const changedState = changed[0]?.state ?? null;
    const alertedDevices = new Set<string>();

    if (aggregate !== null) {
      const activeAggregateDevices = new Set(activities.map((activity) => activity.deviceId));
      for (const device of devices) {
        if (
          activeAggregateDevices.has(device.deviceId) ||
          device.revokedAt !== undefined ||
          (device.sessionExpiresAt !== undefined && device.sessionExpiresAt <= now) ||
          !device.bundleId ||
          !device.apsEnvironment ||
          !device.preferences.liveActivitiesEnabled ||
          !device.pushToStartToken ||
          (device.pushToStartIssuedAt ?? 0) > now - PUSH_TO_START_LEASE_MS
        ) {
          continue;
        }
        const transitionAlert = changed.flatMap(({ state, previousPhase }) => {
          const value = alertForTransition(
            { ...state, phase: previousPhase as SessionPhase } satisfies SessionState,
            state,
            device.preferences,
          );
          return value ? [value] : [];
        })[0] ?? null;
        const request = makeLiveActivityStart({
          token: device.pushToStartToken,
          bundleId: device.bundleId,
          environment: device.apsEnvironment,
          aggregate,
          nowEpochSeconds: Math.floor(now / 1_000),
          alert: transitionAlert ?? { title: "Talaria", body: aggregate.subtitle },
        });
        await enqueueJob(ctx, {
          userId: args.userId,
          deviceId: device.deviceId,
          kind: "live_activity_start",
          request,
          aggregate,
          stateFingerprint: `start:${device.pushToStartToken}:${aggregateFingerprint(aggregate)}`,
          now,
        });
        await ctx.db.patch(device._id, { pushToStartIssuedAt: now, updatedAt: now });
        if (transitionAlert) alertedDevices.add(device.deviceId);
      }
    }

    for (const activity of allActivities) {
      const device = devicesById.get(activity.deviceId);
      if (
        !device ||
        device.revokedAt !== undefined ||
        (device.sessionExpiresAt !== undefined && device.sessionExpiresAt <= now) ||
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
      const alert = changed.flatMap(({ state, previousPhase }) => {
        if (
          activity.mode !== "all_running" &&
          (activity.publisherId !== state.publisherId || activity.sessionId !== state.sessionId)
        ) return [];
        const value = alertForTransition(
          { ...state, phase: previousPhase as SessionPhase } satisfies SessionState,
          state,
          device.preferences,
        );
        return value ? [value] : [];
      })[0] ?? null;

      const seededLeaseUntil = activity.emptyStateLeaseUntil;
      const seededLeaseActive = seededLeaseUntil !== undefined && seededLeaseUntil > now;
      const hasCompleteStreamIdentity = activity.lastAggregate?.rows.every(
        (row) => row.streamId !== undefined,
      ) ?? false;
      const matchesDeliveredAggregate =
        nextAggregate !== null &&
        activity.lastAggregate !== undefined &&
        semanticAggregateFingerprint(
          activity.lastAggregate,
          hasCompleteStreamIdentity,
        ) ===
          semanticAggregateFingerprint(nextAggregate, hasCompleteStreamIdentity);
      if (
        seededLeaseUntil !== undefined &&
        seededLeaseUntil > now &&
        (nextAggregate === null || matchesDeliveredAggregate)
      ) {
        await ctx.scheduler.runAfter(
          seededLeaseUntil - now,
          internal.delivery.recompute,
          { userId: args.userId },
        );
        continue;
      }
      if (nextAggregate === null) {
        const request = makeLiveActivityEnd({
          token: activity.activityPushToken,
          bundleId: device.bundleId,
          environment: device.apsEnvironment,
          aggregate: null,
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
        !seededLeaseActive &&
        !shouldUpdateAggregate(
          activity.lastAggregate ?? null,
          nextAggregate,
          activity.lastDeliveryAt ?? null,
          now,
        )
      ) {
        if (
          activity.lastAggregate &&
          activity.lastDeliveryAt !== undefined &&
          aggregateFingerprint(activity.lastAggregate) !== aggregateFingerprint(nextAggregate)
        ) {
          await ctx.scheduler.runAfter(
            Math.max(0, activity.lastDeliveryAt + 15_000 - now),
            internal.delivery.recompute,
            args,
          );
        }
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

    if (changedState) {
      for (const device of devices) {
          if (
            alertedDevices.has(device.deviceId) ||
            device.revokedAt !== undefined ||
            (device.sessionExpiresAt !== undefined && device.sessionExpiresAt <= now) ||
            !device.preferences.notificationsEnabled ||
            !device.pushToken ||
            !device.bundleId ||
            !device.apsEnvironment
          ) {
            continue;
          }
          const changedAlert = changed.flatMap(({ state, previousPhase }) => {
            const value = alertForTransition(
              { ...state, phase: previousPhase as SessionPhase } satisfies SessionState,
              state,
              device.preferences,
            );
            return value ? [{ alert: value, state }] : [];
          })[0];
          const alert: ActivityAlert | null = changedAlert?.alert ?? null;
          if (!alert) continue;
          const notificationState = changedAlert?.state ?? changedState;
          await enqueueJob(ctx, {
            userId: args.userId,
            deviceId: device.deviceId,
            kind: "notification",
            sourcePublisherId: notificationState.publisherId,
            sourceSessionId: notificationState.sessionId,
            request: makeNotification({
              token: device.pushToken,
              bundleId: device.bundleId,
              environment: device.apsEnvironment,
              alert,
              row: rowForState(notificationState),
            }),
            stateFingerprint: `notification:${notificationState.eventId}:${device.deviceId}`,
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
        v.literal("live_activity_start"),
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
      const isDisplacementEnd = job.kind === "live_activity_end"
        && job.stateFingerprint === `end:displaced:${job.activityId}`;
      const activityId = job.activityId;
      const [activity, device] = await Promise.all([
        ctx.db
          .query("liveActivities")
          .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
            query.eq("userId", job.userId).eq("deviceId", job.deviceId).eq("activityId", activityId),
          )
          .unique(),
        ctx.db
          .query("devices")
          .withIndex("by_user_id_and_device_id", (query) =>
            query.eq("userId", job.userId).eq("deviceId", job.deviceId),
          )
          .unique(),
      ]);
      if (
        !activity ||
        (isDisplacementEnd ? activity.endedAt === undefined : activity.endedAt !== undefined) ||
        activity.activityPushToken !== job.expectedToken ||
        !device ||
        device.revokedAt !== undefined ||
        (device.sessionExpiresAt !== undefined && device.sessionExpiresAt <= args.now)
      ) {
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
        isDisplacementEnd
          ? true
          : job.kind === "live_activity_end"
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
      const expectedDeviceToken = job.kind === "live_activity_start"
        ? device?.pushToStartToken
        : device?.pushToken;
      const liveActivitiesDisabled = job.kind === "live_activity_start"
        && device?.preferences.liveActivitiesEnabled !== true;
      if (
        !device ||
        device.revokedAt !== undefined ||
        (device.sessionExpiresAt !== undefined && device.sessionExpiresAt <= args.now) ||
        expectedDeviceToken !== job.expectedToken ||
        liveActivitiesDisabled
      ) {
        await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
        if (job.kind === "live_activity_start" && device?.pushToStartToken === job.expectedToken) {
          await ctx.db.patch(device._id, { pushToStartIssuedAt: undefined, updatedAt: args.now });
        }
        return { status: "stale" as const };
      }
      if (job.kind === "live_activity_start") {
        const [states, activeActivity] = await Promise.all([
          currentStates(ctx, job.userId, args.now),
          ctx.db
            .query("liveActivities")
            .withIndex("by_user_id_and_device_id_and_mode_and_ended_at", (query) =>
              query
                .eq("userId", job.userId)
                .eq("deviceId", job.deviceId)
                .eq("mode", "all_running")
                .eq("endedAt", undefined),
            )
            .first(),
        ]);
        const fingerprint = `start:${job.expectedToken}:${aggregateFingerprint(makeAggregate(states, args.now))}`;
        if (activeActivity || fingerprint !== job.stateFingerprint) {
          await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
          if (device.pushToStartToken === job.expectedToken) {
            await ctx.db.patch(device._id, { pushToStartIssuedAt: undefined, updatedAt: args.now });
            await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: job.userId });
          }
          return { status: "stale" as const };
        }
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
          ...(job.kind === "live_activity_update" ? { emptyStateLeaseUntil: undefined } : {}),
          ...(job.kind === "live_activity_end" && activity.endedAt === undefined
            ? { endedAt: args.now }
            : {}),
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
      if (job.kind === "live_activity_start" && device?.pushToStartToken === job.expectedToken) {
        await ctx.db.patch(device._id, {
          pushToStartToken: undefined,
          pushToStartIssuedAt: undefined,
          updatedAt: args.now,
        });
      } else if (device?.pushToken === job.expectedToken) {
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
