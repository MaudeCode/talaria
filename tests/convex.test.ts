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
  it("rejects stale publisher revisions and duplicate nonces", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        publisherId: "publisher-1",
        label: "Home",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
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

  it("moves a globally claimed activity token to its newest owner", async () => {
    const backend = testBackend();
    const now = 1_800_000_000_000;
    await backend.run(async (ctx) => {
      for (const deviceId of ["device-1", "device-2"]) {
        await ctx.db.insert("devices", {
          deviceId,
          credentialHash: `credential-${deviceId}`,
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
      deviceId: "device-1",
      credentialHash: "credential-device-1",
      activityId: "activity-1",
    });
    await backend.mutation(internal.devices.registerActivity, {
      ...registration,
      deviceId: "device-2",
      credentialHash: "credential-device-2",
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
});
