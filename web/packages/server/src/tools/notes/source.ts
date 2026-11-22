/**
 * The port every notes provider sits behind (TAL-1071). The router looks a requested source up in `notesSourcesFor`
 * and calls `search` / `item`; a provider failure throws `NotesSourceError`, whose fixed text the route returns (502).
 */
import type { Dict } from '../../config/agent-config.js'

export interface NotesSource {
  /** `joplin` or `folder:<name>`. */
  readonly id: string
  readonly name: string
  readonly kind: 'joplin' | 'folder'
  /** `signal` aborts when the request goes away; a provider with its own short timeout may ignore it. */
  search(query: string, limit: number, signal?: AbortSignal): Promise<Dict[]>
  item(id: string): Promise<Dict>
}

/** A provider call that failed; its message is fixed text safe to return to the client (Python `ValueError`). */
export class NotesSourceError extends Error {}

/** Results per search: `limit` clamped to 1-50. */
export const searchLimit = (limit: number): number => Math.max(1, Math.min(limit, 50))

/** Python `_note_snippet`: whitespace collapsed, started near the first match, cut at `limit`. */
export function noteSnippet(body: string, query: string, limit = 220): string {
  let text = body.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const q = query.trim().toLowerCase()
  if (q) {
    const idx = text.toLowerCase().indexOf(q)
    if (idx > 40) text = '…' + text.slice(Math.max(0, idx - 60))
  }
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text
}

/** A preview body: cut at 50,000 characters with a notice. Redaction follows. */
export function previewBody(body: string): string {
  return body.length > 50_000 ? body.slice(0, 50_000).trimEnd() + '\n\n[Preview truncated at 50,000 characters]' : body
}
