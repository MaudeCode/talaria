import { httpRouter } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import releaseInfo from "./releaseInfo.json";
import { makeAggregate } from "./lib/aggregate";
import {
  appleIdentityKeyId,
  subjectHash,
  verifyAppleIdentityToken,
} from "./lib/appleIdentity";
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
let appleKeyCache: { keys: JsonWebKey[]; expiresAt: number } | undefined;
let appleAuthWindow = { startedAt: 0, attempts: 0 };

function allowAppleAuthAttempt(now: number): boolean {
  if (now - appleAuthWindow.startedAt >= 60_000) {
    appleAuthWindow = { startedAt: now, attempts: 0 };
  }
  appleAuthWindow.attempts += 1;
  return appleAuthWindow.attempts <= 60;
}

type HttpActionCtx = Parameters<Parameters<typeof httpAction>[0]>[0];

function parsedAppleKeys(value: string): JsonWebKey[] | null {
  try {
    const keys = JSON.parse(value) as unknown;
    if (!Array.isArray(keys)) return null;
    const rsa = keys.filter(
      (key): key is JsonWebKey =>
        typeof key === "object" && key !== null && (key as JsonWebKey).kty === "RSA",
    );
    return rsa.length > 0 ? rsa : null;
  } catch {
    return null;
  }
}

async function appleKeys(ctx: HttpActionCtx, now: number): Promise<JsonWebKey[] | null> {
  if (appleKeyCache && appleKeyCache.expiresAt > now) return appleKeyCache.keys;
  const claim = await ctx.runMutation(internal.auth.claimAppleJwks, { now });
  if (claim.status === "cached") {
    const keys = parsedAppleKeys(claim.keysJson);
    if (!keys) return null;
    appleKeyCache = { keys, expiresAt: claim.expiresAt };
    return keys;
  }
  if (claim.status === "wait") return null;
  const response = await fetch("https://appleid.apple.com/auth/keys");
  if (!response.ok) return null;
  const keySet = await response.json() as { keys?: unknown };
  if (!Array.isArray(keySet.keys)) return null;
  const keys = keySet.keys.filter(
    (key): key is JsonWebKey =>
      typeof key === "object" && key !== null && (key as JsonWebKey).kty === "RSA",
  );
  if (keys.length === 0) return null;
  const expiresAt = now + 60 * 60 * 1_000;
  await ctx.runMutation(internal.auth.saveAppleJwks, {
    keysJson: JSON.stringify(keys),
    expiresAt,
    now,
  });
  appleKeyCache = { keys, expiresAt };
  return keys;
}

