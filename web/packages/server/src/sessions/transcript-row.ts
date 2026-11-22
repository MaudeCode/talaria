/** What the transcript makes of one stored row, shared by the public projection, the outline and content search (TAL-1922). */
import { str } from '../util.js'
import { messageCountsAsRenderable } from './window.js'

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

/**
 * TAL-2676: the key of the first renderable row after the row keyed `viewed` (null: the transcript was empty then), or
 * null when nothing renderable follows it or it is gone (a /clear or rewrite since: no rule rather than a wrong one).
 */
export function firstUnreadKey(rows: readonly unknown[], viewed: string | null): string | null {
  const after = viewed === null ? 0 : rows.findLastIndex((row, index) => isRow(row) && transcriptRowKey(row, index) === viewed) + 1
  if (!after && viewed !== null) return null
  for (let index = after; index < rows.length; index += 1) {
    const row = rows[index]
    if (isRow(row) && messageCountsAsRenderable(row)) return transcriptRowKey(row, index)
  }
  return null
}

const isRow = (v: unknown): v is Row => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
