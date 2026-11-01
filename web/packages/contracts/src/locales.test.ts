import { describe, expect, it } from 'vitest'
import { LOCALE_INFO, negotiateLocale, resolveLocale } from './locales.js'

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
    expect(resolveLocale('zh-Hant-CN')).toBe('zh-Hant')
    expect(resolveLocale('zh-Hans-TW')).toBe('zh')
    expect(resolveLocale('ZH-hk')).toBe('zh-Hant')
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

describe('negotiateLocale', () => {
  it('picks the highest-quality supported tag through the shared catalog', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9,en;q=0.1')).toBe('fr')
    expect(negotiateLocale('en;q=0.5, ja;q=0.8, de;q=0.7')).toBe('ja')
    expect(negotiateLocale('DE-at')).toBe('de')
    expect(negotiateLocale('zh-TW,zh;q=0.8')).toBe('zh-Hant')
    expect(negotiateLocale('zh-Hans-HK')).toBe('zh')
  })
  it('keeps header order between equal qualities', () => {
    expect(negotiateLocale('it;q=0.5, es;q=0.5')).toBe('it')
    expect(negotiateLocale('ko, pl')).toBe('ko')
  })
  it('skips q=0, wildcards, unsupported and malformed entries', () => {
    expect(negotiateLocale('ja;q=0, de;q=0.2')).toBe('de')
    expect(negotiateLocale('ja;q=0.000')).toBe('en')
    expect(negotiateLocale('*, xx-YY, tlh;q=0.9, pt;q=0.1')).toBe('pt')
    expect(negotiateLocale('ru;q=2, cs;q=abc, tr;q=0.3')).toBe('tr')
    expect(negotiateLocale(';;;,,,')).toBe('en')
  })
  it('falls back to English for a missing, unsupported or hostile header', () => {
    expect(negotiateLocale(undefined)).toBe('en')
    expect(negotiateLocale('')).toBe('en')
    expect(negotiateLocale('xx')).toBe('en')
    expect(negotiateLocale('"><script>alert(1)</script>')).toBe('en')
    expect(negotiateLocale('fr\u0000;q=1')).toBe('en')
  })
  it('only ever returns a catalog code', () => {
    const codes = new Set(LOCALE_INFO.map((l) => l.code))
    for (const header of ['fr-CA', 'zh-Hant', 'vi-VN;q=0.4', 'en-GB', 'nope', 'a'.repeat(5000)]) expect(codes.has(negotiateLocale(header))).toBe(true)
  })
  it('ignores entries past the cap so an oversized header cannot dominate', () => {
    expect(negotiateLocale(`${Array.from({ length: 40 }, () => 'xx').join(',')},fr`)).toBe('en')
  })
})
