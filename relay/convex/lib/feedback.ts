import type { Infer } from "convex/values";

import type { feedbackAttachmentTypeValidator, feedbackPayloadValidator } from "./validators";

export type FeedbackPayload = Infer<typeof feedbackPayloadValidator>;
export type FeedbackAttachmentType = Infer<typeof feedbackAttachmentTypeValidator>;
type Attachment = NonNullable<FeedbackPayload["attachments"]>[number];

/** Mirrors `contracts/fixtures/feedback-attachment-limits.json`; the bridge enforces `maxVideoSeconds`. */
export const attachmentLimits = {
  maxAttachments: 5,
  maxVideosPerReport: 1,
  maxVideoSeconds: 120,
  types: {
    "image/png": { kind: "image", maxBytes: 10_000_000 },
    "image/jpeg": { kind: "image", maxBytes: 10_000_000 },
    "image/heic": { kind: "image", maxBytes: 10_000_000 },
    "image/webp": { kind: "image", maxBytes: 10_000_000 },
    "video/mp4": { kind: "video", maxBytes: 20_000_000 },
    "video/quicktime": { kind: "video", maxBytes: 20_000_000 },
    "video/webm": { kind: "video", maxBytes: 20_000_000 },
  },
  tierKinds: { verified: ["image", "video"], unverified: [] },
} as const satisfies {
  types: Record<FeedbackAttachmentType, { kind: "image" | "video"; maxBytes: number }>;
  [key: string]: unknown;
};

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
  const report = record(value, ["requestId", "installId", "kind", "title", "body", "client", "server", "diagnostics", "attachments"]);
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
  const attachments = "attachments" in report ? parseAttachments(report.attachments) : undefined;
  if (
    !requestId || !uuidPattern.test(requestId) || !installId || !uuidPattern.test(installId) || !kind || !title || !body
    || diagnostics === null || !platform || appVersion === null || osVersion === null || deviceModel === null
    || !webVersion || agentVersion === null || attachments === null
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
    ...(attachments === undefined ? {} : { attachments }),
  };
}

/** 1–5 entries of exactly `{contentType, bytes, sha256}` within the per-type size, with at most one video. */
function parseAttachments(value: unknown): Attachment[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > attachmentLimits.maxAttachments) return null;
  const parsed: Attachment[] = [];
  for (const item of value) {
    const entry = record(item, ["contentType", "bytes", "sha256"]);
    const contentType = entry && oneOf(entry.contentType, Object.keys(attachmentLimits.types) as FeedbackAttachmentType[]);
    if (!entry || !contentType) return null;
    const { bytes, sha256 } = entry;
    if (
      typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1
      || bytes > attachmentLimits.types[contentType].maxBytes
      || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)
    ) {
      return null;
    }
    parsed.push({ contentType, bytes, sha256 });
  }
  const videos = parsed.filter((entry) => attachmentLimits.types[entry.contentType].kind === "video").length;
  return videos <= attachmentLimits.maxVideosPerReport ? parsed : null;
}

const ftypBrands: Partial<Record<FeedbackAttachmentType, readonly string[]>> = {
  "image/heic": ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"],
  "video/mp4": ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash"],
  "video/quicktime": ["qt  "],
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

/** Whether the leading bytes are the declared container: a mismatch, such as HTML sent as PNG, is refused. */
export function matchesAttachmentType(bytes: Uint8Array, contentType: FeedbackAttachmentType): boolean {
  switch (contentType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      // ISO base media: an `ftyp` box whose major brand belongs to the declared type.
      return startsWith(bytes, ascii("ftyp"), 4) && bytes.length >= 12
        && (ftypBrands[contentType] ?? []).includes(String.fromCharCode(...bytes.subarray(8, 12)));
  }
}
