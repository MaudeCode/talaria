import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  activityModeValidator,
  aggregateValidator,
  apsEnvironmentValidator,
  preferencesValidator,
  sessionPhaseValidator,
  aggregateRowValidator,
} from "./lib/validators";

export default defineSchema({
  relayUsers: defineTable({
    userId: v.string(),
    appleSubjectHash: v.string(),
    disabledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_id", ["userId"])
    .index("by_apple_subject_hash", ["appleSubjectHash"]),

  userSessions: defineTable({
    userId: v.string(),
    sessionId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_expires_at", ["expiresAt"]),

  appleIdentityTokens: defineTable({
    tokenHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_expires_at", ["expiresAt"]),

  authRateLimits: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    attempts: v.number(),
  }).index("by_key", ["key"]),

  appleJwksCache: defineTable({
    key: v.string(),
    keysJson: v.optional(v.string()),
    expiresAt: v.number(),
    refreshLeaseUntil: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  publisherInvitations: defineTable({
    userId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_expires_at", ["expiresAt"]),

  publishers: defineTable({
    version: v.optional(v.number()),
    userId: v.optional(v.string()),
    ownerUserId: v.optional(v.string()),
    publisherId: v.string(),
    label: v.string(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_version_and_owner_user_id_and_publisher_id", ["version", "ownerUserId", "publisherId"]),

  publisherKeys: defineTable({
    version: v.optional(v.number()),
    userId: v.optional(v.string()),
    ownerUserId: v.optional(v.string()),
    publisherId: v.string(),
    keyId: v.string(),
    publicKey: v.string(),
    activatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_version_and_owner_user_id_and_publisher_id", ["version", "ownerUserId", "publisherId"])
    .index("by_activated_at_and_created_at", ["activatedAt", "createdAt"])
    .index("by_revoked_at", ["revokedAt"])
    .index("by_version_and_key_id", ["version", "keyId"])
    .index("by_key_id", ["keyId"]),

  publisherNonces: defineTable({
    version: v.optional(v.number()),
    userId: v.optional(v.string()),
    ownerUserId: v.optional(v.string()),
    publisherId: v.string(),
    nonce: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_version_and_owner_user_id_and_publisher_id_and_nonce", ["version", "ownerUserId", "publisherId", "nonce"])
    .index("by_expires_at", ["expiresAt"]),

  publisherGrants: defineTable({
    userId: v.string(),
    publisherOwnerUserId: v.string(),
    publisherId: v.string(),
    profileId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_id_and_publisher_id", ["userId", "publisherId"])
    .index("by_publisher_owner_user_id_and_publisher_id_and_profile_id", ["publisherOwnerUserId", "publisherId", "profileId"]),

  devices: defineTable({
    userId: v.string(),
    sessionId: v.optional(v.string()),
    sessionExpiresAt: v.optional(v.number()),
    deviceId: v.string(),
    label: v.string(),
    bundleId: v.optional(v.string()),
    apsEnvironment: v.optional(apsEnvironmentValidator),
    pushToken: v.optional(v.string()),
    pushToStartToken: v.optional(v.string()),
    pushToStartIssuedAt: v.optional(v.number()),
    pushToStartDeferredAt: v.optional(v.number()),
    preferences: preferencesValidator,
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_id_and_device_id", ["userId", "deviceId"])
    .index("by_user_id_and_session_id", ["userId", "sessionId"])
    .index("by_push_token", ["pushToken"])
    .index("by_push_to_start_token", ["pushToStartToken"])
    .index("by_revoked_at", ["revokedAt"])
    .index("by_user_id_and_updated_at", ["userId", "updatedAt"]),

  devicePublisherExclusions: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    publisherId: v.string(),
    createdAt: v.number(),
  })
    .index("by_user_id_and_device_id_and_publisher_id", ["userId", "deviceId", "publisherId"])
    .index("by_user_id_and_publisher_id_and_device_id", ["userId", "publisherId", "deviceId"]),

  sessionStates: defineTable({
    version: v.optional(v.number()),
    userId: v.string(),
    profileId: v.optional(v.string()),
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
    runKey: v.optional(v.string()),
    alertEligible: v.optional(v.boolean()),
    receivedAt: v.number(),
  })
    .index("by_user_id_and_publisher_id_and_session_id", ["userId", "publisherId", "sessionId"])
    .index("by_version_and_user_id_and_publisher_id_and_session_id", ["version", "userId", "publisherId", "sessionId"])
    .index("by_user_id_and_expires_at", ["userId", "expiresAt"])
    .index("by_version_and_user_id_and_expires_at", ["version", "userId", "expiresAt"])
    .index("by_expires_at", ["expiresAt"]),

  completions: defineTable({
    userId: v.string(),
    grantId: v.id("publisherGrants"),
    publisherOwnerUserId: v.string(),
    profileId: v.string(),
    runKey: v.string(),
    revision: v.optional(v.number()),
    acknowledged: v.boolean(),
    row: aggregateRowValidator,
  })
    .index("by_grant_id_and_run_key", ["grantId", "runKey"])
    .index("by_grant_id_and_session_id_and_acknowledged", ["grantId", "row.sessionId", "acknowledged"])
    .index("by_user_id_and_acknowledged", ["userId", "acknowledged"])
    .index("by_acknowledged", ["acknowledged"]),

  pruneCursors: defineTable({
    table: v.string(),
    cursor: v.string(),
  }).index("by_table", ["table"]),

  liveActivities: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    activityId: v.string(),
    mode: activityModeValidator,
    publisherId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    streamId: v.optional(v.string()),
    attributesType: v.string(),
    schemaVersion: v.number(),
    activityPushToken: v.string(),
    lastAggregate: v.optional(aggregateValidator),
    lastDeliveryAt: v.optional(v.number()),
    emptyStateLeaseUntil: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_id_and_device_id_and_activity_id", ["userId", "deviceId", "activityId"])
    .index("by_activity_push_token", ["activityPushToken"])
    .index("by_user_id_and_device_id_and_mode_and_ended_at", ["userId", "deviceId", "mode", "endedAt"])
    .index("by_user_id_and_mode_and_ended_at", ["userId", "mode", "endedAt"])
    .index("by_ended_at", ["endedAt"]),

  deliveryJobs: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    activityId: v.optional(v.string()),
    sourcePublisherId: v.optional(v.string()),
    sourceSessionId: v.optional(v.string()),
    kind: v.union(
      v.literal("live_activity_update"),
      v.literal("live_activity_end"),
      v.literal("live_activity_start"),
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
    .index("by_user_id_and_activity_id_and_status", ["userId", "activityId", "status"])
    .index("by_user_id_and_device_id_and_status", ["userId", "deviceId", "status"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),

});
