import type {
  ActivityAggregate,
  ActivityAlert,
  AggregateRow,
  NotificationPreferences,
  SessionPhase,
  SessionState,
} from "./model";
import { isTerminalPhase } from "./model";

export const MAX_AGGREGATE_ROWS = 5;

function phasePriority(phase: SessionPhase): number {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return 0;
    case "failed":
      return 1;
    case "starting":
    case "running":
      return 2;
    case "completed":
    case "cancelled":
      return 3;
    case "stale":
      return 4;
  }
}

function statusForPhase(phase: SessionPhase): string {
  switch (phase) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "stale":
      return "Waiting";
  }
}

export function rowForState(state: SessionState): AggregateRow {
  return {
    ...(state.completionId ? { completionId: state.completionId } : {}),
    publisherId: state.publisherId,
    publisherLabel: state.publisherLabel,
    sessionId: state.sessionId,
    streamId: state.streamId,
    title: state.title,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

export function makeAggregate(
  states: readonly SessionState[],
  now: number,
  includeTerminalOnly = false,
): ActivityAggregate | null {
  const bySession = new Map<string, SessionState>();
  for (const state of states) {
    if (state.deleted || state.expiresAt <= now
      || (isTerminalPhase(state.phase) && (state.terminalExpiresAt ?? 0) <= now)) continue;
    const key = JSON.stringify([state.publisherId, state.sessionId]);
    const current = bySession.get(key);
    if (!current
      || (isTerminalPhase(current.phase) && !isTerminalPhase(state.phase))
      || (isTerminalPhase(current.phase) === isTerminalPhase(state.phase) && state.updatedAt > current.updatedAt)) {
      bySession.set(key, state);
    }
  }
  // The card shows the latest outcome per session; the inbox retains every run.
  const visible = [...bySession.values()]
    .sort(
      (left, right) =>
        phasePriority(left.phase) - phasePriority(right.phase) ||
        // A finished run keeps the instant it ended, so the newest outcome leads; running rows heartbeat their
        // timestamps and keep the stable id order.
        (isTerminalPhase(left.phase) && isTerminalPhase(right.phase) ? right.updatedAt - left.updatedAt : 0) ||
        `${left.publisherId}\u0000${left.sessionId}\u0000${left.streamId ?? ""}`.localeCompare(
          `${right.publisherId}\u0000${right.sessionId}\u0000${right.streamId ?? ""}`,
        ),
    );

  if (visible.length === 0) return null;
  if (!includeTerminalOnly && !visible.some((state) => !isTerminalPhase(state.phase))) return null;

  const activeCount = visible.filter(
    (state) => !isTerminalPhase(state.phase) && state.phase !== "stale",
  ).length;
  const failed = visible.some((state) => state.phase === "failed");
  const attentionCount = visible.filter(
    (state) => state.phase === "waiting_for_approval" || state.phase === "waiting_for_input",
  ).length;

  return {
    schemaVersion: 1,
    activeCount,
    title: "Talaria",
    subtitle:
      activeCount === 0
        ? failed
          ? "Agent work failed"
          : "Agent work completed"
        : attentionCount > 0
          ? `${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`
          : `${activeCount} active ${activeCount === 1 ? "session" : "sessions"}`,
    updatedAt: Math.max(...visible.map((state) => state.updatedAt)),
    rows: visible.slice(0, MAX_AGGREGATE_ROWS).map(rowForState),
  };
}

export function aggregateFingerprint(aggregate: ActivityAggregate | null): string {
  // Convex reorders object keys on persistence. Fingerprints must survive that round trip.
  return JSON.stringify(aggregate, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      : value,
  );
}

export function alertForTransition(
  previous: SessionState | null,
  next: SessionState,
  preferences: NotificationPreferences,
): ActivityAlert | null {
  // A first publication has no transition to alert for; it still carries eligibility to delivery.
  if (!previous || previous.phase === next.phase || next.alertEligible === false) return null;

  switch (next.phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval
        ? { title: next.title, body: `Approval needed on ${next.publisherLabel}` }
        : null;
    case "waiting_for_input":
      return preferences.notifyOnInput
        ? { title: next.title, body: `Input needed on ${next.publisherLabel}` }
        : null;
    case "completed":
      return preferences.notifyOnCompletion
        ? { title: next.title, body: `Completed on ${next.publisherLabel}` }
        : null;
    case "failed":
      return preferences.notifyOnFailure
        ? { title: next.title, body: `Failed on ${next.publisherLabel}` }
        : null;
    default:
      return null;
  }
}

export function shouldUpdateAggregate(
  previous: ActivityAggregate | null,
  next: ActivityAggregate,
  lastDeliveryAt: number | null,
  now: number,
): boolean {
  if (previous === null) return true;
  if (aggregateFingerprint(previous) === aggregateFingerprint(next)) {
    if (next.activeCount === 0 && lastDeliveryAt !== null) return false;
    return lastDeliveryAt === null || now - lastDeliveryAt >= 120_000;
  }
  if (previous.activeCount !== next.activeCount) return true;
  if (next.rows.some((row) => row.phase.startsWith("waiting_for_"))) return true;
  if (next.rows.some((row) => isTerminalPhase(row.phase))) return true;
  return lastDeliveryAt === null || now - lastDeliveryAt >= 15_000;
}
