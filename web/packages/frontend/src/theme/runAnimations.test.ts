import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const keyframes = readFileSync(join(__dirname, 'keyframes.css'), 'utf8')
const components = ['chat', 'tools'].map((name) => readFileSync(join(__dirname, 'components', `${name}.css`), 'utf8')).join('\n')

describe('long-running status animations (TAL-1393)', () => {
  for (const name of ['reasoning-title-glow', 'skeletonSheen', 'laurel-leaf', 'wlpulse']) {
    it(`${name} never animates box-shadow`, () => {
      const body = keyframes.split(`@keyframes ${name}{`)[1]?.split('@keyframes')[0]
      expect(body).toBeDefined()
      expect(body).not.toContain('box-shadow')
    })
  }

  for (const name of ['reasoning-title-glow', 'skeletonSheen', 'laurel-leaf']) {
    it(`${name} uses stepped timing at every animation site`, () => {
      const declarations = [...components.matchAll(new RegExp(`animation:${name}[^;}]*`, 'g'))].map((match) => match[0])
      expect(declarations.length).toBeGreaterThan(0)
      for (const declaration of declarations) expect(declaration).toContain('steps(')
    })
  }

  it('puts the running-dot pulse on its own pseudo-element', () => {
    expect(components).toMatch(/\.tool-card-running-dot::after\{[^}]*animation:wlpulse/)
    expect(components).not.toMatch(/\.tool-card-running-dot\{[^}]*animation:wlpulse/)
    expect(components).toMatch(/prefers-reduced-motion: reduce\)\{\.tool-card-running-dot::after\{animation:none/)
  })
})
