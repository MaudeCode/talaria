import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences, type AgentNotify, type SessionPhase } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const now = 1_800_000_000_000;
const publisherId = "https://hermes.example";
const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/relay-approval-alert.json", import.meta.url), "utf8")) as {
  notificationAlert: Record<string, string>;
};

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); });

// Two Relay users, each granted one profile of the same publisher, with one notification-enabled phone each.
async function seed() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey)));
  await backend.run(async (ctx) => {
    await ctx.db.insert("publishers", { version: 2, ownerUserId: "user-1", publisherId, label: "Home", enabled: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("publisherKeys", { version: 2, ownerUserId: "user-1", publisherId, keyId: "key-1", publicKey, activatedAt: now, createdAt: now });
    for (const [user, profile] of [["user-1", "profile-1"], ["user-2", "profile-2"]] as const) {
      await ctx.db.insert("publisherGrants", { publisherOwnerUserId: "user-1", userId: user, publisherId, profileId: profile, createdAt: now, updatedAt: now });
      await ctx.db.insert("devices", {
        userId: user, deviceId: `${user}-phone`, label: "iPhone", bundleId: "dev.kil.talaria", apsEnvironment: "production",
        pushToken: `${user}-push-token`, preferences: { ...defaultNotificationPreferences, notificationsEnabled: true },
        createdAt: now, updatedAt: now,
      });
    }
  });
  let nonce = 0;
  let revision = 1;
  const processed = new Set<string>();
  const runScheduledRecomputes = async () => {
    const scheduled = await backend.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const job of scheduled) {
      if (job.name !== "delivery:recompute" || processed.has(job._id)) continue;
      processed.add(job._id);
      await backend.mutation(internal.delivery.recompute, (job.args as [never])[0]);
    }
  };
  // Every snapshot is a fresh signed event with a new revision, as Talaria Web's heartbeat publishes them.
  const publish = async (phase: SessionPhase, head?: string, options: { profileId?: string; alertEligible?: boolean; decision?: string; notices?: AgentNotify[] } = {}) => {
    revision += 1;
    const path = `/v1/publishers/${encodeURIComponent(publisherId)}/profiles/${options.profileId ?? "profile-1"}/snapshot`;
    const body = JSON.stringify({
      snapshotId: `snapshot-${String(revision)}`,
      states: [{
        sessionId: "session-1", streamId: "stream-1", eventId: `snapshot:${String(revision)}:session-1`, revision,
        title: "Private session title", phase, updatedAt: now + revision, deepLink: "/sessions/session-1",
        ...(options.alertEligible === undefined ? {} : { alertEligible: options.alertEligible }),
        ...(head === undefined ? {} : { approvalHeadId: head }),
        ...(options.decision === undefined ? {} : { decisionReviewId: options.decision, decisionReviewTitle: "Release choices" }),
        ...(options.notices === undefined ? {} : { agentNotices: options.notices }),
      }],
    });
    const timestamp = String(now / 1000);
    const requestNonce = `nonce-${String(nonce++)}`;
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign("Ed25519", keys.privateKey,
      new TextEncoder().encode(["PUT", path, timestamp, requestNonce, await sha256(body)].join("\n")))));
    const response = await backend.fetch(path, {
      method: "PUT", body,
      headers: {
        "content-type": "application/json", "x-talaria-key-id": "key-1", "x-talaria-timestamp": timestamp,
        "x-talaria-nonce": requestNonce, "x-talaria-signature": signature,
      },
    });
    expect(response.status).toBe(200);
    await runScheduledRecomputes();
  };
  const notifications = async (userId = "user-1") => {
    const rows = await backend.run(async (ctx) => ctx.db.query("deliveryJobs").order("asc").collect());
    return rows.filter((job) => job.userId === userId && job.kind === "notification")
      .map((job) => ({ id: job._id, payload: JSON.parse(job.request.payloadJson) as { aps: Record<string, unknown> } & Record<string, unknown> }));
  };
  return { backend, publish, notifications };
}

