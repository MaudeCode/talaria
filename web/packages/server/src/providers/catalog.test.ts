import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConfig, parseProviderQualifiedModel } from '../config/agent-config.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, WEB_ROOT, type TestServer } from '../test/harness.js'
import { ProviderCatalog, repairSessionModel, splitPickerOverflow, type ModelEntry, type ModelGroup, type ModelsCatalog } from './catalog.js'
import { PROVIDER_MODELS } from './tables.js'
import { writeEnvFile } from '../test/env-file.js'
import { SIDECAR_METHODS, type SidecarResult } from '@maudecode/talaria-web-contracts'

type Json = Record<string, unknown>
interface Entry { id: string; provider_id?: string; bare_id?: string }
interface Group { provider_id: string; models: Entry[]; extra_models?: Entry[] }

describe('shared admission catalog discovery (TAL-1196)', () => {
  let home: string
  let sidecar: FakeSidecar
  let catalog: ProviderCatalog
  let clock: number
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'talaria-admission-catalog-'))
    clock = 1_800_000_000
    writeFileSync(join(home, 'config.yaml'), '# synthetic config\n')
    sidecar = new FakeSidecar()
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: {
      model: { provider: 'anthropic', default: 'claude-sonnet-4' },
      providers: { anthropic: { models: ['claude-sonnet-4'] }, ollama: { base_url: 'http://ollama.test/v1', models: ['local-model'] }, deepseek: { api_key: 'sk-synthetic-discovery' } },
    } }))
    sidecar.respond('usage.pool_providers', () => ({ providers: [], keys: {} }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.auth_status', () => ({ status: { logged_in: false } }))
    sidecar.respond('providers.local_models', () => ({ provider_id: 'llamacpp', models: [], current_endpoint: null }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'deepseek' ? ['ds-model'] : [] }))
    catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => clock, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('shares a held build across concurrent repair, complete catalog and picker reads', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('providers.local_models', async () => { await held; return { provider_id: 'llamacpp', models: [], current_endpoint: null } })
    expect(catalog.sessionModelRepair(home, 'ds-model', 'ollama')).toBeNull()
    expect(catalog.sessionModelRepair(home, 'ds-model', 'ollama')).toBeNull()
    const full = catalog.models(home)
    const picker = catalog.pickerModels(home, 'default')
    try {
      await vi.waitFor(() => { expect(sidecar.calls.filter((c) => c.method === 'providers.local_models')).toHaveLength(1) })
      expect(catalog.sessionModelRepair(home, 'ds-model', 'ollama')).toBeNull()
    } finally { release() }
    const [first, second] = await Promise.all([full, picker])
    expect(sidecar.calls.filter((c) => c.method === 'providers.local_models')).toHaveLength(1)
    expect(catalog.sessionModelRepair(home, 'ds-model', 'ollama')).toEqual(['ds-model', 'deepseek'])
    first.groups.length = 0
    second.groups.length = 0
    expect(catalog.sessionModelRepair(home, 'ds-model', 'ollama')).toEqual(['ds-model', 'deepseek'])
  })

  it.each(['profile', 'all'] as const)('retires a pre-refresh build on %s invalidation without discarding confirmed live ids', async (scope) => {
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let first = true
    sidecar.respond('models.speed_tiers', async (params) => {
      if (first) { first = false; entered(); await held }
      return { tiers: params.routes.map(() => []) }
    })
    const old = catalog.models(home)
    await started
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'deepseek' ? ['ds-new'] : [] }))
    catalog.invalidate(scope === 'profile' ? home : undefined, 'deepseek', { preserveConfirmed: true })
    await catalog.liveModelIds(home, 'deepseek', { force: true })
    let result: ModelsCatalog | undefined
    const refreshed = catalog.pickerModels(home, 'default').then((value) => { result = value })
    try {
      await vi.waitFor(() => { expect(result, 'explicit refresh must not join the pre-refresh build').toBeDefined() })
      expect(catalog.modelOptionFor(home, 'ds-new', 'deepseek')).toBe('@deepseek:ds-new')
    } finally { release(); await Promise.all([old, refreshed]) }
    expect(catalog.modelOptionFor(home, 'ds-new', 'deepseek')).toBe('@deepseek:ds-new')
    expect(catalog.modelOptionFor(home, 'ds-model', 'deepseek')).toBeNull()
  })

  it.each(['stale', 'failed', 'unconfirmed'] as const)('keeps the pair for %s evidence until a shared background refresh confirms it', async (state) => {
    await catalog.models(home)
    if (state === 'stale') clock += 31
    else {
      clock += 100_000
      if (state === 'failed') sidecar.respond('usage.pool_providers', () => { throw new Error('synthetic unavailable pool') })
      else sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: ['ds-model'], fallback: true }))
      await catalog.models(home)
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    sidecar.respond('usage.pool_providers', async () => { entered(); await held; return { providers: [], keys: {} } })
    try {
      expect(catalog.sessionModelRepair(home, 'ds-model', state === 'unconfirmed' ? 'deepseek' : 'ollama')).toBeNull()
      await started
    } finally { release() }
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'deepseek' ? ['ds-model'] : [] }))
    clock += 100_000
    await catalog.models(home)
    expect(catalog.sessionModelRepair(home, 'ds-model', 'ollama')).toEqual(['ds-model', 'deepseek'])
  })

  it.each(['usage.pool_providers', 'providers.local_models'] as const)('cannot publish an old generation over a newer catalog or another profile after held %s', async (method) => {
    const other = join(home, 'profiles', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'config.yaml'), '# other profile\n')
    let generation = 'old'
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'deepseek' ? [p.profile_home === other ? 'other-model' : `${generation}-model`] : [] }))
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    sidecar.respond(method, async () => { entered(); await held; return method === 'usage.pool_providers' ? { providers: [], keys: {} } : { provider_id: 'llamacpp', models: [], current_endpoint: null } })
    const old = catalog.models(home)
    await started
    generation = 'new'
    writeFileSync(join(home, 'auth.json'), '{"synthetic_generation":2}')
    sidecar.respond(method, () => method === 'usage.pool_providers' ? { providers: [], keys: {} } : { provider_id: 'llamacpp', models: [], current_endpoint: null })
    try {
      await Promise.all([catalog.models(home), catalog.models(other)])
    } finally { release() }
    expect((await old).availability?.authoritative).toBe(true)
    expect(catalog.sessionModelRepair(home, 'new-model', 'ollama')).toEqual(['new-model', 'deepseek'])
    expect(catalog.sessionModelRepair(home, 'old-model', 'ollama')).toBeNull()
    expect(catalog.sessionModelRepair(home, 'other-model', 'ollama')).toBeNull()
    expect(catalog.sessionModelRepair(other, 'other-model', 'ollama')).toEqual(['other-model', 'deepseek'])
  })
})

