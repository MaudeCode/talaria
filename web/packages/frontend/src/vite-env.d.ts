/// <reference types="vite/client" />

/** Token stylesheet rendered from src/theme/skins.ts (src/theme/themePlugin.ts). */
declare module 'virtual:hermes-theme.css'

/** Skin keys and traits rendered from src/theme/skins.ts, without the token tables (src/theme/themePlugin.ts, TAL-1700). */
declare module 'virtual:hermes-skin-meta' {
  import type { SkinKey, SkinTrait } from '~/theme/skins'
  export const SKIN_KEYS: readonly [SkinKey, ...SkinKey[]]
  export const SKIN_TRAITS: Readonly<Record<string, readonly SkinTrait[]>>
}

/** Per-locale message chunks (src/i18n/localeSplit.ts, TAL-1403). */
declare module 'virtual:talaria-locales' {
  /** Installs a locale's strings on the Paraglide runtime; resolves to its chunk URL, or undefined for the base locale. */
  export function loadLocaleMessages(locale: string): Promise<string | undefined>
}
