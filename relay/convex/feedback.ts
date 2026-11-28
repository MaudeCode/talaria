import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { consumeBudget, longestBudgetWindowMs, type Budget } from "./auth";
import { attachmentLimits, operatorAccess } from "./lib/feedback";
import { timingSafeEqual } from "./lib/crypto";
import { authorizePublisherMutation } from "./publishers";
import {
  feedbackAttachmentRefusalValidator,
  feedbackAttachmentTypeValidator,
  feedbackDeliveryFailureStageValidator,
  feedbackPayloadValidator,
  feedbackTierValidator,
} from "./lib/validators";

const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const megabyte = 1_000_000;
const allTiers: Budget = { key: "feedback:global", windowMs: day, limit: 1_000 };
const uploadWindowMs = 30 * 60 * 1_000;
const deliveryRetryMs = 120_000;
/** Admission refuses attachments that would take stored bytes past this. */
const storedBytesCeiling = 2_000 * megabyte;

const admissionValidator = v.union(
  v.object({ index: v.number(), status: v.literal("accepted"), expiresAt: v.number() }),
  v.object({ index: v.number(), status: v.literal("refused"), reason: feedbackAttachmentRefusalValidator }),
  v.object({ index: v.number(), status: v.union(v.literal("stored"), v.literal("missing")) }),
);
type Admission = Infer<typeof admissionValidator>;

const uploadRefusalValidator = v.union(
  v.object({ status: v.literal("unauthorized") }),
  v.object({ status: v.literal("expired") }),
);

async function attachmentsOf(ctx: { db: QueryCtx["db"] }, reportId: Id<"feedbackReports">) {
  return await ctx.db.query("feedbackAttachments")
    .withIndex("by_report_id_and_index", (query) => query.eq("reportId", reportId))
    .collect();
}

async function attachmentAt(ctx: { db: QueryCtx["db"] }, reportId: string, index: number) {
  const id = ctx.db.normalizeId("feedbackReports", reportId);
  return id && await ctx.db.query("feedbackAttachments")
    .withIndex("by_report_id_and_index", (query) => query.eq("reportId", id).eq("index", index))
    .unique();
}

async function storedBytes(ctx: { db: QueryCtx["db"] }) {
  return (await ctx.db.query("feedbackAttachmentUsage").first())?.storedBytes ?? 0;
}

async function addStoredBytes(ctx: MutationCtx, delta: number) {
  const usage = await ctx.db.query("feedbackAttachmentUsage").first();
  if (usage) await ctx.db.patch(usage._id, { storedBytes: Math.max(0, usage.storedBytes + delta) });
  else await ctx.db.insert("feedbackAttachmentUsage", { storedBytes: Math.max(0, delta) });
}

/** Deletes an attachment's blob, if any, and its bytes from the stored total; the caller updates or deletes the row. */
export async function deleteBlob(ctx: MutationCtx, attachment: Doc<"feedbackAttachments">) {
  if (!attachment.storageId) return;
  await ctx.storage.delete(attachment.storageId);
  await addStoredBytes(ctx, -attachment.bytes);
}

export async function deleteAttachments(ctx: MutationCtx, reportId: Id<"feedbackReports">) {
  for (const attachment of await attachmentsOf(ctx, reportId)) {
    await deleteBlob(ctx, attachment);
    await ctx.db.delete(attachment._id);
  }
}

/** A replay reissues tokens for attachments still awaiting upload; it never charges a budget or moves the deadline. */
async function replayAdmissions(
  ctx: MutationCtx,
  report: Doc<"feedbackReports">,
  tokenHashes: readonly string[],
  now: number,
): Promise<Admission[]> {
  const admissions: Admission[] = [];
  for (const attachment of await attachmentsOf(ctx, report._id)) {
    const { index, status, uploadExpiresAt } = attachment;
    if (status === "refused") {
      admissions.push({ index, status, reason: attachment.reason ?? "quota" });
    } else if (status === "awaiting" && uploadExpiresAt !== undefined && uploadExpiresAt > now) {
      await ctx.db.patch(attachment._id, { tokenHash: tokenHashes[index] });
      admissions.push({ index, status: "accepted", expiresAt: uploadExpiresAt });
    } else {
      admissions.push({ index, status: status === "stored" ? "stored" : "missing" });
    }
  }
  return admissions;
}

