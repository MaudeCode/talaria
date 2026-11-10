/** TAL-2152: the conversation outline, built from a chat's public (projected, redacted) messages. */
import type { SessionOutlineEntry } from '@maudecode/talaria-web-contracts'
import { markdownPlainText } from '../text/markdown.js'
import { str } from '../util.js'
import { messageText } from './merge.js'

export const OUTLINE_EXCERPT_MAX = 120
/** A chat shows its outline from this many questions; a shorter one is read whole at a glance. */
export const OUTLINE_MIN_ENTRIES = 4

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const FENCE = /^\s*(?:```|~~~)/

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** At most `OUTLINE_EXCERPT_MAX` characters as a reader counts them, never splitting an emoji. */
function capped(text: string): string {
  const chars = Array.from(graphemes.segment(text), (part) => part.segment)
  return chars.length <= OUTLINE_EXCERPT_MAX ? text : `${chars.slice(0, OUTLINE_EXCERPT_MAX - 1).join('').trimEnd()}…`
}

/** The first line a reader sees, without Markdown, capped; an attachment-only message names its files. */
export function outlineExcerpt(message: Record<string, unknown>): string {
  for (const line of messageText(message.content).split('\n')) {
    if (!line.trim() || FENCE.test(line)) continue
    const plain = markdownPlainText(line)
    if (plain) return capped(plain)
  }
  const files = Array.isArray(message.attachments) ? message.attachments.map((a) => (isDict(a) ? str(a.name) : str(a))).filter(Boolean) : []
  return capped(files.join(', '))
}

/**
 * One entry per user message among `rows` (public transcript messages at their absolute positions, the coordinates its
 * pages use): every row the transcript shows as the user's (markers, deliveries, notices and background updates are not),
 * and every steer.
 */
export function outlineEntries(rows: readonly { message: unknown; index: number }[]): SessionOutlineEntry[] {
  return rows.flatMap(({ message: m, index }) => {
    if (!isDict(m) || m.role !== 'user') return []
    if (!m._steer && (m._display !== 'row' || m._marker_kind || m._delivery || m._notice_kind || m._background_update)) return []
    const id = m.message_id ?? m.id
    return [{
      // The transcript's row key (`messageKey`), so a jump finds the row this entry names.
      message_id: typeof id === 'string' || typeof id === 'number' ? String(id) : `${String(index)}-user`,
      index,
      excerpt: outlineExcerpt(m),
      created_at: typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : null,
    }]
  })
}
