/**
 * Same-origin / CSRF provenance checks, allowlisted public origins, trusted
 * proxy networks, and forwarded client IP resolution (Python `api/routes.py`).
 */
import { BlockList, SocketAddress, isIP } from 'node:net'
import { truthy, type Env } from '../config.js'

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

export interface ProxyTrust {
  /** Loopback peers count as proxies without being listed; per-client throttles turn this off. */
  implicitLoopback?: boolean
}

interface ProxyCidr { addr: string; bits: number; type: 'ipv4' | 'ipv6' }

/** The valid `HERMES_WEBUI_TRUSTED_PROXY_CIDRS` entries; a bare address is a full-length prefix, malformed entries are skipped. */
function proxyCidrEntries(env: Env): ProxyCidr[] {
  const out: ProxyCidr[] = []
  for (const rawToken of (env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS ?? '').replace(/;/g, ',').split(',')) {
    const token = rawToken.trim()
    if (!token) continue
    const [addr = '', prefix] = token.split('/')
    const family = isIP(addr)
    if (!family) continue
    const max = family === 4 ? 32 : 128
    const bits = prefix === undefined ? max : Number(prefix)
    if ((prefix !== undefined && !/^\d+$/.test(prefix)) || bits < 0 || bits > max) continue
    out.push({ addr, bits, type: family === 4 ? 'ipv4' : 'ipv6' })
  }
  return out
}

export function trustedProxyNetworks(env: Env, { implicitLoopback = true }: ProxyTrust = {}): BlockList {
  const list = new BlockList()
  if (implicitLoopback) {
    list.addSubnet('127.0.0.0', 8, 'ipv4')
    list.addSubnet('::1', 128, 'ipv6')
    list.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
  }
  for (const { addr, bits, type } of proxyCidrEntries(env)) {
    try { list.addSubnet(addr, bits, type) } catch { /* fail closed */ }
  }
  return list
}

/** Whether `HERMES_WEBUI_TRUSTED_PROXY_CIDRS` trusts any proxy beyond the loopback networks. */
export function trustsProxyBeyondLoopback(env: Env): boolean {
  return proxyCidrEntries(env).some(({ addr, bits, type }) => {
    if (type === 'ipv4') return !(addr.startsWith('127.') && bits >= 8)
    const mapped = ipv4Mapped(addr)
    return mapped ? !(mapped.startsWith('127.') && bits >= 104) : !(isLoopback(addr) && bits === 128)
  })
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

export function rawPeerIsTrustedProxy(peer: string, env: Env, trust: ProxyTrust = {}): boolean {
  return Boolean(peer) && ipInNetworks(peer, trustedProxyNetworks(env, trust))
}

/**
 * One spelling per address: compressed lower-case IPv6, IPv4-mapped IPv6 as IPv4; null when not an address.
 * A scoped IPv6 address is null too: its zone id is free-form text that `SocketAddress` would silently drop.
 */
export function canonicalIp(addr: string): string | null {
  if (addr.includes('%')) return null
  const family = isIP(addr)
  if (!family) return null
  try {
    const canonical = new SocketAddress({ address: addr, family: family === 4 ? 'ipv4' : 'ipv6' }).address
    return ipv4Mapped(canonical) ?? canonical
  } catch {
    return null
  }
}

/**
 * Real client IP behind a trusted proxy: walk X-Forwarded-For right to left
 * skipping trusted hops (`trust` as for the peer); fail closed (null) on
 * malformed chains.
 */
export function forwardedClientIp(xff: string[], realIp: string | undefined, peer: string, env: Env, trust: ProxyTrust = {}): string | null {
  const hops = xff.flatMap((v) => v.split(',').map((t) => t.trim()))
  if (xff.length) {
    if (!hops.some(Boolean)) return null
    const nets = trustedProxyNetworks(env, trust)
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

/**
 * The key for per-client throttles (password, passkey, native OIDC start,
 * TTS). Stricter than `forwardedClientIp`, whose implicit loopback and
 * X-Real-IP trust the onboarding and local-origin gates keep. Forwarded
 * identity counts only with the opt-in, a raw peer listed in
 * HERMES_WEBUI_TRUSTED_PROXY_CIDRS (loopback included, for the peer and every
 * skipped hop alike), a non-empty
 * X-Forwarded-For chain with no empty field, and every X-Real-IP field naming
 * the same address. Anything else keys on the socket peer, so a client cannot
 * pick a fresh budget by rotating a header.
 */
export function throttleClientIp(xff: string[], realIp: string[], peer: string, env: Env): string {
  const explicit = { implicitLoopback: false }
  if (!truthy(env.HERMES_WEBUI_TRUST_FORWARDED_FOR) || !rawPeerIsTrustedProxy(peer, env, explicit)) return peer
  if (!xff.length || xff.some((field) => field.split(',').some((hop) => !hop.trim()))) return peer
  const forwarded = forwardedClientIp(xff, undefined, peer, env, explicit)
  const client = forwarded === null ? null : canonicalIp(forwarded)
  if (client === null) return peer
  return realIp.flatMap((field) => field.split(',')).every((value) => canonicalIp(value.trim()) === client) ? client : peer
}

export type ForwardedLogFields = { forwarded_for: string } | { forwarded_for_ignored: true } | Record<string, never>

/**
 * Request-log client identity. `forwarded_for` comes only from the X-Forwarded-For walk (never X-Real-IP,
 * which a proxy relays from the client unchanged) behind an opted-in trusted peer, as a canonical address
 * other than the peer. A nonblank chain that yields nothing is flagged without its text; no chain adds neither.
 */
export function forwardedLogFields(xff: string[], peer: string, env: Env): ForwardedLogFields {
  if (!xff.some((v) => v.trim())) return {}
  if (truthy(env.HERMES_WEBUI_TRUST_FORWARDED_FOR) && rawPeerIsTrustedProxy(peer, env)) {
    const client = canonicalIp(forwardedClientIp(xff, undefined, peer, env) ?? '')
    if (client && client !== canonicalIp(peer)) return { forwarded_for: client }
  }
  return { forwarded_for_ignored: true }
}
