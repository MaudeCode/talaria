import { convexTest } from "convex-test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// Counts APNs preflight runs: the action signs a provider token on every call.
const signings = vi.hoisted(() => ({ count: 0 }));
vi.mock("../convex/lib/apnsTransport.node", async (importOriginal) => {
  const original = await importOriginal<typeof import("../convex/lib/apnsTransport.node")>();
  return { ...original, makeProviderToken: (...args: Parameters<typeof original.makeProviderToken>) => {
    signings.count += 1;
    return original.makeProviderToken(...args);
  } };
});

const modules = import.meta.glob("../convex/**/*.ts");

it("reports release identity and canonical capabilities without changing health readiness", async () => {
  const backend = convexTest(schema, modules);
  const now = Date.now();
  await backend.mutation(internal.auth.claimAppleJwks, { now });
  await backend.mutation(internal.auth.saveAppleJwks, {
    keysJson: '[{"kty":"RSA","alg":"RS256"}]', expiresAt: now + 60_000, now,
  });
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
  vi.stubEnv("APNS_TEAM_ID", "");
  vi.stubEnv("APPLE_SUBJECT_HASH_KEY", "");
  try {
    const response = await backend.fetch("/v1/health");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    const versions = JSON.parse(readFileSync(new URL("../../contracts/versions.json", import.meta.url), "utf8"));
    expect(body.release).toEqual({
      version: "development", sourceRevision: null, releaseSet: null, deploymentId: null,
      contracts: {
        webRelay: [versions.webRelay.protocolVersion],
        appRelay: [versions.appRelay.aggregateSchemaVersion],
        activityScene: [versions.activityScene.version],
      },
    });
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("reuses a healthy result for a minute but rechecks an unhealthy one on every poll", async () => {
  const backend = convexTest(schema, modules);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60 * 60_000);
  const now = Date.now();
  await backend.mutation(internal.auth.claimAppleJwks, { now });
  await backend.mutation(internal.auth.saveAppleJwks, {
    keysJson: '[{"kty":"RSA","alg":"RS256"}]', expiresAt: now + 60 * 60_000, now,
  });
  vi.stubEnv("APPLE_SUBJECT_HASH_KEY", "k".repeat(32));
  vi.stubEnv("APNS_TEAM_ID", "team");
  vi.stubEnv("APNS_KEY_ID", "key");
  vi.stubEnv("APNS_PRIVATE_KEY", "not a key");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
  const status = async () => (await backend.fetch("/v1/health")).status;
  try {
    const before = signings.count;
    expect([await status(), await status()]).toEqual([503, 503]);
    expect(signings.count - before).toBe(2);

    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    vi.stubEnv("APNS_PRIVATE_KEY", privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    expect(await status()).toBe(200);
    vi.advanceTimersByTime(59_000);
    expect(await status()).toBe(200);
    expect(signings.count - before).toBe(3);
    vi.advanceTimersByTime(2_000);
    expect(await status()).toBe(200);
    expect(signings.count - before).toBe(4);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});
