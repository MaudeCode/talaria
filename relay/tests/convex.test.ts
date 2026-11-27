import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";
import { readState } from "./relayFixture";

const pairingFixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/relay-pairing.json", import.meta.url), "utf8")) as {
  createInvitation: { publisherId: string };
  publisherAlreadyRegistered: { error: string };
  invalidInvitation: { error: string };
  publisherNotOwned: { error: string };
  ownerSubscription: { publisherId: string; label: string; subscribed: boolean; canRevokeKeys: boolean };
};
const modules = import.meta.glob("../convex/**/*.ts");
// Approval alerts name only the App's Localizable keys, never the session.
const localizedApprovalAlert = {
  title: { "loc-key": "Approval required" },
  body: { "loc-key": "An agent run is waiting for your approval." },
};

// Fake timers hold convex-test's scheduler and the APNs workpool, so no queued job runs or logs behind a test's back,
// or after the file's worker has torn down.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function testBackend() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  return backend;
}

type TestBackend = ReturnType<typeof testBackend>;

function rsaKeyPair(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

/**
 * Signs Apple-shaped identity tokens; `serveJwks` makes Apple's JWKS endpoint publish the key as "apple-live-shaped".
 * Create it once per file: the relay caches Apple's keys per isolate, across test backends.
 */
async function appleIdentityFixture() {
  const apple = await rsaKeyPair();
  const forger = await rsaKeyPair();
  const publicKey = await webcrypto.subtle.exportKey("jwk", apple.publicKey);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let subject = 0;
  const token = async ({ kid = "apple-live-shaped", forged = false } = {}) => {
    const now = Math.floor(Date.now() / 1_000);
    const header = encode({ alg: "RS256", kid });
    subject += 1;
    const claims = encode({
      iss: "https://appleid.apple.com",
      aud: "dev.kil.talaria",
      sub: `apple-user-${subject}`,
      exp: now + 600,
      iat: now,
      nonce: "hashed-nonce",
    });
    const signature = Buffer.from(await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      (forged ? forger : apple).privateKey,
      new TextEncoder().encode(`${header}.${claims}`),
    )).toString("base64url");
    return `${header}.${claims}.${signature}`;
  };
  const signIn = (backend: TestBackend, identityToken: string, clientAddress?: string) => backend.fetch("/v1/auth/apple", {
    method: "POST",
    headers: { "content-type": "application/json", ...(clientAddress ? { "x-forwarded-for": clientAddress } : {}) },
    body: JSON.stringify({ identityToken, nonce: "hashed-nonce" }),
  });
  const globalBudget = (backend: TestBackend) => backend.run((ctx) => ctx.db
    .query("authRateLimits")
    .withIndex("by_key", (query) => query.eq("key", "apple-auth-global"))
    .unique());
  const serveJwks = () => {
    const appleFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      keys: [{ ...publicKey, kid: "apple-live-shaped", alg: "RS256" }],
    }), { status: 200 }));
    process.env.APPLE_SUBJECT_HASH_KEY = "test-subject-hash-key-that-is-at-least-32-bytes";
    process.env.APPLE_CLIENT_IDS = "dev.kil.talaria";
    return () => {
      appleFetch.mockRestore();
      delete process.env.APPLE_SUBJECT_HASH_KEY;
      delete process.env.APPLE_CLIENT_IDS;
    };
  };
  return { token, signIn, globalBudget, serveJwks };
}

describe("Apple sign-in", () => {
  let apple: Awaited<ReturnType<typeof appleIdentityFixture>>;
  let stopServingJwks: () => void;
  beforeAll(async () => { apple = await appleIdentityFixture(); });
  beforeEach(() => { stopServingJwks = apple.serveJwks(); });
  afterEach(() => { stopServingJwks(); });

  it("accepts an Apple-shaped RS256 identity token through the HTTP router", async () => {
    const backend = testBackend();
    const response = await apple.signIn(backend, await apple.token());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ userId: expect.any(String) });
  });

  it("keeps forged tokens off the global budget so a real sign-in still succeeds", async () => {
    const backend = testBackend();
    const forged = await apple.token({ forged: true });
    const statuses = new Set<number>();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      statuses.add((await apple.signIn(backend, forged, `10.0.${attempt >> 8}.${attempt & 255}`)).status);
    }
    expect([...statuses]).toEqual([401]);
    expect(await apple.globalBudget(backend)).toBeNull();
    const valid = await apple.token();
    expect((await apple.signIn(backend, valid, "192.0.2.1")).status).toBe(201);
    expect((await apple.signIn(backend, valid, "192.0.2.1")).status).toBe(409);
    expect(await apple.globalBudget(backend)).toMatchObject({ attempts: 1 });
  });

  it("limits unverified attempts per client address", async () => {
    const backend = testBackend();
    const forged = await apple.token({ forged: true });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await apple.signIn(backend, forged, "203.0.113.7")).status).toBe(401);
    }
    expect((await apple.signIn(backend, forged, "203.0.113.7, 10.9.9.9")).status).toBe(429);
    expect((await apple.signIn(backend, forged, "198.51.100.2")).status).toBe(401);
  });

  it("rejects a key id missing from Apple's JWKS before any signature check or global charge", async () => {
    const backend = testBackend();
    const verify = vi.spyOn(globalThis.crypto.subtle, "verify");
    try {
      expect((await apple.signIn(backend, await apple.token({ kid: "unknown-kid" }), "203.0.113.7")).status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
    expect(await apple.globalBudget(backend)).toBeNull();
  });

  it("still limits verified sign-ins to 300 a minute across the relay", async () => {
    const backend = testBackend();
    const windowStartedAt = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("authRateLimits", { key: "apple-auth-global", windowStartedAt, attempts: 299 });
    });
    expect((await apple.signIn(backend, await apple.token(), "192.0.2.1")).status).toBe(201);
    expect((await apple.signIn(backend, await apple.token(), "192.0.2.2")).status).toBe(429);
    expect(await backend.run((ctx) => ctx.db.query("relayUsers").collect())).toHaveLength(1);
    vi.setSystemTime(windowStartedAt + 60_000);
    expect((await apple.signIn(backend, await apple.token(), "192.0.2.2")).status).toBe(201);
  });
});

