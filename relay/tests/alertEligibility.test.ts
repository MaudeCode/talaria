import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import { sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences, type NotificationPreferences, type SessionPhase } from "../convex/lib/model";
import { type Backend, now, readState, publish, publisherId, runScheduledRecomputes, seed, snapshotState } from "./relayFixture";

async function jobs(backend: Backend) {
  const rows = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").order("asc").collect());
  return rows.filter((job) => job.kind !== "badge").map((job) => ({
    kind: job.kind, status: job.status, aps: (JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> }).aps,
  }));
}

function expectedClaimedRequest(job: Doc<"deliveryJobs">, badge: number) {
  if (job.kind !== "notification") return job.request;
  const payload = JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> };
  return { ...job.request, payloadJson: JSON.stringify({ ...payload, aps: { ...payload.aps, badge } }) };
}

describe("publisher alert eligibility", () => {
  it("stales a queued Live Activity start after owner key revocation", async ({ onTestFinished }) => {
    vi.useFakeTimers({ now });
    onTestFinished(() => { vi.useRealTimers(); });
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const queued = await backend.run((ctx) => ctx.db.query("deliveryJobs").first());
    expect(queued).toMatchObject({ kind: "live_activity_start", status: "queued" });
    await backend.mutation(internal.subscriptions.revokePublisherKeys, {
      userId: "user-1", publisherId, now: now + 1,
    });
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 2 }))
      .resolves.toEqual({ status: "stale" });
    await expect(backend.query(internal.publishers.listCurrentStates, { userId: "user-1", now: now + 2 }))
      .resolves.toEqual([]);
  });

  it("persists and silently delivers an ineligible transition without a later or duplicate alert", async () => {
    const backend = await seed({ pushToken: "push-token", activity: true });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await expect(readState(backend, { userId: "user-1", publisherId, sessionId: "session-1" }))
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
    await expect(readState(backend, { userId: "user-1", publisherId, sessionId: "session-1" }))
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
    const activityJobs = await jobs(withActivity);
    expect(activityJobs.map((job) => job.kind)).toEqual(["live_activity_update", "notification"]);
    expect(activityJobs[0]!.aps).not.toHaveProperty("alert");
    expect(activityJobs[1]!.aps).toMatchObject({ alert: { title: "session-2", body: "Input needed on Home" }, "interruption-level": "time-sensitive" });

    const withoutActivity = await seed({ pushToken: "push-token", activity: false });
    await withoutActivity.mutation(internal.publishers.acceptSnapshot, { ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1", states: mixed });
    await runScheduledRecomputes(withoutActivity);
    expect(await jobs(withoutActivity)).toEqual([
      expect.objectContaining({ kind: "notification", aps: { alert: { title: "session-2", body: "Input needed on Home" }, sound: "default", "thread-id": expect.any(String), "interruption-level": "time-sensitive" } }),
    ]);
  });

  it("TAL-1469: a published question head reaches the input notification, so its Reply answers only that question", async () => {
    const backend = await seed({ pushToken: "push-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [{ ...snapshotState("session-1", 2, "waiting_for_input"), inputHeadId: "question-head-1" }],
    });
    await runScheduledRecomputes(backend);
    const rows = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").collect());
    const notifications = rows.filter((job) => job.kind === "notification");
    expect(notifications.map((job) => JSON.parse(job.request.payloadJson))).toEqual([
      expect.objectContaining({ aps: expect.objectContaining({ category: "talaria.input" }), inputHeadId: "question-head-1" }),
    ]);
  });

  it("still sends the Time Sensitive notification when another alert sounds on the activity", async () => {
    const backend = await seed({ pushToken: "push-token", activity: true });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "completed"), snapshotState("session-2", 2, "waiting_for_approval")],
    });
    await runScheduledRecomputes(backend);
    const delivered = await jobs(backend);
    expect(delivered.map((job) => job.kind)).toEqual(["live_activity_update", "notification"]);
    expect(delivered[0]!.aps.alert).toEqual({ title: "session-1", body: "Completed on Home", sound: "default" });
    expect(delivered[1]!.aps).toMatchObject({
      alert: { "title-loc-key": "Approval required", "loc-key": "An agent run is waiting for your approval." },
      "interruption-level": "time-sensitive",
    });
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
      state: { sessionId: "session-1", title: "session-1", phase: "failed", startedAt: now, updatedAt: now + 1, deepLink: "/sessions/session-1", alertEligible: false },
    });
    await runScheduledRecomputes(backend);
    const delivered = await jobs(backend);
    expect(delivered.map((job) => job.kind)).toEqual(["live_activity_update"]);
    expect(delivered[0]!.aps).not.toHaveProperty("alert");
    expect((delivered[0]!.aps["content-state"] as { subtitle: string }).subtitle).toBe("Agent work failed");
    await expect(backend.query(internal.publishers.listCurrentStates, { userId: "user-1", now: now + 2 }))
      .resolves.toEqual([expect.objectContaining({ sessionId: "session-1", phase: "failed" })]);
  });

  it("defers a push-to-start for an ineligible terminal transition while other work is active", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n1", receivedAt: now + 1, sessionId: "session-1", eventId: "session-1-event-2", revision: 2,
      state: { sessionId: "session-1", title: "session-1", phase: "completed", startedAt: now, updatedAt: now + 1, deepLink: "/sessions/session-1", alertEligible: false },
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([]);
    const device = await backend.run(async (ctx) => ctx.db.query("devices").first());
    expect(device?.pushToStartIssuedAt).toBeUndefined();
    expect(device?.pushToStartDeferredAt).toBeDefined();

    // Transitionless recomputes (device upsert, acknowledgement, cleanup) keep the deferral.
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    expect(await jobs(backend)).toEqual([]);

    // The next eligible transition starts the activity with its own alert and consumes the deferral.
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n2", receivedAt: now + 2, sessionId: "session-2", eventId: "session-2-event-2", revision: 2,
      state: { sessionId: "session-2", title: "session-2", phase: "waiting_for_input", startedAt: now, updatedAt: now + 2, deepLink: "/sessions/session-2" },
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([
      expect.objectContaining({ kind: "live_activity_start", aps: expect.objectContaining({ alert: { title: "session-2", body: "Input needed on Home", sound: "default" } }) }),
    ]);
    const started = await backend.run(async (ctx) => ctx.db.query("devices").first());
    expect(started?.pushToStartDeferredAt).toBeUndefined();
  });

  it("defers a push-to-start for an ineligible first publication but not an eligible one", async () => {
    const deferredBackend = await seed({ pushToStartToken: "start-token", activity: false });
    await deferredBackend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 1, "running"), snapshotState("session-2", 1, "running"), snapshotState("session-3", 1, "waiting_for_approval", false)],
    });
    await runScheduledRecomputes(deferredBackend);
    expect(await jobs(deferredBackend)).toEqual([]);
    expect((await deferredBackend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeDefined();

    const startedBackend = await seed({ pushToStartToken: "start-token", activity: false });
    await startedBackend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 1, "running"), snapshotState("session-2", 1, "running"), snapshotState("session-3", 1, "waiting_for_approval")],
    });
    await runScheduledRecomputes(startedBackend);
    expect(await jobs(startedBackend)).toEqual([
      expect.objectContaining({ kind: "live_activity_start", aps: expect.objectContaining({ alert: { title: "Talaria", body: "1 needs attention", sound: "default" } }) }),
    ]);
  });

  it("does not record a deferral while an aggregate activity already exists", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: true });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    expect((await jobs(backend)).map((job) => job.kind)).toEqual(["live_activity_update"]);
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeUndefined();
  });

  it("releases a deferral on an eligible phase transition once no suppressed row remains", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([]);

    // Another session's eligible transition does not release it while the suppressed approval is still visible.
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 2, snapshotId: "s2",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 2, "stale")],
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([]);
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeDefined();

    // The suppressed session moving on to running (no alert category) releases the deferral and uses the fallback start.
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n3", receivedAt: now + 3, snapshotId: "s3",
      states: [snapshotState("session-1", 3, "running"), snapshotState("session-2", 3, "running")],
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([
      expect.objectContaining({ kind: "live_activity_start", aps: expect.objectContaining({ alert: { title: "Talaria", body: "2 active sessions", sound: "default" } }) }),
    ]);
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeUndefined();
  });

  it("does not inherit suppression into a new run that begins in the same phase", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false, "run-1"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([]);
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 2, snapshotId: "s2",
      states: [snapshotState("session-1", 3, "waiting_for_approval", undefined, "run-2"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const state = await readState(backend, { userId: "user-1", publisherId, sessionId: "session-1" });
    expect(state).toMatchObject({ streamId: "run-2" });
    expect(state).not.toHaveProperty("alertEligible");
    expect(await jobs(backend)).toEqual([
      expect.objectContaining({ kind: "live_activity_start", aps: expect.objectContaining({ alert: { title: "Talaria", body: "1 needs attention", sound: "default" } }) }),
    ]);
  });

  it("stales a queued push-to-start once a deferral is recorded", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const queued = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(queued).toMatchObject({ kind: "live_activity_start", status: "queued" });
    // Same phase, same aggregate fields, now suppressed: the aggregate fingerprint is unchanged.
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n2", receivedAt: now + 3, sessionId: "session-1", eventId: "session-1-event-3", revision: 3,
      state: { sessionId: "session-1", title: "session-1", phase: "waiting_for_approval", startedAt: now, updatedAt: now + 2, deepLink: "/sessions/session-1", alertEligible: false },
    });
    await runScheduledRecomputes(backend);
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 4 })).resolves.toEqual({ status: "stale" });
    const device = await backend.run(async (ctx) => ctx.db.query("devices").first());
    expect(device?.pushToStartIssuedAt).toBeUndefined();
    expect(device?.pushToStartDeferredAt).toBeDefined();
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    expect((await jobs(backend)).map((job) => [job.kind, job.status])).toEqual([["live_activity_start", "stale"]]);
  });

  it("sends a queued alerted update silently once its transition is suppressed", async () => {
    // Without a notification token the approval alert stays on the activity.
    const backend = await seed({ activity: true });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const queued = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(queued).toMatchObject({ kind: "live_activity_update", status: "queued", sourceSessionId: "session-1" });
    expect((JSON.parse(queued!.request.payloadJson) as { aps: Record<string, unknown> }).aps.alert).toBeDefined();
    // Same phase and aggregate fields, now suppressed: the silent duplicate is dropped, so revalidate at claim time.
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 3, snapshotId: "s2",
      states: [{ ...snapshotState("session-1", 3, "waiting_for_approval", false), updatedAt: now + 2 }, snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const claimed = await backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 4 });
    expect(claimed).toMatchObject({ status: "ready", kind: "live_activity_update" });
    const aps = (JSON.parse((claimed as { request: { payloadJson: string } }).request.payloadJson) as { aps: Record<string, unknown> }).aps;
    expect(aps).not.toHaveProperty("alert");
    expect(aps["content-state"]).toMatchObject({ subtitle: "1 needs attention" });
  });

  it("stales a queued push-to-start once a snapshot suppresses its row in the same phase", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const queued = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(queued).toMatchObject({ kind: "live_activity_start", status: "queued" });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 3, snapshotId: "s2",
      states: [{ ...snapshotState("session-1", 3, "waiting_for_approval", false), updatedAt: now + 2 }, snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 4 })).resolves.toEqual({ status: "stale" });
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeDefined();
  });

  it("stales a queued alerted push-to-start once a snapshot suppresses its terminal transition", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "completed"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const queued = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(queued).toMatchObject({ kind: "live_activity_start", status: "queued" });
    expect((JSON.parse(queued!.request.payloadJson) as { aps: { alert: unknown } }).aps.alert).toEqual({ title: "session-1", body: "Completed on Home", sound: "default" });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 3, snapshotId: "s2",
      states: [{ ...snapshotState("session-1", 3, "completed", false), updatedAt: now + 2 }, snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 4 })).resolves.toEqual({ status: "stale" });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    expect((await jobs(backend)).map((job) => [job.kind, job.status])).toEqual([["live_activity_start", "stale"]]);
  });

  it("stales a queued notification once its event is suppressed", async () => {
    const backend = await seed({ pushToken: "push-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const queued = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(queued).toMatchObject({ kind: "notification", status: "queued" });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 3, snapshotId: "s2",
      states: [{ ...snapshotState("session-1", 3, "waiting_for_approval", false), eventId: "session-1-event-2", updatedAt: now + 2 }, snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 4 })).resolves.toEqual({ status: "stale" });
  });

  it("releases a deferral on an eligible transition even while Live Activities are disabled", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const device = await backend.run(async (ctx) => ctx.db.query("devices").first());
    expect(device?.pushToStartDeferredAt).toBeDefined();
    await backend.run(async (ctx) => ctx.db.patch(device!._id, { preferences: { ...device!.preferences, liveActivitiesEnabled: false } }));
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 2, snapshotId: "s2",
      states: [snapshotState("session-1", 3, "running"), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([]);
    expect((await backend.run(async (ctx) => ctx.db.get(device!._id)))?.pushToStartDeferredAt).toBeUndefined();
    await backend.run(async (ctx) => ctx.db.patch(device!._id, { preferences: { ...device!.preferences, liveActivitiesEnabled: true } }));
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    expect((await jobs(backend)).map((job) => job.kind)).toEqual(["live_activity_start"]);
  });

  it("clears a deferral when an aggregate activity registers", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n1", receivedAt: now + 1, sessionId: "session-1", eventId: "session-1-event-2", revision: 2,
      state: { sessionId: "session-1", title: "session-1", phase: "completed", startedAt: now, updatedAt: now + 1, deepLink: "/sessions/session-1", alertEligible: false },
    });
    await runScheduledRecomputes(backend);
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeDefined();
    await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1", deviceId: "device-1", activityId: "activity-1", mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1, activityPushToken: "activity-token", seededLocally: false, now: now + 2,
    });
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeUndefined();
  });

  it("clears a deferral once the device's work goes idle", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
      states: [snapshotState("session-1", 2, "waiting_for_approval", false), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeDefined();
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "n2", receivedAt: now + 2, snapshotId: "s2",
      states: [snapshotState("session-1", 3, "completed", false), snapshotState("session-2", 2, "completed", false)],
    });
    await runScheduledRecomputes(backend);
    expect(await jobs(backend)).toEqual([]);
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartDeferredAt).toBeUndefined();
  });

  it("lets a later eligible transition replace a queued silent update", async () => {
    // Without a notification token the input alert stays on the activity.
    const backend = await seed({ activity: true });
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n1", receivedAt: now + 1, sessionId: "session-1", eventId: "session-1-event-2", revision: 2,
      state: { sessionId: "session-1", title: "session-1", phase: "waiting_for_approval", startedAt: now, updatedAt: now + 1, deepLink: "/sessions/session-1", alertEligible: false },
    });
    await backend.mutation(internal.publishers.acceptState, {
      ...publish, nonce: "n2", receivedAt: now + 2, sessionId: "session-2", eventId: "session-2-event-2", revision: 2,
      state: { sessionId: "session-2", title: "session-2", phase: "waiting_for_input", startedAt: now, updatedAt: now + 2, deepLink: "/sessions/session-2" },
    });
    // Both recomputes run after both states are stored, so they compute the same aggregate fingerprint.
    await runScheduledRecomputes(backend);
    const delivered = await jobs(backend);
    expect(delivered.map((job) => [job.kind, job.status])).toEqual([["live_activity_update", "stale"], ["live_activity_update", "queued"]]);
    expect(delivered[0]!.aps).not.toHaveProperty("alert");
    expect(delivered[1]!.aps.alert).toEqual({ title: "session-2", body: "Input needed on Home", sound: "default" });
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

