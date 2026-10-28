import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { consumeBudget, longestBudgetWindowMs, type Budget } from "./auth";
import { authorizePublisherMutation } from "./publishers";
import { feedbackPayloadValidator, feedbackTierValidator } from "./lib/validators";

const hour = 60 * 60 * 1_000;
const day = longestBudgetWindowMs;
const allTiers: Budget = { key: "feedback:global", windowMs: day, limit: 1_000 };

export const submit = internalMutation({
  args: {
    payload: feedbackPayloadValidator,
    payloadHash: v.string(),
    installHash: v.string(),
    now: v.number(),
    publisher: v.optional(v.object({
      publisherOwnerUserId: v.string(),
      publisherId: v.string(),
      keyId: v.string(),
      nonce: v.string(),
      nonceExpiresAt: v.number(),
      receivedAt: v.number(),
    })),
  },
  returns: v.union(
    v.object({ status: v.literal("accepted"), reportId: v.id("feedbackReports") }),
    v.object({ status: v.literal("idempotency_conflict") }),
    v.object({ status: v.literal("rate_limited"), retryAfterMs: v.number() }),
    v.object({ status: v.literal("unauthorized") }),
  ),
  handler: async (ctx, args) => {
    if (args.publisher) {
      const authorized = await authorizePublisherMutation(ctx, args.publisher);
      if (!authorized || authorized === "replay") return { status: "unauthorized" as const };
    }
    const existing = await ctx.db.query("feedbackReports")
      .withIndex("by_request_id", (query) => query.eq("requestId", args.payload.requestId))
      .unique();
    if (existing) {
      return existing.payloadHash === args.payloadHash
        ? { status: "accepted" as const, reportId: existing._id }
        : { status: "idempotency_conflict" as const };
    }
    const budget = await consumeBudget(ctx, args.now, args.publisher
      ? [{ key: `feedback:pub:${args.publisher.publisherId}`, windowMs: hour, limit: 20 }, allTiers]
      : [
          { key: `feedback:install:${args.installHash}`, windowMs: hour, limit: 5 },
          { key: "feedback:unverified", windowMs: day, limit: 200 },
          allTiers,
        ]);
    if (!budget.ok) return { status: "rate_limited" as const, retryAfterMs: budget.retryAfterMs };
    const reportId = await ctx.db.insert("feedbackReports", {
      requestId: args.payload.requestId,
      payloadHash: args.payloadHash,
      tier: args.publisher ? "verified" : "unverified",
      publisherId: args.publisher?.publisherId,
      installHash: args.installHash,
      payload: args.payload,
      status: "pending",
      createdAt: args.now,
    });
    return { status: "accepted" as const, reportId };
  },
});

export const listPending = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.object({
    reportId: v.id("feedbackReports"),
    tier: feedbackTierValidator,
    publisherId: v.optional(v.string()),
    createdAt: v.number(),
    payload: feedbackPayloadValidator,
  })),
  handler: async (ctx, args) => {
    const reports = await ctx.db.query("feedbackReports")
      .withIndex("by_status_and_created_at", (query) => query.eq("status", "pending"))
      .take(args.limit);
    return reports.map((report) => ({
      reportId: report._id,
      tier: report.tier,
      publisherId: report.publisherId,
      createdAt: report.createdAt,
      payload: report.payload,
    }));
  },
});

export const acknowledge = internalMutation({
  args: { reportId: v.string(), ticketKey: v.string(), now: v.number() },
  returns: v.union(
    v.object({ status: v.literal("delivered") }),
    v.object({ status: v.literal("not_found") }),
    v.object({ status: v.literal("ticket_key_conflict") }),
  ),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("feedbackReports", args.reportId);
    const report = id ? await ctx.db.get(id) : null;
    if (!report) return { status: "not_found" as const };
    if (report.status === "delivered") {
      return report.ticketKey === args.ticketKey
        ? { status: "delivered" as const }
        : { status: "ticket_key_conflict" as const };
    }
    await ctx.db.patch(report._id, { status: "delivered", ticketKey: args.ticketKey, deliveredAt: args.now });
    return { status: "delivered" as const };
  },
});
