import { z } from 'zod'

const Tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
export const ContextCategoryIdSchema = z.enum(['system_prompt', 'tool_definitions', 'rules', 'skills', 'mcp', 'subagent_definitions', 'memory', 'conversation'])
/** A read of the existing owner only. Category estimates are independent of measured occupancy. */
export const ContextDetailSchema = z.object({
  available: z.boolean(), reason: z.enum(['not_built', 'unsupported', 'changed', 'unavailable']).nullable(),
  used_tokens: Tokens, window_tokens: Tokens, estimated_total: Tokens,
  source: z.enum(['local_estimate', 'provider_usage', 'provider_usage_plus_estimate']).nullable(), estimated: z.boolean().nullable(),
  categories: z.array(z.object({ id: ContextCategoryIdSchema, tokens: Tokens.unwrap(), percent: z.number().min(0).max(100).nullable(), estimated: z.literal(true) })).max(8),
  files: z.array(z.object({ label: z.enum(['AGENTS.md', 'SOUL.md', '.hermes.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md', 'Context file']), characters: Tokens, tokens: Tokens,
    status: z.enum(['loaded', 'truncated', 'flagged', 'shadowed', 'blocked', 'empty', 'unreadable', 'suppressed', 'unknown']), loaded: z.boolean().nullable() })).max(64),
  truncated: z.boolean(), current_turn_output_tokens: Tokens, last_turn_output_tokens: Tokens,
})
export type ContextDetail = z.infer<typeof ContextDetailSchema>
export const unavailableContextDetail = (reason: NonNullable<ContextDetail['reason']> = 'unavailable'): ContextDetail => ({
  available: false, reason, used_tokens: null, window_tokens: null, estimated_total: null, source: null, estimated: null,
  categories: [], files: [], truncated: false, current_turn_output_tokens: null, last_turn_output_tokens: null,
})
