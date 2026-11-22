import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { bytesToBase64Url, sha256 } from "../convex/lib/crypto";
import { defaultNotificationPreferences } from "../convex/lib/model";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const fixture = (name: string) => readFileSync(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), "utf8");

const now = 1_800_000_000_000;

// Fake timers hold the clock, convex-test's scheduler and the APNs workpool for every contract test.
beforeEach(() => { vi.useFakeTimers({ now }); });
afterEach(() => { vi.useRealTimers(); });

// A synthetic relay with one enrolled publisher profile (prf_default) and one signed-in device.
async function relayWithPublisher() {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
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
  let nonces = 0;
  const signedPut = async (path: string, body: string) => {
    const timestamp = String(now / 1000);
    const nonce = `contract-nonce-${String(nonces++)}`;
    const signed = ["PUT", path, timestamp, nonce, await sha256(body)].join("\n");
    const signature = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign(
      "Ed25519", keys.privateKey, new TextEncoder().encode(signed),
    )));
    return await backend.fetch(path, {
      method: "PUT", body,
      headers: {
        "content-type": "application/json", "x-talaria-key-id": "contract-key",
        "x-talaria-timestamp": timestamp, "x-talaria-nonce": nonce, "x-talaria-signature": signature,
      },
    });
  };
  return { backend, signedPut };
}

const publisherPath = (profileId: string, rest: string) =>
  `/v1/publishers/${encodeURIComponent("https://contract.example")}/profiles/${profileId}/${rest}`;

// TAL-874, TAL-1422, TAL-2336: fields an older Web publisher does not send; Relay copies each onto the App's row only when
// sent. Every supported Web sends the run's start (TAL-868, TAL-1666).
const optionalRunFields = ["toolCount", "activityAt", "currentTool", "planCompleted", "planTotal", "workerCount"] as const;
type PublisherSnapshot = { states: Partial<Record<"startedAt" | (typeof optionalRunFields)[number], unknown>>[] };

function withoutRunFields(body: string) {
  const snapshot = JSON.parse(body) as PublisherSnapshot;
  for (const state of snapshot.states) for (const field of optionalRunFields) delete state[field];
  return JSON.stringify(snapshot);
}

// The release gate pairs the selected Relay and App with each supported Web's own publisher fixture, so each row's
// expected optional fields follow the publisher.
function expectedAppSnapshot(publisherBody: string) {
  const { states } = JSON.parse(publisherBody) as PublisherSnapshot;
  const expected = JSON.parse(fixture("relay-snapshot")) as { aggregate: { rows: PublisherSnapshot["states"] } };
  for (const [index, row] of expected.aggregate.rows.entries()) {
    for (const field of ["startedAt", ...optionalRunFields] as const) {
      const value = states[index]?.[field];
      if (value === undefined) delete row[field];
      else row[field] = value;
    }
  }
  return expected;
}

it.each([
  ["its fixture", (body: string) => body],
  ["none of the optional run fields", withoutRunFields],
])("accepts a Web publisher sending %s and App registration, then returns the shared App snapshot", async (_, publish) => {
  const { backend, signedPut } = await relayWithPublisher();
  const body = publish(fixture("publisher-snapshot"));
  const response = await signedPut(publisherPath("prf_default", "snapshot"), body);
  expect(response.status).toBe(200);
  const headers = { authorization: "Bearer contract-session-token", "x-talaria-device-id": "contract-device" };
  const snapshot = await backend.fetch("/v1/activity-snapshot?mode=all_running", { headers });
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toEqual(expectedAppSnapshot(body));
  const registration = await backend.fetch("/v1/devices/contract-device/live-activities/contract-activity", {
    method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: fixture("app-registration"),
  });
  expect(registration.status).toBe(200);
});

it("accepts only the bounded session-started fields for the publisher's own profile", async () => {
  const { signedPut } = await relayWithPublisher();
  const body = fixture("publisher-session-started");
  const event = JSON.parse(body) as Record<string, unknown>;
  const path = publisherPath("prf_default", "sessions/contract-session/started");
  expect((await signedPut(path, body)).status).toBe(200);
  for (const invalid of [
    { ...event, title: "Contract fixture" },
    { ...event, version: 2 },
    { ...event, sessionId: "another-session" },
    { ...event, eventId: "e".repeat(201) },
    { ...event, startedAt: 1.5 },
  ]) {
    expect((await signedPut(path, JSON.stringify(invalid))).status).toBe(400);
  }
  // Another profile's scope: the body cannot name it, and the publisher holds no grant for its path.
  expect((await signedPut(path, JSON.stringify({ ...event, profileId: "prf_other" }))).status).toBe(403);
  const other = await signedPut(
    publisherPath("prf_other", "sessions/contract-session/started"),
    JSON.stringify({ ...event, profileId: "prf_other" }),
  );
  expect(other.status).toBe(409);
  expect(await other.json()).toEqual({ status: "unauthorized" });
});

