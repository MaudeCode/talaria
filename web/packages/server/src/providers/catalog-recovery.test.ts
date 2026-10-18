import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer } from '../test/harness.js'
import { ProviderCatalog } from './catalog.js'

async function setup(cold = false) {
  let hold = cold
  let empty = false
  let fallback = false
  let clock = 1_800_000_000
  const sidecar = new FakeSidecar()
  const guard = () => { if (hold) throw new SidecarError('Agent update recovery is incomplete.', { condition: 'agent_runtime_stale', data: { agent_update_state: 'incomplete' } }) }
  sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'openai-codex', default: 'gpt-6.1-sol' } } }))
  sidecar.respond('providers.auth_status', (p) => { guard(); return { status: { logged_in: !empty && p.provider === 'openai-codex' } } })
  sidecar.respond('plugins.providers', () => { guard(); return { providers: [] } })
  sidecar.respond('providers.local_models', () => { guard(); return { provider_id: 'llamacpp', models: [], current_endpoint: null } })
  sidecar.respond('providers.model_ids', (p) => { guard(); return { provider: p.provider, model_ids: empty ? [] : fallback ? ['gpt-5.5'] : ['gpt-6.1-sol', 'gpt-6-sol'], fallback } })
  sidecar.respond('usage.pool_providers', () => { guard(); return { providers: empty ? [] : ['openai-codex'] } })
  sidecar.respond('usage.pool', () => { guard(); return { entries: empty ? [] : [{ credential_id: 'synthetic-account', label: 'Test account', status: 'available', unavailable_reason: null, retry_after: null, matches_api_key: false }] } })
  sidecar.respond('usage.account', () => { guard(); return { snapshot: { provider: 'openai-codex', available: true, fetched_at: '2027-01-15T08:00:00Z', windows: [{ label: '5h', remaining_percent: 75, used_percent: 25 }], details: [] } } })
  const s = await bootTestServer({ sidecar, now: () => clock })
  const home = s.deps.profileHome('default')
  writeFileSync(join(home, 'config.yaml'), '# synthetic config\n')
  const get = async (path: string) => { const r = await s.get(path); expect(r.status).toBe(200); return r.json() as Promise<{ availability: { authoritative: boolean; generation: string }; missing_source: boolean; scope_id: string; models: unknown[]; default_model: string; sources: { source_id: string; windows: unknown }[]; groups: { availability: { authoritative: boolean }; models: unknown[] }[] }> }
  return { s, home, sidecar, get, hold: (value: boolean) => { hold = value; clock += 100_000 }, empty: () => { empty = true; clock += 100_000 }, fallback: () => { fallback = true; clock += 100_000 } }
}

