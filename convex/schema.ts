import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  activityModeValidator,
  aggregateValidator,
  apsEnvironmentValidator,
  preferencesValidator,
  sessionPhaseValidator,
} from "./lib/validators";

export default defineSchema({
  publishers: defineTable({
    publisherId: v.string(),
    label: v.string(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_publisher_id", ["publisherId"]),

  publisherKeys: defineTable({
    publisherId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_publisher_id_and_key_id", ["publisherId", "keyId"]),

  publisherNonces: defineTable({
    publisherId: v.string(),
    nonce: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_publisher_id_and_nonce", ["publisherId", "nonce"])
    .index("by_expires_at", ["expiresAt"]),

  enrollmentCodes: defineTable({
    codeHash: v.string(),
    kind: v.union(v.literal("publisher"), v.literal("device")),
    publisherId: v.optional(v.string()),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_code_hash", ["codeHash"])
    .index("by_expires_at", ["expiresAt"]),

  devices: defineTable({
    deviceId: v.string(),
    credentialHash: v.string(),
    label: v.string(),
    bundleId: v.optional(v.string()),
    apsEnvironment: v.optional(apsEnvironmentValidator),
    pushToken: v.optional(v.string()),
    preferences: preferencesValidator,
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_device_id", ["deviceId"])
    .index("by_push_token", ["pushToken"])
    .index("by_updated_at", ["updatedAt"]),

  sessionStates: defineTable({
    deleted: v.boolean(),
    publisherId: v.string(),
    publisherLabel: v.string(),
    sessionId: v.string(),
    streamId: v.optional(v.string()),
    eventId: v.string(),
    revision: v.number(),
    title: v.string(),
    phase: sessionPhaseValidator,
    updatedAt: v.number(),
    deepLink: v.string(),
    expiresAt: v.number(),
    terminalExpiresAt: v.optional(v.number()),
    receivedAt: v.number(),
  })
    .index("by_publisher_id_and_session_id", ["publisherId", "sessionId"])
    .index("by_expires_at", ["expiresAt"]),

  liveActivities: defineTable({
    deviceId: v.string(),
    activityId: v.string(),
    mode: activityModeValidator,
    publisherId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    attributesType: v.string(),
    schemaVersion: v.number(),
    activityPushToken: v.string(),
    lastAggregate: v.optional(aggregateValidator),
    lastDeliveryAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_device_id_and_activity_id", ["deviceId", "activityId"])
    .index("by_activity_push_token", ["activityPushToken"])
    .index("by_device_id_and_mode_and_ended_at", ["deviceId", "mode", "endedAt"])
    .index("by_mode_and_ended_at", ["mode", "endedAt"]),

  deliveryJobs: defineTable({
    deviceId: v.string(),
    activityId: v.optional(v.string()),
    sourcePublisherId: v.optional(v.string()),
    sourceSessionId: v.optional(v.string()),
    kind: v.union(
      v.literal("live_activity_update"),
      v.literal("live_activity_end"),
      v.literal("notification"),
    ),
    expectedToken: v.string(),
    stateFingerprint: v.string(),
    request: v.object({
      token: v.string(),
      topic: v.string(),
      environment: apsEnvironmentValidator,
      pushType: v.union(v.literal("alert"), v.literal("liveactivity")),
      priority: v.union(v.literal("5"), v.literal("10")),
      payloadJson: v.string(),
    }),
    aggregate: v.optional(aggregateValidator),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("dead"),
      v.literal("stale"),
    ),
    attemptCount: v.number(),
    lastError: v.optional(v.string()),
    apnsStatus: v.optional(v.number()),
    apnsId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_activity_id_and_status", ["activityId", "status"])
    .index("by_device_id_and_status", ["deviceId", "status"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),

  apnsProviderTokens: defineTable({
    cacheKey: v.string(),
    token: v.string(),
    issuedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_cache_key", ["cacheKey"]),
});
