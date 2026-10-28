import { z } from 'zod'

export const AgentImportSourceSchema = z.enum(['claude-code', 'codex', 'cursor'])
export type AgentImportSource = z.infer<typeof AgentImportSourceSchema>
export const AgentImportResultSchema = z.object({
  status: z.enum(['available', 'unavailable', 'preview', 'applied', 'partial', 'changed', 'unknown']),
  sources: z.array(z.object({ agent: AgentImportSourceSchema, label: z.string().max(64) })).max(3),
  items: z.array(z.object({ kind: z.string().max(64), status: z.enum(['imported', 'skipped', 'conflict', 'error']), label: z.string().max(256) })).max(2048),
  stripped_secrets: z.array(z.string().max(200)).max(2048),
  catalog_required: z.boolean().optional(),
  receipt: z.string().max(128).nullable(), can_apply: z.boolean(), message: z.string().max(512).nullable(),
})
export type AgentImportResult = z.infer<typeof AgentImportResultSchema>