// TAL-868, TAL-874: the run's start times the activity; its tool count and last activity replace the lock screen's
// empty excerpt, which Relay never has.
describe("relay-pushed Live Activity run fields", () => {
  const runStartedAt = now - 60_000;
  const activityAt = now - 20_000;
  // The loaded Web's publisher snapshot carrying this run's fields, at a given revision.
  const runSnapshot = (revision: number) => {
    const body = JSON.parse(fixture("publisher-snapshot")) as { snapshotId: string; states: Record<string, unknown>[] };
    body.snapshotId = `contract-snapshot-${String(revision)}`;
    body.states = body.states.map((state) => ({
      ...state, startedAt: runStartedAt, revision: now + revision, eventId: `snapshot:${String(now + revision)}:contract-session`,
      updatedAt: Date.now(), toolCount: 3, activityAt, planCompleted: 2, planTotal: 5, workerCount: 3,
    }));
    return body;
  };
  // A snapshot whose first state carries the given fields; the publisher must refuse it.
  const refused = async (fields: Record<string, unknown>) => {
    const { signedPut } = await relayWithPublisher();
    const body = runSnapshot(3);
    Object.assign(body.states[0]!, fields);
    return (await signedPut(publisherPath("prf_default", "snapshot"), JSON.stringify(body))).status;
  };

  it("maps the run's start, tool count and last activity into a relay-pushed Live Activity", async () => {
    const { backend, signedPut } = await relayWithPublisher();
    expect((await signedPut(publisherPath("prf_default", "snapshot"), JSON.stringify(runSnapshot(1)))).status).toBe(200);
    // The phone registers its activity (or reconnects) well after the run began.
    vi.setSystemTime(now + 30_000);
    const headers = { authorization: "Bearer contract-session-token", "x-talaria-device-id": "contract-device", "content-type": "application/json" };
    const registration = await backend.fetch("/v1/devices/contract-device/live-activities/contract-activity", {
      method: "PUT", headers, body: fixture("app-registration"),
    });
    expect(registration.status).toBe(200);
    vi.setSystemTime(now + 60_000);
    expect((await signedPut(publisherPath("prf_default", "snapshot"), JSON.stringify(runSnapshot(2)))).status).toBe(200);
    await backend.mutation(internal.delivery.recompute, { userId: "contract-user" });
    const jobs = await backend.run((ctx) => ctx.db.query("deliveryJobs").collect());
    const updates = jobs.filter((job) => job.kind === "live_activity_update" && job.activityId === "contract-activity");
    expect(updates.length).toBeGreaterThan(0);
    // Swift's default Codable Date representation is seconds since 2001-01-01.
    const swiftDate = (milliseconds: number) => milliseconds / 1_000 - 978_307_200;
    // TAL-2336, TAL-2401: the run's current call, as this Web's publisher fixture sent it; a Web that sends none gets none.
    const sentTool = (JSON.parse(fixture("publisher-snapshot")) as PublisherSnapshot).states[0]!.currentTool;
    for (const job of updates) {
      const contentState = JSON.parse(job.request.payloadJson).aps["content-state"] as Record<string, unknown>;
      expect(contentState).toMatchObject({
        responseExcerpt: "", startedAt: swiftDate(runStartedAt), toolCount: 3, activityAt: swiftDate(activityAt),
        planCompleted: 2, planTotal: 5, workerCount: 3,
      });
      expect(contentState.currentTool).toEqual(sentTool);
    }
  });

  it.each([
    { startedAt: 1.5 }, { toolCount: -1 }, { toolCount: 1.5 }, { activityAt: 1.5 },
  ])("refuses a run field that is not a whole count or time: %o", async (fields) => {
    expect(await refused(fields)).toBe(400);
  });

  // TAL-1666: every supported Web sends the run's start, so Relay never times an activity from its registration.
  it("refuses a snapshot state without the run's start", async () => {
    const { signedPut } = await relayWithPublisher();
    const body = runSnapshot(3);
    delete body.states[0]!.startedAt;
    const response = await signedPut(publisherPath("prf_default", "snapshot"), JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_snapshot" });
  });

  // TAL-2336: the current call's words and texts are bounded, and it carries no field Relay does not know.
  const call = { kind: "shell", target: "npm test", done: false };
  it.each([
    null, "npm test", { ...call, kind: "Shell" }, { ...call, target: "t".repeat(65) }, { ...call, done: "false" }, { ...call, failed: false },
    { ...call, verb: "x".repeat(33) }, { ...call, app: { name: "" } }, { ...call, app: { name: "Slack", logo_url: null } },
    { ...call, outcome: { key: "exit", tone: "loud" } }, { ...call, outcome: { key: "exit", tone: "error", count: 1.5 } },
    { ...call, outcome: { key: "failed", tone: "error", value: "v".repeat(65) } }, { ...call, args: { command: "npm test" } },
  ])("refuses an out-of-bound or unknown current call: %j", async (currentTool) => {
    expect(await refused({ currentTool })).toBe(400);
  });

  // TAL-1422: a plan's counts travel together, stay within its total, and every count is bounded.
  it.each([
    { planCompleted: undefined }, { planTotal: undefined }, { planCompleted: 6 }, { planTotal: 10_000, planCompleted: 0 },
    { workerCount: 10_000 }, { workerCount: -1 }, { workerCount: 1.5 }, { planCompleted: "2" },
  ])("refuses plan and worker counts that do not travel together or exceed their bounds: %j", async (fields) => {
    expect(await refused(fields)).toBe(400);
  });
});

// TAL-1422: plan and worker counts reach only their own session's activity, a repeat of unchanged counts pushes nothing,
// and the publisher's zeros clear what the activity showed.
it("updates, fences and clears a relay-pushed Live Activity's plan and worker counts", async () => {
  const { backend, signedPut } = await relayWithPublisher();
  let revision = 0;
  const publish = async (counts: { planCompleted: number; planTotal: number; workerCount: number }) => {
    revision += 1;
    const body = JSON.parse(fixture("publisher-snapshot")) as { snapshotId: string; states: Record<string, unknown>[] };
    body.snapshotId = `contract-snapshot-${String(revision)}`;
    const state = body.states[0]!;
    body.states = [
      { ...state, ...counts, revision: now + revision, eventId: `snapshot:${String(now + revision)}:contract-session` },
      // Another chat of the same publisher and profile, with its own counts.
      { ...state, sessionId: "other-session", streamId: "other-stream", deepLink: "/sessions/other-session", planCompleted: 9, planTotal: 9_999, workerCount: 9_999, revision: now + revision, eventId: `snapshot:${String(now + revision)}:other-session` },
    ];
    expect((await signedPut(publisherPath("prf_default", "snapshot"), JSON.stringify(body))).status).toBe(200);
    await backend.mutation(internal.delivery.recompute, { userId: "contract-user" });
  };
  const contentStates = async () => (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect()))
    .filter((job) => job.kind === "live_activity_update" && job.activityId === "contract-activity")
    .map((job) => JSON.parse(job.request.payloadJson).aps["content-state"] as Record<string, unknown>);
  await publish({ planCompleted: 2, planTotal: 5, workerCount: 3 });
  const headers = { authorization: "Bearer contract-session-token", "x-talaria-device-id": "contract-device", "content-type": "application/json" };
  expect((await backend.fetch("/v1/devices/contract-device/live-activities/contract-activity", { method: "PUT", headers, body: fixture("app-registration") })).status).toBe(200);
  await backend.mutation(internal.delivery.recompute, { userId: "contract-user" });
  expect((await contentStates()).at(-1)).toMatchObject({ sessionID: "contract-session", planCompleted: 2, planTotal: 5, workerCount: 3 });
  // APNs accepted that push, as the delivery worker records it, whenever the scheduler gets to it.
  await backend.run(async (ctx) => {
    const job = (await ctx.db.query("deliveryJobs").collect()).filter((candidate) => candidate.activityId === "contract-activity").at(-1)!;
    const activity = (await ctx.db.query("liveActivities").collect()).find((candidate) => candidate.activityId === "contract-activity")!;
    await ctx.db.patch(activity._id, { lastAggregate: job.aggregate, lastDeliveryAt: Date.now() });
  });
  const delivered = (await contentStates()).length;
  // The same counts again, past the update throttle but inside the unchanged-content heartbeat: no new push.
  vi.setSystemTime(now + 60_000);
  await publish({ planCompleted: 2, planTotal: 5, workerCount: 3 });
  expect(await contentStates()).toHaveLength(delivered);
  // A plan item completes and a worker finishes.
  await publish({ planCompleted: 3, planTotal: 5, workerCount: 2 });
  expect((await contentStates()).at(-1)).toMatchObject({ planCompleted: 3, planTotal: 5, workerCount: 2 });
  // The plan completes and the last worker ends: the zeros clear both.
  vi.setSystemTime(now + 120_000);
  await publish({ planCompleted: 0, planTotal: 0, workerCount: 0 });
  expect((await contentStates()).at(-1)).toMatchObject({ planCompleted: 0, planTotal: 0, workerCount: 0 });
});