describe('catalog recovery authority (TAL-1110)', () => {
  it('marks cold HTTP catalogs unavailable without fabricating accounts or changing the configured model', async () => {
    const t = await setup(true)
    try {
      const quotas = await t.get('/api/provider/quotas?source=qsrc_unknown&refresh=true')
      expect(quotas.availability).toMatchObject({ authoritative: false, status: 'unavailable' })
      expect(quotas.sources).toEqual([])
      expect(quotas.missing_source).toBe(false)
      const models = await t.get('/api/models')
      expect(models.availability).toMatchObject({ authoritative: false, status: 'unavailable' })
      expect(models.default_model).toBe('gpt-6.1-sol')
      expect((await t.get('/api/models/live')).availability.authoritative).toBe(false)
      expect(models.groups[0]!.availability.authoritative).toBe(false)
      expect(t.s.deps.catalog.sessionModelRepair(t.home, 'gpt-6.1-sol', 'openai-codex')).toBeNull()
      t.hold(false)
      expect((await t.get('/api/provider/quotas')).sources).toHaveLength(1)
      expect((await t.get('/api/models')).availability.authoritative).toBe(true)
    } finally { await t.s.close() }
  })

  it('keeps scoped last-confirmed identities and values stale, then reconciles confirmed removal', async () => {
    const t = await setup()
    try {
      writeFileSync(join(t.home, 'auth.json'), '{"synthetic_generation":1}')
      utimesSync(join(t.home, 'auth.json'), 1_700_000_000, 1_700_000_000)
      const initial = await t.get('/api/provider/quotas')
      const models = await t.get('/api/models')
      expect(initial.sources).toHaveLength(1)
      const id = initial.sources[0]!.source_id
      t.hold(true)
      for (const query of ['', `?source=${id}&refresh=true`]) {
        const stale = await t.get(`/api/provider/quotas${query}`)
        expect(stale.availability).toMatchObject({ authoritative: false, status: 'stale' })
        expect(stale.sources.map((s: { source_id: string }) => s.source_id)).toEqual([id])
        expect(stale.sources[0]).toMatchObject({ status: 'stale', windows: initial.sources[0]!.windows })
        expect(stale.missing_source).toBe(false)
      }
      const staleModels = await t.get('/api/models')
      expect(staleModels.availability.authoritative).toBe(false)
      expect(staleModels.groups[0]!.models).toEqual(models.groups[0]!.models)
      writeFileSync(join(t.home, 'auth.json'), '{"synthetic_generation":2}')
      utimesSync(join(t.home, 'auth.json'), 1_700_000_000, 1_700_000_000)
      const replaced = await t.get('/api/provider/quotas')
      expect(replaced.sources).toEqual([])
      expect(replaced.availability.generation).not.toBe(initial.availability.generation)
      t.hold(false)
      t.empty()
      const confirmed = await t.get(`/api/provider/quotas?source=${id}`)
      expect(confirmed.availability.authoritative).toBe(true)
      expect(confirmed.missing_source).toBe(true)
      expect((await t.get('/api/provider/quotas')).sources).toEqual([])
      const emptyModels = await t.get('/api/models')
      expect(emptyModels.availability.authoritative).toBe(false)
      expect(emptyModels.default_model).toBe('gpt-6.1-sol')
      expect((await t.get('/api/models/live')).availability.authoritative).toBe(true)
    } finally { await t.s.close() }
  })
  it('never borrows another profile or server cache and preserves a refresh hold', async () => {
    const t = await setup()
    const other = await setup(true)
    try {
      const initial = await t.get('/api/provider/quotas')
      await t.get('/api/models')
      t.hold(true)
      t.s.deps.catalog.invalidate(t.home, 'openai-codex', { preserveConfirmed: true })
      const refreshed = await t.get('/api/models')
      expect(refreshed.availability).toMatchObject({ authoritative: false })
      expect(refreshed.groups[0]!.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gpt-6.1-sol' })]))
      const home = join(t.home, 'profiles', 'synthetic-other')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.yaml'), '# other profile')
      const profile = await t.s.deps.catalog.quotas(home, 'synthetic-other')
      expect(profile.sources).toEqual([])
      expect(profile.scope_id).not.toBe(initial.scope_id)
      const cold = await other.get('/api/provider/quotas')
      expect(cold.sources).toEqual([])
      expect(cold.availability.authoritative).toBe(false)
      t.hold(false)
      const recovered = await t.get('/api/provider/quotas?refresh=true')
      expect(recovered.availability.authoritative).toBe(true)
      expect(recovered.sources.map((s) => s.source_id)).toEqual(initial.sources.map((s) => s.source_id))
    } finally { await t.s.close(); await other.s.close() }
  })

  it('never lets repeated Agent fallback answers replace a confirmed model list', async () => {
    const t = await setup()
    try {
      const initial = await t.get('/api/models')
      t.fallback()
      for (let read = 0; read < 2; read += 1) {
        const fallback = await t.get('/api/models')
        expect(fallback.groups[0]!.models).toEqual(initial.groups[0]!.models)
        expect(fallback.availability).toMatchObject({ authoritative: false, status: 'stale' })
      }
    } finally { await t.s.close() }
  })

  it('keeps a configured identity without adding static models to a confirmed empty keyed catalog', async () => {
    const t = await setup()
    try {
      t.empty()
      t.sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'openai-codex', default: 'gpt-6.1-sol', api_key: 'sk-synthetic-keyed-catalog' } } }))
      const catalog = await t.get('/api/models')
      expect(catalog.groups[0]!.models).toEqual([expect.objectContaining({ id: 'gpt-6.1-sol' })])
      expect(catalog.availability.authoritative).toBe(true)
      const live = await t.get('/api/models/live')
      expect(live.availability.authoritative).toBe(true)
    } finally { await t.s.close() }
  })

  it('discards a cached model answer when a failed refresh crosses credential generations', async () => {
    const t = await setup()
    try {
      await t.get('/api/models')
      let reject: ((error: Error) => void) | undefined
      t.sidecar.respond('providers.model_ids', () => new Promise<never>((_resolve, fail) => { reject = fail }))
      const pending = t.s.deps.catalog.liveModelIds(t.home, 'openai-codex', { force: true })
      await vi.waitFor(() => { expect(reject).toBeDefined() })
      writeFileSync(join(t.home, 'auth.json'), '{"synthetic_generation":2}')
      reject!(new Error('Synthetic lookup failure'))
      expect(await pending).toEqual([])
    } finally { await t.s.close() }
  })

  it('retries a live HTTP catalog when its original lookup crosses source generations', async () => {
    const t = await setup()
    try {
      let finish: ((value: { provider: string; model_ids: string[] }) => void) | undefined
      t.sidecar.respond('providers.model_ids', () => new Promise((resolve) => { finish = resolve }))
      const pending = t.get('/api/models/live')
      await vi.waitFor(() => { expect(finish).toBeDefined() })
      writeFileSync(join(t.home, 'auth.json'), '{"synthetic_generation":2}')
      t.sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: ['gpt-6.1-sol'] }))
      finish!({ provider: 'openai-codex', model_ids: ['gpt-5.5'] })
      const live = await pending
      expect(live.models).toEqual([expect.objectContaining({ id: 'gpt-6.1-sol' })])
      expect(live.availability.authoritative).toBe(true)
    } finally { await t.s.close() }
  })

  it('keeps newer targeted quota values when an older full refresh finishes later', async () => {
    const t = await setup()
    try {
      t.sidecar.respond('usage.pool', () => ({ entries: ['one', 'two'].map((id) => ({ credential_id: id, label: id, status: 'available' as const, unavailable_reason: null, retry_after: null, matches_api_key: false })) }))
      const initial = await t.get('/api/provider/quotas')
      const id = initial.sources[0]!.source_id
      let finishPool: (() => void) | undefined
      let blockPool = true
      t.sidecar.respond('usage.pool', () => {
        const result = { entries: ['one', 'two'].map((id) => ({ credential_id: id, label: id, status: 'available' as const, unavailable_reason: null, retry_after: null, matches_api_key: false })) }
        if (!blockPool) return result
        blockPool = false
        return new Promise((resolve) => { finishPool = () => { resolve(result) } })
      })
      let remaining = 55
      t.sidecar.respond('usage.account', () => ({ snapshot: { provider: 'openai-codex', available: true, windows: [{ label: '5h', remaining_percent: remaining }], details: [] } }))
      const full = t.get('/api/provider/quotas?refresh=true')
      await vi.waitFor(() => { expect(finishPool).toBeDefined() })
      const target = await t.get(`/api/provider/quotas?source=${id}&refresh=true`)
      expect(target.sources[0]).toMatchObject({ windows: [expect.objectContaining({ remaining_percent: 55 })] })
      remaining = 75
      finishPool!()
      const fullResponse = await full
      expect(fullResponse.sources.find((s) => s.source_id === id)).toMatchObject({ windows: [expect.objectContaining({ remaining_percent: 55 })] })
      const latest = await t.get('/api/provider/quotas')
      expect(latest.sources.find((s) => s.source_id === id)).toMatchObject({ windows: [expect.objectContaining({ remaining_percent: 55 })] })
      t.hold(true)
      const retained = await t.get('/api/provider/quotas')
      expect(retained.sources).toHaveLength(2)
      expect(retained.sources.find((s) => s.source_id === id)).toMatchObject({ status: 'stale', windows: [expect.objectContaining({ remaining_percent: 55 })] })
    } finally { await t.s.close() }
  })

  it('changes source generation for replacement provider or custom environment credentials, not launch-only variables', async () => {
    const t = await setup()
    try {
      t.sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'openai-codex', default: 'gpt-6.1-sol' }, custom_providers: [{ name: 'Synthetic', key_env: 'CUSTOM_MODEL_ACCESS', model: 'synthetic-model' }] } }))
      expect((await t.get('/api/provider/quotas')).availability).toMatchObject({ authoritative: true })
      const first = await t.get('/api/models')
      t.hold(true)
      const restarted = (extra: Record<string, string>) => new ProviderCatalog({ sidecar: () => t.sidecar, config: t.s.deps.agentConfig, env: extra, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
      expect((await restarted({ PATH: '/synthetic/restarted/bin' }).models(t.home)).availability?.generation).toBe(first.availability?.generation)
      for (const extra of [{ OPENAI_API_KEY: 'sk-synthetic-replacement' }, { CUSTOM_MODEL_ACCESS: 'synthetic-custom-replacement' }]) {
        const replacement = await restarted(extra).models(t.home)
        expect(replacement.availability?.generation).not.toBe(first.availability?.generation)
        expect(replacement.availability?.authoritative).toBe(false)
      }
    } finally { await t.s.close() }
  })
})
