import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SKINS, SKIN_TRAITS, TOKEN_NAMES, renderThemeCss, type SkinSpec } from './skins'

const skins: readonly SkinSpec[] = SKINS

const names = new Set<string>(TOKEN_NAMES)

describe('theme system', () => {
  it('defines every token in the base light set', () => {
    for (const n of TOKEN_NAMES) expect(BASE.tokens[n], n).toBeTypeOf('string')
  })

  it('skins only set known tokens and known traits', () => {
    for (const s of skins) {
      for (const k of [...Object.keys(s.tokens), ...Object.keys(s.dark)]) expect(names.has(k), `${s.key} sets ${k}`).toBe(true)
      for (const t of s.traits ?? []) expect(SKIN_TRAITS).toContain(t)
      expect(s.colors.length, `${s.key} swatch`).toBeGreaterThan(0)
    }
    expect(new Set(SKINS.map((s) => s.key)).size).toBe(SKINS.length)
  })

  it('renders one block per skin and scheme in cascade order', () => {
    const css = renderThemeCss()
    expect(css.startsWith(':root{')).toBe(true)
    expect(css.indexOf(':root.dark{')).toBeGreaterThan(0)
    for (const s of skins) {
      if (s.key === 'default') { expect(css).toContain(':root:not([data-skin]),:root[data-skin="default"]{'); continue }
      if (Object.keys(s.tokens).length) expect(css).toContain(`:root[data-skin="${s.key}"]{`)
      if (Object.keys(s.dark).length) expect(css).toContain(`:root.dark[data-skin="${s.key}"]{`)
    }
  })

  it('component sheets carry no colour of their own', () => {
    // Palette and semantic colours live in skins.ts. Black/white alpha shadows and overlays are ink, not palette.
    const dir = join(__dirname, 'components')
    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.css')) continue
      const css = readFileSync(join(dir, f), 'utf8')
      for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) {
        const lit = m[0]
        if (/^rgba?\(\s*(0|255)\s*,\s*(0|255)\s*,\s*(0|255)/.test(lit)) continue
        offenders.push(`${f}: ${lit}`)
      }
      expect(css, `${f} must not scope rules to a skin or theme`).not.toMatch(/data-skin=|:root\.dark|:not\(\.dark\)/)
    }
    expect(offenders).toEqual([])
  })
})
