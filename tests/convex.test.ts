import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { defaultNotificationPreferences } from "../convex/lib/model";

const modules = import.meta.glob("../convex/**/*.ts");

function testBackend() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  return backend;
}

describe("Convex relay state", () => {
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
    await expect(backend.query(internal.pairing.getPublisherKey, {
      publisherId: redemption.publisherId,
      keyId: "key-1",
    })).resolves.toMatchObject({ revokedAt: now + 1 });
    const replacementKey = await backend.query(internal.pairing.getPublisherKey, {
      publisherId: redemption.publisherId,
      keyId: "key-2",
    });
    expect(replacementKey).not.toHaveProperty("revokedAt");
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
});
