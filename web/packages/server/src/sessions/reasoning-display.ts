import { normalizeAssistantDisplay } from './merge.js'

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const REASONING_FIELDS = new Set(['reasoning', 'reasoning_content', 'thinking', 'reasoning_titles', 'reasoning_details', 'codex_reasoning_items'])
const CONTAINERS = new Set(['session', 'messages', 'context_messages', 'runtime_journal_snapshot', '_anchor_activity_scene', 'anchor_activity_scenes', 'scene', 'activity_rows', 'rows'])

/** Display-only copies at the wire boundary; stored transcripts and Agent context retain their reasoning. */
export function reasoningProjection<T>(value: T, show: boolean): T {
  if (show) return value
  if (Array.isArray(value)) return value.filter((row: unknown) => !record(row) || !['reasoning', 'thinking'].includes(String(row.role))).map((row: unknown) => reasoningProjection(row, false)) as T
  if (!record(value)) return value
  const source = normalizeAssistantDisplay(value)
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    if (REASONING_FIELDS.has(key)) continue
    // Scene records are keyed by opaque message references, rather than fixed schema keys.
    if (key === 'anchor_activity_scenes' && record(child)) result[key] = Object.fromEntries(Object.entries(child).map(([ref, scene]) => [ref, reasoningProjection(scene, false)]))
    else result[key] = CONTAINERS.has(key) ? reasoningProjection(child, false) : child
  }
  // Explicit clears replace cached reasoning on clients that preserve omitted message fields.
  if (source.role === 'assistant') { result.reasoning = ''; result.reasoning_titles = [] }
  return result as T
}
