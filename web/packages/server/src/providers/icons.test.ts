import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { providerIcon } from './icons.js'

const repo = resolve(import.meta.dirname, '../../../../..')
const registry = readFileSync(resolve(repo, 'app/Talaria/Models/ProviderIconRegistry.swift'), 'utf8')
/** The body of one Swift collection literal, `private static let <name>: <type> = [ … ]`. */
const literal = (name: string) => { const declaration = registry.slice(registry.indexOf(`static let ${name}:`)); return declaration.slice(declaration.indexOf('= [')).split(']')[0] ?? '' }
const strip = (asset: string) => asset.replace(/^ProviderIcon/, '')

describe('provider icons (TAL-1858)', () => {
  it('give every App registry provider id its asset and colour style, served as a byte-identical SVG', () => {
    const assets = new Map([...literal('assets').matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(([, id, asset]) => [id!, strip(asset!)]))
    const colour = new Set([...literal('colorAssets').matchAll(/"([^"]+)"/g)].map(([, asset]) => strip(asset!)))
    expect(assets.size).toBeGreaterThan(50)
    for (const [id, asset] of assets) expect(providerIcon(id, 'Provider'), id).toEqual({ asset, initials: 'P', color: colour.has(asset) })
    const served = resolve(repo, 'web/static/brand/providers')
    expect(readdirSync(served).sort()).toEqual([...new Set(assets.values())].map((asset) => `${asset}.svg`).sort())
    for (const asset of new Set(assets.values())) {
      expect(readFileSync(resolve(served, `${asset}.svg`)), asset).toEqual(readFileSync(resolve(repo, `app/Talaria/Resources/ProviderIcons.xcassets/ProviderIcon${asset}.imageset/icon.svg`)))
    }
  })

  it('matches a provider id in any case and spacing, and gives an unknown or custom provider only its initials', () => {
    expect(providerIcon(' OpenAI-Codex ', 'OpenAI Codex')).toEqual({ asset: 'Codex', initials: 'OC', color: true })
    expect(providerIcon('custom:localhost:8080', 'Local Server')).toEqual({ asset: null, initials: 'LS', color: false })
    expect(providerIcon('acme-cloud', 'Acme Cloud')).toEqual({ asset: null, initials: 'AC', color: false })
    expect(providerIcon('', '—').initials).toBe('?')
  })
})
