import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { type Backend, now, publish, runScheduledRecomputes, seed, snapshotState } from "./relayFixture";

const workPublisher = { ...publish, publisherId: "https://work.example", profileId: "work-profile", keyId: "key-2" };
const clearPush = JSON.parse(readFileSync(new URL("../../contracts/fixtures/relay-waiting-badge-push.json", import.meta.url), "utf8")) as {
  pushType: string;
  priority: string;
  payload: { aps: { badge: number } };
};

beforeEach(() => { vi.useFakeTimers({ now }); });
afterEach(() => { vi.useRealTimers(); });

async function publishSnapshot(backend: Backend, publisher: typeof publish, states: ReturnType<typeof snapshotState>[]) {
  const snapshotId = states.map((state) => state.eventId).join(":");
  const result = await backend.mutation(internal.publishers.acceptSnapshot, {
    ...publisher, nonce: snapshotId, receivedAt: now, snapshotId, states,
  });
  expect(result.status).toBe("accepted");
  await runScheduledRecomputes(backend);
}

async function seedTwoWaitingChats() {
  const backend = await seed({ pushToken: "push-token", activity: false });
  await backend.run(async (ctx) => {
    const { publisherId, publisherOwnerUserId: ownerUserId, profileId, keyId } = workPublisher;
    await ctx.db.insert("publishers", { version: 2, ownerUserId, publisherId, label: "Work", enabled: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("publisherKeys", { version: 2, ownerUserId, publisherId, keyId, publicKey: "work-key", activatedAt: now, createdAt: now });
    await ctx.db.insert("publisherGrants", { publisherOwnerUserId: ownerUserId, userId: "user-1", publisherId, profileId, createdAt: now, updatedAt: now });
  });
  await publishSnapshot(backend, workPublisher, [snapshotState("session-1", 1, "waiting_for_input", false)]);
  await publishSnapshot(backend, publish, [snapshotState("session-1", 2, "waiting_for_approval")]);
  return backend;
}

async function pushes(backend: Backend) {
  const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").order("asc").collect());
  return jobs.filter((job) => job.request.pushType === "alert").map((job) => ({
    id: job._id, payload: JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> },
  }));
}

async function latestPush(backend: Backend, withAlert: boolean) {
  const push = (await pushes(backend)).filter(({ payload }) => ("alert" in payload.aps) === withAlert).at(-1);
  if (!push) return undefined;
  const result = await backend.mutation(internal.delivery.claimJob, { jobId: push.id, now });
  if (result.status !== "ready") return result;
  const { pushType, priority, payloadJson } = result.request;
  return { pushType, priority, payload: JSON.parse(payloadJson) as unknown };
}

it("includes both enrolled publishers and profiles in an ordinary alert", async () => {
  const backend = await seedTwoWaitingChats();
  expect(await latestPush(backend, true)).toMatchObject({
    pushType: "alert", payload: { aps: { badge: 2, "interruption-level": "time-sensitive" } },
  });
});

it("sends a badge-only update as waiting chats resolve", async () => {
  const backend = await seedTwoWaitingChats();
  expect(await latestPush(backend, false)).toEqual({ ...clearPush, payload: { aps: { badge: 2 } } });

  await publishSnapshot(backend, publish, [snapshotState("session-1", 3, "running")]);
  expect(await latestPush(backend, false)).toEqual({ ...clearPush, payload: { aps: { badge: 1 } } });

  await publishSnapshot(backend, workPublisher, [snapshotState("session-1", 2, "running")]);
  expect(await latestPush(backend, false)).toEqual(clearPush);
});

it("queues one badge-only job per changed count across snapshot heartbeats", async () => {
  const backend = await seedTwoWaitingChats();
  const beforeHeartbeat = (await pushes(backend)).filter(({ payload }) => !("alert" in payload.aps));
  expect(beforeHeartbeat.map(({ payload }) => payload.aps.badge)).toEqual([1, 2]);

  await publishSnapshot(backend, workPublisher, [snapshotState("session-1", 2, "waiting_for_input", false)]);
  expect((await pushes(backend)).filter(({ payload }) => !("alert" in payload.aps))).toEqual(beforeHeartbeat);
});

it("refreshes the badge on an alert retry after a different publisher's chat resolves", async () => {
  const backend = await seedTwoWaitingChats();
  expect(await latestPush(backend, true)).toMatchObject({ payload: { aps: { badge: 2 } } });

  await publishSnapshot(backend, workPublisher, [snapshotState("session-1", 2, "running")]);
  expect(await latestPush(backend, true)).toMatchObject({ payload: { aps: { badge: 1 } } });
});

it("updates the total when a device excludes a publisher", async () => {
  const backend = await seedTwoWaitingChats();
  await expect(backend.mutation(internal.subscriptions.setForDevice, {
    userId: "user-1", deviceId: "device-1", publisherId: workPublisher.publisherId, subscribed: false, now,
  })).resolves.toEqual({ ok: true });
  await runScheduledRecomputes(backend);

  expect(await latestPush(backend, false)).toEqual({ ...clearPush, payload: { aps: { badge: 1 } } });
});