http.route({
  path: "/v1/health",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const now = Date.now();
    const [keys, apns, delivery] = await Promise.all([
      appleKeys(ctx, now),
      ctx.runAction(internal.apns.preflight, {}),
      ctx.runQuery(internal.delivery.healthSummary, { since: now - 24 * 60 * 60 * 1_000 }),
    ]);
    const authConfigured = (process.env.APPLE_SUBJECT_HASH_KEY?.trim().length ?? 0) >= 32;
    const audiences = (process.env.APPLE_CLIENT_IDS ?? "dev.kil.talaria,dev.kil.talaria.branch")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const ok = Boolean(keys?.some((key) => key.kty === "RSA" && key.alg === "RS256"))
      && authConfigured
      && audiences.length > 0
      && apns.ok;
    return json(ok ? 200 : 503, {
      ok,
      release: releaseInfo,
      appleKeys: Boolean(keys?.length),
      appleAuth: authConfigured && audiences.length > 0,
      apns: apns.ok,
      recentPermanentDeliveryFailure: delivery.recentPermanentFailure,
    });
  }),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function mutationResponse(
  result: { ok: boolean; reason?: string },
  failureStatus: number,
  fallbackError: string,
): Response {
  return result.ok ? json(200, result) : json(failureStatus, { error: result.reason ?? fallbackError });
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

function canonicalHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function talariaBundleId(bundleId: string, environment: unknown): string | null {
  if (
    (bundleId === "dev.kil.talaria" || bundleId === "dev.kil.talaria.branch") &&
    (environment === "sandbox" || environment === "production")
  ) {
    return bundleId;
  }
  return null;
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
): Promise<{ userId: string; sessionId: string; expiresAt: number } | null> {
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
  | { publisherOwnerUserId: string; keyId: string; nonce: string; nonceExpiresAt: number; receivedAt: number }
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
      ? {
          publisherOwnerUserId: key.ownerUserId,
          keyId,
          nonce,
          nonceExpiresAt: receivedAt + 10 * 60 * 1_000,
          receivedAt,
        }
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
  const alertEligible = value.alertEligible;
  if (
    (alertEligible !== undefined && typeof alertEligible !== "boolean") ||
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
    alertEligible,
  };
}

const sessionStartedKeys = ["eventId", "profileId", "publisherId", "sessionId", "startedAt", "version"];

// Exactly the v1 fields, each bounded: an extra field is rejected rather than ignored.
function parseSessionStarted(value: Record<string, unknown>) {
  if (Object.keys(value).sort().join() !== sessionStartedKeys.join() || value.version !== 1) return null;
  const eventId = stringField(value, "eventId", 200);
  const publisherId = canonicalHttpOrigin(stringField(value, "publisherId", 191) ?? "");
  const profileId = stringField(value, "profileId", 128);
  const sessionId = stringField(value, "sessionId", 191);
  const startedAt = numberField(value, "startedAt");
  if (!eventId || !publisherId || !profileId || !sessionId || startedAt === null || !Number.isSafeInteger(startedAt) || startedAt < 0) {
    return null;
  }
  return { eventId, publisherId, profileId, sessionId, startedAt };
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
    if (!appleIdentityKeyId(identityToken)) {
      return json(401, { error: "invalid_apple_credential" });
    }
    if (!allowAppleAuthAttempt(Date.now())) return json(429, { error: "rate_limited" });
    const budget = await ctx.runMutation(internal.auth.consumeAppleAuthBudget, { now: Date.now() });
    if (!budget.ok) return json(429, { error: "rate_limited" });

    try {
      const audiences = (process.env.APPLE_CLIENT_IDS ?? "dev.kil.talaria,dev.kil.talaria.branch")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const now = Date.now();
      const keys = await appleKeys(ctx, now);
      if (!keys) return json(503, { error: "apple_keys_unavailable" });
      const claims = await verifyAppleIdentityToken({
        token: identityToken,
        nonce,
        audiences,
        nowSeconds: Math.floor(now / 1_000),
        keys,
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
    const publisherId = canonicalHttpOrigin(stringField(body, "publisherId", 191) ?? "");
    const profileId = stringField(body, "profileId", 128);
    const label = stringField(body, "label", 80);
    const publicKey = stringField(body, "publicKey", 128);
    if (!invitation || !publisherId || !profileId || !label || !publicKey) {
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
      profileId,
      keyId: `key_${randomToken(8)}`,
      label,
      publicKey,
      now: Date.now(),
    });
    return result.ok ? json(201, result) : json(400, { error: result.reason });
  }),
});

http.route({
  path: "/v1/pairings/profile/redeem",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    if (rawBody.length > maximumBodyCharacters) return json(413, { error: "body_too_large" });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!isRecord(parsed)) throw new Error("invalid");
      body = parsed;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const invitation = stringField(body, "invitation", 256);
    const publisherId = canonicalHttpOrigin(stringField(body, "publisherId", 191) ?? "");
    const profileId = stringField(body, "profileId", 128);
    if (!invitation || !publisherId || !profileId) return json(400, { error: "invalid_pairing" });
    const auth = await authenticatePublisher(ctx, request, rawBody, publisherId);
    if (!auth) return json(401, { error: "unauthorized" });
    const result = await ctx.runMutation(internal.pairing.redeemProfileInvitation, {
      tokenHash: await sha256(invitation),
      publisherOwnerUserId: auth.publisherOwnerUserId,
      publisherId,
      profileId,
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
    const publisherId = canonicalHttpOrigin(parts[2] ?? "");
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

    const profileId = parts[3] === "profiles" ? parts[4] : null;
    if (!profileId) return json(404, { error: "not_found" });

    if (parts.length === 8 && parts[5] === "sessions" && parts[7] === "activity") {
      const sessionId = parts[6];
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
        profileId,
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
              alertEligible: state.alertEligible,
            }
          : null,
      });
      const status = result.status === "accepted" || result.status === "duplicate" ? 200 : 409;
      return json(status, result);
    }

    if (parts.length === 8 && parts[5] === "sessions" && parts[7] === "started") {
      const event = parseSessionStarted(body);
      if (!event || event.sessionId !== parts[6]) return json(400, { error: "invalid_session_started" });
      if (event.publisherId !== publisherId || event.profileId !== profileId) return json(403, { error: "profile_mismatch" });
      const result = await ctx.runMutation(internal.publishers.acceptSessionStarted, {
        publisherId,
        profileId,
        ...auth,
        sessionId: event.sessionId,
        eventId: event.eventId,
        startedAt: event.startedAt,
      });
      return json(result.status === "accepted" ? 200 : 409, result);
    }

    if (parts.length === 8 && parts[5] === "sessions" && parts[7] === "viewed") {
      const through = numberField(body, "through");
      if (!parts[6] || through === null || !Number.isSafeInteger(through)) return json(400, { error: "invalid_viewed" });
      const result = await ctx.runMutation(internal.publishers.acknowledgeViewedSession, {
        publisherId,
        profileId,
        ...auth,
        sessionId: parts[6],
        through,
      });
      return json(result.status === "accepted" ? 200 : 409, result);
    }

    if (parts.length === 6 && parts[5] === "snapshot") {
      const snapshotId = stringField(body, "snapshotId", 191);
      const rawStates = body.states;
      if (!snapshotId || !Array.isArray(rawStates) || rawStates.length > 500) {
        return json(400, { error: "invalid_snapshot" });
      }
      const states = rawStates.map((state) => parseState(state));
      if (states.some((state) => state === null)) return json(400, { error: "invalid_snapshot" });
      const result = await ctx.runMutation(internal.publishers.acceptSnapshot, {
        publisherId,
        profileId,
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
    return mutationResponse(result, 404, "session_not_found");
  }),
});

