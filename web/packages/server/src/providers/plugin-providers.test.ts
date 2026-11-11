import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { writeEnvFile } from '../test/env-file.js'

type Json = Record<string, unknown>
interface Row { id: string; display_name?: string; has_key?: boolean; is_active?: boolean; is_custom?: boolean; install_hint?: string | null; is_plugin_provider?: boolean; configurable?: boolean; is_oauth?: boolean; key_source?: string; removable?: boolean; auth_error?: string | null; models?: { id: string }[]; models_total?: number }
interface Group { provider: string; provider_id: string; models: { id: string }[] }
interface Source { source_id: string; provider_id: string; provider_label: string; status: string; supported: boolean; unavailable_reason: string | null; windows: { label: string; used_percent: number }[]; details: string[] }
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const profileRow = (name: string, path: string, isDefault: boolean) => ({ name, path, is_default: isDefault, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })

/** TAL-288: model-provider plugins installed in a profile join the provider cards and the picker as their own providers. */
describe('installed model-provider plugins in the provider catalog', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let other: string
  const configs = new Map<string, Json>()
  let plugins: (home: string) => { name: string; display_name: string; auth_type: string; setup: 'ready' | 'missing_cli' | 'needs_setup' | 'not_loaded' | 'unavailable'; account_usage?: boolean }[]
  const providers = async (headers: Record<string, string> = {}): Promise<Json> => json(await s.get('/api/providers', { headers }))
  const models = async (headers: Record<string, string> = {}): Promise<Json> => json(await s.get('/api/models', { headers }))

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    other = join(s.state, 'profiles', 'other')
    mkdirSync(other, { recursive: true })
    for (const home of [s.state, other]) {
      writeFileSync(join(home, 'config.yaml'), '# seed\n')
      configs.set(home, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } })
      writeEnvFile(join(home, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234' })
    }
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: existsSync(join(p.profile_home, 'config.yaml')), config: configs.get(p.profile_home) ?? {} }))
    sidecar.respond('profiles.list', () => ({ profiles: [profileRow('default', s.state, true), profileRow('other', other, false)] }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    // Two providers list the same bare id; only the default profile has the plugin installed.
    plugins = (home) => (home === s.state ? [
      { name: 'fake-sub', display_name: 'Fake Subscription', auth_type: 'external_process', setup: 'ready' },
      { name: 'fake-missing', display_name: 'Fake Missing CLI', auth_type: 'external_process', setup: 'missing_cli' },
      // An alias of a built-in (`claude` is Anthropic) would route to that provider's API billing.
      { name: 'claude', display_name: 'Claude Lookalike', auth_type: 'external_process', setup: 'ready' },
      { name: 'under_score', display_name: 'Under Score', auth_type: 'external_process', setup: 'ready' },
    ] : [])
    sidecar.respond('plugins.providers', (p) => ({ providers: plugins(p.profile_home) }))
    sidecar.respond('providers.model_ids', (p) => ({
      provider: p.provider,
      model_ids: p.provider === 'anthropic' ? ['claude-opus-4-7', 'claude-sonnet-4-6'] : p.provider === 'fake-sub' && p.profile_home === s.state ? ['fake-opus', 'claude-sonnet-4-6'] : p.provider === 'under_score' ? ['us-1'] : [],
    }))
    s.deps.profiles.invalidate()
  })
  afterAll(() => s.close())

  it('offers and routes device sign-in only for the active profile plugin capability (TAL-1827)', async () => {
    const original = plugins
    const row = { name: 'device-test', display_name: 'Device Test', auth_type: 'oauth_device_code', setup: 'needs_setup' as const, device_login: true }
    plugins = (home) => home === s.state ? [row] : []
    sidecar.respond('oauth.start', (p) => ({ flow_id: 'device-flow', provider: p.provider, status: 'pending', user_code: 'TEST-1827', verification_url: 'https://device.example.test/login', expires_in: 90, interval: 1 }))
    try {
      s.deps.catalog.invalidate()
      expect((await providers()).providers).toContainEqual(expect.objectContaining({ id: 'device-test', device_login: true, has_key: false }))
      const started = await post(s, '/api/onboarding/oauth/start', { provider: 'device-test' })
      expect(started.status).toBe(200)
      expect(await json(started)).toMatchObject({ provider: 'device-test', user_code: 'TEST-1827' })
      expect(sidecar.calls.filter((c) => c.method === 'oauth.start').at(-1)?.params).toEqual({ profile_home: s.state, provider: 'device-test' })
      expect((await post(s, '/api/onboarding/oauth/start', { provider: 'device-test' }, { cookie: 'hermes_profile=other' })).status).toBe(400)
      plugins = () => [{ ...row, device_login: false }]
      s.deps.catalog.invalidate()
      expect((await post(s, '/api/onboarding/oauth/start', { provider: 'device-test' })).status).toBe(400)
    } finally {
      plugins = original
      sidecar.respond('oauth.start', undefined)
      s.deps.catalog.invalidate()
    }
  })

  it('a ready plugin is its own provider card and picker group; built-ins and the default stay unchanged', async () => {
    const cards = await providers()
    const rows = cards.providers as Row[]
    expect(cards.active_provider).toBe('anthropic')
    expect(rows.find((p) => p.id === 'fake-sub')).toMatchObject({
      display_name: 'Fake Subscription', is_plugin_provider: true, has_key: true, configurable: false, is_oauth: false, key_source: 'plugin', removable: false, auth_error: null,
      models: [{ id: 'fake-opus' }, { id: 'claude-sonnet-4-6' }], models_total: 2,
    })
    expect(rows.find((p) => p.id === 'anthropic')).toMatchObject({ has_key: true, is_plugin_provider: false, key_source: 'env_file', models: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-6' }] })
    expect(rows.some((p) => p.id === 'claude' || p.display_name === 'Claude Lookalike')).toBe(false)

    const catalog = await models()
    const groups = catalog.groups as Group[]
    expect(catalog.active_provider).toBe('anthropic')
    expect(catalog.default_model).toBe('claude-sonnet-4-6')
    expect(groups[0]).toMatchObject({ provider_id: 'anthropic', models: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-6' }] })
    // The overlapping id keeps its plugin identity through a provider-qualified id.
    expect(groups.some((g) => g.provider_id === 'claude')).toBe(false)
    // A plugin id is routed verbatim, never folded like a built-in id (`under_score` is not `under-score`).
    expect(groups.find((g) => g.provider_id === 'under_score')).toMatchObject({ provider: 'Under Score', models: [{ id: '@under_score:us-1' }] })
    expect(groups.find((g) => g.provider_id === 'fake-sub')).toMatchObject({ provider: 'Fake Subscription', models: [{ id: '@fake-sub:fake-opus' }, { id: '@fake-sub:claude-sonnet-4-6' }] })
    const badges = catalog.configured_model_badges as Json
    expect(badges['claude-sonnet-4-6']).toEqual({ role: 'main', label: 'Main', provider: 'anthropic' })
    expect(badges['@fake-sub:claude-sonnet-4-6']).toBeUndefined()
  })

  it('a plugin that is not set up is a truthful card without picker models or a key fallback', async () => {
    const row = ((await providers()).providers as Row[]).find((p) => p.id === 'fake-missing')
    expect(row).toMatchObject({ is_plugin_provider: true, has_key: false, configurable: false, key_source: 'none', models: [], models_total: 0 })
    expect(row?.auth_error).toMatch(/CLI/)
    expect(sidecar.calls.some((c) => c.method === 'providers.model_ids' && (c.params as Json).provider === 'fake-missing')).toBe(false)
    expect(((await models()).groups as Group[]).some((g) => g.provider_id === 'fake-missing')).toBe(false)
  })

  it('the composer selection reaches the chat runtime as the plugin provider and its bare model', async () => {
    const created = await json(await post(s, '/api/session/new', {}))
    const sid = String((created.session as Json).session_id)
    let started: Json | null = null
    sidecar.respond('chat.start', (params) => {
      started = params
      return { status: 'completed', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'claude-sonnet-4-6', provider: 'fake-sub', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }
    })
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'hi', model: '@fake-sub:claude-sonnet-4-6', model_provider: 'fake-sub' })
    expect(res.status).toBe(200)
    await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}`, (f) => f.event === 'stream_end')
    expect(started).toMatchObject({ model: 'claude-sonnet-4-6', model_provider: 'fake-sub' })
    expect((await s.deps.sessionStore.get(sid))).toMatchObject({ model: 'claude-sonnet-4-6', model_provider: 'fake-sub' })
  })

  it('another profile never sees the plugin, and a refresh drops a removed plugin', async () => {
    const cookie = ((await post(s, '/api/profile/switch', { name: 'other' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(((await providers({ cookie })).providers as Row[]).some((p) => p.is_plugin_provider)).toBe(false)
    expect(((await models({ cookie })).groups as Group[]).some((g) => g.provider_id === 'fake-sub')).toBe(false)

    const installed = plugins
    plugins = () => []
    try {
      expect((await post(s, '/api/models/refresh', {})).status).toBe(200)
      expect(((await providers()).providers as Row[]).some((p) => p.is_plugin_provider)).toBe(false)
      expect(((await models()).groups as Group[]).some((g) => g.provider_id === 'fake-sub')).toBe(false)
    } finally {
      plugins = installed
      s.deps.catalog.invalidate()
    }
  })

  it('reads a usage-capable plugin\'s own account limits per profile and keeps its source while signed out (TAL-2187)', async () => {
    const original = plugins
    const usage = { name: 'fake-usage', display_name: 'Fake Usage', auth_type: 'api_key' }
    // The same plugin name in two profiles, each signed in to a different synthetic account, or not at all.
    const accounts = new Map<string, number | null>([[s.state, null], [other, 64]])
    let listing: (home: string) => ReturnType<typeof plugins> = (home) => [
      { ...usage, setup: accounts.get(home) === null ? 'needs_setup' : 'ready', account_usage: true },
      { name: 'fake-plain', display_name: 'Fake Plain', auth_type: 'api_key', setup: 'ready' },
    ]
    plugins = (home) => listing(home)
    sidecar.respond('usage.pool_providers', () => ({ providers: [], keys: {} }))
    sidecar.respond('usage.pool', () => ({ entries: [], has_api_key: false }))
    sidecar.respond('usage.account', (p) => {
      if (p.provider !== 'fake-usage') return { snapshot: null }
      const used = accounts.get(p.profile_home)
      return { snapshot: used === null || used === undefined
        ? { provider: 'fake-usage', available: false, unavailable_reason: 'no synthetic subscription login found', windows: [], details: [] }
        : { provider: 'fake-usage', available: true, title: 'Synthetic plan', fetched_at: '2027-01-15T08:00:00Z', windows: [{ label: 'Current session', used_percent: used }], details: [`account ${used}`] } }
    })
    const quotas = async (query = '', headers: Record<string, string> = {}): Promise<{ availability: { status: string }; sources: Source[] }> => (await json(await s.get(`/api/provider/quotas${query}`, { headers }))) as never
    const plugin = (body: { sources: Source[] }): Source | undefined => body.sources.find((row) => row.provider_id === 'fake-usage')
    try {
      s.deps.catalog.invalidate()
      // Signed out: still a source, with the plugin's own reason rather than a missing row or local pool status.
      const signedOut = plugin(await quotas('?refresh=true'))
      expect(signedOut).toMatchObject({ provider_label: 'Fake Usage', supported: true, status: 'unavailable', windows: [] })
      expect(signedOut?.unavailable_reason).toContain('no synthetic subscription login found')
      // A plugin without the hook keeps its existing unsupported row and is never read.
      expect((await quotas()).sources.find((row) => row.provider_id === 'fake-plain')).toMatchObject({ supported: false, status: 'unsupported' })
      expect(sidecar.calls.some((c) => c.method === 'usage.account' && (c.params as { provider: string }).provider === 'fake-plain')).toBe(false)
      // Read through the plugin's own identity: no key, base URL or pool account borrowed from a built-in.
      expect(sidecar.calls.filter((c) => c.method === 'usage.account' && (c.params as { provider: string }).provider === 'fake-usage').at(-1)?.params).toEqual({ profile_home: s.state, provider: 'fake-usage' })

      // The other profile's same-named plugin answers with its own account only.
      const cookie = ((await post(s, '/api/profile/switch', { name: 'other' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      try {
        const named = plugin(await quotas('?refresh=true', { cookie }))
        expect(named).toMatchObject({ status: 'available', details: ['account 64'] })
        expect(named?.windows.map((w) => w.used_percent)).toEqual([64])
        expect(named?.source_id).not.toBe(signedOut?.source_id)
      } finally {
        await post(s, '/api/profile/switch', { name: 'default' }, { cookie })
      }
      expect(plugin(await quotas())).toMatchObject({ status: 'unavailable', windows: [] })

      // A later sign-in recovers the same source.
      accounts.set(s.state, 12)
      s.deps.catalog.invalidate()
      const recovered = plugin(await quotas('?refresh=true'))
      expect(recovered).toMatchObject({ source_id: signedOut?.source_id, status: 'available', details: ['account 12'] })

      // A failed plugin listing keeps the last-confirmed source stale; a confirmed uninstall removes it.
      sidecar.respond('plugins.providers', () => { throw new SidecarError('plugin manager unavailable', { condition: 'plugins_unavailable' }) })
      s.deps.catalog.invalidate(undefined, undefined, { preserveConfirmed: true })
      expect(plugin(await quotas('?refresh=true'))).toMatchObject({ source_id: signedOut?.source_id, status: 'stale' })
      sidecar.respond('plugins.providers', (p) => ({ providers: plugins(p.profile_home) }))
      listing = () => []
      s.deps.catalog.invalidate(undefined, undefined, { preserveConfirmed: true })
      expect(plugin(await quotas('?refresh=true'))).toBeUndefined()
    } finally {
      plugins = original
      for (const method of ['usage.pool_providers', 'usage.pool', 'usage.account'] as const) sidecar.respond(method, undefined)
      sidecar.respond('plugins.providers', (p) => ({ providers: plugins(p.profile_home) }))
      s.deps.catalog.invalidate()
    }
  })

  it('a failed plugin listing leaves every other provider usable', async () => {
    sidecar.respond('plugins.providers', () => { throw new SidecarError('plugin manager unavailable', { condition: 'plugins_unavailable' }) })
    try {
      s.deps.catalog.invalidate()
      const groups = (await models()).groups as Group[]
      expect(groups[0]).toMatchObject({ provider_id: 'anthropic' })
      expect(groups.some((g) => g.provider_id === 'fake-sub')).toBe(false)
      expect(((await providers()).providers as Row[]).find((p) => p.id === 'anthropic')).toMatchObject({ has_key: true })
    } finally {
      sidecar.respond('plugins.providers', (p) => ({ providers: plugins(p.profile_home) }))
      s.deps.catalog.invalidate()
    }
  })
})

/** TAL-1812: Agent v0.22.6 moved GitHub Copilot into a catalog plugin; it reaches the catalog only as the sidecar's plugin rows. */
describe('a provider that left the Agent core', () => {
  let s: TestServer
  let config: Json
  let rows: { name: string; display_name: string; auth_type: string; setup: 'ready' | 'missing_cli' | 'not_installed'; install_hint?: string; aliases?: string[] }[]
  const providers = async (): Promise<{ active_provider: string; providers: Row[] }> => {
    writeFileSync(join(s.state, 'config.yaml'), `# ${JSON.stringify(config)}\n`)
    s.deps.catalog.invalidate()
    return (await json(await s.get('/api/providers'))) as { active_provider: string; providers: Row[] }
  }

  beforeAll(async () => {
    const sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
    sidecar.respond('plugins.providers', () => ({ providers: rows }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'copilot' ? ['gpt-5.5'] : [] }))
  })
  afterAll(() => s.close())

  it('has no built-in card, and shows the plugin\'s own rows once it is installed', async () => {
    config = { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } }
    rows = []
    const builtIn = (await providers()).providers.map((p) => p.id)
    expect(builtIn).not.toContain('copilot')
    expect(builtIn).not.toContain('copilot-acp')

    rows = [{ name: 'copilot', display_name: 'GitHub Copilot', auth_type: 'copilot', setup: 'ready' }, { name: 'copilot-acp', display_name: 'GitHub Copilot ACP', auth_type: 'external_process', setup: 'missing_cli' }]
    const installed = (await providers()).providers
    expect(installed.find((p) => p.id === 'copilot')).toMatchObject({ display_name: 'GitHub Copilot', is_plugin_provider: true, is_oauth: false, has_key: true, key_source: 'plugin', models: [{ id: 'gpt-5.5' }], models_total: 1 })
    expect(installed.find((p) => p.id === 'copilot-acp')).toMatchObject({ display_name: 'GitHub Copilot ACP', is_plugin_provider: true, has_key: false, models: [] })
  })

  it('offers the catalog plugin on the card of a provider the profile still names', async () => {
    config = { model: { default: 'gpt-5.5', provider: 'copilot' } }
    rows = [{ name: 'copilot', display_name: 'GitHub Copilot', auth_type: '', setup: 'not_installed', install_hint: 'github-copilot' }]
    const answer = await providers()
    expect(answer.active_provider).toBe('copilot')
    expect(answer.providers.filter((p) => p.id === 'copilot')).toMatchObject([{ display_name: 'GitHub Copilot', install_hint: 'github-copilot', is_active: true, is_plugin_provider: true, has_key: false, models: [], auth_error: expect.any(String) as string }])
  })

  it('leaves a custom provider named github as itself', async () => {
    rows = []
    config = { model: { default: 'm', provider: 'github' }, providers: { github: { api: 'https://git.invalid/v1', api_key: 'sk-test', default_model: 'm' } } }
    const answer = await providers()
    expect(answer.providers.map((p) => p.id)).not.toContain('copilot')
    expect(answer.active_provider).toBe('custom:github')
    expect(answer.providers.find((p) => p.id === 'custom:github')).toMatchObject({ is_custom: true, is_active: true, base_url: 'https://git.invalid/v1' })
  })

  describe('declared plugin aliases (TAL-1940)', () => {
    const copilot = { name: 'copilot', display_name: 'GitHub Copilot', auth_type: 'copilot', setup: 'ready' as const, aliases: ['github-copilot', 'github-models', 'github', 'claude'] }
    const models = async (): Promise<{ active_provider: string; groups: Group[]; configured_model_badges: Record<string, { provider: string }> }> => (await json(await s.get('/api/models'))) as never

    it('reads the selected alias as the plugin on its card, in the picker and in the settings and fallbacks that name it', async () => {
      rows = [copilot]
      config = { model: { default: 'gpt-5.5', provider: 'github-copilot' }, providers: { 'github-models': { models: ['pinned-1'] } }, fallback_providers: [{ provider: 'github', model: 'gpt-5.5-mini' }] }
      const answer = await providers()
      expect(answer.active_provider).toBe('copilot')
      expect(answer.providers.filter((p) => p.is_active).map((p) => p.id)).toEqual(['copilot'])
      expect(answer.providers.map((p) => p.id).filter((id) => id.startsWith('github'))).toEqual([])

      const catalog = await models()
      expect(catalog.active_provider).toBe('copilot')
      expect(catalog.groups.map((g) => g.provider_id)).toEqual(['copilot'])
      expect(catalog.groups[0]?.provider).toBe('GitHub Copilot')
      expect(catalog.groups[0]?.models.map((m) => m.id)).toContain('pinned-1')
      expect(catalog.configured_model_badges['@copilot:gpt-5.5-mini']).toMatchObject({ provider: 'copilot' })
      expect(await json(await s.get('/api/provider/quota'))).toMatchObject({ provider: 'copilot' })
    })

    it.each<[string, Json, string]>([
      ['a native providers.<key> endpoint', { providers: { github: { api: 'https://git.invalid/v1', api_key: 'sk-test', default_model: 'm' } } }, 'custom:github'],
      ['a legacy custom provider', { custom_providers: [{ name: 'github', base_url: 'https://git.invalid/v1', api_key: 'sk-test', model: 'm' }] }, 'custom:github'],
    ])('leaves %s named after an alias as itself', async (_name, endpoint, id) => {
      rows = [copilot]
      config = { model: { default: 'm', provider: 'github' }, ...endpoint }
      const answer = await providers()
      expect(answer.active_provider).toBe(id)
      expect(answer.providers.find((p) => p.id === id)).toMatchObject({ is_custom: true, is_active: true })
      expect(answer.providers.find((p) => p.id === 'copilot')).toMatchObject({ is_active: false })
      expect((await models()).active_provider).toBe(id)
    })

    it('never lets an alias stand in for a built-in provider', async () => {
      rows = [copilot]
      config = { model: { default: 'claude-sonnet-4-6', provider: 'claude' } }
      expect((await providers()).active_provider).toBe('anthropic')
      expect((await models()).active_provider).toBe('anthropic')
    })
  })
})
