import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { makeAggregate } from "./lib/aggregate";
import { subjectHash, verifyAppleIdentityToken } from "./lib/appleIdentity";
import {
  base64UrlToBytes,
  randomToken,
  sha256,
  verifyPublisherSignature,
} from "./lib/crypto";
import {
  defaultNotificationPreferences,
  isSessionPhase,
  type ActivityMode,
  type ApsEnvironment,
  type NotificationPreferences,
  type PublishedSessionState,
} from "./lib/model";

const http = httpRouter();
const jsonHeaders = { "content-type": "application/json" };
const maximumBodyCharacters = 512 * 1_024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > maximumBodyCharacters) return null;
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function stringField(
  object: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string | null {
  const value = object[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : null;
}

function optionalStringField(
  object: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string | undefined | null {
  if (!(key in object) || object[key] === null) return undefined;
  return stringField(object, key, maximumLength);
}

function numberField(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && value.length <= 512;
}

function httpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() || null : null;
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}

function pathParts(request: Request): string[] {
  try {
    return requestPath(request)
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

function parsePreferences(value: unknown): NotificationPreferences | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(defaultNotificationPreferences) as (keyof NotificationPreferences)[];
  if (keys.some((key) => typeof value[key] !== "boolean")) return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as NotificationPreferences;
}

async function authenticateUser(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  request: Request,
): Promise<{ userId: string; sessionId: string } | null> {
  const credential = bearer(request);
  if (!credential) return null;
  return await ctx.runQuery(internal.auth.getSession, {
    tokenHash: await sha256(credential),
    now: Date.now(),
  });
}

async function authenticatePublisher(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  request: Request,
  rawBody: string,
  publisherId: string,
): Promise<
  | { userId: string; keyId: string; nonce: string; nonceExpiresAt: number; receivedAt: number }
  | null
> {
  const keyId = request.headers.get("x-talaria-key-id")?.trim();
  const nonce = request.headers.get("x-talaria-nonce")?.trim();
  const timestamp = request.headers.get("x-talaria-timestamp")?.trim();
  const signature = request.headers.get("x-talaria-signature")?.trim();
  if (!keyId || !nonce || !timestamp || !signature || nonce.length > 128) return null;
  const timestampSeconds = Number(timestamp);
  const receivedAt = Date.now();
  if (!Number.isInteger(timestampSeconds) || Math.abs(receivedAt / 1_000 - timestampSeconds) > 5 * 60) {
    return null;
  }
  const key = await ctx.runQuery(internal.pairing.getPublisherKey, { publisherId, keyId });
  if (!key?.enabled || key.revokedAt !== undefined) return null;
  try {
    const valid = await verifyPublisherSignature({
      publicKey: key.publicKey,
      signature,
      method: request.method,
      path: requestPath(request),
      timestamp,
      nonce,
      body: rawBody,
    });
    return valid
      ? { userId: key.userId, keyId, nonce, nonceExpiresAt: receivedAt + 10 * 60 * 1_000, receivedAt }
      : null;
  } catch {
    return null;
  }
}

function parseState(
  value: unknown,
  envelope?: { eventId: string; revision: number },
): PublishedSessionState | null {
  if (!isRecord(value)) return null;
  const sessionId = stringField(value, "sessionId", 191);
  const streamId = optionalStringField(value, "streamId", 191);
  const eventId = stringField(value, "eventId", 191) ?? envelope?.eventId ?? null;
  const revision = numberField(value, "revision") ?? envelope?.revision ?? null;
  const title = stringField(value, "title", 120);
  const phase = value.phase;
  const updatedAt = numberField(value, "updatedAt");
  const deepLink = stringField(value, "deepLink", 512);
  if (
    !sessionId ||
    streamId === null ||
    !eventId ||
    revision === null ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !title ||
    !isSessionPhase(phase) ||
    updatedAt === null ||
    !deepLink ||
    !safePath(deepLink)
  ) {
    return null;
  }
  return {
    sessionId,
    streamId,
    eventId,
    revision,
    title,
    phase,
    updatedAt,
    deepLink,
  };
}

http.route({
  path: "/v1/auth/apple",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request);
    if (!body) return json(400, { error: "invalid_json" });
    const identityToken = stringField(body, "identityToken", 16_384);
    const nonce = stringField(body, "nonce", 256);
    const subjectSecret = process.env.APPLE_SUBJECT_HASH_KEY?.trim();
    if (!identityToken || !nonce) return json(400, { error: "invalid_apple_credential" });
    if (!subjectSecret) return json(503, { error: "apple_auth_not_configured" });

    try {
      const response = await fetch("https://appleid.apple.com/auth/keys");
      if (!response.ok) return json(503, { error: "apple_keys_unavailable" });
      const keySet = await response.json() as { keys?: JsonWebKey[] };
      const audiences = (process.env.APPLE_CLIENT_IDS ?? "dev.kil.talaria,dev.kil.talaria.branch")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const now = Date.now();
      const claims = await verifyAppleIdentityToken({
        token: identityToken,
        nonce,
        audiences,
        nowSeconds: Math.floor(now / 1_000),
        keys: keySet.keys ?? [],
      });
      if (!claims) return json(401, { error: "invalid_apple_credential" });

      const sessionToken = randomToken(32);
      const sessionExpiresAt = now + 30 * 24 * 60 * 60 * 1_000;
      const result = await ctx.runMutation(internal.auth.acceptAppleSignIn, {
        appleSubjectHash: await subjectHash(subjectSecret, claims.sub),
        appleTokenHash: await sha256(identityToken),
        appleTokenExpiresAt: claims.exp * 1_000,
        userId: `usr_${randomToken(12)}`,
        sessionId: `ses_${randomToken(12)}`,
        sessionTokenHash: await sha256(sessionToken),
        sessionExpiresAt,
        now,
      });
      return result.ok
        ? json(201, { userId: result.userId, sessionToken, expiresAt: sessionExpiresAt })
        : json(409, { error: result.reason });
    } catch {
      return json(503, { error: "apple_auth_unavailable" });
    }
  }),
});