function diagnosticChunks(ctx: { db: QueryCtx["db"] }, reportId: Id<"feedbackReports">) {
  return ctx.db.query("feedbackDiagnosticChunks")
    .withIndex("by_report_and_index", (q) => q.eq("reportId", reportId)).collect();
}

async function deleteDiagnosticReports(ctx: MutationCtx, reportId: Id<"feedbackReports">) {
  const chunks = await diagnosticChunks(ctx, reportId);
  for (const chunk of chunks) await ctx.db.delete(chunk._id);
  if (chunks.length) await addStoredBytes(ctx, -chunks.reduce((bytes, chunk) => bytes + chunk.bytes.byteLength, 0));
}

export const pruneDiagnosticReports = internalMutation({
  args: { reportId: v.id("feedbackReports") },
  returns: v.null(),
  handler: async (ctx, { reportId }) => {
    await deleteDiagnosticReports(ctx, reportId);
    return null;
  },
});

export const getDiagnosticReports = internalQuery({
  args: { reportId: v.string() },
  returns: v.array(v.bytes()),
  handler: async (ctx, { reportId }) => {
    const id = ctx.db.normalizeId("feedbackReports", reportId);
    const report = id ? await ctx.db.get(id) : null;
    if (report?.status !== "pending" || !report.hasDiagnosticReports) return [];
    return (await diagnosticChunks(ctx, report._id)).map((chunk) => chunk.bytes);
  },
});

