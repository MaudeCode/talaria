import { describe, expect, it } from 'vitest'
import { LOCALE_INFO, resolveLocale } from './locales'

describe('resolveLocale', () => {
  it('matches exact, case-insensitive and primary subtags', () => {
    expect(resolveLocale('de')).toBe('de')
    expect(resolveLocale('DE')).toBe('de')
    expect(resolveLocale('de-AT')).toBe('de')
    expect(resolveLocale('pt-PT')).toBe('pt')
  })
  it('routes Chinese variants like the legacy runtime', () => {
    expect(resolveLocale('zh-TW')).toBe('zh-Hant')
    expect(resolveLocale('zh-HK')).toBe('zh-Hant')
    expect(resolveLocale('zh-Hant')).toBe('zh-Hant')
    expect(resolveLocale('zh-CN')).toBe('zh')
    expect(resolveLocale('zh')).toBe('zh')
  })
  it('rejects unsupported or malformed tags', () => {
    expect(resolveLocale('xx')).toBeNull()
    expect(resolveLocale('')).toBeNull()
    expect(resolveLocale('en;drop')).toBeNull()
    expect(resolveLocale(null)).toBeNull()
  })
  it('exposes every legacy locale with a speech tag', () => {
    expect(LOCALE_INFO.map((l) => l.code)).toEqual(['en', 'it', 'ja', 'ru', 'es', 'de', 'zh', 'zh-Hant', 'pt', 'ko', 'fr', 'cs', 'tr', 'pl', 'vi'])
    for (const l of LOCALE_INFO) expect(l.speech).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
  })
})
