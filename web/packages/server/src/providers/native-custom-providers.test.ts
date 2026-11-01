import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeProviderFromConfig, AgentConfig, customProviderEntries, customProviderOwner, modelBaseUrl, type Config } from '../config/agent-config.js'
import { HOME_DOTENV_KEYS_VAR } from '../cli/dotenv.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { ProviderCatalog, type ModelEntry } from './catalog.js'

interface Row { id: string; display_name: string; has_key: boolean; is_custom: boolean; key_source: string; base_url: string | null; models: ModelEntry[] }

const DEMO = { name: 'Friendly Demo', api: 'https://synthetic.invalid/v1', key_env: 'DEMO_KEY', models: { 'demo-model': { context_length: 777777 } } }
const OMNI = { name: 'Omni Label', url: 'https://omni.invalid/v1', api_key_env: 'OMNI_KEY', default_model: 'omni-1' }

describe('native custom providers in the catalog (TAL-1654)', () => {
  let home: string
  let sidecar: FakeSidecar
  let config: Config
  let pooled: string[]
  const build = (env: Record<string, string | undefined>, root = true) => new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env }), env, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => root })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'talaria-native-custom-'))
    writeFileSync(join(home, 'config.yaml'), '# synthetic config\n')
    config = { model: { provider: 'anthropic', default: 'claude-sonnet-4' }, providers: { 'custom:demo': structuredClone(DEMO), omni: structuredClone(OMNI) } }
    pooled = []
    sidecar = new FakeSidecar()
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config: structuredClone(config) }))
    sidecar.respond('usage.pool_providers', () => ({ providers: pooled, keys: {} }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.auth_status', () => ({ status: { logged_in: false } }))
    sidecar.respond('providers.local_models', () => ({ provider_id: 'llamacpp', models: [], current_endpoint: null }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: [] }))
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('keeps keyed and bare native identities, labels, endpoints, keys and models consistent across cards and picker', async () => {
    const catalog = build({ DEMO_KEY: 'sk-synthetic-demo', OMNI_KEY: 'sk-synthetic-omni' })
    const rows = (await catalog.providers(home)).providers as unknown as Row[]
    const groups = (await catalog.models(home)).groups
    for (const [id, label, baseUrl, model] of [['custom:demo', 'Friendly Demo', 'https://synthetic.invalid/v1', 'demo-model'], ['custom:omni', 'Omni Label', 'https://omni.invalid/v1', 'omni-1']] as const) {
      const cards = rows.filter((r) => r.id === id)
      expect(cards, id).toHaveLength(1)
      expect(cards[0]).toMatchObject({ display_name: label, has_key: true, is_custom: true, base_url: baseUrl })
      expect(cards[0]!.models.map((m) => m.bare_id ?? m.id)).toEqual([model])
      const group = groups.find((g) => g.provider_id === id)
      expect(group, `${id} picker group`).toMatchObject({ provider: label })
      expect(group!.models.map((m) => m.bare_id ?? m.id)).toEqual(cards[0]!.models.map((m) => m.bare_id ?? m.id))
    }
    expect(rows.some((r) => r.id === 'omni')).toBe(false)
    expect(await catalog.contextLengthInputs(home, 'demo-model', 'custom:demo')).toEqual({ base_url: 'https://synthetic.invalid/v1', api_key: 'sk-synthetic-demo', config_context_length: 777777 })
    const quota = await catalog.quota(home, 'custom:demo')
    expect(quota.display_name).toBe('Friendly Demo')
    expect(String(quota.message)).toContain('Friendly Demo')
    expect(sidecar.calls.some((c) => c.method === 'providers.auth_status' && String((c.params as { provider?: string }).provider).includes('omni'))).toBe(false)
  })

  it('resolves key_env within the selected profile and counts a pooled-only native identity', async () => {
    // A named profile never borrows the default profile's `.env` copy of the variable.
    const borrowed = build({ DEMO_KEY: 'sk-root-only', [HOME_DOTENV_KEYS_VAR]: 'DEMO_KEY' }, false)
    expect(((await borrowed.providers(home)).providers as unknown as Row[]).find((r) => r.id === 'custom:demo')).toMatchObject({ has_key: false, key_source: 'none' })
    expect((await borrowed.contextLengthInputs(home, 'demo-model', 'custom:demo')).api_key).toBeUndefined()
    writeFileSync(join(home, '.env'), 'DEMO_KEY=sk-profile-demo\n')
    const scoped = build({ DEMO_KEY: 'sk-root-only', [HOME_DOTENV_KEYS_VAR]: 'DEMO_KEY' }, false)
    expect(((await scoped.providers(home)).providers as unknown as Row[]).find((r) => r.id === 'custom:demo')).toMatchObject({ has_key: true })
    expect((await scoped.contextLengthInputs(home, 'demo-model', 'custom:demo')).api_key).toBe('sk-profile-demo')
    rmSync(join(home, '.env'))
    pooled = ['custom:demo']
    const pool = build({})
    expect(((await pool.providers(home)).providers as unknown as Row[]).find((r) => r.id === 'custom:demo')).toMatchObject({ has_key: true, key_source: 'credential_pool' })
  })

  it('keeps a selected owner key and context when an empty legacy store suppresses the view', async () => {
    config = { ...config, custom_providers: [] }
    const catalog = build({ DEMO_KEY: 'sk-synthetic-demo' })
    const rows = (await catalog.providers(home)).providers as unknown as Row[]
    expect(rows.some((r) => r.id.startsWith('custom:') || r.id === 'omni')).toBe(false)
    expect(await catalog.contextLengthInputs(home, 'demo-model', 'custom:demo')).toEqual({ base_url: 'https://synthetic.invalid/v1', api_key: 'sk-synthetic-demo', config_context_length: 777777 })
  })

  it('never routes a disabled identity to another record or key', async () => {
    config = { model: { provider: 'anthropic' }, providers: { 'custom:demo': { ...DEMO, enabled: false }, demo: { api: 'https://other.invalid/v1', api_key: 'sk-other-owner' } } }
    const catalog = build({ DEMO_KEY: 'sk-synthetic-demo' })
    const rows = (await catalog.providers(home)).providers as unknown as Row[]
    expect(rows.some((r) => r.id === 'custom:demo' || r.id === 'demo')).toBe(false)
    expect(await catalog.contextLengthInputs(home, 'demo-model', 'custom:demo')).toEqual({ config_context_length: null })
  })
})

