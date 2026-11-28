import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  nativeSessionRequest,
  makeLiveActivityEnd,
  makeLiveActivityStart,
  makeLiveActivityUpdate,
  makeNotification,
} from "../convex/lib/apnsPayload";
import { alertForState, makeAggregate } from "../convex/lib/aggregate";
import type { ActivityAggregate, ActivityAlert, SessionState } from "../convex/lib/model";
import { activityPhase, defaultNotificationPreferences } from "../convex/lib/model";

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

it("ships every Relay notification body format in each App language", () => {
  const app = new URL("../../app/", import.meta.url);
  const project = readFileSync(new URL("Talaria.xcodeproj/project.pbxproj", app), "utf8");
  const regions = project.match(/knownRegions\s*=\s*\(([^)]+)\)/)?.[1];
  expect(regions).toBeDefined();
  const languages = regions!.split(",").map((region) => region.trim().replaceAll('"', ""))
    .filter((region) => region !== "" && region !== "Base");
  expect(languages).toContain("en");
  const catalog = JSON.parse(readFileSync(new URL("Talaria/Resources/Localizable.xcstrings", app), "utf8")) as {
    strings: Record<string, { localizations?: Record<string, { stringUnit?: { value?: string } }> }>;
  };
  const keys = (["waiting_for_approval", "waiting_for_input", "completed", "failed"] as const).map((phase) => {
    const alert = alertForState({ ...attentionState, phase }, defaultNotificationPreferences);
    if (!alert || typeof alert.body === "string") throw new Error(`Missing localized body for ${phase}`);
    return alert.body.key;
  });
  const start = makeLiveActivityStart({
    token: "synthetic", bundleId: "dev.kil.talaria", environment: "sandbox",
    aggregate, nowEpochSeconds: 100, alert: null,
  });
  const { alert } = start.payload.aps as { alert: { body: { "loc-key": string } } };
  keys.push(alert.body["loc-key"]);

  for (const key of keys) {
    for (const language of languages) {
      const value = catalog.strings[key]?.localizations?.[language]?.stringUnit?.value;
      expect(value?.replace("%@", "").trim(), `${key} (${language})`).toBeTruthy();
      expect(value?.match(/%@/g), `${key} (${language}) server name placeholder`).toHaveLength(1);
    }
  }
});

