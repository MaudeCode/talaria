import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { defaultNotificationPreferences } from "../convex/lib/model";
import { sha256 } from "../convex/lib/crypto";

const modules = import.meta.glob("../convex/**/*.ts");

async function fixture() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  const now = Date.now();
  await backend.run(async (ctx) => {
    await ctx.db.insert("publishers", { version: 2, ownerUserId: "owner", publisherId: "https://hermes.example", label: "Test", enabled: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("publisherKeys", { version: 2, ownerUserId: "owner", publisherId: "https://hermes.example", keyId: "key", publicKey: "test", activatedAt: now, createdAt: now });
    await ctx.db.insert("publisherGrants", { userId: "user", publisherOwnerUserId: "owner", publisherId: "https://hermes.example", profileId: "profile", createdAt: now, updatedAt: now });
    await ctx.db.insert("relayUsers", { userId: "user", appleSubjectHash: "synthetic", createdAt: now, updatedAt: now });
    await ctx.db.insert("userSessions", { userId: "user", sessionId: "auth", tokenHash: await sha256("token"), expiresAt: now + 10 ** 9, createdAt: now });
    await ctx.db.insert("devices", { userId: "user", deviceId: "device", label: "Test", bundleId: "dev.kil.talaria", apsEnvironment: "sandbox", preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now });
    await ctx.db.insert("liveActivities", { userId: "user", deviceId: "device", activityId: "activity", mode: "all_running", attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1, activityPushToken: "synthetic", createdAt: now, updatedAt: now });
  });
  let revision = 0;
  const publish = async (phase: "running" | "completed" | "failed", streamId = "run-1") => {
    revision++;
    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "owner", publisherId: "https://hermes.example", profileId: "profile", keyId: "key",
      nonce: `nonce-${revision}`, nonceExpiresAt: Date.now() + 60_000, receivedAt: Date.now(), snapshotId: `snapshot-${revision}`,
      states: [{ sessionId: "session", streamId, eventId: `event-${revision}`, revision, title: "Synthetic task", phase, updatedAt: Date.now(), deepLink: "/sessions/session" }],
    });
  };
  const list = () => backend.query(internal.completions.list, { userId: "user", deviceId: "device", paginationOpts: { numItems: 100, cursor: null } });
  return { backend, publish, list, now };
}

it("keeps Done through heartbeat expiry, new runs and replay until exact acknowledgement", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  try {
    const { backend, publish, list, now } = await fixture();
    await publish("running");
    await publish("completed");
    const first = (await list())!.completions[0]!;
    expect(first.row.phase).toBe("completed");
    await publish("completed");
    expect((await list())!.completions).toHaveLength(1);
    vi.setSystemTime(new Date(now + 86_400_000));
    await backend.mutation(internal.cleanup.prune, {});
    await backend.mutation(internal.delivery.recompute, { userId: "user" });
    const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
    expect(jobs.at(-1)?.kind).toBe("live_activity_update");
    expect(JSON.parse(jobs.at(-1)!.request.payloadJson).aps["content-state"]).toMatchObject({ activeCount: 0, rows: [{ phase: "completed" }] });
    await publish("running", "run-2");
    const beforeAck = await backend.query(internal.publishers.listCurrentStates, { userId: "user", now: Date.now() });
    expect(beforeAck.some((state) => state.phase === "running" && state.streamId === "run-2")).toBe(true);
    await publish("failed", "run-2");
    expect((await list())!.completions).toHaveLength(2);
    expect(await backend.mutation(internal.completions.acknowledge, { userId: "user", deviceId: "device", ids: [first.id] })).toEqual({ ok: true });
    expect((await list())!.completions.map((c) => c.row.phase)).toEqual(["failed"]);
    await publish("completed", "run-1");
    expect((await list())!.completions.map((c) => c.row.phase)).toEqual(["failed"]);
    const second = (await list())!.completions[0]!;
    await backend.mutation(internal.completions.acknowledge, { userId: "user", deviceId: "device", ids: [first.id, second.id] });
    expect((await list())!.completions).toEqual([]);
    await backend.mutation(internal.delivery.recompute, { userId: "user" });
    expect((await backend.run((ctx) => ctx.db.query("deliveryJobs").collect())).at(-1)?.kind).toBe("live_activity_end");
  } finally { vi.useRealTimers(); }
});

