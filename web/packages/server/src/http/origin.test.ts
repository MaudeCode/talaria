import { describe, expect, it } from 'vitest'
import { allowedPublicOrigins, canonicalIp, checkSameOriginBrowserRequest, forwardedClientIp, isLoopback, normalizeHostPort, portsMatch, rawPeerIsTrustedProxy, throttleClientIp, trustsProxyBeyondLoopback } from './origin.js'
import { buildCspEnforcedPolicy, buildCspReportOnlyPolicy, cspExtras } from './csp.js'

describe('host and port normalisation', () => {
  it('splits host:port and bracketed IPv6', () => {
    expect(normalizeHostPort('Example.com:8080')).toEqual(['example.com', '8080'])
    expect(normalizeHostPort('[::1]:8787')).toEqual(['::1', '8787'])
    expect(normalizeHostPort('[::1]')).toEqual(['::1', null])
    expect(normalizeHostPort('example.com')).toEqual(['example.com', null])
    expect(normalizeHostPort('')).toEqual(['', null])
  })

  it('treats absent ports as the scheme default', () => {
    expect(portsMatch('https', null, '443')).toBe(true)
    expect(portsMatch('http', '80', null)).toBe(true)
    expect(portsMatch('http', null, '443')).toBe(false)
    expect(portsMatch('https', '8443', '443')).toBe(false)
  })
})

describe('same-origin browser check', () => {
  const host = '127.0.0.1:8787'
  it('accepts same-origin, allowlisted, and non-browser requests; rejects the rest', () => {
    expect(checkSameOriginBrowserRequest({ origin: 'http://127.0.0.1:8787', host }, {})).toBeNull()
    expect(checkSameOriginBrowserRequest({ referer: 'http://127.0.0.1:8787/settings', host }, {})).toBeNull()
    expect(checkSameOriginBrowserRequest({ host }, {})).toBeNull()
    expect(checkSameOriginBrowserRequest({ host }, {}, { requireProvenance: true })).toBe('origin_mismatch')
    expect(checkSameOriginBrowserRequest({ origin: 'https://evil.example', host }, {})).toBe('origin_mismatch')
    expect(checkSameOriginBrowserRequest({ origin: 'https://app.example:8000', host }, { HERMES_WEBUI_ALLOWED_ORIGINS: 'https://app.example:8000/' })).toBeNull()
    expect(checkSameOriginBrowserRequest({ secFetchSite: 'cross-site', host }, {})).toBe('origin_mismatch')
    expect(checkSameOriginBrowserRequest({ secFetchSite: 'none', host }, {})).toBeNull()
    expect(checkSameOriginBrowserRequest({ secFetchSite: 'same-origin', host }, {})).toBeNull()
    expect(checkSameOriginBrowserRequest({ origin: 'ftp://x', host }, {})).toBe('origin_mismatch')
  })

  it('trusts forwarded hosts only with the opt-in', () => {
    const h = { origin: 'https://ui.example', host, forwardedHost: 'ui.example' }
    expect(checkSameOriginBrowserRequest(h, {})).toBe('origin_mismatch')
    expect(checkSameOriginBrowserRequest(h, { HERMES_WEBUI_TRUST_FORWARDED_HOST: '1' })).toBeNull()
  })

  it('drops allowlist entries without a scheme', () => {
    const warnings: string[] = []
    expect([...allowedPublicOrigins({ HERMES_WEBUI_ALLOWED_ORIGINS: 'app.example, https://ok.example/' }, (l) => warnings.push(l))]).toEqual(['https://ok.example'])
    expect(warnings).toHaveLength(1)
  })
})

