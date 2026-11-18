import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  classifyApnsFailure,
  makeProviderToken,
  sendHttp2,
  type ApnsWireRequest,
} from "../convex/lib/apnsTransport.node";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";
import { type Backend, now, publish, runScheduledRecomputes, seed, snapshotState } from "./relayFixture";

const modules = import.meta.glob("../convex/**/*.ts");

// What the fake APNs answers; each test starts from a 200.
const http2 = vi.hoisted(() => ({ requests: [] as Record<string, string>[], reply: { status: 200, reason: undefined as string | undefined } }));

vi.mock("node:http2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    connect: () =>
      Object.assign(new EventEmitter(), {
        closed: false,
        destroyed: false,
        close() {
          this.closed = true;
        },
        request(headers: Record<string, string>) {
          http2.requests.push(headers);
          const stream = Object.assign(new EventEmitter(), {
            setEncoding() {},
            destroy() {},
            end() {
              queueMicrotask(() => {
                stream.emit("response", { ":status": http2.reply.status, "apns-id": "apns-id" });
                if (http2.reply.reason) stream.emit("data", JSON.stringify({ reason: http2.reply.reason }));
                stream.emit("end");
              });
            },
          });
          return stream;
        },
      }),
  };
});

// Fake timers hold convex-test's scheduler and the APNs workpool, so a queued job never runs behind a test's back.
beforeEach(() => {
  vi.useFakeTimers({ now });
  http2.requests.length = 0;
  http2.reply = { status: 200, reason: undefined };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("APNs transport", () => {
  it("creates a valid ES256 provider token", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = makeProviderToken({
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      issuedAt: 1_800_000_000,
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iss: "TEAM123",
      iat: 1_800_000_000,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("keeps the per-job apns-collapse-id for Live Activity pushes", async () => {
    const request: ApnsWireRequest = {
      token: "token",
      topic: "dev.kil.talaria.push-type.liveactivity",
      environment: "sandbox",
      pushType: "liveactivity",
      priority: "10",
      payloadJson: "{}",
      jobId: "job-1",
    };
    http2.requests.length = 0;

    await sendHttp2(request, "jwt");
    await sendHttp2(request, "jwt");
    await sendHttp2({ ...request, jobId: "job-2" }, "jwt");

    const [first, retry, other] = http2.requests.map((headers) => headers["apns-collapse-id"]);
    // APNs refuses an apns-collapse-id over 64 bytes.
    expect(Buffer.byteLength(first!)).toBeGreaterThan(0);
    expect(Buffer.byteLength(first!)).toBeLessThanOrEqual(64);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
  });

  it("groups notification alerts by chat and lets the newest replace the previous one", async () => {
    const backend = convexTest(schema, modules);
    workpoolTest.register(backend, "apnsWorkpool");
    const now = Date.now();
    const publisherId = "https://hermes.example";
    const state = (sessionId: string, eventId: string, phase: "waiting_for_approval" | "completed") => ({
      version: 2 as const,
      userId: "user-1",
      profileId: "profile-1",
      deleted: false,
      publisherId,
      publisherLabel: "Home",
      sessionId,
      eventId,
      revision: 1,
      title: "Chat",
      phase,
      updatedAt: now,
      deepLink: `/sessions/${sessionId}`,
      expiresAt: now + 15 * 60_000,
      receivedAt: now,
    });
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        pushToken: "push-token",
        preferences: { ...defaultNotificationPreferences, notificationsEnabled: true },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("sessionStates", state("session-a", "event-a-1", "waiting_for_approval"));
      await ctx.db.insert("sessionStates", state("session-b", "event-b-1", "completed"));
    });
    const notify = async (sessionId: string, previousPhase: "running" | "waiting_for_approval") => {
      await backend.mutation(internal.delivery.recompute, {
        userId: "user-1",
        transitions: [{ publisherId, sessionId, previousPhase }],
      });
      const jobs = await backend.run(async (ctx) =>
        (await ctx.db.query("deliveryJobs").collect()).filter((job) => job.kind === "notification"),
      );
      const job = jobs.at(-1)!;
      await backend.run(async (ctx) => ctx.db.patch(job._id, { status: "done", updatedAt: now }));
      return job;
    };

    const approval = await notify("session-a", "running");
    await backend.run(async (ctx) => {
      const row = (await ctx.db.query("sessionStates").collect()).find((s) => s.sessionId === "session-a")!;
      await ctx.db.patch(row._id, { eventId: "event-a-2", phase: "completed" });
    });
    const completion = await notify("session-a", "waiting_for_approval");
    const otherChat = await notify("session-b", "running");
    expect(new Set([approval._id, completion._id, otherChat._id]).size).toBe(3);

    http2.requests.length = 0;
    const sent = [approval, completion, otherChat];
    for (const job of sent) await sendHttp2({ ...job.request, jobId: job._id }, "jwt");
    const collapseIds = http2.requests.map((headers) => headers["apns-collapse-id"]);
    const threadIds = sent.map((job) => JSON.parse(job.request.payloadJson).aps["thread-id"]);

    expect(collapseIds[1]).toBe(collapseIds[0]);
    expect(collapseIds[2]).not.toBe(collapseIds[0]);
    expect(threadIds).toEqual(collapseIds);
    for (const id of collapseIds) expect(Buffer.byteLength(id!)).toBeLessThanOrEqual(64);
  });

  it("retries transient failures and invalidates only permanent token failures", () => {
    expect(classifyApnsFailure({ status: 500 })).toEqual({ retry: true, invalidateToken: false });
    expect(classifyApnsFailure({ status: 410, reason: "Unregistered" })).toEqual({
      retry: false,
      invalidateToken: true,
    });
    expect(classifyApnsFailure({ status: 403, reason: "InvalidProviderToken" })).toEqual({
      retry: false,
      invalidateToken: false,
    });
  });
});

describe("apns.sendJob", () => {
  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("APNS_TEAM_ID", "TEAM123");
    vi.stubEnv("APNS_KEY_ID", "KEY123");
    vi.stubEnv("APNS_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  });

  // A queued job of each kind, produced by Relay's own publish and recompute.
  async function queuedJob(kind: "notification" | "live_activity_start" | "live_activity_update") {
    const backend = await seed({
      ...(kind === "notification" ? { pushToken: "push-token" } : {}),
      ...(kind === "live_activity_start" ? { pushToStartToken: "start-token" } : {}),
      activity: kind === "live_activity_update",
    });
    if (kind === "notification") {
      await backend.mutation(internal.publishers.acceptSnapshot, {
        ...publish, nonce: "n1", receivedAt: now + 1, snapshotId: "s1",
        states: [snapshotState("session-1", 2, "waiting_for_approval"), snapshotState("session-2", 1, "running")],
      });
      await runScheduledRecomputes(backend);
    } else {
      await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    }
    const job = (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect())).find((row) => row.kind === kind);
    expect(job?.status).toBe("queued");
    return { backend, job: job! };
  }

  const read = (backend: Backend, jobId: Id<"deliveryJobs">) => backend.run(async (ctx) => ({
    job: await ctx.db.get(jobId),
    device: (await ctx.db.query("devices").collect())[0]!,
    activity: (await ctx.db.query("liveActivities").collect())[0],
  }));

  it("marks the job delivered with the APNs id when APNs accepts it", async () => {
    const { backend, job } = await queuedJob("notification");

    await expect(backend.action(internal.apns.sendJob, { jobId: job._id }))
      .resolves.toEqual({ outcome: "delivered", status: 200, apnsId: "apns-id" });
    expect((await read(backend, job._id)).job).toMatchObject({ status: "done", apnsStatus: 200, apnsId: "apns-id" });
  });

  it("throws on a transient failure so the workpool retries, keeping the token", async () => {
    const { backend, job } = await queuedJob("notification");
    http2.reply = { status: 500, reason: "InternalServerError" };

    await expect(backend.action(internal.apns.sendJob, { jobId: job._id })).rejects.toThrow("APNs 500: InternalServerError");
    const after = await read(backend, job._id);
    expect(after.job?.status).toBe("running");
    expect(after.device.pushToken).toBe("push-token");
  });

  it("ends the job without retrying or touching the token on a permanent provider failure", async () => {
    const { backend, job } = await queuedJob("notification");
    http2.reply = { status: 403, reason: "InvalidProviderToken" };

    await expect(backend.action(internal.apns.sendJob, { jobId: job._id }))
      .resolves.toMatchObject({ outcome: "permanent_failure", status: 403 });
    const after = await read(backend, job._id);
    expect(after.job).toMatchObject({ status: "dead", apnsStatus: 403, lastError: "InvalidProviderToken" });
    expect(after.device.pushToken).toBe("push-token");
  });

  it.each([
    ["notification", (state: Awaited<ReturnType<typeof read>>) => expect(state.device.pushToken).toBeUndefined()],
    ["live_activity_start", (state: Awaited<ReturnType<typeof read>>) => expect(state.device.pushToStartToken).toBeUndefined()],
    ["live_activity_update", (state: Awaited<ReturnType<typeof read>>) => expect(state.activity?.endedAt).toBe(now)],
  ] as const)("retires the token a %s job used when APNs says it is unregistered", async (kind, retired) => {
    const { backend, job } = await queuedJob(kind);
    http2.reply = { status: 410, reason: "Unregistered" };

    await expect(backend.action(internal.apns.sendJob, { jobId: job._id }))
      .resolves.toMatchObject({ outcome: "permanent_failure", status: 410 });
    const after = await read(backend, job._id);
    expect(after.job?.status).toBe("dead");
    retired(after);
  });

  it("reuses the provider token for 45 minutes, then signs a new one", async () => {
    const { backend, job } = await queuedJob("notification");
    http2.reply = { status: 500, reason: "InternalServerError" };
    const send = async () => {
      await expect(backend.action(internal.apns.sendJob, { jobId: job._id })).rejects.toThrow("APNs 500");
      return http2.requests.at(-1)!.authorization;
    };

    const first = await send();
    expect(await send()).toBe(first);
    vi.setSystemTime(now + 45 * 60_000);
    expect(await send()).not.toBe(first);
  });
});