it("requires a live device and current profile grant for listing and acknowledgement", async () => {
  const { backend, publish, list } = await fixture();
  await publish("completed");
  const completion = (await list())!.completions[0]!;
  expect(await backend.mutation(internal.completions.acknowledge, { userId: "attacker", deviceId: "device", ids: [completion.id] })).toEqual({ ok: false });
  const response = await backend.fetch("/v1/activity-completions", { headers: { authorization: "Bearer token", "x-talaria-device-id": "device" } });
  expect(response.status).toBe(200);
  expect((await response.json()).completions).toHaveLength(1);
  await backend.run(async (ctx) => {
    const grant = await ctx.db.query("publisherGrants").first();
    await ctx.db.patch(grant!._id, { profileId: "another-profile" });
  });
  expect((await list())!.completions).toEqual([]);
  expect(await backend.mutation(internal.completions.acknowledge, { userId: "user", deviceId: "device", ids: [completion.id] })).toEqual({ ok: false });
  await backend.run(async (ctx) => {
    const device = await ctx.db.query("devices").first();
    await ctx.db.patch(device!._id, { revokedAt: Date.now() });
  });
  expect(await list()).toBeNull();
});


it("sends native per-session Done as an update and does not repush unchanged terminal content", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_800_000_000_000));
  try {
    const { backend, publish, now } = await fixture();
    await backend.run(async (ctx) => {
      const activity = await ctx.db.query("liveActivities").first();
      await ctx.db.patch(activity!._id, { mode: "per_session", publisherId: "https://hermes.example", sessionId: "session", attributesType: "AgentRunActivityAttributes" });
    });
    await publish("running");
    await publish("completed");
    await backend.mutation(internal.delivery.recompute, { userId: "user" });
    const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
    expect(jobs).toHaveLength(1);
    const aps = JSON.parse(jobs[0]!.request.payloadJson).aps;
    expect(jobs[0]!.kind).toBe("live_activity_update");
    expect(jobs[0]!.request.priority).toBe("10");
    expect(aps.event).toBe("update");
    expect(aps["content-state"]).toEqual({
      sessionID: "session", sessionTitle: "Synthetic task", status: "complete",
      currentActivity: "Done", responseExcerpt: "", startedAt: 821692800,
      updatedAt: 821692800, isStale: false, isFinal: true,
    });
    await backend.mutation(internal.delivery.markDelivered, { jobId: jobs[0]!._id, apnsStatus: 200, now });
    vi.setSystemTime(new Date(now + 180_000));
    await publish("completed");
    await backend.mutation(internal.delivery.recompute, { userId: "user" });
    const afterHeartbeat = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
    expect(afterHeartbeat).toHaveLength(1);
    const headers = { authorization: "Bearer token", "x-talaria-device-id": "device" };
    const snapshot = await backend.fetch("/v1/activity-snapshot?mode=per_session&publisherId=https%3A%2F%2Fhermes.example&sessionId=session", { headers });
    expect((await snapshot.json()).aggregate).toMatchObject({ activeCount: 0, rows: [{ phase: "completed" }] });
    const invalid = await backend.fetch("/v1/activity-completions/acknowledge", {
      method: "POST", headers, body: JSON.stringify({ ids: ["not-an-id"] }),
    });
    expect(invalid.status).toBe(400);
  } finally { vi.useRealTimers(); }
});


