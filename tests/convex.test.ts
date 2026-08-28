import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { sha256 } from "../convex/lib/crypto";
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
    });

    const pairing = await backend.fetch("/v1/pairings/publisher/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitation: "publisher-invitation",
        publisherId: "https://Hermes.Example:443",
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
        invitation: "publisher-invitation",
        publisherId: "https://hermes.example/path",
        label: "Home",
        publicKey: Buffer.alloc(32).toString("base64url"),
      }),
    });
    expect(invalidOrigin.status).toBe(400);

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
      keyId: "key-1",
      label: "Home",
      publicKey: "public-key",
      now,
    };
    await expect(
      backend.mutation(internal.pairing.redeemPublisherInvitation, redemption),
    ).resolves.toEqual({
      ok: true,
      userId: "user-1",
      publisherId: "https://hermes.example",
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
    await backend.mutation(internal.pairing.redeemPublisherInvitation, {
      ...redemption,
      tokenHash: "replacement-invitation-hash",
      keyId: "key-2",
      now: now + 1,
    });
    const stillActive = await backend.query(internal.pairing.getPublisherKey, {
      publisherId: redemption.publisherId,
      keyId: "key-1",
    });
    expect(stillActive).not.toHaveProperty("revokedAt");
    await backend.mutation(internal.publishers.acceptState, {
      userId: "user-1",
      publisherId: redemption.publisherId,
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
  });

  it("preserves snapshot phase transitions for alert delivery", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        userId: "user-1",
        publisherId: "https://hermes.example",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        userId: "user-1",
        publisherId: "https://hermes.example",
        keyId: "key-1",
        publicKey: "public-key",
        activatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("sessionStates", {
        userId: "user-1",
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
      userId: "user-1",
      publisherId: "https://hermes.example",
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
      userId: "user-1",
      publisherId: "https://hermes.example",
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
        userId: "user-1",
        publisherId: "publisher-1",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        userId: "user-1",
        publisherId: "publisher-1",
        keyId: "key-1",
        publicKey: "public-key",
        createdAt: now,
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
        userId: "user-1",
        publisherId: "publisher-1",
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
        userId: "user-1",
        publisherId: "publisher-1",
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
        userId: "user-1",
        publisherId: "publisher-1",
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

  it("keeps publisher, device, snapshot, and activity state tenant isolated", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      for (const userId of ["user-1", "user-2"]) {
        await ctx.db.insert("relayUsers", {
          userId,
          appleSubjectHash: `apple-${userId}`,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("publishers", {
          userId,
          publisherId: "https://hermes.example",
          label: userId,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("publisherKeys", {
          userId,
          publisherId: "https://hermes.example",
          keyId: `key-${userId}`,
          publicKey: "public-key",
          createdAt: now,
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
        userId,
        publisherId: "https://hermes.example",
        keyId: `key-${userId}`,
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
    expect(first.map((item) => item.publisherLabel)).toEqual(["user-1"]);
    expect(second.map((item) => item.publisherLabel)).toEqual(["user-2"]);

    const registered = await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-user-1",
      activityId: "activity-1",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "tenant-token",
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
          userId,
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
        userId: "user-1",
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

    const claimed = await backend.mutation(internal.delivery.claimJob, {
      jobId: state.jobs[0]!._id,
      now: now + 1,
    });
    expect(claimed).toMatchObject({
      status: "ready",
      kind: "live_activity_start",
      request: { token: "push-to-start-token", pushType: "liveactivity" },
    });

    await backend.mutation(internal.devices.registerActivity, {
      userId: "user-1",
      deviceId: "device-1",
      activityId: "activity-from-apns",
      mode: "all_running",
      attributesType: "TalariaAggregateActivityAttributes",
      schemaVersion: 1,
      activityPushToken: "activity-token",
      now: now + 2,
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
  });
});
