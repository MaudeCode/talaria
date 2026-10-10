"use node";

import { NonRetryableError } from "@convex-dev/workpool";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { apnsDeliveryResultValidator } from "./lib/validators";
import {
  classifyApnsFailure,
  makeProviderToken,
  sendWithTransport,
} from "./lib/apnsTransport.node";

let cachedProviderToken: { cacheKey: string; token: string; issuedAt: number } | undefined;

export const preflight = internalAction({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: async () => {
    const teamId = process.env.APNS_TEAM_ID?.trim();
    const keyId = process.env.APNS_KEY_ID?.trim();
    const privateKey = process.env.APNS_PRIVATE_KEY?.trim();
    if (!teamId || !keyId || !privateKey) return { ok: false };
    try {
      makeProviderToken({ teamId, keyId, privateKey, issuedAt: Math.floor(Date.now() / 1_000) });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
});

export const sendJob = internalAction({
  args: { jobId: v.id("deliveryJobs") },
  returns: apnsDeliveryResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const claimed = await ctx.runMutation(internal.delivery.claimJob, { jobId: args.jobId, now });
    if (claimed.status === "stale") return { outcome: "stale" as const };

    const teamId = process.env.APNS_TEAM_ID?.trim();
    const keyId = process.env.APNS_KEY_ID?.trim();
    const privateKey = process.env.APNS_PRIVATE_KEY?.trim();
    if (!teamId || !keyId || !privateKey) {
      throw new NonRetryableError("APNs credentials are not configured");
    }

    const cacheKey = `${teamId}:${keyId}`;
    const nowSeconds = Math.floor(now / 1_000);
    let providerToken = cachedProviderToken?.cacheKey === cacheKey
      ? cachedProviderToken.token
      : undefined;
    if (!providerToken || nowSeconds - cachedProviderToken!.issuedAt >= 45 * 60) {
      providerToken = makeProviderToken({ teamId, keyId, privateKey, issuedAt: nowSeconds });
      cachedProviderToken = { cacheKey, token: providerToken, issuedAt: nowSeconds };
    }

    const response = await sendWithTransport(
      { ...claimed.request, stateFingerprint: claimed.stateFingerprint },
      providerToken,
    );
    if (response.status >= 200 && response.status < 300) {
      await ctx.runMutation(internal.delivery.markDelivered, {
        jobId: args.jobId,
        apnsStatus: response.status,
        apnsId: response.apnsId,
        now: Date.now(),
      });
      return { outcome: "delivered" as const, status: response.status, apnsId: response.apnsId };
    }

    const failure = classifyApnsFailure(response);
    if (failure.retry) {
      throw new Error(`APNs ${response.status}: ${response.reason ?? "transient failure"}`);
    }
    await ctx.runMutation(internal.delivery.markPermanentFailure, {
      jobId: args.jobId,
      apnsStatus: response.status,
      error: response.reason ?? "APNs rejected the request",
      invalidateToken: failure.invalidateToken,
      now: Date.now(),
    });
    return { outcome: "permanent_failure" as const, status: response.status, apnsId: response.apnsId };
  },
});