http.route({
  path: "/v1/pairings/publisher",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticateUser(ctx, request);
    if (!auth) return json(401, { error: "unauthorized" });
    const token = randomToken(32);
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1_000;
    const result = await ctx.runMutation(internal.pairing.createPublisherInvitation, {
      userId: auth.userId,
      tokenHash: await sha256(token),
      expiresAt,
      now,
    });
    return result.ok ? json(201, { invitation: token, expiresAt }) : json(401, { error: "unauthorized" });
  }),
});

http.route({
  path: "/v1/pairings/publisher/redeem",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await readJson(request);
    if (!body) return json(400, { error: "invalid_json" });
    const invitation = stringField(body, "invitation", 256);
    const publisherId = stringField(body, "publisherId", 191);
    const label = stringField(body, "label", 80);
    const publicKey = stringField(body, "publicKey", 128);
    if (!invitation || !publisherId || !httpOrigin(publisherId) || !label || !publicKey) {
      return json(400, { error: "invalid_pairing" });
    }
    try {
      if (base64UrlToBytes(publicKey).byteLength !== 32) {
        return json(400, { error: "invalid_public_key" });
      }
    } catch {
      return json(400, { error: "invalid_public_key" });
    }
    const result = await ctx.runMutation(internal.pairing.redeemPublisherInvitation, {
      tokenHash: await sha256(invitation),
      publisherId,
      keyId: `key_${randomToken(8)}`,
      label,
      publicKey,
      now: Date.now(),
    });
    return result.ok ? json(201, result) : json(400, { error: result.reason });
  }),
});

http.route({
  pathPrefix: "/v1/publishers/",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    const parts = pathParts(request);
    const publisherId = parts[2];
    if (!publisherId) return json(404, { error: "not_found" });
    const rawBody = await request.text();
    if (rawBody.length > maximumBodyCharacters) return json(413, { error: "body_too_large" });
    const auth = await authenticatePublisher(ctx, request, rawBody, publisherId);
    if (!auth) return json(401, { error: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!isRecord(parsed)) throw new Error("invalid");
      body = parsed;
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (parts.length === 6 && parts[3] === "sessions" && parts[5] === "activity") {
      const sessionId = parts[4];
      const eventId = stringField(body, "eventId", 191);
      const revision = numberField(body, "revision");
      const state =
        body.state === null || !eventId || revision === null
          ? null
          : parseState(body.state, { eventId, revision });
      if (!sessionId || !eventId || revision === null || !Number.isSafeInteger(revision) || state === null && body.state !== null) {
        return json(400, { error: "invalid_state" });
      }
      if (state && state.sessionId !== sessionId) return json(400, { error: "session_mismatch" });
      const result = await ctx.runMutation(internal.publishers.acceptState, {
        publisherId,
        ...auth,
        sessionId,
        eventId,
        revision,
        state: state
          ? {
              sessionId: state.sessionId,
              streamId: state.streamId,
              title: state.title,
              phase: state.phase,
              updatedAt: state.updatedAt,
              deepLink: state.deepLink,
            }
          : null,
      });
      const status = result.status === "accepted" || result.status === "duplicate" ? 200 : 409;
      return json(status, result);
    }

    if (parts.length === 4 && parts[3] === "snapshot") {
      const snapshotId = stringField(body, "snapshotId", 191);
      const rawStates = body.states;
      if (!snapshotId || !Array.isArray(rawStates) || rawStates.length > 500) {
        return json(400, { error: "invalid_snapshot" });
      }
      const states = rawStates.map((state) => parseState(state));
      if (states.some((state) => state === null)) return json(400, { error: "invalid_snapshot" });
      const result = await ctx.runMutation(internal.publishers.acceptSnapshot, {
        publisherId,
        ...auth,
        snapshotId,
        states: states as Exclude<(typeof states)[number], null>[],
      });
      const status = result.status === "accepted" ? 200 : 409;
      return json(status, result);
    }

    return json(404, { error: "not_found" });
  }),
});

