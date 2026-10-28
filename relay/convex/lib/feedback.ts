import type { Infer } from "convex/values";

import type { feedbackPayloadValidator } from "./validators";

export type FeedbackPayload = Infer<typeof feedbackPayloadValidator>;

export const maximumFeedbackBytes = 32 * 1_024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Fields = Record<string, unknown>;

function record(value: unknown, keys: readonly string[]): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.keys(value).every((key) => keys.includes(key)) ? value as Fields : null;
}

/** A bounded, non-blank string; `undefined` only for an omitted optional field, `null` when invalid. */
function text(object: Fields, key: string, maximumLength: number, optional = false): string | undefined | null {
  if (!(key in object)) return optional ? undefined : null;
  const value = object[key];
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? value as T : null;
}

/** Exactly the v1 report fields, each bounded: an extra field is rejected rather than ignored. */
export function parseFeedbackReport(value: unknown): FeedbackPayload | null {
  const report = record(value, ["requestId", "installId", "kind", "title", "body", "client", "server", "diagnostics"]);
  const client = report && record(report.client, ["platform", "appVersion", "osVersion", "deviceModel"]);
  const server = report && record(report.server, ["webVersion", "agentVersion"]);
  if (!report || !client || !server) return null;
  const requestId = text(report, "requestId", 36);
  const installId = text(report, "installId", 36);
  const kind = oneOf(report.kind, ["bug", "feature", "other"] as const);
  const title = text(report, "title", 120);
  const body = text(report, "body", 8_000);
  const diagnostics = text(report, "diagnostics", 16_384, true);
  const platform = oneOf(client.platform, ["web", "ios"] as const);
  const appVersion = text(client, "appVersion", 64, true);
  const osVersion = text(client, "osVersion", 64, true);
  const deviceModel = text(client, "deviceModel", 64, true);
  const webVersion = text(server, "webVersion", 64);
  const agentVersion = text(server, "agentVersion", 64, true);
  if (
    !requestId || !uuidPattern.test(requestId) || !installId || !uuidPattern.test(installId) || !kind || !title || !body
    || diagnostics === null || !platform || appVersion === null || osVersion === null || deviceModel === null
    || !webVersion || agentVersion === null
  ) {
    return null;
  }
  return {
    requestId,
    installId,
    kind,
    title,
    body,
    client: {
      platform,
      ...(appVersion === undefined ? {} : { appVersion }),
      ...(osVersion === undefined ? {} : { osVersion }),
      ...(deviceModel === undefined ? {} : { deviceModel }),
    },
    server: { webVersion, ...(agentVersion === undefined ? {} : { agentVersion }) },
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}
