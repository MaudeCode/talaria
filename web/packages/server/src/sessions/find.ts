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

/** `text` folded, with each folded UTF-16 unit's source code point as `[start, end)` in `text`. */
function folded(text: string): { text: string; from: number[]; to: number[] } {
  let out = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  for (const cp of text) {
    const f = fold(cp)
    out += f
    for (let units = f.length; units > 0; units -= 1) { from.push(at); to.push(at + cp.length) }
    at += cp.length
  }
  return { text: out, from, to }
}

/** Non-overlapping ranges of `query` in `text`, case- and accent-blind; a match keeps the combining marks that follow it. */
export function findRanges(text: string, query: string): { start: number; end: number }[] {
  const needle = fold(query)
  // The whole-text fold is native and cheap; only a row that matches pays for the per-character map.
  if (!needle.trim() || !fold(text).includes(needle)) return []
  const hay = folded(text)
  const ranges: { start: number; end: number }[] = []
  for (let i = hay.text.indexOf(needle); i >= 0; i = hay.text.indexOf(needle, i + needle.length)) {
    let end = hay.to[i + needle.length - 1]!
    // Marks fold to nothing, so the next folded unit starts past them: they belong to the last matched character.
    while (end < text.length) {
      const next = String.fromCodePoint(text.codePointAt(end)!)
      if (fold(next)) break
      end += next.length
    }
    ranges.push({ start: hay.from[i]!, end })
  }
  return ranges
}

/** Every match among public detail `rows` starting at absolute `offset`, in transcript order. */
export function sessionFindMatches(rows: readonly unknown[], offset: number, query: string): SessionFindMatch[] {
  return rows.flatMap((m, index) => (isDict(m) ? findRanges(shownText(m), query).map((range) => ({ message_id: transcriptRowKey(m, offset + index), range })) : []))
}
