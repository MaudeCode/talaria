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

// TAL-873: who started a published turn; a publisher that omits it started every turn for the user.
export type TurnOrigin = "user" | "background";

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
  /** TAL-874: tool calls the run started, counted by the publisher. */
  toolCount?: number;
  /** TAL-874: the run's last phase change or tool event, in epoch milliseconds. */
  activityAt?: number;
  /** TAL-2336: the call the run's Live Activity names: its latest running call, else its last finished one. */
  currentTool?: ActivityTool;
  /** TAL-1422: the run's plan, completed items of all but cancelled ones; 0 of 0 while it has none open. */
  planCompleted?: number;
  planTotal?: number;
  /** TAL-1422: the session's running workers (subagents, processes, `/background` tasks); 0 clears the count. */
  workerCount?: number;
  deepLink: string;
  expiresAt: number;
  activityExpiresAt?: number;
  terminalExpiresAt?: number;
  origin?: TurnOrigin;
  alertEligible?: boolean;
  approvalHeadId?: string;
  /** TAL-1469: the question queue head while the session waits for input, an opaque digest like `approvalHeadId`. */
  inputHeadId?: string;
  decisionReviewId?: string;
  decisionReviewTitle?: string;
  agentNotices?: AgentNotify[];
}

/**
 * TAL-2336: the call a Live Activity names, with its transcript row's display fields, each string at most 64 characters:
 * its server display `kind`, `target`, whether it finished (`done`) or failed (`failed`), a `verb` and `app` for kinds that carry one, and its
 * `outcome`. The App words and draws it; Relay only bounds and copies it.
 */
export interface ActivityTool {
  kind: string;
  target: string;
  done: boolean;
  failed?: boolean;
  verb?: string;
  app?: { name: string };
  outcome?: { key: string; tone: "neutral" | "error" | "attention"; count?: number; value?: string };
}

/** TAL-1970: an agent notice the session carries; one the stored state did not hold alerts once. */
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
  startedAt: number;
  updatedAt: number;
  toolCount?: number;
  activityAt?: number;
  currentTool?: ActivityTool;
  planCompleted?: number;
  planTotal?: number;
  workerCount?: number;
  deepLink: string;
  origin?: TurnOrigin;
  alertEligible?: boolean;
  approvalHeadId?: string;
  /** TAL-1469: the question queue head while the session waits for input, an opaque digest like `approvalHeadId`. */
  inputHeadId?: string;
  decisionReviewId?: string;
  decisionReviewTitle?: string;
  agentNotices?: AgentNotify[];
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
  toolCount?: number;
  activityAt?: number;
  currentTool?: ActivityTool;
  planCompleted?: number;
  planTotal?: number;
  workerCount?: number;
  deepLink: string;
  /** TAL-1463: the approval this row waits on, so the App answers only the approval the activity shows. */
  approvalHeadId?: string;
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
  // Older registrations omit this field and keep the default APNs sound.
  notificationSoundEnabled?: boolean;
  notifyOnApproval: boolean;
  notifyOnInput: boolean;
  notifyOnCompletion: boolean;
  notifyOnFailure: boolean;
  // TAL-873: completion alerts for background turns; absent means off.
  notifyOnBackground?: boolean;
  // TAL-2665: an owner's alert that a Talaria Web or Hermes Agent update is available; absent means off.
  notifyOnUpdateAvailable?: boolean;
}

export interface ActivityAlert {
  title: string;
  // A keyed body is formatted by iOS using the App's Localizable strings.
  body: string | { key: string; args: string[] };
  // Time Sensitive alerts break through Focus. Any alert with a level arrives as a standalone notification wherever the
  // device can receive one, never only on a Live Activity.
  interruptionLevel?: "time-sensitive" | "active";
  // TAL-1966: where the notification opens when it is not the session's own deep link.
  deepLink?: string;
  // TAL-1970: the agent notice this alert announces; it is queued once per notice and device.
  agentNotifyId?: string;
  // TAL-1469: the App's notification category whose banner actions answer the request the alert names by its queue head
  // (`headId`): Deny for an approval (the alert never shows what it runs, so it offers no Allow), Reply for a question.
  category?: "talaria.approval" | "talaria.input";
  headId?: string;
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