export const submit = internalMutation({
  args: {
    payload: feedbackPayloadValidator,
    diagnosticReports: v.optional(v.bytes()),
    payloadHash: v.string(),
    installHash: v.string(),
    /** SHA-256 hex of a fresh upload token per manifest entry, in manifest order. */
    uploadTokenHashes: v.array(v.string()),
    attachmentsDisabled: v.boolean(),
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
    v.object({
      status: v.literal("accepted"),
      reportId: v.id("feedbackReports"),
      attachments: v.optional(v.array(admissionValidator)),
    }),
    v.object({ status: v.literal("idempotency_conflict") }),
    v.object({ status: v.literal("rate_limited"), retryAfterMs: v.number() }),
    v.object({ status: v.literal("unauthorized") }),
    v.object({ status: v.literal("diagnostics_disabled") }),
  ),
  handler: async (ctx, args) => {
    if (args.publisher) {
      const authorized = await authorizePublisherMutation(ctx, args.publisher);
      if (!authorized || authorized === "replay") return { status: "unauthorized" as const };
    }
    if (args.diagnosticReports && !args.publisher) return { status: "unauthorized" as const };
    const manifest = args.payload.attachments;
    const existing = await ctx.db.query("feedbackReports")
      .withIndex("by_request_id", (query) => query.eq("requestId", args.payload.requestId))
      .unique();
    if (existing) {
      if (existing.payloadHash !== args.payloadHash) return { status: "idempotency_conflict" as const };
      return {
        status: "accepted" as const,
        reportId: existing._id,
        ...(manifest ? { attachments: await replayAdmissions(ctx, existing, args.uploadTokenHashes, args.now) } : {}),
      };
    }
    const publisher = args.publisher;
    const tier = publisher ? "verified" as const : "unverified" as const;
    // Registrations are per owner and origin, so another account registering the same origin gets its own budget.
    // The owner's own budget is charged too, so registering more origins buys no more quota.
    const owner = publisher?.publisherOwnerUserId;
    const publisherKey = publisher && `${owner}:${publisher.publisherId}`;
    const budget = await consumeBudget(ctx, args.now, publisherKey
      ? [
          { key: `feedback:pub:${publisherKey}`, windowMs: hour, limit: 20 },
          { key: `feedback:owner:${owner}`, windowMs: hour, limit: 20 },
          allTiers,
        ]
      : [
          { key: `feedback:install:${args.installHash}`, windowMs: hour, limit: 5 },
          { key: "feedback:unverified", windowMs: day, limit: 200 },
          allTiers,
        ]);
    if (!budget.ok) return { status: "rate_limited" as const, retryAfterMs: budget.retryAfterMs };

    // Attachment bytes have their own budgets; a refused attachment is charged nothing and never refuses the text.
    // Only verified reports may attach files, so only a publisher registration has a byte budget of its own.
    const byteBudgets: Budget[] = [
      ...(publisherKey ? [
        { key: `feedback-bytes:pub:${publisherKey}`, windowMs: day, limit: 200 * megabyte },
        { key: `feedback-bytes:owner:${owner}`, windowMs: day, limit: 200 * megabyte },
      ] : []),
      { key: "feedback-bytes:global", windowMs: day, limit: 600 * megabyte },
      { key: "feedback-bytes:global:30d", windowMs: longestBudgetWindowMs, limit: 6_000 * megabyte },
    ];
    // ponytail: the ceiling counts stored bytes plus this admission, not other reports' unfinished uploads;
    // the 600 MB daily budget bounds that overshoot.
    let committed = await storedBytes(ctx);
    const diagnosticBytes = args.diagnosticReports?.byteLength ?? 0;
    if (diagnosticBytes) {
      if (args.attachmentsDisabled) return { status: "diagnostics_disabled" as const };
      if (committed + diagnosticBytes > storedBytesCeiling) return { status: "rate_limited" as const, retryAfterMs: hour };
      const diagnosticsBudget = await consumeBudget(ctx, args.now, byteBudgets.map((budget) => ({
        ...budget, cost: diagnosticBytes,
      })));
      if (!diagnosticsBudget.ok) return { status: "rate_limited" as const, retryAfterMs: diagnosticsBudget.retryAfterMs };
      committed += diagnosticBytes;
      await addStoredBytes(ctx, diagnosticBytes);
    }
    const admissions: Admission[] = [];
    for (const [index, entry] of (manifest ?? []).entries()) {
      const kind = attachmentLimits.types[entry.contentType].kind;
      const reason = args.attachmentsDisabled
        ? "disabled" as const
        : !(attachmentLimits.tierKinds[tier] as readonly string[]).includes(kind)
          ? "tier" as const
          : committed + entry.bytes > storedBytesCeiling
            || !(await consumeBudget(ctx, args.now, byteBudgets.map((byteBudget) => ({ ...byteBudget, cost: entry.bytes })))).ok
            ? "quota" as const
            : null;
      if (reason) {
        admissions.push({ index, status: "refused", reason });
      } else {
        committed += entry.bytes;
        admissions.push({ index, status: "accepted", expiresAt: args.now + uploadWindowMs });
      }
    }
    const uploading = admissions.some((admission) => admission.status === "accepted");
    const reportId = await ctx.db.insert("feedbackReports", {
      requestId: args.payload.requestId,
      payloadHash: args.payloadHash,
      tier,
      publisherId: publisher?.publisherId,
      installHash: args.installHash,
      payload: args.payload,
      ...(args.diagnosticReports ? { hasDiagnosticReports: true } : {}),
      status: uploading ? "uploading" : "pending",
      createdAt: args.now,
      queuedAt: args.now,
    });
    // Relay documents are limited to 1 MiB. Keep large diagnostics out of the pending list.
    if (args.diagnosticReports) {
      const chunkSize = 512 * 1024;
      for (let offset = 0; offset < args.diagnosticReports.byteLength; offset += chunkSize) {
        await ctx.db.insert("feedbackDiagnosticChunks", {
          reportId, index: offset / chunkSize, bytes: args.diagnosticReports.slice(offset, offset + chunkSize),
        });
      }
    }
    for (const [index, entry] of (manifest ?? []).entries()) {
      const admission = admissions[index]!;
      await ctx.db.insert("feedbackAttachments", {
        reportId,
        index,
        ...entry,
        createdAt: args.now,
        ...(admission.status === "accepted"
          ? { status: "awaiting" as const, tokenHash: args.uploadTokenHashes[index], uploadExpiresAt: admission.expiresAt }
          : { status: "refused" as const, reason: admission.status === "refused" ? admission.reason : undefined }),
      });
    }
    if (uploading) {
      await ctx.scheduler.runAt(args.now + uploadWindowMs, internal.feedback.closeUploads, { reportId });
    }
    return { status: "accepted" as const, reportId, ...(manifest ? { attachments: admissions } : {}) };
  },
});

const uploadTargetArgs = { reportId: v.string(), index: v.number(), tokenHash: v.string(), now: v.number() };

