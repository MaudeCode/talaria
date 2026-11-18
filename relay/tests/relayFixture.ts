import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";

import { internal } from "../convex/_generated/api";
import { defaultNotificationPreferences, type SessionPhase } from "../convex/lib/model";
import schema from "../convex/schema";

// One user's publisher, grant, phone and two running sessions: the shared seed for delivery suites.
const modules = import.meta.glob("../convex/**/*.ts");
export const now = 1_800_000_000_000;
export const publisherId = "https://hermes.example";
export const publish = {
  publisherOwnerUserId: "user-1",
  publisherId,
  profileId: "profile-1",
  keyId: "key-1",
  nonceExpiresAt: now + 600_000,
};

export async function seed(device: { pushToken?: string; pushToStartToken?: string; activity: boolean }) {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  await backend.run(async (ctx) => {
    await ctx.db.insert("publishers", { version: 2, ownerUserId: "user-1", publisherId, label: "Home", enabled: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("publisherKeys", { version: 2, ownerUserId: "user-1", publisherId, keyId: "key-1", publicKey: "public-key", activatedAt: now, createdAt: now });
    await ctx.db.insert("publisherGrants", { publisherOwnerUserId: "user-1", userId: "user-1", publisherId, profileId: "profile-1", createdAt: now, updatedAt: now });
    await ctx.db.insert("devices", {
      userId: "user-1", deviceId: "device-1", label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
      pushToken: device.pushToken, pushToStartToken: device.pushToStartToken,
      preferences: { ...defaultNotificationPreferences, notificationsEnabled: true }, createdAt: now, updatedAt: now,
    });
    if (device.activity) {
      await ctx.db.insert("liveActivities", {
        userId: "user-1", deviceId: "device-1", activityId: "activity-1", mode: "all_running",
        attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1, activityPushToken: "activity-token", createdAt: now, updatedAt: now,
      });
    }
    for (const sessionId of ["session-1", "session-2"]) {
      await ctx.db.insert("sessionStates", {
        version: 2, userId: "user-1", profileId: "profile-1", deleted: false, publisherId, publisherLabel: "Home",
        sessionId, eventId: `${sessionId}-event-1`, revision: 1, title: sessionId, phase: "running", updatedAt: now,
        deepLink: `/sessions/${sessionId}`, expiresAt: now + 180_000, receivedAt: now,
      });
    }
  });
  return backend;
}

export type Backend = Awaited<ReturnType<typeof seed>>;

const processed = new WeakMap<Backend, Set<string>>();

export async function runScheduledRecomputes(backend: Backend) {
  const seen = processed.get(backend) ?? new Set<string>();
  processed.set(backend, seen);
  const scheduled = await backend.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  for (const job of scheduled) {
    if (job.name !== "delivery:recompute" || seen.has(job._id)) continue;
    seen.add(job._id);
    await backend.mutation(internal.delivery.recompute, (job.args as [never])[0]);
  }
}

export function snapshotState(sessionId: string, revision: number, phase: SessionPhase, alertEligible?: boolean, streamId?: string) {
  return { sessionId, eventId: `${sessionId}-event-${revision}`, revision, title: sessionId, phase, updatedAt: now + revision, deepLink: `/sessions/${sessionId}`, ...(alertEligible === undefined ? {} : { alertEligible }), ...(streamId === undefined ? {} : { streamId }) };
}

// The session state Relay committed for one publisher session, or null once it is gone or deleted.
export async function readState(backend: Backend, key: { userId: string; publisherId: string; sessionId: string }) {
  const state = await backend.run((ctx) => ctx.db.query("sessionStates")
    .withIndex("by_version_and_user_id_and_publisher_id_and_session_id", (query) =>
      query.eq("version", 2).eq("userId", key.userId).eq("publisherId", key.publisherId).eq("sessionId", key.sessionId))
    .unique());
  return state && !state.deleted ? state : null;
}
