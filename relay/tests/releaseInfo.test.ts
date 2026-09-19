import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

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