describe("decision reviews (TAL-1966)", () => {
  it("alerts once for a new review with its title and a link to it, through the run's completion", async () => {
    const { backend, publish, notifications } = await seed();
    await publish("running");
    await publish("running", undefined, { decision: "dr_0a1b2c3d" });
    await publish("running", undefined, { decision: "dr_0a1b2c3d" });
    await publish("completed", undefined, { decision: "dr_0a1b2c3d" });
    const delivered = await notifications();
    // The run's completion alerts on its own; the review alert stays deliverable while the session holds the review.
    expect(delivered.map(({ payload }) => payload.deepLink)).toEqual(["/decisions/dr_0a1b2c3d", "/sessions/session-1"]);
    expect(delivered[0]!.payload.aps).toMatchObject({ alert: { title: "Decision review ready", body: "Release choices" }, "interruption-level": "active" });
    expect(await backend.mutation(internal.delivery.claimJob, { jobId: delivered[0]!.id, now })).toMatchObject({ status: "ready" });

    // A later review alerts again.
    await publish("running", undefined, { decision: "dr_0a1b2c3e" });
    expect((await notifications()).map(({ payload }) => payload.deepLink).at(-1)).toBe("/decisions/dr_0a1b2c3e");
  });

  it("sends nothing for a review shown while a Talaria tab is open or with input alerts off", async () => {
    const { backend, publish, notifications } = await seed();
    await publish("running");
    await publish("running", undefined, { decision: "dr_0a1b2c3d", alertEligible: false });
    expect(await notifications()).toHaveLength(0);
    await backend.run(async (ctx) => {
      const device = (await ctx.db.query("devices").collect()).find((row) => row.userId === "user-1")!;
      await ctx.db.patch(device._id, { preferences: { ...device.preferences, notifyOnInput: false } });
    });
    await publish("running", undefined, { decision: "dr_0a1b2c3e" });
    expect(await notifications()).toHaveLength(0);
  });

  it("drops a queued review alert once the session no longer holds that review", async () => {
    const { backend, publish, notifications } = await seed();
    await publish("running");
    await publish("running", undefined, { decision: "dr_0a1b2c3d" });
    const [queued] = await notifications();
    await publish("running");
    expect(await backend.mutation(internal.delivery.claimJob, { jobId: queued!.id, now })).toEqual({ status: "stale" });
  });
});

describe("agent notices (TAL-1970)", () => {
  // The workpool may already have run a queued job in the background; claim it again from queued to check its state alone.
  const claim = async (backend: Awaited<ReturnType<typeof seed>>["backend"], jobId: Id<"deliveryJobs">) => {
    await backend.run(async (ctx) => { await ctx.db.patch(jobId, { status: "queued" }); });
    return backend.mutation(internal.delivery.claimJob, { jobId, now });
  };
  const info: AgentNotify = { id: "an_0000000000000001", title: "Report ready", body: "reports/week-45.md is done.", level: "info" };
  const attention: AgentNotify = { id: "an_0000000000000002", title: "Need your login", body: "The import stopped at the bank's sign-in.", level: "attention" };

  it("alerts once per notice with the agent's words, opening the session, beside the run's own alert", async () => {
    const { backend, publish, notifications } = await seed();
    await publish("running");
    await publish("running", undefined, { notices: [info] });
    await publish("running", undefined, { notices: [info] });
    await publish("completed", undefined, { notices: [info] });
    const delivered = await notifications();
    // The run's completion still alerts on its own.
    expect(delivered.map(({ payload }) => payload.deepLink)).toEqual(["/sessions/session-1", "/sessions/session-1"]);
    expect((delivered[1]!.payload.aps.alert as { body: string }).body.startsWith("Completed on ")).toBe(true);
    expect(delivered[0]!.payload.aps).toMatchObject({ alert: { title: info.title, body: info.body }, "interruption-level": "active" });

    expect(await claim(backend, delivered[0]!.id)).toMatchObject({ status: "ready" });

    // An attention notice breaks through Focus even while a Talaria tab mutes the run's alerts, and a newer notice
    // leaves the queued one deliverable.
    await publish("running", undefined, { notices: [info, attention], alertEligible: false });
    const latest = (await notifications()).at(-1)!;
    expect(latest.payload.aps).toMatchObject({ alert: { title: attention.title, body: attention.body }, "interruption-level": "time-sensitive" });
    expect(await claim(backend, latest.id)).toMatchObject({ status: "ready" });
    expect(await claim(backend, delivered[0]!.id)).toMatchObject({ status: "ready" });
  });

  it("alerts for every notice a snapshot first carries, none collapsing into another or into the run's alert", async () => {
    const { backend, publish } = await seed();
    await publish("running");
    await publish("completed", undefined, { notices: [info, attention] });
    const jobs = (await backend.run(async (ctx) => ctx.db.query("deliveryJobs").collect()))
      .filter((job) => job.userId === "user-1" && job.kind === "notification");
    const titles = jobs.map((job) => ((JSON.parse(job.request.payloadJson) as { aps: { alert: { title: string } } }).aps.alert.title));
    expect(titles.slice(0, 2)).toEqual([info.title, attention.title]);
    expect(jobs).toHaveLength(3);
    // One chat thread, three collapse identities.
    expect(new Set(jobs.map((job) => JSON.parse(job.request.payloadJson).aps["thread-id"] as string)).size).toBe(1);
    expect(new Set(jobs.map((job) => job.request.collapseId)).size).toBe(3);
  });

  it("refuses a malformed notice", async () => {
    const { publish } = await seed();
    await expect(publish("running", undefined, { notices: [{ ...info, title: "x".repeat(81) }] })).rejects.toThrow();
  });
});

