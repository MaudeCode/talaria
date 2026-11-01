import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { alertForTransition } from "../convex/lib/aggregate";
import { defaultNotificationPreferences, type SessionPhase, type SessionState } from "../convex/lib/model";

// Talaria Web's server applies the same vectors (web/packages/server/src/sessions/notify/alerts.test.ts).
interface Vector {
  name: string;
  previous: SessionPhase | null;
  next: SessionPhase;
  alertEligible: boolean;
  preferences: Record<"notify_on_approval" | "notify_on_input" | "notify_on_completion" | "notify_on_failure", boolean>;
  expected: "approval" | "input" | "completion" | "failure" | null;
}

const { vectors } = JSON.parse(readFileSync(new URL("../../contracts/fixtures/notification-alerts.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const bodyPrefix = { approval: "Approval needed", input: "Input needed", completion: "Completed", failure: "Failed" } as const;
const now = 1_800_000_000_000;

it.each(vectors)("shared alert rule: $name", (vector) => {
  const next: SessionState = {
    publisherId: "publisher-1", publisherLabel: "Home", sessionId: "s1", streamId: "stream-1", eventId: "event-1", revision: 1,
    title: "Session", phase: vector.next, updatedAt: now, deepLink: "/sessions/s1", expiresAt: now + 60_000, terminalExpiresAt: now + 60_000,
    ...(vector.alertEligible ? {} : { alertEligible: false }),
  };
  const preferences = {
    ...defaultNotificationPreferences,
    notifyOnApproval: vector.preferences.notify_on_approval,
    notifyOnInput: vector.preferences.notify_on_input,
    notifyOnCompletion: vector.preferences.notify_on_completion,
    notifyOnFailure: vector.preferences.notify_on_failure,
  };
  const alert = alertForTransition(vector.previous, next, preferences);
  if (vector.expected === null) expect(alert).toBeNull();
  else expect(alert?.body.startsWith(`${bodyPrefix[vector.expected]} on `)).toBe(true);
});
