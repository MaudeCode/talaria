import { v } from "convex/values";

import { retainedStates } from "./completions";
import { isTerminalPhase } from "./lib/model";
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
  nativeSessionRequest,
  makeLiveActivityEnd,
  makeLiveActivityStart,
  makeLiveActivityUpdate,
  makeNotification,
  type ApnsRequest,
} from "./lib/apnsPayload";
import type { ActivityAggregate, ActivityAlert, SessionState } from "./lib/model";
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
const MAX_PUBLISHER_EXCLUSIONS = 1_000;
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
    alertEligible: state.alertEligible,
  };
}

async function currentStates(ctx: MutationCtx, userId: string, now: number): Promise<SessionState[]> {
  const states = await ctx.db
    .query("sessionStates")
    .withIndex("by_version_and_user_id_and_expires_at", (query) =>
      query.eq("version", 2).eq("userId", userId).gt("expiresAt", now),
    )
    .take(MAX_STATE_ROWS);
  return [
    ...states.filter((state) => !state.deleted && (!isTerminalPhase(state.phase) || state.runKey === undefined)).map(asSessionState),
    ...await retainedStates(ctx, userId),
  ];
}

async function excludedPublisherIds(
  ctx: MutationCtx,
  userId: string,
  deviceId: string,
): Promise<Set<string>> {
  const exclusions = await ctx.db
    .query("devicePublisherExclusions")
    .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
      query.eq("userId", userId).eq("deviceId", deviceId),
    )
    .take(MAX_STATE_ROWS);
  return new Set(exclusions.map((item) => item.publisherId));
}

function statesForDevice(
  states: SessionState[],
  exclusionsByDevice: Map<string, Set<string>>,
  deviceId: string,
): SessionState[] {
  const excluded = exclusionsByDevice.get(deviceId);
  return excluded ? states.filter((state) => !excluded.has(state.publisherId)) : states;
}

async function pendingActivityJobs(
  ctx: MutationCtx,
  userId: string,
  activityId: string,
  fingerprint: string,
): Promise<Doc<"deliveryJobs">[]> {
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
  return [...queued, ...running].filter((job) => job.stateFingerprint === fingerprint);
}

async function pendingDeviceJobs(
  ctx: MutationCtx,
  userId: string,
  deviceId: string,
  fingerprint: string,
): Promise<Doc<"deliveryJobs">[]> {
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
  return [...queued, ...running].filter((job) => job.stateFingerprint === fingerprint);
}

