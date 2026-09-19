/**
 * Paraglide runtime glue. Locale precedence (legacy HWEB-65 order): the server
 * `language` setting delivered by /api/bootstrap, then the persisted
 * `hermes-lang` choice, then English. No locale path segments.
 *
 * Paraglide's `globalVariable` strategy holds the active locale in memory; this
 * module owns persistence and the <html lang>/dir attributes.
 */
import { getLocale as paraglideGetLocale, setLocale as paraglideSetLocale, isLocale, baseLocale } from '../paraglide/runtime.js'
import { LOCALE_CODES, localeInfo, resolveLocale } from './locales'
import { readPersisted, writePersisted } from '../lib/persisted'

const listeners = new Set<() => void>()
let version = 0

export function currentLocale(): string {
  return paraglideGetLocale()
}

export function localeVersion(): number {
  return version
}

/** Apply a resolved locale: Paraglide state, `hermes-lang`, `<html lang>`, `dir`. */
export function applyLocale(code: string, opts: { persist?: boolean } = {}): string {
  const resolved = resolveLocale(code) ?? baseLocale
  if (!isLocale(resolved)) return currentLocale()
  // globalVariable strategy: in-memory switch, no page reload.
  void paraglideSetLocale(resolved, { reload: false })
  const info = localeInfo(resolved)
  document.documentElement.lang = info.speech
  if (opts.persist !== false) writePersisted('hermes-lang', resolved)
  version += 1
  for (const l of listeners) l()
  return resolved
}

/** Boot resolution: server language (authoritative) then persisted choice then English. */
export function bootLocale(serverLanguage: string | null | undefined): string {
  const fromServer = resolveLocale(serverLanguage)
  const fromStorage = resolveLocale(readPersisted('hermes-lang'))
  return applyLocale(fromServer ?? fromStorage ?? baseLocale, { persist: fromServer !== null })
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const SUPPORTED_LOCALES = LOCALE_CODES
