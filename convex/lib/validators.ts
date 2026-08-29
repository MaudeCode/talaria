import { v } from "convex/values";

export const sessionPhaseValidator = v.union(
  v.literal("starting"),
  v.literal("running"),
  v.literal("waiting_for_approval"),
  v.literal("waiting_for_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("stale"),
);

export const activityModeValidator = v.union(
  v.literal("per_session"),
  v.literal("all_running"),
);

export const apsEnvironmentValidator = v.union(
  v.literal("sandbox"),
  v.literal("production"),
);

export const preferencesValidator = v.object({
  liveActivitiesEnabled: v.boolean(),
  notificationsEnabled: v.boolean(),
  notifyOnApproval: v.boolean(),
  notifyOnInput: v.boolean(),
  notifyOnCompletion: v.boolean(),
  notifyOnFailure: v.boolean(),
});

export const aggregateRowValidator = v.object({
  publisherId: v.string(),
  publisherLabel: v.string(),
  sessionId: v.string(),
  streamId: v.optional(v.string()),
  title: v.string(),
  phase: sessionPhaseValidator,
  status: v.string(),
  updatedAt: v.number(),
  deepLink: v.string(),
});

export const aggregateValidator = v.object({
  schemaVersion: v.literal(1),
  activeCount: v.number(),
  title: v.string(),
  subtitle: v.string(),
  updatedAt: v.number(),
  rows: v.array(aggregateRowValidator),
});

export const alertValidator = v.object({ title: v.string(), body: v.string() });

export const sessionStateContentValidator = v.object({
  sessionId: v.string(),
  streamId: v.optional(v.string()),
  title: v.string(),
  phase: sessionPhaseValidator,
  updatedAt: v.number(),
  deepLink: v.string(),
});

export const sessionStateInputValidator = v.object({
  eventId: v.string(),
  revision: v.number(),
  ...sessionStateContentValidator.fields,
});

export const storedSessionStateValidator = v.object({
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
});

export const apnsRequestValidator = v.object({
  token: v.string(),
  topic: v.string(),
  environment: apsEnvironmentValidator,
  pushType: v.union(v.literal("alert"), v.literal("liveactivity")),
  priority: v.union(v.literal("5"), v.literal("10")),
  payloadJson: v.string(),
});

export const apnsDeliveryResultValidator = v.object({
  outcome: v.union(
    v.literal("delivered"),
    v.literal("permanent_failure"),
    v.literal("stale"),
  ),
  status: v.optional(v.number()),
  apnsId: v.optional(v.string()),
});
