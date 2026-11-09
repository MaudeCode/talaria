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
  approvalHeadId?: string;
  decisionReviewId?: string;
  decisionReviewTitle?: string;
  agentNotify?: AgentNotify;
}

/** TAL-1970: the session's newest agent notice; one the stored state did not hold alerts once. */
export interface AgentNotify {
  id: string;
  title: string;
  body: string;
  level: "info" | "attention";
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
  approvalHeadId?: string;
  decisionReviewId?: string;
  decisionReviewTitle?: string;
  agentNotify?: AgentNotify;
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
  // `title` and `body` are keys in the App's Localizable strings, so the phone shows them in its own language.
  localized?: true;
  // Time Sensitive alerts break through Focus. Any alert with a level arrives as a standalone notification wherever the
  // device can receive one, never only on a Live Activity.
  interruptionLevel?: "time-sensitive" | "active";
  // TAL-1966: where the notification opens when it is not the session's own deep link.
  deepLink?: string;
  // TAL-1970: the agent notice this alert announces; it is queued once per notice and device.
  agentNotifyId?: string;
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
