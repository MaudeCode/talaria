/**
 * The supported Web locale catalog, shared by the server's Accept-Language negotiation (TAL-1031) and the
 * frontend's locale runtime. Each `label` is the locale's own name (an endonym), identical in every UI language.
 * Metadata carried over from the legacy catalogue (`_lang`, `_label`, `_speech`).
 */
export interface LocaleInfo {
  code: string
  label: string
  /** BCP 47 tag used for speech recognition and `<html lang>`. */
  speech: string
  dir: 'ltr' | 'rtl'
}

const EN: LocaleInfo = { code: 'en', label: 'English', speech: 'en-US', dir: 'ltr' }

export const LOCALE_INFO: readonly LocaleInfo[] = [
  EN,
  { code: 'it', label: 'Italiano', speech: 'it-IT', dir: 'ltr' },
  { code: 'ja', label: '日本語', speech: 'ja-JP', dir: 'ltr' },
  { code: 'ru', label: 'Русский', speech: 'ru-RU', dir: 'ltr' },
  { code: 'es', label: 'Español', speech: 'es-ES', dir: 'ltr' },
  { code: 'de', label: 'Deutsch', speech: 'de-DE', dir: 'ltr' },
  { code: 'zh', label: '简体中文', speech: 'zh-CN', dir: 'ltr' },
  { code: 'zh-Hant', label: '繁體中文', speech: 'zh-TW', dir: 'ltr' },
  { code: 'pt', label: 'Português', speech: 'pt-BR', dir: 'ltr' },
  { code: 'ko', label: '한국어', speech: 'ko-KR', dir: 'ltr' },
  { code: 'fr', label: 'Français', speech: 'fr-FR', dir: 'ltr' },
  { code: 'cs', label: 'Čeština', speech: 'cs-CZ', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe', speech: 'tr-TR', dir: 'ltr' },
  { code: 'pl', label: 'Polski', speech: 'pl-PL', dir: 'ltr' },
  { code: 'vi', label: 'Tiếng Việt', speech: 'vi-VN', dir: 'ltr' },
]

export const LOCALE_CODES = LOCALE_INFO.map((l) => l.code)

/**
 * Resolve a requested language tag to a supported locale code, mirroring the
 * legacy `resolveLocale()`: exact match, then case-insensitive, then the
 * primary subtag (`de-AT` -> `de`, `zh-TW` -> `zh-Hant`, `zh-Hans-TW` -> `zh`, `zh-*` -> `zh`).
 */
export function resolveLocale(lang: string | null | undefined): string | null {
  if (!lang) return null
  const raw = lang.trim()
  if (!raw || !/^[A-Za-z][A-Za-z0-9-]{0,14}$/.test(raw)) return null
  const exact = LOCALE_INFO.find((l) => l.code === raw)
  if (exact) return exact.code
  const lower = raw.toLowerCase()
  const ci = LOCALE_INFO.find((l) => l.code.toLowerCase() === lower)
  if (ci) return ci.code
  const primary = lower.split('-')[0] ?? lower
  if (primary === 'zh') {
    // An explicit script wins over the region (`zh-Hans-TW` is Simplified); otherwise TW/HK/MO read Traditional.
    const subtags = lower.split('-').slice(1)
    if (subtags.includes('hant')) return 'zh-Hant'
    if (subtags.includes('hans')) return 'zh'
    return subtags.some((r) => r === 'tw' || r === 'hk' || r === 'mo') ? 'zh-Hant' : 'zh'
  }
  const base = LOCALE_INFO.find((l) => l.code === primary)
  return base ? base.code : null
}

export function localeInfo(code: string): LocaleInfo {
  return LOCALE_INFO.find((l) => l.code === code) ?? EN
}

/** At most this many Accept-Language entries are considered; the rest of an oversized header is ignored. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32
const QUALITY_RE = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i

/**
 * The supported locale an `Accept-Language` header prefers most (RFC 9110 §12.5.4), or `en`. Entries are
 * ordered by quality, ties keeping header order; `q=0`, `*`, malformed and unsupported tags are skipped. Each tag
 * goes through `resolveLocale`, so only a catalog code is ever returned.
 */
export function negotiateLocale(header: string | null | undefined): string {
  const ranked: { code: string; q: number; index: number }[] = []
  const entries = (header ?? '').split(',').slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)
  entries.forEach((entry, index) => {
    const [tag = '', ...params] = entry.split(';').map((part) => part.trim())
    let q = 1
    for (const param of params) {
      const match = QUALITY_RE.exec(param)
      if (!match) { if (/^q=/i.test(param)) q = -1; continue }
      q = Number(match[1])
    }
    const code = q > 0 ? resolveLocale(tag) : null
    if (code) ranked.push({ code, q, index })
  })
  ranked.sort((a, b) => b.q - a.q || a.index - b.index)
  return ranked[0]?.code ?? EN.code
}
