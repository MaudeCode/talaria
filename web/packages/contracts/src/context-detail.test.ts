import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ContextDetailSchema, unavailableContextDetail } from './context-detail.js'

describe('safe context detail contract', () => {
  it('parses the shared App/Web fixture', () => {
    const fixtures = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/context-detail.json', import.meta.url), 'utf8')) as Record<string, unknown>
    for (const value of Object.values(fixtures)) expect(ContextDetailSchema.parse(value)).toBeTruthy()
  })
  it('preserves explicit unknown/pre-build fields', () => {
    const unavailable = unavailableContextDetail('not_built')
    expect(ContextDetailSchema.parse(unavailable)).toEqual(unavailable)
    expect(unavailable.used_tokens).toBeNull()
  })
  it('rejects private/arbitrary file labels, unbounded lists and non-finite counters', () => {
    const file = { label: 'AGENTS.md', characters: 1, tokens: 1, status: 'loaded', loaded: true }
    for (const override of [{ files: [{ ...file, label: '/private/operator/AGENTS.md' }] }, { files: Array(65).fill(file) }, { used_tokens: Infinity }, { window_tokens: -1 }]) {
      expect(ContextDetailSchema.safeParse({ ...unavailableContextDetail(), ...override }).success).toBe(false)
    }
  })
})
