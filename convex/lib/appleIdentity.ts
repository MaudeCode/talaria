import { bytesToBase64Url, timingSafeEqual } from "./crypto";

interface AppleJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

interface AppleIdentityClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat?: number;
  nonce: string;
}

function decodeSegment(segment: string): Uint8Array {
  const normalized = segment.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseJsonSegment(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeSegment(value))) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseClaims(value: Record<string, unknown>): AppleIdentityClaims | null {
  const aud = value.aud;
  if (
    value.iss !== "https://appleid.apple.com" ||
    (typeof aud !== "string" && !Array.isArray(aud)) ||
    typeof value.sub !== "string" ||
    value.sub.length === 0 ||
    value.sub.length > 255 ||
    typeof value.exp !== "number" ||
    typeof value.nonce !== "string"
  ) {
    return null;
  }
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (audiences.some((item) => typeof item !== "string")) return null;
  return {
    iss: value.iss,
    aud: audiences as string[],
    sub: value.sub,
    exp: value.exp,
    iat: typeof value.iat === "number" ? value.iat : undefined,
    nonce: value.nonce,
  };
}

export async function verifyAppleIdentityToken(input: {
  token: string;
  nonce: string;
  audiences: readonly string[];
  nowSeconds: number;
  keys: readonly AppleJwk[];
}): Promise<AppleIdentityClaims | null> {
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = parseJsonSegment(encodedHeader);
  const rawClaims = parseJsonSegment(encodedClaims);
  if (!header || !rawClaims || header.alg !== "RS256" || typeof header.kid !== "string") {
    return null;
  }
  const claims = parseClaims(rawClaims);
  if (!claims) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((audience) => input.audiences.includes(audience))) return null;
  if (claims.exp <= input.nowSeconds) return null;
  if (claims.iat !== undefined && claims.iat > input.nowSeconds + 5 * 60) return null;
  if (!timingSafeEqual(claims.nonce, input.nonce)) return null;

  const jwk = input.keys.find(
    (key) => key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256",
  );
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeSegment(encodedSignature).buffer as ArrayBuffer,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    return valid ? claims : null;
  } catch {
    return null;
  }
}

export function appleIdentityKeyId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const header = parseJsonSegment(parts[0]!);
  return header?.alg === "RS256" && typeof header.kid === "string" ? header.kid : null;
}

export async function subjectHash(secret: string, subject: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(subject))),
  );
}