describe("clarification delivery", () => {
  beforeEach(() => { vi.useFakeTimers({ now }); });
  afterEach(() => { vi.useRealTimers(); });

  async function publishQuestion(backend: Backend, route: "snapshot" | "state", revision: number, head: string, alertEligible?: boolean) {
    const state = { ...snapshotState("session-1", revision, "waiting_for_input", alertEligible), inputHeadId: head };
    const envelope = { ...publish, nonce: `q-${revision}`, receivedAt: now + revision };
    if (route === "snapshot") {
      await backend.mutation(internal.publishers.acceptSnapshot, { ...envelope, snapshotId: `q-${revision}`, states: [state] });
    } else {
      const { sessionId, eventId, revision: stateRevision, ...body } = state;
      await backend.mutation(internal.publishers.acceptState, { ...envelope, sessionId, eventId, revision: stateRevision, state: { ...body, sessionId } });
    }
    await runScheduledRecomputes(backend);
  }

  const notifications = async (backend: Backend) => (await backend.run((ctx) => ctx.db.query("deliveryJobs").order("asc").collect()))
    .filter((job) => job.kind === "notification");

  it.each(["snapshot", "state"] as const)("%s publishes each successive eligible question once", async (route) => {
    const backend = await seed({ pushToken: "push-token", activity: false });
    await publishQuestion(backend, route, 2, "question-1");
    await publishQuestion(backend, route, 3, "question-2");
    await publishQuestion(backend, route, 4, "question-2");
    const sent = await notifications(backend);
    expect(sent.map((job) => JSON.parse(job.request.payloadJson).inputHeadId)).toEqual(["question-1", "question-2"]);
    expect(new Set(sent.map((job) => job.request.collapseId)).size).toBe(2);
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: sent[0]!._id, now: now + 5 }))
      .resolves.toEqual({ status: "stale" });
  });

  it("keeps a queued question claimable across a newer heartbeat of its head", async () => {
    const backend = await seed({ pushToken: "push-token", activity: false });
    await publishQuestion(backend, "snapshot", 2, "question-1");
    const [job] = await notifications(backend);
    expect(job).toMatchObject({ status: "queued" });
    await publishQuestion(backend, "snapshot", 3, "question-1");
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: now + 4 }))
      .resolves.toMatchObject({ status: "ready", request: expectedClaimedRequest(job!, 1) });
  });

  it("keeps a muted question consumed and lets the next eligible head alert", async () => {
    const backend = await seed({ pushToken: "push-token", activity: false });
    await publishQuestion(backend, "snapshot", 2, "question-1", false);
    await publishQuestion(backend, "snapshot", 3, "question-1");
    await publishQuestion(backend, "snapshot", 4, "question-2");
    expect((await notifications(backend)).map((job) => JSON.parse(job.request.payloadJson).inputHeadId)).toEqual(["question-2"]);
  });
});