describe('trusted proxies and client IPs', () => {
  it('trusts loopback implicitly and CIDRs from the env, skipping malformed entries', () => {
    expect(rawPeerIsTrustedProxy('127.0.0.1', {})).toBe(true)
    expect(rawPeerIsTrustedProxy('::1', {})).toBe(true)
    expect(rawPeerIsTrustedProxy('::ffff:127.0.0.1', {})).toBe(true)
    expect(rawPeerIsTrustedProxy('10.0.0.5', {})).toBe(false)
    expect(rawPeerIsTrustedProxy('10.0.0.5', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '10.0.0.0/8; bogus/99' })).toBe(true)
    expect(rawPeerIsTrustedProxy('::ffff:10.9.9.9', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe(true)
    expect(rawPeerIsTrustedProxy('10.0.0.5', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: 'not-a-cidr' })).toBe(false)
    expect(rawPeerIsTrustedProxy('', {})).toBe(false)
  })

  it('walks X-Forwarded-For right to left and fails closed on malformed chains', () => {
    const env = { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }
    expect(forwardedClientIp(['203.0.113.9, 10.0.0.2'], undefined, '10.0.0.1', env)).toBe('203.0.113.9')
    expect(forwardedClientIp(['203.0.113.9', '10.0.0.2'], undefined, '10.0.0.1', env)).toBe('203.0.113.9')
    expect(forwardedClientIp(['10.0.0.3, 10.0.0.2'], undefined, '10.0.0.1', env)).toBe('10.0.0.1')
    expect(forwardedClientIp([' , '], undefined, '10.0.0.1', env)).toBeNull()
    expect(forwardedClientIp(['203.0.113.9,,10.0.0.2'], undefined, '10.0.0.1', env)).toBeNull()
    expect(forwardedClientIp(['evil, 10.0.0.2'], undefined, '10.0.0.1', env)).toBeNull()
    expect(forwardedClientIp([], '198.51.100.7', '10.0.0.1', env)).toBe('198.51.100.7')
    expect(forwardedClientIp([], 'nope', '10.0.0.1', env)).toBeNull()
    expect(forwardedClientIp([], undefined, '10.0.0.1', env)).toBe('10.0.0.1')
  })

  it('trusts only listed peers when implicit loopback trust is off', () => {
    const explicit = { implicitLoopback: false }
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(rawPeerIsTrustedProxy(peer, {}, explicit), peer).toBe(false)
    expect(rawPeerIsTrustedProxy('127.0.0.1', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }, explicit)).toBe(true)
    expect(rawPeerIsTrustedProxy('::ffff:127.0.0.1', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '127.0.0.1' }, explicit)).toBe(true)
    expect(rawPeerIsTrustedProxy('::1', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }, explicit)).toBe(false)
    expect(rawPeerIsTrustedProxy('::1', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '::1/128' }, explicit)).toBe(true)
    for (const cidrs of ['', ' , ;', 'not-a-cidr', '127.0.0.1/33', '127.0.0.1/x']) expect(rawPeerIsTrustedProxy('127.0.0.1', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: cidrs }, explicit), cidrs).toBe(false)
  })

  it('spells each address one way', () => {
    expect(canonicalIp('2001:0DB8:0:0::1')).toBe('2001:db8::1')
    expect(canonicalIp('::ffff:203.0.113.1')).toBe('203.0.113.1')
    expect(canonicalIp('::FFFF:cb00:7101')).toBe('203.0.113.1')
    expect(canonicalIp('203.0.113.1')).toBe('203.0.113.1')
    expect(canonicalIp('0:0:0:0:0:ffff:cb00:7101')).toBe('203.0.113.1')
    // A zone id is free-form text; the address is rejected rather than silently stripped.
    for (const bad of ['', 'evil', '010.0.0.1', '203.0.113.1 ', 'fe80::1%eth0', '2001:db8::1%x']) expect(canonicalIp(bad), bad).toBeNull()
  })

  it('keys throttles on a forwarded client only behind an explicitly listed proxy with consistent evidence', () => {
    const listed = { HERMES_WEBUI_TRUST_FORWARDED_FOR: '1', HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 127.0.0.1/32' }
    const key = (xff: string[], realIp: string[] = [], peer = '10.0.0.1', env: Record<string, string> = listed): string => throttleClientIp(xff, realIp, peer, env)
    // Opt-in off, implicit loopback, unlisted and direct public peers, and empty or invalid CIDRs key on the peer.
    expect(key(['203.0.113.9'], [], '10.0.0.1', { HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).toBe('10.0.0.1')
    expect(key(['203.0.113.9'], [], '127.0.0.1', { HERMES_WEBUI_TRUST_FORWARDED_FOR: '1' })).toBe('127.0.0.1')
    expect(key(['203.0.113.9'], [], '::1', listed)).toBe('::1')
    expect(key(['203.0.113.9'], [], '198.51.100.4')).toBe('198.51.100.4')
    for (const cidrs of ['', 'bogus', '10.0.0.0/99']) expect(key(['203.0.113.9'], [], '10.0.0.1', { HERMES_WEBUI_TRUST_FORWARDED_FOR: '1', HERMES_WEBUI_TRUSTED_PROXY_CIDRS: cidrs }), cidrs).toBe('10.0.0.1')
    // A listed peer, IPv4-mapped included, resolves the right-most untrusted hop.
    expect(key(['203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['203.0.113.9'], [], '::ffff:10.0.0.1')).toBe('203.0.113.9')
    expect(key(['203.0.113.9'], [], '127.0.0.1')).toBe('203.0.113.9')
    expect(key(['198.51.100.7, 203.0.113.9, 10.0.0.2'])).toBe('203.0.113.9')
    expect(key(['evil, 203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['198.51.100.7', '203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['10.0.0.3, 10.0.0.2'])).toBe('10.0.0.1')
    // Only listed hops are skipped: an unlisted loopback hop is the client, not a proxy.
    const lanOnly = { HERMES_WEBUI_TRUST_FORWARDED_FOR: '1', HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }
    expect(key(['198.51.100.7, 127.0.0.1'], [], '10.0.0.1', lanOnly)).toBe('127.0.0.1')
    expect(key(['198.51.100.7, ::1'], [], '10.0.0.1', lanOnly)).toBe('::1')
    expect(key(['198.51.100.7, 127.0.0.1'])).toBe('198.51.100.7')
    // Missing, blank, empty, and malformed chains fail closed.
    expect(key([])).toBe('10.0.0.1')
    expect(key([], ['203.0.113.9'])).toBe('10.0.0.1')
    for (const xff of [[''], [' , '], ['203.0.113.9,,10.0.0.2'], ['', '203.0.113.9'], ['203.0.113.9', ' '], ['203.0.113.9, evil'], ['x'.repeat(15_000)]]) expect(key(xff), JSON.stringify(xff)).toBe('10.0.0.1')
    // Every X-Real-IP field must name the resolved client.
    expect(key(['203.0.113.9'], ['203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['203.0.113.9'], ['203.0.113.9', '203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['203.0.113.9'], ['203.0.113.9, 203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['203.0.113.9'], ['192.0.2.99'])).toBe('10.0.0.1')
    expect(key(['203.0.113.9'], ['203.0.113.9', '192.0.2.99'])).toBe('10.0.0.1')
    expect(key(['203.0.113.9'], ['203.0.113.9', ''])).toBe('10.0.0.1')
    expect(key(['203.0.113.9'], [''])).toBe('10.0.0.1')
    expect(key(['203.0.113.9'], ['nope'])).toBe('10.0.0.1')
    // Equivalent spellings agree and share one key.
    expect(key(['::ffff:203.0.113.9'], ['203.0.113.9'])).toBe('203.0.113.9')
    expect(key(['203.0.113.9'], ['::FFFF:cb00:7109'])).toBe('203.0.113.9')
    expect(key(['2001:0DB8:0:0::1'], ['2001:db8::0:1'])).toBe('2001:db8::1')
    expect(key(['2001:db8::1'])).toBe(key(['2001:0db8:0000::0001']))
    // A scoped hop names no client, so it never mints a fresh budget.
    expect(key(['fe80::1%syntheticmarker'])).toBe('10.0.0.1')
  })

  it('recognises loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true)
    for (const a of ['10.0.0.1', '192.168.1.1', '100.64.0.1', 'garbage']) expect(isLoopback(a), a).toBe(false)
  })

  it('tells loopback-only proxy lists from ones that trust another host', () => {
    for (const cidrs of [undefined, '', '127.0.0.1/32', '127.0.0.0/8; ::1', '::ffff:127.0.0.1', 'bogus/99']) {
      expect(trustsProxyBeyondLoopback({ HERMES_WEBUI_TRUSTED_PROXY_CIDRS: cidrs }), String(cidrs)).toBe(false)
    }
    for (const cidrs of ['172.17.0.1', '127.0.0.1, 10.0.0.0/8', '0.0.0.0/0', '::/0', '2001:db8::/32', '127.0.0.0/7']) {
      expect(trustsProxyBeyondLoopback({ HERMES_WEBUI_TRUSTED_PROXY_CIDRS: cidrs }), cidrs).toBe(true)
    }
  })
})

describe('CSP', () => {
  it('builds the Python policy with no inline scripts or CDNs and the report-only twin', () => {
    const policy = buildCspEnforcedPolicy({ connect: '', frame: '' })
    const script = policy.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(script).not.toContain("'unsafe-inline'")
    expect(policy).not.toContain('cdn.jsdelivr.net')
    expect(policy).toContain("manifest-src 'self' https://*.cloudflareaccess.com")
    expect(policy).toContain("connect-src 'self' http://127.0.0.1:* http://localhost:* http://ipc.localhost https://127.0.0.1:* https://localhost:* ws://127.0.0.1:* ws://localhost:* blob:; ")
    expect(policy).toContain("frame-src 'self'; ")
    expect(buildCspReportOnlyPolicy({ connect: '', frame: '' })).toBe(policy + '; report-uri /api/csp-report; report-to csp-endpoint')
  })

  it('accepts valid extra connect and frame sources and rejects injection, paths, ws frames, and bad ports', () => {
    const warnings: string[] = []
    const warn = (l: string) => warnings.push(l)
    expect(cspExtras({ HERMES_WEBUI_CSP_CONNECT_EXTRA: 'https://api.example:8443 wss://*.relay.example' }, warn).connect).toBe(' https://api.example:8443 wss://*.relay.example')
    expect(cspExtras({ HERMES_WEBUI_CSP_FRAME_EXTRA: 'https://dash.example' }, warn).frame).toBe(' https://dash.example')
    expect(cspExtras({ HERMES_WEBUI_CSP_CONNECT_EXTRA: "https://x.example; script-src 'unsafe-inline'" }, warn).connect).toBe('')
    expect(cspExtras({ HERMES_WEBUI_CSP_CONNECT_EXTRA: 'https://x.example/path' }, warn).connect).toBe('')
    expect(cspExtras({ HERMES_WEBUI_CSP_CONNECT_EXTRA: 'https://x.example:70000' }, warn).connect).toBe('')
    expect(cspExtras({ HERMES_WEBUI_CSP_FRAME_EXTRA: 'wss://x.example' }, warn).frame).toBe('')
    expect(warnings).toHaveLength(4)
  })
})
