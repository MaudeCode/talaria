import type { ActivityAggregate, ActivityAlert, AggregateRow, ApsEnvironment } from "./model";

export interface ApnsRequest {
  token: string;
  topic: string;
  environment: ApsEnvironment;
  pushType: "alert" | "liveactivity";
  priority: "5" | "10";
  payload: Record<string, unknown>;
}

const maximumContentStateBytes = 3_500;
const liveActivityStaleAfterSeconds = 10 * 60;

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
  const aggregate = fitActivityAggregate(input.aggregate);
  return {
    token: input.token,
    topic: `${input.bundleId}.push-type.liveactivity`,
    environment: input.environment,
    pushType: "liveactivity",
    priority: input.alert || aggregate.rows.some(
      (row) => row.phase === "waiting_for_approval"
        || row.phase === "waiting_for_input"
        || row.phase === "failed",
    ) ? "10" : "5",
    payload: {
      aps: {
        timestamp: input.nowEpochSeconds,
        event: "update",
        "content-state": aggregate,
        "stale-date": input.nowEpochSeconds + liveActivityStaleAfterSeconds,
        ...(input.alert
          ? { alert: { title: input.alert.title, body: input.alert.body, sound: "default" } }
          : {}),
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
        alert: { title: input.alert.title, body: input.alert.body, sound: "default" },
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
        ...(input.alert
          ? { alert: { title: input.alert.title, body: input.alert.body, sound: "default" } }
          : {}),
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
}): ApnsRequest {
  return {
    token: input.token,
    topic: input.bundleId,
    environment: input.environment,
    pushType: "alert",
    priority: "10",
    payload: {
      aps: {
        alert: { title: input.alert.title, body: input.alert.body },
        sound: "default",
      },
      publisherId: input.row.publisherId,
      sessionId: input.row.sessionId,
      deepLink: input.row.deepLink,
    },
  };
}
