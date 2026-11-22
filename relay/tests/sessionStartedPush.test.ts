import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { defaultNotificationPreferences } from "../convex/lib/model";
import { type Backend, now, publish, publisherId, runScheduledRecomputes, seed } from "./relayFixture";

// TAL-232: a session-started event sends one silent push to each enrolled device the event's profile reaches.

beforeEach(() => { vi.useFakeTimers({ now }); });
afterEach(() => { vi.useRealTimers(); });

const sessionStarted = (nonce: string, eventId = "started:session-3") => ({
  ...publish, nonce, receivedAt: now + 1, sessionId: "session-3", eventId, startedAt: now,
});

// user-1's profile-1 holds device-1 and device-2, plus a revoked, a signed-out and a publisher-excluded device; user-2
// enrolled the same publisher's profile-2 on its own phone.
async function relay() {
  const backend = await seed({ pushToken: "token-1", activity: false });
  await backend.run(async (ctx) => {
    const device = (userId: string, deviceId: string, extra: { revokedAt?: number; sessionExpiresAt?: number } = {}) =>
      ctx.db.insert("devices", {
        userId, deviceId, label: deviceId, bundleId: "dev.kil.talaria", apsEnvironment: "production",
        pushToken: `token-${deviceId}`, preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now, ...extra,
      });
    await device("user-1", "device-2");
    await device("user-1", "revoked", { revokedAt: now - 1 });
    await device("user-1", "signed-out", { sessionExpiresAt: now });
    await device("user-1", "excluded");
    await ctx.db.insert("devicePublisherExclusions", { userId: "user-1", deviceId: "excluded", publisherId, createdAt: now });
    await ctx.db.insert("publisherGrants", {
      publisherOwnerUserId: "user-1", userId: "user-2", publisherId, profileId: "profile-2", createdAt: now, updatedAt: now,
    });
    await device("user-2", "other-profile");
  });
  return backend;
}

const pushes = (backend: Backend) => backend.run(async (ctx) =>
  (await ctx.db.query("deliveryJobs").collect()).filter((job) => job.kind === "background"));

it("sends one silent low-priority push to each enrolled device of the event's profile", async () => {
  const backend = await relay();

  await expect(backend.mutation(internal.publishers.acceptSessionStarted, sessionStarted("n1")))
    .resolves.toEqual({ status: "accepted" });
  await runScheduledRecomputes(backend);

  const jobs = await pushes(backend);
  expect(jobs.map((job) => [job.deviceId, job.request.token]).sort()).toEqual([
    ["device-1", "token-1"], ["device-2", "token-device-2"],
  ]);
  for (const job of jobs) {
    expect(job.request).toMatchObject({ topic: "dev.kil.talaria", pushType: "background", priority: "5" });
    expect(JSON.parse(job.request.payloadJson)).toEqual({
      aps: { "content-available": 1 }, event: "session_started", publisherId, sessionId: "session-3",
    });
  }
});

it("queues nothing more when the same event arrives again after its pushes went out", async () => {
  const backend = await relay();
  await backend.mutation(internal.publishers.acceptSessionStarted, sessionStarted("n1"));
  await runScheduledRecomputes(backend);
  await backend.run(async (ctx) => {
    for (const job of await ctx.db.query("deliveryJobs").collect()) await ctx.db.patch(job._id, { status: "done" });
  });

  await expect(backend.mutation(internal.publishers.acceptSessionStarted, sessionStarted("n2")))
    .resolves.toEqual({ status: "accepted" });
  await runScheduledRecomputes(backend);
  expect(await pushes(backend)).toHaveLength(2);

  await backend.mutation(internal.publishers.acceptSessionStarted, sessionStarted("n3", "started:session-3:again"));
  await runScheduledRecomputes(backend);
  expect(await pushes(backend)).toHaveLength(4);
});

it("sends nothing to a user who re-enrolled the publisher under another profile", async () => {
  const backend = await relay();
  const enroll = (profileId: string) => backend.run(async (ctx) => {
    const grant = (await ctx.db.query("publisherGrants").collect()).find((row) => row.userId === "user-1")!;
    await ctx.db.patch(grant._id, { profileId });
  });
  await backend.mutation(internal.publishers.acceptSessionStarted, sessionStarted("n1"));
  await runScheduledRecomputes(backend);
  const [queued] = await pushes(backend);

  // Re-enrolled after the push was queued: claiming it drops it.
  await enroll("profile-3");
  await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued!._id, now: now + 2 }))
    .resolves.toEqual({ status: "stale" });

  // Re-enrolled between the event and the scheduled fan-out: nothing is queued.
  await enroll("profile-1");
  await backend.mutation(internal.publishers.acceptSessionStarted, sessionStarted("n2", "started:session-4"));
  await enroll("profile-3");
  await runScheduledRecomputes(backend);
  expect(await pushes(backend)).toHaveLength(2);
});
