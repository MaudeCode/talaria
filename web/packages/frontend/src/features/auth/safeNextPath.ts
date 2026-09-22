/**
 * Validate a `?next=` redirect target (ported from static/login.js, #5578):
 * path-absolute only, no protocol-relative or backslash variants, no control
 * characters, and never the login route itself even through nested encoding.
 * Returns an app-relative path ('./' means the app root).
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return './'
  if (!raw.startsWith('/')) return './'
  if (raw.charAt(1) === '/' || raw.charAt(1) === '\\') return './'
  if (/[\x00-\x1f\x7f\s]/.test(raw)) return './'
  if (raw.length > 2048) return './'
  let probe = raw
  let stabilized = false
  for (let i = 0; i < 8; i++) {
    const pathOnly = (probe.split('?')[0] ?? '').split('#')[0]?.split('&')[0]?.replace(/\/+$/, '') ?? ''
    if (pathOnly === '/login' || pathOnly.endsWith('/login')) return './'
    let decoded: string
    try {
      decoded = decodeURIComponent(probe)
    } catch {
      stabilized = true
      break
    }
    if (decoded === probe) {
      stabilized = true
      break
    }
    probe = decoded
  }
  if (!stabilized) return './'
  return raw
}
