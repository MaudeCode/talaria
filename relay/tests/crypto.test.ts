import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  bytesToBase64Url,
  randomToken,
  sha256,
  timingSafeEqual,
  verifyPublisherSignature,
} from "../convex/lib/crypto";

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

describe("publisher signatures", () => {
  it("binds an Ed25519 signature to the exact method, path, timestamp, nonce, and body", async () => {
    const keys = (await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = bytesToBase64Url(
      new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey)),
    );
    const body = JSON.stringify({ revision: 1 });
    const timestamp = "1800000000";
    const nonce = "nonce-1";
    const message = ["PUT", "/v1/publishers/p/sessions/s/activity", timestamp, nonce, await sha256(body)].join("\n");
    const signature = bytesToBase64Url(
      new Uint8Array(
        await webcrypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message)),
      ),
    );

    expect(
      await verifyPublisherSignature({
        publicKey,
        signature,
        method: "PUT",
        path: "/v1/publishers/p/sessions/s/activity",
        timestamp,
        nonce,
        body,
      }),
    ).toBe(true);
    expect(
      await verifyPublisherSignature({
        publicKey,
        signature,
        method: "PUT",
        path: "/v1/publishers/p/sessions/s/activity",
        timestamp,
        nonce,
        body: JSON.stringify({ revision: 2 }),
      }),
    ).toBe(false);
  });

  it("compares credentials without an early exit", () => {
    expect(timingSafeEqual("credential", "credential")).toBe(true);
    expect(timingSafeEqual("credential", "credentiaL")).toBe(false);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  });
});
