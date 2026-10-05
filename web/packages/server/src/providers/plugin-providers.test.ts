import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { writeEnvFile } from './env-file.js'

type Json = Record<string, unknown>
interface Row { id: string; display_name?: string; has_key?: boolean; is_plugin_provider?: boolean; configurable?: boolean; is_oauth?: boolean; key_source?: string; auth_error?: string | null; models?: { id: string }[]; models_total?: number }
interface Group { provider: string; provider_id: string; models: { id: string }[] }
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const profileRow = (name: string, path: string, isDefault: boolean) => ({ name, path, is_default: isDefault, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })

/** TAL-288: model-provider plugins installed in a profile join the provider cards and the picker as their own providers. */
describe('installed model-provider plugins in the provider catalog', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let other: string
  const configs = new Map<string, Json>()
  let plugins: (home: string) => { name: string; display_name: string; auth_type: string; setup: 'ready' | 'missing_cli' | 'needs_setup' | 'not_loaded' | 'unavailable' }[]
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

  it('a ready plugin is its own provider card and picker group; built-ins and the default stay unchanged', async () => {
    const cards = await providers()
    const rows = cards.providers as Row[]
    expect(cards.active_provider).toBe('anthropic')
    expect(rows.find((p) => p.id === 'fake-sub')).toMatchObject({
      display_name: 'Fake Subscription', is_plugin_provider: true, has_key: true, configurable: false, is_oauth: false, key_source: 'plugin', auth_error: null,
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
    expect(s.deps.sessionStore.get(sid)).toMatchObject({ model: 'claude-sonnet-4-6', model_provider: 'fake-sub' })
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