http.route({
  path: "/v1/auth/session",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const credential = bearer(request);
    if (!credential) return json(401, { error: "unauthorized" });
    const result = await ctx.runMutation(internal.auth.revokeSession, {
      tokenHash: await sha256(credential),
      now: Date.now(),
    });
    return json(result.ok ? 200 : 404, result);
  }),
});

http.route({
  pathPrefix: "/v1/devices/",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    const parts = pathParts(request);
    const deviceId = parts[2];
    if (!deviceId) return json(404, { error: "not_found" });
    const auth = await authenticateUser(ctx, request);
    if (!auth) return json(401, { error: "unauthorized" });
    const body = await readJson(request);
    if (!body) return json(400, { error: "invalid_json" });

    if (parts.length === 3) {
      const label = stringField(body, "label", 80);
      const bundleId = stringField(body, "bundleId", 255);
      const apsEnvironment = body.apsEnvironment;
      const pushToken = body.pushToken === null
        ? undefined
        : optionalStringField(body, "pushToken", 512);
      const clearPushToken = body.pushToken === null;
      const preferences = parsePreferences(body.preferences);
      if (
        !label ||
        !bundleId ||
        !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(bundleId) ||
        (apsEnvironment !== "sandbox" && apsEnvironment !== "production") ||
        pushToken === null ||
        !preferences
      ) {
        return json(400, { error: "invalid_device" });
      }
      const result = await ctx.runMutation(internal.devices.upsertDevice, {
        userId: auth.userId,
        deviceId,
        label,
        bundleId,
        apsEnvironment: apsEnvironment as ApsEnvironment,
        pushToken,
        clearPushToken,
        preferences,
        now: Date.now(),
      });
      return result.ok ? json(200, result) : json(401, { error: "unauthorized" });
    }

    if (parts.length === 5 && parts[3] === "live-activities") {
      const activityId = parts[4];
      const mode = body.mode;
      const publisherId = optionalStringField(body, "publisherId", 191);
      const sessionId = optionalStringField(body, "sessionId", 191);
      const attributesType = stringField(body, "attributesType", 120);
      const schemaVersion = numberField(body, "schemaVersion");
      const activityPushToken = stringField(body, "activityPushToken", 512);
      if (
        !activityId ||
        (mode !== "per_session" && mode !== "all_running") ||
        publisherId === null ||
        sessionId === null ||
        !attributesType ||
        schemaVersion === null ||
        !Number.isSafeInteger(schemaVersion) ||
        !activityPushToken
      ) {
        return json(400, { error: "invalid_activity" });
      }
      const result = await ctx.runMutation(internal.devices.registerActivity, {
        userId: auth.userId,
        deviceId,
        activityId,
        mode: mode as ActivityMode,
        publisherId,
        sessionId,
        attributesType,
        schemaVersion,
        activityPushToken,
        now: Date.now(),
      });
      return result.ok ? json(200, result) : json(400, { error: result.reason });
    }

    return json(404, { error: "not_found" });
  }),
});

http.route({
  pathPrefix: "/v1/devices/",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const parts = pathParts(request);
    const deviceId = parts[2];
    if (!deviceId) return json(404, { error: "not_found" });
    const auth = await authenticateUser(ctx, request);
    if (!auth) return json(401, { error: "unauthorized" });
    if (parts.length === 3) {
      const result = await ctx.runMutation(internal.devices.revokeDevice, {
        userId: auth.userId,
        deviceId,
        now: Date.now(),
      });
      return json(result.ok ? 200 : 404, result);
    }
    if (parts.length === 5 && parts[3] === "live-activities") {
      const result = await ctx.runMutation(internal.devices.endActivity, {
        userId: auth.userId,
        deviceId,
        activityId: parts[4]!,
        now: Date.now(),
      });
      return json(result.ok ? 200 : 404, result);
    }
    return json(404, { error: "not_found" });
  }),
});

http.route({
  path: "/v1/activity-snapshot",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const deviceId = request.headers.get("x-talaria-device-id")?.trim();
    const auth = await authenticateUser(ctx, request);
    if (!deviceId || !auth) {
      return json(401, { error: "unauthorized" });
    }
    const mode = url.searchParams.get("mode");
    const now = Date.now();
    if (mode === "all_running") {
      const states = await ctx.runQuery(internal.publishers.listCurrentStates, {
        userId: auth.userId,
        now,
      });
      return json(200, { aggregate: makeAggregate(states, now) });
    }
    if (mode === "per_session") {
      const publisherId = url.searchParams.get("publisherId");
      const sessionId = url.searchParams.get("sessionId");
      if (!publisherId || !sessionId) return json(400, { error: "session_required" });
      const state = await ctx.runQuery(internal.publishers.getState, {
        userId: auth.userId,
        publisherId,
        sessionId,
      });
      return json(200, { aggregate: state ? makeAggregate([state], now) : null });
    }
    return json(400, { error: "invalid_mode" });
  }),
});

export default http;
