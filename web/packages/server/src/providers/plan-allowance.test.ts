import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer } from '../test/harness.js'

const native = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/plan-allowance.json', import.meta.url), 'utf8')) as Record<string, unknown>

async function setup() {
  let current = native
  let clock = 1_800_000_000
  const sidecar = new FakeSidecar()
  sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'nous', default: 'saved-outside-catalog' } } }))
  sidecar.respond('usage.pool_providers', () => ({ providers: [], keys: {} }))
  sidecar.respond('providers.auth_status', () => ({ status: { logged_in: true } }))
  sidecar.respond('plugins.providers', () => ({ providers: [] }))
  sidecar.respond('providers.local_models', () => ({ provider_id: '', models: [], current_endpoint: null }))
  sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: ['large', 'included', 'free'], ...current }))
  const s = await bootTestServer({ sidecar, now: () => clock })
  const home = s.deps.profileHome('default')
  writeFileSync(join(home, 'config.yaml'), '# synthetic plan config\n')
  return { s, home, sidecar, setSnapshot: (next: Record<string, unknown>) => { current = next; clock += 46 } }
}

describe('native plan allowance (TAL-1508)', () => {
  it('projects native model labels, exhaustion and recommendation after inserting the saved model', async () => {
    const { s, home } = await setup()
    try {
      const catalog = await s.deps.catalog.pickerModels(home, 'default')
      const group = catalog.groups.find((g) => g.provider_id === 'nous')!
      expect(group.models.find((m) => m.bare_id === 'large')).toMatchObject({ allowance: { state: 'blocked', usage_level: 'top_tier' } })
      expect(group.models.find((m) => m.bare_id === 'free')).toMatchObject({ allowance: { state: 'free', usage_level: 'free' } })
      expect(group.models.find((m) => m.bare_id === 'saved-outside-catalog')).toMatchObject({ allowance: { state: 'unknown', usage_level: null } })
      expect(group.sections?.map((section) => [section.kind, section.model_ids])).toEqual([
        ['recommended', ['included']], ['other', ['saved-outside-catalog', 'large', 'free']],
      ])
    } finally { await s.close() }
  })
  it.each([[true, 'credits'], [false, 'blocked'], [null, 'unknown']] as const)('uses only native credits_pay=%s for exhausted allowance', async (credits, state) => {
    const t = await setup()
    t.setSnapshot({ ...native, plan_usage: { ...(native.plan_usage as object), credits_pay: credits, keep_going_on_credits: true } })
    try {
      const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
      expect(g.models.find((m) => m.bare_id === 'included')?.allowance?.state).toBe(state)
      expect(g.models.find((m) => m.bare_id === 'free')?.allowance?.state).toBe('free')
    } finally { await t.s.close() }
  })

  it('shows included room and restricts the Large allowance to native Large models', async () => {
    const t = await setup()
    t.setSnapshot({ ...native, plan_usage: { ...(native.plan_usage as object), gauges: [
      { label: 'week', title: 'Weekly', scope: 'all', left_fraction: 0.7, style: 'green', resets_at_ms: null },
      { label: 'large', title: 'Large', scope: 'top_tier', left_fraction: 0, style: 'red', resets_at_ms: null },
    ] } })
    try {
      const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
      expect(g.models.find((m) => m.bare_id === 'included')?.allowance).toMatchObject({ state: 'included' })
      expect(g.models.find((m) => m.bare_id === 'large')?.allowance).toMatchObject({ state: 'blocked', resets_at_ms: null })
      expect(g.models.find((m) => m.bare_id === 'saved-outside-catalog')?.allowance).toMatchObject({ state: 'unknown' })
    } finally { await t.s.close() }
  })

  it('retains native labels and recommendations through repeated pending/error reads, then clears on capability omission', async () => {
    const t = await setup()
    try {
      await t.s.deps.catalog.models(t.home)
      for (const metadata_status of ['pending', 'pending', 'error']) {
        t.setSnapshot({ metadata_status, model_ids: [], allowance_pending: true, plan_usage: null, usage_levels: {} })
        const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
        expect(g.plan_stale).toBe(true)
        expect(g.models.find((m) => m.bare_id === 'large')?.allowance).toMatchObject({ usage_level: 'top_tier', state: 'unknown' })
        expect(g.sections?.[0]).toEqual({ kind: 'recommended', model_ids: ['included'] })
      }
      t.setSnapshot({ metadata_status: 'unsupported' })
      const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
      expect(g.plan_usage).toBeUndefined()
      expect(g.models.every((m) => !m.allowance)).toBe(true)
    } finally { await t.s.close() }
  })

  it('discards allowance metadata after account identity changes, including pending reads', async () => {
    const t = await setup()
    try {
      await t.s.deps.catalog.models(t.home)
      writeFileSync(join(t.home, 'auth.json'), '{"synthetic_account":"second"}')
      t.setSnapshot({ metadata_status: 'pending', plan_usage: null, usage_levels: {} })
      const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
      expect(g.plan_usage).toBeNull()
      expect(g.models.every((m) => m.allowance?.usage_level === null)).toBe(true)
      expect(g.sections).toBeUndefined()
    } finally { await t.s.close() }
  })

  it('shares its native snapshot with the quota source without a second usage fetch', async () => {
    const t = await setup()
    t.sidecar.respond('usage.pool', () => ({ entries: [] }))
    try {
      await t.s.deps.catalog.models(t.home)
      const reads = t.sidecar.calls.filter((c) => c.method === 'providers.model_ids' && (c.params as { provider: string }).provider === 'nous').length
      const quotas = await t.s.deps.catalog.quotas(t.home, 'default') as { sources: { provider_id: string; plan_usage: unknown; windows: { used_percent: number; remaining_percent: number }[] }[] }
      const own = quotas.sources.find((q) => q.provider_id === 'nous')!
      expect(own.plan_usage).toEqual(native.plan_usage)
      expect(own.windows[0]).toMatchObject({ used_percent: 100, remaining_percent: 0 })
      expect(t.sidecar.calls.filter((c) => c.method === 'providers.model_ids' && (c.params as { provider: string }).provider === 'nous')).toHaveLength(reads)
      expect(t.sidecar.calls.some((c) => c.method === 'usage.account' && (c.params as { provider: string }).provider === 'nous')).toBe(false)
    } finally { await t.s.close() }
  })

  it('marks a passed reset stale and accepts an unknown plan name without inventing credits coverage', async () => {
    const t = await setup()
    t.setSnapshot({ ...native, plan_usage: { ...(native.plan_usage as object), plan: null, credits_pay: true, gauges: [
      { label: 'day', title: 'Today', scope: 'all', left_fraction: 0, style: 'red', resets_at_ms: 1 },
    ] } })
    try {
      const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
      expect(g.plan_stale).toBe(true)
      expect(g.models.find((m) => m.bare_id === 'included')?.allowance?.state).toBe('unknown')
      expect(await t.s.deps.catalog.quota(t.home, 'nous')).toMatchObject({ status: 'stale', account_limits: { title: 'Plan allowance', plan_stale: true } })
    } finally { await t.s.close() }
  })

  it('keeps plain labels for a confirmed non-window account after leaving a plan', async () => {
    const t = await setup()
    try {
      await t.s.deps.catalog.models(t.home)
      t.setSnapshot({ metadata_status: 'current', plan_usage: null, usage_levels: {}, unavailable_model_ids: [], free_tier: false })
      const g = (await t.s.deps.catalog.models(t.home)).groups.find((g) => g.provider_id === 'nous')!
      expect(g.plan_usage).toBeNull()
      expect(g.sections).toBeUndefined()
      expect(g.models.every((m) => m.allowance === undefined)).toBe(true)
    } finally { await t.s.close() }
  })

  it('marks retained plan quotas stale when account membership cannot be refreshed', async () => {
    const t = await setup()
    t.sidecar.respond('usage.pool', () => ({ entries: [] }))
    try {
      await t.s.deps.catalog.quotas(t.home, 'default')
      t.sidecar.respond('usage.pool_providers', () => { throw new Error('synthetic unavailable membership') })
      t.setSnapshot(native)
      const quotas = await t.s.deps.catalog.quotas(t.home, 'default') as { sources: { provider_id: string; status: string; plan_stale?: boolean }[] }
      expect(quotas.sources.find((source) => source.provider_id === 'nous')).toMatchObject({ status: 'stale', plan_stale: true })
    } finally { await t.s.close() }
  })

})
