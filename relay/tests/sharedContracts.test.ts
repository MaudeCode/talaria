import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const fixture = (name: string) => readFileSync(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), "utf8");

const now = 1_800_000_000_000;

// A synthetic relay with one enrolled publisher profile (prf_default) and one signed-in device.
async function relayWithPublisher() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey)));
  await backend.run(async (ctx) => {
    await ctx.db.insert("relayUsers", {
      userId: "contract-user", appleSubjectHash: "contract-apple", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("userSessions", {
      userId: "contract-user", sessionId: "contract-auth", tokenHash: await sha256("contract-session-token"),
      expiresAt: now + 60_000, createdAt: now,
    });
    await ctx.db.insert("publishers", {
      version: 2, ownerUserId: "contract-user", publisherId: "https://contract.example",
      label: "Contract publisher", enabled: true, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("publisherKeys", {
      version: 2, ownerUserId: "contract-user", publisherId: "https://contract.example",
      keyId: "contract-key", publicKey, activatedAt: now, createdAt: now,
    });
    await ctx.db.insert("publisherGrants", {
      userId: "contract-user", publisherOwnerUserId: "contract-user", publisherId: "https://contract.example",
      profileId: "prf_default", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("devices", {
      userId: "contract-user", deviceId: "contract-device", label: "Synthetic phone",
      bundleId: "dev.kil.talaria", apsEnvironment: "sandbox",
      preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now,
    });
  });
  let nonces = 0;
  const signedPut = async (path: string, body: string) => {
    const timestamp = String(now / 1000);
    const nonce = `contract-nonce-${String(nonces++)}`;
    const signed = ["PUT", path, timestamp, nonce, await sha256(body)].join("\n");
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
      "Ed25519", keys.privateKey, new TextEncoder().encode(signed),
    )));
    return await backend.fetch(path, {
      method: "PUT", body,
      headers: {
        "content-type": "application/json", "x-talaria-key-id": "contract-key",
        "x-talaria-timestamp": timestamp, "x-talaria-nonce": nonce, "x-talaria-signature": signature,
      },
    });
  };
  return { backend, signedPut };
}

const publisherPath = (profileId: string, rest: string) =>
  `/v1/publishers/${encodeURIComponent("https://contract.example")}/profiles/${profileId}/${rest}`;

it("accepts the Web publisher and App registration, then returns the shared App snapshot", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const { backend, signedPut } = await relayWithPublisher();
    const response = await signedPut(publisherPath("prf_default", "snapshot"), fixture("publisher-snapshot"));
    expect(response.status).toBe(200);
    const headers = { authorization: "Bearer contract-session-token", "x-talaria-device-id": "contract-device" };
    const snapshot = await backend.fetch("/v1/activity-snapshot?mode=all_running", { headers });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual(JSON.parse(fixture("relay-snapshot")));
    const registration = await backend.fetch("/v1/devices/contract-device/live-activities/contract-activity", {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: fixture("app-registration"),
    });
    expect(registration.status).toBe(200);
  } finally {
    clock.mockRestore();
  }
});

it("accepts only the bounded session-started fields for the publisher's own profile", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const { signedPut } = await relayWithPublisher();
    const body = fixture("publisher-session-started");
    const event = JSON.parse(body) as Record<string, unknown>;
    const path = publisherPath("prf_default", "sessions/contract-session/started");
    expect((await signedPut(path, body)).status).toBe(200);
    for (const invalid of [
      { ...event, title: "Contract fixture" },
      { ...event, version: 2 },
      { ...event, sessionId: "another-session" },
      { ...event, eventId: "e".repeat(201) },
      { ...event, startedAt: 1.5 },
    ]) {
      expect((await signedPut(path, JSON.stringify(invalid))).status).toBe(400);
    }
    // Another profile's scope: the body cannot name it, and the publisher holds no grant for its path.
    expect((await signedPut(path, JSON.stringify({ ...event, profileId: "prf_other" }))).status).toBe(403);
    const other = await signedPut(
      publisherPath("prf_other", "sessions/contract-session/started"),
      JSON.stringify({ ...event, profileId: "prf_other" }),
    );
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ status: "unauthorized" });
  } finally {
    clock.mockRestore();
  }
});

it("times a relay-pushed Live Activity from the run's start, not from the activity's registration", async () => {
  let clock = now;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const { backend, signedPut } = await relayWithPublisher();
    const runStartedAt = now - 60_000;
    const snapshot = (revision: number) => {
      const body = JSON.parse(fixture("publisher-snapshot")) as { snapshotId: string; states: Record<string, unknown>[] };
      body.snapshotId = `contract-snapshot-${String(revision)}`;
      body.states = body.states.map((state) => ({
        ...state, startedAt: runStartedAt, revision: now + revision, eventId: `snapshot:${String(now + revision)}:contract-session`,
        updatedAt: clock,
      }));
      return JSON.stringify(body);
    };
    expect((await signedPut(publisherPath("prf_default", "snapshot"), snapshot(1))).status).toBe(200);
    const invalid = JSON.parse(snapshot(1)) as { states: Record<string, unknown>[] };
    invalid.states[0]!.startedAt = 1.5;
    expect((await signedPut(publisherPath("prf_default", "snapshot"), JSON.stringify(invalid))).status).toBe(400);
    // The phone registers its activity (or reconnects) well after the run began.
    clock = now + 30_000;
    const headers = { authorization: "Bearer contract-session-token", "x-talaria-device-id": "contract-device", "content-type": "application/json" };
    const registration = await backend.fetch("/v1/devices/contract-device/live-activities/contract-activity", {
      method: "PUT", headers, body: fixture("app-registration"),
    });
    expect(registration.status).toBe(200);
    clock = now + 60_000;
    expect((await signedPut(publisherPath("prf_default", "snapshot"), snapshot(2))).status).toBe(200);
    await backend.mutation(internal.delivery.recompute, { userId: "contract-user" });
    const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
    const updates = jobs.filter((job) => job.kind === "live_activity_update" && job.activityId === "contract-activity");
    expect(updates.length).toBeGreaterThan(0);
    // Swift's default Codable Date representation is seconds since 2001-01-01.
    const swiftRunStart = runStartedAt / 1_000 - 978_307_200;
    for (const job of updates) {
      expect(JSON.parse(job.request.payloadJson).aps["content-state"].startedAt).toBe(swiftRunStart);
    }
  } finally {
    spy.mockRestore();
  }
});
