import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

// The upload mutation fails after the blob is stored, as an exhausted retry or outage would.
vi.mock("../convex/feedback", async (original) => {
  const actual = await original<typeof import("../convex/feedback")>();
  const { internalMutation } = await import("../convex/_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    recordUpload: internalMutation({
      args: { reportId: v.string(), index: v.number(), tokenHash: v.string(), now: v.number(), storageId: v.id("_storage") },
      handler: () => { throw new Error("synthetic record failure"); },
    }),
  };
});

const modules = import.meta.glob("../convex/**/*.ts");
const { attachments: _, ...fixture } = JSON.parse(readFileSync(
  new URL("../../contracts/fixtures/feedback-report.json", import.meta.url), "utf8",
)) as Record<string, unknown>;

beforeEach(() => {
  process.env.FEEDBACK_OPERATOR_TOKEN_SHA256 = createHash("sha256").update("synthetic-operator-token").digest("hex");
});
afterEach(() => { delete process.env.FEEDBACK_OPERATOR_TOKEN_SHA256; });

it("deletes the stored blob when recording the upload fails", async () => {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  const image = new Uint8Array(64).fill(0x2a);
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Only verified reports may attach files; admit one for a registered publisher without re-testing signatures here.
  const owner = { version: 2 as const, ownerUserId: "feedback-owner", publisherId: "https://feedback.example", createdAt: 0 };
  await backend.run(async (ctx) => {
    await ctx.db.insert("publishers", { ...owner, label: "Feedback publisher", enabled: true, updatedAt: 0 });
    await ctx.db.insert("publisherKeys", { ...owner, keyId: "feedback-key", publicKey: "unused", activatedAt: 0 });
  });
  const uploadToken = "synthetic-upload-token";
  const now = Date.now();
  const payload = {
    ...fixture,
    attachments: [{ contentType: "image/png", bytes: image.byteLength, sha256: createHash("sha256").update(image).digest("hex") }],
  } as never;
  const admission = await backend.mutation(internal.feedback.submit, {
    payload, payloadHash: "synthetic", installHash: "synthetic", attachmentsDisabled: false, now,
    uploadTokenHashes: [createHash("sha256").update(uploadToken).digest("hex")],
    publisher: {
      publisherOwnerUserId: owner.ownerUserId, publisherId: owner.publisherId, keyId: "feedback-key",
      nonce: "synthetic-nonce", nonceExpiresAt: now + 60_000, receivedAt: now,
    },
  });
  expect(admission).toMatchObject({ status: "accepted", attachments: [{ status: "accepted" }] });
  const { reportId } = admission as { reportId: string };
  await expect(backend.fetch(`/v1/feedback/${reportId}/attachments/0`, {
    method: "PUT",
    body: image,
    headers: { authorization: `Bearer ${uploadToken}`, "content-length": String(image.byteLength) },
  })).rejects.toThrow("synthetic record failure");
  expect(await backend.run(async (ctx) => await ctx.db.system.query("_storage").collect())).toEqual([]);
});
