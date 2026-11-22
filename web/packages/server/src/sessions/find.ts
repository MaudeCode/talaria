/** TAL-2666: find in chat, over the text a chat's public (projected, redacted) messages show on their own rows. */
import type { SessionFindMatch } from '@maudecode/talaria-web-contracts'
import { messageText } from './merge.js'
import { transcriptRowKey } from './transcript-row.js'

type Row = Record<string, unknown>
const isDict = (v: unknown): v is Row => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * The text a row shows on its own: a user message's text, or a settled turn's answer on the reply row carrying its scene.
 * Everything a turn folds under "Worked", a running turn, and markers, notices, deliveries and background updates: none.
 */
function shownText(m: Row): string {
  if (m._display !== 'row' || m._marker_kind || m._notice_kind || m._delivery || m._background_update || m._talaria_activity) return ''
  if (m.role === 'user') return typeof m._display_text === 'string' ? m._display_text : messageText(m.content)
  const scene = m._anchor_activity_scene
  if (m.role !== 'assistant' || !isDict(scene) || scene.terminal_state === 'running') return ''
  const shown = scene.final_answer_display ?? scene.final_answer
  return typeof shown === 'string' ? shown : ''
}

/**
 * Case and accents dropped; a combining mark folds to nothing. Final sigma folds like sigma, so a string folds the same
 * whole as one code point at a time.
 */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ς', 'σ')

/** How many folded units the code point at `at` becomes, and its UTF-16 length; ASCII folds to one unit without normalizing. */
function unitAt(text: string, at: number): { width: number; length: number } {
  const code = text.codePointAt(at)!
  if (code < 0x80) return { width: 1, length: 1 }
  const cp = String.fromCodePoint(code)
  return { width: fold(cp).length, length: cp.length }
}

interface Range { start: number; end: number }

/**
 * At most `limit` non-overlapping ranges of `query` in `text`, case- and accent-blind; a match keeps the combining marks
 * that follow it. Offsets are mapped back in one walk that stops at the last match, holding no per-character index.
 */
export function findRanges(text: string, query: string, limit = Number.POSITIVE_INFINITY): Range[] {
  const needle = fold(query)
  if (!needle.trim() || limit <= 0) return []
  const hay = fold(text)
  const starts: number[] = []
  for (let i = hay.indexOf(needle); i >= 0 && starts.length < limit; i = hay.indexOf(needle, i + needle.length)) starts.push(i)
  const ranges: Range[] = []
  // `unit` folded units come before the code point at `at`.
  let at = 0
  let unit = 0
  let cp = starts.length ? unitAt(text, 0) : { width: 0, length: 0 }
  const step = () => { unit += cp.width; at += cp.length; cp = unitAt(text, at) }
  for (const first of starts) {
    while (unit + cp.width <= first) step()
    const start = at
    const last = first + needle.length - 1
    while (unit + cp.width <= last) step()
    let end = at + cp.length
    // Marks fold to nothing: they belong to the last matched character.
    while (end < text.length) {
      const next = unitAt(text, end)
      if (next.width) break
      end += next.length
    }
    ranges.push({ start, end })
  }
  return ranges
}

/** Find answers at most this many matches; `truncated` says more exist. */
export const FIND_MATCH_LIMIT = 1000

/** The first `FIND_MATCH_LIMIT` matches among public detail `rows` starting at absolute `offset`, in transcript order. */
export function sessionFindMatches(rows: readonly unknown[], offset: number, query: string): { matches: SessionFindMatch[]; truncated: boolean } {
  const matches: SessionFindMatch[] = []
  for (const [index, m] of rows.entries()) {
    if (matches.length > FIND_MATCH_LIMIT) break
    if (!isDict(m)) continue
    // One past the limit, to know whether more exist.
    for (const range of findRanges(shownText(m), query, FIND_MATCH_LIMIT + 1 - matches.length)) matches.push({ message_id: transcriptRowKey(m, offset + index), range })
  }
  return { matches: matches.slice(0, FIND_MATCH_LIMIT), truncated: matches.length > FIND_MATCH_LIMIT }
}
