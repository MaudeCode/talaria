import { describe, expect, it } from 'vitest'
import { checkExternalLink, linkPreferences, normalizeTrustedLinkHost, normalizeTrustedLinkHosts, TRUSTED_LINK_HOSTS_MAX } from './links.js'

describe('normalizeTrustedLinkHost (TAL-279)', () => {
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

describe('checkExternalLink (TAL-279)', () => {
  const trusted = { confirm: true, trustedHosts: ['example.com'] }

  it('matches the exact hostname only, ignoring case and port', () => {
    expect(checkExternalLink('https://EXAMPLE.com:8443/a?b#c', trusted).opens_directly).toBe(true)
    expect(checkExternalLink('http://example.com', trusted).opens_directly).toBe(true)
    expect(checkExternalLink('https://docs.example.com/', trusted).opens_directly).toBe(false)
    expect(checkExternalLink('https://example.com.evil.test/', trusted).opens_directly).toBe(false)
    expect(checkExternalLink('https://evilexample.com/', trusted).opens_directly).toBe(false)
  })

  it('never skips the prompt for non-HTTP(S), relative, or malformed links, even with confirmation off', () => {
    for (const prefs of [trusted, { confirm: false, trustedHosts: [] }]) {
      for (const href of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@example.com', 'ftp://example.com/', '/relative', 'https://', 'not a url']) {
        expect(checkExternalLink(href, prefs).opens_directly, href).toBe(false)
      }
    }
  })

  it('names the destination host the dialog shows, or null when there is none', () => {
    expect(checkExternalLink('https://Docs.Example.com:8443/x', trusted)).toEqual({ opens_directly: false, host: 'docs.example.com' })
    expect(checkExternalLink('https://example.com/', trusted)).toEqual({ opens_directly: true, host: 'example.com' })
    expect(checkExternalLink('mailto:a@example.com', trusted)).toEqual({ opens_directly: false, host: null })
    expect(checkExternalLink('not a url', trusted)).toEqual({ opens_directly: false, host: null })
  })

  it('reads saved settings fail-closed', () => {
    expect(linkPreferences({})).toEqual({ confirm: true, trustedHosts: [] })
    expect(linkPreferences({ confirm_external_links: 'no', trusted_link_hosts: ['A.test', 'bad host'] })).toEqual({ confirm: true, trustedHosts: ['a.test'] })
    expect(linkPreferences({ confirm_external_links: false })).toEqual({ confirm: false, trustedHosts: [] })
  })

})
