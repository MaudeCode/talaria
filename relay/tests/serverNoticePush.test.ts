import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import { type Backend, now, publish, publisherId, runScheduledRecomputes, seed } from "./relayFixture";

// TAL-2665: an update-available notice alerts each opted-in device of the publisher's owner, once per notice and device.

beforeEach(() => { vi.useFakeTimers({ now }); });
afterEach(() => { vi.useRealTimers(); });

const notice = (nonce: string, noticeId = "update_available:webui:web-v2.1.0", profileId = "profile-1") => ({
  ...publish, profileId, nonce, receivedAt: now + 1, noticeId,
  title: "Talaria Web update available", body: "Talaria Web 2.1.0 is available.", deepLink: "/settings/system",
});

// user-1 owns the publisher: device-1 and device-2 opted in, plus one that left the switch off, one with notifications
// off, one excluding the publisher and one signed out. user-2 shares profile-1 and opted in on its own phone.
async function relay() {
  const backend = await seed({ pushToken: "token-1", activity: false });
  await backend.run(async (ctx) => {
    const on = { ...defaultNotificationPreferences, notificationsEnabled: true, notifyOnUpdateAvailable: true };
    const device = (userId: string, deviceId: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("devices", {
        userId, deviceId, label: deviceId, bundleId: "dev.kil.talaria", apsEnvironment: "production",
        pushToken: `token-${deviceId}`, preferences: on, createdAt: now, updatedAt: now, ...extra,
      });
    const first = await ctx.db.query("devices").first();
    await ctx.db.patch(first!._id, { preferences: on });
    await device("user-1", "device-2");
    await device("user-1", "switch-off", { preferences: { ...on, notifyOnUpdateAvailable: false } });
    await device("user-1", "notifications-off", { preferences: { ...on, notificationsEnabled: false } });
    await device("user-1", "signed-out", { sessionExpiresAt: now });
    await device("user-1", "excluded");
    await ctx.db.insert("devicePublisherExclusions", { userId: "user-1", deviceId: "excluded", publisherId, createdAt: now });
    await ctx.db.insert("publisherGrants", {
      publisherOwnerUserId: "user-1", userId: "user-2", publisherId, profileId: "profile-2", createdAt: now, updatedAt: now,
    });
    await device("user-2", "shared");
  });
  return backend;
}

const alerts = (backend: Backend) => backend.run(async (ctx) =>
  (await ctx.db.query("deliveryJobs").collect()).filter((job) => job.kind === "notification"));

async function pruneDeliveredAlerts(backend: Backend, jobs: Awaited<ReturnType<typeof alerts>>): Promise<Date> {
  for (const job of jobs) await backend.mutation(internal.delivery.markDelivered, { jobId: job._id, apnsStatus: 200, now });
  const retryTime = new Date(now);
  retryTime.setUTCDate(retryTime.getUTCDate() + 8);
  vi.setSystemTime(retryTime);
  await backend.mutation(internal.cleanup.prune, {});
  return retryTime;
}

// Its thread is the publisher's server thread, never a chat's `["alert", publisher, session]` thread.
it("alerts each opted-in device of the publisher's owner once, grouped apart from chat alerts", async () => {
  const backend = await relay();

  await expect(backend.mutation(internal.publishers.acceptServerNotice, notice("n1"))).resolves.toEqual({ status: "accepted" });
  // The same notice through the profile the publisher shares with user-2 reaches neither user-2 nor the owner again.
  await backend.mutation(internal.publishers.acceptServerNotice, notice("n2", undefined, "profile-2"));
  await backend.mutation(internal.publishers.acceptServerNotice, notice("n3"));
  await runScheduledRecomputes(backend);

  const jobs = await alerts(backend);
  expect(jobs.map((job) => job.deviceId).sort()).toEqual(["device-1", "device-2"]);
  const threadId = await sha256(JSON.stringify(["server", publisherId]));
  for (const job of jobs) {
    expect(job.request).toMatchObject({ pushType: "alert", priority: "10" });
    expect(JSON.parse(job.request.payloadJson)).toEqual({
      aps: {
        alert: { title: "Talaria Web update available", body: "Talaria Web 2.1.0 is available." },
        sound: "default", "thread-id": threadId, "interruption-level": "active",
      },
      publisherId, deepLink: "/settings/system",
    });
  }

  // A newer version alerts once more.
  await backend.mutation(internal.publishers.acceptServerNotice, notice("n4", "update_available:webui:web-v2.2.0"));
  await runScheduledRecomputes(backend);
  expect((await alerts(backend)).length).toBe(4);
});

it("drops a queued notice once the device turns the switch off or its user no longer owns the publisher", async () => {
  const backend = await relay();
  await backend.mutation(internal.publishers.acceptServerNotice, notice("n1"));
  await runScheduledRecomputes(backend);
  const jobs = await alerts(backend);
  const job = (deviceId: string) => jobs.find((entry) => entry.deviceId === deviceId)!._id;

  await backend.run(async (ctx) => {
    const device = (await ctx.db.query("devices").collect()).find((entry) => entry.deviceId === "device-2")!;
    await ctx.db.patch(device._id, { preferences: { ...device.preferences, notifyOnUpdateAvailable: false } });
  });
  await expect(backend.mutation(internal.delivery.claimJob, { jobId: job("device-2"), now: now + 2 })).resolves.toEqual({ status: "stale" });
  await expect(backend.mutation(internal.delivery.claimJob, { jobId: job("device-1"), now: now + 2 }))
    .resolves.toMatchObject({ status: "ready", kind: "notification" });

  await backend.mutation(internal.publishers.acceptServerNotice, notice("n2", "update_available:agent:v2.0.0"));
  await runScheduledRecomputes(backend);
  const queued = (await alerts(backend)).find((entry) => entry.sourceServerNoticeId === "update_available:agent:v2.0.0")!;
  // The publisher re-enrolled under another owner: user-1's grant now belongs to it.
  await backend.run(async (ctx) => {
    const grant = (await ctx.db.query("publisherGrants").collect()).find((entry) => entry.userId === "user-1")!;
    await ctx.db.patch(grant._id, { publisherOwnerUserId: "user-3" });
  });
  await expect(backend.mutation(internal.delivery.claimJob, { jobId: queued._id, now: now + 3 })).resolves.toEqual({ status: "stale" });
});

it("does not re-alert after a lost acknowledgement outlives delivery job retention", async () => {
  const backend = await relay();
  await expect(backend.mutation(internal.publishers.acceptServerNotice, notice("original"))).resolves.toEqual({ status: "accepted" });
  await runScheduledRecomputes(backend);
  const jobs = await alerts(backend);
  expect(jobs.map((job) => job.deviceId).sort()).toEqual(["device-1", "device-2"]);
  const retryTime = await pruneDeliveredAlerts(backend, jobs);
  expect(await alerts(backend)).toEqual([]);

  await expect(backend.mutation(internal.publishers.acceptServerNotice, { ...notice("retry"), receivedAt: retryTime.valueOf() })).resolves.toEqual({ status: "accepted" });
  await runScheduledRecomputes(backend);
  expect(await alerts(backend)).toEqual([]);
});

it("keeps one durable receipt per publisher, device and update target across versions", async () => {
  const backend = await relay();
  for (const [nonce, id] of [
    ["web-1", "update_available:webui:web-v2.1.0"],
    ["web-2", "update_available:webui:web-v2.2.0"],
    ["agent-1", "update_available:agent:v2.1.0"],
  ] as const) {
    await expect(backend.mutation(internal.publishers.acceptServerNotice, notice(nonce, id))).resolves.toEqual({ status: "accepted" });
  }
  await runScheduledRecomputes(backend);
  const jobs = await alerts(backend);
  expect(jobs).toHaveLength(6);
  await pruneDeliveredAlerts(backend, jobs);
  expect(await backend.run((ctx) => ctx.db.query("serverNoticeReceipts").collect())).toHaveLength(4);
});
