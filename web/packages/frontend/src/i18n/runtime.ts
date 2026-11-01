/**
 * Paraglide runtime glue. Locale precedence (legacy HWEB-65 order, TAL-1031): the saved
 * server `language` setting delivered by /api/bootstrap, then the persisted `hermes-lang`
 * choice, then the server-negotiated `browser_language`, then English. No locale path segments.
 *
 * Paraglide's `globalVariable` strategy holds the active locale in memory; this
 * module owns persistence and the <html lang>/dir attributes.
 */
import { getLocale as paraglideGetLocale, setLocale as paraglideSetLocale, isLocale, baseLocale } from '../paraglide/runtime.js'
import { LOCALE_CODES, localeInfo, resolveLocale } from '@maudecode/talaria-web-contracts'
import { readPersisted, writePersisted } from '../lib/persisted'
import { loadLocaleMessages } from 'virtual:talaria-locales'
import { cacheLocaleChunk } from '../app/pwa'

const listeners = new Set<() => void>()
let requested = 0

export function currentLocale(): string {
  return paraglideGetLocale()
}

/**
 * Apply a resolved locale: its strings (TAL-1403), Paraglide state, `hermes-lang`, `<html lang>`, `dir`.
 * The locale switches only once its strings are installed, so no message renders in English first;
 * a newer request supersedes one still loading.
 */
export async function applyLocale(code: string, opts: { persist?: boolean } = {}): Promise<string> {
  const resolved = resolveLocale(code) ?? baseLocale
  if (!isLocale(resolved)) return currentLocale()
  const request = ++requested
  try {
    const chunk = await loadLocaleMessages(resolved)
    if (chunk) cacheLocaleChunk(chunk)
  } catch (error) {
    // Messages fall back to English; the next switch retries the chunk.
    console.warn('[i18n] locale strings failed to load', error)
  }
  if (request !== requested) return currentLocale()
  // globalVariable strategy: in-memory switch, no page reload.
  void paraglideSetLocale(resolved, { reload: false })
  const info = localeInfo(resolved)
  document.documentElement.lang = info.speech
  if (opts.persist !== false) writePersisted('hermes-lang', resolved)
  for (const l of listeners) l()
  return resolved
}

/**
 * Boot resolution: saved server language (authoritative), persisted device choice, negotiated browser
 * language, then English. Only a saved server language is persisted; the browser fallback never becomes a choice.
 */
export function bootLocale(serverLanguage: string | null | undefined, browserLanguage: string | null | undefined): Promise<string> {
  const fromServer = resolveLocale(serverLanguage)
  const fromStorage = resolveLocale(readPersisted('hermes-lang'))
  return applyLocale(fromServer ?? fromStorage ?? resolveLocale(browserLanguage) ?? baseLocale, { persist: fromServer !== null })
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const SUPPORTED_LOCALES = LOCALE_CODES
