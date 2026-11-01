import { z } from 'zod'
import { SkillReplayCaseResultSchema, SkillReplayCaseSchema, SkillReplayPlanInputSchema, SkillReplayPlanSidecarSchema, SkillReplayRevisionSchema, SkillReplayRouteSchema, SkillRevisionIdSchema } from './sidecar/namespaces.js'

/** TAL-1563: the server-reserved finite budget. Every call caps output at `max_output_tokens`, its prompt at the case's
 * `input_tokens_bound`, and its price per million tokens at `max_price_per_million`, which the provider enforces; the
 * sum over `max_calls` cannot exceed `max_cost_usd`. */
export const SkillReplayBudgetSchema = z.object({
  max_cost_usd: z.number().positive().max(5), max_calls: z.number().int().positive().max(24), max_output_tokens: z.number().int().positive(),
  max_input_tokens: z.number().int().positive(), max_price_per_million: z.number().positive(),
})
export const SkillReplayPlanSchema = SkillReplayPlanSidecarSchema.extend({ budget: SkillReplayBudgetSchema.nullable() })
export const SkillReplayPlanQuerySchema = SkillReplayPlanInputSchema
export const SkillReplayStartSchema = SkillReplayPlanInputSchema.extend({
  /** Stable per consent: a retry after an uncertain acknowledgement returns the admitted job instead of starting another. */
  request_id: z.uuid(),
  case_ids: z.array(SkillRevisionIdSchema).min(1).max(12),
  route: SkillReplayRouteSchema,
  max_cost_usd: z.number().positive().max(5),
})
export const SkillReplayRunSchema = z.object({
  status: z.enum(['pending', 'dispatched', 'completed', 'error', 'refused', 'unknown', 'skipped']),
  detail: z.string().max(240).nullable(),
  result: SkillReplayCaseResultSchema.nullable(),
})
export const SkillReplayJobSchema = z.object({
  id: SkillRevisionIdSchema,
  skill: z.string(),
  state: z.enum(['queued', 'running', 'cancelling', 'completed', 'cancelled', 'interrupted', 'failed']),
  reason: z.enum(['budget_exceeded']).nullable(),
  active: z.boolean(),
  can_cancel: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  revisions: z.tuple([SkillReplayRevisionSchema, SkillReplayRevisionSchema]),
  route: SkillReplayRouteSchema,
  budget: SkillReplayBudgetSchema,
  /** Sum of the costs the provider reported; `unreported_calls` dispatched calls reported none. Enforcement is the reservation, not this sum. */
  reported_cost_usd: z.number().nonnegative(),
  unreported_calls: z.number().int().nonnegative(),
  cases: z.array(SkillReplayCaseSchema.omit({ input_tokens_bound: true }).extend({ baseline: SkillReplayRunSchema, candidate: SkillReplayRunSchema })).max(12),
  summary: z.array(z.object({ role: z.enum(['baseline', 'candidate']), passed: z.number().int(), failed: z.number().int(), error: z.number().int(), unknown: z.number().int(), refused: z.number().int(), skipped: z.number().int(), pending: z.number().int() })).length(2),
})
export const SkillReplayJobsSchema = z.object({ jobs: z.array(SkillReplayJobSchema).max(10) })
export type SkillReplayPlan = z.infer<typeof SkillReplayPlanSchema>
export type SkillReplayJob = z.infer<typeof SkillReplayJobSchema>
export type SkillReplayBudget = z.infer<typeof SkillReplayBudgetSchema>
