import { describe, expect, it } from 'vitest'
import { applyAppearance, resolveAppearance } from './boot'

describe('resolveAppearance', () => {
  it('defaults to dark with the default skin', () => {
    expect(resolveAppearance(null, null, false)).toEqual({ theme: 'dark', skin: 'default', effectiveDark: true })
  })
  it('honours light and system themes', () => {
    expect(resolveAppearance('light', null, true).effectiveDark).toBe(false)
    expect(resolveAppearance('system', null, true)).toMatchObject({ theme: 'system', effectiveDark: true })
    expect(resolveAppearance('system', null, false).effectiveDark).toBe(false)
  })
  it('maps legacy theme aliases to a theme plus skin', () => {
    expect(resolveAppearance('solarized', null, false)).toEqual({ theme: 'dark', skin: 'poseidon', effectiveDark: true })
    expect(resolveAppearance('nord', null, false).skin).toBe('slate')
    expect(resolveAppearance('OLED', null, false)).toMatchObject({ theme: 'dark', skin: 'default' })
  })
  it('keeps an explicit known skin over a legacy alias skin', () => {
    expect(resolveAppearance('monokai', 'ares', false).skin).toBe('ares')
  })
  it('rejects unknown skins and themes', () => {
    expect(resolveAppearance('purple', 'not-a-skin', false)).toEqual({ theme: 'dark', skin: 'default', effectiveDark: true })
  })
})

describe('applyAppearance', () => {
  it('sets the dark class, skin dataset and theme-color meta', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('media', '(prefers-color-scheme: dark)')
    document.head.appendChild(meta)
    const root = document.documentElement
    applyAppearance({ theme: 'dark', skin: 'ares', effectiveDark: true }, root)
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.dataset.skin).toBe('ares')
    expect(meta.getAttribute('content')).toBe('#141425')
    expect(meta.hasAttribute('media')).toBe(false)
    applyAppearance({ theme: 'light', skin: 'default', effectiveDark: false }, root)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.dataset.skin).toBeUndefined()
    expect(meta.getAttribute('content')).toBe('#FAF7F0')
    meta.remove()
  })
})
