import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { preferencesValidator } from "./lib/validators";

const publisherEnrollmentResult = v.union(
  v.object({ ok: v.literal(false), reason: v.string() }),
  v.object({ ok: v.literal(true), publisherId: v.string(), keyId: v.string() }),
);

const deviceEnrollmentResult = v.union(
  v.object({ ok: v.literal(false), reason: v.string() }),
  v.object({ ok: v.literal(true), deviceId: v.string() }),
);

export const redeemPublisher = internalMutation({
  args: {
    codeHash: v.string(),
    publisherId: v.string(),
    keyId: v.string(),
    label: v.string(),
    publicKey: v.string(),
    now: v.number(),
  },
  returns: publisherEnrollmentResult,
  handler: async (ctx, args) => {
    const enrollment = await ctx.db
      .query("enrollmentCodes")
      .withIndex("by_code_hash", (query) => query.eq("codeHash", args.codeHash))
      .unique();
    if (!enrollment || enrollment.kind !== "publisher") {
      return { ok: false as const, reason: "invalid_enrollment" };
    }
    if (enrollment.consumedAt !== undefined || enrollment.expiresAt <= args.now) {
      return { ok: false as const, reason: "expired_enrollment" };
    }
    if (enrollment.publisherId && enrollment.publisherId !== args.publisherId) {
      return { ok: false as const, reason: "publisher_mismatch" };
    }

    const existingPublisher = await ctx.db
      .query("publishers")
      .withIndex("by_publisher_id", (query) => query.eq("publisherId", args.publisherId))
      .unique();
    if (existingPublisher) {
      await ctx.db.patch(existingPublisher._id, { label: args.label, enabled: true, updatedAt: args.now });
    } else {
      await ctx.db.insert("publishers", {
        publisherId: args.publisherId,
        label: args.label,
        enabled: true,
        createdAt: args.now,
        updatedAt: args.now,
      });
    }

    await ctx.db.insert("publisherKeys", {
      publisherId: args.publisherId,
      keyId: args.keyId,
      publicKey: args.publicKey,
      createdAt: args.now,
    });
    await ctx.db.patch(enrollment._id, { consumedAt: args.now });
    return { ok: true as const, publisherId: args.publisherId, keyId: args.keyId };
  },
});

export const redeemDevice = internalMutation({
  args: {
    codeHash: v.string(),
    deviceId: v.string(),
    credentialHash: v.string(),
    label: v.string(),
    preferences: preferencesValidator,
    now: v.number(),
  },
  returns: deviceEnrollmentResult,
  handler: async (ctx, args) => {
    const enrollment = await ctx.db
      .query("enrollmentCodes")
      .withIndex("by_code_hash", (query) => query.eq("codeHash", args.codeHash))
      .unique();
    if (!enrollment || enrollment.kind !== "device") {
      return { ok: false as const, reason: "invalid_enrollment" };
    }
    if (enrollment.consumedAt !== undefined || enrollment.expiresAt <= args.now) {
      return { ok: false as const, reason: "expired_enrollment" };
    }

    await ctx.db.insert("devices", {
      deviceId: args.deviceId,
      credentialHash: args.credentialHash,
      label: args.label,
      preferences: args.preferences,
      createdAt: args.now,
      updatedAt: args.now,
    });
    await ctx.db.patch(enrollment._id, { consumedAt: args.now });
    return { ok: true as const, deviceId: args.deviceId };
  },
});

export const getPublisherKey = internalQuery({
  args: { publisherId: v.string(), keyId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      publisherId: v.string(),
      label: v.string(),
      enabled: v.boolean(),
      publicKey: v.string(),
      revokedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const [publisher, key] = await Promise.all([
      ctx.db
        .query("publishers")
        .withIndex("by_publisher_id", (query) => query.eq("publisherId", args.publisherId))
        .unique(),
      ctx.db
        .query("publisherKeys")
        .withIndex("by_publisher_id_and_key_id", (query) =>
          query.eq("publisherId", args.publisherId).eq("keyId", args.keyId),
        )
        .unique(),
    ]);
    if (!publisher || !key) return null;
    return {
      publisherId: publisher.publisherId,
      label: publisher.label,
      enabled: publisher.enabled,
      publicKey: key.publicKey,
      revokedAt: key.revokedAt,
    };
  },
});

export const getDeviceCredential = internalQuery({
  args: { deviceId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ credentialHash: v.string(), revokedAt: v.optional(v.number()) }),
  ),
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_device_id", (query) => query.eq("deviceId", args.deviceId))
      .unique();
    return device ? { credentialHash: device.credentialHash, revokedAt: device.revokedAt } : null;
  },
});
