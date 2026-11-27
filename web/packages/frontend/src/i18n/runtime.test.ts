/** TAL-1031: boot precedence is the saved server language, the device choice, the server-negotiated browser language, then English. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLocaleMessages } from 'virtual:talaria-locales'
import { cacheLocaleChunk } from '../app/pwa'
import { applyLocale, bootLocale, currentLocale } from './runtime'
import { readPersisted } from '../lib/persisted'

vi.mock('virtual:talaria-locales', { spy: true })
vi.mock('../app/pwa', { spy: true })

beforeEach(() => { window.localStorage.clear() })
afterEach(async () => {
  await bootLocale('en', undefined)
  window.localStorage.clear()
})

it('only asks the worker to cache the winning locale when loads finish out of order', async () => {
  const slower = Promise.withResolvers<string>()
  const faster = Promise.withResolvers<string>()
  vi.mocked(loadLocaleMessages).mockReturnValueOnce(slower.promise).mockReturnValueOnce(faster.promise)
  vi.mocked(cacheLocaleChunk).mockClear()

  const earlier = applyLocale('de')
  const later = applyLocale('ja')
  faster.resolve('/assets/locale-ja.js')
  await later
  slower.resolve('/assets/locale-de.js')
  await earlier

  expect(currentLocale()).toBe('ja')
  expect(vi.mocked(cacheLocaleChunk).mock.calls).toEqual([['/assets/locale-ja.js']])
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
