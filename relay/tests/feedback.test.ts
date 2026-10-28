import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const fixtureText = readFileSync(new URL("../../contracts/fixtures/feedback-report.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText) as Record<string, unknown> & { client: Record<string, unknown> };
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
    await ctx.db.insert("authRateLimits", { key: "ended", windowStartedAt: start - day - 1, attempts: 5 });
    await ctx.db.insert("authRateLimits", { key: "open", windowStartedAt: start - day + 1_000, attempts: 5 });
  });
  await backend.mutation(internal.cleanup.prune, {});
  expect((await rows()).map((row) => row.requestId).sort()).toEqual(["new-delivered", "new-pending"]);
  const budgets = await backend.run(async (ctx) => await ctx.db.query("authRateLimits").collect());
  expect(budgets.map((row) => row.key)).toEqual(["open"]);
});
