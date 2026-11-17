import type { ActivityAggregate, ActivityAlert, AggregateRow, ApsEnvironment } from "./model";

export interface ApnsRequest {
  token: string;
  topic: string;
  environment: ApsEnvironment;
  pushType: "alert" | "liveactivity";
  priority: "5" | "10";
  payload: Record<string, unknown>;
  // Replaces the delivered alert with the same ID; unset falls back to the per-job ID.
  collapseId?: string;
}

// The standalone notification carries a Time Sensitive alert, so the activity stays silent and the user hears it once.
export function liveActivityAlert(alert: ActivityAlert | null | undefined): ActivityAlert | null {
  return alert && !alert.interruptionLevel ? alert : null;
}

// iOS looks a localized alert's keys up in the App's Localizable strings and shows an unknown key as written.
function liveActivityAlertText(alert: ActivityAlert) {
  return alert.localized
    ? { title: { "loc-key": alert.title }, body: { "loc-key": alert.body } }
    : { title: alert.title, body: alert.body };
}

function notificationAlertText(alert: ActivityAlert) {
  return alert.localized ? { "title-loc-key": alert.title, "loc-key": alert.body } : { title: alert.title, body: alert.body };
}

const maximumContentStateBytes = 3_500;
const liveActivityStaleAfterSeconds = 10 * 60;

// `registeredAt` times an activity only for older publishers that do not send the run's start.
export function nativeSessionRequest(request: ApnsRequest, registeredAt: number): ApnsRequest {
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
  return { ...request, payload: { aps: { ...aps, "content-state": {
    sessionID: row.sessionId, sessionTitle: row.title, status: statuses[row.phase],
    currentActivity: row.status, responseExcerpt: "", startedAt: swiftDate(row.startedAt ?? registeredAt),
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
export function fitActivityAggregate(aggregate: ActivityAggregate): ActivityAggregate {
  const fitted = { ...aggregate, rows: [...aggregate.rows] };
  const fits = () => new TextEncoder().encode(JSON.stringify(fitted)).byteLength <= maximumContentStateBytes;
  for (let index = fitted.rows.length - 1; index > 0 && !fits(); index--) {
    const { currentTool: _dropped, ...row } = fitted.rows[index]!;
    fitted.rows[index] = row;
  }
  while (fitted.rows.length > 0 && !fits()) fitted.rows.pop();
  return fitted;
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
  const aggregate = fitActivityAggregate(input.aggregate);
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: input.alert || requiresImmediateDelivery ? "10" : "5",
    payload: {
      aps: {
        timestamp: input.nowEpochSeconds,
        event: "update",
        "content-state": aggregate,
        "stale-date": input.nowEpochSeconds + liveActivityStaleAfterSeconds,
        ...(alert ? { alert: { ...liveActivityAlertText(alert), sound: "default" } } : {}),
      },
    },
  };
}

export function makeLiveActivityStart(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  aggregate: ActivityAggregate;
  nowEpochSeconds: number;
  alert: ActivityAlert;
}): ApnsRequest {
  const aggregate = fitActivityAggregate(input.aggregate);
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: "10",
    payload: {
      aps: {
        timestamp: input.nowEpochSeconds,
        event: "start",
        "content-state": aggregate,
        "stale-date": input.nowEpochSeconds + liveActivityStaleAfterSeconds,
        "attributes-type": "TalariaAggregateActivityAttributes",
        attributes: {},
        "input-push-token": 1,
        // APNs requires an alert on push-to-start.
        alert: {
          ...liveActivityAlertText(input.alert),
          ...(liveActivityAlert(input.alert) ? { sound: "default" } : {}),
        },
      },
    },
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
  const aggregate = input.aggregate ? fitActivityAggregate(input.aggregate) : null;
  const alert = liveActivityAlert(input.alert);
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: "10",
    payload: {
      aps: {
        timestamp: input.nowEpochSeconds,
        event: "end",
        ...(aggregate ? { "content-state": aggregate } : {}),
        ...(alert ? { alert: { ...liveActivityAlertText(alert), sound: "default" } } : {}),
        "dismissal-date": input.nowEpochSeconds
          + (input.dismissalDelaySeconds ?? (aggregate ? 5 * 60 : 15)),
      },
    },
  };
}

export function makeNotification(input: {
  token: string;
  bundleId: string;
  environment: ApsEnvironment;
  alert: ActivityAlert;
  row: AggregateRow;
  // One ID per chat: groups its alerts and lets the newest replace the previous one.
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
      publisherId: input.row.publisherId,
      sessionId: input.row.sessionId,
      deepLink: input.alert.deepLink ?? input.row.deepLink,
      // TAL-1469: the request the banner's Deny or Reply answers; the App refuses it once another heads the queue.
      ...(input.alert.category && input.alert.headId
        ? { [input.alert.category === "talaria.approval" ? "approvalHeadId" : "inputHeadId"]: input.alert.headId }
        : {}),
    },
  };
}