describe("Convex relay state", () => {
  it("coordinates Apple JWKS refreshes through durable relay state", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await expect(backend.mutation(internal.auth.claimAppleJwks, { now })).resolves.toEqual({
      status: "refresh",
    });
    await expect(backend.mutation(internal.auth.claimAppleJwks, { now: now + 1 })).resolves.toEqual({
      status: "wait",
    });
    await backend.mutation(internal.auth.saveAppleJwks, {
      keysJson: "[{\"kty\":\"RSA\"}]",
      expiresAt: now + 60_000,
      now: now + 2,
    });
    await expect(backend.mutation(internal.auth.claimAppleJwks, { now: now + 3 })).resolves.toEqual({
      status: "cached",
      keysJson: "[{\"kty\":\"RSA\"}]",
      expiresAt: now + 60_000,
    });
    await expect(
      backend.mutation(internal.auth.claimAppleJwks, { now: now + 60_001 }),
    ).resolves.toEqual({ status: "refresh" });
  });

  it("canonicalizes publisher origins and rejects untrusted APNs topics at the HTTP boundary", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "user-1",
        appleSubjectHash: "apple-user-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("userSessions", {
        userId: "user-1",
        sessionId: "session-1",
        tokenHash: await sha256("session-token"),
        expiresAt: now + 60_000,
        createdAt: now,
      });
    });
    const issueInvitation = (body: object) => backend.fetch("/v1/pairings/publisher", {
      method: "POST",
      headers: { authorization: "Bearer session-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    for (const body of [{}, { publisherId: "https://hermes.example/path" }]) {
      const rejected = await issueInvitation(body);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({ error: "invalid_pairing" });
    }
    const issued = await issueInvitation({ publisherId: "https://Hermes.Example:443" });
    expect(issued.status).toBe(201);
    const { invitation } = await issued.json() as { invitation: string };

    const pairing = await backend.fetch("/v1/pairings/publisher/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitation,
        publisherId: "https://Hermes.Example:443",
        profileId: "profile-1",
        label: "Home",
        publicKey: Buffer.alloc(32).toString("base64url"),
      }),
    });
    expect(pairing.status).toBe(201);
    await expect(pairing.json()).resolves.toMatchObject(pairingFixture.createInvitation);

    const replacement = await issueInvitation(pairingFixture.createInvitation);
    const replacementInvitation = (await replacement.json() as { invitation: string }).invitation;
    const unsigned = await backend.fetch("/v1/pairings/publisher/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitation: replacementInvitation,
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        label: "Home",
        publicKey: Buffer.alloc(32, 1).toString("base64url"),
      }),
    });
    expect(unsigned.status).toBe(400);
    await expect(unsigned.json()).resolves.toEqual(pairingFixture.publisherAlreadyRegistered);

    const deviceBody = {
      label: "iPhone",
      bundleId: "dev.kil.talaria",
      apsEnvironment: "sandbox",
      pushToken: "ab".repeat(32),
      preferences: defaultNotificationPreferences,
    };
    const putDevice = (body: unknown) =>
      backend.fetch("/v1/devices/device-1", {
        method: "PUT",
        headers: {
          authorization: "Bearer session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    await expect(putDevice(deviceBody).then((response) => response.status)).resolves.toBe(200);
    await expect(
      putDevice({ ...deviceBody, bundleId: "dev.attacker.app" }).then(
        (response) => response.status,
      ),
    ).resolves.toBe(400);
    await expect(
      putDevice({ ...deviceBody, bundleId: "dev.kil.talaria.branch" }).then(
        (response) => response.status,
      ),
    ).resolves.toBe(200);
    await expect(
      putDevice({
        ...deviceBody,
        bundleId: "dev.kil.talaria.branch",
        apsEnvironment: "production",
      }).then((response) => response.status),
    ).resolves.toBe(200);
  });

  it("leaves every device untouched when a device upsert is refused", async () => {
    const now = 1_800_000_000_000;
    const seed = (backend: ReturnType<typeof testBackend>, destination: "new" | "existing" | "revoked") =>
      backend.run(async (ctx) => {
        const device = (userId: string, deviceId: string, tokens: object) => ({
          userId, sessionId: `${userId}-session`, sessionExpiresAt: now + 600_000, deviceId,
          label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production" as const,
          preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now, ...tokens,
        });
        await ctx.db.insert("devices", device("viewer", "old-device", {
          pushToken: "ordinary-token", pushToStartToken: "own-start-token", pushToStartIssuedAt: now,
        }));
        await ctx.db.insert("devices", device("other-user", "foreign-device", {
          pushToken: "foreign-token", pushToStartToken: "foreign-start-token", pushToStartIssuedAt: now,
        }));
        if (destination !== "new") {
          await ctx.db.insert("devices", device("viewer", "new-device", {
            pushToken: "destination-token",
            ...(destination === "revoked" ? { revokedAt: now } : {}),
          }));
        }
      });
    const devices = (backend: ReturnType<typeof testBackend>) =>
      backend.run(async (ctx) => JSON.stringify(await ctx.db.query("devices").collect()));
    const upsert = (backend: ReturnType<typeof testBackend>, tokens: object) =>
      backend.mutation(internal.devices.upsertDevice, {
        userId: "viewer", sessionId: "viewer-session", sessionExpiresAt: now + 600_000,
        deviceId: "new-device", label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
        clearPushToken: false, clearPushToStartToken: false,
        preferences: defaultNotificationPreferences, now: now + 1, ...tokens,
      });

    const refusals: [("new" | "existing" | "revoked"), object][] = [
      ["new", { pushToken: "ordinary-token", pushToStartToken: "foreign-start-token" }],
      ["existing", { pushToken: "ordinary-token", pushToStartToken: "foreign-start-token" }],
      ["new", { pushToken: "foreign-token", pushToStartToken: "own-start-token" }],
      ["existing", { pushToken: "foreign-token" }],
      ["new", { pushToStartToken: "foreign-start-token" }],
      ["revoked", { pushToken: "ordinary-token", pushToStartToken: "own-start-token" }],
    ];
    for (const [destination, tokens] of refusals) {
      const backend = testBackend();
      await seed(backend, destination);
      const before = await devices(backend);
      await expect(upsert(backend, tokens)).resolves.toEqual({ ok: false });
      expect(await devices(backend), JSON.stringify({ destination, tokens })).toBe(before);
    }

    const tokensOf = (backend: ReturnType<typeof testBackend>, deviceId: string) =>
      backend.run(async (ctx) => {
        const row = await ctx.db.query("devices").withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "viewer").eq("deviceId", deviceId)).unique();
        return {
          pushToken: row?.pushToken,
          pushToStartToken: row?.pushToStartToken,
          pushToStartIssuedAt: row?.pushToStartIssuedAt,
        };
      });
    const transfers: [object, object, object][] = [
      [
        { pushToken: "ordinary-token", pushToStartToken: "own-start-token" },
        { pushToken: undefined, pushToStartToken: undefined, pushToStartIssuedAt: undefined },
        { pushToken: "ordinary-token", pushToStartToken: "own-start-token", pushToStartIssuedAt: undefined },
      ],
      [
        { pushToken: "ordinary-token" },
        { pushToken: undefined, pushToStartToken: "own-start-token", pushToStartIssuedAt: now },
        { pushToken: "ordinary-token", pushToStartToken: undefined, pushToStartIssuedAt: undefined },
      ],
      [
        { pushToStartToken: "own-start-token", clearPushToken: true },
        { pushToken: "ordinary-token", pushToStartToken: undefined, pushToStartIssuedAt: undefined },
        { pushToken: undefined, pushToStartToken: "own-start-token", pushToStartIssuedAt: undefined },
      ],
    ];
    for (const [tokens, oldDevice, newDevice] of transfers) {
      const backend = testBackend();
      await seed(backend, "existing");
      await expect(upsert(backend, tokens)).resolves.toEqual({ ok: true });
      await expect(tokensOf(backend, "old-device")).resolves.toEqual(oldDevice);
      await expect(tokensOf(backend, "new-device")).resolves.toEqual(newDevice);
    }
  });

  describe("Apple sign-in and publisher invitations", () => {
    const now = 1_800_000_000_000;
    const publisherId = "https://hermes.example";
    const redemption = {
      tokenHash: "invitation-hash", publisherId, profileId: "profile-1", keyId: "key-1", label: "Home", publicKey: "public-key", now,
    };
    type Backend = ReturnType<typeof testBackend>;
    const signIn = {
      appleSubjectHash: "subject-hash", appleTokenHash: "apple-token-hash", appleTokenExpiresAt: now + 600_000,
      userId: "user-1", sessionId: "session-1", sessionTokenHash: "session-token-hash", sessionExpiresAt: now + 86_400_000, now,
    };
    // Invitations belong to a Relay user, whom Apple sign-in creates.
    async function signedIn() {
      const backend = testBackend();
      await backend.mutation(internal.auth.acceptAppleSignIn, signIn);
      return backend;
    }
    const invite = (backend: Backend, tokenHash: string, at = now) => backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-1", publisherId, tokenHash, expiresAt: at + 60_000, now: at,
    });
    const redeem = (backend: Backend, overrides: Partial<import("convex/server").FunctionArgs<typeof internal.pairing.redeemPublisherInvitation>> = {}) =>
      backend.mutation(internal.pairing.redeemPublisherInvitation, { ...redemption, ...overrides });
    const publisherKey = (backend: Backend, keyId: string) => backend.query(internal.pairing.getPublisherKey, { publisherId, keyId });
    const publishAs = (backend: Backend, keyId: string, profileId: string, receivedAt: number) =>
      backend.mutation(internal.publishers.acceptState, {
        publisherOwnerUserId: "user-1", publisherId, profileId, keyId, nonce: `activate-${keyId}`, nonceExpiresAt: now + 60_000,
        receivedAt, sessionId: "session-1", eventId: "event-1", revision: 1,
        state: { sessionId: "session-1", title: "Activate", phase: "running" as const, startedAt: now, updatedAt: receivedAt, deepLink: "/sessions/session-1" },
      });
    // A publisher enrolled with key-1, then given replacement key-2 through a second invitation.
    async function replacedKey() {
      const backend = await signedIn();
      await invite(backend, "invitation-hash");
      await redeem(backend);
      await invite(backend, "replacement-invitation-hash", now + 1);
      const replacement = await redeem(backend, {
        tokenHash: "replacement-invitation-hash", keyId: "key-2", profileId: "different-profile", now: now + 1,
        authorization: {
          publisherOwnerUserId: "user-1", keyId: "key-1", nonce: "replacement",
          nonceExpiresAt: now + 60_000, receivedAt: now + 1,
        },
      });
      return { backend, replacement };
    }

    it("refuses a replayed Apple sign-in token", async () => {
      const backend = testBackend();
      await expect(backend.mutation(internal.auth.acceptAppleSignIn, signIn)).resolves.toEqual({ ok: true, userId: "user-1" });
      await expect(backend.mutation(internal.auth.acceptAppleSignIn, {
        ...signIn, sessionId: "session-replay", sessionTokenHash: "session-token-replay",
      })).resolves.toEqual({ ok: false, reason: "replay" });
    });

    it("consumes a publisher invitation exactly once", async () => {
      const backend = await signedIn();
      await invite(backend, "invitation-hash");
      await expect(redeem(backend)).resolves.toMatchObject({
        ok: true, protocolVersion: 2, userId: "user-1", publisherId, profileId: "profile-1", profileIdPreserved: false, keyId: "key-1",
      });
      await expect(redeem(backend, { keyId: "key-2" })).resolves.toEqual({ ok: false, reason: "expired_invitation" });
    });

    it("refuses a sixth open invitation for one user until one is used or expires", async () => {
      const backend = await signedIn();
      for (let index = 0; index < 5; index += 1) await expect(invite(backend, `open-${index}`)).resolves.toEqual({ ok: true });
      await expect(invite(backend, "sixth")).resolves.toEqual({ ok: false, reason: "too_many_invitations" });
      await redeem(backend, { tokenHash: "open-0" });
      await expect(invite(backend, "after-use")).resolves.toEqual({ ok: true });
      await expect(invite(backend, "after-expiry", now + 60_000)).resolves.toEqual({ ok: true });
    });

    it("refuses an eleventh active publisher for one user and keeps the ones already registered", async () => {
      const backend = await signedIn();
      const origins = Array.from({ length: 10 }, (_, index) => `https://p${index}.example`);
      await backend.run(async (ctx) => {
        for (const origin of [...origins, publisherId]) {
          await ctx.db.insert("publishers", {
            version: 2, ownerUserId: "user-1", publisherId: origin, label: origin,
            enabled: origin !== publisherId, createdAt: now, updatedAt: now,
          });
        }
      });
      await invite(backend, "invitation-hash");
      await expect(redeem(backend)).resolves.toEqual({ ok: false, reason: "too_many_publishers" });
      await backend.mutation(internal.pairing.createPublisherInvitation, {
        userId: "user-1", publisherId: origins[0]!, tokenHash: "existing", expiresAt: now + 60_000, now,
      });
      await expect(redeem(backend, { tokenHash: "existing", publisherId: origins[0]! })).resolves.toMatchObject({ ok: true });
      const enabled = await backend.run(async (ctx) => (await ctx.db.query("publishers").collect()).filter((row) => row.enabled).length);
      expect(enabled).toBe(10);
    });

    it("rejects unbound invitations and leaves an origin-bound invitation usable after a mismatch", async () => {
      const backend = await signedIn();
      await backend.run(async (ctx) => {
        await ctx.db.insert("publisherInvitations", {
          userId: "user-1", tokenHash: "legacy", expiresAt: now + 60_000, createdAt: now,
        });
      });
      await invite(backend, "invitation-hash");
      const mismatch = { ...redemption, publisherId: "https://other.example" };
      await expect(redeem(backend, mismatch)).resolves.toEqual({ ok: false, reason: pairingFixture.invalidInvitation.error });
      await expect(backend.mutation(internal.pairing.redeemProfileInvitation, {
        tokenHash: mismatch.tokenHash, publisherId: mismatch.publisherId,
        publisherOwnerUserId: "user-1", profileId: mismatch.profileId, now,
      })).resolves.toEqual({ ok: false, reason: pairingFixture.invalidInvitation.error });
      await expect(redeem(backend, { tokenHash: "legacy" })).resolves.toEqual({ ok: false, reason: pairingFixture.invalidInvitation.error });
      expect(await backend.run((ctx) => ctx.db.query("publisherKeys").collect())).toEqual([]);
      await expect(redeem(backend)).resolves.toMatchObject({ ok: true, publisherId });
    });

    it("keeps the profile and the old key when a replacement key enrols through a new invitation", async () => {
      const { backend, replacement } = await replacedKey();
      expect(replacement).toMatchObject({ ok: true, keyId: "key-2", profileId: "profile-1", profileIdPreserved: true });
      const ownerGrant = await backend.run(async (ctx) => ctx.db.query("publisherGrants")
        .withIndex("by_user_id_and_publisher_id", (query) => query.eq("userId", "user-1").eq("publisherId", publisherId))
        .unique());
      expect(ownerGrant?.profileId).toBe("profile-1");
      const enrollment = await backend.run(async (ctx) => ({
        keys: (await ctx.db.query("publisherKeys").collect()).map((key) => key.keyId),
        unconsumed: (await ctx.db.query("publisherInvitations").collect())
          .filter((invitation) => invitation.consumedAt === undefined).length,
      }));
      expect(enrollment).toEqual({ keys: ["key-1", "key-2"], unconsumed: 0 });
      expect(await publisherKey(backend, "key-1")).not.toHaveProperty("revokedAt");
    });

    it("revokes the old key once the replacement key first publishes", async () => {
      const { backend } = await replacedKey();
      await publishAs(backend, "key-2", "profile-1", now + 2);
      await expect(publisherKey(backend, "key-1")).resolves.toMatchObject({ revokedAt: now + 2 });
      expect(await publisherKey(backend, "key-2")).not.toHaveProperty("revokedAt");
    });

    it("lets the owner revoke publisher keys after removing their own grant and register again", async () => {
      const { backend } = await replacedKey();
      vi.setSystemTime(now + 3);
      await backend.mutation(internal.subscriptions.revokePublisher, { userId: "user-1", publisherId, now: now + 2 });
      const revoke = (token: string) => backend.fetch(`/v1/publisher-keys?publisherId=${encodeURIComponent(publisherId)}`, {
        method: "DELETE", headers: { authorization: `Bearer ${token}` },
      });
      await backend.run(async (ctx) => {
        const session = await ctx.db.query("userSessions").first();
        if (!session) throw new Error("owner session missing");
        await ctx.db.patch(session._id, { tokenHash: await sha256("recovery-session") });
        await ctx.db.insert("relayUsers", {
          userId: "viewer", appleSubjectHash: "viewer-apple", createdAt: now, updatedAt: now,
        });
        await ctx.db.insert("userSessions", {
          userId: "viewer", sessionId: "viewer-session", tokenHash: await sha256("viewer-session"),
          expiresAt: now + 60_000, createdAt: now,
        });
        await ctx.db.insert("devices", {
          userId: "user-1", deviceId: "recovery-device", label: "iPhone",
          bundleId: "dev.kil.talaria", apsEnvironment: "sandbox",
          preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now,
        });
      });
      const subscriptions = () => backend.fetch("/v1/devices/recovery-device/publisher-subscriptions", {
        headers: { authorization: "Bearer recovery-session" },
      }).then((response) => response.json());
      expect(await subscriptions()).toEqual({
        publishers: [pairingFixture.ownerSubscription],
      });
      const denied = await revoke("viewer-session");
      expect(denied.status).toBe(404);
      await expect(denied.json()).resolves.toEqual(pairingFixture.publisherNotOwned);
      await expect(publisherKey(backend, "key-1")).resolves.not.toHaveProperty("revokedAt");
      await invite(backend, "pre-revocation-invitation", now + 2);
      expect((await revoke("recovery-session")).status).toBe(200);
      expect(await subscriptions()).toEqual({ publishers: [] });
      await expect(redeem(backend, { tokenHash: "pre-revocation-invitation", now: now + 3 }))
        .resolves.toEqual({ ok: false, reason: pairingFixture.invalidInvitation.error });
      for (const keyId of ["key-1", "key-2"]) {
        await expect(publisherKey(backend, keyId)).resolves.toMatchObject({ revokedAt: now + 3 });
      }
      await invite(backend, "recovery-invitation", now + 4);
      await expect(redeem(backend, {
        tokenHash: "recovery-invitation", profileId: "recovered-profile", keyId: "key-3", now: now + 4,
      })).resolves.toMatchObject({ ok: true, profileId: "recovered-profile" });
      await expect(publishAs(backend, "key-1", "recovered-profile", now + 5))
        .resolves.toEqual({ status: "unauthorized" });
      await expect(publishAs(backend, "key-3", "recovered-profile", now + 5)).resolves.toEqual({ status: "accepted" });
    });
  });

  it("keeps one server publisher while isolating enrolled profile state", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      for (const userId of ["user-a", "user-b"]) {
        await ctx.db.insert("relayUsers", {
          userId,
          appleSubjectHash: `apple-${userId}`,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await backend.mutation(internal.pairing.createPublisherInvitation, {
      publisherId: "https://hermes.example",
      userId: "user-a",
      tokenHash: "invite-a",
      expiresAt: now + 60_000,
      now,
    });
    await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, {
      tokenHash: "invite-a",
      publisherId: "https://hermes.example",
      profileId: "profile-a",
      keyId: "key-1",
      label: "Home",
      publicKey: "public-key",
      now,
    })).resolves.toMatchObject({ ok: true, publisherId: "https://hermes.example" });

    await backend.mutation(internal.pairing.createPublisherInvitation, {
      publisherId: "https://hermes.example",
      userId: "user-b",
      tokenHash: "invite-b",
      expiresAt: now + 60_000,
      now,
    });
    await expect(backend.mutation(internal.pairing.redeemProfileInvitation, {
      publisherOwnerUserId: "user-a",
      tokenHash: "invite-b",
      publisherId: "https://hermes.example",
      profileId: "profile-b",
      now: now + 1,
    })).resolves.toMatchObject({ ok: true, userId: "user-b" });

    const publish = (profileId: string, sessionId: string, nonce: string) =>
      backend.mutation(internal.publishers.acceptSnapshot, {
        publisherOwnerUserId: "user-a",
        publisherId: "https://hermes.example",
        profileId,
        keyId: "key-1",
        nonce,
        nonceExpiresAt: now + 60_000,
        receivedAt: now + 2,
        snapshotId: `snapshot-${profileId}`,
        states: [{
          sessionId,
          eventId: `event-${sessionId}`,
          revision: 1,
          title: `Title ${sessionId}`,
          phase: "running" as const,
          startedAt: now, updatedAt: now + 2,
          deepLink: `/sessions/${sessionId}`,
        }],
      });
    await publish("profile-a", "session-a", "nonce-a");
    await publish("profile-b", "session-b", "nonce-b");

    await expect(backend.query(internal.publishers.listCurrentStates, {
      userId: "user-a",
      now,
    })).resolves.toEqual([expect.objectContaining({ sessionId: "session-a" })]);
    await expect(backend.query(internal.publishers.listCurrentStates, {
      userId: "user-b",
      now,
    })).resolves.toEqual([expect.objectContaining({ sessionId: "session-b" })]);
    const counts = await backend.run(async (ctx) => ({
      publishers: (await ctx.db.query("publishers").collect()).length,
      keys: (await ctx.db.query("publisherKeys").collect()).length,
      grants: (await ctx.db.query("publisherGrants").collect()).length,
    }));
    expect(counts).toEqual({ publishers: 1, keys: 1, grants: 2 });
  });

  it("ignores v1 relay rows and requires a fresh v2 registration", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "user-1",
        appleSubjectHash: "apple-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publishers", {
        userId: "user-1",
        publisherId: "https://hermes.example",
        label: "Legacy",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        userId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "legacy-key",
        publicKey: "legacy-public-key",
        createdAt: now,
      });
      await ctx.db.insert("sessionStates", {
        userId: "user-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Legacy",
        sessionId: "legacy-session",
        eventId: "legacy-event",
        revision: 1,
        title: "Legacy state",
        phase: "running",
        updatedAt: now,
        deepLink: "/sessions/legacy-session",
        expiresAt: now + 60_000,
        receivedAt: now,
      });
      await ctx.db.insert("publisherInvitations", {
        publisherId: "https://hermes.example",
        userId: "user-1",
        tokenHash: "fresh-invitation",
        expiresAt: now + 60_000,
        createdAt: now,
      });
    });

    await expect(backend.query(internal.pairing.getPublisherKey, {
      publisherId: "https://hermes.example",
      keyId: "legacy-key",
    })).resolves.toBeNull();
    await expect(backend.query(internal.publishers.listCurrentStates, {
      userId: "user-1",
      now,
    })).resolves.toEqual([]);
    await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, {
      tokenHash: "fresh-invitation",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "v2-key",
      label: "Home",
      publicKey: "v2-public-key",
      now,
    })).resolves.toMatchObject({ ok: true, keyId: "v2-key" });
  });

  it("does not let another relay user reserve a Hermes origin", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    for (const userId of ["attacker", "owner"]) {
      await backend.run(async (ctx) => {
        await ctx.db.insert("relayUsers", {
          userId,
          appleSubjectHash: `apple-${userId}`,
          createdAt: now,
          updatedAt: now,
        });
      });
      await backend.mutation(internal.pairing.createPublisherInvitation, {
        userId,
        publisherId: "https://hermes.example",
        tokenHash: `invite-${userId}`,
        expiresAt: now + 60_000,
        now,
      });
      await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, {
        tokenHash: `invite-${userId}`,
        publisherId: "https://hermes.example",
        profileId: `profile-${userId}`,
        keyId: `key-${userId}`,
        label: "Home",
        publicKey: `public-key-${userId}`,
        now,
      })).resolves.toMatchObject({ ok: true, userId });
    }

    const owners = await backend.run(async (ctx) => (await ctx.db.query("publishers").collect())
      .map((publisher) => publisher.ownerUserId)
      .sort());
    expect(owners).toEqual(["attacker", "owner"]);
  });

  it("leaves every record unchanged when publisher registration refuses an over-limit replacement", async () => {
    for (const existingPublisher of [false, true]) {
      const backend = testBackend();
      const now = 1_800_000_000_000;
      const publisherId = "https://hermes.example";
      await backend.run(async (ctx) => {
        for (const userId of ["owner", "viewer"]) {
          await ctx.db.insert("relayUsers", {
            userId,
            appleSubjectHash: `apple-${userId}`,
            createdAt: now,
            updatedAt: now,
          });
        }
        await ctx.db.insert("publisherGrants", {
          userId: "viewer",
          publisherOwnerUserId: "owner",
          publisherId,
          profileId: "owner-profile",
          createdAt: now,
          updatedAt: now,
        });
        if (existingPublisher) {
          await ctx.db.insert("publishers", {
            version: 2,
            ownerUserId: "viewer",
            publisherId,
            label: "Old label",
            enabled: false,
            createdAt: now,
            updatedAt: now,
          });
        }
        for (let index = 0; index < 501; index += 1) {
          await ctx.db.insert("sessionStates", {
            version: 2,
            userId: "viewer",
            profileId: "owner-profile",
            deleted: false,
            publisherId,
            publisherLabel: "Owner",
            sessionId: `session-${index}`,
            eventId: `event-${index}`,
            revision: 1,
            title: "State",
            phase: "running",
            updatedAt: now,
            deepLink: `/sessions/session-${index}`,
            expiresAt: now + 60_000,
            receivedAt: now,
          });
        }
      });
      await backend.mutation(internal.pairing.createPublisherInvitation, {
        publisherId,
        userId: "viewer",
        tokenHash: "viewer-invite",
        expiresAt: now + 60_000,
        now,
      });
      const snapshot = () => backend.run(async (ctx) => ({
        publishers: await ctx.db.query("publishers").collect(),
        keys: await ctx.db.query("publisherKeys").collect(),
        grants: await ctx.db.query("publisherGrants").collect(),
        states: (await ctx.db.query("sessionStates").collect()).length,
        invitations: await ctx.db.query("publisherInvitations").collect(),
      }));
      const before = await snapshot();
      const redemption = {
        tokenHash: "viewer-invite",
        publisherId,
        profileId: "viewer-profile",
        keyId: "viewer-key",
        label: "Viewer",
        publicKey: "viewer-public-key",
        now: now + 1,
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, redemption))
          .resolves.toEqual({ ok: false, reason: "too_many_states" });
        await expect(snapshot()).resolves.toEqual(before);
      }

      await backend.run(async (ctx) => {
        const extra = await ctx.db.query("sessionStates").first();
        await ctx.db.delete(extra!._id);
      });
      await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, redemption))
        .resolves.toMatchObject({ ok: true, profileId: "viewer-profile", profileIdPreserved: false });
      const after = await snapshot();
      expect(after.publishers).toEqual([expect.objectContaining({
        ownerUserId: "viewer",
        label: "Viewer",
        enabled: true,
      })]);
      expect(after.keys).toEqual([expect.objectContaining({ keyId: "viewer-key" })]);
      expect(after.grants).toEqual([expect.objectContaining({
        publisherOwnerUserId: "viewer",
        profileId: "viewer-profile",
      })]);
      expect(after.states).toBe(0);
      expect(after.invitations).toEqual([expect.objectContaining({ consumedAt: now + 1 })]);
    }
  });

  it("requires the registered publisher signature for profile enrollment", async () => {
    const backend = testBackend();
    const now = Date.now();
    const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = bytesToBase64Url(
      new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey)),
    );
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "user-b",
        appleSubjectHash: "apple-b",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: "user-a",
        publisherId: "https://hermes.example",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-a",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey,
        activatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("publisherInvitations", {
        publisherId: "https://hermes.example",
        userId: "user-b",
        tokenHash: await sha256("invite-b"),
        expiresAt: now + 60_000,
        createdAt: now,
      });
    });
    const path = "/v1/pairings/profile/redeem";
    const body = JSON.stringify({
      invitation: "invite-b",
      publisherId: "https://hermes.example",
      profileId: "profile-b",
    });
    const unsigned = await backend.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unsigned.status).toBe(401);

    const signedHeaders = async (method: string, signedPath: string, signedBody: string, nonce: string) => {
      const timestamp = String(Math.floor(now / 1_000));
      const message = [method, signedPath, timestamp, nonce, await sha256(signedBody)].join("\n");
      const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        new TextEncoder().encode(message),
      )));
      return {
        "content-type": "application/json",
        "x-talaria-key-id": "key-1",
        "x-talaria-timestamp": timestamp,
        "x-talaria-nonce": nonce,
        "x-talaria-signature": signature,
      };
    };
    const response = await backend.fetch(path, {
      method: "POST",
      headers: await signedHeaders("POST", path, body, "grant-nonce"),
      body,
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ userId: "user-b", profileId: "profile-b" });

    const snapshotPath = `/v1/publishers/${encodeURIComponent("https://hermes.example")}/profiles/profile-b/snapshot`;
    const snapshotBody = JSON.stringify({
      snapshotId: "snapshot-b",
      states: [{
        sessionId: "session-b",
        eventId: "event-b",
        revision: 1,
        title: "Private B",
        phase: "running",
        startedAt: now,
        updatedAt: now,
        deepLink: "/sessions/session-b",
        alertEligible: false,
      }],
    });
    const snapshot = await backend.fetch(snapshotPath, {
      method: "PUT",
      headers: await signedHeaders("PUT", snapshotPath, snapshotBody, "snapshot-nonce"),
      body: snapshotBody,
    });
    expect(snapshot.status).toBe(200);
    await expect(backend.query(internal.publishers.listCurrentStates, {
      userId: "user-b",
      now,
    })).resolves.toEqual([expect.objectContaining({ sessionId: "session-b", title: "Private B", alertEligible: false })]);
    for (const [value, nonce] of [['"no"', "malformed-nonce"], ["null", "null-nonce"]]) {
      const malformedBody = snapshotBody.replace('"alertEligible":false', `"alertEligible":${value}`);
      const malformed = await backend.fetch(snapshotPath, {
        method: "PUT",
        headers: await signedHeaders("PUT", snapshotPath, malformedBody, nonce!),
        body: malformedBody,
      });
      expect(malformed.status).toBe(400);
    }
    await expect(backend.query(internal.publishers.listCurrentStates, {
      userId: "user-a",
      now,
    })).resolves.toEqual([]);

    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "user-a", appleSubjectHash: "apple-a", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        userId: "user-a", publisherOwnerUserId: "user-a", publisherId: "https://hermes.example",
        profileId: "owner-profile", createdAt: now, updatedAt: now,
      });
    });
    await backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-a",
      publisherId: "https://hermes.example",
      tokenHash: await sha256("owner-replacement"),
      expiresAt: now + 60_000,
      now,
    });
    const replacementPath = "/v1/pairings/publisher/redeem";
    const replacementBody = JSON.stringify({
      invitation: "owner-replacement",
      publisherId: "https://hermes.example",
      profileId: "replacement-profile",
      label: "Home",
      publicKey: Buffer.alloc(32, 1).toString("base64url"),
    });
    const replacement = await backend.fetch(replacementPath, {
      method: "POST",
      headers: await signedHeaders("POST", replacementPath, replacementBody, "replacement-nonce"),
      body: replacementBody,
    });
    expect(replacement.status).toBe(201);
    await expect(replacement.json()).resolves.toMatchObject({
      publisherId: "https://hermes.example", profileId: "owner-profile", profileIdPreserved: true,
    });
  });

  it("renews a non-terminal session's expiry on an equal-revision heartbeat", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey: "public-key",
        activatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        eventId: "event-1",
        revision: 1,
        title: "Needs approval",
        phase: "running",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: now + 60_000,
        receivedAt: now,
      });
    });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "nonce-snapshot",
      nonceExpiresAt: now + 60_000,
      receivedAt: now + 1,
      snapshotId: "snapshot-1",
      states: [{
        sessionId: "session-1",
        eventId: "event-2",
        revision: 2,
        title: "Needs approval",
        phase: "waiting_for_approval",
        startedAt: now, updatedAt: now + 1,
        deepLink: "/sessions/session-1",
      }],
    });
    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "nonce-heartbeat",
      nonceExpiresAt: now + 120_000,
      receivedAt: now + 60_000,
      snapshotId: "snapshot-heartbeat",
      states: [{
        sessionId: "session-1",
        eventId: "event-2",
        revision: 2,
        title: "Needs approval",
        phase: "waiting_for_approval",
        startedAt: now, updatedAt: now + 1,
        deepLink: "/sessions/session-1",
      }],
    });
    const refreshed = await readState(backend, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
    });
    expect(refreshed?.expiresAt).toBe(now + 60_000 + 3 * 60_000);
  });

  it("supports device-only subscriptions and account-wide publisher revocation", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "user-1",
        appleSubjectHash: "apple-user-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("userSessions", {
        userId: "user-1",
        sessionId: "session-1",
        tokenHash: await sha256("session-token"),
        expiresAt: now + 60_000,
        createdAt: now,
      });
      for (const deviceId of ["device-1", "device-2"]) {
        await ctx.db.insert("devices", {
          userId: "user-1",
          sessionId: "session-1",
          sessionExpiresAt: now + 60_000,
          deviceId,
          label: deviceId,
          bundleId: "dev.kil.talaria",
          apsEnvironment: "sandbox",
          preferences: defaultNotificationPreferences,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const publisherId of ["https://hermes.example", "https://other.example"]) {
        await ctx.db.insert("publishers", {
          version: 2,
          ownerUserId: "user-1",
          publisherId,
          label: publisherId,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("publisherGrants", {
          publisherOwnerUserId: "user-1",
          userId: "user-1",
          publisherId,
          profileId: "profile-1",
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey: "public-key",
        activatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        eventId: "event-1",
        revision: 1,
        title: "Working",
        phase: "running",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: now + 60_000,
        receivedAt: now,
      });
    });
    const headers = {
      authorization: "Bearer session-token",
      "content-type": "application/json",
    };
    const subscriptions = (deviceId: string) =>
      backend.fetch(`/v1/devices/${deviceId}/publisher-subscriptions`, { headers });
    const setSubscription = (deviceId: string, subscribed: boolean) =>
      backend.fetch(`/v1/devices/${deviceId}/publisher-subscriptions`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ publisherId: "https://hermes.example", subscribed }),
      });
    const snapshot = (deviceId: string) =>
      backend.fetch("/v1/activity-snapshot?mode=all_running", {
        headers: { ...headers, "x-talaria-device-id": deviceId },
      });

    const unregistered = await setSubscription("device-unregistered", true);
    expect(unregistered.status).toBe(404);
    await expect(unregistered.json()).resolves.toEqual({ error: "device_not_registered" });
    await expect(setSubscription("device-1", false).then((response) => response.status)).resolves.toBe(200);
    await expect(subscriptions("device-1").then((response) => response.json())).resolves.toMatchObject({
      publishers: expect.arrayContaining([
        expect.objectContaining({ publisherId: "https://hermes.example", subscribed: false }),
      ]),
    });
    await expect(subscriptions("device-2").then((response) => response.json())).resolves.toMatchObject({
      publishers: expect.arrayContaining([
        expect.objectContaining({ publisherId: "https://hermes.example", subscribed: true }),
      ]),
    });
    await expect(snapshot("device-1").then((response) => response.json())).resolves.toEqual({ aggregate: null });
    await expect(snapshot("device-2").then((response) => response.json())).resolves.toMatchObject({
      aggregate: { activeCount: 1 },
    });
    await expect(backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-1",
      activityId: "activity-1",
      mode: "per_session",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
      attributesType: "AgentRunActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "activity-token",
      seededLocally: false,
      now,
    })).resolves.toEqual({ ok: false, reason: "publisher_unsubscribed" });

    const revoke = await backend.fetch(
      `/v1/publisher-enrollment?publisherId=${encodeURIComponent("https://hermes.example")}`,
      { method: "DELETE", headers },
    );
    expect(revoke.status).toBe(200);
    const revokedState = await backend.run(async (ctx) => ({
      publisher: await ctx.db.query("publishers").withIndex(
        "by_version_and_owner_user_id_and_publisher_id",
        (query) => query.eq("version", 2).eq("ownerUserId", "user-1")
          .eq("publisherId", "https://hermes.example"),
      ).unique(),
      otherPublisher: await ctx.db.query("publishers").withIndex(
        "by_version_and_owner_user_id_and_publisher_id",
        (query) => query.eq("version", 2).eq("ownerUserId", "user-1")
          .eq("publisherId", "https://other.example"),
      ).unique(),
      grant: await ctx.db.query("publisherGrants").withIndex(
        "by_user_id_and_publisher_id",
        (query) => query.eq("userId", "user-1").eq("publisherId", "https://hermes.example"),
      ).unique(),
      key: await ctx.db.query("publisherKeys").withIndex(
        "by_key_id",
        (query) => query.eq("keyId", "key-1"),
      ).unique(),
      state: await ctx.db.query("sessionStates").withIndex(
        "by_user_id_and_publisher_id_and_session_id",
        (query) => query
          .eq("userId", "user-1")
          .eq("publisherId", "https://hermes.example")
          .eq("sessionId", "session-1"),
      ).unique(),
    }));
    expect(revokedState.publisher?.enabled).toBe(true);
    expect(revokedState.otherPublisher?.enabled).toBe(true);
    expect(revokedState.grant).toBeNull();
    expect(revokedState.key?.revokedAt).toBeUndefined();
    expect(revokedState.state?.deleted).toBe(true);
    await expect(backend.mutation(internal.publishers.acceptState, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "after-revoke",
      nonceExpiresAt: now + 60_000,
      receivedAt: now + 1,
      sessionId: "session-1",
      eventId: "event-2",
      revision: 2,
      state: {
        sessionId: "session-1",
        title: "Still working",
        phase: "running",
        startedAt: now, updatedAt: now + 1,
        deepLink: "/sessions/session-1",
      },
    })).resolves.toEqual({ status: "stale" });

    await backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      tokenHash: "reenroll-invitation",
      expiresAt: now + 60_000,
      now: now + 2,
    });
    await expect(backend.mutation(internal.pairing.redeemProfileInvitation, {
      publisherOwnerUserId: "user-1",
      tokenHash: "reenroll-invitation",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      now: now + 2,
    })).resolves.toMatchObject({ ok: true });
    await expect(backend.mutation(internal.publishers.acceptState, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "after-reenroll",
      nonceExpiresAt: now + 60_000,
      receivedAt: now + 3,
      sessionId: "session-1",
      eventId: "event-1",
      revision: 1,
      state: {
        sessionId: "session-1",
        title: "Working again",
        phase: "running",
        startedAt: now, updatedAt: now + 3,
        deepLink: "/sessions/session-1",
      },
    })).resolves.toEqual({ status: "accepted" });
    await expect(readState(backend, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
    })).resolves.toMatchObject({ deleted: false, title: "Working again" });
  });

  it("keeps the grant when bounded revocation cannot retire every state", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("sessionStates", {
          version: 2,
          userId: "user-1",
          profileId: "profile-1",
          deleted: false,
          publisherId: "https://hermes.example",
          publisherLabel: "Home",
          sessionId: `session-${index}`,
          eventId: `event-${index}`,
          revision: 1,
          title: "State",
          phase: "running",
          updatedAt: now,
          deepLink: `/sessions/session-${index}`,
          expiresAt: now + 60_000,
          receivedAt: now,
        });
      }
    });

    await expect(backend.mutation(internal.subscriptions.revokePublisher, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      now,
    })).resolves.toEqual({ ok: false, reason: "too_many_states" });
    const grant = await backend.run(async (ctx) => ctx.db.query("publisherGrants")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", "user-1").eq("publisherId", "https://hermes.example"),
      ).unique());
    expect(grant).not.toBeNull();
  });

  it("keeps the grant when bounded revocation cannot clear every exclusion", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("devicePublisherExclusions", {
          userId: "user-1",
          publisherId: "https://hermes.example",
          deviceId: `device-${index}`,
          createdAt: now,
        });
      }
    });

    await expect(backend.mutation(internal.subscriptions.revokePublisher, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      now,
    })).resolves.toEqual({ ok: false, reason: "too_many_exclusions" });
    const grant = await backend.run(async (ctx) => ctx.db.query("publisherGrants")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", "user-1").eq("publisherId", "https://hermes.example"),
      ).unique());
    expect(grant).not.toBeNull();
  });

  it("does not renew terminal retention on equal-revision heartbeats", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    const terminalExpiresAt = now + 15 * 60_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey: "public-key",
        activatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        eventId: "event-2",
        revision: 2,
        title: "Finished",
        phase: "completed",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: terminalExpiresAt,
        terminalExpiresAt,
        receivedAt: now,
      });
    });

    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "nonce-heartbeat",
      nonceExpiresAt: now + 120_000,
      receivedAt: now + 60_000,
      snapshotId: "snapshot-heartbeat",
      states: [{
        sessionId: "session-1",
        eventId: "event-2",
        revision: 2,
        title: "Finished",
        phase: "completed",
        startedAt: now, updatedAt: now,
        deepLink: "/sessions/session-1",
      }],
    });
    const refreshed = await readState(backend, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
    });
    expect(refreshed?.expiresAt).toBe(terminalExpiresAt);
    expect(refreshed?.terminalExpiresAt).toBe(terminalExpiresAt);
    expect(refreshed?.receivedAt).toBe(now + 60_000);
  });

  it("does not renew terminal retention on producer heartbeat revisions", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    const terminalExpiresAt = now + 15 * 60_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey: "public-key",
        activatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        streamId: "stream-1",
        eventId: "event-2",
        revision: 2,
        title: "Finished",
        phase: "completed",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: terminalExpiresAt,
        terminalExpiresAt,
        receivedAt: now,
      });
    });

    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "nonce-heartbeat",
      nonceExpiresAt: now + 120_000,
      receivedAt: now + 60_000,
      snapshotId: "snapshot-heartbeat",
      states: [{
        sessionId: "session-1",
        streamId: "stream-1",
        eventId: "event-3",
        revision: 3,
        title: "Finished",
        phase: "completed",
        startedAt: now, updatedAt: now,
        deepLink: "/sessions/session-1",
      }],
    });
    let refreshed = await readState(backend, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
    });
    expect(refreshed?.expiresAt).toBe(terminalExpiresAt);
    expect(refreshed?.terminalExpiresAt).toBe(terminalExpiresAt);

    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "nonce-new-stream",
      nonceExpiresAt: now + 180_000,
      receivedAt: now + 120_000,
      snapshotId: "snapshot-new-stream",
      states: [{
        sessionId: "session-1",
        streamId: "stream-2",
        eventId: "event-4",
        revision: 4,
        title: "Finished again",
        phase: "completed",
        startedAt: now, updatedAt: now + 120_000,
        deepLink: "/sessions/session-1",
      }],
    });
    refreshed = await readState(backend, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
    });
    expect(refreshed?.terminalExpiresAt).toBe(now + 120_000 + 15 * 60_000);

    await backend.mutation(internal.publishers.acceptSnapshot, {
      publisherOwnerUserId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      nonce: "nonce-unknown-stream",
      nonceExpiresAt: now + 240_000,
      receivedAt: now + 180_000,
      snapshotId: "snapshot-unknown-stream",
      states: [{
        sessionId: "session-1",
        eventId: "event-5",
        revision: 5,
        title: "Finished without stream identity",
        phase: "completed",
        startedAt: now, updatedAt: now + 180_000,
        deepLink: "/sessions/session-1",
      }],
    });
    refreshed = await readState(backend, {
      userId: "user-1",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
    });
    expect(refreshed?.terminalExpiresAt).toBe(now + 180_000 + 15 * 60_000);
  });

  it("keeps terminal session state visible until acknowledgement", async () => {
    const backend = testBackend();
    const now = Date.now();
    let stateId: Id<"sessionStates">;
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        preferences: defaultNotificationPreferences,
        createdAt: now,
        updatedAt: now,
      });
      stateId = await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        eventId: "event-2",
        revision: 2,
        title: "Finished",
        phase: "completed",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: now + 15 * 60_000,
        terminalExpiresAt: now + 15 * 60_000,
        receivedAt: now,
      });
      await ctx.db.insert("liveActivities", {
        userId: "user-1",
        deviceId: "device-1",
        activityId: "activity-1",
        mode: "all_running",
        attributesType: "TalariaAggregateActivityAttributes",
        schemaVersion: 1,
        activityPushToken: "activity-token",
        lastAggregate: {
          schemaVersion: 1,
          activeCount: 1,
          title: "Talaria",
          subtitle: "1 active session",
          updatedAt: now - 1,
          rows: [],
        },
        lastDeliveryAt: now - 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const jobs = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").collect());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("live_activity_update");
    const payload = JSON.parse(jobs[0]!.request.payloadJson) as { aps: Record<string, unknown> };
    expect(payload.aps["content-state"]).toMatchObject({
      activeCount: 0,
      subtitle: "Agent work completed",
      rows: [{ sessionId: "session-1", status: "Done" }],
    });
    expect(payload.aps.event).toBe("update");
    expect(payload.aps["dismissal-date"]).toBeUndefined();
    await backend.run(async (ctx) => {
      await ctx.db.patch(stateId, {
        eventId: "event-3",
        revision: 3,
        phase: "failed",
        updatedAt: now + 1,
        receivedAt: now + 1,
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });

    const revisedJobs = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").order("asc").collect(),
    );
    expect(revisedJobs).toHaveLength(2);
    expect(revisedJobs[0]?.stateFingerprint).not.toBe(revisedJobs[1]?.stateFingerprint);
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: revisedJobs[0]!._id,
      now: now + 2,
    })).resolves.toEqual({ status: "stale" });
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: revisedJobs[1]!._id,
      now: now + 2,
    })).resolves.toMatchObject({ status: "ready", kind: "live_activity_update" });
  });

  it("ends every open activity when a device is revoked, including across cleanup batches", async () => {
    const backend = testBackend();
    const now = Date.now();
    const userId = "user-1";
    const deviceId = "device-1";
    const otherDeviceId = "device-2";
    const { deviceRow, activities } = await backend.run(async (ctx) => {
      const insertDevice = (id: string) => ctx.db.insert("devices", {
        userId, deviceId: id, label: "iPhone", pushToken: `push-${id}`,
        pushToStartToken: `start-${id}`, pushToStartIssuedAt: now - 1,
        preferences: defaultNotificationPreferences, createdAt: now - 2, updatedAt: now - 1,
      });
      const deviceRow = await insertDevice(deviceId);
      await insertDevice(otherDeviceId);

      const activities = [];
      for (const [id, mode, count, endedAt] of [
        [deviceId, "all_running", 101, now - 1],
        [deviceId, "all_running", 1, undefined],
        [deviceId, "per_session", 257, undefined],
        [otherDeviceId, "per_session", 1, undefined],
      ] as const) {
        for (let index = 0; index < count; index += 1) {
          const activityId = `${id}-${mode}-${endedAt ?? "open"}-${index}`;
          const rowId = await ctx.db.insert("liveActivities", {
            userId, deviceId: id, activityId, mode, attributesType: "TalariaAggregateActivityAttributes",
            ...(mode === "per_session"
              ? { publisherId: "https://hermes.example", sessionId: "session-1", streamId: activityId }
              : {}),
            schemaVersion: 1, activityPushToken: activityId,
            endedAt, createdAt: now - 2, updatedAt: endedAt ?? now - 2,
          });
          activities.push({ rowId, endedAt: endedAt ?? (id === deviceId ? now : undefined) });
        }
      }
      return { deviceRow, activities };
    });

    const revoke = (at: number) =>
      backend.mutation(internal.devices.revokeDevice, { userId, deviceId, now: at });

    await expect(revoke(now)).resolves.toEqual({ ok: true });
    const revokedDevice = await backend.run((ctx) => ctx.db.get(deviceRow));
    expect(revokedDevice).toMatchObject({ revokedAt: now });
    expect(revokedDevice?.pushToken).toBeUndefined();
    expect(revokedDevice?.pushToStartToken).toBeUndefined();
    const tokenTransfer = await backend.mutation(internal.devices.registerActivity, {
      userId, deviceId: otherDeviceId, activityId: "reused-token", mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1,
      activityPushToken: `${deviceId}-per_session-open-256`, seededLocally: true, now,
    });
    await expect(revoke(now + 1)).resolves.toEqual({ ok: true });
    await backend.finishAllScheduledFunctions(vi.runAllTimers);
    const current = await backend.run((ctx) => Promise.all(activities.map(({ rowId }) => ctx.db.get(rowId))));
    // Compare only the rows still wrong so a failed regression shows the number left open.
    expect(current.filter((row, index) =>
      row === null || row.endedAt !== activities[index]!.endedAt,
    )).toHaveLength(0);
    expect(tokenTransfer).toEqual({ ok: false, reason: "ended" });
  });

  it("finishes revoking old activities before reenrolling a device", async () => {
    const backend = testBackend();
    const now = Date.now();
    const userId = "user-1";
    const deviceId = "device-1";
    const token = "replacement-session-token";
    const tokenHash = await sha256(token);
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId, appleSubjectHash: "apple-user-1", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("userSessions", {
        userId, sessionId: "replacement-session", tokenHash, expiresAt: now + 60_000, createdAt: now,
      });
      await ctx.db.insert("devices", {
        userId, deviceId, sessionId: "original-session", label: "iPhone",
        preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now,
      });
      for (let index = 0; index < 257; index += 1) {
        await ctx.db.insert("liveActivities", {
          userId, deviceId, activityId: `old-${index}`, mode: "per_session",
          publisherId: "https://hermes.example", sessionId: "session-1", streamId: `stream-${index}`,
          attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1,
          activityPushToken: `old-token-${index}`, createdAt: now, updatedAt: now,
        });
      }
    });

    await expect(backend.mutation(internal.devices.revokeDevice, { userId, deviceId, now }))
      .resolves.toEqual({ ok: true });
    // Keep the scheduled drain held while a replacement sign-in reenrolls the device.
    const response = await backend.fetch(`/v1/devices/${deviceId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
        preferences: defaultNotificationPreferences,
      }),
    });
    expect(response.status).toBe(200);
    const activitiesStillOpen = await backend.run(async (ctx) =>
      (await ctx.db.query("liveActivities").collect()).filter((activity) => activity.endedAt !== now).length,
    );
    expect(activitiesStillOpen).toBe(0);

    const newCard = await backend.mutation(internal.devices.registerActivity, {
      userId, deviceId, activityId: "new", mode: "all_running", attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1, activityPushToken: "new-token", seededLocally: true, now,
    });
    expect(newCard).toEqual({ ok: true });
    await backend.finishAllScheduledFunctions(vi.runAllTimers);
    const current = await backend.run((ctx) => ctx.db.query("liveActivities")
      .withIndex("by_user_id_and_device_id_and_activity_id", (q) =>
        q.eq("userId", userId).eq("deviceId", deviceId).eq("activityId", "new"),
      ).unique());
    expect(current).toMatchObject({ activityId: "new" });
    expect(current?.endedAt).toBeUndefined();
  });

  it.each(["sign-out", "expiry"] as const)("%s queries only open activities before revoking session devices", async (trigger) => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("userSessions", {
        userId: "user-1", sessionId: "session-1", tokenHash: "session-token",
        expiresAt: trigger === "expiry" ? now - 1 : now + 60_000,
        createdAt: now - 2_000,
      });
      for (const [userId, deviceId, sessionId] of [
        ["user-1", "device-1", "session-1"],
        ["user-1", "device-2", "session-1"],
        ["user-1", "device-3", "other-session"],
        ["user-2", "device-1", "session-1"],
      ] as const) {
        await ctx.db.insert("devices", {
          userId, deviceId, sessionId, label: "iPhone",
          pushToken: "push-token", pushToStartToken: "start-token",
          pushToStartIssuedAt: now - 2_000,
          preferences: defaultNotificationPreferences,
          createdAt: now - 2_000, updatedAt: now - 2_000,
        });
        for (const mode of ["per_session", "all_running"] as const) {
          // More than 100 open rows per mode catches silent revocation caps.
          for (let index = 0; index < 181; index += 1) {
            const endedAt = index < 80 ? now - 1_000 : undefined;
            await ctx.db.insert("liveActivities", {
              userId, deviceId, mode, activityId: `${mode}-${index}`,
              attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1,
              activityPushToken: `${userId}-${deviceId}-${mode}-${index}`,
              endedAt, createdAt: now - 2_000, updatedAt: endedAt ?? now - 2_000,
            });
          }
        }
      }
    });
    const before = await backend.run(async (ctx) => ({
      devices: await ctx.db.query("devices").collect(),
      activities: await ctx.db.query("liveActivities").collect(),
    }));
    // Observe the real Convex query plan without replacing its database execution.
    const convex = (globalThis as unknown as {
      Convex: { syscall: (op: string, args: string) => string };
    }).Convex;
    const syscall = vi.fn<(op: string, args: string) => string>();
    await backend.run(async () => { syscall.mockImplementation(convex.syscall); });
    const syscallGetter = vi.spyOn(convex as { syscall: unknown }, "syscall", "get")
      .mockReturnValue(syscall);
    try {
      if (trigger === "sign-out") {
        await expect(backend.mutation(internal.auth.revokeSession, {
          tokenHash: "session-token", now,
        })).resolves.toEqual({ ok: true });
      } else {
        await expect(backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({
          deleted: 1, revokedDevices: 2,
        });
      }
    } finally {
      syscallGetter.mockRestore();
    }
    const after = await backend.run(async (ctx) => ({
      devices: await ctx.db.query("devices").collect(),
      activities: await ctx.db.query("liveActivities").collect(),
    }));
    for (const device of before.devices) {
      const current = after.devices.find((row) => row._id === device._id)!;
      const matched = device.userId === "user-1" && device.sessionId === "session-1";
      expect(current).toEqual(matched ? {
        ...device, revokedAt: expect.any(Number), updatedAt: current.revokedAt,
        pushToken: undefined, pushToStartToken: undefined, pushToStartIssuedAt: undefined,
      } : device);
    }
    expect(after.activities).toHaveLength(before.activities.length);
    for (const activity of before.activities) {
      const current = after.activities.find((row) => row._id === activity._id)!;
      const device = after.devices.find((row) =>
        row.userId === activity.userId && row.deviceId === activity.deviceId,
      )!;
      const matched = device.userId === "user-1" && device.sessionId === "session-1";
      expect(current).toEqual(matched && activity.endedAt === undefined
        ? { ...activity, endedAt: device.revokedAt, updatedAt: device.revokedAt }
        : activity);
    }
    const activityQueries = syscall.mock.calls
      .filter(([op]) => op === "1.0/queryStream")
      .map(([, args]) => JSON.parse(args).query)
      .filter((query) => query.source.indexName ===
        "liveActivities.by_user_id_and_device_id_and_mode_and_ended_at");
    expect(activityQueries).toEqual(["device-1", "device-2"].flatMap((deviceId) =>
      ["per_session", "all_running"].map((mode) => ({
        source: {
          type: "IndexRange",
          indexName: "liveActivities.by_user_id_and_device_id_and_mode_and_ended_at",
          range: [
            { type: "Eq", fieldPath: "userId", value: "user-1" },
            { type: "Eq", fieldPath: "deviceId", value: deviceId },
            { type: "Eq", fieldPath: "mode", value: mode },
            { type: "Eq", fieldPath: "endedAt", value: { $undefined: null } },
          ],
          order: null,
        },
        operators: [{ limit: expect.any(Number) }],
      })),
    ));
  });

  it("sums revoked devices across expired sessions including empty sessions", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      for (const [sessionId, deviceCount] of [["empty", 0], ["one", 1], ["two", 2]] as const) {
        await ctx.db.insert("userSessions", {
          userId: "user-1", sessionId, tokenHash: sessionId,
          expiresAt: now - 1, createdAt: now - 100,
        });
        for (let index = 0; index < deviceCount; index += 1) {
          await ctx.db.insert("devices", {
            userId: "user-1", sessionId, deviceId: `${sessionId}-${index}`,
            label: "iPhone", preferences: defaultNotificationPreferences,
            createdAt: now - 100, updatedAt: now - 100,
          });
        }
      }
    });
    await expect(backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({
      deleted: 3, revokedDevices: 3,
    });
    await expect(backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({
      deleted: 0, revokedDevices: 0,
    });
  });

  it("rejects stale publisher revisions and duplicate nonces", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "user-1",
        appleSubjectHash: "apple-user-1",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "publisher-1",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "publisher-1",
        keyId: "key-1",
        publicKey: "public-key",
        createdAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "publisher-1",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
    });
    const state = {
      sessionId: "session-1",
      streamId: "stream-1",
      title: "Relay",
      phase: "running" as const,
      startedAt: now,
      updatedAt: now,
      deepLink: "/sessions/session-1",
    };

    await expect(
      backend.mutation(internal.publishers.acceptState, {
        publisherOwnerUserId: "user-1",
        publisherId: "publisher-1",
        profileId: "profile-1",
        keyId: "key-1",
        nonce: "nonce-1",
        nonceExpiresAt: now + 60_000,
        receivedAt: now,
        sessionId: "session-1",
        eventId: "event-1",
        revision: 1,
        state,
      }),
    ).resolves.toEqual({ status: "accepted" });
    await expect(
      backend.mutation(internal.publishers.acceptState, {
        publisherOwnerUserId: "user-1",
        publisherId: "publisher-1",
        profileId: "profile-1",
        keyId: "key-1",
        nonce: "nonce-2",
        nonceExpiresAt: now + 60_000,
        receivedAt: now + 1,
        sessionId: "session-1",
        eventId: "event-stale",
        revision: 0,
        state,
      }),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      backend.mutation(internal.publishers.acceptState, {
        publisherOwnerUserId: "user-1",
        publisherId: "publisher-1",
        profileId: "profile-1",
        keyId: "key-1",
        nonce: "nonce-2",
        nonceExpiresAt: now + 60_000,
        receivedAt: now + 2,
        sessionId: "session-1",
        eventId: "event-2",
        revision: 2,
        state,
      }),
    ).resolves.toEqual({ status: "replay" });
  });

  it("moves an activity token only between devices owned by the same user", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      for (const deviceId of ["device-1", "device-2"]) {
        await ctx.db.insert("devices", {
          userId: "user-1",
          deviceId,
          label: deviceId,
          preferences: defaultNotificationPreferences,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const registration = {
      mode: "all_running" as const,
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "shared-token",
      seededLocally: false,
      now,
    };

    await backend.mutation(internal.devices.registerActivity, {
      ...registration,
      userId: "user-1",
      deviceId: "device-1",
      activityId: "activity-1",
    });
    await backend.mutation(internal.devices.registerActivity, {
      ...registration,
      userId: "user-1",
      deviceId: "device-2",
      activityId: "activity-2",
      now: now + 1,
    });

    const activities = await backend.run(async (ctx) =>
      ctx.db.query("liveActivities").withIndex("by_activity_push_token", (query) =>
        query.eq("activityPushToken", "shared-token"),
      ).collect(),
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]?.activityId).toBe("activity-2");
  });

  it("displaces only the matching run on a crowded device, including on registration retry", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    const registration = {
      userId: "user-1", deviceId: "device-1", mode: "per_session" as const,
      publisherId: "https://hermes.example", sessionId: "session-1", streamId: "stream-1",
      attributesType: "AgentRunActivityAttributes", schemaVersion: 1, seededLocally: false,
      activityId: "replacement", activityPushToken: "replacement-token", now: now + 1,
    };
    const { userId, deviceId, mode, publisherId, sessionId, streamId, attributesType, schemaVersion } = registration;
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId, deviceId, label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "sandbox",
        preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        userId, publisherId, publisherOwnerUserId: userId, profileId: "profile-1",
        createdAt: now, updatedAt: now,
      });
      const previous = {
        userId, deviceId, mode, publisherId, sessionId, streamId, attributesType, schemaVersion,
        activityId: "superseded", activityPushToken: "superseded-token", createdAt: now, updatedAt: now,
      };
      const otherRuns = [
        { publisherId: "https://other.example" },
        { sessionId: "other-session" },
        ...Array.from({ length: 8 }, (_, index) => ({ streamId: `retained-stream-${index}` })),
      ];
      for (const [index, identity] of otherRuns.entries()) {
        await ctx.db.insert("liveActivities", {
          ...previous, ...identity, activityId: `retained-${index}`, activityPushToken: `retained-token-${index}`,
        });
      }
      await ctx.db.insert("liveActivities", previous);
    });

    const displacement = () => backend.run(async (ctx) => ({
      ended: (await ctx.db.query("liveActivities").collect())
        .filter((activity) => activity.endedAt !== undefined)
        .map(({ activityId, endedAt }) => ({ activityId, endedAt })),
      jobs: (await ctx.db.query("deliveryJobs").collect())
        .map(({ activityId, kind, expectedToken, status }) => ({ activityId, kind, expectedToken, status })),
    }));
    await expect(backend.mutation(internal.devices.registerActivity, registration)).resolves.toEqual({ ok: true });
    const expected = {
      ended: [{ activityId: "superseded", endedAt: registration.now }],
      jobs: [{ activityId: "superseded", kind: "live_activity_end", expectedToken: "superseded-token", status: "queued" }],
    };
    expect(await displacement()).toEqual(expected);

    await expect(backend.mutation(internal.devices.registerActivity, {
      ...registration, now: registration.now + 1,
    })).resolves.toEqual({ ok: true });
    expect(await displacement()).toEqual(expected);
  });

  it("ends a displaced activity after Live Activities are turned off", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "production",
        preferences: defaultNotificationPreferences,
        createdAt: now,
        updatedAt: now,
      });
    });
    const registration = {
      userId: "user-1",
      deviceId: "device-1",
      mode: "all_running" as const,
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      seededLocally: false,
    };
    await backend.mutation(internal.devices.registerActivity, {
      ...registration,
      activityId: "old-activity",
      activityPushToken: "old-token",
      now,
    });
    await backend.mutation(internal.devices.registerActivity, {
      ...registration,
      activityId: "new-activity",
      activityPushToken: "new-token",
      now: now + 1,
    });

    const state = await backend.run(async (ctx) => ({
      oldActivity: await ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "old-activity"),
      ).unique(),
      newActivity: await ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "new-activity"),
      ).unique(),
      displacedEnd: await ctx.db.query("deliveryJobs").withIndex(
        "by_user_id_and_activity_id_and_status",
        (query) => query.eq("userId", "user-1").eq("activityId", "old-activity").eq("status", "queued"),
      ).unique(),
    }));
    expect(state.oldActivity?.endedAt).toBe(now + 1);
    expect(state.newActivity?.endedAt).toBeUndefined();
    expect(state.displacedEnd).toMatchObject({
      kind: "live_activity_end",
      expectedToken: "old-token",
      stateFingerprint: "end:displaced:device-1:old-activity",
    });
    await backend.mutation(internal.devices.upsertDevice, {
      userId: "user-1", sessionId: "login-1", sessionExpiresAt: now + 600_000,
      deviceId: "device-1", label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
      clearPushToken: false, clearPushToStartToken: false,
      preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: false }, now: now + 1,
    });
    const claimed = await backend.mutation(internal.delivery.claimJob, {
      jobId: state.displacedEnd!._id,
      now: now + 2,
    });
    expect(claimed).toMatchObject({ status: "ready", kind: "live_activity_end" });
    if (claimed.status !== "ready") throw new Error("displacement end was not claimable");
    await expect(backend.mutation(internal.devices.registerActivity, {
      ...registration,
      activityId: "old-activity",
      activityPushToken: "old-token",
      now: now + 3,
    })).resolves.toEqual({ ok: false, reason: "ended" });
    await expect(backend.mutation(internal.devices.registerActivity, {
      ...registration,
      activityId: "old-activity",
      activityPushToken: "new-token",
      now: now + 4,
    })).resolves.toEqual({ ok: false, reason: "ended" });
    const replacement = await backend.run(async (ctx) =>
      ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "new-activity"),
      ).unique(),
    );
    expect(replacement?.activityPushToken).toBe("new-token");
    await expect(backend.mutation(internal.devices.registerActivity, {
      ...registration,
      activityId: "third-activity",
      activityPushToken: "old-token",
      now: now + 5,
    })).resolves.toEqual({ ok: false, reason: "ended" });
    const tombstone = await backend.run(async (ctx) =>
      ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "old-activity"),
      ).unique(),
    );
    expect(tombstone?.endedAt).toBe(now + 1);
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-2",
        label: "Other iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "production",
        preferences: defaultNotificationPreferences,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("liveActivities", {
        userId: "user-1",
        deviceId: "device-2",
        activityId: "old-activity",
        mode: "all_running",
        attributesType: "TalariaAggregateActivityAttributes",
        schemaVersion: 1,
        activityPushToken: "other-old-token",
        createdAt: now,
        updatedAt: now,
      });
    });
    await backend.mutation(internal.devices.registerActivity, {
      ...registration,
      deviceId: "device-2",
      activityId: "other-new-activity",
      activityPushToken: "other-new-token",
      now: now + 6,
    });
    const displacementJobs = await backend.run(async (ctx) => {
      const queued = await ctx.db.query("deliveryJobs").withIndex(
        "by_user_id_and_activity_id_and_status",
        (query) => query.eq("userId", "user-1").eq("activityId", "old-activity").eq("status", "queued"),
      ).collect();
      const running = await ctx.db.query("deliveryJobs").withIndex(
        "by_user_id_and_activity_id_and_status",
        (query) => query.eq("userId", "user-1").eq("activityId", "old-activity").eq("status", "running"),
      ).collect();
      return [...queued, ...running];
    });
    expect(new Set(displacementJobs.map((job) => job.stateFingerprint))).toEqual(new Set([
      "end:displaced:device-1:old-activity",
      "end:displaced:device-2:old-activity",
    ]));
    const payload = JSON.parse(claimed.request.payloadJson);
    expect(payload.aps).toMatchObject({
      event: "end",
      timestamp: Math.floor((now + 1) / 1_000),
      "dismissal-date": Math.floor((now + 1) / 1_000),
    });
  });

  it("keeps publisher, device, snapshot, and activity state tenant isolated", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2,
        ownerUserId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey: "public-key",
        createdAt: now,
      });
      for (const userId of ["user-1", "user-2"]) {
        await ctx.db.insert("relayUsers", {
          userId,
          appleSubjectHash: `apple-${userId}`,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("publisherGrants", {
          publisherOwnerUserId: "user-1",
          userId,
          publisherId: "https://hermes.example",
          profileId: `profile-${userId}`,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("devices", {
          userId,
          deviceId: `device-${userId}`,
          label: userId,
          preferences: defaultNotificationPreferences,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const state = {
      sessionId: "same-session",
      title: "Private",
      phase: "running" as const,
      startedAt: now,
      updatedAt: now,
      deepLink: "/sessions/same-session",
    };
    for (const userId of ["user-1", "user-2"]) {
      await backend.mutation(internal.publishers.acceptState, {
        publisherOwnerUserId: "user-1",
        publisherId: "https://hermes.example",
        profileId: `profile-${userId}`,
        keyId: "key-1",
        nonce: `nonce-${userId}`,
        nonceExpiresAt: now + 60_000,
        receivedAt: now,
        sessionId: state.sessionId,
        eventId: `event-${userId}`,
        revision: 1,
        state,
      });
    }
    const first = await backend.query(internal.publishers.listCurrentStates, {
      userId: "user-1",
      now,
    });
    const second = await backend.query(internal.publishers.listCurrentStates, {
      userId: "user-2",
      now,
    });
    expect(first.map((item) => item.eventId)).toEqual(["event-user-1"]);
    expect(second.map((item) => item.eventId)).toEqual(["event-user-2"]);

    const registered = await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-user-1",
      activityId: "activity-1",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "tenant-token",
      seededLocally: false,
      now,
    });
    const stolen = await backend.mutation(internal.devices.registerActivity, {
      userId: "user-2",
      deviceId: "device-user-2",
      activityId: "activity-2",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "tenant-token",
      seededLocally: false,
      now: now + 1,
    });
    expect(registered).toEqual({ ok: true });
    expect(stolen).toEqual({ ok: false, reason: "token_owned" });
  });

  it("isolates delivery lifecycles and does not deliver or reopen revoked activities", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      for (const userId of ["user-1", "user-2"]) {
        await ctx.db.insert("devices", {
          userId,
          deviceId: `device-${userId}`,
          label: userId,
          bundleId: "dev.kil.talaria",
          apsEnvironment: "production",
          pushToken: `push-${userId}`,
          preferences: { ...defaultNotificationPreferences, notificationsEnabled: false },
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("sessionStates", {
          version: 2,
          userId,
          profileId: `profile-${userId}`,
          deleted: false,
          publisherId: "https://hermes.example",
          publisherLabel: userId,
          sessionId: "session-1",
          eventId: `event-${userId}-1`,
          revision: 1,
          title: userId,
          phase: "running",
          updatedAt: now,
          deepLink: "/sessions/session-1",
          expiresAt: now + 60_000,
          receivedAt: now,
        });
        await ctx.db.insert("liveActivities", {
          userId,
          deviceId: `device-${userId}`,
          activityId: `activity-${userId}`,
          mode: "all_running",
          attributesType: "TalariaAggregateActivityAttributes",
          schemaVersion: 1,
          activityPushToken: `activity-token-${userId}`,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    for (const userId of ["user-1", "user-2"]) {
      await backend.mutation(internal.delivery.recompute, { userId });
    }
    const initialJobs = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").collect(),
    );
    expect(initialJobs).toHaveLength(2);
    for (const job of initialJobs) {
      const claimed = await backend.mutation(internal.delivery.claimJob, {
        jobId: job._id,
        now: now + 1,
      });
      expect(claimed).toMatchObject({
        status: "ready",
        request: { token: `activity-token-${job.userId}` },
      });
      await backend.mutation(internal.delivery.markDelivered, {
        jobId: job._id,
        apnsStatus: 200,
        now: now + 2,
      });
    }
    const deliveredActivities = await backend.run(async (ctx) =>
      ctx.db.query("liveActivities").collect(),
    );
    for (const activity of deliveredActivities) {
      expect(activity.lastAggregate?.rows.map((row) => row.publisherLabel)).toEqual([
        activity.userId,
      ]);
    }

    await backend.run(async (ctx) => {
      const state = await ctx.db
        .query("sessionStates")
        .withIndex("by_user_id_and_publisher_id_and_session_id", (query) =>
          query
            .eq("userId", "user-1")
            .eq("publisherId", "https://hermes.example")
            .eq("sessionId", "session-1"),
        )
        .unique();
      await ctx.db.patch(state!._id, { title: "routine update", revision: 2 });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const scheduledRetry = await backend.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduledRetry.some(
      (job) => job.name === "delivery:recompute" && job.scheduledTime > Date.now(),
    )).toBe(true);

    await backend.run(async (ctx) => {
      const states = await ctx.db.query("sessionStates").collect();
      for (const state of states) {
        await ctx.db.patch(state._id, {
          eventId: `event-${state.userId}-2`,
          revision: 2,
          title: `${state.userId}-updated`,
          phase: "waiting_for_input",
          updatedAt: now + 3,
        });
      }
    });
    for (const userId of ["user-1", "user-2"]) {
      await backend.mutation(internal.delivery.recompute, { userId });
    }
    const queuedJobs = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "queued"),
      ).collect(),
    );
    expect(queuedJobs).toHaveLength(2);
    const inFlight = queuedJobs.find((job) => job.userId === "user-1")!;
    await expect(
      backend.mutation(internal.delivery.claimJob, {
        jobId: inFlight._id,
        now: now + 4,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await backend.mutation(internal.devices.endActivity, {
      userId: "user-1",
      deviceId: "device-user-1",
      activityId: "activity-user-1",
      now: now + 5,
    });
    await backend.mutation(internal.delivery.markDelivered, {
      jobId: inFlight._id,
      apnsStatus: 200,
      now: now + 6,
    });
    const ended = await backend.run(async (ctx) =>
      ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query
            .eq("userId", "user-1")
            .eq("deviceId", "device-user-1")
            .eq("activityId", "activity-user-1"),
        )
        .unique(),
    );
    expect(ended?.endedAt).toBe(now + 5);

    const revokedJob = queuedJobs.find((job) => job.userId === "user-2")!;
    await backend.mutation(internal.devices.revokeDevice, {
      userId: "user-2",
      deviceId: "device-user-2",
      now: now + 5,
    });
    await expect(
      backend.mutation(internal.delivery.claimJob, {
        jobId: revokedJob._id,
        now: now + 6,
      }),
    ).resolves.toEqual({ status: "stale" });
  });

  describe("push-to-start on an idle device", () => {
    // A phone with a push-to-start token and Live Activities on, and one running session.
    async function idleDeviceWithWork() {
      const backend = testBackend();
      const now = Date.now();
      const deviceId = await backend.run(async (ctx) => {
        const id = await ctx.db.insert("devices", {
          userId: "user-1", deviceId: "device-1", label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
          pushToStartToken: "push-to-start-token",
          preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: true }, createdAt: now, updatedAt: now,
        });
        await ctx.db.insert("sessionStates", session("session-1", now));
        return id;
      });
      const device = () => backend.run(async (ctx) => (await ctx.db.get(deviceId))!);
      const queued = () => backend.run(async (ctx) => ctx.db.query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued")).collect());
      const recompute = () => backend.mutation(internal.delivery.recompute, { userId: "user-1" });
      const claim = (jobId: Id<"deliveryJobs">, at: number) => backend.mutation(internal.delivery.claimJob, { jobId, now: at });
      const endWork = () => backend.run(async (ctx) => {
        for (const state of await ctx.db.query("sessionStates").collect()) await ctx.db.delete(state._id);
      });
      // Push-to-start queued, claimed and delivered by APNs.
      const deliveredStart = async () => {
        await recompute();
        const [start] = await queued();
        await claim(start!._id, now + 1);
        await backend.mutation(internal.delivery.markDelivered, { jobId: start!._id, apnsStatus: 200, now: now + 2 });
      };
      return { backend, now, deviceId, device, queued, recompute, claim, endWork, deliveredStart };
    }
    const session = (sessionId: string, at: number) => ({
      version: 2 as const, userId: "user-1", profileId: "profile-1", deleted: false, publisherId: "https://hermes.example",
      publisherLabel: "Home", sessionId, eventId: `event-${sessionId}`, revision: 1, title: "Build relay", phase: "running" as const,
      updatedAt: at, deepLink: `/sessions/${sessionId}`, expiresAt: at + 60_000, receivedAt: at,
    });

    it("queues one push-to-start when work begins, however often it recomputes", async () => {
      const { device, recompute, backend } = await idleDeviceWithWork();
      await recompute();
      await recompute();
      const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
      expect(jobs.map((job) => job.kind)).toEqual(["live_activity_start"]);
      expect((await device()).pushToStartIssuedAt).toBeDefined();
    });

    it("queues a new push-to-start for a rotated token and makes the old one stale", async () => {
      const { backend, now, deviceId, device, queued, recompute, claim } = await idleDeviceWithWork();
      await recompute();
      const [original] = await queued();
      await backend.run((ctx) => ctx.db.patch(deviceId, { pushToStartToken: "rotated-push-to-start-token", pushToStartIssuedAt: undefined }));
      await recompute();
      const jobs = await queued();
      expect(jobs).toHaveLength(2);
      expect(jobs.some((job) => job.expectedToken === "rotated-push-to-start-token")).toBe(true);
      await expect(claim(original!._id, now + 1)).resolves.toEqual({ status: "stale" });
      expect((await device()).pushToStartIssuedAt).toBeDefined();
    });

    it("makes a queued push-to-start stale when the work changes, releases its lease and recomputes", async () => {
      const { backend, now, device, queued, recompute, claim } = await idleDeviceWithWork();
      await recompute();
      const [start] = await queued();
      await backend.run(async (ctx) => {
        const [state] = await ctx.db.query("sessionStates").collect();
        await ctx.db.patch(state!._id, { title: "Updated work", updatedAt: now + 1 });
      });
      await recompute();
      await expect(claim(start!._id, now + 2)).resolves.toEqual({ status: "stale" });
      expect((await device()).pushToStartIssuedAt).toBeUndefined();
      const scheduled = await backend.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled.some((job) => job.name === "delivery:recompute")).toBe(true);
    });

    it("makes a push-to-start stale and releases its lease once the device's session has expired", async () => {
      const { backend, now, deviceId, device, queued, recompute, claim } = await idleDeviceWithWork();
      await recompute();
      const [start] = await queued();
      await backend.run((ctx) => ctx.db.patch(deviceId, { sessionExpiresAt: now + 3 }));
      await expect(claim(start!._id, now + 4)).resolves.toEqual({ status: "stale" });
      expect((await device()).pushToStartIssuedAt).toBeUndefined();
    });

    it("claims a current push-to-start with the device's token", async () => {
      const { now, queued, recompute, claim } = await idleDeviceWithWork();
      await recompute();
      const [start] = await queued();
      await expect(claim(start!._id, now + 1)).resolves.toMatchObject({
        status: "ready", kind: "live_activity_start", request: { token: "push-to-start-token", pushType: "liveactivity" },
      });
    });

    it("starts no second activity while a delivered start is outstanding across a gap in work", async () => {
      const { backend, now, device, recompute, endWork, deliveredStart } = await idleDeviceWithWork();
      await deliveredStart();
      const startsBeforeGap = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
      await endWork();
      await recompute();
      expect((await device()).pushToStartIssuedAt).toBeDefined();
      await backend.run((ctx) => ctx.db.insert("sessionStates", session("session-2", now + 7)));
      await recompute();
      expect(await backend.run((ctx) => ctx.db.query("deliveryJobs").collect())).toHaveLength(startsBeforeGap.length);
    });

    const registration = (now: number) => ({
      userId: "user-1", deviceId: "device-1", activityId: "activity-from-apns", mode: "all_running" as const,
      attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1, activityPushToken: "activity-token",
      seededLocally: false, now: now + 8,
    });

    it("releases the push-to-start lease when the started activity registers", async () => {
      const { backend, now, device, deliveredStart } = await idleDeviceWithWork();
      await deliveredStart();
      await backend.mutation(internal.devices.registerActivity, registration(now));
      expect((await device()).pushToStartIssuedAt).toBeUndefined();
    });

    it("ends the registered activity once its work ends", async () => {
      const { backend, now, queued, recompute, endWork, deliveredStart } = await idleDeviceWithWork();
      await deliveredStart();
      await backend.mutation(internal.devices.registerActivity, registration(now));
      await endWork();
      await recompute();
      expect((await queued())[0]).toMatchObject({ kind: "live_activity_end", activityId: "activity-from-apns" });
    });
  });

  it("keeps an exact locally seeded re-registration from repainting delivered state", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: true },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        streamId: "stream-1",
        eventId: "event-1",
        revision: 1,
        title: "Old publisher state",
        phase: "running",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: now + 60_000,
        receivedAt: now,
      });
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-2",
        streamId: "stream-2",
        eventId: "event-session-2",
        revision: 1,
        title: "Other publisher state",
        phase: "running",
        updatedAt: now - 1,
        deepLink: "/sessions/session-2",
        expiresAt: now + 60_000,
        receivedAt: now,
      });
      await ctx.db.insert("liveActivities", {
        userId: "user-1",
        deviceId: "device-1",
        activityId: "activity-1",
        mode: "all_running",
        attributesType: "TalariaAggregateActivityAttributes",
        schemaVersion: 1,
        activityPushToken: "activity-token",
        createdAt: now,
        updatedAt: now,
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const initialJob = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "queued"),
      ).unique(),
    );
    expect(initialJob).not.toBeNull();
    await backend.mutation(internal.delivery.claimJob, { jobId: initialJob!._id, now: now + 1 });
    await backend.mutation(internal.delivery.markDelivered, {
      jobId: initialJob!._id,
      apnsStatus: 200,
      now: now + 2,
    });
    const delivered = await backend.run(async (ctx) =>
      ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "activity-1"),
      ).unique(),
    );

    const legacyAggregate = await backend.run(async (ctx) => {
      const activity = await ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "activity-1"),
      ).unique();
      const lastAggregate = activity!.lastAggregate && {
        ...activity!.lastAggregate,
        rows: activity!.lastAggregate.rows.map(({ streamId: _streamId, ...row }) => row),
      };
      await ctx.db.patch(activity!._id, { lastAggregate });
      return lastAggregate;
    });

    await backend.run(async (ctx) => {
      const session = await ctx.db.query("sessionStates").withIndex(
        "by_user_id_and_publisher_id_and_session_id",
        (query) => query
          .eq("userId", "user-1")
          .eq("publisherId", "https://hermes.example")
          .eq("sessionId", "session-1"),
      ).unique();
      await ctx.db.patch(session!._id, {
        eventId: "event-2",
        revision: 2,
        updatedAt: now + 3,
        receivedAt: now + 3,
      });
      const otherSession = await ctx.db.query("sessionStates").withIndex(
        "by_user_id_and_publisher_id_and_session_id",
        (query) => query
          .eq("userId", "user-1")
          .eq("publisherId", "https://hermes.example")
          .eq("sessionId", "session-2"),
      ).unique();
      await ctx.db.patch(otherSession!._id, {
        eventId: "event-session-2-heartbeat",
        revision: 2,
        updatedAt: now + 4,
        receivedAt: now + 4,
      });
    });

    await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-1",
      activityId: "activity-1",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "activity-token",
      seededLocally: true,
      now: now + 4,
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const state = await backend.run(async (ctx) => ({
      activity: await ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "activity-1"),
      ).unique(),
      queuedJobs: await ctx.db.query("deliveryJobs").withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "queued"),
      ).collect(),
    }));
    expect(state.activity?.lastAggregate).toEqual(legacyAggregate);
    expect(state.activity?.lastDeliveryAt).toBe(delivered?.lastDeliveryAt);
    expect(state.activity?.emptyStateLeaseUntil).toBe(now + 30_004);
    expect(state.queuedJobs).toEqual([]);

    await backend.run(async (ctx) => {
      const activity = await ctx.db.query("liveActivities").withIndex(
        "by_user_id_and_device_id_and_activity_id",
        (query) => query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "activity-1"),
      ).unique();
      await ctx.db.patch(activity!._id, { lastAggregate: delivered!.lastAggregate });
    });

    await backend.run(async (ctx) => {
      const session = await ctx.db.query("sessionStates").withIndex(
        "by_user_id_and_publisher_id_and_session_id",
        (query) => query
          .eq("userId", "user-1")
          .eq("publisherId", "https://hermes.example")
          .eq("sessionId", "session-1"),
      ).unique();
      await ctx.db.patch(session!._id, {
        eventId: "event-3",
        revision: 3,
        streamId: "stream-new",
        updatedAt: now + 5,
        receivedAt: now + 5,
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const freshJobs = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").withIndex("by_status_and_updated_at", (query) =>
        query.eq("status", "queued"),
      ).collect(),
    );
    expect(freshJobs).toHaveLength(1);
    expect(freshJobs[0]?.kind).toBe("live_activity_update");
    expect(freshJobs[0]?.aggregate?.rows[0]).toMatchObject({
      streamId: "stream-new",
      title: "Old publisher state",
    });
  });

  it("does not re-alert a transition when a throttled activity recompute reruns", async () => {
    const backend = testBackend();
    const now = Date.now();
    const sessionState = (sessionId: string, eventId: string, title: string, phase: "running" | "completed") => ({
      version: 2 as const,
      userId: "user-1",
      profileId: "profile-1",
      deleted: false,
      publisherId: "https://hermes.example",
      publisherLabel: "Home",
      sessionId,
      eventId,
      revision: 2,
      title,
      phase,
      updatedAt: now,
      deepLink: `/sessions/${sessionId}`,
      expiresAt: now + 15 * 60_000,
      terminalExpiresAt: phase === "completed" ? now + 15 * 60_000 : undefined,
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
      await ctx.db.insert("sessionStates", sessionState("session-x", "event-x-2", "Heartbeat title", "running"));
      await ctx.db.insert("sessionStates", sessionState("session-y", "event-y-2", "Finished", "completed"));
      // Session X's activity was delivered 5 s ago, so X's heartbeat is throttled and reschedules a recompute.
      await ctx.db.insert("liveActivities", {
        userId: "user-1",
        deviceId: "device-1",
        activityId: "activity-x",
        mode: "per_session",
        publisherId: "https://hermes.example",
        sessionId: "session-x",
        attributesType: "TalariaAggregateActivityAttributes",
        schemaVersion: 1,
        activityPushToken: "activity-token",
        lastAggregate: {
          schemaVersion: 1,
          activeCount: 1,
          title: "Talaria",
          subtitle: "Earlier title",
          updatedAt: now - 5_000,
          rows: [],
        },
        lastDeliveryAt: now - 5_000,
        createdAt: now,
        updatedAt: now,
      });
    });

    await backend.mutation(internal.delivery.recompute, {
      userId: "user-1",
      transitions: [{ publisherId: "https://hermes.example", sessionId: "session-y", previousPhase: "running" }],
    });
    const notifications = async () => backend.run(async (ctx) =>
      (await ctx.db.query("deliveryJobs").collect()).filter((job) => job.kind === "notification"),
    );
    const first = await notifications();
    expect(first).toHaveLength(1);
    expect(first[0]?.stateFingerprint).toBe("notification:event-y-2:device-1");
    await backend.run(async (ctx) => ctx.db.patch(first[0]!._id, { status: "done", updatedAt: now }));

    const rerun = await backend.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((job) => job.name === "delivery:recompute" && job.state.kind === "pending"),
    );
    expect(rerun).toHaveLength(1);
    await backend.mutation(internal.delivery.recompute, rerun[0]!.args[0]);

    expect(await notifications()).toHaveLength(1);
  });

  describe("attention alerts during a Live Activity", () => {
    type Phase = "waiting_for_approval" | "waiting_for_input" | "completed" | "failed";
    async function deliverTransition(
      phase: Phase,
      options: { activity: boolean; preferences?: Partial<typeof defaultNotificationPreferences> },
    ) {
      const backend = testBackend();
      const now = Date.now();
      await backend.run(async (ctx) => {
        await ctx.db.insert("devices", {
          userId: "user-1",
          deviceId: "device-1",
          label: "iPhone",
          bundleId: "dev.kil.talaria",
          apsEnvironment: "sandbox",
          pushToken: "push-token",
          pushToStartToken: options.activity ? undefined : "start-token",
          preferences: { ...defaultNotificationPreferences, notificationsEnabled: true, ...options.preferences },
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("sessionStates", {
          version: 2,
          userId: "user-1",
          profileId: "profile-1",
          deleted: false,
          publisherId: "https://hermes.example",
          publisherLabel: "Home",
          sessionId: "session-1",
          eventId: "event-2",
          revision: 2,
          title: "Build relay",
          phase,
          updatedAt: now,
          deepLink: "/sessions/session-1",
          expiresAt: now + 15 * 60_000,
          terminalExpiresAt: phase === "completed" || phase === "failed" ? now + 15 * 60_000 : undefined,
          receivedAt: now,
        });
        if (options.activity) {
          await ctx.db.insert("liveActivities", {
            userId: "user-1",
            deviceId: "device-1",
            activityId: "activity-1",
            mode: "all_running",
            attributesType: "TalariaAggregateActivityAttributes",
            schemaVersion: 1,
            activityPushToken: "activity-token",
            createdAt: now,
            updatedAt: now,
          });
        }
      });
      await backend.mutation(internal.delivery.recompute, {
        userId: "user-1",
        transitions: [{ publisherId: "https://hermes.example", sessionId: "session-1", previousPhase: "running" }],
      });
      const jobs = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").collect());
      return jobs.map((job) => ({
        kind: job.kind,
        aps: (JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> }).aps,
      }));
    }

    it.each([
      ["waiting_for_approval", { "title-loc-key": "Approval required", "loc-key": "An agent run is waiting for your approval." }],
    ] as const)("sends a silent activity update and a Time Sensitive notification for %s", async (phase, alert) => {
      const jobs = await deliverTransition(phase, { activity: true });

      const activityJobs = jobs.filter((job) => job.kind.startsWith("live_activity_"));
      expect(activityJobs).toHaveLength(1);
      expect(activityJobs[0]!.aps).not.toHaveProperty("alert");
      const notifications = jobs.filter((job) => job.kind === "notification");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.aps).toMatchObject({
        alert,
        sound: "default",
        "interruption-level": "time-sensitive",
      });
    });

    it("starts an approval activity with a silent alert alongside the Time Sensitive notification", async () => {
      const jobs = await deliverTransition("waiting_for_approval", { activity: false });

      const starts = jobs.filter((job) => job.kind === "live_activity_start");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.aps.alert).toEqual(localizedApprovalAlert);
      const notifications = jobs.filter((job) => job.kind === "notification");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.aps["interruption-level"]).toBe("time-sensitive");
    });

    it.each([
      ["failed", "Failed on Home"],
    ] as const)("keeps the %s alert on the activity without a standalone duplicate", async (phase, body) => {
      const jobs = await deliverTransition(phase, { activity: true });

      const activityJobs = jobs.filter((job) => job.kind.startsWith("live_activity_"));
      expect(activityJobs).toHaveLength(1);
      expect(activityJobs[0]!.aps.alert).toEqual({ title: "Build relay", body, sound: "default" });
      expect(activityJobs[0]!.aps).not.toHaveProperty("interruption-level");
      expect(jobs.filter((job) => job.kind === "notification")).toHaveLength(0);
    });

    it("keeps the approval alert on the activity when the device cannot receive notifications", async () => {
      const jobs = await deliverTransition("waiting_for_approval", {
        activity: true,
        preferences: { notificationsEnabled: false },
      });

      expect(jobs.map((job) => job.kind)).toEqual(["live_activity_update"]);
      expect(jobs[0]!.aps.alert).toEqual({ ...localizedApprovalAlert, sound: "default" });
    });

    it("sends no approval alert when approval notifications are off", async () => {
      const jobs = await deliverTransition("waiting_for_approval", {
        activity: true,
        preferences: { notifyOnApproval: false },
      });

      expect(jobs.filter((job) => job.kind === "notification")).toHaveLength(0);
      for (const job of jobs) expect(job.aps).not.toHaveProperty("alert");
    });
  });

  // TAL-192: the App restarts a retained current-session card for the session's next run by
  // re-registering the same activity and token with the new stream.
  it("rebinds a current-session activity to the next run of its session", async () => {
    const backend = testBackend();
    const now = Date.now();
    const sessionState = (streamId: string, phase: "completed" | "running", revision: number) => ({
      version: 2 as const,
      userId: "user-1",
      profileId: "profile-1",
      deleted: false,
      publisherId: "https://hermes.example",
      publisherLabel: "Home",
      sessionId: "session-1",
      streamId,
      eventId: `event-${revision}`,
      revision,
      title: "Fixture session",
      phase,
      // Each run started a minute before its first update.
      startedAt: now - 60_000 + revision,
      updatedAt: now + revision,
      deepLink: "/sessions/session-1",
      expiresAt: now + 15 * 60_000,
      terminalExpiresAt: phase === "completed" ? now + 15 * 60_000 : undefined,
      receivedAt: now + revision,
    });
    let stateId!: Id<"sessionStates">;
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: true },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        publisherOwnerUserId: "user-1",
        userId: "user-1",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        createdAt: now,
        updatedAt: now,
      });
      stateId = await ctx.db.insert("sessionStates", sessionState("stream-1", "completed", 1));
    });
    const register = (streamId: string, at: number) => backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-1",
      activityId: "activity-1",
      mode: "per_session",
      publisherId: "https://hermes.example",
      sessionId: "session-1",
      streamId,
      attributesType: "AgentRunActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "activity-token",
      seededLocally: false,
      now: at,
    });
    const queuedJobs = () => backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued")).collect(),
    );

    await expect(register("stream-1", now + 2)).resolves.toEqual({ ok: true });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    // The next run starts before the App rebinds the card, so run 1's registration gets an end.
    await backend.run(async (ctx) => ctx.db.replace(stateId, sessionState("stream-2", "running", 3)));
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const firstRunJobs = await queuedJobs();
    expect(firstRunJobs.map((job) => job.kind).sort()).toEqual(["live_activity_end", "live_activity_update"]);

    await expect(register("stream-2", now + 4)).resolves.toEqual({ ok: true });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const activities = await backend.run(async (ctx) => ctx.db.query("liveActivities").collect());
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ activityId: "activity-1", streamId: "stream-2" });
    expect(activities[0]?.endedAt).toBeUndefined();

    for (const job of firstRunJobs) {
      await expect(backend.mutation(internal.delivery.claimJob, { jobId: job._id, now: now + 5 }))
        .resolves.toEqual({ status: "stale" });
    }
    const secondRunJobs = (await queuedJobs()).filter((job) => !firstRunJobs.some((first) => first._id === job._id));
    expect(secondRunJobs).toHaveLength(1);
    expect(secondRunJobs[0]?.aggregate?.rows[0]).toMatchObject({ streamId: "stream-2", phase: "running" });
    // The card's timer counts from run 2's start, not run 1's or either registration.
    const contentState = JSON.parse(secondRunJobs[0]!.request.payloadJson).aps["content-state"];
    expect(contentState).toMatchObject({ status: "thinking", isFinal: false, startedAt: (now - 60_000 + 3) / 1_000 - 978_307_200 });
    await expect(backend.mutation(internal.delivery.claimJob, { jobId: secondRunJobs[0]!._id, now: now + 6 }))
      .resolves.toMatchObject({ status: "ready", kind: "live_activity_update" });
  });

  it("leases a locally seeded activity for publisher reconciliation", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: true },
        createdAt: now,
        updatedAt: now,
      });
    });
    await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-1",
      activityId: "seeded-activity",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "seeded-token",
      seededLocally: true,
      now,
    });

    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    let state = await backend.run(async (ctx) => ({
      activity: await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "seeded-activity"),
        )
        .unique(),
      jobs: await ctx.db.query("deliveryJobs").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.activity?.emptyStateLeaseUntil).toBe(now + 30_000);
    expect(state.jobs).toHaveLength(0);
    expect(state.scheduled.some((job) => job.name === "delivery:recompute")).toBe(true);

    await backend.run(async (ctx) => {
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-1",
        eventId: "event-1",
        revision: 1,
        title: "Local work",
        phase: "starting",
        updatedAt: now + 1,
        deepLink: "/sessions/session-1",
        expiresAt: now + 60_000,
        receivedAt: now + 1,
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    state = await backend.run(async (ctx) => ({
      activity: await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "seeded-activity"),
        )
        .unique(),
      jobs: await ctx.db.query("deliveryJobs").collect(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "live_activity_update",
      activityId: "seeded-activity",
    });
  });

  it("stores APNs tokens as lower-case hex and refuses every other spelling", async () => {
    const backend = testBackend();
    const now = Date.now();
    const token = (digit: string) => `${digit}0`.repeat(32);
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", { userId: "user-1", appleSubjectHash: "apple-user-1", createdAt: now, updatedAt: now });
      await ctx.db.insert("userSessions", {
        userId: "user-1", sessionId: "session-1", tokenHash: await sha256("session-token"), expiresAt: now + 60_000, createdAt: now,
      });
      await ctx.db.insert("devices", {
        userId: "other-user", deviceId: "foreign-device", label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "sandbox",
        pushToken: token("f"), preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now,
      });
    });
    const headers = { authorization: "Bearer session-token", "content-type": "application/json" };
    const device = { label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "sandbox", preferences: defaultNotificationPreferences };
    const putDevice = (tokens: object) => backend.fetch("/v1/devices/device-1", {
      method: "PUT", headers, body: JSON.stringify({ ...device, ...tokens }),
    });
    const putActivity = (activityPushToken: string) => backend.fetch("/v1/devices/device-1/live-activities/activity-1", {
      method: "PUT", headers, body: JSON.stringify({
        mode: "all_running", attributesType: "TalariaAggregateActivityAttributes", schemaVersion: 1, activityPushToken,
      }),
    });

    expect((await putDevice({ pushToken: token("A"), pushToStartToken: token("B") })).status).toBe(200);
    const stored = await backend.run((ctx) => ctx.db.query("devices").withIndex("by_user_id_and_device_id", (query) =>
      query.eq("userId", "user-1").eq("deviceId", "device-1")).unique());
    expect([stored?.pushToken, stored?.pushToStartToken]).toEqual([token("a"), token("b")]);

    const malformed = [`${token("a")}/x`, `${token("a")}?`, ` ${token("a")}`, `${token("a")}\n`, token("g"), "a".repeat(63), "a".repeat(201)];
    for (const value of malformed) {
      for (const field of ["pushToken", "pushToStartToken"]) {
        const response = await putDevice({ [field]: value });
        expect(response.status, JSON.stringify({ field, value })).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "invalid_device" });
      }
      const activity = await putActivity(value);
      expect(activity.status, JSON.stringify({ field: "activityPushToken", value })).toBe(400);
      await expect(activity.json()).resolves.toEqual({ error: "invalid_device" });
    }

    // Another user's token in upper case is that user's token, so the ownership check refuses it.
    expect((await putDevice({ pushToken: token("F") })).status).toBe(401);
    const foreign = await backend.run((ctx) => ctx.db.query("devices").withIndex("by_push_token", (query) =>
      query.eq("pushToken", token("f"))).collect());
    expect(foreign.map((row) => row.userId)).toEqual(["other-user"]);
  });
});
