import { str } from '../../util.js'
import { SessionRowSchema } from '@maudecode/talaria-web-contracts'
import type { SessionStore } from '../store.js'
type Row = Record<string, unknown>
const malformedFiles = new WeakMap<SessionStore, Set<string>>()

/** Read-only projection; never let a corrupt identity acquire a generated ID. */
export function sanitizeSessionRow(value: unknown, store: SessionStore, file?: string): Row | null {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
  file ??= str(row.session_id)
  if (file && !file.includes('.') && file !== 'index') file += '.json'
  const mismatchedFile = file.endsWith('.json') && file !== 'index' && row.session_id !== file.slice(0, -5)
  if (!SessionRowSchema.shape.session_id.safeParse(row.session_id).success || mismatchedFile) {
    const logged = malformedFiles.get(store) ?? new Set<string>()
    if (!logged.has(file)) {
      store.deps.log(`[webui] WARNING: skipping session row with invalid session_id in ${JSON.stringify(file)}`)
      logged.add(file)
      malformedFiles.set(store, logged)
    }
    return null
  }
  const result: Row = { ...row, title: row.title ?? '' }
  for (const [key, schema] of Object.entries(SessionRowSchema.shape)) {
    const value = result[key]
    if (value === undefined || schema.safeParse(value).success) continue
    const coerced = typeof value === 'string' && value.trim() !== ''
      ? value.trim() === 'true' ? true : value.trim() === 'false' ? false : Number(value)
      : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined
    const boolean = value === 0 || value === 1 ? value === 1 : coerced === 0 || coerced === 1 ? coerced === 1 : undefined
    if (coerced !== undefined && schema.safeParse(coerced).success) result[key] = coerced
    else if (boolean !== undefined && schema.safeParse(boolean).success) result[key] = boolean
    else if (key === 'title') result[key] = ''
    // Invalid persisted permissions must not turn a locked session into an editable one.
    else if (key === 'read_only') result[key] = true
    else Reflect.deleteProperty(result, key)
  }
  // These persisted flags affect list filtering before the wire flags are computed.
  for (const key of ['pre_compression_snapshot', 'default_hidden', 'has_pending_user_message']) {
    if (result[key] === 'true' || result[key] === 'false') result[key] = result[key] === 'true'
  }
  return result
}

/** TAL-306: the row's `sort_ts`, the time it sorts and date-buckets by on every client. */
