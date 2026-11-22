import { str } from '../../util.js'
import { kindDisplay, transcriptRowKey } from '../transcript-row.js'
type Row = Record<string, unknown>

/** A row's searchable text. A hidden row has none, so search neither finds nor previews it; it still counts toward row indexes. */
export function sessionSearchMessageText(message: unknown): string {
  if (!message || typeof message !== 'object' || (message as Row).display_kind === 'hidden') return ''
  const content = (message as Row).content
  if (Array.isArray(content)) return content.filter((p): p is Row => Boolean(p) && typeof p === 'object' && (p as Row).type === 'text').map((p) => str(p.text)).join(' ')
  return str(content)
}

/**
 * TAL-1922: the stored row at absolute index `idx` as search sees it: its text, and the transcript key a content hit on it
 * lands on, null when the transcript does not show the row on its own (a tool result or steer inside its turn).
 */
export function sessionSearchEntry(message: unknown, idx: number): { text: string; key: string | null } {
  const text = sessionSearchMessageText(message)
  if (!text) return { text, key: null }
  const row = message as Row
  return { text, key: kindDisplay(row) === null ? transcriptRowKey(row, idx) : null }
}

/** TAL-453: a query's distinct whitespace-separated terms, lowercased; a row matches when one field holds them all. */
export function sessionSearchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

export function sessionSearchMatches(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return terms.length > 0 && terms.every((term) => lower.includes(term))
}