describe('bounded picker pool limits (TAL-1222)', () => {
  let home: string
  let sidecar: FakeSidecar
  let catalog: ProviderCatalog
  const resetsAt = '2026-10-21T13:00:00Z'
  const limits = { ollama: { scope: 'account' as const, resets_at: resetsAt } }
  const calls = (): number => sidecar.calls.filter((c) => c.method === 'usage.limits').length
  const picker = (): Promise<ModelsCatalog> => catalog.pickerModels(home, 'synthetic')
  const group = (result: ModelsCatalog): ModelGroup | undefined => result.groups.find((g) => g.provider_id === 'ollama')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
    home = mkdtempSync(join(tmpdir(), 'talaria-picker-limits-'))
    writeFileSync(join(home, 'config.yaml'), '# synthetic configuration\n')
    sidecar = new FakeSidecar()
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'ollama', default: 'llama3.2' }, providers: { ollama: { base_url: 'http://ollama.test/v1', models: ['llama3.2'] } } } }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'ollama' ? ['llama3.2'] : [] }))
    sidecar.respond('usage.limits', () => ({ limits }))
    catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => Date.now() / 1000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(home, { recursive: true, force: true })
  })

  it('settles a non-answering limits read in three seconds and caches the failure for 45 seconds', async () => {
    // The responder never answers; emulate the real client's transport deadline.
    sidecar.respond('usage.limits', (_p, _emit, opts) => new Promise((_resolve, reject) => {
      setTimeout(() => { reject(new Error('sidecar call usage.limits timed out')) }, opts.timeoutMs ?? 120_000)
    }))
    let result: ModelsCatalog | undefined
    const pending = picker().then((value) => { result = value })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result, 'picker must resolve when the three-second limits deadline expires').toBeDefined()
    await pending
    expect(result!.groups.every((g) => g.limit === undefined)).toBe(true)
    await picker()
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(44_999)
    await picker()
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await picker()
    expect(calls()).toBe(2)
  })

  it('shares cold reads and serves cached limits while one expired read refreshes', async () => {
    let resolve!: (value: SidecarResult<'usage.limits'>) => void
    sidecar.respond('usage.limits', () => new Promise((done) => { resolve = done }))
    const first = picker()
    const second = picker()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)
    resolve({ limits })
    expect(group(await first)?.limit).toEqual(limits.ollama)
    expect(group(await second)?.limit).toEqual(limits.ollama)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(group(await picker())?.limit).toEqual(limits.ollama)
    expect(group(await picker())?.limit).toEqual(limits.ollama)
    expect(calls()).toBe(2)
    resolve({ limits: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(group(await picker())?.limit).toBeUndefined()
    expect(calls()).toBe(2)
  })

  it('clears stale limits after a failed refresh and throttles retries', async () => {
    expect(group(await picker())?.limit).toEqual(limits.ollama)
    let reject!: (reason: Error) => void
    sidecar.respond('usage.limits', () => new Promise((_resolve, fail) => { reject = fail }))
    await vi.advanceTimersByTimeAsync(45_000)
    expect(group(await picker())?.limit).toEqual(limits.ollama)
    expect(calls()).toBe(2)
    reject(new Error('limits unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(group(await picker())?.limit).toBeUndefined()
    expect(calls()).toBe(2)
  })

  it('drops expired account and model limits even while the cache is fresh', async () => {
    const reset = new Date(Date.now() + 1_000).toISOString()
    sidecar.respond('usage.limits', () => ({ limits: { ollama: { scope: 'account', resets_at: reset } } }))
    expect(group(await picker())?.limit).toBeDefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(group(await picker())?.limit).toBeUndefined()
    expect(calls()).toBe(1)
    catalog.invalidate(home)
    sidecar.respond('usage.limits', () => ({ limits: { ollama: { scope: 'models', models: { 'llama3.2': new Date(Date.now() + 1_000).toISOString() } } } }))
    expect(group(await picker())?.models[0]?.limit).toBeDefined()
    await vi.advanceTimersByTimeAsync(1_000)
    const expired = group(await picker())
    expect(expired?.limit).toBeUndefined()
    expect(expired?.models[0]?.limit).toBeUndefined()
    expect(calls()).toBe(2)
  })

  it('isolates homes and discards cached and in-flight limits after credentials change', async () => {
    expect(group(await picker())?.limit).toBeDefined()
    const otherHome = mkdtempSync(join(tmpdir(), 'talaria-picker-other-'))
    try {
      sidecar.respond('usage.limits', () => ({ limits: {} }))
      expect(group(await catalog.pickerModels(otherHome, 'other'))?.limit).toBeUndefined()
      expect(calls()).toBe(2)
    } finally { rmSync(otherHome, { recursive: true, force: true }) }
    let resolve!: (value: SidecarResult<'usage.limits'>) => void
    sidecar.respond('usage.limits', () => new Promise((done) => { resolve = done }))
    writeFileSync(join(home, 'auth.json'), '{"account":"new"}')
    const pending = picker()
    await vi.advanceTimersByTimeAsync(0)
    writeFileSync(join(home, 'auth.json'), '{"account":"newer"}')
    resolve({ limits })
    expect(group(await pending)?.limit).toBeUndefined()
    sidecar.respond('usage.limits', () => ({ limits: {} }))
    expect(group(await picker())?.limit).toBeUndefined()
    expect(calls()).toBe(4)
  })
})

describe.each([
  ['openrouter', 'OPENROUTER_API_KEY', []],
  ['deepseek', 'DEEPSEEK_API_KEY', []],
  ['opencode-go', 'OPENCODE_GO_API_KEY', ['OPENCODE_API_KEY']],
] as const)('profile-scoped usage credentials (TAL-932): %s', (provider, envVar, aliases) => {
  it.each(['op://v/i/f', '', 'sk-synthetic-plain'])('routes quota, pool and cost reads with configured key %s', async (key) => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-usage-'))
    try {
      writeFileSync(join(home, 'config.yaml'), '# synthetic configuration\n')
      writeEnvFile(join(home, '.env'), { [envVar]: key, ...Object.fromEntries(aliases.map((name) => [name, key.startsWith('op://') ? 'sk-lower-priority-alias' : null])) })
      const sidecar = new FakeSidecar()
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'anthropic' }, providers: { ollama: { base_url: 'http://ollama.test/v1', models: ['legacy-model'] }, ...(key.startsWith('op://') ? { [provider]: { api_key: 'sk-lower-priority-config' } } : {}) } } }))
      let revision = 'account-a'
      let liveIds = ['account-a-model']
      sidecar.respond('usage.pool_providers', (p) => ({ providers: [], keys: p.key_envs?.[provider] ? { [provider]: { present: true, revision } } : {} }))
      sidecar.respond('usage.pool', (p) => ({ entries: [], has_api_key: p.provider === provider }))
      sidecar.respond('usage.balance', () => ({
        status: 'ok', http_status: null, label: 'Synthetic',
        quota: provider === 'openrouter' ? { usage: 3, limit: 100, limit_remaining: 97 } : null,
        is_available: provider === 'deepseek' ? true : null,
        balances: provider === 'deepseek' ? [{ currency: 'USD', total: 97, granted: null, topped_up: 97 }] : [],
        windows: provider === 'opencode-go' ? [{ key: 'rolling', used_percent: 3, reset_at: '2030-01-01T00:00:00Z', rate_limited: false }] : [],
      }))
      sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === provider ? liveIds : [] }))
      const config = new AgentConfig({ sidecar: () => sidecar, env: {} })
      const catalog = new ProviderCatalog({ sidecar: () => sidecar, config, env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
      expect(await catalog.quota(home, provider)).toMatchObject({ status: 'available' })
      if (provider === 'openrouter') expect(await catalog.costHistory(home, 'openrouter', 30)).toMatchObject({ status: 'available' })
      expect((await catalog.providers(home)).providers.find((p) => p.id === provider)).toMatchObject({ has_key: true, configured: true, is_oauth: false })
      expect((await catalog.models(home)).groups.some((g) => g.provider_id === provider)).toBe(true)
      const quotas = await catalog.quotas(home, 'synthetic')
      expect((quotas.sources as Json[]).find((s) => s.provider_id === provider)).toMatchObject({ status: 'available' })
      const calls = sidecar.calls.filter((c) => (c.method === 'usage.balance' || c.method === 'usage.pool') && (c.params as Json).provider === provider)
      expect(calls.some((c) => c.method === 'usage.pool')).toBe(true)
      const expected = key.startsWith('sk-') ? { api_key: key } : { env_vars: [envVar, ...aliases] }
      for (const call of calls) {
        expect(call.params).toMatchObject(expected)
        expect(JSON.stringify(call.params)).not.toContain('op://')
        if (!key.startsWith('sk-')) expect(call.params).not.toHaveProperty('api_key')
      }
      for (const matches of [true, false]) {
        sidecar.respond('usage.pool', (p) => ({ has_api_key: p.provider === provider, entries: p.provider === provider ? [{ credential_id: 'work', label: 'Work', status: 'available', unavailable_reason: null, retry_after: null, matches_api_key: matches }] : [] }))
        const sources = (await catalog.quotas(home, 'synthetic')).sources as Json[]
        const providerSources = sources.filter((s) => s.provider_id === provider)
        expect(providerSources).toHaveLength(matches ? 1 : 2)
        expect(providerSources.every((s) => s.status === 'available')).toBe(true)
      }
      if (!key.startsWith('sk-')) {
        revision = 'account-b'
        liveIds = ['account-b-model']
        await catalog.warmSessionModelRepair(home)
        expect(catalog.sessionModelRepair(home, 'account-b-model', 'ollama')).toEqual(['account-b-model', provider])
        expect(catalog.sessionModelRepair(home, 'account-a-model', 'ollama')).toBeNull()
        revision = 'account-c'
        liveIds = ['account-c-model']
        await catalog.warmModelOptions(home)
        expect(catalog.modelOptionFor(home, 'account-c-model', provider)).toBe(`@${provider}:account-c-model`)
        revision = 'account-d'
        liveIds = ['account-d-model']
        expect(await catalog.liveModelIds(home, provider)).toEqual(['account-d-model'])
        sidecar.respond('usage.pool_providers', () => { throw new Error('synthetic secret source unavailable') })
        await catalog.warmSessionModelRepair(home)
        expect(catalog.sessionModelRepair(home, 'account-d-model', 'ollama')).toBeNull()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('parseProviderQualifiedModel, the one `@provider:model` splitter', () => {
  it('splits a known provider at its first colon so the model keeps its own colons', () => {
    expect(parseProviderQualifiedModel('@ollama:llama3:8b')).toEqual(['llama3:8b', 'ollama'])
    expect(parseProviderQualifiedModel('@gemini:gemini-2.5-flash')).toEqual(['gemini-2.5-flash', 'gemini'])
  })

  it('keeps a `custom:` host:port as the provider', () => {
    expect(parseProviderQualifiedModel('@custom:localhost:8080:m')).toEqual(['m', 'custom:localhost:8080'])
    expect(parseProviderQualifiedModel('@custom:my-box:llama3:8b')).toEqual(['llama3:8b', 'custom:my-box'])
  })

  it('falls back to the first colon for an unknown provider, and leaves unqualified ids alone', () => {
    expect(parseProviderQualifiedModel('@fake-sub:claude:latest')).toEqual(['claude:latest', 'fake-sub'])
    expect(parseProviderQualifiedModel('llama3:8b')).toBeNull()
    expect(parseProviderQualifiedModel('@cf/meta/llama-3')).toBeNull()
  })
})

describe('stale session model repair (TAL-542)', () => {
  const catalog = (active: string, defaultModel: string, groups: Record<string, string[]>, extra: Record<string, string[]> = {}): ModelsCatalog => {
    const entries = (pid: string, ids: string[]): ModelEntry[] => ids.map((id) => { const [bare, provider] = parseProviderQualifiedModel(id) ?? [id, pid]; return { id, label: id, bare_id: bare, provider_id: provider } })
    return {
      active_provider: active, default_model: defaultModel, default_provider_id: active, default_bare_id: defaultModel, aliases: {}, configured_model_badges: {},
      groups: Object.entries(groups).map(([pid, ids]) => ({ provider: pid, provider_id: pid, models: entries(pid, ids), ...(extra[pid] ? { extra_models: entries(pid, extra[pid]) } : {}) })),
    }
  }
  const kilo = 'kilo/minimax/minimax-m3'

  it('moves a pair to the only other provider listing the model, matching its spelling (#5731)', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [`@kilocode:${kilo}`] }), kilo, 'ollama')).toEqual([kilo, 'kilocode'])
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['GPT.4O.MINI'] }), 'gpt-4o-mini', 'ollama')).toEqual(['GPT.4O.MINI', 'kilocode'])
  })

  it('finds the owner with a vendor prefix on either side and starts on the owner\'s own id', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['openai/gpt-5.4'] }), 'gpt-5.4', 'ollama')).toEqual(['openai/gpt-5.4', 'kilocode'])
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['gpt-5.4'] }), 'openai/gpt-5.4', 'ollama')).toEqual(['gpt-5.4', 'kilocode'])
    // The profile's own provider listing the vendorless id: the session starts on that id rather than the default.
    expect(repairSessionModel(catalog('openai-codex', 'gpt-5.5', { 'openai-codex': ['gpt-5.5', 'gpt-5.4-mini'] }), 'openai/gpt-5.4-mini', 'openai-codex')).toEqual(['gpt-5.4-mini', 'openai-codex'])
  })

  it('starts a bare model on the vendor-prefixed id its own provider advertises', () => {
    expect(repairSessionModel(catalog('openrouter', 'openai/gpt-5.5', { openrouter: ['openai/gpt-5.5', 'openai/gpt-5.4'] }), 'gpt-5.4', 'openrouter')).toEqual(['openai/gpt-5.4', 'openrouter'])
    expect(repairSessionModel(catalog('ollama', 'llama3.2', { ollama: ['lmstudio-community/Qwen2.5-Coder'] }), 'Qwen2.5-Coder', 'ollama')).toBeNull()
  })

  it('never treats a namespace other than a vendor prefix as the same model', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['Qwen2.5-Coder'] }), 'lmstudio-community/Qwen2.5-Coder', 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: ['lmstudio-community/Qwen2.5-Coder'] }), 'Qwen2.5-Coder', 'ollama')).toBeNull()
  })

  it('keeps the pair without one clear owner or when its provider lists it, in models or extra_models', () => {
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [kilo], other: [kilo] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { kilocode: [kilo] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: [kilo], kilocode: [kilo] }), kilo, 'ollama')).toBeNull()
    expect(repairSessionModel(catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [kilo] }, { ollama: [kilo] }), kilo, 'ollama')).toBeNull()
  })

  it('keeps the pair when its provider\'s or the only owner\'s live lookup failed, or it is the profile\'s own provider', () => {
    const c = catalog('kilocode', 'kilo/auto', { ollama: ['llama3.2'], kilocode: [kilo] })
    expect(repairSessionModel(c, kilo, 'ollama', new Set(['ollama']))).toBeNull()
    expect(repairSessionModel(c, kilo, 'ollama', new Set(['kilocode']))).toBeNull()
    expect(repairSessionModel(catalog('ollama', 'llama3.2', { ollama: ['llama3.2'], kilocode: [kilo] }), kilo, 'ollama')).toBeNull()
  })

  it('switches a model naming another vendor to the profile default, and keeps unknown vendors (#1734, #751)', () => {
    const codex = catalog('openai-codex', 'gpt-5.5', { 'openai-codex': ['gpt-5.5'] })
    for (const stale of ['gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview', 'openai/gpt-5.4-mini', 'claude-sonnet-4']) expect(repairSessionModel(codex, stale, null)).toEqual(['gpt-5.5', 'openai-codex'])
    for (const kept of ['gpt-5.4-mini', 'custom-provider/test-model-999', 'lmstudio-community/Qwen2.5-Coder-7B-Instruct-GGUF', 'custom/my-local-llm']) expect(repairSessionModel(codex, kept, null)).toBeNull()
    expect(repairSessionModel(catalog('openrouter', 'openai/gpt-5.4-mini', { openrouter: ['anthropic/claude-sonnet-4'] }), 'google/gemini-3.1-pro-preview', null)).toBeNull()
    expect(repairSessionModel(catalog('anthropic', 'claude-sonnet-4', { anthropic: ['claude-sonnet-4'] }), 'gpt-5.4-mini', 'anthropic')).toEqual(['claude-sonnet-4', 'anthropic'])
    expect(repairSessionModel(catalog('anthropic', '', { anthropic: ['claude-sonnet-4'] }), 'gpt-5.4-mini', null)).toBeNull()
  })

  it('prefers a provider that lists a providerless model over the default', () => {
    expect(repairSessionModel(catalog('openai-codex', 'gpt-5.5', { 'openai-codex': ['gpt-5.5'], gemini: ['gemini-3.1-pro-preview'] }), 'gemini-3.1-pro-preview', null)).toEqual(['gemini-3.1-pro-preview', 'gemini'])
  })
})

