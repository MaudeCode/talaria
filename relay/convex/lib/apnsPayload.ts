import type { ActivityAggregate, ActivityAlert, AggregateRow, ApsEnvironment } from "./model";

export interface ApnsRequest {
  token: string;
  topic: string;
  environment: ApsEnvironment;
  pushType: "alert" | "liveactivity" | "background";
  priority: "5" | "10";
  payload: Record<string, unknown>;
  // Replaces the delivered alert with the same ID; unset falls back to the per-job ID.
  collapseId?: string;
}

export function withBadge(payload: Record<string, unknown>, badge: number): Record<string, unknown> {
  const aps = payload.aps as Record<string, unknown> | undefined;
  return { ...payload, aps: { ...aps, badge } };
}

export function makeBadgePush(input: { token: string; bundleId: string; environment: ApsEnvironment; badge: number }): ApnsRequest {
  return {
    token: input.token,
    topic: input.bundleId,
    environment: input.environment,
    // APNs uses the alert push type for icon badges, even without a banner or sound.
    pushType: "alert",
    priority: "10",
    collapseId: "talaria.waiting-badge",
    payload: withBadge({}, input.badge),
  };
}

// The standalone notification carries a Time Sensitive alert, so the activity stays silent and the user hears it once.
export function liveActivityAlert(alert: ActivityAlert | null | undefined): ActivityAlert | null {
  return alert && !alert.interruptionLevel ? alert : null;
}

function localizedBody(body: Exclude<ActivityAlert["body"], string>) {
  return { "loc-key": body.key, "loc-args": body.args };
}

function liveActivityAlertText({ title, body }: ActivityAlert) {
  return { title, body: typeof body === "string" ? body : localizedBody(body) };
}

function notificationAlertText({ title, body }: ActivityAlert) {
  return { title, ...(typeof body === "string" ? { body } : localizedBody(body)) };
}

export function omitApnsSound(payloadJson: string, pushType: ApnsRequest["pushType"]): string {
  if (pushType === "background") return payloadJson;
  const payload = JSON.parse(payloadJson) as { aps: { sound?: string; alert?: { sound?: string } } };
  // APNs puts standalone notification sound in aps and Live Activity sound inside the alert.
  const soundContainer = pushType === "alert" ? payload.aps : payload.aps.alert;
  if (soundContainer?.sound === undefined) return payloadJson;
  delete soundContainer.sound;
  return JSON.stringify(payload);
}

const maximumApnsPayloadBytes = 4_096;
const maximumContentStateBytes = 3_500;
const liveActivityStaleAfterSeconds = 10 * 60;

export function nativeSessionRequest(request: ApnsRequest): ApnsRequest {
  const aps = request.payload.aps as Record<string, unknown>;
  const aggregate = aps["content-state"] as ActivityAggregate | undefined;
  const row = aggregate?.rows[0];
  if (!row) return request;
  const terminal = ["completed", "failed", "cancelled"].includes(row.phase);
  const statuses: Record<string, string> = {
    starting: "starting", running: "thinking", waiting_for_approval: "waitingForApproval",
    waiting_for_input: "waitingForClarification", completed: "complete", failed: "failed",
    cancelled: "cancelled", stale: "thinking",
  };
  // Swift's default Codable Date representation is seconds since 2001-01-01.
  const swiftDate = (milliseconds: number) => milliseconds / 1_000 - 978_307_200;
  // TAL-1666: only a state stored before publishers had to send the run's start lacks it, until that state expires.
  return { ...request, payload: { aps: { ...aps, "content-state": {
    sessionID: row.sessionId, sessionTitle: row.title, status: statuses[row.phase],
    currentActivity: row.status, responseExcerpt: "", startedAt: swiftDate(row.startedAt ?? row.updatedAt),
    updatedAt: swiftDate(row.updatedAt), isStale: row.phase === "stale", isFinal: terminal,
    ...(row.toolCount === undefined ? {} : { toolCount: row.toolCount }),
    ...(row.activityAt === undefined ? {} : { activityAt: swiftDate(row.activityAt) }),
    ...(row.currentTool ? { currentTool: row.currentTool } : {}),
    ...(row.planTotal === undefined ? {} : { planCompleted: row.planCompleted ?? 0, planTotal: row.planTotal }),
    ...(row.workerCount === undefined ? {} : { workerCount: row.workerCount }),
    ...(row.approvalHeadId ? { approvalHeadID: row.approvalHeadId } : {}),
  } } } };
}

// TAL-2336: a row outweighs its current call, so the last row's call goes before any row does; the first row, which a
// per-session activity shows, keeps its call longest.
function fitActivityAggregate(aggregate: ActivityAggregate, maximumBytes: number): ActivityAggregate {
  const fitted = { ...aggregate, rows: [...aggregate.rows] };
  const fits = () => new TextEncoder().encode(JSON.stringify(fitted)).byteLength <= maximumBytes;
  for (let index = fitted.rows.length - 1; index > 0 && !fits(); index--) {
    const { currentTool: _dropped, ...row } = fitted.rows[index]!;
    fitted.rows[index] = row;
  }
  while (fitted.rows.length > 0 && !fits()) fitted.rows.pop();
  return fitted;
}

