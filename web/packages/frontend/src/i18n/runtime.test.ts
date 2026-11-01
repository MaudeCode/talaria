/** TAL-1031: boot precedence is the saved server language, the device choice, the server-negotiated browser language, then English. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootLocale, currentLocale } from './runtime'
import { readPersisted } from '../lib/persisted'

beforeEach(() => { window.localStorage.clear() })
afterEach(async () => {
  await bootLocale('en', undefined)
  window.localStorage.clear()
})

describe('bootLocale', () => {
  it('uses the negotiated browser language on a first visit without persisting it', async () => {
    expect(await bootLocale('', 'fr')).toBe('fr')
    expect(currentLocale()).toBe('fr')
    expect(document.documentElement.lang).toBe('fr-FR')
    expect(readPersisted('hermes-lang')).toBeNull()
  })

  it('a persisted device choice beats the browser language', async () => {
    window.localStorage.setItem('hermes-lang', 'de')
    expect(await bootLocale('', 'fr')).toBe('de')
  })

  it('an explicit server language beats the device choice and the browser language', async () => {
    window.localStorage.setItem('hermes-lang', 'de')
    expect(await bootLocale('ja', 'fr')).toBe('ja')
    expect(readPersisted('hermes-lang')).toBe('ja')
  })

  it('an older payload without browser_language, or a hostile value, stays English', async () => {
    expect(await bootLocale('', undefined)).toBe('en')
    expect(await bootLocale('', '"><img src=x>')).toBe('en')
    expect(document.documentElement.lang).toBe('en-US')
  })
})
