import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const expiredPerCategory = 250;

// Tests drain scheduled work explicitly; continuations must not outlive their test.
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(1_800_000_000_000)); });
afterEach(() => { vi.useRealTimers(); });

async function fixture(expired = expiredPerCategory) {
  const backend = convexTest(schema, modules);
  workpoolTest.register(backend, "apnsWorkpool");
  const now = Date.now();
  await backend.run(async (ctx) => {
    await ctx.db.insert("publishers", { version: 2, ownerUserId: "owner", publisherId: "https://hermes.example", label: "Test", enabled: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("publisherKeys", { version: 2, ownerUserId: "owner", publisherId: "https://hermes.example", keyId: "key", publicKey: "test", activatedAt: now, createdAt: now });
    for (let index = 0; index < expired; index += 1) {
      await ctx.db.insert("publisherNonces", { version: 2, ownerUserId: "owner", publisherId: "https://hermes.example", nonce: `expired-${index}`, expiresAt: now - 1, createdAt: now - 100 });
      await ctx.db.insert("appleIdentityTokens", { tokenHash: `apple-${index}`, expiresAt: now - 1, createdAt: now - 100 });
      await ctx.db.insert("publisherInvitations", { userId: "user", tokenHash: `invite-${index}`, expiresAt: now - 1, createdAt: now - 100 });
      await ctx.db.insert("userSessions", { userId: "user", sessionId: `session-${index}`, tokenHash: `token-${index}`, expiresAt: now - 1, createdAt: now - 100 });
    }
  });
  const signed = (nonce: string) => backend.mutation(internal.publishers.acceptSnapshot, {
    publisherOwnerUserId: "owner", publisherId: "https://hermes.example", profileId: "profile", keyId: "key",
    nonce, nonceExpiresAt: Date.now() + 60_000, receivedAt: Date.now(), snapshotId: nonce, states: [],
  });
  const remaining = () => backend.run(async (ctx) => ({
    nonces: (await ctx.db.query("publisherNonces").collect()).map((row) => row.nonce).filter((nonce) => nonce.startsWith("expired-")).length,
    appleTokens: (await ctx.db.query("appleIdentityTokens").collect()).length,
    invitations: (await ctx.db.query("publisherInvitations").collect()).length,
    userSessions: (await ctx.db.query("userSessions").collect()).length,
  }));
  const pendingPrunes = () => backend.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name.startsWith("cleanup") && job.state.kind === "pending"));
  const drain = () => backend.finishAllScheduledFunctions(vi.runAllTimers);
  return { backend, signed, remaining, pendingPrunes, drain };
}

const each = (count: number) => ({ nonces: count, appleTokens: count, invitations: count, userSessions: count });

it("drains every full expiration batch from one trigger while keeping fresh nonces replay-protected", async () => {
  const { backend, signed, remaining, pendingPrunes, drain } = await fixture();
  expect(await signed("fresh")).toEqual({ status: "accepted" });

  await expect(backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({ deleted: 400, revokedDevices: 0 });
  expect(await remaining()).toEqual(each(expiredPerCategory - 100));
  expect(await pendingPrunes()).toHaveLength(1);
  expect(await signed("fresh")).toEqual({ status: "replay" });

  await drain();
  expect(await remaining()).toEqual(each(0));
  expect(await pendingPrunes()).toEqual([]);
  expect(await signed("fresh")).toEqual({ status: "replay" });
});

it("terminates empty and partially full queues without a continuation", async () => {
  const empty = await fixture(0);
  await expect(empty.backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({ deleted: 0, revokedDevices: 0 });
  expect(await empty.pendingPrunes()).toEqual([]);

  const partial = await fixture(40);
  await expect(partial.backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({ deleted: 160, revokedDevices: 0 });
  expect(await partial.remaining()).toEqual(each(0));
  expect(await partial.pendingPrunes()).toEqual([]);
});

it("keeps one drain owner across repeated and simultaneous triggers", async () => {
  const { backend, remaining, pendingPrunes, drain } = await fixture();
  await Promise.all([1, 2, 3].map(() => backend.mutation(internal.cleanup.prune, {})));
  expect(await remaining()).toEqual(each(expiredPerCategory - 100));
  expect(await pendingPrunes()).toHaveLength(1);

  await expect(backend.mutation(internal.cleanup.prune, {})).resolves.toEqual({ deleted: 0, revokedDevices: 0 });
  expect(await pendingPrunes()).toHaveLength(1);

  await drain();
  expect(await remaining()).toEqual(each(0));
});

it("ignores superseded continuations and lets the next trigger resume an interrupted drain", async () => {
  const { backend, remaining, pendingPrunes, drain } = await fixture();
  await backend.mutation(internal.cleanup.prune, {});
  const [interrupted] = await pendingPrunes();
  await backend.run((ctx) => ctx.scheduler.cancel(interrupted!._id));
  await expect(backend.mutation(internal.cleanup.prune, { generation: 0 })).resolves.toEqual({ deleted: 0, revokedDevices: 0 });
  expect(await remaining()).toEqual(each(expiredPerCategory - 100));

  await backend.mutation(internal.cleanup.prune, {});
  expect(await remaining()).toEqual(each(expiredPerCategory - 200));
  expect(await pendingPrunes()).toHaveLength(1);
  await drain();
  expect(await remaining()).toEqual(each(0));
});
