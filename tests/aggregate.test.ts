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

  it("keeps terminal context only while nonterminal work remains", () => {
    const expired = { ...state("expired", "running"), expiresAt: now - 1 };
    const terminal = state("done", "completed");

    expect(makeAggregate([expired, terminal], now)).toBeNull();
    expect(makeAggregate([state("run", "running"), terminal], now)?.rows.map((row) => row.sessionId)).toEqual([
      "run",
      "done",
    ]);
    expect(
      makeAggregate([{ ...terminal, terminalExpiresAt: now - 1 }], now),
    ).toBeNull();
  });

  it("does not update unchanged aggregates and throttles routine changes", () => {
    const previous = makeAggregate([state("a", "running")], now)!;
    const changed = makeAggregate([state("a", "running", now + 1)], now)!;

    expect(shouldUpdateAggregate(previous, previous, now, now)).toBe(false);
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
