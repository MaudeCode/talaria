/**
 * External-link confirmation (TAL-279). The settings store keeps `trusted_link_hosts`
 * through `normalizeTrustedLinkHosts`; `POST /api/settings/link-check` answers
 * `checkExternalLink` for each chat link click. The list only gates that
 * click warning: it never changes URL sanitization or server outbound trust.
 */

export const TRUSTED_LINK_HOSTS_MAX = 100

/** A bare hostname as the browser URL parser normalizes it, or null for anything else (scheme, port, path, userinfo, wildcard). */
export function normalizeTrustedLinkHost(entry: unknown): string | null {
  if (typeof entry !== 'string') return null
  const host = entry.trim()
  if (!host || /[\s/\\?#@*%]/.test(host)) return null
  // A colon is only valid inside a bracketed IPv6 literal; `example.com:443` would otherwise lose its default port silently.
  if (host.startsWith('[') ? !host.endsWith(']') : host.includes(':')) return null
  let url: URL
  try {
    url = new URL(`https://${host}`)
  } catch {
    return null
  }
  return url.hostname && url.port === '' && url.pathname === '/' ? url.hostname : null
}

/** Valid entries, normalized and deduplicated in order; a non-list is empty. */
export function normalizeTrustedLinkHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts = new Set<string>()
  for (const entry of value) {
    const host = normalizeTrustedLinkHost(entry)
    if (host) hosts.add(host)
    if (hosts.size >= TRUSTED_LINK_HOSTS_MAX) break
  }
  return [...hosts]
}

export interface LinkPreferences {
  confirm: boolean
  trustedHosts: readonly string[]
}

/** The saved preferences as the link check reads them: anything but an explicit `false` keeps the confirmation. */
export function linkPreferences(settings: Record<string, unknown>): LinkPreferences {
  return { confirm: settings.confirm_external_links !== false, trustedHosts: normalizeTrustedLinkHosts(settings.trusted_link_hosts) }
}

export interface ExternalLinkCheck {
  /** Only absolute HTTP(S) URLs, when confirmation is off or the exact hostname is trusted. */
  opens_directly: boolean
  /** The hostname the confirmation dialog names; null when the URL has none. */
  host: string | null
}

/** The click decision and the dialog's destination, from one URL parse. */
export function checkExternalLink(href: string, prefs: LinkPreferences): ExternalLinkCheck {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { opens_directly: false, host: null }
  }
  const http = url.protocol === 'http:' || url.protocol === 'https:'
  return { opens_directly: http && (!prefs.confirm || prefs.trustedHosts.includes(url.hostname)), host: url.hostname || null }
}

export function externalLinkOpensDirectly(href: string, prefs: LinkPreferences): boolean {
  return checkExternalLink(href, prefs).opens_directly
}
