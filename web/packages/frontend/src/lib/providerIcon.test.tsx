import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProviderIcon } from './providerIcon'

const repo = resolve(import.meta.dirname, '../../../../..')
const registry = readFileSync(resolve(repo, 'app/Talaria/Models/ProviderIconRegistry.swift'), 'utf8')
/** The body of one Swift collection literal, `private static let <name>: <type> = [ … ]`. */
const literal = (name: string) => { const declaration = registry.slice(registry.indexOf(`static let ${name}:`)); return declaration.slice(declaration.indexOf('= [')).split(']')[0] ?? '' }
const strip = (asset: string) => asset.replace(/^ProviderIcon/, '')
const icon = (providerId: string | undefined, label = 'Provider') => render(<ProviderIcon providerId={providerId} label={label} />).container.firstElementChild!

describe('ProviderIcon (TAL-1858)', () => {
  it('draws the App registry\'s icon for every provider id, in its colour style, from a byte-identical SVG', () => {
    const assets = new Map([...literal('assets').matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(([, id, asset]) => [id!, strip(asset!)]))
    const colour = new Set([...literal('colorAssets').matchAll(/"([^"]+)"/g)].map(([, asset]) => strip(asset!)))
    expect(assets.size).toBeGreaterThan(50)
    for (const [id, asset] of assets) {
      const el = icon(id)
      expect(el.getAttribute('data-provider-icon'), id).toBe(asset)
      // The App's default `color` style: colour icons keep their colours; the rest take the text colour through a mask.
      expect(el.tagName, id).toBe(colour.has(asset) ? 'IMG' : 'SPAN')
    }
    const served = resolve(repo, 'web/static/brand/providers')
    expect(readdirSync(served).sort()).toEqual([...new Set(assets.values())].map((asset) => `${asset}.svg`).sort())
    for (const asset of new Set(assets.values())) {
      expect(readFileSync(resolve(served, `${asset}.svg`)), asset).toEqual(readFileSync(resolve(repo, `app/Talaria/Resources/ProviderIcons.xcassets/ProviderIcon${asset}.imageset/icon.svg`)))
    }
  })

  it('matches a provider id in any case and spacing, and draws initials for a custom endpoint', () => {
    expect(icon(' OpenAI-Codex ').getAttribute('data-provider-icon')).toBe('Codex')
    const custom = icon('custom:localhost:8080', 'Local Server')
    expect(custom).toHaveAttribute('data-provider-icon', 'initials')
    expect(custom).toHaveTextContent(/^LS$/)
    expect(icon(undefined, '—')).toHaveTextContent(/^\?$/)
  })
})