describe('live model ids without a sidecar (TAL-542)', () => {
  it('never lets ids fetched under another source confirm a repair while the sidecar is down', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-catalog-'))
    try {
      let sidecar: FakeSidecar | null = new FakeSidecar()
      const config = { model: { provider: 'anthropic', default: 'claude-sonnet-4' }, providers: { ollama: { base_url: 'http://ollama.test/v1', models: ['llama3.2'] }, deepseek: { api_key: 'sk-deepseek-12345' } } }
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
      sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
      sidecar.respond('plugins.providers', () => ({ providers: [] }))
      sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'deepseek' ? ['ds-old'] : [] }))
      writeFileSync(join(home, 'config.yaml'), '# cfg\n')
      const agentConfig = new AgentConfig({ sidecar: () => sidecar, env: {} })
      const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: agentConfig, env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'ds-old', 'ollama')).toEqual(['ds-old', 'deepseek'])
      // The credential changes in .env while the sidecar is down: the cached ids belong to the old one.
      writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=sk-deepseek-67890\n')
      sidecar = null
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'ds-old', 'ollama')).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('curated and fallback model lists (TAL-799)', () => {
  const setup = (config: Json, modelIds: (provider: string) => { model_ids: string[]; fallback?: boolean }) => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-catalog-'))
    let clock = 1_800_000_000
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, ...modelIds(p.provider) }))
    writeFileSync(join(home, 'config.yaml'), '# cfg\n')
    const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => clock, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
    const lookups = (provider: string): number => sidecar.calls.filter((c) => c.method === 'providers.model_ids' && (c.params as Json).provider === provider).length
    return { home, catalog, sidecar, lookups, tick: (s: number) => { clock += s } }
  }

  it('lists the Agent\'s curated ids for a provider without credentials, and never repairs onto them', async () => {
    const { home, catalog } = setup(
      { model: { provider: 'anthropic', default: 'claude-fable-5.1' }, providers: { ollama: { base_url: 'http://ollama.test/v1', models: ['llama3.2'] } } },
      (provider) => (provider === 'anthropic' ? { model_ids: ['claude-fable-5.1', 'claude-opus-5-5'], fallback: true } : { model_ids: [] }),
    )
    try {
      const groups = (await catalog.models(home)).groups
      expect(groups.find((g) => g.provider_id === 'anthropic')?.models.map((m) => m.id)).toEqual(['claude-fable-5.1', 'claude-opus-5-5'])
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'claude-opus-5-5', 'ollama')).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps an Agent fallback list unconfirmed and looks the catalog up again after the short TTL', async () => {
    let fallback = true
    const { home, catalog, lookups, tick } = setup(
      { model: { provider: 'anthropic', default: 'claude-sonnet-4' }, providers: { ollama: { base_url: 'http://ollama.test/v1', models: ['llama3.2'] }, deepseek: { api_key: 'sk-deepseek-12345' } } },
      (provider) => (provider === 'deepseek' ? { model_ids: ['ds-curated'], fallback } : { model_ids: [] }),
    )
    try {
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'ds-curated', 'ollama')).toBeNull()
      expect(await catalog.liveModels(home, 'deepseek')).toMatchObject({ source: 'fallback', count: 1 })
      const first = lookups('deepseek')
      // Within the short TTL a rebuilt catalog reuses the fallback answer and still does not trust it.
      tick(31)
      await catalog.warmSessionModelRepair(home)
      expect(lookups('deepseek')).toBe(first)
      expect(catalog.sessionModelRepair(home, 'ds-curated', 'ollama')).toBeNull()
      // Past it, the next build asks again; a live answer confirms the group.
      fallback = false
      tick(31)
      await catalog.warmSessionModelRepair(home)
      expect(lookups('deepseek')).toBe(first + 1)
      expect(catalog.sessionModelRepair(home, 'ds-curated', 'ollama')).toEqual(['ds-curated', 'deepseek'])
      expect(await catalog.liveModels(home, 'deepseek')).toMatchObject({ source: 'live', count: 1 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // TAL-981: setup cards for providers without credentials follow the picker, not the frozen tables.
  const unkeyed = { model: { provider: 'ollama', default: 'llama3.2' }, providers: { ollama: { base_url: 'http://ollama.test/v1' } } }

  it('lists the Agent\'s curated ids on an unkeyed provider card, keeping the static table without a sidecar', async () => {
    const { home, catalog } = setup(unkeyed, (provider) => (provider === 'anthropic' ? { model_ids: ['claude-fable-5.1', 'claude-opus-5-5', 'claude-haiku-5-5'], fallback: true } : { model_ids: [] }))
    try {
      const card = (await catalog.providers(home)).providers.find((p) => p.id === 'anthropic')!
      expect(card).toMatchObject({ has_key: false, configured: false, models_total: 3 })
      expect((card.models as Entry[]).map((m) => m.id)).toEqual(['claude-fable-5.1', 'claude-opus-5-5', 'claude-haiku-5-5'])
      const sidecar = new FakeSidecar()
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: unkeyed }))
      const offline = new ProviderCatalog({ sidecar: () => null, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
      const fallback = (await offline.providers(home)).providers.find((p) => p.id === 'anthropic')!
      expect((fallback.models as Entry[]).map((m) => m.id)).toEqual(PROVIDER_MODELS.anthropic!.map((m) => m.id))
      expect(fallback.models_total).toBe(PROVIDER_MODELS.anthropic!.length)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('starts every unconfigured card\'s lookup before any answers', async () => {
    const reference = setup(unkeyed, () => ({ model_ids: [] }))
    let expected = 0
    try {
      const rows = (await reference.catalog.providers(reference.home)).providers
      const lookups = new Set(rows.filter((p) => p.configured !== true && p.is_custom !== true && p.is_plugin_provider !== true).map((p) => String(p.id)))
      expect(lookups.size).toBeGreaterThan(10)
      for (const id of lookups) expect(reference.lookups(id), id).toBe(1)
      // The configured Ollama row looks its catalog up in the same batch.
      expected = reference.sidecar.calls.filter((c) => c.method === 'providers.model_ids').length
      expect(expected).toBe(lookups.size + 1)
    } finally {
      rmSync(reference.home, { recursive: true, force: true })
    }
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let started = 0
    const { home, catalog, sidecar } = setup(unkeyed, () => ({ model_ids: [] }))
    try {
      sidecar.respond('providers.model_ids', async (p) => { started += 1; await held; return { provider: p.provider, model_ids: [] } })
      const cards = catalog.providers(home)
      try {
        await vi.waitFor(() => { expect(started).toBe(expected) })
      } finally { release() }
      await cards
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('keyless self-hosted providers (TAL-570)', () => {
  it('count an endpoint as configured, list its live models, and refresh them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-catalog-'))
    try {
      let ids = ['qwen3', 'llama3.2']
      const sidecar = new FakeSidecar()
      const config = { model: { provider: 'lmstudio', default: 'qwen3', base_url: 'http://gpu-box:1234/v1' }, providers: { lmstudio: { base_url: 'http://gpu-box:1234/v1' } } }
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
      sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
      sidecar.respond('plugins.providers', () => ({ providers: [] }))
      sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'lmstudio' ? ids : [] }))
      writeFileSync(join(home, 'config.yaml'), '# cfg\n')
      const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
      const row = async (id: string) => (await catalog.providers(home)).providers.find((p) => p.id === id)!
      expect(await row('lmstudio')).toMatchObject({ has_key: false, configured: true, models_total: 2 })
      // Ollama has no endpoint configured here, so it stays unconfigured.
      expect(await row('ollama')).toMatchObject({ has_key: false, configured: false })
      expect((await catalog.models(home)).groups.find((g) => g.provider_id === 'lmstudio')?.models.map((m) => m.id)).toEqual(expect.arrayContaining(['qwen3', 'llama3.2']))
      ids = ['qwen3', 'llama3.2', 'gemma3']
      catalog.invalidate(home, 'lmstudio')
      expect(await row('lmstudio')).toMatchObject({ models_total: 3 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('model_catalog.excluded_providers (TAL-911)', () => {
  const pickerFor = async (modelCatalog: unknown, model: Json = { provider: 'gemini', default: 'gemini-2.5-flash' }) => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-catalog-'))
    const sidecar = new FakeSidecar()
    const config = {
      model,
      providers: { anthropic: { api_key: 'sk-ant-12345678' }, gemini: { api_key: 'gm-12345678' }, openrouter: { api_key: 'sk-or-12345678' } },
      model_catalog: modelCatalog,
    }
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: [], fallback: true }))
    writeFileSync(join(home, 'config.yaml'), '# cfg\n')
    const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
    try {
      const built = await catalog.models(home)
      const groups = built.groups.map((g) => g.provider_id)
      const entries = built.groups.flatMap((g) => [...g.models, ...(g.extra_models ?? [])])
      return { groups, entries, geminiOption: catalog.modelOptionFor(home, 'gemini-2.5-flash', 'gemini'), anthropicOption: catalog.modelOptionFor(home, 'claude-sonnet-4.6', 'anthropic') }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('drops excluded providers from the picker case-insensitively, the active one included', async () => {
    const { groups, geminiOption, anthropicOption } = await pickerFor({ excluded_providers: [' openrouter ', 'Gemini'] })
    expect(groups).toContain('anthropic')
    expect(groups).not.toContain('openrouter')
    expect(groups).not.toContain('gemini')
    // Session model options follow the catalog: an excluded provider's pair selects no picker entry.
    expect(geminiOption).toBeNull()
    expect(anthropicOption).not.toBeNull()
  })

  it('matches an excluded alias against the provider it names', async () => {
    const { groups } = await pickerFor({ excluded_providers: ['Claude', 'github-copilot'] })
    expect(groups).not.toContain('anthropic')
    expect(groups).toEqual(expect.arrayContaining(['gemini', 'openrouter']))
  })

  it('never adds a default qualified to an excluded provider to another group', async () => {
    const { groups, entries } = await pickerFor({ excluded_providers: ['openrouter'] }, { provider: 'anthropic', default: '@openrouter:openai/gpt-5.5' })
    expect(groups).not.toContain('openrouter')
    expect(entries.filter((e) => e.provider_id === 'openrouter' || e.id.includes('openrouter'))).toEqual([])
  })

  it('treats an empty or non-list value as no exclusion', async () => {
    for (const value of [{ excluded_providers: [] }, { excluded_providers: 'openrouter' }, 'openrouter', null]) {
      expect((await pickerFor(value)).groups).toEqual(expect.arrayContaining(['anthropic', 'gemini', 'openrouter']))
    }
  })
})

describe('live model ids after an Agent account switch (TAL-542)', () => {
  it('re-reads live ids when the Agent\'s sign-in store changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-catalog-'))
    try {
      let clock = 1_800_000_000
      let ids = ['cp-a']
      const sidecar = new FakeSidecar()
      const config = { model: { provider: 'anthropic', default: 'claude-sonnet-4' }, providers: { ollama: { base_url: 'http://ollama.test/v1', models: ['llama3.2'] } } }
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
      sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: p.provider === 'copilot', provider: p.provider ?? '' } }))
      sidecar.respond('plugins.providers', () => ({ providers: [] }))
      sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'copilot' ? ids : [] }))
      writeFileSync(join(home, 'config.yaml'), '# cfg\n')
      writeFileSync(join(home, 'auth.json'), '{"account":"a"}\n')
      const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => clock, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'cp-a', 'ollama')).toEqual(['cp-a', 'copilot'])
      // `hermes` switches the Copilot account: only auth.json changes, and the new account lists other models.
      ids = ['cp-b']
      writeFileSync(join(home, 'auth.json'), '{"account":"bb"}\n')
      clock += 1
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'cp-a', 'ollama')).toBeNull()
      expect(catalog.sessionModelRepair(home, 'cp-b', 'ollama')).toEqual(['cp-b', 'copilot'])
      // A sign-in change while the catalog is being built makes that build stale; the warm-up rebuilds it.
      let edits = 0
      sidecar.respond('plugins.providers', () => { if (edits++ === 0) { ids = ['cp-c']; writeFileSync(join(home, 'auth.json'), '{"account":"ccc"}\n') } return { providers: [] } })
      clock += 1
      writeFileSync(join(home, '.env'), 'TRIGGER_REBUILD=1\n')
      await catalog.warmSessionModelRepair(home)
      expect(catalog.sessionModelRepair(home, 'cp-c', 'ollama')).toEqual(['cp-c', 'copilot'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the picker overflow split', () => {
  it('keeps a colon-bearing selected model visible', () => {
    const models = Array.from({ length: 30 }, (_, i) => ({ id: `m${String(i)}`, label: `M${String(i)}` }))
    const [visible, extras] = splitPickerOverflow(models, '@custom:localhost:8080:m20', 'custom:localhost:8080')
    expect(visible.map((m) => m.id)).toContain('m20')
    expect(extras.map((m) => m.id)).not.toContain('m20')
  })
})

