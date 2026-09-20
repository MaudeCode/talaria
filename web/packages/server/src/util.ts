/** Python-flavoured coercions shared by the ported domains. */

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
