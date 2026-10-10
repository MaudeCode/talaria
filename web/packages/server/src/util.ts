/** Python-flavoured coercions shared by the ported domains. */
import { constants as osConstants } from 'node:os'

const errnoConstants: Record<string, number> = osConstants.errno

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
