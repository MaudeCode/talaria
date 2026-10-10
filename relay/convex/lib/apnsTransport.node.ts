import { createHash, createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";

import type { ApsEnvironment } from "./model";

export interface ApnsWireRequest {
  token: string;
  topic: string;
  environment: ApsEnvironment;
  pushType: "alert" | "liveactivity";
  priority: "5" | "10";
  payloadJson: string;
  // Hashed into apns-collapse-id so a retry replaces, not duplicates, an already-delivered push.
  jobId: string;
}

export interface ApnsWireResponse {
  status: number;
  apnsId?: string;
  reason?: string;
}

export type ApnsTransport = (
  request: ApnsWireRequest,
  authorization: string,
) => Promise<ApnsWireResponse>;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function makeProviderToken(input: {
  teamId: string;
  keyId: string;
  privateKey: string;
  issuedAt: number;
}): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const encodedPayload = base64Url(JSON.stringify({ iss: input.teamId, iat: input.issuedAt }));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(input.privateKey.replaceAll("\\n", "\n")),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

function closeSession(session: ClientHttp2Session): void {
  if (!session.closed && !session.destroyed) session.close();
}

export const sendHttp2: ApnsTransport = async (request, authorization) =>
  new Promise((resolve, reject) => {
    const origin =
      request.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const session = connect(origin);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeSession(session);
      reject(error);
    };
    session.once("error", fail);
    const stream = session.request({
      ":method": "POST",
      ":path": `/3/device/${request.token}`,
      authorization: `bearer ${authorization}`,
      "apns-topic": request.topic,
      "apns-push-type": request.pushType,
      "apns-priority": request.priority,
      "apns-collapse-id": createHash("sha256").update(request.jobId).digest("base64url"),
      "content-type": "application/json",
    });
    let responseHeaders: IncomingHttpHeaders = {};
    let body = "";
    timeout = setTimeout(() => stream.destroy(new Error("APNs request timed out")), 15_000);
    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      responseHeaders = headers;
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.once("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeSession(session);
      const status = Number(responseHeaders[":status"] ?? 0);
      let reason: string | undefined;
      if (body) {
        try {
          const parsed = JSON.parse(body) as { reason?: unknown };
          if (typeof parsed.reason === "string") reason = parsed.reason;
        } catch {
          reason = body.slice(0, 200);
        }
      }
      resolve({
        status,
        apnsId: typeof responseHeaders["apns-id"] === "string" ? responseHeaders["apns-id"] : undefined,
        reason,
      });
    });
    stream.end(request.payloadJson);
  });

export async function sendWithTransport(
  request: ApnsWireRequest,
  authorization: string,
  transport: ApnsTransport = sendHttp2,
): Promise<ApnsWireResponse> {
  return transport(request, authorization);
}

const permanentTokenReasons = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export function classifyApnsFailure(response: ApnsWireResponse): {
  retry: boolean;
  invalidateToken: boolean;
} {
  if (response.status === 429 || response.status >= 500 || response.status === 0) {
    return { retry: true, invalidateToken: false };
  }
  return {
    retry: false,
    invalidateToken:
      response.status === 410 ||
      (response.status === 400 && !!response.reason && permanentTokenReasons.has(response.reason)),
  };
}
