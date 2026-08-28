import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyAppleIdentityToken } from "../convex/lib/appleIdentity";
import { bytesToBase64Url } from "../convex/lib/crypto";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

describe("Apple identity verification", () => {
  it("verifies signature, issuer, audience, expiry, and nonce", async () => {
    const keys = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const publicKey = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    const header = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "apple-key" })),
    );
    const claims = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "dev.kil.talaria",
      sub: "apple-user",
      exp: 1_800_000_600,
      iat: 1_800_000_000,
      nonce: "nonce-1",
    })));
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(`${header}.${claims}`),
    )));
    const token = `${header}.${claims}.${signature}`;
    const input = {
      token,
      nonce: "nonce-1",
      audiences: ["dev.kil.talaria"],
      nowSeconds: 1_800_000_000,
      keys: [{ ...publicKey, kid: "apple-key", alg: "ES256" }],
    };

    await expect(verifyAppleIdentityToken(input)).resolves.toMatchObject({ sub: "apple-user" });
    await expect(verifyAppleIdentityToken({ ...input, nonce: "wrong" })).resolves.toBeNull();
    await expect(verifyAppleIdentityToken({ ...input, audiences: ["other.app"] })).resolves.toBeNull();
    await expect(verifyAppleIdentityToken({ ...input, nowSeconds: 1_800_000_601 })).resolves.toBeNull();
  });
});
