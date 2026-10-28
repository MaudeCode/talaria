import { z } from 'zod'

/** Native allowance snapshots, shared by the catalog, quota and persisted run views. */
export const PlanGaugeSchema = z.object({ id: z.string().max(128), label: z.string().max(256), used_bp: z.number().int().min(0).max(10000), resets_at_ms: z.number().int().nonnegative().nullable() })
export type PlanGauge = z.infer<typeof PlanGaugeSchema>
export const PlanUsageSchema = z.object({
  kind: z.literal('usage_window'), plan: z.string().nullable(),
  gauges: z.array(z.object({ label: z.string(), left_fraction: z.number().min(0).max(1), style: z.enum(['green', 'yellow', 'red']), resets_at_ms: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable(), scope: z.string(), title: z.string() })),
  top_tier_model_ids: z.array(z.string()), featured_model_ids: z.array(z.string()), paused_reason: z.string().nullable(), credits_pay: z.boolean().nullable(),
})
export type PlanUsage = z.infer<typeof PlanUsageSchema>
export const ModelAllowanceSchema = z.object({
  state: z.enum(['included', 'free', 'blocked', 'credits', 'unknown']),
  usage_level: z.enum(['free', 'low', 'medium', 'top_tier']).nullable(), resets_at_ms: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable(),
})
export type ModelAllowance = z.infer<typeof ModelAllowanceSchema>
export const ModelSectionsSchema = z.array(z.object({ kind: z.enum(['recommended', 'other']), model_ids: z.array(z.string()) }))
export const ModelAllowanceSnapshotSchema = z.object({
  metadata_status: z.enum(['current', 'pending', 'stale', 'error', 'unsupported']).optional(),
  plan_usage: PlanUsageSchema.nullable().optional(),
  usage_levels: z.record(z.string(), z.enum(['free', 'low', 'medium', 'top_tier'])).optional(),
  unavailable_model_ids: z.array(z.string()).optional(), allowance_pending: z.boolean().optional(), free_tier: z.boolean().nullable().optional(),
})