it.each(["state", "snapshot"] as const)("backfills legacy terminal rows on duplicate %s publication", async (kind) => {
  const { backend, list, now } = await fixture();
  const state = { sessionId: "legacy-session", streamId: "legacy-run", eventId: "legacy-event", revision: 7,
    title: "Legacy completion", phase: "completed" as const, updatedAt: now, deepLink: "/sessions/legacy-session" };
  await backend.run(async (ctx) => {
    await ctx.db.insert("sessionStates", { ...state, version: 2, userId: "user", profileId: "profile", deleted: false,
      publisherId: "https://hermes.example", publisherLabel: "Test", expiresAt: now + 900_000, terminalExpiresAt: now + 900_000, receivedAt: now });
  });
  const args = { publisherOwnerUserId: "owner", publisherId: "https://hermes.example", profileId: "profile", keyId: "key",
    nonce: "legacy-nonce", nonceExpiresAt: now + 60_000, receivedAt: now };
  const republish = async (nonce: string) => {
    if (kind === "snapshot") {
      await backend.mutation(internal.publishers.acceptSnapshot, { ...args, nonce, snapshotId: nonce, states: [state] });
    } else {
      const { eventId, revision, ...content } = state;
      await backend.mutation(internal.publishers.acceptState, { ...args, nonce, sessionId: state.sessionId, eventId, revision, state: content });
    }
  };
  await republish("legacy-first");
  const completion = (await list())!.completions[0];
  expect(completion?.row.status).toBe("Done");
  await backend.mutation(internal.completions.acknowledge, { userId: "user", deviceId: "device", ids: [completion!.id] });
  await republish("legacy-repeat");
  expect((await list())!.completions).toEqual([]);
  const visible = await backend.query(internal.publishers.listCurrentStates, { userId: "user", now });
  expect(visible).toEqual([]);
});


it("keeps a completed current-session card pinned while a later run starts", async () => {
  const { backend, publish, list, now } = await fixture();
  const registration = { userId: "user", deviceId: "device", mode: "per_session" as const,
    publisherId: "https://hermes.example", sessionId: "session", attributesType: "AgentRunActivityAttributes",
    schemaVersion: 1, seededLocally: false, now };
  expect(await backend.mutation(internal.devices.registerActivity, { ...registration,
    activityId: "activity", activityPushToken: "synthetic", streamId: "run-1" })).toEqual({ ok: true });
  await publish("running");
  await publish("completed");
  await backend.mutation(internal.delivery.recompute, { userId: "user" });
  const firstJob = (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect()))[0]!;
  await publish("running", "run-2");
  expect(await backend.mutation(internal.devices.registerActivity, { ...registration,
    activityId: "activity-2", activityPushToken: "synthetic-2", streamId: "run-2" })).toEqual({ ok: true });
  const activities = await backend.run((ctx) => ctx.db.query("liveActivities").collect());
  expect(activities).toHaveLength(2);
  expect(activities.every((activity) => activity.endedAt === undefined)).toBe(true);
  // The older Done job remains valid even while the same session runs a new stream.
  expect(await backend.mutation(internal.delivery.claimJob, { jobId: firstJob._id, now: Date.now() })).toMatchObject({ status: "ready" });
  await backend.mutation(internal.delivery.markDelivered, { jobId: firstJob._id, apnsStatus: 200, now: Date.now() });
  await backend.mutation(internal.delivery.recompute, { userId: "user" });
  const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
  expect(jobs.filter((job) => job.kind === "live_activity_end")).toHaveLength(0);
  const newJob = jobs.find((job) => job.activityId === "activity-2")!;
  expect(JSON.parse(newJob.request.payloadJson).aps["content-state"].status).toBe("thinking");
  const first = (await list())!.completions[0]!;
  await backend.mutation(internal.completions.acknowledge, { userId: "user", deviceId: "device", ids: [first.id] });
  await backend.mutation(internal.delivery.recompute, { userId: "user" });
  const ends = (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect())).filter((job) => job.kind === "live_activity_end");
  expect(ends.map((job) => job.activityId)).toEqual(["activity"]);
});
