import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../convex/_generated/api";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const now = 1_800_000_000_000;
const publisherId = "https://hermes.example";
const publish = {
  publisherOwnerUserId: "user-1",
  publisherId,
  profileId: "profile-1",
  keyId: "key-1",
  nonceExpiresAt: now + 600_000,
};

async function seed(device: { pushToken?: string; pushToStartToken?: string; activity: boolean }) {
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

type Backend = Awaited<ReturnType<typeof seed>>;

const processed = new WeakMap<Backend, Set<string>>();

async function runScheduledRecomputes(backend: Backend) {
  const seen = processed.get(backend) ?? new Set<string>();
  processed.set(backend, seen);
  const scheduled = await backend.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  for (const job of scheduled) {
    if (job.name !== "delivery:recompute" || seen.has(job._id)) continue;
    seen.add(job._id);
    await backend.mutation(internal.delivery.recompute, (job.args as [never])[0]);
  }
}

async function jobs(backend: Backend) {
  const rows = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").order("asc").collect());
  return rows.map((job) => ({ kind: job.kind, aps: (JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> }).aps }));
}

function snapshotState(sessionId: string, revision: number, phase: "running" | "waiting_for_approval" | "waiting_for_input" | "completed", alertEligible?: boolean) {
  return { sessionId, eventId: `${sessionId}-event-${revision}`, revision, title: sessionId, phase, updatedAt: now + revision, deepLink: `/sessions/${sessionId}`, ...(alertEligible === undefined ? {} : { alertEligible }) };
}

describe("publisher alert eligibility", () => {
  it("persists and silently delivers an ineligible transition without a later or duplicate alert", async () => {
    const backend = await seed({ pushToken: "push-token", activity: true });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await expect(backend.query(internal.publishers.getState, { userId: "user-1", publisherId, sessionId: "session-1" }))
      .resolves.toMatchObject({ phase: "waiting_for_approval", revision: 2, alertEligible: false });
    let delivered = await jobs(backend);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ kind: "live_activity_update", aps: { event: "update" } });
    expect(delivered[0]!.aps).not.toHaveProperty("alert");
    expect((delivered[0]!.aps["content-state"] as { rows: { sessionId: string; status: string }[] }).rows[0]).toMatchObject({ sessionId: "session-1", status: "Approval" });

    // Equal-revision heartbeat, an eligibility flip in the same phase, and an idle recompute never alert for the consumed transition.
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 60_000, snapshotId: "s2",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n3", receivedAt: now + 61_000, snapshotId: "s3",
      states: [snapshotState("session-1", 3, "waiting_for_approval", true), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    delivered = await jobs(backend);
    expect(delivered.every((job) => job.kind === "live_activity_update" && !("alert" in job.aps))).toBe(true);
    await expect(backend.query(internal.publishers.getState, { userId: "user-1", publisherId, sessionId: "session-1" }))
      .resolves.toMatchObject({ revision: 3, alertEligible: false });

    // Omitting the field keeps the existing alert behavior for a new transition.
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n4", receivedAt: now + 62_000, snapshotId: "s4",
      states: [snapshotState("session-1", 4, "completed"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    delivered = await jobs(backend);
    expect(delivered.at(-1)).toMatchObject({ kind: "live_activity_update", aps: { alert: { title: "session-1", body: "Completed on Home", sound: "default" } } });
  });

  it("suppresses one transition while selecting the eligible one from a mixed snapshot", async () => {
    const mixed = [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 2, "waiting_for_input")];
    const withActivity = await seed({ pushToken: "push-token", activity: true });
    await withActivity.mutation(internal.publishers.acceptSnapshot, { ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1", states: mixed });
    await runScheduledRecomputes(withActivity);
    expect(await jobs(withActivity)).toEqual([
      expect.objectContaining({ kind: "live_activity_update", aps: expect.objectContaining({ alert: { title: "session-2", body: "Input needed on Home", sound: "default" } }) }),
    ]);

    const withoutActivity = await seed({ pushToken: "push-token", activity: false });
    await withoutActivity.mutation(internal.publishers.acceptSnapshot, { ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1", states: mixed });
    await runScheduledRecomputes(withoutActivity);
    expect(await jobs(withoutActivity)).toEqual([
      expect.objectContaining({ kind: "notification", aps: { alert: { title: "session-2", body: "Input needed on Home" }, sound: "default" } }),
    ]);
  });

  it("honors the per-session route and keeps an ineligible end silent", async () => {
    const backend = await seed({ pushToken: "push-token", activity: true });
    await backend.run(async (ctx) => {
      const other = await ctx.db.query("sessionStates").withIndex("by_user_id_and_publisher_id_and_session_id", (q) =>
        q.eq("userId", "user-1").eq("publisherId", publisherId).eq("sessionId", "session-2")).unique();
      await ctx.db.delete(other!._id);
    });
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n1", receivedAt: now + 1, sessionId: "session-1", eventId: "session-1-event-2", revision: 2,
      state: { sessionId: "session-1", title: "session-1", phase: "failed", updatedAt: now + 1, deepLink: "/sessions/session-1", alertEligible: false },
    });
    await runScheduledRecomputes(backend);
    const delivered = await jobs(backend);
    expect(delivered.map((job) => job.kind)).toEqual(["live_activity_update"]);
    expect(delivered[0]!.aps).not.toHaveProperty("alert");
    expect((delivered[0]!.aps["content-state"] as { subtitle: string }).subtitle).toBe("Agent work failed");
    await expect(backend.query(internal.publishers.listCurrentStates, { userId: "user-1", now: now + 2 }))
      .resolves.toEqual([expect.objectContaining({ sessionId: "session-1", phase: "failed" })]);
  });

  it("defers a push-to-start instead of injecting the fallback alert for an ineligible transition", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    expect(await jobs(backend)).toEqual([]);
    const device = await backend.run(async (ctx) => ctx.db.query("devices").first());
    expect(device?.pushToStartIssuedAt).toBeUndefined();

    // A same-phase update that omits the field keeps the start deferred.
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1b", receivedAt: now + 2, snapshotId: "s1b",
      states: [snapshotState("session-1", 3, "waiting_for_approval"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    expect(await jobs(backend)).toEqual([]);

    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 3, snapshotId: "s2",
      states: [snapshotState("session-1", 3, "waiting_for_approval"), snapshotState("session-2", 2, "waiting_for_input")],
    });
    await runScheduledRecomputes(backend);
    const delivered = await jobs(backend);
    expect(delivered.map((job) => job.kind)).toEqual(["live_activity_start"]);
    expect(delivered[0]!.aps.alert).toEqual({ title: "session-2", body: "Input needed on Home", sound: "default" });
  });
});
