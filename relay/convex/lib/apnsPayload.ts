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
  } } } };
}

export function fitActivityAggregate(aggregate: ActivityAggregate): ActivityAggregate {
  const fitted = { ...aggregate, rows: [...aggregate.rows] };
  while (
    fitted.rows.length > 0 &&
    new TextEncoder().encode(JSON.stringify(fitted)).byteLength > maximumContentStateBytes
  ) {
    fitted.rows.pop();
  }
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
        ...(alert ? { alert: { title: alert.title, body: alert.body, sound: "default" } } : {}),
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
          title: input.alert.title,
          body: input.alert.body,
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
        ...(alert ? { alert: { title: alert.title, body: alert.body, sound: "default" } } : {}),
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
}): ApnsRequest {
  return {
    token: input.token,
    topic: input.bundleId,
    environment: input.environment,
    pushType: "alert",
    priority: "10",
    collapseId: input.threadId,
    payload: {
      aps: {
        alert: { title: input.alert.title, body: input.alert.body },
        sound: "default",
        "thread-id": input.threadId,
        ...(input.alert.interruptionLevel ? { "interruption-level": input.alert.interruptionLevel } : {}),
      },
      publisherId: input.row.publisherId,
      sessionId: input.row.sessionId,
      deepLink: input.row.deepLink,
    },
  };
}