it("alerts a Web publisher's approval queue head with only the shared localized keys", async () => {
  const { backend, signedPut } = await relayWithPublisher();
  await backend.run(async (ctx) => {
    const device = (await ctx.db.query("devices").collect())[0]!;
    await ctx.db.patch(device._id, {
      pushToken: "contract-push-token", preferences: { ...defaultNotificationPreferences, notificationsEnabled: true },
    });
  });
  const { snapshot, notificationAlert, notificationCategory } = JSON.parse(fixture("relay-approval-alert")) as {
    snapshot: { snapshotId: string; states: Record<string, unknown>[] }; notificationAlert: Record<string, string>;
    notificationCategory: string;
  };
  const path = publisherPath("prf_default", "snapshot");
  const running = JSON.parse(fixture("publisher-snapshot")) as { states: { revision: number; eventId: string }[] };
  running.states[0]!.revision -= 1;
  running.states[0]!.eventId = `snapshot:${String(running.states[0]!.revision)}:contract-session`;
  expect((await signedPut(path, JSON.stringify(running))).status).toBe(200);
  expect((await signedPut(path, JSON.stringify(snapshot))).status).toBe(200);
  const scheduled = await backend.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  for (const job of scheduled) {
    if (job.name === "delivery:recompute") await backend.mutation(internal.delivery.recompute, (job.args as [never])[0]);
  }
  const notifications = (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect()))
    .filter((job) => job.kind === "notification");
  expect(notifications).toHaveLength(1);
  const payload = JSON.parse(notifications[0]!.request.payloadJson);
  expect(payload.aps.alert).toEqual(notificationAlert);
  expect(payload.aps.category).toBe(notificationCategory);
  expect(payload.approvalHeadId).toBe(snapshot.states[0]!.approvalHeadId);
  expect(notifications[0]!.request.payloadJson).not.toContain("Contract fixture");
  // The head is bounded and opaque; anything else rejects the whole snapshot.
  for (const head of ["", "x".repeat(65), "has/slash", 7]) {
    for (const field of ["approvalHeadId", "inputHeadId"]) {
      const invalid = { ...snapshot, states: [{ ...snapshot.states[0], [field]: head }] };
      expect((await signedPut(path, JSON.stringify(invalid))).status).toBe(400);
    }
  }
});

