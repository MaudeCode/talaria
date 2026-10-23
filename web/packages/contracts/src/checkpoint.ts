import { z } from 'zod'

export const CHECKPOINT_DIFF_MAX_BYTES = 4 * 1024 * 1024
/** Project checkpoints can predate the chat; native reads never imply a session-only edit ledger. */
export const CheckpointComparisonSchema = z.object({
  provenance: z.enum(['native_owner', 'direct_workspace']),
  baseline: z.enum(['earliest_retained_project_checkpoint', 'selected_checkpoint']),
  available: z.boolean(), reason: z.enum(['checkpoints_disabled', 'no_baseline', 'checkpoint_unavailable', 'payload_too_large', 'invalid_payload', 'owner_unavailable']).nullable(),
  truncated: z.boolean(),
})
export const CheckpointReadSchema = z.object({ diff: z.string().max(CHECKPOINT_DIFF_MAX_BYTES), stat: z.string().max(CHECKPOINT_DIFF_MAX_BYTES), comparison: CheckpointComparisonSchema })
export const CheckpointDiffSchema = z.object({
  checkpoint: z.string(), workspace: z.string(), diff: z.string(),
  files_changed: z.array(z.object({ file: z.string(), status: z.string() })), total_changes: z.number().int(),
  comparison: CheckpointComparisonSchema.optional(),
})
export type CheckpointDiff = z.infer<typeof CheckpointDiffSchema>
