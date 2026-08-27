import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const prune = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const oldJobCutoff = now - 7 * 24 * 60 * 60 * 1_000;
    const [nonces, enrollments, sessions, doneJobs, deadJobs, staleJobs] = await Promise.all([
      ctx.db
        .query("publisherNonces")
        .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
        .take(100),
      ctx.db
        .query("enrollmentCodes")
        .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
        .take(100),
      ctx.db
        .query("sessionStates")
        .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
        .take(100),
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) =>
          query.eq("status", "done").lt("updatedAt", oldJobCutoff),
        )
        .take(100),
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) =>
          query.eq("status", "dead").lt("updatedAt", oldJobCutoff),
        )
        .take(100),
      ctx.db
        .query("deliveryJobs")
        .withIndex("by_status_and_updated_at", (query) =>
          query.eq("status", "stale").lt("updatedAt", oldJobCutoff),
        )
        .take(100),
    ]);
    const documents = [...nonces, ...enrollments, ...sessions, ...doneJobs, ...deadJobs, ...staleJobs];
    for (const document of documents) await ctx.db.delete(document._id);
    if (sessions.length > 0) await ctx.scheduler.runAfter(0, internal.delivery.recompute, {});
    return { deleted: documents.length };
  },
});