function liveActivityPayload(aps: Record<string, unknown>, aggregate: ActivityAggregate | null) {
  if (!aggregate) return { aps };
  // Count the envelope and alert in UTF-8, excluding the four bytes the aggregate replaces.
  const empty = { aps: { ...aps, "content-state": null } };
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength - 4;
  const budget = Math.min(maximumContentStateBytes, maximumApnsPayloadBytes - overhead);
  return { aps: { ...aps, "content-state": fitActivityAggregate(aggregate, budget) } };
}

export function makeLiveActivityUpdate(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  aggregate: ActivityAggregate;
  nowEpochSeconds: number;
  alert?: ActivityAlert | null;
}): ApnsRequest {
  const alert = liveActivityAlert(input.alert);
  const requiresImmediateDelivery = input.aggregate.activeCount === 0 || input.aggregate.rows.some(
    (row) => row.phase === "waiting_for_approval"
      || row.phase === "waiting_for_input"
      || row.phase === "failed",
  );
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: input.alert || requiresImmediateDelivery ? "10" : "5",
    payload: liveActivityPayload({
      timestamp: input.nowEpochSeconds,
      event: "update",
      "stale-date": input.nowEpochSeconds + liveActivityStaleAfterSeconds,
      ...(alert ? { alert: { ...liveActivityAlertText(alert), sound: "default" } } : {}),
    }, input.aggregate),
  };
}

export function makeLiveActivityStart(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  aggregate: ActivityAggregate;
  nowEpochSeconds: number;
  alert: ActivityAlert | null;
}): ApnsRequest {
  // Delivery starts only nonempty aggregates. Its first visible row supplies the server for the mandatory alert.
  const alert = input.alert ?? {
    title: input.aggregate.title,
    body: { key: "Work in progress on %@", args: [input.aggregate.rows[0]!.publisherLabel] },
  };
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: "10",
    payload: liveActivityPayload({
      timestamp: input.nowEpochSeconds,
      event: "start",
      "stale-date": input.nowEpochSeconds + liveActivityStaleAfterSeconds,
      "attributes-type": "TalariaAggregateActivityAttributes",
      attributes: {},
      "input-push-token": 1,
      // APNs requires an alert on push-to-start.
      alert: {
        ...liveActivityAlertText(alert),
        ...(liveActivityAlert(alert) ? { sound: "default" } : {}),
      },
    }, input.aggregate),
  };
}

export function makeLiveActivityEnd(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  aggregate: ActivityAggregate | null;
  nowEpochSeconds: number;
  dismissalDelaySeconds?: number;
  alert?: ActivityAlert | null;
}): ApnsRequest {
  const alert = liveActivityAlert(input.alert);
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: "10",
    payload: liveActivityPayload({
      timestamp: input.nowEpochSeconds,
      event: "end",
      ...(alert ? { alert: { ...liveActivityAlertText(alert), sound: "default" } } : {}),
      "dismissal-date": input.nowEpochSeconds
        + (input.dismissalDelaySeconds ?? (input.aggregate ? 5 * 60 : 15)),
    }, input.aggregate),
  };
}

export function makeNotification(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  alert: ActivityAlert;
  // Chat alerts carry a session, server notices carry a publisher, and device tests omit the row.
  row?: Pick<AggregateRow, "publisherId" | "deepLink"> & Partial<AggregateRow>;
  // Groups related alerts and replaces the previous one unless a separate collapse ID is supplied.
  threadId: string;
  // TAL-1970: an alert that must never replace or be replaced by the chat's others collapses under its own ID.
  collapseId?: string;
}): ApnsRequest {
  return {
    token: input.token,
    topic: input.bundleId,
    environment: input.environment,
    pushType: "alert",
    priority: "10",
    collapseId: input.collapseId ?? input.threadId,
    payload: {
      aps: {
        alert: notificationAlertText(input.alert),
        sound: "default",
        "thread-id": input.threadId,
        ...(input.alert.interruptionLevel ? { "interruption-level": input.alert.interruptionLevel } : {}),
        ...(input.alert.category ? { category: input.alert.category } : {}),
      },
      publisherId: input.row?.publisherId,
      sessionId: input.row?.sessionId,
      deepLink: input.alert.deepLink ?? input.row?.deepLink,
      // TAL-1469: the request the banner's Deny or Reply answers; the App refuses it once another heads the queue.
      ...(input.alert.category && input.alert.headId
        ? { [input.alert.category === "talaria.approval" ? "approvalHeadId" : "inputHeadId"]: input.alert.headId }
        : {}),
    },
  };
}

// TAL-232: a silent background push that tells the App a session started, so it refreshes Chats before its next poll.
// It carries only the IDs the refresh needs; APNs requires priority 5 for a background push.
export function makeSessionStartedPush(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  publisherId: string;
  sessionId: string;
}): ApnsRequest {
  return {
    token: input.token,
    topic: input.bundleId,
    environment: input.environment,
    pushType: "background",
    priority: "5",
    payload: { aps: { "content-available": 1 }, event: "session_started", publisherId: input.publisherId, sessionId: input.sessionId },
  };
}