describe('custom provider read view and owner (TAL-1654)', () => {
  const slugs = (config: Config, plugins?: ReadonlySet<string>) => customProviderEntries(config, plugins).map((e) => [e.name, e.display_name ?? null, e.base_url ?? null])

  it('reads legacy-only, native-only and mixed stores with the legacy winner', () => {
    expect(slugs({ custom_providers: [{ name: 'Legacy', base_url: 'https://legacy.invalid/v1' }] })).toEqual([['Legacy', null, 'https://legacy.invalid/v1']])
    expect(slugs({ providers: { 'custom:demo': DEMO, omni: OMNI } })).toEqual([['custom:demo', 'Friendly Demo', 'https://synthetic.invalid/v1'], ['omni', 'Omni Label', 'https://omni.invalid/v1']])
    const mixed: Config = { custom_providers: [{ name: 'Demo', base_url: 'https://legacy.invalid/v1' }], providers: { 'custom:demo': DEMO, 'custom:other': { api: 'https://other.invalid/v1' } } }
    expect(slugs(mixed)).toEqual([['Demo', null, 'https://legacy.invalid/v1'], ['custom:other', null, 'https://other.invalid/v1']])
    expect(customProviderOwner(mixed, 'custom:demo').entry).toMatchObject({ base_url: 'https://legacy.invalid/v1' })
    const omni = customProviderEntries({ providers: { omni: OMNI } })[0]!
    expect(omni).toMatchObject({ model: 'omni-1', key_env: 'OMNI_KEY' })
  })

  it.each([[[]], [null], ['malformed'], [{}]])('suppresses the native view under custom_providers=%j but keeps the owner', (legacy) => {
    const config: Config = { custom_providers: legacy, providers: { 'custom:demo': DEMO } }
    expect(customProviderEntries(config)).toEqual([])
    expect(customProviderOwner(config, 'custom:demo')).toMatchObject({ entry: { base_url: 'https://synthetic.invalid/v1', key_env: 'DEMO_KEY' }, refused: null })
    expect(modelBaseUrl(config, 'custom:demo')).toBe('https://synthetic.invalid/v1')
  })

  it('refuses disabled exact records and ambiguous aliases, and lets the exact key outrank an alias', () => {
    for (const enabled of [false, 'off', 'False', 0]) {
      const config: Config = { providers: { 'custom:demo': { ...DEMO, enabled }, demo: { api: 'https://alias.invalid/v1' } } }
      expect(customProviderEntries(config)).toEqual([])
      expect(customProviderOwner(config, 'custom:demo')).toEqual({ entry: null, refused: 'disabled' })
      expect(modelBaseUrl(config, 'custom:demo')).toBe('')
    }
    const ambiguous: Config = { providers: { Demo: { api: 'https://a.invalid/v1' }, demo: { api: 'https://b.invalid/v1' }, 'custom:other': { api: 'https://other.invalid/v1' } } }
    expect(slugs(ambiguous)).toEqual([['custom:other', null, 'https://other.invalid/v1']])
    expect(customProviderOwner(ambiguous, 'custom:demo')).toEqual({ entry: null, refused: 'ambiguous' })
    const oneEnabled: Config = { providers: { Demo: { api: 'https://a.invalid/v1', enabled: false }, demo: { api: 'https://b.invalid/v1' } } }
    expect(customProviderOwner(oneEnabled, 'custom:demo').entry).toMatchObject({ base_url: 'https://b.invalid/v1' })
    const exact: Config = { providers: { demo: { api: 'https://alias.invalid/v1' }, 'custom:demo': DEMO } }
    expect(slugs(exact)).toEqual([['custom:demo', 'Friendly Demo', 'https://synthetic.invalid/v1']])
  })

  it('exempts built-in, alias, local runtime, plugin, base_url-override and endpoint-less settings', () => {
    const config: Config = { providers: {
      openrouter: { base_url: 'https://openrouter.invalid/v1' }, OpenRouter: { api: 'https://x.invalid' }, grok: { base_url: 'https://grok.invalid' }, ollama: { base_url: 'http://ollama.invalid/v1' },
      custom: { base_url: 'https://generic.invalid/v1' }, local: { base_url: 'http://local.invalid' }, llamacpp: { base_url: 'http://llama.invalid' },
      kilocode: { base_url: 'https://kilo.invalid/v1', models: ['kilo/auto'] }, myplugin: { api: 'https://plugin.invalid/v1' }, keyonly: { api_key: 'sk-not-an-endpoint' }, only_configured: true,
    } }
    expect(slugs(config, new Set(['myplugin']))).toEqual([])
    expect(slugs(config)).toEqual([['myplugin', null, 'https://plugin.invalid/v1']])
  })

  it('agrees with the active provider and route resolvers', () => {
    const config: Config = { model: { provider: 'omni', default: 'omni-1' }, providers: { omni: OMNI } }
    expect(activeProviderFromConfig(config)).toBe('custom:omni')
    expect(activeProviderFromConfig(config, new Set(['omni']))).toBe('omni')
    expect(modelBaseUrl(config, 'custom:omni')).toBe('https://omni.invalid/v1')
  })

  it('projects read-only without changing the source config', () => {
    const config: Config = { custom_providers: [{ name: 'Legacy', api_key_env: 'L' }], providers: { 'custom:demo': structuredClone(DEMO), omni: structuredClone(OMNI) } }
    const before = structuredClone(config)
    for (const entry of customProviderEntries(config)) { entry.name = 'changed'; if (entry.models) Object.assign(entry.models, { injected: {} }) }
    customProviderOwner(config, 'custom:omni').entry!.base_url = 'changed'
    expect(config).toEqual(before)
  })

  it('reads every native identity in a bounded number of providers-map operations', () => {
    const n = 2000
    let ops = 0
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < n; i += 1) raw[i % 2 ? `custom:p${i}` : `p${i}`] = { api: `https://p${i}.invalid/v1` }
    const providers = new Proxy(raw, { get: (t, k, r): unknown => { ops += 1; return Reflect.get(t, k, r) as unknown }, ownKeys: (t) => { ops += 1; return Reflect.ownKeys(t) }, getOwnPropertyDescriptor: (t, k) => { ops += 1; return Reflect.getOwnPropertyDescriptor(t, k) } })
    expect(customProviderEntries({ providers })).toHaveLength(n)
    expect(ops).toBeLessThan(4 * n)
  })
})
