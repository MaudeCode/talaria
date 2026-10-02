import { describe, expect, it } from "vitest";

import {
  alertForTransition,
  makeAggregate,
  MAX_AGGREGATE_ROWS,
  shouldUpdateAggregate,
} from "../convex/lib/aggregate";
import { defaultNotificationPreferences, type SessionPhase, type SessionState } from "../convex/lib/model";

const now = 1_800_000_000_000;

function state(
  sessionId: string,
  phase: SessionPhase,
  updatedAt = now,
): SessionState {
  return {
    publisherId: "publisher-1",
    publisherLabel: "Home",
    sessionId,
    streamId: `stream-${sessionId}`,
    eventId: `event-${sessionId}-${phase}`,
    revision: 1,
    title: `Session ${sessionId}`,
    phase,
    updatedAt,
    deepLink: `/sessions/${sessionId}`,
    expiresAt: now + 60_000,
    terminalExpiresAt: now + 60_000,
  };
}

describe("makeAggregate", () => {
  it("counts every active session while capping and prioritizing display rows", () => {
    const states = [
      state("run-1", "running"),
      state("run-2", "running"),
      state("run-3", "running"),
      state("run-4", "running"),
      state("run-5", "running"),
      state("approval", "waiting_for_approval", now - 1),
      state("input", "waiting_for_input", now - 2),
    ];

    const aggregate = makeAggregate(states, now);

    expect(aggregate?.activeCount).toBe(7);
    expect(aggregate?.rows).toHaveLength(MAX_AGGREGATE_ROWS);
    expect(aggregate?.rows.slice(0, 2).map((row) => row.sessionId)).toEqual([
      "approval",
      "input",
    ]);
  });

  it("puts the newest outcome first within a phase, whatever its session id", () => {
    // The widget opens `rows[0]` from the compact and minimal presentations.
    const older = state("aaa-older", "completed", now - 6 * 24 * 60 * 60_000);
    const newer = state("zzz-newer", "completed", now - 60_000);

    const aggregate = makeAggregate([older, newer], now, true);

    expect(aggregate?.rows.map((row) => row.sessionId)).toEqual(["zzz-newer", "aaa-older"]);
  });

  it("keeps terminal context only while nonterminal work remains", () => {
    const expired = { ...state("expired", "running"), expiresAt: now - 1 };
    const terminal = state("done", "completed");

    expect(makeAggregate([expired, terminal], now)).toBeNull();
    expect(makeAggregate([terminal], now, true)).toMatchObject({
      activeCount: 0,
      subtitle: "Agent work completed",
      rows: [{ sessionId: "done", status: "Done" }],
    });
    expect(makeAggregate([state("run", "running"), terminal], now)?.rows.map((row) => row.sessionId)).toEqual([
      "run",
      "done",
    ]);
    expect(
      makeAggregate([{ ...terminal, terminalExpiresAt: now - 1 }], now),
    ).toBeNull();
  });

  it("keeps capped row membership stable across heartbeat timestamps", () => {
    const sessions = ["run-1", "run-2", "run-3", "run-4", "run-5", "run-6"];
    const first = makeAggregate(
      sessions.map((sessionId, index) => state(sessionId, "running", now + index)),
      now
    );
    const heartbeat = makeAggregate(
      sessions.map((sessionId, index) => state(sessionId, "running", now - index)),
      now
    );

    expect(heartbeat?.rows.map((row) => row.sessionId)).toEqual(
      first?.rows.map((row) => row.sessionId)
    );
  });

  it("shows the newest retained outcome for a session while preserving its other records", () => {
    const first = { ...state("same", "completed", now - 10), streamId: "run-1", completionId: "first" };
    const latest = { ...state("same", "completed", now), streamId: "run-2", completionId: "latest" };
    expect(makeAggregate([first, latest], now, true)?.rows[0]?.completionId).toBe("latest");
    expect(makeAggregate([{ ...first, phase: "failed" }, latest], now, true)?.rows[0]?.completionId).toBe("latest");
    expect(makeAggregate([latest, { ...first, phase: "running" }], now, true)?.activeCount).toBe(1);
  });

  it("does not update unchanged aggregates and throttles routine changes", () => {
    const previous = makeAggregate([state("a", "running")], now)!;
    const changed = makeAggregate([state("a", "running", now + 1)], now)!;

    expect(shouldUpdateAggregate(previous, previous, now, now)).toBe(false);
    expect(shouldUpdateAggregate(previous, previous, now, now + 120_000)).toBe(true);
    expect(shouldUpdateAggregate(previous, changed, now, now + 1)).toBe(false);
    expect(shouldUpdateAggregate(previous, changed, now, now + 15_000)).toBe(true);
  });
});

describe("alertForTransition", () => {
  it("alerts once when a session enters an attention state", () => {
    const previous = state("a", "running");
    const waiting = state("a", "waiting_for_approval");

    expect(alertForTransition(previous, waiting, defaultNotificationPreferences)).toEqual({
      title: "Session a",
      body: "Approval needed on Home",
    });
    expect(alertForTransition(waiting, waiting, defaultNotificationPreferences)).toBeNull();
  });
});
