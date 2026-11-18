import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyAppleIdentityToken } from "../convex/lib/appleIdentity";
import { bytesToBase64Url } from "../convex/lib/crypto";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

const claims = {
  iss: "https://appleid.apple.com",
  aud: "dev.kil.talaria",
  sub: "apple-user",
  exp: 1_800_086_400,
  iat: 1_800_000_000,
  nonce: "nonce-1",
};
const encode = (value: object) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

// One RS256 key pair and a signer for Apple-shaped identity tokens.
async function appleSigner() {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKey = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const sign = async (body: object, kid = "apple-key") => {
    const signed = `${encode({ alg: "RS256", kid })}.${encode(body)}`;
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signed),
    )));
    return `${signed}.${signature}`;
  };
  const verify = (token: string, overrides: Partial<Parameters<typeof verifyAppleIdentityToken>[0]> = {}) =>
    verifyAppleIdentityToken({
      token,
      nonce: "nonce-1",
      audiences: ["dev.kil.talaria"],
      nowSeconds: 1_800_000_000,
      keys: [{ ...publicKey, kid: "apple-key", alg: "RS256" }],
      ...overrides,
    });
  return { sign, verify };
}

describe("Apple identity verification", () => {
  it("accepts a signed token for this app and nonce, and refuses a wrong nonce, audience or expiry", async () => {
    const { sign, verify } = await appleSigner();
    const token = await sign(claims);

    await expect(verify(token)).resolves.toMatchObject({ sub: "apple-user" });
    await expect(verify(token, { nonce: "wrong" })).resolves.toBeNull();
    await expect(verify(token, { audiences: ["other.app"] })).resolves.toBeNull();
    await expect(verify(token, { nowSeconds: 1_800_086_401 })).resolves.toBeNull();
  });

  it.each([
    // Claims swapped under the original signature: only the RSA check refuses it.
    ["claims changed after signing", async (sign: (body: object, kid?: string) => Promise<string>) => {
      const [header, , signature] = (await sign(claims)).split(".");
      return `${header}.${encode({ ...claims, sub: "another-user" })}.${signature}`;
    }],
    ["another issuer", (sign: (body: object, kid?: string) => Promise<string>) => sign({ ...claims, iss: "https://issuer.example" })],
    ["an issue time more than five minutes ahead", (sign: (body: object, kid?: string) => Promise<string>) => sign({ ...claims, iat: claims.iat + 5 * 60 + 1 })],
    ["a key id Apple does not publish", (sign: (body: object, kid?: string) => Promise<string>) => sign(claims, "rotated-key")],
  ] as const)("refuses a token with %s", async (_name, tamper) => {
    const { sign, verify } = await appleSigner();
    await expect(verify(await tamper(sign))).resolves.toBeNull();
  });
});
