import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const fixture = (name: string) => readFileSync(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), "utf8");

it("accepts the Web publisher and App registration, then returns the shared App snapshot", async () => {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  const now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey)));
    await backend.run(async (ctx) => {
      await ctx.db.insert("relayUsers", {
        userId: "contract-user", appleSubjectHash: "contract-apple", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("userSessions", {
        userId: "contract-user", sessionId: "contract-auth", tokenHash: await sha256("contract-session-token"),
        expiresAt: now + 60_000, createdAt: now,
      });
      await ctx.db.insert("publishers", {
        version: 2, ownerUserId: "contract-user", publisherId: "https://contract.example",
        label: "Contract publisher", enabled: true, createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2, ownerUserId: "contract-user", publisherId: "https://contract.example",
        keyId: "contract-key", publicKey, activatedAt: now, createdAt: now,
      });
      await ctx.db.insert("publisherGrants", {
        userId: "contract-user", publisherOwnerUserId: "contract-user", publisherId: "https://contract.example",
        profileId: "prf_default", createdAt: now, updatedAt: now,
      });
      await ctx.db.insert("devices", {
        userId: "contract-user", deviceId: "contract-device", label: "Synthetic phone",
        bundleId: "dev.kil.talaria", apsEnvironment: "sandbox",
        preferences: defaultNotificationPreferences, createdAt: now, updatedAt: now,
      });
    });
    const body = fixture("publisher-snapshot");
    const path = `/v1/publishers/${encodeURIComponent("https://contract.example")}/profiles/prf_default/snapshot`;
    const timestamp = String(now / 1000);
    const nonce = "contract-nonce";
    const signed = ["PUT", path, timestamp, nonce, await sha256(body)].join("\n");
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
      "Ed25519", keys.privateKey, new TextEncoder().encode(signed),
    )));
    const response = await backend.fetch(path, {
      method: "PUT", body,
      headers: {
        "content-type": "application/json", "x-talaria-key-id": "contract-key",
        "x-talaria-timestamp": timestamp, "x-talaria-nonce": nonce, "x-talaria-signature": signature,
      },
    });
    expect(response.status).toBe(200);
    const headers = { authorization: "Bearer contract-session-token", "x-talaria-device-id": "contract-device" };
    const snapshot = await backend.fetch("/v1/activity-snapshot?mode=all_running", { headers });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual(JSON.parse(fixture("relay-snapshot")));
    const registration = await backend.fetch("/v1/devices/contract-device/live-activities/contract-activity", {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: fixture("app-registration"),
    });
    expect(registration.status).toBe(200);
  } finally {
    clock.mockRestore();
  }
});
