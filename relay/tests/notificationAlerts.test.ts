import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { agentNotifyAlert, alertForTransition, approvalAlertBodyKey } from "../convex/lib/aggregate";
import { defaultNotificationPreferences, type AgentNotify, type SessionPhase, type SessionState } from "../convex/lib/model";

// Talaria Web's server applies the same vectors (web/packages/server/src/sessions/notify/alerts.test.ts).
interface Vector {
  name: string;
  previous: SessionPhase | null;
  next: SessionPhase;
  alertEligible: boolean;
  previousDecisionReviewId?: string | null;
  decisionReviewId?: string;
  preferences: Record<"notify_on_approval" | "notify_on_input" | "notify_on_completion" | "notify_on_failure", boolean>;
  expected: "approval" | "input" | "completion" | "failure" | "decision" | null;
}

interface NoticeVector { name: string; previousAgentNotifyId: string | null; agentNotify?: AgentNotify; alertEligible: boolean; expected: boolean }

const { vectors, agentNotify } = JSON.parse(readFileSync(new URL("../../contracts/fixtures/notification-alerts.json", import.meta.url), "utf8")) as { vectors: Vector[]; agentNotify: NoticeVector[] };
const bodyPrefix = { input: "Input needed", completion: "Completed", failure: "Failed" } as const;
const now = 1_800_000_000_000;

it.each(vectors)("shared alert rule: $name", (vector) => {
  const next: SessionState = {
    publisherId: "publisher-1", publisherLabel: "Home", sessionId: "s1", streamId: "stream-1", eventId: "event-1", revision: 1,
    title: "Session", phase: vector.next, updatedAt: now, deepLink: "/sessions/s1", expiresAt: now + 60_000, terminalExpiresAt: now + 60_000,
    ...(vector.alertEligible ? {} : { alertEligible: false }),
    ...(vector.decisionReviewId ? { decisionReviewId: vector.decisionReviewId, decisionReviewTitle: "Release choices" } : {}),
  };
  const preferences = {
    ...defaultNotificationPreferences,
    notifyOnApproval: vector.preferences.notify_on_approval,
    notifyOnInput: vector.preferences.notify_on_input,
    notifyOnCompletion: vector.preferences.notify_on_completion,
    notifyOnFailure: vector.preferences.notify_on_failure,
  };
  const alert = alertForTransition(vector.previous, next, preferences, undefined, vector.previousDecisionReviewId);
  if (vector.expected === null) expect(alert).toBeNull();
  else if (vector.expected === "decision") expect(alert).toMatchObject({ title: "Decision review ready", body: "Release choices", deepLink: `/decisions/${String(vector.decisionReviewId)}` });
  else if (vector.expected === "approval") expect(alert?.body).toBe(approvalAlertBodyKey);
  else expect(alert?.body.startsWith(`${bodyPrefix[vector.expected]} on `)).toBe(true);
});

// TAL-1970: a notice the state did not hold alerts with the agent's words, whatever alertEligible says.
it.each(agentNotify)("shared agent notice rule: $name", (vector) => {
  const next: SessionState = {
    publisherId: "publisher-1", publisherLabel: "Home", sessionId: "s1", streamId: "stream-1", eventId: "event-1", revision: 1,
    title: "Session", phase: "running", updatedAt: now, deepLink: "/sessions/s1", expiresAt: now + 60_000,
    ...(vector.alertEligible ? {} : { alertEligible: false }),
    ...(vector.agentNotify ? { agentNotify: vector.agentNotify } : {}),
  };
  const alert = agentNotifyAlert(next, vector.previousAgentNotifyId);
  if (!vector.expected) expect(alert).toBeNull();
  else expect(alert).toEqual({
    title: vector.agentNotify!.title,
    body: vector.agentNotify!.body,
    interruptionLevel: vector.agentNotify!.level === "attention" ? "time-sensitive" : "active",
    agentNotifyId: vector.agentNotify!.id,
  });
});
