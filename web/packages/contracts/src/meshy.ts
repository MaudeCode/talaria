import { z } from 'zod'

/**
 * TAL-1514: Meshy model previews and gallery through the reviewed native Meshy plugin. The server and sidecar own every
 * field below: directive recognition, task/profile identity, asset custody, ordering, costs and actions. Clients render
 * them, format numbers and dates, and never parse a directive or trust a path or URL from message text.
 */

/** A Meshy task id, as the native plugin validates one. */
export const MESHY_TASK_ID_RE = /^[0-9a-f][0-9a-f-]{15,63}$/
export const MeshyTaskIdSchema = z.string().regex(MESHY_TASK_ID_RE)
/** A download format the native task offers: `glb`, `fbx`, or a rig clip such as `glb:walking`. */
export const MeshyFormatIdSchema = z.string().regex(/^(?:glb|fbx|obj|stl|usdz|3mf|blend)(?::[a-z0-9_]{1,40})?$/)

/** On a `model` display media item: an opaque locator the server finds again in that session's assistant text before use. */
export const MeshyModelRefSchema = z.object({ ref: z.string().min(1).max(4096) })
export type MeshyModelRef = z.infer<typeof MeshyModelRefSchema>

/**
 * Why Meshy content is or is not available, decided per request from the profile's native plugin:
 * `ready`; `missing_key` (no MESHY_API_KEY: local files still show); `plugin_unavailable` (not installed, not enabled, or
 * not the reviewed revision); `agent_incompatible` (this Agent has no native plugin host); `unavailable` (the native
 * backend or Meshy did not answer; `message` says why).
 */
export const MeshyAvailabilitySchema = z.enum(['ready', 'missing_key', 'plugin_unavailable', 'agent_incompatible', 'unavailable'])
export type MeshyAvailability = z.infer<typeof MeshyAvailabilitySchema>

/** Bytes behind a grant bound to the signed-in owner, profile, reviewed plugin revision and task. `url` is app-relative. */
export const MeshyAssetSchema = z.object({
  url: z.string(), name: z.string(), mime: z.string(), kind: z.enum(['model', 'image']), bytes: z.number().int().nonnegative().nullable(),
})
export type MeshyAsset = z.infer<typeof MeshyAssetSchema>

/** One task's state as a full snapshot: `terminal` ends polling; `progress` is Meshy's own percentage. */
export const MeshyTaskSchema = z.object({
  task_id: MeshyTaskIdSchema,
  status: z.enum(['pending', 'in_progress', 'succeeded', 'failed', 'canceled', 'expired', 'unknown']),
  progress: z.number().int().min(0).max(100), terminal: z.boolean(), stage: z.string().nullable(), error: z.string().nullable(),
})
export type MeshyTask = z.infer<typeof MeshyTaskSchema>

/** One model or image set, the same shape inline and in the gallery. Unknown credits stay null. */
export const MeshyItemSchema = z.object({
  /** Stable within one response: list key. */
  key: z.string(),
  task_id: MeshyTaskIdSchema.nullable(), kind: z.enum(['model', 'image']), title: z.string(), prompt: z.string().nullable(),
  task_type: z.string().nullable(),
  /** Epoch milliseconds. */
  created_at: z.number().nullable(), credits: z.number().nullable(),
  thumbnail: MeshyAssetSchema.nullable(),
  /** A local self-contained GLB the shared viewer renders; null until one is saved. */
  model: MeshyAssetSchema.nullable(),
  images: z.array(MeshyAssetSchema),
  /** A local copy exists. */
  saved: z.boolean(), expired: z.boolean(),
  /** An image set whose download stopped part way: offer a retry. */
  download_incomplete: z.boolean(),
  /** The task is known and the key configured: its formats, actions and "Made from" can be read. */
  can_download: z.boolean(),
})
export type MeshyItem = z.infer<typeof MeshyItemSchema>

const MeshyStatusFields = {
  availability: MeshyAvailabilitySchema, message: z.string().nullable(),
  /** Meshy's credit balance, null when unknown. Never estimated. */
  balance: z.number().nullable(),
}

export const MeshyOverviewSchema = z.object({
  ...MeshyStatusFields,
  /** Recent finished generations, newest first. */
  recent: z.array(MeshyItemSchema),
  /** Saved models and image sets on this machine, newest first. */
  local: z.array(MeshyItemSchema),
  /** Tasks still running, newest first. */
  active: z.array(MeshyTaskSchema),
  /** The profile's Meshy "auto-rotate in the gallery" setting; clients still honour reduced motion. */
  auto_rotate: z.boolean(),
})
export type MeshyOverview = z.infer<typeof MeshyOverviewSchema>

export const MeshyCardQuerySchema = z.object({ session_id: z.string().min(1), ref: z.string().min(1).max(4096) })
export const MeshyCardSchema = z.object({ ...MeshyStatusFields, title: z.string(), item: MeshyItemSchema.nullable(), task: MeshyTaskSchema.nullable() })
export type MeshyCard = z.infer<typeof MeshyCardSchema>

/**
 * A follow-up the user can start: tapping it only puts `draft` in the composer. Nothing is sent or spent; the Agent's
 * tool-cost approval still decides. `cost` and `affordable` are null when unknown.
 */
