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
