/**
 * Cookie parsing and `Set-Cookie` formatting matching Python `http.cookies`
 * output byte for byte (attribute order: HttpOnly, Max-Age, Path, SameSite, Secure).
 */

/** RFC 6265 cookie-name token (Python `_COOKIE_NAME_RE`). */
export const COOKIE_NAME_RE = /^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/

/** Parse a `Cookie` header into name → value; quoted values are unquoted like `SimpleCookie`. */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    const name = part.slice(0, at).trim()
    let value = part.slice(at + 1).trim()
    if (!name || !COOKIE_NAME_RE.test(name)) continue
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    if (!out.has(name)) out.set(name, value)
  }
  return out
}

export interface CookieAttrs { httpOnly?: boolean; maxAge?: number | string; path?: string; sameSite?: 'Lax' | 'Strict' | 'None'; secure?: boolean }

/** `SimpleCookie(...).OutputString()`: an empty value renders as `""`. */
export function formatSetCookie(name: string, value: string, attrs: CookieAttrs): string {
  const parts = [`${name}=${value === '' ? '""' : value}`]
  if (attrs.httpOnly) parts.push('HttpOnly')
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`)
  if (attrs.path) parts.push(`Path=${attrs.path}`)
  if (attrs.sameSite) parts.push(`SameSite=${attrs.sameSite}`)
  if (attrs.secure) parts.push('Secure')
  return parts.join('; ')
}
