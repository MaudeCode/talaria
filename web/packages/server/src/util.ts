/** Python-flavoured coercions shared by the ported domains. */
import { constants as osConstants } from 'node:os'

const errnoConstants: Record<string, number> = osConstants.errno

export interface SingleFlightEntry<T> { until: number; read: Promise<T> }

/**
 * `read`'s answer for `ttl` (in `now`'s units) after it settles, and to every caller while it runs. An entry removed from
 * `cache` during its read stays removed: the read still answers its own callers, and the next one starts afresh.
 */
export function singleFlightRead<K, T>(cache: { get: (key: K) => SingleFlightEntry<T> | undefined; set: (key: K, entry: SingleFlightEntry<T>) => unknown }, key: K, ttl: number, now: () => number, read: () => Promise<T>): Promise<T> {
  const cached = cache.get(key)
  if (cached && cached.until > now()) return cached.read
  const entry: SingleFlightEntry<T> = { until: Infinity, read: read().finally(() => { entry.until = now() + ttl }) }
  cache.set(key, entry)
  return entry.read
}

/** A Settings list filter: whether any of `texts` contains `q`, case-insensitively; a blank `q` keeps every row. */
export function containsQuery(q: string | undefined, texts: readonly unknown[]): boolean {
  const needle = (q ?? '').trim().toLowerCase()
  return !needle || texts.some((text) => typeof text === 'string' && text.toLowerCase().includes(needle))
}

/** `str(v)` for scalars; `null`/`undefined` become `''`, objects go through JSON (never `[object Object]`). */
export function str(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return Object.prototype.toString.call(v)
  }
}

/** Python `repr()` of a plain string: single quotes unless the text contains one and no double quote. */
export function pyRepr(text: string): string {
  return text.includes("'") && !text.includes('"') ? `"${text}"` : `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

const PY_STRERROR: Record<string, string> = {
  EPERM: 'Operation not permitted', ENOENT: 'No such file or directory', EIO: 'Input/output error', EACCES: 'Permission denied',
  EEXIST: 'File exists', ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EINVAL: 'Invalid argument', ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system', ELOOP: 'Too many levels of symbolic links', ENAMETOOLONG: 'File name too long', ENOTEMPTY: 'Directory not empty',
  EBUSY: 'Resource busy', ETXTBSY: 'Text file busy', EXDEV: 'Cross-device link',
}

/** TAL-2716: the answer, HTTP 507, to a write that failed because the server's disk or quota is full. */
export const STORAGE_FULL = { error: 'Storage on the server is full. Free up space on the server, then try again.', condition: 'storage_full' } as const

/** True when the error, or any error in its `cause` chain, is `ENOSPC` or `EDQUOT`. */
export function storageFull(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 16; e = (e as { cause?: unknown }).cause, depth += 1) {
    const code = (e as { code?: unknown }).code
    if (code === 'ENOSPC' || code === 'EDQUOT') return true
  }
  return false
}

/** The C library's text for an errno error (`Permission denied`), else its message. */
export function osErrorText(error: unknown): string {
  const e = error as NodeJS.ErrnoException
  return PY_STRERROR[e.code ?? ''] ?? (e.message || String(error))
}

/** Python `str(OSError)`: `[Errno N] <strerror>: '<path>'`, so error text reads as it did in the Python backend. */
export function pyOsError(error: unknown, path?: string): string {
  const e = error as NodeJS.ErrnoException
  const code = e.code ?? ''
  const num = code ? errnoConstants[code] : undefined
  if (num === undefined) return e.message || String(error)
  const target = path ?? e.path
  const text = `[Errno ${String(num)}] ${PY_STRERROR[code] ?? code}`
  return target ? `${text}: ${pyRepr(target)}` : text
}
/** Keep input order while predicates perform independent asynchronous reads. */
export async function filterAsync<T>(values: readonly T[], predicate: (value: T) => Promise<unknown>): Promise<T[]> {
  const keep = await Promise.all(values.map(predicate))
  return values.filter((_, index) => Boolean(keep[index]))
}