/** TAL-301: every `/api/models` and `/api/providers` entry carries the server's split of its id. */
describe('catalog entries carry their routing provider and bare id', () => {
  let s: TestServer
  let sidecar: FakeSidecar

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234', GOOGLE_API_KEY: 'g-test-1234', GEMINI_API_KEY: 'g-test-5678' })
    const config = {
      model: { default: '@custom:localhost:8080:m', provider: 'anthropic' },
      providers: { ollama: { base_url: 'http://localhost:11434/v1', models: ['llama3:8b'] } },
    }
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: existsSync(join(p.profile_home, 'config.yaml')), config }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: [], fallback: true }))
  })
  afterAll(() => s.close())

  it('stamps /api/models entries and the default with `parseProviderQualifiedModel` output', async () => {
    const catalog = (await (await s.get('/api/models')).json()) as Json
    const groups = catalog.groups as Group[]
    const entries = groups.flatMap((g) => [...g.models, ...(g.extra_models ?? [])].map((e) => ({ group: g.provider_id, ...e })))
    for (const e of entries) {
      const [bare, provider] = parseProviderQualifiedModel(e.id) ?? [e.id, e.group]
      expect({ id: e.id, provider_id: e.provider_id, bare_id: e.bare_id }).toEqual({ id: e.id, provider_id: provider, bare_id: bare })
    }
    const byId = (id: string): Entry | undefined => entries.find((e) => e.id === id)
    expect(byId('@ollama:llama3:8b')).toMatchObject({ provider_id: 'ollama', bare_id: 'llama3:8b' })
    expect(byId('@custom:localhost:8080:m')).toMatchObject({ provider_id: 'custom:localhost:8080', bare_id: 'm' })
    expect(byId('@gemini:gemini-2.5-flash')).toMatchObject({ provider_id: 'gemini', bare_id: 'gemini-2.5-flash' })
    expect(byId('@google:gemini-2.5-flash')).toMatchObject({ provider_id: 'google', bare_id: 'gemini-2.5-flash' })
    expect(byId('claude-opus-4.7')).toMatchObject({ provider_id: 'anthropic', bare_id: 'claude-opus-4.7' })
    expect(catalog).toMatchObject({ default_model: '@custom:localhost:8080:m', default_provider_id: 'custom:localhost:8080', default_bare_id: 'm', default_option_id: '@custom:localhost:8080:m' })
  })

  it('stamps /api/providers model lists with the card provider', async () => {
    const rows = ((await (await s.get('/api/providers')).json()) as Json).providers as { id: string; models: Entry[] }[]
    const ollama = rows.find((r) => r.id === 'ollama')
    expect(ollama?.models).toContainEqual(expect.objectContaining({ id: 'llama3:8b', provider_id: 'ollama', bare_id: 'llama3:8b' }))
    for (const row of rows) for (const m of row.models) expect(m.provider_id).toBe(parseProviderQualifiedModel(m.id)?.[1] ?? row.id)
  })

  it('session payloads carry the catalog entry their stored pair selects', async () => {
    const post = async (path: string, body: Json): Promise<Json> => (await (await s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json()) as Json
    const sid = String(((await post('/api/session/new', {})).session as Json).session_id)
    const cases: [Json, string | null][] = [
      [{ model: '@ollama:llama3:8b', model_provider: 'ollama' }, '@ollama:llama3:8b'],
      [{ model: '@custom:localhost:8080:m', model_provider: 'custom:localhost:8080' }, '@custom:localhost:8080:m'],
      [{ model: 'gemini-2.5-flash', model_provider: 'google' }, '@google:gemini-2.5-flash'],
      [{ model: 'gemini-2.5-flash', model_provider: 'gemini' }, '@gemini:gemini-2.5-flash'],
      [{ model: 'not-in-catalog', model_provider: 'ollama' }, null],
    ]
    for (const [body, optionId] of cases) {
      const updated = (await post('/api/session/update', { session_id: sid, ...body })).session as Json
      expect(updated.model_option_id, JSON.stringify(body)).toBe(optionId)
      const detail = ((await (await s.get(`/api/session?session_id=${sid}`)).json()) as Json).session as Json
      expect(detail.model_option_id, JSON.stringify(body)).toBe(optionId)
    }
  })

  it('a catalog invalidation drops the option ids it paired against', async () => {
    await s.get('/api/models')
    expect(s.deps.catalog.modelOptionFor(s.state, 'llama3:8b', 'ollama')).toBe('@ollama:llama3:8b')
    s.deps.catalog.invalidate(s.state)
    expect(s.deps.catalog.modelOptionFor(s.state, 'llama3:8b', 'ollama')).toBeNull()
    await s.deps.catalog.warmModelOptions(s.state)
    expect(s.deps.catalog.modelOptionFor(s.state, 'llama3:8b', 'ollama')).toBe('@ollama:llama3:8b')
  })

  it('cron job payloads carry the catalog entry their stored pair selects', async () => {
    const jobs = new Map<string, Json>()
    sidecar.respond('cron.list', () => ({ jobs: [...jobs.values()] as never[] }))
    sidecar.respond('cron.create', (params) => { const job = { id: `c${String(jobs.size + 1)}`, name: null, profile: null, toast_notifications: true, monitor: '', continuity: false, ...(params.job as Json), context_from: [] }; jobs.set(job.id, job); return { job: job } })
    const create = async (body: Json): Promise<Json> => ((await (await s.get('/api/crons/create', { method: 'POST', body: JSON.stringify({ schedule: 'every 1h', prompt: 'hi', ...body }), headers: { 'content-type': 'application/json' } })).json()) as Json).job as Json
    expect(await create({ model: '@ollama:llama3:8b' })).toMatchObject({ model: 'llama3:8b', provider: 'ollama', model_option_id: '@ollama:llama3:8b' })
    expect(await create({ model: 'gemini-2.5-flash', provider: 'google' })).toMatchObject({ model_option_id: '@google:gemini-2.5-flash' })
    expect(await create({ model: 'gemini-2.5-flash' })).toMatchObject({ model_option_id: null })
    const listed = ((await (await s.get('/api/crons')).json()) as Json).jobs as Json[]
    expect(listed.map((j) => j.model_option_id)).toEqual(['@ollama:llama3:8b', '@google:gemini-2.5-flash', null])
  })

  it('stamps /api/models/live entries with the echoed provider', async () => {
    const live = (await (await s.get('/api/models/live?provider=gemini')).json()) as { provider: string; models: Entry[] }
    expect(live.provider).toBe('gemini')
    expect(live.models).toContainEqual(expect.objectContaining({ id: 'gemini-2.5-flash', provider_id: 'gemini', bare_id: 'gemini-2.5-flash' }))
  })
})