http.route({
  pathPrefix: "/v1/devices/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const parts = pathParts(request);
    const deviceId = parts[2];
    if (!deviceId || parts.length !== 4 || parts[3] !== "publisher-subscriptions") {
      return json(404, { error: "not_found" });
    }
    const auth = await authenticateUser(ctx, request);
    if (!auth) return json(401, { error: "unauthorized" });
    const publishers = await ctx.runQuery(internal.subscriptions.listForDevice, {
      userId: auth.userId,
      deviceId,
    });
    return publishers ? json(200, { publishers }) : json(404, { error: "not_found" });
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

    if (parts.length === 4 && parts[3] === "publisher-subscriptions") {
      const publisherId = canonicalHttpOrigin(stringField(body, "publisherId", 191) ?? "");
      const subscribed = body.subscribed;
      if (!publisherId || typeof subscribed !== "boolean") {
        return json(400, { error: "invalid_subscription" });
      }
      const result = await ctx.runMutation(internal.subscriptions.setForDevice, {
        userId: auth.userId,
        deviceId,
        publisherId,
        subscribed,
        now: Date.now(),
      });
      return mutationResponse(result, 404, "not_found");
    }

    if (parts.length === 3) {
      const label = stringField(body, "label", 80);
      const apsEnvironment = body.apsEnvironment;
      const bundleId = talariaBundleId(stringField(body, "bundleId", 255) ?? "", apsEnvironment);
      const pushToken = body.pushToken === null
        ? undefined
        : optionalStringField(body, "pushToken", 512);
      const clearPushToken = body.pushToken === null;
      const pushToStartToken = body.pushToStartToken === null
        ? undefined
        : optionalStringField(body, "pushToStartToken", 512);
      const clearPushToStartToken = body.pushToStartToken === null;
      const preferences = parsePreferences(body.preferences);
      if (
        !label ||
        !bundleId ||
        (apsEnvironment !== "sandbox" && apsEnvironment !== "production") ||
        pushToken === null ||
        pushToStartToken === null ||
        !preferences
      ) {
        return json(400, { error: "invalid_device" });
      }
      const result = await ctx.runMutation(internal.devices.upsertDevice, {
        userId: auth.userId,
        sessionId: auth.sessionId,
        sessionExpiresAt: auth.expiresAt,
        deviceId,
        label,
        bundleId,
        apsEnvironment: apsEnvironment as ApsEnvironment,
        pushToken,
        clearPushToken,
        pushToStartToken,
        clearPushToStartToken,
        preferences,
        now: Date.now(),
      });
      return result.ok ? json(200, result) : json(401, { error: "unauthorized" });
    }

    if (parts.length === 5 && parts[3] === "live-activities") {
      const activityId = parts[4];
      const mode = body.mode;
      const rawPublisherId = optionalStringField(body, "publisherId", 191);
      const publisherId = rawPublisherId ? canonicalHttpOrigin(rawPublisherId) : rawPublisherId;
      const sessionId = optionalStringField(body, "sessionId", 191);
      const streamId = optionalStringField(body, "streamId", 191);
      const attributesType = stringField(body, "attributesType", 120);
      const schemaVersion = numberField(body, "schemaVersion");
      const activityPushToken = stringField(body, "activityPushToken", 512);
      const seededLocally = body.seededLocally ?? false;
      if (
        !activityId ||
        (mode !== "per_session" && mode !== "all_running") ||
        publisherId === null ||
        sessionId === null ||
        streamId === null ||
        !attributesType ||
        schemaVersion === null ||
        !Number.isSafeInteger(schemaVersion) ||
        !activityPushToken ||
        typeof seededLocally !== "boolean"
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
        streamId,
        attributesType,
        schemaVersion,
        activityPushToken,
        seededLocally,
        now: Date.now(),
      });
      return mutationResponse(result, 400, "invalid_activity");
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
      return mutationResponse(result, 404, "device_not_found");
    }
    if (parts.length === 5 && parts[3] === "live-activities") {
      const result = await ctx.runMutation(internal.devices.endActivity, {
        userId: auth.userId,
        deviceId,
        activityId: parts[4]!,
        now: Date.now(),
      });
      return mutationResponse(result, 404, "activity_not_found");
    }
    return json(404, { error: "not_found" });
  }),
});

