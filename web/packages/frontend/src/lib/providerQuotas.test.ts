import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderQuotasSchema } from '../contracts'
import { reconcileProviderQuotas } from './providerQuotas'

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/catalog-recovery.json'), 'utf8')) as { quotas: unknown }
const cached = ProviderQuotasSchema.parse(fixture.quotas)

describe('quota cache authority', () => {
  it('retains last-confirmed values without marking them fresh during a cold server recovery', () => {
    const unavailable = { ...cached, sources: [], availability: { ...cached.availability!, status: 'unavailable' as const } }
    const result = reconcileProviderQuotas(cached, unavailable)
    expect(result.sources.map((s) => s.source_id)).toEqual(cached.sources.map((s) => s.source_id))
    expect(result.sources[0]?.status).toBe('unavailable')
    expect(result.sources[0]?.windows).toEqual(cached.sources[0]?.windows)
    expect(result.sources[0]?.urgency).toEqual({ remaining: 'unavailable', pace: 'unavailable' })
    expect(reconcileProviderQuotas(undefined, unavailable).sources).toEqual([])
  })

  it('applies confirmed empty lists and isolates profile, server scope and credential generations', () => {
    for (const next of [
      { ...cached, availability: { ...cached.availability!, authoritative: true } },
      { ...cached, scope_id: 'another-server-or-profile' },
      { ...cached, availability: { ...cached.availability!, generation: 'replacement-credential' } },
    ]) expect(reconcileProviderQuotas(cached, { ...next, sources: [] }).sources).toEqual([])
  })
})
