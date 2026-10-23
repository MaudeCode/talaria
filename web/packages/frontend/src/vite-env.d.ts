/// <reference types="vite/client" />

/** Token stylesheet rendered from src/theme/skins.ts (vite.config.ts, hermesTheme plugin). */
declare module 'virtual:hermes-theme.css'

/** Per-locale message chunks (src/i18n/localeSplit.ts, TAL-1403). */
declare module 'virtual:talaria-locales' {
  /** Installs a locale's strings on the Paraglide runtime; resolves to its chunk URL, or undefined for the base locale. */
  export function loadLocaleMessages(locale: string): Promise<string | undefined>
}
