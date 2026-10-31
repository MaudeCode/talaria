import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { attachmentLimits, matchesAttachmentType } from "../convex/lib/feedback";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const fixtureText = readFileSync(new URL("../../contracts/fixtures/feedback-report.json", import.meta.url), "utf8");
// The shared example carries an attachment manifest; text-only tests drop it.
const { attachments: _fixtureAttachments, ...fixture } = JSON.parse(fixtureText) as Record<string, unknown> & { client: Record<string, unknown> };
const operatorToken = "synthetic-operator-token";
const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const start = 1_800_000_000_000;
let clock = start;

beforeEach(() => {
  clock = start;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  process.env.FEEDBACK_OPERATOR_TOKEN_SHA256 = createHash("sha256").update(operatorToken).digest("hex");
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FEEDBACK_OPERATOR_TOKEN_SHA256;
});

let uuidCounter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`;
const report = (overrides: Record<string, unknown> = {}) => ({ ...fixture, requestId: uuid(), ...overrides });

async function relay() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  // Two accounts may register the same origin; each registration authenticates independently.
  const signers: Record<string, CryptoKey> = {};
  for (const owner of ["feedback-owner", "rival-owner"]) {
    const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey)));
    signers[`${owner}-key`] = keys.privateKey;
    await backend.run(async (ctx) => {
      await ctx.db.insert("publishers", {
        version: 2, ownerUserId: owner, publisherId: "https://feedback.example",
        label: "Feedback publisher", enabled: true, createdAt: start, updatedAt: start,
      });
      await ctx.db.insert("publisherKeys", {
        version: 2, ownerUserId: owner, publisherId: "https://feedback.example",
        keyId: `${owner}-key`, publicKey, activatedAt: start, createdAt: start,
      });
    });
  }
  const submit = (body: unknown, headers: Record<string, string> = {}) => backend.fetch("/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let nonces = 0;
  const signatureHeaders = async (body: string, options: { nonce?: string; timestamp?: number; signedBody?: string; keyId?: string } = {}) => {
    const keyId = options.keyId ?? "feedback-owner-key";
    const timestamp = String(Math.floor((options.timestamp ?? clock) / 1_000));
    const nonce = options.nonce ?? `feedback-nonce-${String(nonces++)}`;
    const message = ["POST", "/v1/feedback", timestamp, nonce, await sha256(options.signedBody ?? body)].join("\n");
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
      "Ed25519", signers[keyId]!, new TextEncoder().encode(message),
    )));
    return {
      "x-talaria-key-id": keyId, "x-talaria-timestamp": timestamp,
      "x-talaria-nonce": nonce, "x-talaria-signature": signature,
    };
  };
  const signedSubmit = async (body: unknown, options?: Parameters<typeof signatureHeaders>[1]) => {
    const text = JSON.stringify(body);
    return await submit(text, await signatureHeaders(text, options));
  };
  const operator = (path: string, init: RequestInit = {}, token = operatorToken) => backend.fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  const rows = () => backend.run(async (ctx) => await ctx.db.query("feedbackReports").collect());
  return { backend, submit, signedSubmit, signatureHeaders, operator, rows };
}

describe("feedback intake", () => {
  it("accepts the shared fixture as an unverified pending report", async () => {
    const { submit, rows } = await relay();
    const response = await submit(fixtureText);
    expect(response.status).toBe(202);
    const { reportId } = await response.json() as { reportId: string };
    const [row] = await rows();
    expect(row).toMatchObject({
      // Unverified reports cannot attach files, so the example's screenshot is refused and the report queues at once.
      _id: reportId, requestId: fixture.requestId, tier: "unverified", status: "pending",
      installHash: await sha256(fixture.installId as string), createdAt: start, payload: fixture,
    });
    expect(row?.publisherId).toBeUndefined();
  });

  it("records a signed submission from a registered publisher as verified", async () => {
    const { signedSubmit, rows } = await relay();
    expect((await signedSubmit(report())).status).toBe(202);
    expect(await rows()).toEqual([
      expect.objectContaining({ tier: "verified", publisherId: "https://feedback.example" }),
    ]);
  });

  it("rejects bad, stale, replayed, unknown, or partial publisher signatures without downgrading", async () => {
    const { submit, signedSubmit, signatureHeaders, rows } = await relay();
    expect((await signedSubmit(report(), { signedBody: "{}" })).status).toBe(401);
    expect((await signedSubmit(report(), { timestamp: clock - 6 * 60 * 1_000 })).status).toBe(401);
    expect((await signedSubmit(report(), { nonce: "used-once" })).status).toBe(202);
    expect((await signedSubmit(report(), { nonce: "used-once" })).status).toBe(401);
    const text = JSON.stringify(report());
    const headers = await signatureHeaders(text);
    expect((await submit(text, { ...headers, "x-talaria-key-id": "unknown-key" })).status).toBe(401);
    expect((await submit(text, { "x-talaria-signature": headers["x-talaria-signature"] })).status).toBe(401);
    expect(await rows()).toHaveLength(1);
  });

  it("rejects oversize, unknown, or invalid fields with 400 and stores nothing", async () => {
    const { submit, rows } = await relay();
    const oversize = await submit(report({ diagnostics: "é".repeat(16_384) }));
    expect(oversize.status).toBe(400);
    expect(await oversize.json()).toEqual({ error: "body_too_large" });
    for (const invalid of [
      report({ title: "t".repeat(121) }),
      report({ body: "b".repeat(8_001) }),
      report({ diagnostics: "d".repeat(16_385) }),
      report({ title: "   " }),
      report({ extra: true }),
      report({ client: { ...fixture.client, extra: true } }),
      report({ client: { ...fixture.client, appVersion: "v".repeat(65) } }),
      report({ client: { ...fixture.client, platform: "android" } }),
      report({ kind: "praise" }),
      report({ installId: "not-a-uuid" }),
      report({ server: {} }),
      report({ requestId: undefined }),
    ]) {
      const response = await submit(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_feedback" });
    }
    expect((await submit("not json")).status).toBe(400);
    expect(await rows()).toEqual([]);
  });
});

describe("feedback budgets", () => {
  const retryAfter = (response: Response) => Number(response.headers.get("retry-after"));

  it("limits one unverified install to five reports an hour", async () => {
    const { submit } = await relay();
    for (let index = 0; index < 5; index += 1) expect((await submit(report())).status).toBe(202);
    clock += 10 * 60 * 1_000;
    const limited = await submit(report());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(retryAfter(limited)).toBe(50 * 60);
    expect((await submit(report({ installId: uuid() }))).status).toBe(202);
    clock = start + hour;
    expect((await submit(report())).status).toBe(202);
  });

  it("limits a verified publisher to twenty reports an hour without spending another owner's budget", async () => {
    const { signedSubmit } = await relay();
    for (let index = 0; index < 20; index += 1) expect((await signedSubmit(report({ installId: uuid() }))).status).toBe(202);
    const limited = await signedSubmit(report({ installId: uuid() }));
    expect(limited.status).toBe(429);
    expect(retryAfter(limited)).toBe(3_600);
    expect((await signedSubmit(report(), { keyId: "rival-owner-key" })).status).toBe(202);
  });

  it("caps unverified reports at two hundred a day while verified reports continue", async () => {
    const { submit, signedSubmit } = await relay();
    for (let install = 0; install < 40; install += 1) {
      const installId = uuid();
      for (let index = 0; index < 5; index += 1) expect((await submit(report({ installId }))).status).toBe(202);
    }
    clock += hour;
    const limited = await submit(report({ installId: uuid() }));
    expect(limited.status).toBe(429);
    expect(retryAfter(limited)).toBe(23 * 3_600);
    expect((await signedSubmit(report())).status).toBe(202);
  });

  it("caps every tier at one thousand reports a day", async () => {
    const { backend, submit, signedSubmit } = await relay();
    await backend.run(async (ctx) => {
      await ctx.db.insert("authRateLimits", { key: "feedback:global", windowStartedAt: start, attempts: 999 });
    });
    expect((await signedSubmit(report())).status).toBe(202);
    expect((await signedSubmit(report())).status).toBe(429);
    expect((await submit(report())).status).toBe(429);
    clock = start + day;
    expect((await submit(report())).status).toBe(202);
  });

  it("replays the same request without a new row or budget and rejects a changed payload", async () => {
    const { submit, rows } = await relay();
    const first = report();
    const accepted = await submit(first);
    const { reportId } = await accepted.json() as { reportId: string };
    for (let index = 0; index < 10; index += 1) {
      const retry = await submit(first);
      expect(retry.status).toBe(202);
      expect(await retry.json()).toEqual({ reportId });
    }
    const conflict = await submit({ ...first, title: "A different title" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
    for (let index = 0; index < 4; index += 1) expect((await submit(report())).status).toBe(202);
    expect((await submit(report())).status).toBe(429);
    expect(await rows()).toHaveLength(5);
  });

  it("keeps the Apple sign-in budget at three hundred attempts a minute", async () => {
    const { backend } = await relay();
    for (let index = 0; index < 300; index += 1) {
      await expect(backend.mutation(internal.auth.consumeAppleAuthBudget, { now: start })).resolves.toEqual({ ok: true });
    }
    await expect(backend.mutation(internal.auth.consumeAppleAuthBudget, { now: start + 59_999 })).resolves.toEqual({ ok: false });
    await expect(backend.mutation(internal.auth.consumeAppleAuthBudget, { now: start + 60_000 })).resolves.toEqual({ ok: true });
  });
});

describe("feedback operator queue", () => {
  it("turns every feedback route off when the operator token is unset", async () => {
    const { submit, operator } = await relay();
    delete process.env.FEEDBACK_OPERATOR_TOKEN_SHA256;
    expect((await submit(report())).status).toBe(404);
    expect((await operator("/v1/feedback/pending")).status).toBe(404);
    expect((await operator("/v1/feedback/anything/ack", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("rejects a missing or wrong operator token", async () => {
    const { operator, backend } = await relay();
    expect((await operator("/v1/feedback/pending", {}, "wrong-token")).status).toBe(401);
    expect((await backend.fetch("/v1/feedback/pending")).status).toBe(401);
    expect((await operator("/v1/feedback/anything/ack", {
      method: "POST", body: JSON.stringify({ ticketKey: "TAL-1" }),
    }, "wrong-token")).status).toBe(401);
  });

  it("lists pending reports oldest first and acknowledges delivery idempotently", async () => {
    const { submit, signedSubmit, operator } = await relay();
    const ids: string[] = [];
    for (const send of [submit, signedSubmit, submit]) {
      const response = await send(report({ installId: uuid() }));
      ids.push(((await response.json()) as { reportId: string }).reportId);
      clock += 1_000;
    }
    const pending = async (query = "") => {
      const response = await operator(`/v1/feedback/pending${query}`);
      expect(response.status).toBe(200);
      return ((await response.json()) as { reports: { reportId: string; tier: string; publisherId?: string; createdAt: number; payload: unknown }[] }).reports;
    };
    const all = await pending();
    expect(all.map((entry) => entry.reportId)).toEqual(ids);
    expect(all[0]).toMatchObject({ tier: "unverified", createdAt: start });
    expect(all[0]?.publisherId).toBeUndefined();
    expect(all[1]).toMatchObject({ tier: "verified", publisherId: "https://feedback.example", createdAt: start + 1_000 });
    expect(all[2]?.payload).toMatchObject({ title: fixture.title, kind: fixture.kind });
    expect((await pending("?limit=2")).map((entry) => entry.reportId)).toEqual(ids.slice(0, 2));
    for (const limit of ["0", "51", "abc", "1.5"]) {
      expect((await operator(`/v1/feedback/pending?limit=${limit}`)).status).toBe(400);
    }

    const ack = (reportId: string, body: unknown) => operator(`/v1/feedback/${reportId}/ack`, {
      method: "POST", body: JSON.stringify(body),
    });
    const delivered = await ack(ids[0]!, { ticketKey: "TAL-9001" });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ reportId: ids[0], ticketKey: "TAL-9001", status: "delivered" });
    expect((await ack(ids[0]!, { ticketKey: "TAL-9001" })).status).toBe(200);
    const conflict = await ack(ids[0]!, { ticketKey: "TAL-9002" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "ticket_key_conflict" });
    expect((await ack("unknown-report", { ticketKey: "TAL-9001" })).status).toBe(404);
    for (const invalid of [{}, { ticketKey: "not a key" }, { ticketKey: "TAL-1", extra: true }]) {
      expect((await ack(ids[1]!, invalid)).status).toBe(400);
    }
    expect((await pending()).map((entry) => entry.reportId)).toEqual(ids.slice(1));
  });

  it("signals only pending report IDs, and only to the operator token", async () => {
    const { backend } = await relay();
    const payload = { ...fixture } as never;
    const ids = await backend.run(async (ctx) => {
      const insert = (requestId: string, status: "pending" | "uploading" | "delivered", createdAt: number) =>
        ctx.db.insert("feedbackReports", {
          requestId, payloadHash: requestId, tier: "unverified", installHash: "install", payload, status, createdAt,
          ...(status === "delivered" ? { ticketKey: "TAL-1", deliveredAt: start } : {}),
        });
      await insert("delivered", "delivered", start);
      await insert("uploading", "uploading", start);
      const pending = [];
      for (let index = 0; index < 51; index += 1) pending.push(await insert(`pending-${String(index)}`, "pending", start + index));
      return pending;
    });
    const signal = (token: string) => backend.query(api.feedback.pendingSignal, { token });
    expect(await signal(operatorToken)).toEqual(ids.slice(0, 50));
    await expect(signal("wrong-token")).rejects.toThrow("unauthorized");
    delete process.env.FEEDBACK_OPERATOR_TOKEN_SHA256;
    await expect(signal(operatorToken)).rejects.toThrow("unauthorized");
  });
});

it("prunes delivered reports after seven days, pending reports after thirty, and ended budget windows", async () => {
  const { backend, rows } = await relay();
  const payload = { ...fixture } as never;
  await backend.run(async (ctx) => {
    const insert = (requestId: string, fields: { status: "pending" | "delivered"; createdAt: number; deliveredAt?: number }) =>
      ctx.db.insert("feedbackReports", {
        requestId, payloadHash: requestId, tier: "unverified", installHash: "install", payload,
        ...fields, ...(fields.status === "delivered" ? { ticketKey: "TAL-1" } : {}),
      });
    await insert("old-delivered", { status: "delivered", createdAt: start - 40 * day, deliveredAt: start - 7 * day - 1 });
    await insert("new-delivered", { status: "delivered", createdAt: start - 40 * day, deliveredAt: start - 7 * day + 1_000 });
    await insert("old-pending", { status: "pending", createdAt: start - 30 * day - 1 });
    await insert("new-pending", { status: "pending", createdAt: start - 30 * day + 1_000 });
    await ctx.db.insert("authRateLimits", { key: "ended", windowStartedAt: start - 30 * day - 1, attempts: 5 });
    await ctx.db.insert("authRateLimits", { key: "open", windowStartedAt: start - 30 * day + 1_000, attempts: 5 });
  });
  await backend.mutation(internal.cleanup.prune, {});
  expect((await rows()).map((row) => row.requestId).sort()).toEqual(["new-delivered", "new-pending"]);
  const budgets = await backend.run(async (ctx) => await ctx.db.query("authRateLimits").collect());
  expect(budgets.map((row) => row.key)).toEqual(["open"]);
});

describe("feedback attachments", () => {
  const MB = 1_000_000;
  const limitsText = readFileSync(new URL("../../contracts/fixtures/feedback-attachment-limits.json", import.meta.url), "utf8");
  const signatures: Record<string, number[]> = {
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
    "image/webp": [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")],
    "image/heic": [0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0, ...Buffer.from("mif1heic")],
    "video/mp4": [0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 2, 0, ...Buffer.from("isomiso2")],
    "video/quicktime": [0, 0, 0, 20, ...Buffer.from("ftypqt  "), 0, 0, 2, 0, ...Buffer.from("qt  ")],
    "video/webm": [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81],
  };
  const file = (contentType: string, size = 64) => {
    const bytes = new Uint8Array(size).fill(0x2a);
    bytes.set(signatures[contentType]!);
    return bytes;
  };
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const entry = (bytes: Uint8Array, contentType = "image/png") => ({ contentType, bytes: bytes.byteLength, sha256: digest(bytes) });
  const declared = (bytes: number, contentType = "image/png") => ({ contentType, bytes, sha256: "a".repeat(64) });
  type Admission = { index: number; status: string; uploadToken?: string; expiresAt?: number; reason?: string };

  async function attachmentRelay() {
    const base = await relay();
    const accepted = async (response: Response | Promise<Response>) => {
      const resolved = await response;
      expect(resolved.status).toBe(202);
      return await resolved.json() as { reportId: string; attachments: Admission[] };
    };
    const put = (reportId: string, index: number, token: string | null, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
      base.backend.fetch(`/v1/feedback/${reportId}/attachments/${String(index)}`, {
        method: "PUT",
        body,
        headers: {
          "content-length": String(body.byteLength),
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
      });
    const blobs = () => base.backend.run(async (ctx) => await ctx.db.system.query("_storage").collect());
    const storedBytes = () => base.backend.run(async (ctx) =>
      (await ctx.db.query("feedbackAttachmentUsage").first())?.storedBytes ?? 0);
    const budgets = () => base.backend.run(async (ctx) =>
      Object.fromEntries((await ctx.db.query("authRateLimits").collect()).map((row) => [row.key, row.attempts])));
    const pending = async () => {
      const response = await base.operator("/v1/feedback/pending");
      expect(response.status).toBe(200);
      return ((await response.json()) as { reports: { reportId: string; attachments: unknown[] }[] }).reports;
    };
    return { ...base, accepted, put, blobs, storedBytes, budgets, pending };
  }

  it("pins Relay's limits to the shared table", () => {
    expect(attachmentLimits).toEqual(JSON.parse(limitsText));
  });

  it("recognizes each declared type by its leading bytes and nothing else", () => {
    for (const [contentType, bytes] of Object.entries(signatures)) {
      for (const declaredType of Object.keys(signatures)) {
        expect(matchesAttachmentType(file(contentType), declaredType as never)).toBe(contentType === declaredType);
      }
      expect(matchesAttachmentType(new Uint8Array(bytes.slice(0, 3)), contentType as never)).toBe(contentType === "image/jpeg");
    }
  });

  it("stores an uploaded blob, lists it, serves its exact bytes, and deletes it on ack", async () => {
    const { signedSubmit, accepted, put, operator, pending, blobs, storedBytes } = await attachmentRelay();
    const image = file("image/png", 4_096);
    const admission = await accepted(signedSubmit(report({ attachments: [entry(image)] })));
    const [slot] = admission.attachments;
    expect(slot).toEqual({ index: 0, status: "accepted", uploadToken: expect.any(String), expiresAt: start + 30 * 60 * 1_000 });
    expect(Buffer.from(slot!.uploadToken!, "base64url")).toHaveLength(32);
    expect(await pending()).toEqual([]);

    const stored = await put(admission.reportId, 0, slot!.uploadToken!, image);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ reportId: admission.reportId, index: 0, status: "stored" });
    expect(await storedBytes()).toBe(4_096);
    const [listed] = await pending();
    expect(listed?.attachments).toEqual([{ index: 0, ...entry(image), status: "stored" }]);

    const download = await operator(`/v1/feedback/${admission.reportId}/attachments/0`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(image);
    expect((await operator(`/v1/feedback/${admission.reportId}/attachments/0`, {}, "wrong-token")).status).toBe(401);

    const ack = await operator(`/v1/feedback/${admission.reportId}/ack`, { method: "POST", body: JSON.stringify({ ticketKey: "TAL-1" }) });
    expect(ack.status).toBe(200);
    expect(await blobs()).toEqual([]);
    expect(await storedBytes()).toBe(0);
    expect((await operator(`/v1/feedback/${admission.reportId}/attachments/0`)).status).toBe(404);
  });

  it("refuses mismatched uploads and bad tokens without storing anything", async () => {
    const { signedSubmit, accepted, put, blobs, backend } = await attachmentRelay();
    const image = file("image/png", 512);
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const svg = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const first = await accepted(signedSubmit(report({ attachments: [entry(image), entry(html), entry(svg)] })));
    const other = await accepted(signedSubmit(report({ attachments: [entry(image)] })));
    const token = first.attachments[0]!.uploadToken!;
    const invalid = async (response: Promise<Response>) => {
      const resolved = await response;
      expect(resolved.status).toBe(400);
      expect(await resolved.json()).toEqual({ error: "invalid_attachment" });
    };
    const unauthorized = async (response: Promise<Response>) => {
      const resolved = await response;
      expect(resolved.status).toBe(401);
      expect(await resolved.json()).toEqual({ error: "unauthorized" });
    };

    await invalid(backend.fetch(`/v1/feedback/${first.reportId}/attachments/0`, {
      method: "PUT", body: new ReadableStream({ start(controller) { controller.enqueue(image); controller.close(); } }),
      headers: { authorization: `Bearer ${token}` }, duplex: "half",
    } as RequestInit));
    await invalid(put(first.reportId, 0, token, image, { "content-length": "511" }));
    await invalid(put(first.reportId, 0, token, image.slice(0, 511), { "content-length": "512" }));
    const corrupted = image.slice();
    corrupted[100] = 0;
    await invalid(put(first.reportId, 0, token, corrupted));
    await invalid(put(first.reportId, 1, first.attachments[1]!.uploadToken!, html));
    await invalid(put(first.reportId, 2, first.attachments[2]!.uploadToken!, svg));
    await unauthorized(put(first.reportId, 0, null, image));
    await unauthorized(put(first.reportId, 0, "not-the-token", image));
    await unauthorized(put(first.reportId, 0, other.attachments[0]!.uploadToken!, image));
    await unauthorized(put(other.reportId, 0, token, image));
    expect(await blobs()).toEqual([]);

    expect((await put(first.reportId, 0, token, image)).status).toBe(200);
    await unauthorized(put(first.reportId, 0, token, image));
    expect(await blobs()).toHaveLength(1);

    clock += 30 * 60 * 1_000;
    const expired = await put(other.reportId, 0, other.attachments[0]!.uploadToken!, image);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "upload_expired" });
    expect(await blobs()).toHaveLength(1);
    expect((await backend.fetch("/v1/feedback/x/attachments/9", { method: "PUT", body: image })).status).toBe(404);
  });

  it("refuses every attachment on an unverified report, charging nothing, while verified reports keep images and video", async () => {
    const { submit, signedSubmit, accepted, budgets, rows } = await attachmentRelay();
    const manifest = [entry(file("image/jpeg")), entry(file("video/mp4"), "video/mp4")];
    expect((await accepted(submit(report({ attachments: manifest })))).attachments).toEqual([
      { index: 0, status: "refused", reason: "tier" },
      { index: 1, status: "refused", reason: "tier" },
    ]);
    expect(Object.keys(await budgets()).filter((key) => key.startsWith("feedback-bytes:"))).toEqual([]);
    expect((await rows()).map((row) => row.status)).toEqual(["pending"]);
    expect((await accepted(signedSubmit(report({ attachments: manifest })))).attachments.map(({ status }) => status))
      .toEqual(["accepted", "accepted"]);
  });

  it("rejects a malformed manifest as invalid feedback", async () => {
    const { submit, rows } = await attachmentRelay();
    const image = declared(1);
    for (const attachments of [
      [],
      Array(6).fill(image),
      [declared(1, "image/svg+xml")],
      [declared(1, "text/html")],
      [declared(10 * MB + 1)],
      [declared(20 * MB + 1, "video/mp4")],
      [declared(0)],
      [declared(1.5)],
      [{ ...image, sha256: "A".repeat(64) }],
      [{ ...image, sha256: "a".repeat(63) }],
      [{ ...image, name: "shot.png" }],
      [{ contentType: "image/png", bytes: 1 }],
      [declared(1, "video/mp4"), declared(1, "video/webm")],
      null,
    ]) {
      const response = await submit(report({ attachments }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_feedback" });
    }
    expect(await rows()).toEqual([]);
  });

  it("degrades to text when a byte budget or the storage ceiling is spent and charges refused files nothing", async () => {
    const { backend, signedSubmit, accepted, budgets } = await attachmentRelay();
    const statuses = (admission: { attachments: Admission[] }) => admission.attachments.map(({ status, reason }) => reason ?? status);
    const byteBudgets = async () => Object.entries(await budgets()).filter(([key]) => key.startsWith("feedback-bytes:"));
    const preset = async (key: string, attempts: number) => backend.run(async (ctx) => {
      const row = await ctx.db.query("authRateLimits").withIndex("by_key", (query) => query.eq("key", key)).unique();
      if (row) await ctx.db.patch(row._id, { attempts, windowStartedAt: clock });
      else await ctx.db.insert("authRateLimits", { key, windowStartedAt: clock, attempts });
    });
    await preset("feedback-bytes:pub:feedback-owner:https://feedback.example", 200 * MB - 5);
    expect(statuses(await accepted(signedSubmit(report({ attachments: [declared(6), declared(5)] }))))).toEqual(["quota", "accepted"]);
    const charged = await byteBudgets();
    expect(statuses(await accepted(signedSubmit(report({ attachments: [declared(1)] }))))).toEqual(["quota"]);
    expect(await byteBudgets()).toEqual(charged);
    await preset("feedback-bytes:global", 600 * MB - 5);
    expect(statuses(await accepted(signedSubmit(report({ attachments: [declared(6)] }), { keyId: "rival-owner-key" })))).toEqual(["quota"]);
    await preset("feedback-bytes:global", 0);
    await preset("feedback-bytes:global:30d", 6_000 * MB - 5);
    expect(statuses(await accepted(signedSubmit(report({ attachments: [declared(6), declared(5)] }), { keyId: "rival-owner-key" }))))
      .toEqual(["quota", "accepted"]);
    await preset("feedback-bytes:global:30d", 0);
    await backend.run(async (ctx) => { await ctx.db.insert("feedbackAttachmentUsage", { storedBytes: 2_000 * MB - 5 }); });
    const before = await budgets();
    expect(statuses(await accepted(signedSubmit(report({ attachments: [declared(6), declared(5), declared(1)] }), { keyId: "rival-owner-key" }))))
      .toEqual(["quota", "accepted", "quota"]);
    expect((await budgets())["feedback-bytes:global"]).toBe(before["feedback-bytes:global"]! + 5);
  });

  it("refuses every attachment while the kill switch is set and still accepts the report", async () => {
    const { submit, signedSubmit, accepted, put, rows } = await attachmentRelay();
    process.env.FEEDBACK_ATTACHMENTS_DISABLED = "1";
    try {
      const image = file("image/png");
      for (const send of [submit, signedSubmit]) {
        const admission = await accepted(send(report({ attachments: [entry(image), entry(file("video/webm"), "video/webm")] })));
        expect(admission.attachments).toEqual([
          { index: 0, status: "refused", reason: "disabled" },
          { index: 1, status: "refused", reason: "disabled" },
        ]);
      }
      expect((await rows()).map((row) => row.status)).toEqual(["pending", "pending"]);
      const uploading = (await rows())[0]!;
      const refused = await put(uploading._id, 0, "any-token", image);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: "attachments_disabled" });
    } finally {
      delete process.env.FEEDBACK_ATTACHMENTS_DISABLED;
    }
  });

  it("replays a submission by rotating only unstored tokens and charging nothing", async () => {
    const { signedSubmit, accepted, put, budgets } = await attachmentRelay();
    const [first, second] = [file("image/png", 100), file("image/webp", 200)];
    const payload = report({ attachments: [entry(first), entry(second, "image/webp")] });
    const original = await accepted(signedSubmit(payload));
    expect((await put(original.reportId, 0, original.attachments[0]!.uploadToken!, first)).status).toBe(200);
    const charged = await budgets();
    clock += 60_000;
    const replay = await accepted(signedSubmit(payload));
    expect(replay.reportId).toBe(original.reportId);
    expect(replay.attachments).toEqual([
      { index: 0, status: "stored" },
      { index: 1, status: "accepted", uploadToken: expect.any(String), expiresAt: original.attachments[1]!.expiresAt },
    ]);
    expect(replay.attachments[1]!.uploadToken).not.toBe(original.attachments[1]!.uploadToken);
    expect(await budgets()).toEqual(charged);
    expect((await put(original.reportId, 1, original.attachments[1]!.uploadToken!, second)).status).toBe(401);
    expect((await put(original.reportId, 1, replay.attachments[1]!.uploadToken!, second)).status).toBe(200);
    const conflict = await signedSubmit({ ...payload, attachments: [entry(first)] });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
  });

  it("queues a report whose upload window closed with the file marked missing, then prunes stale blobs", async () => {
    const { backend, signedSubmit, accepted, put, pending, blobs, storedBytes, rows } = await attachmentRelay();
    const [kept, never] = [file("image/png", 300), file("image/jpeg", 400)];
    const admission = await accepted(signedSubmit(report({ attachments: [entry(kept), entry(never, "image/jpeg")] })));
    expect((await put(admission.reportId, 0, admission.attachments[0]!.uploadToken!, kept)).status).toBe(200);
    expect(await pending()).toEqual([]);
    const scheduled = await backend.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toEqual([expect.objectContaining({ name: "feedback:closeUploads", scheduledTime: start + 30 * 60 * 1_000 })]);
    clock += 30 * 60 * 1_000;
    await backend.mutation(internal.feedback.closeUploads, { reportId: admission.reportId as never });
    const [listed] = await pending();
    expect(listed?.attachments).toEqual([
      { index: 0, ...entry(kept), status: "stored" },
      { index: 1, ...entry(never, "image/jpeg"), status: "missing" },
    ]);

    clock = start + 7 * day - 1;
    await backend.mutation(internal.cleanup.prune, {});
    expect(await blobs()).toHaveLength(1);
    clock = start + 7 * day + 1;
    await backend.mutation(internal.cleanup.prune, {});
    expect(await blobs()).toEqual([]);
    expect(await storedBytes()).toBe(0);
    expect((await pending())[0]?.attachments).toEqual([
      { index: 0, ...entry(kept), status: "missing" },
      { index: 1, ...entry(never, "image/jpeg"), status: "missing" },
    ]);
    clock = start + 30 * day + 1;
    await backend.mutation(internal.cleanup.prune, {});
    expect(await rows()).toEqual([]);
    expect(await backend.run(async (ctx) => await ctx.db.query("feedbackAttachments").collect())).toEqual([]);
  });
});