describe("ActivityKit payloads", () => {
  it("starts an aggregate activity with a new update token", () => {
    const request = makeLiveActivityStart({
      token: "push-to-start-token",
      bundleId: "dev.kil.talaria",
      environment: "production",
      aggregate,
      nowEpochSeconds: 100,
      alert: null,
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
          alert: { title: "Talaria", body: { "loc-key": "Work in progress on %@", "loc-args": ["Home"] }, sound: "default" },
        },
      },
    });
  });

  it("keeps a push-to-start below APNs' size limit when its localized alert names a long chat and server", () => {
    const states: SessionState[] = Array.from({ length: 5 }, (_, index) => ({
      ...attentionState, publisherId: "https://publisher.example.com", publisherLabel: "界".repeat(80),
      sessionId: `session-${String(index)}-${"s".repeat(32)}`, streamId: `stream-${"r".repeat(32)}`,
      title: "界".repeat(120), deepLink: `/sessions/session-${String(index)}-${"s".repeat(32)}`,
      startedAt: 1_799_999_000_000, toolCount: 9_999, activityAt: 1_800_000_000_000,
      planCompleted: 9_999, planTotal: 9_999, workerCount: 9_999,
    }));
    const request = makeLiveActivityStart({
      token: "push-to-start-token", bundleId: "dev.kil.talaria", environment: "sandbox",
      aggregate: makeAggregate(states, 1_800_000_000_000)!, nowEpochSeconds: 1_800_000_000,
      alert: alertForState({ ...states[0]!, phase: "waiting_for_approval" }, defaultNotificationPreferences)!,
    });

    expect(new TextEncoder().encode(JSON.stringify(request.payload)).byteLength).toBeLessThanOrEqual(4_096);
    expect(request.payload.aps).toHaveProperty("content-state.rows.0.sessionId", states[0]!.sessionId);
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
    expect(request.payload).toMatchObject({ aps: { "content-state": { activeCount: 1, rows: [] } } });
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

  it("TAL-1469: lets only the approval or question an alert names be answered from the banner", () => {
    const notification = (state: SessionState) => makeNotification({
      token: "device-token",
      bundleId: "dev.kil.talaria",
      environment: "sandbox",
      alert: alertForState(state, defaultNotificationPreferences)!,
      row: { ...aggregate.rows[0]!, phase: activityPhase(state) },
      threadId: "chat-1",
    });
    const approval = notification({ ...attentionState, phase: "waiting_for_approval", approvalHeadId: "head-1" });
    expect(approval.payload.aps).toMatchObject({ category: "talaria.approval" });
    expect(approval.payload).toMatchObject({ approvalHeadId: "head-1" });
    const input = notification({ ...attentionState, phase: "waiting_for_input", inputHeadId: "question-1" });
    expect(input.payload.aps).toMatchObject({ category: "talaria.input" });
    expect(input.payload).toMatchObject({ inputHeadId: "question-1" });
    expect(input.payload).not.toHaveProperty("approvalHeadId");
    // Deny and Reply answer only the request the banner names; an older publisher's unnamed one opens the chat.
    for (const phase of ["waiting_for_approval", "waiting_for_input"] as const) {
      const unnamed = notification({ ...attentionState, phase });
      expect(unnamed.payload.aps).not.toHaveProperty("category");
      expect(Object.keys(unnamed.payload)).toEqual(["aps", "publisherId", "sessionId", "deepLink"]);
    }
    for (const phase of ["completed", "failed"] as const) {
      expect(notification({ ...attentionState, phase }).payload.aps).not.toHaveProperty("category");
    }
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

  it.each([
    ["waiting_for_approval", "Approval needed on %@"],
    ["waiting_for_input", "Input needed on %@"],
    ["completed", "Completed on %@"],
    ["failed", "Failed on %@"],
  ] as const)("localizes the %s notification body with the server name", (phase, key) => {
    const alert = alertForState({ ...attentionState, phase }, defaultNotificationPreferences)!;
    const request = makeNotification({
      token: "device-token", bundleId: "dev.kil.talaria", environment: "sandbox",
      alert, row: aggregate.rows[0]!, threadId: "chat-1",
    });

    expect(request.payload.aps).toHaveProperty("alert", {
      title: "Build relay", "loc-key": key, "loc-args": ["Home"],
    });
  });

  it("keeps Time Sensitive alerts off activity updates and ends, and silences their push-to-start", () => {
    const approval = alertForState({ ...attentionState, phase: "waiting_for_approval" }, defaultNotificationPreferences)!;
    const common = { token: "activity-token", bundleId: "dev.kil.talaria", environment: "sandbox" as const, nowEpochSeconds: 100 };

    expect(makeLiveActivityUpdate({ ...common, aggregate, alert: approval }).payload.aps).not.toHaveProperty("alert");
    expect(makeLiveActivityEnd({ ...common, aggregate, alert: approval }).payload.aps).not.toHaveProperty("alert");
    expect((makeLiveActivityStart({ ...common, aggregate, alert: approval }).payload.aps as Record<string, unknown>).alert)
      .toEqual({ title: "Build relay", body: { "loc-key": "Approval needed on %@", "loc-args": ["Home"] } });
  });
});


it("names the approval a waiting row shows in the aggregate and native per-session payloads (TAL-1463)", () => {
  const waiting = { publisherId: "publisher", publisherLabel: "Test", sessionId: "session", streamId: "run", eventId: "wait", revision: 1, title: "Test", phase: "waiting_for_approval" as const, updatedAt: 100, deepLink: "/sessions/session", expiresAt: 10_000, approvalHeadId: "head-1" };
  const content = makeAggregate([waiting], 100)!;
  expect(content.rows[0]).toMatchObject({ phase: "waiting_for_approval", approvalHeadId: "head-1" });
  const request = makeLiveActivityUpdate({ token: "synthetic", bundleId: "dev.kil.talaria", environment: "sandbox", aggregate: content, nowEpochSeconds: 1 });
  expect(nativeSessionRequest(request).payload.aps).toMatchObject({ "content-state": { status: "waitingForApproval", approvalHeadID: "head-1" } });
  // Relay keeps a run's head across its other phases; only a waiting row names it.
  expect(makeAggregate([{ ...waiting, phase: "running" }], 100)!.rows[0]).not.toHaveProperty("approvalHeadId");
});

it("keeps all-running and native per-session payloads non-final after the foreground turn ends", () => {
  const parent = { publisherId: "publisher", publisherLabel: "Test", sessionId: "session", streamId: "parent", eventId: "done", revision: 2, title: "Test", phase: "completed" as const, activityPhase: "running" as const, updatedAt: 100, deepLink: "/sessions/session", expiresAt: 10_000 };
  for (const phase of ["running", "stale"] as const) {
    const content = makeAggregate([{ ...parent, activityPhase: phase }], 100)!;
    expect(content.activeCount).toBe(phase === "running" ? 1 : 0);
    expect(content.isFinal).toBe(false);
    const request = makeLiveActivityUpdate({ token: "synthetic", bundleId: "dev.kil.talaria", environment: "sandbox", aggregate: content, nowEpochSeconds: 1 });
    expect(request.payload.aps).toMatchObject({ event: "update", "content-state": { isFinal: false } });
    expect(nativeSessionRequest(request).payload.aps).toMatchObject({ event: "update", "content-state": { isFinal: false, isStale: phase === "stale", currentActivity: phase === "running" ? "Working" : "Waiting" } });
  }
});

// The content state an update sends, after fitting it under ActivityKit's limit.
const contentState = (content: ActivityAggregate) => (makeLiveActivityUpdate({
  token: "synthetic", bundleId: "dev.kil.talaria", environment: "sandbox", aggregate: content, nowEpochSeconds: 1,
}).payload.aps as { "content-state": ActivityAggregate })["content-state"];

// TAL-1422: the largest plan and worker counts a publisher may send cost no row of a full aggregate with the longest titles.
it("fits a full aggregate's largest plan and worker counts without dropping a row", () => {
  const states: SessionState[] = Array.from({ length: 5 }, (_, index) => ({
    ...attentionState, publisherId: "https://publisher.example.com", sessionId: `session-${String(index)}-${"s".repeat(32)}`,
    streamId: `stream-${"r".repeat(32)}`, title: "t".repeat(120), deepLink: `/sessions/session-${String(index)}-${"s".repeat(32)}`,
    startedAt: 1_799_999_000_000, toolCount: 9_999, activityAt: 1_800_000_000_000,
    planCompleted: 9_999, planTotal: 9_999, workerCount: 9_999,
  }));
  const full = makeAggregate(states, 1_800_000_000_000)!;
  expect(full.rows).toHaveLength(5);
  expect(full.rows[0]).toMatchObject({ planCompleted: 9_999, planTotal: 9_999, workerCount: 9_999 });
  expect(contentState(full).rows).toHaveLength(5);
});

// TAL-2336: the largest current call a publisher may send, on every row of a full aggregate with the longest titles.
const largestTool = {
  kind: "connector", target: "t".repeat(64), done: true, failed: true, verb: "comment", app: { name: "a".repeat(64) },
  outcome: { key: "failed", tone: "error" as const, count: 1, value: "v".repeat(64) },
};

it("maps the current call into the native content state, and leaves an older publisher's row without one", () => {
  const request = (state: SessionState) => nativeSessionRequest(makeLiveActivityUpdate({
    token: "synthetic", bundleId: "dev.kil.talaria", environment: "sandbox", aggregate: makeAggregate([state], 100)!, nowEpochSeconds: 1,
  })).payload.aps as { "content-state": Record<string, unknown> };
  const running = { ...attentionState, phase: "running" as const, currentTool: { kind: "shell", target: "npm test", done: false } };
  expect(request(running)["content-state"].currentTool).toEqual({ kind: "shell", target: "npm test", done: false });
  expect(request({ ...attentionState, phase: "running" })["content-state"]).not.toHaveProperty("currentTool");
});

it("keeps every row of a full aggregate by dropping the later rows' current calls first", () => {
  const states: SessionState[] = Array.from({ length: 5 }, (_, index) => ({
    ...attentionState, publisherId: "https://publisher.example.com", sessionId: `session-${String(index)}-${"s".repeat(32)}`,
    streamId: `stream-${"r".repeat(32)}`, title: "t".repeat(120), deepLink: `/sessions/session-${String(index)}-${"s".repeat(32)}`,
    startedAt: 1_799_999_000_000, toolCount: 9_999, activityAt: 1_800_000_000_000,
    planCompleted: 9_999, planTotal: 9_999, workerCount: 9_999, currentTool: largestTool,
  }));
  const fitted = contentState(makeAggregate(states, 1_800_000_000_000)!);
  expect(fitted.rows).toHaveLength(5);
  // The first row, which a per-session activity shows, keeps its call.
  expect(fitted.rows[0]!.currentTool).toEqual(largestTool);
  expect(new TextEncoder().encode(JSON.stringify(fitted)).byteLength).toBeLessThanOrEqual(3_500);
});