/** The awaiting attachment this bearer may upload; a wrong, consumed, or other report's token is unauthorized. */
async function uploadTarget(
  ctx: { db: QueryCtx["db"] },
  args: { reportId: string; index: number; tokenHash: string; now: number },
): Promise<Doc<"feedbackAttachments"> | "unauthorized" | "expired"> {
  const attachment = await attachmentAt(ctx, args.reportId, args.index);
  if (attachment?.status !== "awaiting" || !attachment.tokenHash || !timingSafeEqual(attachment.tokenHash, args.tokenHash)) {
    return "unauthorized";
  }
  return (attachment.uploadExpiresAt ?? 0) > args.now ? attachment : "expired";
}

export const uploadSlot = internalQuery({
  args: uploadTargetArgs,
  returns: v.union(
    v.object({ status: v.literal("ok"), contentType: feedbackAttachmentTypeValidator, bytes: v.number(), sha256: v.string() }),
    uploadRefusalValidator,
  ),
  handler: async (ctx, args) => {
    const target = await uploadTarget(ctx, args);
    if (typeof target === "string") return { status: target };
    return { status: "ok" as const, contentType: target.contentType, bytes: target.bytes, sha256: target.sha256 };
  },
});

/** Records a verified blob and consumes its token; the report joins the queue once nothing awaits upload. */
export const recordUpload = internalMutation({
  args: { ...uploadTargetArgs, storageId: v.id("_storage") },
  returns: v.union(v.object({ status: v.literal("stored") }), uploadRefusalValidator),
  handler: async (ctx, args) => {
    const target = await uploadTarget(ctx, args);
    if (typeof target === "string") return { status: target };
    await ctx.db.patch(target._id, { status: "stored", storageId: args.storageId, tokenHash: undefined });
    await addStoredBytes(ctx, target.bytes);
    const awaiting = (await attachmentsOf(ctx, target.reportId)).some((attachment) => attachment.status === "awaiting");
    const report = await ctx.db.get(target.reportId);
    if (!awaiting && report?.status === "uploading") await ctx.db.patch(report._id, { status: "pending" });
    return { status: "stored" as const };
  },
});

/** Scheduled at the upload deadline: unfinished uploads become `missing` and the report joins the queue. */
export const closeUploads = internalMutation({
  args: { reportId: v.id("feedbackReports") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (report?.status !== "uploading") return null;
    for (const attachment of await attachmentsOf(ctx, report._id)) {
      if (attachment.status === "awaiting") await ctx.db.patch(attachment._id, { status: "missing", tokenHash: undefined });
    }
    await ctx.db.patch(report._id, { status: "pending" });
    return null;
  },
});

function readyReports(ctx: QueryCtx, limit: number) {
  // Existing rows without queuedAt retain their original createdAt order until their first retry.
  return ctx.db.query("feedbackReports")
    .withIndex("by_status_and_retry_at_and_queued_at_and_created_at", (query) =>
      query.eq("status", "pending").eq("retryAt", undefined))
    .take(limit);
}

export const listPending = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.object({
    reportId: v.id("feedbackReports"),
    tier: feedbackTierValidator,
    publisherId: v.optional(v.string()),
    createdAt: v.number(),
    payload: feedbackPayloadValidator,
    hasDiagnosticReports: v.optional(v.boolean()),
    attachments: v.array(v.object({
      index: v.number(),
      contentType: feedbackAttachmentTypeValidator,
      bytes: v.number(),
      sha256: v.string(),
      status: v.union(v.literal("stored"), v.literal("missing"), v.literal("refused")),
      reason: v.optional(feedbackAttachmentRefusalValidator),
    })),
  })),
  handler: async (ctx, args) => {
    const reports = await readyReports(ctx, args.limit);
    return await Promise.all(reports.map(async (report) => ({
      reportId: report._id,
      tier: report.tier,
      publisherId: report.publisherId,
      createdAt: report.createdAt,
      payload: report.payload,
      hasDiagnosticReports: report.hasDiagnosticReports,
      attachments: (await attachmentsOf(ctx, report._id)).map(({ index, contentType, bytes, sha256, status, reason }) => ({
        index, contentType, bytes, sha256, status: status === "awaiting" ? "missing" as const : status, reason,
      })),
    })));
  },
});