describe.each([false, true])("claim preferences, retry=%s", (retry) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now + 2);
  });
  afterEach(() => vi.useRealTimers());

  async function queuedAlert(activity: boolean, phase: SessionPhase = "waiting_for_approval") {
    // An activity device without a notification token keeps every alert, Time Sensitive included, on its activity.
    const backend = await seed({ pushToken: activity ? undefined : "push-token", activity });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "preferences", receivedAt: now + 1, snapshotId: "preferences",
      states: [snapshotState("session-1", 2, phase), snapshotState("session-2", 1, "running")],
    });
    await runScheduledRecomputes(backend);
    const job = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(job).toMatchObject({ kind: activity ? "live_activity_update" : "notification", status: "queued" });
    expect(JSON.parse(job!.request.payloadJson).aps.alert).toBeDefined();
    if (retry) {
      await expect(backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: now + 2 }))
        .resolves.toMatchObject({ status: "ready" });
    }
    return { backend, job: job! };
  }

  async function changePreferences(backend: Backend, preferences: Partial<NotificationPreferences>) {
    await expect(backend.mutation(internal.devices.upsertDevice, {
      userId: "user-1", sessionId: "login-1", sessionExpiresAt: now + 600_000,
      deviceId: "device-1", label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
      clearPushToken: false, clearPushToStartToken: false,
      preferences: { ...defaultNotificationPreferences, notificationsEnabled: true, ...preferences }, now: now + 3,
    })).resolves.toEqual({ ok: true });
  }

  it("refuses ordinary notifications after notifications are disabled", async () => {
    const { backend, job } = await queuedAlert(false);
    await changePreferences(backend, { notificationsEnabled: false });
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: job._id, now: now + 4 }))
      .resolves.toEqual({ status: "stale" });
    expect(await backend.run(async (ctx) => ctx.db.get(job._id))).toMatchObject({ status: "stale", attemptCount: retry ? 1 : 0 });
  });

  it("refuses existing activity updates after Live Activities are disabled", async () => {
    const { backend, job } = await queuedAlert(true);
    await changePreferences(backend, { liveActivitiesEnabled: false });
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: job._id, now: now + 4 }))
      .resolves.toEqual({ status: "stale" });
  });

  it("refuses push-to-start after Live Activities are disabled and releases its lease", async () => {
    const backend = await seed({ pushToStartToken: "start-token", activity: false });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const job = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(job).toMatchObject({ kind: "live_activity_start", status: "queued" });
    if (retry) {
      await expect(backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: now + 2 }))
        .resolves.toMatchObject({ status: "ready" });
    }
    await changePreferences(backend, { liveActivitiesEnabled: false });
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: now + 4 }))
      .resolves.toEqual({ status: "stale" });
    expect((await backend.run(async (ctx) => ctx.db.query("devices").first()))?.pushToStartIssuedAt).toBeUndefined();
  });

  const categories = [
    ["waiting_for_approval", "notifyOnApproval", 1],
    ["waiting_for_input", "notifyOnInput", 1],
    ["completed", "notifyOnCompletion", 0],
    ["failed", "notifyOnFailure", 0],
  ] as const;

  const soundClaims = [
    ...categories.map(([phase, , badge]) => ({ kind: "notification", phase, badge } as const)),
    { kind: "live_activity_start", phase: "waiting_for_input", badge: 0 },
    { kind: "live_activity_update", phase: "completed", badge: 0 },
    { kind: "live_activity_end", phase: "waiting_for_input", badge: 0 },
  ] as const;

  it.each(soundClaims)("applies the current sound preference to $kind for $phase", async ({ kind, phase, badge }) => {
    const backend = await seed({
      pushToken: kind === "notification" ? "push-token" : undefined,
      pushToStartToken: kind === "live_activity_start" ? "start-token" : undefined,
      activity: kind === "live_activity_update" || kind === "live_activity_end",
    });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      ...publish, nonce: "sound", receivedAt: now + 1, snapshotId: "sound",
      states: [snapshotState("session-1", 2, phase), snapshotState("session-2", 1, "running")],
    });
    const tokenHash = await sha256("sound-test-session");
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", { userId: "user-1", appleSubjectHash: "sound-test-user", createdAt: now, updatedAt: now });
      await ctx.db.insert("userSessions", { userId: "user-1", sessionId: "login-1", tokenHash, expiresAt: now + 60_000, createdAt: now });
      // The states can disappear while a recompute with their transition snapshot is queued.
      if (kind === "live_activity_end") {
        for (const state of await ctx.db.query("sessionStates").collect()) await ctx.db.delete(state._id);
      }
    });
    await runScheduledRecomputes(backend);
    const queued = (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect())).filter((job) => job.kind !== "badge");
    expect(queued.map((job) => job.kind)).toEqual([kind]);
    const [job] = queued;
    const expected = expectedClaimedRequest(job!, badge);
    const audible = JSON.parse(expected.payloadJson);
    const soundPath = kind === "notification" ? "aps.sound" : "aps.alert.sound";
    expect(audible).toHaveProperty(soundPath, "default");
    const claim = (at: number) => backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: at });
    if (retry) await expect(claim(now + 2)).resolves.toMatchObject({ status: "ready", request: expected });

    const register = (notificationSoundEnabled?: boolean) => backend.fetch("/v1/devices/device-1", {
      method: "PUT",
      headers: { authorization: "Bearer sound-test-session", "content-type": "application/json" },
      body: JSON.stringify({
        label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
        preferences: { ...defaultNotificationPreferences, notificationsEnabled: true, notificationSoundEnabled },
      }),
    });
    expect((await register(false)).status).toBe(200);
    const muted = await claim(now + 4);
    expect(muted).toMatchObject({ status: "ready", kind });
    if (muted.status !== "ready") throw new Error("muted alert was not claimable");
    const payload = JSON.parse(muted.request.payloadJson);
    expect(payload).not.toHaveProperty(soundPath);
    if (kind === "notification") delete audible.aps.sound;
    else delete audible.aps.alert.sound;
    expect(payload).toEqual(audible);

    // A later attempt uses the current registration, even when an older client omits the preference.
    expect((await register(retry ? true : undefined)).status).toBe(200);
    await expect(claim(now + 5)).resolves.toMatchObject({ status: "ready", request: expected });
  });

  describe.each([false, true])("activity=%s", (activity) => {
    it.each(categories)("rechecks %s against %s", async (phase, preference) => {
      const { backend, job } = await queuedAlert(activity, phase);
      await changePreferences(backend, { [preference]: false });
      const claimed = await backend.mutation(internal.delivery.claimJob, { jobId: job._id, now: now + 4 });
      if (!activity) {
        expect(claimed).toEqual({ status: "stale" });
        return;
      }
      expect(claimed).toMatchObject({ status: "ready", kind: "live_activity_update" });
      if (claimed.status !== "ready") throw new Error("silent state update was not claimable");
      const aps = JSON.parse(claimed.request.payloadJson).aps;
      expect(aps).not.toHaveProperty("alert");
      expect(aps).not.toHaveProperty("sound");
      expect(aps["content-state"].rows).toEqual(expect.arrayContaining([expect.objectContaining({ phase })]));
      expect((await backend.run(async (ctx) => ctx.db.get(job._id)))?.request).toEqual(claimed.request);
      // A retry must not resurrect the stripped alert if the category is enabled again.
      await changePreferences(backend, {});
      const retried = await backend.mutation(internal.delivery.claimJob, { jobId: job._id, now: now + 5 });
      expect(retried).toMatchObject({ status: "ready", request: claimed.request });
    });

    it.each(categories)("keeps enabled %s delivery", async (phase, _preference, badge) => {
      const { backend, job } = await queuedAlert(activity, phase);
      // Activity alerts have their own policy and do not depend on ordinary notifications.
      await changePreferences(backend, activity ? { notificationsEnabled: false } : { liveActivitiesEnabled: false });
      const claimed = await backend.mutation(internal.delivery.claimJob, { jobId: job._id, now: now + 4 });
      expect(claimed).toMatchObject({ status: "ready", request: expectedClaimedRequest(job, badge) });
      expect(await backend.run(async (ctx) => ctx.db.get(job._id))).toMatchObject({ status: "running", attemptCount: retry ? 2 : 1 });
    });
  });

  it("preserves silent end cleanup after Live Activities are disabled", async () => {
    const backend = await seed({ activity: true });
    await backend.run(async (ctx) => {
      for (const state of await ctx.db.query("sessionStates").collect()) await ctx.db.delete(state._id);
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const job = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").first());
    expect(job).toMatchObject({ kind: "live_activity_end" });
    if (retry) await backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: now + 2 });
    await changePreferences(backend, { liveActivitiesEnabled: false });
    const claimed = await backend.mutation(internal.delivery.claimJob, { jobId: job!._id, now: now + 4 });
    expect(claimed).toMatchObject({ status: "ready", kind: "live_activity_end", request: job!.request });
    if (claimed.status !== "ready") throw new Error("end cleanup was not claimable");
    expect(JSON.parse(claimed.request.payloadJson).aps).not.toHaveProperty("alert");
  });
});