// TAL-873: a turn a finished sub-agent or background process started (`origin: "background"`) completes without an alert
// unless the device turns background alerts on; its approval and failure alerts, and user turns, still alert.
it.each([
  ["mutes a background completion by default", "background", "completed", {}, []],
  ["alerts a background completion once the device opts in", "background", "completed", { notifyOnBackground: true }, ["Completed on Contract publisher"]],
  ["still alerts a background failure", "background", "failed", {}, ["Failed on Contract publisher"]],
  ["still alerts a background approval", "background", "waiting_for_approval", {}, ["An agent run is waiting for your approval."]],
  ["still alerts a user completion", "user", "completed", {}, ["Completed on Contract publisher"]],
] as const)("%s", async (_, origin, phase, preferences, expected) => {
  const { backend, signedPut } = await relayWithPublisher();
  await backend.run(async (ctx) => {
    const device = (await ctx.db.query("devices").collect())[0]!;
    await ctx.db.patch(device._id, {
      pushToken: "contract-push-token", preferences: { ...defaultNotificationPreferences, notificationsEnabled: true, ...preferences },
    });
  });
  const path = publisherPath("prf_default", "snapshot");
  const publish = async (revision: number, statePhase: string) => {
    const body = JSON.parse(fixture("publisher-snapshot")) as { snapshotId: string; states: Record<string, unknown>[] };
    const state = body.states[0]!;
    delete state.alertEligible;
    Object.assign(state, {
      origin, phase: statePhase, activityPhase: statePhase, revision, eventId: `snapshot:${String(revision)}:contract-session`,
      ...(statePhase === "waiting_for_approval" ? { approvalHeadId: "contract-head" } : {}),
    });
    body.snapshotId = `contract-snapshot-${String(revision)}`;
    expect((await signedPut(path, JSON.stringify(body))).status).toBe(200);
  };
  await publish(now - 1, "running");
  await publish(now, phase);
  const scheduled = await backend.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  for (const job of scheduled) {
    if (job.name === "delivery:recompute") await backend.mutation(internal.delivery.recompute, (job.args as [never])[0]);
  }
  const alerts = (await backend.run((ctx) => ctx.db.query("deliveryJobs").collect()))
    .filter((job) => job.kind === "notification")
    .map((job) => (JSON.parse(job.request.payloadJson) as { aps: { alert: { body?: string; "loc-key"?: string } } }).aps.alert)
    .map((alert) => alert.body ?? alert["loc-key"]);
  expect(alerts).toEqual(expected);
});