const python = ((): string | null => { try { return execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim() } catch { return null } })()

describe.skipIf(!python)('usage.balance numbers on the wire (TAL-1655)', () => {
  // The real sidecar parser behind a stubbed endpoint, then the sidecar's strict encoder.
  const read = (provider: string, body: string): unknown => JSON.parse(execFileSync(python!, ['-c', [
    'import io, json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from talaria_sidecar.methods import usage',
    'class Response(io.BytesIO):',
    '    def __enter__(self): return self',
    '    def __exit__(self, *exc): return False',
    'usage._open_balance = lambda request, timeout=None: Response(sys.argv[3].encode())',
    "print(json.dumps(usage.balance(sys.argv[2], credential_id=None, api_key='sk-synthetic'), separators=(',', ':'), allow_nan=False))",
  ].join('\n'), join(WEB_ROOT, 'sidecar'), provider, body], { encoding: 'utf8' }))
  const huge = `1${'0'.repeat(400)}`

  it.each([huge, `-${huge}`])('keeps an out-of-range number %# out of an otherwise valid balance read', (bad) => {
    const parse = (provider: string, body: string) => SIDECAR_METHODS['usage.balance'].result.parse(read(provider, body))
    expect(parse('openrouter', `{"data":{"usage":${bad},"limit":100,"limit_remaining":42.5}}`)).toMatchObject({ status: 'ok', quota: { usage: null, limit: 100, limit_remaining: 42.5 } })
    expect(parse('deepseek', `{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"12.5","granted_balance":${bad},"topped_up_balance":${bad}}]}`))
      .toMatchObject({ status: 'ok', balances: [{ currency: 'USD', total: 12.5, granted: null, topped_up: null }] })
  })
})

