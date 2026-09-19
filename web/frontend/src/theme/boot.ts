/**
 * Apply persisted appearance before first paint. Ported from the legacy inline
 * <head> scripts: theme axis (light/dark/system plus legacy aliases), skin axis,
 * font size, full-width chat, RTL, sidebar collapse, workspace panel state.
 * Runs synchronously from the module entry. The first paint happens before the
 * module arrives, so theme/prepaint.js (a blocking head script) sets the theme
 * and skin ahead of it; this pass validates and completes the rest.
 */
import { readPersisted, writePersisted } from '../lib/persisted'
import { ThemeSchema, SkinSchema, FontSizeSchema, type Theme, type Skin } from '../contracts/persisted'
import { skinByKey } from './skins'
const LEGACY_THEME_ALIASES: Record<string, [Theme, Skin]> = {
  slate: ['dark', 'slate'],
  solarized: ['dark', 'poseidon'],
  monokai: ['dark', 'sisyphus'],
  nord: ['dark', 'slate'],
  oled: ['dark', 'default'],
}
export const THEME_COLOR = { light: '#FAF7F0', dark: '#141425' } as const

export interface ResolvedAppearance {
  theme: Theme
  skin: Skin
  effectiveDark: boolean
}

export function resolveAppearance(rawTheme: string | null, rawSkin: string | null, prefersDark: boolean): ResolvedAppearance {
  const t = (rawTheme ?? 'dark').toLowerCase()
  const s = (rawSkin ?? '').toLowerCase()
  const alias = LEGACY_THEME_ALIASES[t]
  const theme: Theme = alias ? alias[0] : ThemeSchema.safeParse(t).success ? (t as Theme) : 'dark'
  let skin: Skin
  if (SkinSchema.safeParse(s).success) skin = s as Skin
  else if (alias) skin = alias[1]
  else skin = 'default'
  const effectiveDark = theme === 'system' ? prefersDark : theme === 'dark'
  return { theme, skin, effectiveDark }
}

export function applyAppearance(a: ResolvedAppearance, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('dark', a.effectiveDark)
  if (a.skin !== 'default') root.dataset.skin = a.skin
  else delete root.dataset.skin
  const traits = skinByKey(a.skin)?.traits
  if (traits?.length) root.dataset.skinTraits = traits.join(' ')
  else delete root.dataset.skinTraits
  root.style.colorScheme = a.effectiveDark ? 'dark' : 'light'
  const color = a.effectiveDark ? THEME_COLOR.dark : THEME_COLOR.light
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.setAttribute('content', color)
    meta.removeAttribute('media')
  }
}

export function applyBootAppearance(): void {
  const root = document.documentElement
  const rawTheme = readPersisted('hermes-theme')
  const rawSkin = readPersisted('hermes-skin')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const resolved = resolveAppearance(rawTheme, rawSkin, prefersDark)
  if (rawTheme !== null || rawSkin !== null) {
    // Normalise legacy aliases in storage, as the legacy boot did.
    writePersisted('hermes-theme', resolved.theme)
    writePersisted('hermes-skin', resolved.skin)
  }
  applyAppearance(resolved, root)

  const fontSize = FontSizeSchema.safeParse(readPersisted('hermes-font-size'))
  if (fontSize.success && fontSize.data !== 'default') root.dataset.fontSize = fontSize.data
  if (readPersisted('hermes-full-width-chat') === 'true') root.dataset.chatWidth = 'full'
  if (readPersisted('hermes-rtl') === 'true') root.dir = 'rtl'
  root.dataset.workspacePanel = readPersisted('hermes-webui-workspace-panel') === 'open' ? 'open' : 'closed'
  if (readPersisted('hermes-webui-sidebar-collapsed') === '1') root.dataset.sidebarCollapsed = '1'
  if (!('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) root.classList.add('no-speech')
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches
  root.classList.toggle('pwa-standalone', standalone)
  root.classList.toggle('pwa-browser', !standalone)

  if (resolved.theme === 'system') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', () => {
      const current = ThemeSchema.safeParse(readPersisted('hermes-theme'))
      if (current.success && current.data === 'system') applyAppearance(resolveAppearance('system', readPersisted('hermes-skin'), mql.matches), root)
    })
  }
}
