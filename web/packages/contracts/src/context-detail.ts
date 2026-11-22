import { z } from 'zod'

const Tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
/** TAL-1908: the Agent's label for a window it did not detect: `pinned` by `model.context_length`, or a `fallback` default. */
export const ContextWindowSourceSchema = z.enum(['pinned', 'fallback'])
export type ContextWindowSource = z.infer<typeof ContextWindowSourceSchema>
export const ContextCategoryIdSchema = z.enum(['system_prompt', 'tool_definitions', 'rules', 'skills', 'mcp', 'subagent_definitions', 'memory', 'conversation'])
const CacheTime = z.number().positive().max(Number.MAX_SAFE_INTEGER).describe('Epoch seconds.')
/**
 * TAL-2647: the Agent's prompt-cache window for this session's next request, as of the read. `state` is the Agent's own
 * classification: `warm` before the guaranteed end, `maybe_warm` until the estimated end, `expired` past it. `confidence` says
 * what backs it: `proven` (the response named the tier), `declared` (what was sent, on a route that honours it) or `assumed`
 * (no guarantee). An `unknown` window carries no ends; `reason` names why (`no_published_window` covers routes without one).
 */
export const PromptCacheWindowSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['warm', 'maybe_warm', 'expired']), confidence: z.enum(['proven', 'declared', 'assumed']), reason: z.null(),
    tier: z.enum(['5m', '30m', '1h', '12h', '24h', 'in_memory']).nullable(), guaranteed_until: CacheTime.nullable(), estimated_until: CacheTime.nullable().describe('Null only on a `warm` window whose end is eviction, not a clock (a local endpoint).'),
    coverage: z.array(z.object({ tier: z.enum(['5m', '30m', '1h', '12h']), until: CacheTime })).max(4).describe('One deadline per tier the cached prefix holds, earliest first.'),
  }),
  z.object({
    state: z.literal('unknown'), confidence: z.literal('unknown'),
    reason: z.enum(['session_rotated', 'compacted', 'route_changed', 'storage_unavailable', 'no_published_window', 'invalid']),
    tier: z.null(), guaranteed_until: z.null(), estimated_until: z.null(), coverage: z.array(z.never()).max(0),
  }),
])
export type PromptCacheWindow = z.infer<typeof PromptCacheWindowSchema>
/** A read of the existing owner only. Category estimates are independent of measured occupancy. */
export const ContextDetailSchema = z.object({
  available: z.boolean(), reason: z.enum(['not_built', 'unsupported', 'changed', 'unavailable']).nullable(),
  used_tokens: Tokens, window_tokens: Tokens, window_source: ContextWindowSourceSchema.nullable(), estimated_total: Tokens,
  source: z.enum(['local_estimate', 'provider_usage', 'provider_usage_plus_estimate']).nullable(), estimated: z.boolean().nullable(),
  categories: z.array(z.object({ id: ContextCategoryIdSchema, tokens: Tokens.unwrap(), percent: z.number().min(0).max(100).nullable(), estimated: z.literal(true) })).max(8),
  files: z.array(z.object({ label: z.enum(['AGENTS.md', 'SOUL.md', '.hermes.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md', 'Context file']), characters: Tokens, tokens: Tokens,
    status: z.enum(['loaded', 'truncated', 'flagged', 'shadowed', 'blocked', 'empty', 'unreadable', 'suppressed', 'unknown']), loaded: z.boolean().nullable() })).max(64),
  truncated: z.boolean(), current_turn_output_tokens: Tokens, last_turn_output_tokens: Tokens,
  prompt_cache: PromptCacheWindowSchema.nullable().optional().describe('TAL-2647: null when the Agent has no window (before v0.23.2, or no cache touched yet); absent from older servers.'),
})
export type ContextDetail = z.infer<typeof ContextDetailSchema>
export const unavailableContextDetail = (reason: NonNullable<ContextDetail['reason']> = 'unavailable'): ContextDetail => ({
  available: false, reason, used_tokens: null, window_tokens: null, window_source: null, estimated_total: null, source: null, estimated: null,
  categories: [], files: [], truncated: false, current_turn_output_tokens: null, last_turn_output_tokens: null, prompt_cache: null,
})
