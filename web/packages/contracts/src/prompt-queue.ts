import { z } from 'zod'

// A cross-chat lifetime cannot belong to a session's pending admissions or cron schedule.
export const PromptQueueActionSchema = z.enum(['start', 'pause', 'resume', 'cancel', 'reconcile'])
export const PromptQueueCardInputSchema = z.object({
  session_id: z.string().min(1).max(256), project_id: z.string().nullable(), text: z.string().trim().min(1).max(32_000),
})
export const PromptQueueCardsSchema = z.array(PromptQueueCardInputSchema).min(1).max(100)
export const PromptQueueCardSchema = PromptQueueCardInputSchema.extend({
  request_id: z.string(), title: z.string(), backend: z.enum(['direct', 'owner']), authority_epoch: z.number().int().nullable(),
  status: z.enum(['waiting', 'dispatching', 'running', 'completed', 'failed', 'refused', 'unknown']),
  stream_id: z.string().nullable(), admission_id: z.string().nullable(), outcome: z.string().nullable(),
})
export const PromptQueueRunSchema = z.object({
  id: z.string(), title: z.string(), revision: z.number().int().nonnegative(), profile: z.string(),
  phase: z.enum(['draft', 'running', 'paused', 'cancelled', 'completed', 'failed', 'refused', 'unknown']),
  current_step: z.number().int().nonnegative(), cards: z.array(PromptQueueCardSchema),
  actions: z.array(PromptQueueActionSchema), editable: z.boolean(), error: z.string().nullable(),
})
export type PromptQueueCardInput = z.infer<typeof PromptQueueCardInputSchema>
export type PromptQueueCard = z.infer<typeof PromptQueueCardSchema>
export type PromptQueueRun = z.infer<typeof PromptQueueRunSchema>
export type PromptQueueAction = z.infer<typeof PromptQueueActionSchema>
