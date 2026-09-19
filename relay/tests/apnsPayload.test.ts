import { describe, expect, it } from "vitest";

import {
  fitActivityAggregate,
  makeLiveActivityEnd,
  makeLiveActivityStart,
  makeLiveActivityUpdate,
  makeNotification,
} from "../convex/lib/apnsPayload";
import type { ActivityAggregate } from "../convex/lib/model";

const aggregate: ActivityAggregate = {
  schemaVersion: 1,
  activeCount: 1,
  title: "Talaria",
  subtitle: "1 active session",
  updatedAt: 1_800_000_000_000,
  rows: [
    {
      publisherId: "publisher-1",
      publisherLabel: "Home",
      sessionId: "session-1",
      title: "Build relay",
      phase: "running",
      status: "Working",
      updatedAt: 1_800_000_000_000,
      deepLink: "/sessions/session-1",
    },
  ],
};

describe("ActivityKit payloads", () => {
  it("starts an aggregate activity with a new update token", () => {
    const request = makeLiveActivityStart({
      token: "push-to-start-token",
      bundleId: "dev.kil.talaria",
      environment: "production",
      aggregate,
      nowEpochSeconds: 100,
      alert: { title: "Talaria", body: "1 active session" },
    });

    expect(request).toMatchObject({
      token: "push-to-start-token",
      pushType: "liveactivity",
      priority: "10",
      payload: {
        aps: {
          event: "start",
          "attributes-type": "TalariaAggregateActivityAttributes",
          attributes: {},
          "input-push-token": 1,
          "content-state": aggregate,
          "stale-date": 700,
          alert: { title: "Talaria", body: "1 active session", sound: "default" },
        },
      },
    });
  });

  it("uses low priority for routine updates and advances stale-date", () => {
    const request = makeLiveActivityUpdate({
      token: "activity-token",
      bundleId: "dev.kil.talaria",
      environment: "sandbox",
      aggregate,
      nowEpochSeconds: 100,
    });

    expect(request.priority).toBe("5");
    expect(request.topic).toBe("dev.kil.talaria.push-type.liveactivity");
    expect(request.payload).toEqual({
      aps: {
        timestamp: 100,
        event: "update",
        "content-state": aggregate,
        "stale-date": 700,
      },
    });
  });

  it("uses high priority and an alert for attention updates", () => {
    const request = makeLiveActivityUpdate({
      token: "activity-token",
      bundleId: "dev.kil.talaria",
      environment: "sandbox",
      aggregate,
      nowEpochSeconds: 100,
      alert: { title: "Approval needed", body: "Build relay" },
    });

    expect(request.priority).toBe("10");
    expect(request.payload).toMatchObject({
      aps: { alert: { title: "Approval needed", body: "Build relay", sound: "default" } },
    });
  });

  it.each(["waiting_for_approval", "waiting_for_input", "failed"] as const)(
    "uses high priority for %s without requiring an alert",
    (phase) => {
      const request = makeLiveActivityUpdate({
        token: "activity-token",
        bundleId: "dev.kil.talaria",
        environment: "sandbox",
        aggregate: {
          ...aggregate,
          rows: [{ ...aggregate.rows[0]!, phase, status: phase }],
        },
        nowEpochSeconds: 100,
      });

      expect(request.priority).toBe("10");
      expect(request.payload.aps).not.toHaveProperty("alert");
    },
  );

  it.each(["completed", "cancelled"] as const)(
    "keeps %s rows at low priority when work remains active",
    (phase) => {
      const request = makeLiveActivityUpdate({
        token: "activity-token",
        bundleId: "dev.kil.talaria",
        environment: "sandbox",
        aggregate: {
          ...aggregate,
          rows: [
            aggregate.rows[0]!,
            { ...aggregate.rows[0]!, sessionId: "terminal-session", phase, status: phase },
          ],
        },
        nowEpochSeconds: 100,
      });

      expect(request.priority).toBe("5");
    },
  );

  it("preserves attention priority when fitting removes an oversized row", () => {
    const request = makeLiveActivityUpdate({
      token: "activity-token",
      bundleId: "dev.kil.talaria",
      environment: "sandbox",
      aggregate: {
        ...aggregate,
        rows: [{
          ...aggregate.rows[0]!,
          title: "x".repeat(4_000),
          phase: "waiting_for_input",
          status: "Input",
        }],
      },
      nowEpochSeconds: 100,
    });

    expect(request.priority).toBe("10");
    expect(request.payload).toMatchObject({ aps: { "content-state": { rows: [] } } });
  });

  it("ends with final content and a five-minute dismissal", () => {
    const request = makeLiveActivityEnd({
      token: "activity-token",
      bundleId: "dev.kil.talaria",
      environment: "production",
      aggregate,
      nowEpochSeconds: 100,
    });

    expect(request.priority).toBe("10");
    expect(request.payload).toMatchObject({
      aps: { event: "end", "content-state": aggregate, "dismissal-date": 400 },
    });
  });

  it("builds an ordinary notification with routing identity", () => {
    const request = makeNotification({
      token: "device-token",
      bundleId: "dev.kil.talaria",
      environment: "sandbox",
      alert: { title: "Done", body: "Build relay" },
      row: aggregate.rows[0]!,
    });

    expect(request.pushType).toBe("alert");
    expect(request.payload).toMatchObject({
      publisherId: "publisher-1",
      sessionId: "session-1",
      deepLink: "/sessions/session-1",
    });
  });

  it("drops overflow rows before ActivityKit's content-state boundary", () => {
    const oversized: ActivityAggregate = {
      ...aggregate,
      rows: Array.from({ length: 5 }, (_, index) => ({
        ...aggregate.rows[0]!,
        sessionId: `session-${index}-${"x".repeat(500)}`,
        deepLink: `/sessions/${"y".repeat(500)}`,
      })),
    };

    const fitted = fitActivityAggregate(oversized);

    expect(fitted.activeCount).toBe(oversized.activeCount);
    expect(fitted.rows.length).toBeLessThan(oversized.rows.length);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).byteLength).toBeLessThanOrEqual(3_500);
  });
});
