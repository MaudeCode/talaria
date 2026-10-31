import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import {
  classifyApnsFailure,
  makeProviderToken,
  sendHttp2,
  sendWithTransport,
  type ApnsWireRequest,
} from "../convex/lib/apnsTransport.node";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const http2 = vi.hoisted(() => ({ requests: [] as Record<string, string>[] }));

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
                stream.emit("response", { ":status": 200, "apns-id": "apns-id" });
                stream.emit("end");
              });
            },
          });
          return stream;
        },
      }),
  };
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

  it("supports a deterministic fake transport", async () => {
    const request: ApnsWireRequest = {
      token: "token",
      topic: "dev.kil.talaria.push-type.liveactivity",
      environment: "sandbox",
      pushType: "liveactivity",
      priority: "5",
      payloadJson: "{}",
      jobId: "job-1",
    };
    const fake = vi.fn().mockResolvedValue({ status: 200, apnsId: "apns-id" });

    await expect(sendWithTransport(request, "jwt", fake)).resolves.toEqual({
      status: 200,
      apnsId: "apns-id",
    });
    expect(fake).toHaveBeenCalledWith(request, "jwt");
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
    expect(first).toBe(createHash("sha256").update("job-1").digest("base64url"));
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
