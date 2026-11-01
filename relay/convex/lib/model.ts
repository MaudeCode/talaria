export const sessionPhases = [
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "stale",
] as const;

export type SessionPhase = (typeof sessionPhases)[number];
export type ActivityMode = "per_session" | "all_running";
export type ApsEnvironment = "sandbox" | "production";

export interface SessionState {
  completionId?: string;
  deleted?: boolean;
  publisherId: string;
  publisherLabel: string;
  sessionId: string;
  streamId?: string;
  eventId: string;
  revision: number;
  title: string;
  phase: SessionPhase;
  activityPhase?: SessionPhase;
  startedAt?: number;
  updatedAt: number;
  deepLink: string;
  expiresAt: number;
  activityExpiresAt?: number;
  terminalExpiresAt?: number;
  alertEligible?: boolean;
}

export interface PublishedSessionState {
  sessionId: string;
  streamId?: string;
  eventId: string;
  revision: number;
  title: string;
  phase: SessionPhase;
  activityPhase?: SessionPhase;
  startedAt?: number;
  updatedAt: number;
  deepLink: string;
  alertEligible?: boolean;
}

export interface AggregateRow {
  completionId?: string;
  publisherId: string;
  publisherLabel: string;
  sessionId: string;
  streamId?: string;
  title: string;
  phase: SessionPhase;
  status: string;
  startedAt?: number;
  updatedAt: number;
  deepLink: string;
}

export interface ActivityAggregate {
  isFinal?: boolean;
  isStale?: boolean;
  schemaVersion: 1;
  activeCount: number;
  title: string;
  subtitle: string;
  updatedAt: number;
  rows: AggregateRow[];
}

export interface NotificationPreferences {
  liveActivitiesEnabled: boolean;
  notificationsEnabled: boolean;
  notifyOnApproval: boolean;
  notifyOnInput: boolean;
  notifyOnCompletion: boolean;
  notifyOnFailure: boolean;
}

export interface ActivityAlert {
  title: string;
  body: string;
}

export const defaultNotificationPreferences: NotificationPreferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

export function isSessionPhase(value: unknown): value is SessionPhase {
  return typeof value === "string" && sessionPhases.includes(value as SessionPhase);
}

export function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

export function activityPhase(state: { phase: SessionPhase; activityPhase?: SessionPhase; activityExpiresAt?: number }, now = Date.now()): SessionPhase {
  const phase = state.activityPhase ?? state.phase;
  return state.activityExpiresAt !== undefined && state.activityExpiresAt <= now && !isTerminalPhase(phase) ? "stale" : phase;
}

/** Current activity survives a completed or acknowledged foreground turn; retained history stays separate. */
export function isCurrentActivityState(state: SessionState & { runKey?: string }): boolean {
  return !state.deleted && (!isTerminalPhase(activityPhase(state)) || activityPhase(state) !== state.phase || state.runKey === undefined);
}