function carriesAlert(payload: unknown): boolean {
  return (payload as { aps?: { alert?: unknown } }).aps?.alert !== undefined;
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
  const pending = input.activityId
    ? await pendingActivityJobs(ctx, input.userId, input.activityId, input.stateFingerprint)
    : await pendingDeviceJobs(ctx, input.userId, input.deviceId, input.stateFingerprint);
  if (pending.length > 0) {
    // Same state already pending. An alerted payload still replaces queued silent duplicates so an eligible
    // transition is never swallowed by an earlier ineligible one that reached the same aggregate first.
    if (!carriesAlert(input.request.payload) || pending.some((job) => carriesAlert(JSON.parse(job.request.payloadJson)))) return;
    for (const job of pending) {
      if (job.status === "queued") await ctx.db.patch(job._id, { status: "stale", updatedAt: input.now });
    }
  }

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
    stateFingerprint: `end:displaced:${activity.deviceId}:${activity.activityId}`,
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
      previousPhase: v.optional(sessionPhaseValidator),
      state: v.optional(storedSessionStateValidator),
    }))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const states = await currentStates(ctx, args.userId, now);
    const [activities, devices, exclusions] = await Promise.all([
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
      ctx.db
        .query("devicePublisherExclusions")
        .withIndex("by_user_id_and_device_id_and_publisher_id", (query) =>
          query.eq("userId", args.userId),
        )
        .take(MAX_PUBLISHER_EXCLUSIONS),
    ]);
    const perSessionActivities = await ctx.db
      .query("liveActivities")
      .withIndex("by_user_id_and_mode_and_ended_at", (query) =>
        query.eq("userId", args.userId).eq("mode", "per_session").eq("endedAt", undefined),
      )
      .take(100);
    const allActivities = [...activities, ...perSessionActivities];
    const devicesById = new Map(devices.map((device) => [device.deviceId, device]));
    const exclusionsByDevice = new Map<string, Set<string>>();
    if (exclusions.length === MAX_PUBLISHER_EXCLUSIONS) {
      // ponytail: fail closed above 1,000 exclusions; paginate per-device recompute if real accounts hit this.
      const everyPublisher = new Set(states.map((state) => state.publisherId));
      for (const device of devices) exclusionsByDevice.set(device.deviceId, everyPublisher);
    } else {
      for (const exclusion of exclusions) {
        const deviceExclusions = exclusionsByDevice.get(exclusion.deviceId) ?? new Set<string>();
        deviceExclusions.add(exclusion.publisherId);
        exclusionsByDevice.set(exclusion.deviceId, deviceExclusions);
      }
    }
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

    const activeAggregateDevices = new Set(activities.map((activity) => activity.deviceId));
    for (const device of devices) {
      const deviceStates = statesForDevice(states, exclusionsByDevice, device.deviceId);
      const aggregate = makeAggregate(deviceStates, now, true);
      if (aggregate === null || aggregate.activeCount === 0) {
        if (device.pushToStartDeferredAt !== undefined) {
          await ctx.db.patch(device._id, { pushToStartDeferredAt: undefined, updatedAt: now });
        }
        continue;
      }
      if (activeAggregateDevices.has(device.deviceId)) {
        if (device.pushToStartDeferredAt !== undefined) {
          await ctx.db.patch(device._id, { pushToStartDeferredAt: undefined, updatedAt: now });
        }
        continue;
      }
      // APNs requires an alert on push-to-start. An ineligible event on a device without an aggregate activity defers
      // the start instead of injecting the fallback alert. The deferral is tracked before the validity and lease
      // checks so a disabled device or a stale in-flight start cannot leak or strand it. It holds while the suppressed
      // state is still visible, and otherwise until an eligible phase transition, an activity, or idle work releases
      // it, so heartbeats, retention, and idle recomputes cannot alert for the suppressed event.
      const visibleChanges = changed.filter(({ state }) => !exclusionsByDevice.get(device.deviceId)?.has(state.publisherId));
      const ineligibleChange = visibleChanges.some(({ state }) => state.alertEligible === false);
      const eligibleTransition = visibleChanges.some(({ state, previousPhase }) =>
        previousPhase !== state.phase && state.alertEligible !== false,
      );
      const ineligibleRow = deviceStates.some((state) => state.alertEligible === false && !isTerminalPhase(state.phase));
      const deferred = ineligibleChange || ineligibleRow
        || (device.pushToStartDeferredAt !== undefined && !eligibleTransition);
      if ((ineligibleChange || ineligibleRow) && device.pushToStartDeferredAt === undefined) {
        await ctx.db.patch(device._id, { pushToStartDeferredAt: now, updatedAt: now });
      } else if (!deferred && device.pushToStartDeferredAt !== undefined) {
        await ctx.db.patch(device._id, { pushToStartDeferredAt: undefined, updatedAt: now });
      }
      if (
        device.revokedAt !== undefined ||
        (device.sessionExpiresAt !== undefined && device.sessionExpiresAt <= now) ||
        !device.bundleId ||
        !device.apsEnvironment ||
        !device.preferences.liveActivitiesEnabled ||
        !device.pushToStartToken
      ) {
        continue;
      }
      if ((device.pushToStartIssuedAt ?? 0) > now - PUSH_TO_START_LEASE_MS) continue;
      const transitionAlert = changed.flatMap(({ state, previousPhase }) => {
        if (exclusionsByDevice.get(device.deviceId)?.has(state.publisherId)) return [];
        const value = alertForTransition(
          previousPhase === undefined ? null : { ...state, phase: previousPhase },
          state,
          device.preferences,
        );
        return value ? [value] : [];
      })[0] ?? null;
      if (!transitionAlert && deferred) continue;
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
      await ctx.db.patch(device._id, { pushToStartIssuedAt: now, pushToStartDeferredAt: undefined, updatedAt: now });
      if (transitionAlert) alertedDevices.add(device.deviceId);
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
      const deviceStates = statesForDevice(states, exclusionsByDevice, activity.deviceId);
      const activityStates = activity.mode === "all_running"
        ? deviceStates
        : deviceStates.filter(
            (state) =>
              state.publisherId === activity.publisherId && state.sessionId === activity.sessionId
                && (activity.streamId === undefined || state.streamId === activity.streamId),
          );
      const nextAggregate = makeAggregate(activityStates, now, true);
      const activityChanged = changed.filter(
        ({ state }) => !exclusionsByDevice.get(activity.deviceId)?.has(state.publisherId),
      );
      const alerted = activityChanged.flatMap(({ state, previousPhase }) => {
        if (
          activity.mode !== "all_running" &&
          (activity.publisherId !== state.publisherId || activity.sessionId !== state.sessionId)
        ) return [];
        const value = alertForTransition(
          previousPhase === undefined ? null : { ...state, phase: previousPhase },
          state,
          device.preferences,
        );
        return value ? [{ alert: value, state }] : [];
      })[0];
      const alert = alerted?.alert ?? null;
      // Source the job from the alerting state so claiming can revalidate that alert's eligibility.
      const activityChangedState = alerted?.state ?? activityChanged[0]?.state ?? null;

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
        const terminalAggregate = makeAggregate(activityStates, now, true);
        const request = makeLiveActivityEnd({
          token: activity.activityPushToken,
          bundleId: device.bundleId,
          environment: device.apsEnvironment,
          aggregate: terminalAggregate,
          nowEpochSeconds: Math.floor(now / 1_000),
          dismissalDelaySeconds: 15,
          alert,
        });
        await enqueueJob(ctx, {
          userId: args.userId,
          deviceId: activity.deviceId,
          activityId: activity.activityId,
          kind: "live_activity_end",
          sourcePublisherId: activityChangedState?.publisherId,
          sourceSessionId: activityChangedState?.sessionId,
          request: activity.attributesType === "AgentRunActivityAttributes" ? nativeSessionRequest(request, activity.createdAt) : request,
          aggregate: terminalAggregate ?? activity.lastAggregate,
          stateFingerprint: `end:${aggregateFingerprint(terminalAggregate)}`,
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
            // The transition alerts in this run; replaying it would re-send that alert.
            { userId: args.userId },
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
        sourcePublisherId: activityChangedState?.publisherId,
        sourceSessionId: activityChangedState?.sessionId,
        request: activity.attributesType === "AgentRunActivityAttributes" ? nativeSessionRequest(request, activity.createdAt) : request,
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
            if (exclusionsByDevice.get(device.deviceId)?.has(state.publisherId)) return [];
            const value = alertForTransition(
              previousPhase === undefined ? null : { ...state, phase: previousPhase },
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
      stateFingerprint: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job?.userId || (job.status !== "queued" && job.status !== "running")) {
      return { status: "stale" as const };
    }
    let request = job.request;
    if (job.activityId) {
      const isDisplacementEnd = job.kind === "live_activity_end"
        && job.stateFingerprint === `end:displaced:${job.deviceId}:${job.activityId}`;
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
      const excluded = await excludedPublisherIds(ctx, job.userId, job.deviceId);
      const deviceStates = states.filter((state) => !excluded.has(state.publisherId));
      const activityStates = activity.mode === "all_running"
        ? deviceStates
        : deviceStates.filter(
            (state) =>
              state.publisherId === activity.publisherId && state.sessionId === activity.sessionId
                && (activity.streamId === undefined || state.streamId === activity.streamId),
          );
      const currentAggregate = makeAggregate(activityStates, args.now, true);
      const stateIsCurrent =
        isDisplacementEnd
          ? true
          : job.kind === "live_activity_end"
          ? currentAggregate === null &&
            job.stateFingerprint === `end:${aggregateFingerprint(makeAggregate(activityStates, args.now, true))}`
          : aggregateFingerprint(currentAggregate) === job.stateFingerprint;
      if (!stateIsCurrent) {
        await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
        return { status: "stale" as const };
      }
      const payload = JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> };
      if (job.sourcePublisherId && job.sourceSessionId && payload.aps.alert !== undefined) {
        // The state is still current, but its alert may have been suppressed after this job was queued.
        const source = await ctx.db
          .query("sessionStates")
          .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
            query.eq("version", 2).eq("userId", job.userId)
              .eq("publisherId", job.sourcePublisherId!).eq("sessionId", job.sourceSessionId!),
          )
          .unique();
        if (source && !source.deleted && source.alertEligible === false) {
          const { alert: _alert, ...aps } = payload.aps;
          request = { ...job.request, payloadJson: JSON.stringify({ ...payload, aps }) };
          await ctx.db.patch(job._id, { request });
        }
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
      const excluded = await excludedPublisherIds(ctx, job.userId, job.deviceId);
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
        const deviceStates = states.filter((state) => !excluded.has(state.publisherId));
        const fingerprint = `start:${job.expectedToken}:${aggregateFingerprint(makeAggregate(deviceStates, args.now, true))}`;
        // A deferral recorded after this start was queued means its fallback alert is no longer wanted.
        if (activeActivity || fingerprint !== job.stateFingerprint || device.pushToStartDeferredAt !== undefined) {
          await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
          if (device.pushToStartToken === job.expectedToken) {
            await ctx.db.patch(device._id, { pushToStartIssuedAt: undefined, updatedAt: args.now });
            await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId: job.userId });
          }
          return { status: "stale" as const };
        }
      }
      if (job.sourcePublisherId && job.sourceSessionId) {
        if (excluded.has(job.sourcePublisherId)) {
          await ctx.db.patch(job._id, { status: "stale", updatedAt: args.now });
          return { status: "stale" as const };
        }
        const [grant, state] = await Promise.all([
          ctx.db
            .query("publisherGrants")
            .withIndex("by_user_id_and_publisher_id", (query) =>
              query.eq("userId", job.userId).eq("publisherId", job.sourcePublisherId!),
            )
            .unique(),
          ctx.db
            .query("sessionStates")
            .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
              query
                .eq("version", 2)
                .eq("userId", job.userId)
                .eq("publisherId", job.sourcePublisherId!)
                .eq("sessionId", job.sourceSessionId!),
            )
            .unique(),
        ]);
        if (
          !grant ||
          !state ||
          state.deleted ||
          state.alertEligible === false ||
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
    return { status: "ready" as const, kind: job.kind, request, stateFingerprint: job.stateFingerprint };
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