export const queueStatus = internalQuery({
  args: {},
  returns: v.object({
    oldestPendingCreatedAt: v.union(v.number(), v.null()),
    lastSuccessfulDeliveryAt: v.union(v.number(), v.null()),
    failureStage: v.union(feedbackDeliveryFailureStageValidator, v.null()),
  }),
  handler: async (ctx) => {
    const [oldest, deliveryState, latestDelivery, failed] = await Promise.all([
      ctx.db.query("feedbackReports")
        .withIndex("by_status_and_created_at", (q) => q.eq("status", "pending")).first(),
      ctx.db.query("feedbackDeliveryState").unique(),
      ctx.db.query("feedbackReports")
        .withIndex("by_status_and_delivered_at", (q) => q.eq("status", "delivered").gt("deliveredAt", undefined))
        .order("desc").first(),
      ctx.db.query("feedbackReports")
        .withIndex("by_status_and_delivery_failure_stage", (q) => q.eq("status", "pending").gt("deliveryFailureStage", undefined))
        .first(),
    ]);
    // A bridge can already have delivered reports before this version first records a timestamp.
    const lastSuccessfulDeliveryAt = deliveryState
      ? Math.max(deliveryState.lastSuccessfulDeliveryAt, latestDelivery?.deliveredAt ?? 0)
      : latestDelivery?.deliveredAt ?? null;
    return {
      oldestPendingCreatedAt: oldest?.createdAt ?? null,
      lastSuccessfulDeliveryAt,
      failureStage: failed?.deliveryFailureStage ?? null,
    };
  },
});

/**
 * The feedback bridge subscribes over Convex's WebSocket to learn when a report is ready to deliver or retry.
 * Operator-only; IDs only.
 */
export const pendingSignal = query({
  args: { token: v.string() },
  returns: v.array(v.id("feedbackReports")),
  handler: async (ctx, args) => {
    if (await operatorAccess(args.token) !== "granted") throw new ConvexError("unauthorized");
    const reports = await readyReports(ctx, 50);
    return reports.map((report) => report._id);
  },
});

export const deferDelivery = internalMutation({
  args: { reportId: v.string(), failureStage: v.optional(feedbackDeliveryFailureStageValidator) },
  returns: v.boolean(),
  handler: async (ctx, { reportId, failureStage }) => {
    const id = ctx.db.normalizeId("feedbackReports", reportId);
    const report = id ? await ctx.db.get(id) : null;
    if (!report) return false;
    if (report.status !== "pending") return true;
    if (report.retryAt === undefined) {
      const retryAt = Date.now() + deliveryRetryMs;
      await ctx.db.patch(report._id, { retryAt, queuedAt: retryAt, deliveryFailureStage: failureStage ?? report.deliveryFailureStage });
      // A database write at expiry wakes the WebSocket subscription, even with no new submissions.
      await ctx.scheduler.runAt(retryAt, internal.feedback.resumeDelivery, { reportId: report._id, retryAt });
    } else if (failureStage !== undefined && failureStage !== report.deliveryFailureStage) {
      await ctx.db.patch(report._id, { deliveryFailureStage: failureStage });
    }
    return true;
  },
});

export const resumeDelivery = internalMutation({
  args: { reportId: v.id("feedbackReports"), retryAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { reportId, retryAt }) => {
    const report = await ctx.db.get(reportId);
    if (report?.status === "pending" && report.retryAt === retryAt) {
      await ctx.db.patch(reportId, { retryAt: undefined });
    }
    return null;
  },
});

export const storedAttachment = internalQuery({
  args: { reportId: v.string(), index: v.number() },
  returns: v.union(v.null(), v.id("_storage")),
  handler: async (ctx, args) => {
    return (await attachmentAt(ctx, args.reportId, args.index))?.storageId ?? null;
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
    await ctx.db.patch(report._id, { status: "delivered", ticketKey: args.ticketKey, deliveredAt: args.now, deliveryFailureStage: undefined });
    const deliveryState = await ctx.db.query("feedbackDeliveryState").unique();
    if (!deliveryState) await ctx.db.insert("feedbackDeliveryState", { lastSuccessfulDeliveryAt: args.now });
    else if (args.now > deliveryState.lastSuccessfulDeliveryAt) {
      await ctx.db.patch(deliveryState._id, { lastSuccessfulDeliveryAt: args.now });
    }
    // The bridge has copied the files by now, so Relay keeps none past delivery.
    await deleteAttachments(ctx, report._id);
    if (report.hasDiagnosticReports) await deleteDiagnosticReports(ctx, report._id);
    return { status: "delivered" as const };
  },
});
