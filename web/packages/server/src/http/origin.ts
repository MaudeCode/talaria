/**
 * Same-origin / CSRF provenance checks, allowlisted public origins, trusted
 * proxy networks, and forwarded client IP resolution (Python `api/routes.py`).
 */
import { BlockList, isIP } from 'node:net'
import type { Env } from '../config.js'

export function normalizeHostPort(value: string): [string, string | null] {
  const v = value.trim().toLowerCase()
  if (!v) return ['', null]
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    if (end !== -1) {
      const host = v.slice(1, end)
      const rest = v.slice(end + 1)
      if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) return [host, rest.slice(1)]
      return [host, null]
    }
  }
  if (v.split(':').length === 2) {
    const at = v.lastIndexOf(':')
    const host = v.slice(0, at)
    const port = v.slice(at + 1)
    if (/^\d+$/.test(port)) return [host, port]
  }
  return [v, null]
}

export function portsMatch(originScheme: string, originPort: string | null, allowedPort: string | null): boolean {
  if (originPort === allowedPort) return true
  const def = originScheme === 'https' ? '443' : '80'
  if (!originPort && allowedPort === def) return true
  if (!allowedPort && originPort === def) return true
  return false
}

export function allowedPublicOrigins(env: Env, warn: (line: string) => void = () => undefined): Set<string> {
  const out = new Set<string>()
  for (const raw of (env.HERMES_WEBUI_ALLOWED_ORIGINS ?? '').split(',')) {
    const value = raw.trim().replace(/\/+$/, '').toLowerCase()
    if (!value) continue
    if (!value.startsWith('http://') && !value.startsWith('https://')) {
      warn(`HERMES_WEBUI_ALLOWED_ORIGINS entry ${JSON.stringify(value)} is missing the scheme (expected https://hostname or http://hostname). Entry ignored.`)
      continue
    }
    out.add(value)
  }
  return out
}

export type CsrfFailure = 'origin_mismatch' | 'token_mismatch' | null

export interface ProvenanceHeaders {
  origin?: string | undefined
  referer?: string | undefined
  host?: string | undefined
  secFetchSite?: string | undefined
  forwardedHost?: string | undefined
  realHost?: string | undefined
}

/**
 * Returns null when the browser request is same-origin or allowlisted; else
 * the failure reason. Non-browser clients (no provenance headers) pass unless
 * `requireProvenance` is set.
 */
export function checkSameOriginBrowserRequest(h: ProvenanceHeaders, env: Env, opts: { requireProvenance?: boolean } = {}): CsrfFailure {
  const origin = h.origin ?? ''
  const referer = h.referer ?? ''
  const host = h.host ?? ''
  const secFetchSite = (h.secFetchSite ?? '').trim().toLowerCase()
  if (!(origin || referer || secFetchSite)) return opts.requireProvenance ? 'origin_mismatch' : null
  if (secFetchSite === 'cross-site') return 'origin_mismatch'
  const target = origin || referer
  if (!target) {
    if (secFetchSite === 'none') return null
    if (secFetchSite === 'same-origin') return opts.requireProvenance ? 'origin_mismatch' : null
    return 'origin_mismatch'
  }
  const m = /^https?:\/\/([^/]+)/.exec(target)
  if (!m) return 'origin_mismatch'
  const originScheme = m[0].split('://')[0]?.toLowerCase() ?? ''
  const [originName, originPort] = normalizeHostPort(m[1] ?? '')
  const originValue = m[0].replace(/\/+$/, '').toLowerCase()
  if (allowedPublicOrigins(env).has(originValue)) return null
  const allowedHosts = [host].map((s) => s.trim()).filter(Boolean)
  if (['1', 'true', 'yes', 'on'].includes((env.HERMES_WEBUI_TRUST_FORWARDED_HOST ?? '').trim().toLowerCase())) {
    for (const value of [h.forwardedHost ?? '', h.realHost ?? '']) if (value.trim()) allowedHosts.push(value.trim())
  }
  for (const allowed of allowedHosts) {
    const [allowedName, allowedPort] = normalizeHostPort(allowed)
    if (originName === allowedName && portsMatch(originScheme, originPort, allowedPort)) return null
  }
  return 'origin_mismatch'
}

export function isBrowserUnsafeRequest(h: ProvenanceHeaders): boolean {
  return Boolean(h.origin) || Boolean(h.referer)
}

export function csrfRejectionError(reason: CsrfFailure): string {
  if (reason === 'origin_mismatch') return 'Cross-origin mismatch - check reverse proxy headers'
  if (reason === 'token_mismatch') return 'Session expired - reload the page'
  return 'Cross-origin request rejected'
}

// ── trusted proxies ───────────────────────────────────────────────────────

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:10.0.0.1` also matches IPv4 networks. */
export function ipv4Mapped(addr: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)
  return m ? (m[1] ?? null) : null
}

export function trustedProxyNetworks(env: Env): BlockList {
  const list = new BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addSubnet('::1', 128, 'ipv6')
  list.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
  for (const rawToken of (env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS ?? '').replace(/;/g, ',').split(',')) {
    const token = rawToken.trim()
    if (!token) continue
    const [addr, prefix] = token.split('/')
    const family = isIP(addr ?? '')
    if (!family) continue
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (prefix === undefined) {
      list.addAddress(addr ?? '', type)
      continue
    }
    const bits = Number(prefix)
    const max = family === 4 ? 32 : 128
    if (!/^\d+$/.test(prefix) || bits < 0 || bits > max) continue
    try { list.addSubnet(addr ?? '', bits, type) } catch { /* fail closed */ }
  }
  return list
}

export function ipInNetworks(addr: string, networks: BlockList): boolean {
  const family = isIP(addr)
  if (!family) return false
  if (networks.check(addr, family === 4 ? 'ipv4' : 'ipv6')) return true
  const mapped = ipv4Mapped(addr)
  return mapped !== null && networks.check(mapped, 'ipv4')
}

export function isLoopback(addr: string): boolean {
  const mapped = ipv4Mapped(addr) ?? addr
  if (isIP(mapped) === 4) return mapped.startsWith('127.')
  return isIP(mapped) === 6 && /^(0*:)*0*1$/.test(mapped.toLowerCase())
}

export function rawPeerIsTrustedProxy(peer: string, env: Env): boolean {
  return Boolean(peer) && ipInNetworks(peer, trustedProxyNetworks(env))
}

/**
 * Real client IP behind a trusted proxy: walk X-Forwarded-For right to left
 * skipping trusted hops; fail closed (null) on malformed chains.
 */
export function forwardedClientIp(xff: string[], realIp: string | undefined, peer: string, env: Env): string | null {
  const hops = xff.flatMap((v) => v.split(',').map((t) => t.trim()))
  if (xff.length) {
    if (!hops.some(Boolean)) return null
    const nets = trustedProxyNetworks(env)
    for (const hop of [...hops].reverse()) {
      if (!hop || !isIP(hop)) return null
      if (ipInNetworks(hop, nets)) continue
      return hop
    }
    return peer
  }
  const real = (realIp ?? '').trim()
  if (real) return isIP(real) ? real : null
  return peer
}