export const MeshyDraftActionSchema = z.object({ id: z.string(), label: z.string(), cost: z.number().nullable(), affordable: z.boolean().nullable(), draft: z.string() })
export type MeshyDraftAction = z.infer<typeof MeshyDraftActionSchema>
export const MeshyFormatSchema = z.object({ format: MeshyFormatIdSchema, label: z.string(), saved: z.boolean() })
export const MeshyLinkSchema = z.object({ task_id: MeshyTaskIdSchema, tool: z.string().nullable() })
/** "Made from": what the native plugin recorded. A source image is named, never located. */
export const MeshyProvenanceSchema = z.object({
  prompt: z.string().nullable(), prompt_inherited: z.boolean(), texture_prompt: z.string().nullable(), style_prompt: z.string().nullable(),
  negative_prompt: z.string().nullable(), source_image: z.string().nullable(), settings: z.array(z.object({ key: z.string(), value: z.string() })),
  seed: z.number().nullable(), credits: z.number().nullable(), created_at: z.number().nullable(),
  parents: z.array(MeshyLinkSchema), children: z.array(MeshyLinkSchema), recorded: z.boolean(),
})
export const MeshyDetailsQuerySchema = z.object({ task_id: MeshyTaskIdSchema, beside: z.string().max(4096).optional() })
export const MeshyDetailsSchema = z.object({
  ...MeshyStatusFields, task_id: MeshyTaskIdSchema,
  formats: z.array(MeshyFormatSchema), conversions: z.array(MeshyDraftActionSchema), actions: z.array(MeshyDraftActionSchema),
  provenance: MeshyProvenanceSchema.nullable(), is_preview: z.boolean(),
})
export type MeshyDetails = z.infer<typeof MeshyDetailsSchema>

/** `beside`: the card's model asset url, to save the format next to it; otherwise the plugin's own folder. */
export const MeshySaveInputSchema = z.object({ task_id: MeshyTaskIdSchema, format: MeshyFormatIdSchema, beside: z.string().max(4096).optional() })
export const MeshySaveImagesInputSchema = z.object({ task_id: MeshyTaskIdSchema })
/**
 * An explicit download: never overwrites another file (the native plugin picks a free name). `complete` is false when
 * only part of an image set arrived; `error` then says why, and a retry resumes.
 */
export const MeshySaveResultSchema = z.object({ ...MeshyStatusFields, saved: z.array(z.string()), complete: z.boolean(), error: z.string().nullable() })
export type MeshySaveResult = z.infer<typeof MeshySaveResultSchema>
export const MeshyTaskQuerySchema = z.object({ task_id: MeshyTaskIdSchema })
export const MeshyTaskResultSchema = z.object({ ...MeshyStatusFields, task: MeshyTaskSchema.nullable() })

// ── sidecar adapter (`plugins.meshy`) ─────────────────────────────────────

/** Native rows, normalized and bounded by the sidecar. Paths and signed URLs stay on the server, which mints grants. */
export const MeshyNativeRecentSchema = z.object({
  task_id: MeshyTaskIdSchema, task_type: z.string(), kind: z.enum(['model', 'image']), prompt: z.string().nullable(), created_at: z.number().nullable(),
  credits: z.number().nullable(), thumbnail_url: z.string().nullable(), image_urls: z.array(z.string()), expired: z.boolean(), local_path: z.string().nullable(),
})
export const MeshyNativeLocalSchema = z.object({
  path: z.string(), name: z.string(), kind: z.enum(['model', 'image']), task_id: MeshyTaskIdSchema.nullable(), prompt: z.string().nullable(),
  modified: z.number().nullable(), bytes: z.number().int().nonnegative().nullable(), images: z.array(z.string()), download_incomplete: z.boolean(),
})
export const MeshyNativeTaskSchema = MeshyTaskSchema.extend({ prompt: z.string().nullable(), thumbnail_url: z.string().nullable(), credits: z.number().nullable(), has_model: z.boolean(), task_type: z.string().nullable() })
export const MeshySidecarParamsSchema = z.object({
  profile_home: z.string().min(1),
  action: z.enum(['overview', 'card', 'task', 'details', 'save', 'save_images', 'asset']),
  task_id: MeshyTaskIdSchema.optional(), format: MeshyFormatIdSchema.optional(),
  /** An absolute local path the server holds from an earlier sidecar answer (`asset`, `card`, `details`/`save` `beside`). */
  path: z.string().max(4096).optional(),
})
export const MeshySidecarResultSchema = z.object({
  ...MeshyStatusFields,
  /** The reviewed plugin revision that answered; grants bind to it. */
  revision: z.string().nullable(),
  auto_rotate: z.boolean().optional(),
  recent: z.array(MeshyNativeRecentSchema).optional(), local: z.array(MeshyNativeLocalSchema).optional(), active: z.array(MeshyTaskSchema).optional(),
  task: MeshyNativeTaskSchema.nullable().optional(),
  details: MeshyDetailsSchema.omit({ availability: true, message: true, balance: true }).optional(),
  saved: z.array(z.string()).optional(), complete: z.boolean().optional(), error: z.string().nullable().optional(),
  /** `asset`: a native-listed regular file, its trusted anchor directory, type and size. */
  asset: z.object({ path: z.string(), anchor: z.string(), mime: z.string(), bytes: z.number().int().nonnegative() }).nullable().optional(),
})
export type MeshySidecarResult = z.infer<typeof MeshySidecarResultSchema>
