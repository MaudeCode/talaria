import { z } from 'zod'

/** A provider wait ends on retry, content, or the turn's terminal frame. Times are epoch seconds. */
export const RateLimitWaitSchema = z.object({ provider: z.string().nullable(), provider_label: z.string().nullable(), until: z.number(), until_kind: z.enum(['reset', 'retry']) })
export type RateLimitWait = z.infer<typeof RateLimitWaitSchema>

/** The sidecar's normalized local-model phase. Unknown progress is null; clients never parse Agent text. */
export const ProviderPhaseSchema = z.object({ phase: z.literal('prompt_reading'), progress_percent: z.number().min(0).max(100).nullable() })
export type ProviderPhase = z.infer<typeof ProviderPhaseSchema>

/** Server-selected precedence: compression, rate-limit wait, prompt reading, working. Null ends the run status. */
export const RunStatusSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('compressing') }),
  z.object({ phase: z.literal('rate_limit_wait'), wait: RateLimitWaitSchema }),
  ProviderPhaseSchema,
  z.object({ phase: z.literal('working') }),
])
export type RunStatus = z.infer<typeof RunStatusSchema>
