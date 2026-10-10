import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  classifyApnsFailure,
  makeProviderToken,
  sendHttp2,
  sendWithTransport,
  type ApnsWireRequest,
} from "../convex/lib/apnsTransport.node";

const http2 = vi.hoisted(() => ({ requests: [] as Record<string, string>[] }));

vi.mock("node:http2", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    connect: () =>
      Object.assign(new EventEmitter(), {
        closed: false,
        destroyed: false,
        close() {
          this.closed = true;
        },
        request(headers: Record<string, string>) {
          http2.requests.push(headers);
          const stream = Object.assign(new EventEmitter(), {
            setEncoding() {},
            destroy() {},
            end() {
              queueMicrotask(() => {
                stream.emit("response", { ":status": 200, "apns-id": "apns-id" });
                stream.emit("end");
              });
            },
          });
          return stream;
        },
      }),
  };
});

describe("APNs transport", () => {
  it("creates a valid ES256 provider token", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = makeProviderToken({
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      issuedAt: 1_800_000_000,
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iss: "TEAM123",
      iat: 1_800_000_000,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("supports a deterministic fake transport", async () => {
    const request: ApnsWireRequest = {
      token: "token",
      topic: "dev.kil.talaria.push-type.liveactivity",
      environment: "sandbox",
      pushType: "liveactivity",
      priority: "5",
      payloadJson: "{}",
      jobId: "job-1",
    };
    const fake = vi.fn().mockResolvedValue({ status: 200, apnsId: "apns-id" });

    await expect(sendWithTransport(request, "jwt", fake)).resolves.toEqual({
      status: 200,
      apnsId: "apns-id",
    });
    expect(fake).toHaveBeenCalledWith(request, "jwt");
  });

  it("sends a stable apns-collapse-id for every retry of the same job", async () => {
    const request: ApnsWireRequest = {
      token: "token",
      topic: "dev.kil.talaria",
      environment: "sandbox",
      pushType: "alert",
      priority: "10",
      payloadJson: "{}",
      jobId: "job-1",
    };
    http2.requests.length = 0;

    await sendHttp2(request, "jwt");
    await sendHttp2(request, "jwt");
    // A different job with the same payload state (e.g. a reused event ID) must not replace the first alert.
    await sendHttp2({ ...request, jobId: "job-2" }, "jwt");

    const [first, retry, other] = http2.requests.map((headers) => headers["apns-collapse-id"]);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
  });

  it("retries transient failures and invalidates only permanent token failures", () => {
    expect(classifyApnsFailure({ status: 500 })).toEqual({ retry: true, invalidateToken: false });
    expect(classifyApnsFailure({ status: 410, reason: "Unregistered" })).toEqual({
      retry: false,
      invalidateToken: true,
    });
    expect(classifyApnsFailure({ status: 403, reason: "InvalidProviderToken" })).toEqual({
      retry: false,
      invalidateToken: false,
    });
  });
});
