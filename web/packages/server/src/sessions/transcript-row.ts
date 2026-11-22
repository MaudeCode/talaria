/** What the transcript makes of one stored row, shared by the public projection, the outline and content search (TAL-1922). */
import { str } from '../util.js'

type Row = Record<string, unknown>

/**
 * A row's display decided by its kind alone: a tool result or a steer shows inside its turn's scene; a row without a
 * role, a silent background row or a hidden row never shows. `null`: its content decides.
 */
export function kindDisplay(row: Row): 'in_scene' | 'hidden' | null {
  if (row.role === 'tool' || row._steer) return 'in_scene'
  if (!row.role || row._background_silent || row.display_kind === 'hidden') return 'hidden'
  return null
}

/** The transcript's key for the row at absolute `index`: its `message_id` or `id` (a string or number), else `${index}-${role}`. */
export function transcriptRowKey(row: Row, index: number): string {
  const id = row.message_id ?? row.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : `${String(index)}-${str(row.role)}`
}

/** TAL-2676: where a profile last viewed a chat: its last row's key and timestamp then (key null: the chat was empty). */
export interface ViewedRow { message_id: string | null; timestamp: number | null }

/** TAL-2676: the position a public detail page starting at absolute `offset` ends at: its last row. */
export function viewedRow(rows: readonly unknown[], offset: number): ViewedRow {
  const last = rows.length - 1
  const row = rows[last]
  return isRow(row) ? { message_id: transcriptRowKey(row, offset + last), timestamp: rowTimestamp(row) } : { message_id: null, timestamp: null }
}

/**
 * TAL-2676: the key of the first standalone row (`_display: 'row'`, the projection's own decision) after `viewed` among
 * public detail rows starting at absolute `offset`; null when none follows. `undefined`: the page does not reach the
 * viewed row. A row is the viewed one only with the same key and timestamp, so one a /clear, truncation or retry put
 * at the same position never is.
 */
export function unreadAfter(rows: readonly unknown[], offset: number, viewed: ViewedRow | null): string | null | undefined {
  let start = 0
  if (viewed?.message_id === null && offset > 0) return undefined
  if (viewed && viewed.message_id !== null) {
    start = rows.findLastIndex((row, index) => isRow(row) && transcriptRowKey(row, offset + index) === viewed.message_id && rowTimestamp(row) === viewed.timestamp) + 1
    if (!start) return undefined
  }
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]
    if (isRow(row) && row._display === 'row') return transcriptRowKey(row, offset + index)
  }
  return null
}

const isRow = (v: unknown): v is Row => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const rowTimestamp = (row: Row): number | null => (typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) ? row.timestamp : null)
