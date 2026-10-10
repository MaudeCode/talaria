/**
 * Appearance actions: theme, skin, font size, chat width, RTL, language.
 * Each applies immediately, persists the legacy localStorage key, and (where
 * the legacy app did) mirrors to server settings through the caller.
 */
import { readPersisted, writePersisted } from '../lib/persisted'
import { FontSizeSchema, type ChatWidth, type FontSize, type Skin, type Theme } from '../contracts/persisted'
import { applyAppearance, readChatWidth, resolveAppearance } from '../theme/boot'
import { applyLocale } from '../i18n/runtime'
import { useSyncExternalStore } from 'react'
import { applyExtensionSkin, extensionSkin } from '../extensions/registry'

const listeners = new Set<() => void>()
let version = 0
const bump = () => { version += 1; for (const l of listeners) l() }

export interface AppearanceState { theme: Theme; skin: Skin; fontSize: FontSize; chatWidth: ChatWidth; rtl: boolean }

export function readAppearance(): AppearanceState {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const rawSkin = readPersisted('hermes-skin')
  const ext = rawSkin ? extensionSkin(rawSkin.toLowerCase()) : undefined
  const r = resolveAppearance(readPersisted('hermes-theme'), ext ? 'default' : rawSkin, prefersDark)
  if (ext) return { theme: r.theme, skin: ext.key as Skin, fontSize: fontSizeOf(), chatWidth: readChatWidth(), rtl: readPersisted('hermes-rtl') === 'true' }
  return { theme: r.theme, skin: r.skin, fontSize: fontSizeOf(), chatWidth: readChatWidth(), rtl: readPersisted('hermes-rtl') === 'true' }
}

function fontSizeOf(): FontSize {
  const fs = FontSizeSchema.safeParse(readPersisted('hermes-font-size'))
  return fs.success ? fs.data : 'default'
}

export function setTheme(theme: Theme): void {
  writePersisted('hermes-theme', theme)
  applyAppearance(resolveAppearance(theme, readPersisted('hermes-skin'), window.matchMedia('(prefers-color-scheme: dark)').matches))
  bump()
}
export function setSkin(skin: string): void {
  const ext = extensionSkin(skin)
  writePersisted('hermes-skin', skin)
  if (ext) {
    applyAppearance(resolveAppearance(readPersisted('hermes-theme'), 'default', window.matchMedia('(prefers-color-scheme: dark)').matches))
    applyExtensionSkin(ext)
    document.documentElement.dataset.skin = ext.key
  } else {
    applyExtensionSkin(null)
    applyAppearance(resolveAppearance(readPersisted('hermes-theme'), skin, window.matchMedia('(prefers-color-scheme: dark)').matches))
  }
  bump()
}

/**
 * Re-apply a persisted extension skin once manifests are known (boot order: manifests load after first paint); when the
 * applied extension skin is gone (disabled or uninstalled), clear its tokens and fall back to the built-in skin.
 */
export function reapplyExtensionSkin(): void {
  const key = (readPersisted('hermes-skin') ?? '').toLowerCase()
  const ext = extensionSkin(key)
  if (ext) { applyExtensionSkin(ext); document.documentElement.dataset.skin = ext.key; bump() }
  else if (document.documentElement.dataset.extSkin) {
    applyExtensionSkin(null)
    applyAppearance(resolveAppearance(readPersisted('hermes-theme'), key, window.matchMedia('(prefers-color-scheme: dark)').matches))
    bump()
  }
}
export function setFontSize(size: FontSize): void {
  writePersisted('hermes-font-size', size)
  if (size === 'default') delete document.documentElement.dataset.fontSize
  else document.documentElement.dataset.fontSize = size
  bump()
}
export function setChatWidth(width: ChatWidth): void {
  writePersisted('hermes-chat-width', width)
  // Stable still reads the legacy boolean (TAL-343); drop it once Stable reads hermes-chat-width.
  writePersisted('hermes-full-width-chat', width === 'full' ? 'true' : 'false')
  if (width === 'comfortable') delete document.documentElement.dataset.chatWidth
  else document.documentElement.dataset.chatWidth = width
  bump()
}
export function setRtl(on: boolean): void {
  writePersisted('hermes-rtl', on ? 'true' : 'false')
  document.documentElement.dir = on ? 'rtl' : 'ltr'
  bump()
}
export function setLanguage(code: string): void {
  applyLocale(code)
  bump()
}

export function useAppearance(): AppearanceState {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => version, () => version)
  return readAppearance()
}
