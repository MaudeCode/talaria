import type { Plugin } from 'vite'
import { SKINS, renderThemeCss, type SkinSpec } from './skins'

/** The two facts the boot path reads from a skin, without its token tables (TAL-1700). */
function renderSkinMeta(skins: readonly SkinSpec[] = SKINS): string {
  const traits = Object.fromEntries(skins.map((s) => [s.key, s.traits ?? []]))
  return `export const SKIN_KEYS = ${JSON.stringify(skins.map((s) => s.key))}\nexport const SKIN_TRAITS = ${JSON.stringify(traits)}\n`
}

const MODULES = new Map<string, () => string>([
  ['virtual:hermes-theme.css', () => renderThemeCss()],
  ['virtual:hermes-skin-meta', () => renderSkinMeta()],
])

/** Serves what src/theme/skins.ts renders at build time, so the browser never loads the table to compute it. */
export function hermesTheme(): Plugin {
  return {
    name: 'hermes-theme',
    resolveId: (source) => (MODULES.has(source) ? `\0${source}` : undefined),
    load: (file) => (file.startsWith('\0') ? MODULES.get(file.slice(1))?.() : undefined),
  }
}
