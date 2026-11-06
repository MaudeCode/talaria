import { z } from 'zod'

export const AgentImportSourceSchema = z.enum(['claude-code', 'codex', 'cursor', 'grok-bot', 'openbot'])
export type AgentImportSource = z.infer<typeof AgentImportSourceSchema>
/** A Grok Bot export is one Bot-written text document, sent with its preview and never stored by the server. */
export const AGENT_IMPORT_EXPORT_MAX_CHARS = 4_000_000
const AgentImportSourceRowSchema = z.object({
  agent: AgentImportSourceSchema,
  label: z.string().max(64),
  available: z.boolean(),
  input: z.enum(['none', 'file']).describe('`file`: the preview carries `export_text`.'),
  detail: z.string().max(64).nullable().describe('Why the source is unavailable.'),
  export_prompt: z.string().max(8192).nullable().describe('The message that asks the source to write its export.'),
})
export const AgentImportResultSchema = z.object({
  status: z.enum(['available', 'unavailable', 'preview', 'applied', 'partial', 'changed', 'unknown']),
  sources: z.array(AgentImportSourceRowSchema).max(5),
  items: z.array(z.object({ kind: z.string().max(64), status: z.enum(['imported', 'skipped', 'conflict', 'error']), label: z.string().max(256) })).max(2048),
  stripped_secrets: z.array(z.string().max(200)).max(2048),
  catalog_required: z.boolean().optional(),
  receipt: z.string().max(128).nullable(), can_apply: z.boolean(), message: z.string().max(512).nullable(),
})
export type AgentImportResult = z.infer<typeof AgentImportResultSchema>