describe("approval queue heads", () => {
  it("alerts once for each approval that becomes the head while the session keeps waiting", async () => {
    const { publish, notifications } = await seed();
    await publish("running");
    await publish("waiting_for_approval", "head-first");
    await publish("waiting_for_approval", "head-first");
    await publish("waiting_for_approval", "head-first");
    expect(await notifications()).toHaveLength(1);

    // Answering the first approval reveals the second one without leaving the waiting phase.
    await publish("waiting_for_approval", "head-second");
    await publish("waiting_for_approval", "head-second");
    const delivered = await notifications();
    expect(delivered).toHaveLength(2);
    for (const { payload } of delivered) {
      expect(payload.aps).toMatchObject({ alert: fixture.notificationAlert, "interruption-level": "time-sensitive" });
      expect(payload).toMatchObject({ publisherId, sessionId: "session-1", deepLink: "/sessions/session-1" });
      expect(JSON.stringify(payload)).not.toContain("Private session title");
    }
  });

  it("never alerts again for a head it already showed when the head returns after another phase", async () => {
    const { publish, notifications } = await seed();
    await publish("running");
    await publish("waiting_for_approval", "head-first");
    await publish("running");
    await publish("waiting_for_approval", "head-first");
    expect(await notifications()).toHaveLength(1);
    await publish("waiting_for_approval", "head-second");
    expect(await notifications()).toHaveLength(2);
  });

  it("alerts only the devices enrolled in the profile that published the head", async () => {
    const { publish, notifications } = await seed();
    await publish("running");
    await publish("waiting_for_approval", "head-first");
    expect(await notifications("user-1")).toHaveLength(1);
    expect(await notifications("user-2")).toHaveLength(0);

    await publish("running", undefined, { profileId: "profile-2" });
    await publish("waiting_for_approval", "head-first", { profileId: "profile-2" });
    expect(await notifications("user-1")).toHaveLength(1);
    expect(await notifications("user-2")).toHaveLength(1);
  });

  it("consumes a head that became visible while alerts were suppressed", async () => {
    const { publish, notifications } = await seed();
    await publish("running");
    await publish("waiting_for_approval", "head-seen", { alertEligible: false });
    await publish("waiting_for_approval", "head-seen", { alertEligible: false });
    await publish("waiting_for_approval", "head-seen");
    expect(await notifications()).toHaveLength(0);

    // The suppression belonged to the earlier head; a new head alerts once the browser tab is gone.
    await publish("waiting_for_approval", "head-next");
    expect(await notifications()).toHaveLength(1);
    await publish("waiting_for_approval", "head-last", { alertEligible: false });
    expect(await notifications()).toHaveLength(1);
  });

  it("keeps a retried delivery valid across later snapshots of the same head and never queues a duplicate", async () => {
    const { backend, publish, notifications } = await seed();
    await publish("running");
    await publish("waiting_for_approval", "head-first");
    const [job] = await notifications();
    // The workpool claims the job again after a transient APNs failure (this test relay has no APNs credentials).
    const retry = async (at: number) => {
      await backend.run(async (ctx) => { await ctx.db.patch(job!.id, { status: "running" }); });
      return await backend.mutation(internal.delivery.claimJob, { jobId: job!.id, now: at });
    };
    expect(await retry(now + 100)).toMatchObject({ status: "ready" });

    // A heartbeat of the same head lands before APNs answers; the retry still delivers the original alert.
    await publish("waiting_for_approval", "head-first");
    expect(await retry(now + 200)).toMatchObject({ status: "ready" });
    expect(await notifications()).toHaveLength(1);

    // Once another approval leads, the earlier head's retry is stale.
    await publish("waiting_for_approval", "head-second");
    expect(await retry(now + 300)).toEqual({ status: "stale" });
    expect(await notifications()).toHaveLength(2);
  });

  it("keeps phase-only alerts for a publisher that sends no heads", async () => {
    const { publish, notifications } = await seed();
    await publish("running");
    await publish("waiting_for_approval");
    await publish("waiting_for_approval");
    expect(await notifications()).toHaveLength(1);
    // A head first seen mid-phase cannot prove it is a new approval.
    await publish("waiting_for_approval", "head-after-upgrade");
    expect(await notifications()).toHaveLength(1);
  });
});
