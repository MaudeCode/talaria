import { describe, expect, it } from 'vitest'
import { sidecarProxyPath } from './ExtensionRoute'

describe('sidecarProxyPath', () => {
  it('keeps ordinary paths and queries, encoding each segment', () => {
    expect(sidecarProxyPath('/api/items?x=1')).toBe('api/items?x=1')
    expect(sidecarProxyPath('a b/c')).toBe('a%20b/c')
    expect(sidecarProxyPath('')).toBe('')
  })

  it('refuses anything that could resolve outside the extension proxy', () => {
    for (const bad of ['../../../session/delete', 'a/../../b', './x', 'a%2e%2e/b', 'a%2Fb', 'x#frag', 'a/%2E%2E/b']) {
      expect(() => sidecarProxyPath(bad), bad).toThrow()
    }
  })
})
