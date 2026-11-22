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
  it('keeps an unknown prompt-cache window free of ends and a known one free of unknown causes (TAL-2647)', () => {
    const warm = { state: 'warm', confidence: 'proven', reason: null, tier: '1h', guaranteed_until: 1763820000, estimated_until: 1763820000, remaining_seconds: 2460, coverage: [{ tier: '1h', until: 1763820000 }] }
    const unknown = { state: 'unknown', confidence: 'unknown', reason: 'compacted', tier: null, guaranteed_until: null, estimated_until: null, remaining_seconds: null, coverage: [] }
    for (const prompt_cache of [
      { ...unknown, estimated_until: 1763820000 }, { ...unknown, remaining_seconds: 60 }, { ...unknown, coverage: warm.coverage }, { ...unknown, reason: 'secret /private/path' }, { ...unknown, confidence: 'proven' },
      { ...warm, reason: 'compacted' }, { ...warm, confidence: 'unknown' }, { ...warm, coverage: Array(5).fill(warm.coverage[0]) }, { ...warm, tier: '7d' }, { ...warm, guaranteed_until: Infinity }, { ...warm, remaining_seconds: -1 },
    ]) expect(ContextDetailSchema.safeParse({ ...unavailableContextDetail(), prompt_cache }).success, JSON.stringify(prompt_cache)).toBe(false)
    for (const prompt_cache of [warm, unknown]) expect(ContextDetailSchema.safeParse({ ...unavailableContextDetail(), prompt_cache }).success).toBe(true)
  })
})
