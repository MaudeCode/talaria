import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import { type Backend, now, seed } from "./relayFixture";

const pushToken = "a".repeat(64);
const sessionToken = "notification-test-session";

beforeEach(() => { vi.useFakeTimers({ now }); });
afterEach(() => { vi.useRealTimers(); });

async function relay() {
  const backend = await seed({ pushToken, activity: false });
  const tokenHash = await sha256(sessionToken);
  await backend.run(async (ctx) => {
    await ctx.db.insert("relayUsers", {
      userId: "user-1", appleSubjectHash: "apple-user-1", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("userSessions", {
      userId: "user-1", sessionId: "signed-in-session", tokenHash, expiresAt: now + 60_000, createdAt: now,
    });
    for (const [userId, deviceId, token] of [
      ["user-1", "other-phone", "b".repeat(64)],
      ["user-1", "no-token", undefined],
      ["user-2", "foreign-device", "c".repeat(64)],
    ] as const) {
      await ctx.db.insert("devices", {
        userId, deviceId, label: deviceId, bundleId: "dev.kil.talaria", apsEnvironment: "production",
        pushToken: token, preferences: { ...defaultNotificationPreferences, notificationsEnabled: true },
        createdAt: now, updatedAt: now,
      });
    }
  });
  return backend;
}

function send(backend: Backend, deviceId: string, token: string | null = sessionToken) {
  return backend.fetch(`/v1/devices/${deviceId}/test-notification`, {
    method: "POST", headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

const jobs = (backend: Backend) => backend.run((ctx) => ctx.db.query("deliveryJobs").collect());

it("queues one deliverable test alert for the authenticated device without a session", async () => {
  const backend = await relay();
  const response = await send(backend, "device-1");
  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toEqual({ status: "queued" });

  const queued = await jobs(backend);
  expect(queued).toHaveLength(1);
  const [job] = queued;
  expect(job).toMatchObject({ kind: "notification", status: "queued", userId: "user-1", deviceId: "device-1" });
  expect(job.sourceSessionId).toBeUndefined();
  const claimed = await backend.mutation(internal.delivery.claimJob, { jobId: job._id, now });
  expect(claimed).toMatchObject({ status: "ready", request: { token: pushToken, pushType: "alert" } });
  if (claimed.status !== "ready") throw new Error("Test notification could not be claimed");
  const payload = JSON.parse(claimed.request.payloadJson);
  expect(payload.aps.alert).toEqual({ title: "Talaria test notification", body: "Relay alerts reach this device." });
  expect(payload).not.toHaveProperty("sessionId");
});

it.each([
  ["no device token", "no-token", sessionToken, 409, "no_push_token"],
  ["another user's device", "foreign-device", sessionToken, 404, "not_found"],
  ["an unknown device", "unknown-device", sessionToken, 404, "not_found"],
  ["no authentication", "device-1", null, 401, "unauthorized"],
] as const)("rejects a test notification with %s without queuing a job", async (_, deviceId, token, status, error) => {
  const backend = await relay();
  const response = await send(backend, deviceId, token);
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error });
  await expect(jobs(backend)).resolves.toHaveLength(0);
});

it("admits one concurrent request per device and admits another when the cooldown ends", async () => {
  const backend = await relay();
  const responses = await Promise.all([send(backend, "device-1"), send(backend, "device-1")]);
  expect(responses.map(({ status }) => status).sort()).toEqual([202, 429]);
  expect((await send(backend, "other-phone")).status).toBe(202);

  vi.setSystemTime(now + 29_999);
  const limited = await send(backend, "device-1");
  expect(limited.status).toBe(429);
  await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
  expect(limited.headers.get("Retry-After")).toBe("1");

  vi.setSystemTime(now + 30_000);
  expect((await send(backend, "device-1")).status).toBe(202);
  const deviceJobs = (await jobs(backend)).filter((job) => job.deviceId === "device-1");
  expect(deviceJobs).toHaveLength(2);
  expect(new Set(deviceJobs.map((job) => job.stateFingerprint)).size).toBe(2);
});