describe('OpenRouter cost history arithmetic (TAL-1655)', () => {
  it('reports no pace when finite daily usage sums past the largest number', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cost-overflow-'))
    try {
      writeFileSync(join(home, 'config.yaml'), '# synthetic configuration\n')
      writeEnvFile(join(home, '.env'), { OPENROUTER_API_KEY: 'sk-synthetic-cost' })
      mkdirSync(join(home, 'cost-snapshots'))
      // 1_800_000_000 is 2027-01-15 UTC; the deltas are 1e308, 1e307 (a reset) and 1e308, each finite, their sum not.
      const snapshots = [{ date: '2027-01-12', used: 0, limit: null }, { date: '2027-01-13', used: 1e308, limit: null }, { date: '2027-01-14', used: 1e307, limit: null }]
      writeFileSync(join(home, 'cost-snapshots', 'openrouter.json'), JSON.stringify({ provider: 'openrouter', snapshots }))
      const sidecar = new FakeSidecar()
      sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'openrouter' } } }))
      sidecar.respond('usage.pool_providers', () => ({ providers: [], keys: {} }))
      sidecar.respond('usage.balance', () => ({ status: 'ok', http_status: null, label: null, quota: { usage: 1.1e308, limit: null, limit_remaining: null }, is_available: null, balances: [], windows: [] }))
      const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => 50, isRootProfileHome: () => true })
      const history = await catalog.costHistory(home, 'openrouter', 30)
      expect(history).toMatchObject({ status: 'available', monthly_pace: null, budget_percent: null, budget_level: null, has_enough_data: true })
      const rows = history.snapshots as Json[]
      expect(rows.map((r) => r.delta)).toEqual([null, 1e308, 1e307, 1e308])
      for (const row of rows) expect(Number.isFinite(row.bar_percent)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
