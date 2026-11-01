import { describe, expect, it } from "vitest";

import {
  nativeSessionRequest,
  fitActivityAggregate,
  makeLiveActivityEnd,
  makeLiveActivityStart,
  makeLiveActivityUpdate,
  makeNotification,
} from "../convex/lib/apnsPayload";
import { alertForState, makeAggregate } from "../convex/lib/aggregate";
import type { ActivityAggregate, ActivityAlert, SessionState } from "../convex/lib/model";
import { defaultNotificationPreferences } from "../convex/lib/model";

const attentionState: SessionState = {
  publisherId: "publisher-1",
  publisherLabel: "Home",
  sessionId: "session-1",
  eventId: "event-1",
  revision: 1,
  title: "Build relay",
  phase: "running",
  updatedAt: 1_800_000_000_000,
  deepLink: "/sessions/session-1",
  expiresAt: 1_800_000_060_000,
};

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
      threadId: "chat-1",
    });

    expect(request.pushType).toBe("alert");
    expect(request.collapseId).toBe("chat-1");
    expect(request.payload).toMatchObject({
      aps: { "thread-id": "chat-1" },
      publisherId: "publisher-1",
      sessionId: "session-1",
      deepLink: "/sessions/session-1",
    });
  });

  it("marks attention notifications Time Sensitive and leaves other alerts at the default level", () => {
    const notification = (alert: ActivityAlert) => makeNotification({
      token: "device-token",
      bundleId: "dev.kil.talaria",
      environment: "sandbox",
      alert,
      row: aggregate.rows[0]!,
      threadId: "chat-1",
    });
    const approval = alertForState({ ...attentionState, phase: "waiting_for_approval" }, defaultNotificationPreferences)!;
    const completion = alertForState({ ...attentionState, phase: "completed" }, defaultNotificationPreferences)!;

    expect(notification(approval).payload.aps).toMatchObject({ "interruption-level": "time-sensitive" });
    expect(notification(completion).payload.aps).not.toHaveProperty("interruption-level");
  });

  it("keeps Time Sensitive alerts off activity updates and ends, and silences their push-to-start", () => {
    const approval = alertForState({ ...attentionState, phase: "waiting_for_approval" }, defaultNotificationPreferences)!;
    const common = { token: "activity-token", bundleId: "dev.kil.talaria", environment: "sandbox" as const, nowEpochSeconds: 100 };

    expect(makeLiveActivityUpdate({ ...common, aggregate, alert: approval }).payload.aps).not.toHaveProperty("alert");
    expect(makeLiveActivityEnd({ ...common, aggregate, alert: approval }).payload.aps).not.toHaveProperty("alert");
    expect((makeLiveActivityStart({ ...common, aggregate, alert: approval }).payload.aps as Record<string, unknown>).alert)
      .toEqual({ title: approval.title, body: approval.body });
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


it("keeps all-running and native per-session payloads non-final after the foreground turn ends", () => {
  const parent = { publisherId: "publisher", publisherLabel: "Test", sessionId: "session", streamId: "parent", eventId: "done", revision: 2, title: "Test", phase: "completed" as const, activityPhase: "running" as const, updatedAt: 100, deepLink: "/sessions/session", expiresAt: 10_000 };
  for (const phase of ["running", "stale"] as const) {
    const content = makeAggregate([{ ...parent, activityPhase: phase }], 100)!;
    expect(content.activeCount).toBe(phase === "running" ? 1 : 0);
    expect(content.isFinal).toBe(false);
    const request = makeLiveActivityUpdate({ token: "synthetic", bundleId: "dev.kil.talaria", environment: "sandbox", aggregate: content, nowEpochSeconds: 1 });
    expect(request.payload.aps).toMatchObject({ event: "update", "content-state": { isFinal: false } });
    expect(nativeSessionRequest(request, 0).payload.aps).toMatchObject({ event: "update", "content-state": { isFinal: false, isStale: phase === "stale", currentActivity: phase === "running" ? "Working" : "Waiting" } });
  }
});
