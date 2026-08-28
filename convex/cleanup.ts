import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const prune = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), revokedDevices: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const oldJobCutoff = now - 7 * 24 * 60 * 60 * 1_000;
    const retiredCutoff = now - 30 * 24 * 60 * 60 * 1_000;
    const [nonces, userSessions, appleTokens, invitations, sessions, doneJobs, keys, pendingKeys, devices, activities, deadJobs, staleJobs] = await Promise.all([
      ctx.db
        .query("publisherNonces")
        .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
        .take(100),
      ctx.db
        .query("userSessions")
        .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
        .take(100),
      ctx.db
        .query("appleIdentityTokens")
        .withIndex("by_expires_at", (query) => query.lt("expiresAt", now))
        .take(100),
      ctx.db
        .query("publisherInvitations")
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
        .query("publisherKeys")
        .withIndex("by_revoked_at", (query) =>
          query.gt("revokedAt", 0).lt("revokedAt", retiredCutoff),
        )
        .take(100),
      ctx.db
        .query("publisherKeys")
        .withIndex("by_activated_at_and_created_at", (query) =>
          query.eq("activatedAt", undefined).lt("createdAt", retiredCutoff),
        )
        .take(100),
      ctx.db
        .query("devices")
        .withIndex("by_revoked_at", (query) =>
          query.gt("revokedAt", 0).lt("revokedAt", retiredCutoff),
        )
        .take(100),
      ctx.db
        .query("liveActivities")
        .withIndex("by_ended_at", (query) =>
          query.gt("endedAt", 0).lt("endedAt", oldJobCutoff),
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
    let revokedDevices = 0;
    for (const session of userSessions) {
      const ownedDevices = await ctx.db
        .query("devices")
        .withIndex("by_user_id_and_session_id", (query) =>
          query.eq("userId", session.userId).eq("sessionId", session.sessionId),
        )
        .collect();
      for (const device of ownedDevices) {
        revokedDevices += 1;
        await ctx.db.patch(device._id, { revokedAt: now, pushToken: undefined, updatedAt: now });
        const ownedActivities = await ctx.db
          .query("liveActivities")
          .withIndex("by_user_id_and_device_id_and_mode_and_ended_at", (query) =>
            query.eq("userId", session.userId).eq("deviceId", device.deviceId),
          )
          .collect();
        for (const activity of ownedActivities) {
          if (activity.endedAt === undefined) {
            await ctx.db.patch(activity._id, { endedAt: now, updatedAt: now });
          }
        }
      }
    }
    const documents = [
      ...nonces,
      ...userSessions,
      ...appleTokens,
      ...invitations,
      ...sessions,
      ...doneJobs,
      ...deadJobs,
      ...staleJobs,
      ...keys,
      ...pendingKeys,
      ...devices,
      ...activities,
    ];
    const uniqueDocuments = [...new Map(documents.map((document) => [document._id, document])).values()];
    for (const document of uniqueDocuments) await ctx.db.delete(document._id);
    const affectedUsers = new Set(
      sessions.flatMap((session) => session.userId ? [session.userId] : []),
    );
    for (const userId of affectedUsers) {
      await ctx.scheduler.runAfter(0, internal.delivery.recompute, { userId });
    }
    return { deleted: uniqueDocuments.length, revokedDevices };
  },
});
