/**
 * TAL-1649: which skills a direct conversation loaded, counted by the server from successful loads it saw resolve: an
 * Agent `skill_view` completing in the session's own run, or an explicit skill or bundle load naming the session. Never
 * inferred from transcript text. Persisted as additive `extra` keys (upstream's `skill_provenance` name → count map and
 * its `skill_provenance_generation` clear fence), so a release without them keeps them untouched.
 */
import type { Session } from './session.js'
import { isDict } from './merge.js'

const COUNTS_KEY = 'skill_provenance'
const GENERATION_KEY = 'skill_provenance_generation'

/** The persisted counts, keeping only nonempty names with a positive integer count; anything else reads as absent. */
export function skillCounts(s: Session): Map<string, number> {
  const raw = s.extra[COUNTS_KEY]
  const counts = new Map<string, number>()
  if (!isDict(raw)) return counts
  for (const [name, count] of Object.entries(raw)) if (name && typeof count === 'number' && Number.isInteger(count) && count > 0) counts.set(name, count)
  return counts
}

/** The clear fence a load captures before it resolves; a clear advances it, so a load that started earlier never counts. */
export function skillGeneration(s: Session): number {
  const raw = s.extra[GENERATION_KEY]
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0
}

/** Adds one use per name; false when nothing countable was given. */
export function addSkillUses(s: Session, names: readonly unknown[]): boolean {
  const counts = skillCounts(s)
  let changed = false
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
    changed = true
  }
  if (changed) s.extra[COUNTS_KEY] = Object.fromEntries(counts)
  return changed
}

/** Clear: no counts survive, and every load that captured the old generation is fenced out. */
export function resetSkillUses(s: Session): void {
  Reflect.deleteProperty(s.extra, COUNTS_KEY)
  s.extra[GENERATION_KEY] = skillGeneration(s) + 1
}

/** The provenance a copy of `source` inherits: all of it for a whole-history copy, none for a partial one. */
export function inheritedSkillUses(source: Session, wholeHistory: boolean): Record<string, unknown> {
  const counts = skillCounts(source)
  return wholeHistory && counts.size ? { [COUNTS_KEY]: Object.fromEntries(counts) } : {}
}

/** Most used first, then by name: the one order every client shows. */
export function orderedSkillCounts(s: Session): { name: string; count: number }[] {
  return [...skillCounts(s)].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The canonical name of a successful structured `skill_view` result, else null (failed, errored, malformed, other tool). */
export function successfulSkillViewName(toolName: unknown, raw: unknown): string | null {
  if (toolName !== 'skill_view') return null
  let result = raw
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return null }
  }
  if (!isDict(result) || result.success !== true || result.error) return null
  return typeof result.name === 'string' && result.name.trim() ? result.name : null
}
