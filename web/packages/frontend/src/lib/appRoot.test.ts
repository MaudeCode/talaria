import { afterEach, describe, expect, it } from 'vitest'
import { appUrl, freezeAppRoot, resetAppRootForTests, routerBasepath } from './appRoot'

function setBase(href: string) {
  document.querySelector('base')?.remove()
  const base = document.createElement('base')
  base.setAttribute('href', href)
  document.head.prepend(base)
}

afterEach(() => {
  resetAppRootForTests()
  document.querySelector('base')?.remove()
})

describe('appRoot', () => {
  it('freezes a root mount from a relative base', () => {
    window.history.replaceState(null, '', '/settings')
    setBase('./')
    const root = freezeAppRoot()
    expect(root.pathname).toBe('/')
    expect(routerBasepath(root)).toBe('/')
    expect(appUrl('/api/sessions').pathname).toBe('/api/sessions')
    expect(document.querySelector('base')?.getAttribute('href')).toBe(root.href)
  })
  it('resolves a nested route back to a subpath mount', () => {
    window.history.replaceState(null, '', '/mount/session/abc')
    setBase('../')
    const root = freezeAppRoot()
    expect(root.pathname).toBe('/mount/')
    expect(routerBasepath(root)).toBe('/mount')
    expect(appUrl('api/chat/start').pathname).toBe('/mount/api/chat/start')
  })
  it('does not drift after a client-side navigation', () => {
    window.history.replaceState(null, '', '/mount/')
    setBase('./')
    const root = freezeAppRoot()
    window.history.pushState(null, '', '/mount/session/xyz')
    expect(appUrl('sw.js').pathname).toBe('/mount/sw.js')
    expect(root.pathname).toBe('/mount/')
  })
})
