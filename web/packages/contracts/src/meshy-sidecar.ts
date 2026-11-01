import { z } from 'zod'
import { MeshyDetailsSchema, MeshyFormatIdSchema, MeshyStatusFields, MeshyTaskIdSchema, MeshyTaskSchema } from './meshy.js'

/** TAL-1514: the sidecar adapter (`plugins.meshy`). Server-only, in its own module so browser bundles never carry it. */

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

/** TAL-1514: closed adapter over the reviewed native Meshy plugin API. No arbitrary paths, hosts or credit-spending calls. */
export const MESHY_METHODS = {
  'plugins.meshy': { params: MeshySidecarParamsSchema, result: MeshySidecarResultSchema },
} as const