http.route({
  path: "/v1/publisher-enrollment",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticateUser(ctx, request);
    if (!auth) return json(401, { error: "unauthorized" });
    const publisherId = canonicalHttpOrigin(new URL(request.url).searchParams.get("publisherId") ?? "");
    if (!publisherId) return json(400, { error: "publisher_required" });
    const result = await ctx.runMutation(internal.subscriptions.revokePublisher, {
      userId: auth.userId,
      publisherId,
      now: Date.now(),
    });
    return mutationResponse(result, 404, "publisher_not_enrolled");
  }),
});

http.route({
  path: "/v1/activity-completions",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticateUser(ctx, request);
    const deviceId = request.headers.get("x-talaria-device-id")?.trim();
    if (!auth || !deviceId) return json(401, { error: "unauthorized" });
    const result = await ctx.runQuery(internal.completions.list, {
      userId: auth.userId, deviceId,
      paginationOpts: { numItems: 100, cursor: new URL(request.url).searchParams.get("cursor") },
    });
    return result ? json(200, result) : json(403, { error: "unauthorized" });
  }),
});

http.route({
  path: "/v1/activity-completions/acknowledge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const auth = await authenticateUser(ctx, request);
    const deviceId = request.headers.get("x-talaria-device-id")?.trim();
    if (!auth || !deviceId) return json(401, { error: "unauthorized" });
    let body: unknown;
    try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
    if (!isRecord(body) || !Array.isArray(body.ids) || body.ids.length > 100
      || body.ids.some((id) => typeof id !== "string" || id.length > 64 || !/^[a-z0-9]+$/.test(id))) {
      return json(400, { error: "invalid_completion_ids" });
    }
    const result = await ctx.runMutation(internal.completions.acknowledge, {
      userId: auth.userId, deviceId, ids: body.ids as string[],
    });
    return mutationResponse(result, 403, "unauthorized");
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
    const excludedPublisherIds = await ctx.runQuery(internal.subscriptions.excludedPublisherIds, {
      userId: auth.userId,
      deviceId,
    });
    if (!excludedPublisherIds) return json(404, { error: "not_found" });
    const excluded = new Set(excludedPublisherIds);
    if (mode === "all_running") {
      const states = await ctx.runQuery(internal.publishers.listCurrentStates, {
        userId: auth.userId,
        now,
      });
      return json(200, {
        aggregate: makeAggregate(states.filter((state) => !excluded.has(state.publisherId)), now, true),
      });
    }
    if (mode === "per_session") {
      const publisherId = canonicalHttpOrigin(url.searchParams.get("publisherId") ?? "");
      const sessionId = url.searchParams.get("sessionId");
      if (!publisherId || !sessionId) return json(400, { error: "session_required" });
      if (excluded.has(publisherId)) return json(200, { aggregate: null });
      const states = await ctx.runQuery(internal.publishers.listCurrentStates, { userId: auth.userId, now });
      return json(200, { aggregate: makeAggregate(states.filter((state) =>
        state.publisherId === publisherId && state.sessionId === sessionId), now, true) });
    }
    return json(400, { error: "invalid_mode" });
  }),
});

export default http;
