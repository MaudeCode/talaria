import { describe, expect, it } from 'vitest'
import { allowedPublicOrigins, checkSameOriginBrowserRequest, forwardedClientIp, isLoopback, normalizeHostPort, portsMatch, rawPeerIsTrustedProxy } from './origin.js'
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

  it('recognises loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a), a).toBe(true)
    for (const a of ['10.0.0.1', '192.168.1.1', '100.64.0.1', 'garbage']) expect(isLoopback(a), a).toBe(false)
  })
})

describe('CSP', () => {
  it('builds the Python policy with no inline scripts or CDNs and the report-only twin', () => {
    const policy = buildCspEnforcedPolicy({ connect: '', frame: '' })
    const script = policy.split(';').find((d) => d.trim().startsWith('script-src'))!
    expect(script).not.toContain("'unsafe-inline'")
    expect(policy).not.toContain('cdn.jsdelivr.net')
    expect(policy).toContain("manifest-src 'self' https://*.cloudflareaccess.com")
    expect(policy).toContain("connect-src 'self' http://127.0.0.1:* http://localhost:* http://ipc.localhost https://127.0.0.1:* https://localhost:* ws://127.0.0.1:* ws://localhost:*; ")
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
