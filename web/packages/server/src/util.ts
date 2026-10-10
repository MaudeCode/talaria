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

/** The image formats a provider accepts inline; the MIME comes from the bytes, never from the client. */
/**
 * Python `_IMAGE_MAGIC` / `_is_valid_image`: the declared MIME must match the file's signature; BMP joins the binary
 * set, and SVG (text, no signature) is accepted on its declared type when the bytes read as an SVG document.
 */
export function sniffImageMime(bytes: Buffer, declared = ''): string | null {
  const mime = declared.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mime === 'image/svg+xml') return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8')) ? 'image/svg+xml' : null
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp'
  return null
}
