import { describe, expect, it } from 'vitest'
import { externalLinkOpensDirectly, normalizeTrustedLinkHost, normalizeTrustedLinkHosts, TRUSTED_LINK_HOSTS_MAX } from './links.js'

describe('normalizeTrustedLinkHost (TAL-279)', () => {
  it('keeps bare hostnames in browser-normalized form', () => {
    expect(normalizeTrustedLinkHost(' Docs.Example.COM ')).toBe('docs.example.com')
    expect(normalizeTrustedLinkHost('bücher.de')).toBe('xn--bcher-kva.de')
    expect(normalizeTrustedLinkHost('[::1]')).toBe('[::1]')
    expect(normalizeTrustedLinkHost('127.1')).toBe('127.0.0.1')
  })

  it('rejects ports, schemes, paths, userinfo, wildcards, and malformed entries', () => {
    for (const entry of ['example.com:443', 'example.com:', 'https://example.com', 'example.com/x', 'example.com?q', 'u@example.com', '*.example.com', 'exa mple.com', 'exa%41.com', '[::1', 'a..b:1', '', '   ', 42, null]) {
      expect(normalizeTrustedLinkHost(entry), String(entry)).toBeNull()
    }
  })

  it('deduplicates after normalization and caps the list', () => {
    expect(normalizeTrustedLinkHosts(['Example.com', 'example.com', 'bad host', 'other.test'])).toEqual(['example.com', 'other.test'])
    expect(normalizeTrustedLinkHosts('example.com')).toEqual([])
    expect(normalizeTrustedLinkHosts(Array.from({ length: 150 }, (_, i) => `h${i}.test`))).toHaveLength(TRUSTED_LINK_HOSTS_MAX)
  })
})

describe('externalLinkOpensDirectly (TAL-279)', () => {
  const trusted = { confirm: true, trustedHosts: ['example.com'] }

  it('matches the exact hostname only, ignoring case and port', () => {
    expect(externalLinkOpensDirectly('https://EXAMPLE.com:8443/a?b#c', trusted)).toBe(true)
    expect(externalLinkOpensDirectly('http://example.com', trusted)).toBe(true)
    expect(externalLinkOpensDirectly('https://docs.example.com/', trusted)).toBe(false)
    expect(externalLinkOpensDirectly('https://example.com.evil.test/', trusted)).toBe(false)
    expect(externalLinkOpensDirectly('https://evilexample.com/', trusted)).toBe(false)
  })

  it('never skips the prompt for non-HTTP(S), relative, or malformed links, even with confirmation off', () => {
    for (const prefs of [trusted, { confirm: false, trustedHosts: [] }]) {
      for (const href of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@example.com', 'ftp://example.com/', '/relative', 'https://', 'not a url']) {
        expect(externalLinkOpensDirectly(href, prefs), href).toBe(false)
      }
    }
  })

  it('opens any external HTTP(S) link directly when confirmation is off', () => {
    expect(externalLinkOpensDirectly('https://anything.test/', { confirm: false, trustedHosts: [] })).toBe(true)
    expect(externalLinkOpensDirectly('https://anything.test/', { confirm: true, trustedHosts: [] })).toBe(false)
  })
})
