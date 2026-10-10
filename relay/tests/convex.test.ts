import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

function testBackend() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  return backend;
}

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

  it("accepts an Apple-shaped RS256 identity token through the HTTP router", async () => {
    const backend = testBackend();
    const keys = await webcrypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const publicKey = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1_000);
    const header = encode({ alg: "RS256", kid: "apple-live-shaped" });
    const claims = encode({
      iss: "https://appleid.apple.com",
      aud: "dev.kil.talaria",
      sub: "apple-user",
      exp: now + 600,
      iat: now,
      nonce: "hashed-nonce",
    });
    const signature = Buffer.from(await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(`${header}.${claims}`),
    )).toString("base64url");
    const appleFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      keys: [{ ...publicKey, kid: "apple-live-shaped", alg: "RS256" }],
    }), { status: 200 }));
    process.env.APPLE_SUBJECT_HASH_KEY = "test-subject-hash-key-that-is-at-least-32-bytes";
    process.env.APPLE_CLIENT_IDS = "dev.kil.talaria";
    try {
      const response = await backend.fetch("/v1/auth/apple", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identityToken: `${header}.${claims}.${signature}`,
          nonce: "hashed-nonce",
        }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ userId: expect.any(String) });
      expect(appleFetch).toHaveBeenCalledTimes(1);
    } finally {
      appleFetch.mockRestore();
      delete process.env.APPLE_SUBJECT_HASH_KEY;
      delete process.env.APPLE_CLIENT_IDS;
    }
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
      await ctx.db.insert("publisherInvitations", {
        userId: "user-1",
        tokenHash: await sha256("publisher-invitation"),
        expiresAt: now + 60_000,
        createdAt: now,
      });
      await ctx.db.insert("publisherInvitations", {
        userId: "user-1",
        tokenHash: await sha256("invalid-origin-invitation"),
        expiresAt: now + 60_000,
        createdAt: now,
      });
    });

    const pairing = await backend.fetch("/v1/pairings/publisher/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitation: "publisher-invitation",
        publisherId: "https://Hermes.Example:443",
        profileId: "profile-1",
        label: "Home",
        publicKey: Buffer.alloc(32).toString("base64url"),
      }),
    });
    expect(pairing.status).toBe(201);
    await expect(pairing.json()).resolves.toMatchObject({ publisherId: "https://hermes.example" });

    const invalidOrigin = await backend.fetch("/v1/pairings/publisher/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitation: "invalid-origin-invitation",
        publisherId: "https://hermes.example/path",
        profileId: "profile-1",
        label: "Home",
        publicKey: Buffer.alloc(32).toString("base64url"),
      }),
    });
    expect(invalidOrigin.status).toBe(400);
    const retryAfterInvalidOrigin = await backend.fetch("/v1/pairings/publisher/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitation: "invalid-origin-invitation",
        publisherId: "https://hermes.example",
        profileId: "profile-1",
        label: "Home",
        publicKey: Buffer.alloc(32, 1).toString("base64url"),
      }),
    });
    expect(retryAfterInvalidOrigin.status).toBe(201);

    const deviceBody = {
      label: "iPhone",
      bundleId: "dev.kil.talaria",
      apsEnvironment: "sandbox",
      pushToken: "push-token",
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

  it("creates one Apple user session and consumes publisher invitations exactly once", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    const signIn = {
      appleSubjectHash: "subject-hash",
      appleTokenHash: "apple-token-hash",
      appleTokenExpiresAt: now + 600_000,
      userId: "user-1",
      sessionId: "session-1",
      sessionTokenHash: "session-token-hash",
      sessionExpiresAt: now + 86_400_000,
      now,
    };
    await expect(backend.mutation(internal.auth.acceptAppleSignIn, signIn)).resolves.toEqual({
      ok: true,
      userId: "user-1",
    });
    await expect(
      backend.mutation(internal.auth.acceptAppleSignIn, {
        ...signIn,
        sessionId: "session-replay",
        sessionTokenHash: "session-token-replay",
      }),
    ).resolves.toEqual({ ok: false, reason: "replay" });

    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        sessionId: "session-1",
        sessionExpiresAt: signIn.sessionExpiresAt,
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        pushToken: "push-token",
        preferences: defaultNotificationPreferences,
        createdAt: now,
        updatedAt: now,
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
    await backend.mutation(internal.auth.revokeSession, {
      tokenHash: signIn.sessionTokenHash,
      now: now + 1,
    });
    const revokedOwnership = await backend.run(async (ctx) => ({
      device: await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1"),
        )
        .unique(),
      activity: await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1").eq("activityId", "activity-1"),
        )
        .unique(),
    }));
    expect(revokedOwnership.device?.revokedAt).toBe(now + 1);
    expect(revokedOwnership.device?.pushToken).toBeUndefined();
    expect(revokedOwnership.activity?.endedAt).toBe(now + 1);

    await backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-1",
      tokenHash: "invitation-hash",
      expiresAt: now + 60_000,
      now,
    });
    const redemption = {
      tokenHash: "invitation-hash",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      keyId: "key-1",
      label: "Home",
      publicKey: "public-key",
      now,
    };
    await expect(
      backend.mutation(internal.pairing.redeemPublisherInvitation, redemption),
    ).resolves.toMatchObject({
      ok: true,
      protocolVersion: 2,
      userId: "user-1",
      publisherId: "https://hermes.example",
      profileId: "profile-1",
      profileIdPreserved: false,
      keyId: "key-1",
    });
    await expect(
      backend.mutation(internal.pairing.redeemPublisherInvitation, {
        ...redemption,
        keyId: "key-2",
      }),
    ).resolves.toEqual({ ok: false, reason: "expired_invitation" });

    await backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-1",
      tokenHash: "replacement-invitation-hash",
      expiresAt: now + 60_000,
      now: now + 1,
    });
    await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, {
      ...redemption,
      tokenHash: "replacement-invitation-hash",
      keyId: "key-2",
      profileId: "different-profile",
      now: now + 1,
    })).resolves.toMatchObject({
      ok: true,
      keyId: "key-2",
      profileId: "profile-1",
      profileIdPreserved: true,
    });
    const ownerGrant = await backend.run(async (ctx) => ctx.db.query("publisherGrants")
      .withIndex("by_user_id_and_publisher_id", (query) =>
        query.eq("userId", "user-1").eq("publisherId", redemption.publisherId),
      ).unique());
    expect(ownerGrant?.profileId).toBe("profile-1");
    const stillActive = await backend.query(internal.pairing.getPublisherKey, {
      publisherId: redemption.publisherId,
      keyId: "key-1",
    });
    expect(stillActive).not.toHaveProperty("revokedAt");
    await backend.mutation(internal.publishers.acceptState, {
      publisherOwnerUserId: "user-1",
      publisherId: redemption.publisherId,
      profileId: "profile-1",
      keyId: "key-2",
      nonce: "activate-key-2",
      nonceExpiresAt: now + 60_000,
      receivedAt: now + 2,
      sessionId: "session-1",
      eventId: "event-1",
      revision: 1,
      state: {
        sessionId: "session-1",
        title: "Activate replacement",
        phase: "running",
        updatedAt: now + 2,
        deepLink: "/sessions/session-1",
      },
    });
    await expect(backend.query(internal.pairing.getPublisherKey, {
      publisherId: redemption.publisherId,
      keyId: "key-1",
    })).resolves.toMatchObject({ revokedAt: now + 2 });
    const replacementKey = await backend.query(internal.pairing.getPublisherKey, {
      publisherId: redemption.publisherId,
      keyId: "key-2",
    });
    expect(replacementKey).not.toHaveProperty("revokedAt");

    await backend.mutation(internal.subscriptions.revokePublisher, {
      userId: "user-1",
      publisherId: redemption.publisherId,
      now: now + 3,
    });
    await backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-1",
      tokenHash: "recovery-invitation",
      expiresAt: now + 60_000,
      now: now + 4,
    });
    await expect(backend.mutation(internal.pairing.redeemPublisherInvitation, {
      ...redemption,
      tokenHash: "recovery-invitation",
      profileId: "recovered-profile",
      keyId: "key-3",
      now: now + 4,
    })).resolves.toMatchObject({ ok: true, profileId: "recovered-profile" });
    await expect(backend.mutation(internal.publishers.acceptState, {
      publisherOwnerUserId: "user-1",
      publisherId: redemption.publisherId,
      profileId: "recovered-profile",
      keyId: "key-3",
      nonce: "activate-key-3",
      nonceExpiresAt: now + 60_000,
      receivedAt: now + 5,
      sessionId: "session-1",
      eventId: "event-1",
      revision: 1,
      state: {
        sessionId: "session-1",
        title: "Recovered",
        phase: "running",
        updatedAt: now + 5,
        deepLink: "/sessions/session-1",
      },
    })).resolves.toEqual({ status: "accepted" });
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
          updatedAt: now + 2,
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
  });

  it("preserves snapshot phase transitions for alert delivery", async () => {
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
        updatedAt: now + 1,
        deepLink: "/sessions/session-1",
      }],
    });
    const scheduled = await backend.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.at(-1)?.args).toMatchObject([{
      userId: "user-1",
      transitions: [{
        publisherId: "https://hermes.example",
        sessionId: "session-1",
        previousPhase: "running",
        state: {
          eventId: "event-2",
          phase: "waiting_for_approval",
          revision: 2,
        },
      }],
    }]);
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
        updatedAt: now + 1,
        deepLink: "/sessions/session-1",
      }],
    });
    const refreshed = await backend.query(internal.publishers.getState, {
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
        updatedAt: now + 1,
        deepLink: "/sessions/session-1",
      },
    })).resolves.toEqual({ status: "stale" });

    await backend.mutation(internal.pairing.createPublisherInvitation, {
      userId: "user-1",
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
        updatedAt: now + 3,
        deepLink: "/sessions/session-1",
      },
    })).resolves.toEqual({ status: "accepted" });
    await expect(backend.query(internal.publishers.getState, {
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
        updatedAt: now,
        deepLink: "/sessions/session-1",
      }],
    });
    const refreshed = await backend.query(internal.publishers.getState, {
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
        updatedAt: now,
        deepLink: "/sessions/session-1",
      }],
    });
    let refreshed = await backend.query(internal.publishers.getState, {
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
        updatedAt: now + 120_000,
        deepLink: "/sessions/session-1",
      }],
    });
    refreshed = await backend.query(internal.publishers.getState, {
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
        updatedAt: now + 180_000,
        deepLink: "/sessions/session-1",
      }],
    });
    refreshed = await backend.query(internal.publishers.getState, {
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

  it("retires devices and activities when cleanup expires their relay session", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("userSessions", {
        userId: "user-1",
        sessionId: "expired-session",
        tokenHash: "expired-token",
        expiresAt: 1,
        createdAt: now - 100,
      });
      await ctx.db.insert("devices", {
        userId: "user-1",
        sessionId: "expired-session",
        sessionExpiresAt: 1,
        deviceId: "expired-device",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "sandbox",
        pushToken: "expired-push",
        preferences: defaultNotificationPreferences,
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      await ctx.db.insert("liveActivities", {
        userId: "user-1",
        deviceId: "expired-device",
        activityId: "expired-activity",
        mode: "all_running",
        attributesType: "TalariaAggregateActivityAttributes",
        schemaVersion: 1,
        activityPushToken: "expired-activity-token",
        createdAt: now - 100,
        updatedAt: now - 100,
      });
    });
    const ownedBeforeCleanup = await backend.run(async (ctx) =>
      ctx.db
        .query("devices")
        .withIndex("by_user_id_and_session_id", (query) =>
          query.eq("userId", "user-1").eq("sessionId", "expired-session"),
        )
        .collect(),
    );
    expect(ownedBeforeCleanup).toHaveLength(1);
    await expect(backend.mutation(internal.cleanup.prune, {})).resolves.toMatchObject({
      revokedDevices: 1,
    });
    const state = await backend.run(async (ctx) => ({
      sessions: await ctx.db.query("userSessions").collect(),
      device: await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "expired-device"),
        )
        .unique(),
      activity: await ctx.db
        .query("liveActivities")
        .withIndex("by_user_id_and_device_id_and_activity_id", (query) =>
          query
            .eq("userId", "user-1")
            .eq("deviceId", "expired-device")
            .eq("activityId", "expired-activity"),
        )
        .unique(),
    }));
    expect(state.sessions).toHaveLength(0);
    expect(state.device?.revokedAt).toEqual(expect.any(Number));
    expect(state.device?.pushToken).toBeUndefined();
    expect(state.activity?.endedAt).toBe(state.device?.revokedAt);
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

  it("ends a displaced same-mode activity on its ActivityKit token", async () => {
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

  it("starts an aggregate activity once when work begins on an idle device", async () => {
    const backend = testBackend();
    const now = Date.now();
    await backend.run(async (ctx) => {
      await ctx.db.insert("devices", {
        userId: "user-1",
        deviceId: "device-1",
        label: "iPhone",
        bundleId: "dev.kil.talaria",
        apsEnvironment: "production",
        pushToStartToken: "push-to-start-token",
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
        eventId: "event-1",
        revision: 1,
        title: "Build relay",
        phase: "running",
        updatedAt: now,
        deepLink: "/sessions/session-1",
        expiresAt: now + 60_000,
        receivedAt: now,
      });
    });

    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });

    const state = await backend.run(async (ctx) => ({
      device: await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1"),
        )
        .unique(),
      jobs: await ctx.db.query("deliveryJobs").collect(),
    }));
    expect(state.device?.pushToStartIssuedAt).toBeDefined();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]?.kind).toBe("live_activity_start");

    await backend.run(async (ctx) => {
      await ctx.db.patch(state.device!._id, {
        pushToStartToken: "rotated-push-to-start-token",
        pushToStartIssuedAt: undefined,
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const rotated = await backend.run(async (ctx) => ({
      device: await ctx.db.get(state.device!._id),
      jobs: await ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued"))
        .collect(),
    }));
    expect(rotated.jobs).toHaveLength(2);
    const rotatedJob = rotated.jobs.find(
      (job) => job.expectedToken === "rotated-push-to-start-token",
    );
    expect(rotatedJob).toBeDefined();
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: state.jobs[0]!._id,
      now: now + 1,
    })).resolves.toEqual({ status: "stale" });
    const rotatedDevice = await backend.run(async (ctx) => ctx.db.get(state.device!._id));
    expect(rotatedDevice?.pushToStartIssuedAt).toBeDefined();

    await backend.run(async (ctx) => {
      const session = await ctx.db
        .query("sessionStates")
        .withIndex("by_user_id_and_publisher_id_and_session_id", (query) =>
          query
            .eq("userId", "user-1")
            .eq("publisherId", "https://hermes.example")
            .eq("sessionId", "session-1"),
        )
        .unique();
      await ctx.db.patch(session!._id, { title: "Updated work", updatedAt: now + 1 });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: rotatedJob!._id,
      now: now + 2,
    })).resolves.toEqual({ status: "stale" });
    const invalidated = await backend.run(async (ctx) => ({
      device: await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1"),
        )
        .unique(),
      scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(invalidated.device?.pushToStartIssuedAt).toBeUndefined();
    expect(invalidated.scheduled.some((job) => job.name === "delivery:recompute")).toBe(true);

    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const replacement = await backend.run(async (ctx) =>
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued"))
        .first(),
    );
    await backend.run(async (ctx) => {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1"),
        )
        .unique();
      await ctx.db.patch(device!._id, {
        preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: false },
      });
    });
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: replacement!._id,
      now: now + 3,
    })).resolves.toEqual({ status: "stale" });
    const disabledDevice = await backend.run(async (ctx) =>
      ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1"),
        )
        .unique(),
    );
    expect(disabledDevice?.pushToStartIssuedAt).toBeUndefined();

    await backend.run(async (ctx) => {
      await ctx.db.patch(disabledDevice!._id, {
        preferences: { ...defaultNotificationPreferences, liveActivitiesEnabled: true },
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const expiringJob = await backend.run(async (ctx) =>
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued"))
        .first(),
    );
    await backend.run(async (ctx) => {
      const device = await ctx.db.get(disabledDevice!._id);
      await ctx.db.patch(device!._id, { sessionExpiresAt: now + 3 });
    });
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: expiringJob!._id,
      now: now + 4,
    })).resolves.toEqual({ status: "stale" });
    const expiredDevice = await backend.run(async (ctx) => ctx.db.get(disabledDevice!._id));
    expect(expiredDevice?.pushToStartIssuedAt).toBeUndefined();

    await backend.run(async (ctx) => {
      await ctx.db.patch(disabledDevice!._id, { sessionExpiresAt: now + 60_000 });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const enabledJob = await backend.run(async (ctx) =>
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued"))
        .first(),
    );
    const claimed = await backend.mutation(internal.delivery.claimJob, {
      jobId: enabledJob!._id,
      now: now + 5,
    });
    expect(claimed).toMatchObject({
      status: "ready",
      kind: "live_activity_start",
      request: { token: "rotated-push-to-start-token", pushType: "liveactivity" },
      stateFingerprint: enabledJob!.stateFingerprint,
    });
    // A workpool retry re-claims the running job with the same fingerprint, so apns-collapse-id is unchanged.
    await expect(backend.mutation(internal.delivery.claimJob, {
      jobId: enabledJob!._id,
      now: now + 5,
    })).resolves.toMatchObject({ status: "ready", stateFingerprint: enabledJob!.stateFingerprint });
    await backend.mutation(internal.delivery.markDelivered, {
      jobId: enabledJob!._id,
      apnsStatus: 200,
      now: now + 6,
    });

    const startsBeforeGap = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").collect(),
    );
    await backend.run(async (ctx) => {
      const states = await ctx.db.query("sessionStates").collect();
      for (const session of states) await ctx.db.delete(session._id);
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const outstandingDevice = await backend.run(async (ctx) => ctx.db.get(disabledDevice!._id));
    expect(outstandingDevice?.pushToStartIssuedAt).toBeDefined();
    await backend.run(async (ctx) => {
      await ctx.db.insert("sessionStates", {
        version: 2,
        userId: "user-1",
        profileId: "profile-1",
        deleted: false,
        publisherId: "https://hermes.example",
        publisherLabel: "Home",
        sessionId: "session-2",
        eventId: "event-2",
        revision: 1,
        title: "More work",
        phase: "running",
        updatedAt: now + 7,
        deepLink: "/sessions/session-2",
        expiresAt: now + 60_000,
        receivedAt: now + 7,
      });
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const startsAfterGap = await backend.run(async (ctx) =>
      ctx.db.query("deliveryJobs").collect(),
    );
    expect(startsAfterGap).toHaveLength(startsBeforeGap.length);

    await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-1",
      activityId: "activity-from-apns",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "activity-token",
      seededLocally: false,
      now: now + 8,
    });
    const registeredDevice = await backend.run(async (ctx) =>
      ctx.db
        .query("devices")
        .withIndex("by_user_id_and_device_id", (query) =>
          query.eq("userId", "user-1").eq("deviceId", "device-1"),
        )
        .unique(),
    );
    expect(registeredDevice?.pushToStartIssuedAt).toBeUndefined();

    await backend.run(async (ctx) => {
      const states = await ctx.db.query("sessionStates").collect();
      for (const session of states) await ctx.db.delete(session._id);
    });
    await backend.mutation(internal.delivery.recompute, { userId: "user-1" });
    const endJob = await backend.run(async (ctx) =>
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) => query.eq("status", "queued"))
        .first(),
    );
    expect(endJob).toMatchObject({
      kind: "live_activity_end",
      activityId: "activity-from-apns",
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
});
