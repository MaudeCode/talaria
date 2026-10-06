import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { AccountUsageSnapshotSchema, ProviderQuotaSchema, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { loadEnvFile, writeEnvFile } from '../providers/env-file.js'
import { applyProviderPrefix, deduplicateModelIds, formatOllamaLabel, labelForModel, uniqueQuotaSources } from '../providers/catalog.js'
import { coerceReasoningEffort, parseProviderQualifiedModel, customProviderSlug } from '../config/agent-config.js'
import { splitProviderModel } from '../profiles/profiles.js'

type Json = Record<string, unknown>
const dictOf = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

/** An in-memory config.yaml the fake sidecar serves and stores, keyed by profile home. */
function fakeConfigStore(sidecar: FakeSidecar, initial: Record<string, Json> = {}): Map<string, Json> {
  const store = new Map<string, Json>(Object.entries(initial))
  sidecar.respond('config.get', (params) => {
    const path = join(params.profile_home, 'config.yaml')
    if (existsSync(path)) {
      // The server only calls config.get when a file exists; the fake serves the in-memory copy written by config.set.
      return { path, exists: true, config: store.get(params.profile_home) ?? {} }
    }
    return { path, exists: false, config: {} }
  })
  sidecar.respond('config.set', (params) => {
    store.set(params.profile_home, params.config)
    const path = join(params.profile_home, 'config.yaml')
    mkdirSync(params.profile_home, { recursive: true })
    writeFileSync(path, `# fake yaml ${String(Date.now())} ${String(Math.random())}\n`)
    return { ok: true as const, path }
  })
  return store
}

describe('settings, profiles, models, providers, reasoning, onboarding', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let configs: Map<string, Json>
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    configs = fakeConfigStore(sidecar)
    // Seed config.yaml so config.get answers with the seeded model section.
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    configs.set(s.state, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' }, agent: { reasoning_effort: 'high', personalities: { pirate: 'Talk like a pirate', calm: { description: 'Calm helper', system_prompt: 'Be calm', tone: 'gentle' } } }, display: { show_reasoning: false } })
    sidecar.respond('models.reasoning_efforts', (params) => ({ efforts: params.model.startsWith('claude') ? ['low', 'medium', 'high'] : [], supports_reasoning: params.model.startsWith('claude') }))
    sidecar.respond('providers.model_ids', (params) => ({ provider: params.provider, model_ids: params.provider === 'anthropic' ? ['claude-opus-4-7', 'claude-sonnet-4-6'] : [] }))
    sidecar.respond('providers.auth_status', (params) => ({ status: { logged_in: false, provider: params.provider ?? '', error: 'not logged in' } }))
  })
  afterAll(() => s.close())

  it('GET /api/settings carries auth state, max_tokens, and version badges without the password hash', async () => {
    const res = await s.get('/api/settings')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).not.toHaveProperty('password_hash')
    expect(body.auth_enabled).toBe(false)
    expect(body.password_auth_enabled).toBe(false)
    expect(body.password_env_var).toBe(false)
    expect(body.passkeys_enabled).toBe(false)
    expect(body.webui_version).toBe('web-v0.0.0-test')
    expect(typeof body.agent_version).toBe('string')
    expect(body.max_tokens).toBeNull()
    expect(body.max_tokens_effective).toBeNull()
    expect(body.persisted_speech_keys).toEqual([])
    expect(body.default_model).toBe('claude-sonnet-4-6')
    expect(body.default_model_provider).toBe('anthropic')
  })

  it('POST /api/settings persists allowed keys, writes max_tokens to config.yaml, and clears it on blank', async () => {
    let res = await post(s, '/api/settings', { bot_name: '  ', send_key: 'ctrl+enter', max_tokens: '4096', not_a_setting: true })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.bot_name).toBe('Hermes')
    expect(body.send_key).toBe('ctrl+enter')
    expect(body.max_tokens).toBe(4096)
    expect(body.max_tokens_effective).toBe(4096)
    expect(body.logged_in).toBe(false)
    expect(body.auth_just_enabled).toBe(false)
    expect(configs.get(s.state)?.max_tokens).toBe(4096)
    expect(body).not.toHaveProperty('not_a_setting')
    res = await post(s, '/api/settings', { max_tokens: '' })
    body = await json(res)
    expect(body.max_tokens).toBeNull()
    expect(configs.get(s.state)).not.toHaveProperty('max_tokens')
  })

  it('POST /api/settings/link-check answers the saved link preferences per clicked URL (TAL-279)', async () => {
    const check = async (url: string) => (await json(await post(s, '/api/settings/link-check', { url }))).opens_directly
    expect(await json(await post(s, '/api/settings/link-check', { url: 'https://Docs.Example.com:8443/guide' }))).toEqual({ opens_directly: false, host: 'docs.example.com' })
    expect(await check('https://docs.example.com/guide')).toBe(false)
    await post(s, '/api/settings', { trusted_link_hosts: ['Docs.Example.com'] })
    expect(await check('https://DOCS.example.com:8443/guide')).toBe(true)
    expect(await check('https://docs.example.com.evil.test/')).toBe(false)
    expect(await check('javascript:alert(1)')).toBe(false)
    await post(s, '/api/settings', { confirm_external_links: false, trusted_link_hosts: [] })
    expect(await check('https://anything.test/')).toBe(true)
    expect(await check('/relative')).toBe(false)
    await post(s, '/api/settings', { confirm_external_links: true })
    expect(await check('https://anything.test/')).toBe(false)
  })

  it('first password setup from loopback enables auth and logs the caller in with a session cookie', async () => {
    const res = await post(s, '/api/settings', { _set_password: 'correct horse battery' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.auth_enabled).toBe(true)
    expect(body.password_auth_enabled).toBe(true)
    expect(body.auth_just_enabled).toBe(true)
    expect(body.logged_in).toBe(true)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('hermes_session=')
    const sessionCookie = cookie.split(';')[0] ?? ''
    // Changing it again needs the current password; wrong → 403, right → 200.
    let again = await post(s, '/api/settings', { _set_password: 'new one here', _current_password: 'nope' }, { cookie: sessionCookie, 'x-hermes-csrf-token': await csrfFor(s, sessionCookie) })
    expect(again.status).toBe(403)
    expect((await json(again)).error).toBe('Current password is incorrect.')
    again = await post(s, '/api/settings', { _clear_password: true, _current_password: 'correct horse battery' }, { cookie: sessionCookie, 'x-hermes-csrf-token': await csrfFor(s, sessionCookie) })
    expect(again.status).toBe(200)
    expect((await json(again)).password_auth_enabled).toBe(false)
  })

  it('GET/POST /api/reasoning reads and writes config.yaml keys and coerces the stored effort', async () => {
    let res = await s.get('/api/reasoning')
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body).toEqual({ show_reasoning: false, reasoning_effort: 'high', supported_efforts: ['low', 'medium', 'high'], supports_reasoning_effort: true, supports_thinking_toggle: true })
    res = await post(s, '/api/reasoning', { effort: 'xhigh' })
    body = await json(res)
    expect(body.reasoning_effort).toBe('high')
    expect(configs.get(s.state)?.agent).toMatchObject({ reasoning_effort: 'xhigh' })
    res = await post(s, '/api/reasoning', { display: 'show' })
    expect((await json(res)).show_reasoning).toBe(true)
    res = await post(s, '/api/reasoning', { effort: 'bogus' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/reasoning', {})
    expect(res.status).toBe(400)
    res = await post(s, '/api/reasoning', { effort: '' })
    expect((await json(res)).reasoning_effort).toBe('')
    expect(configs.get(s.state)?.agent).not.toHaveProperty('reasoning_effort')
    res = await s.get('/api/reasoning?model=gpt-4o&provider=openai')
    body = await json(res)
    expect(body.supported_efforts).toEqual([])
    expect(body.supports_thinking_toggle).toBe(false)
  })

  it('personalities list from config.yaml and personality/set resolves the prompt onto the session', async () => {
    let res = await s.get('/api/personalities')
    expect(await json(res)).toEqual({ personalities: [{ name: 'pirate', description: 'Talk like a pirate' }, { name: 'calm', description: 'Calm helper' }] })
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    res = await post(s, '/api/personality/set', { session_id: sid, name: 'calm' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, personality: 'calm', prompt: 'Be calm\nTone: gentle' })
    res = await post(s, '/api/personality/set', { session_id: sid, name: 'missing' })
    expect(res.status).toBe(404)
    res = await post(s, '/api/personality/set', { session_id: sid, name: '' })
    expect(await json(res)).toEqual({ ok: true, personality: null, prompt: '' })
    res = await post(s, '/api/personality/set', { session_id: 'nope', name: 'calm' })
    expect(res.status).toBe(404)
  })

  it('GET /api/models composes the catalog: active provider first, live ids for keyed providers, prefixes for others', async () => {
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234', OPENROUTER_API_KEY: 'sk-or-test-1234' })
    const res = await s.get('/api/models')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.active_provider).toBe('anthropic')
    expect(body.default_model).toBe('claude-sonnet-4-6')
    const groups = body.groups as { provider: string; provider_id: string; models: { id: string; label: string }[] }[]
    expect(groups[0]?.provider_id).toBe('anthropic')
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6'])
    const openrouter = groups.find((g) => g.provider_id === 'openrouter')
    expect(openrouter).toBeDefined()
    expect(openrouter?.models.every((m) => m.id.startsWith('@openrouter:') || m.id.includes('/'))).toBe(true)
    expect(body.configured_model_badges).toMatchObject({ 'claude-sonnet-4-6': { role: 'main', label: 'Main', provider: 'anthropic' } })
    const bad = await s.get('/api/models?freshness=nope')
    expect(bad.status).toBe(400)
  })

  it('POST /api/models/refresh evicts the live cache and re-asks the sidecar', async () => {
    const before = sidecar.calls.filter((c) => c.method === 'providers.model_ids').length
    const res = await post(s, '/api/models/refresh', { provider: 'anthropic' })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('anthropic')
    expect(sidecar.calls.filter((c) => c.method === 'providers.model_ids').length).toBeGreaterThan(before)
    // TAL-570: a refresh reaches past the Agent's own catalog cache.
    expect(sidecar.calls.slice(before).some((c) => c.method === 'providers.model_ids' && (c.params as Json).provider === 'anthropic' && (c.params as Json).force_refresh === true)).toBe(true)
  })

  it('GET /api/providers reports key presence and sources; POST writes and removes keys in .env', async () => {
    let res = await s.get('/api/providers')
    expect(res.status).toBe(200)
    let body = await json(res)
    const providers = body.providers as { id: string; has_key: boolean; key_source: string; configurable: boolean; is_oauth: boolean; models_total: number }[]
    const anthropic = providers.find((p) => p.id === 'anthropic')
    expect(anthropic).toMatchObject({ has_key: true, key_source: 'env_file', configurable: true, is_oauth: false })
    expect(providers.find((p) => p.id === 'openai')).toMatchObject({ has_key: false, key_source: 'none' })
    expect(providers.find((p) => p.id === 'openai-codex')).toMatchObject({ is_oauth: true, configurable: false, has_key: false, auth_error: 'not logged in' })
    expect(body.active_provider).toBe('anthropic')
    res = await post(s, '/api/providers', { provider: 'deepseek', api_key: 'sk-deepseek-12345' })
    expect(await json(res)).toEqual({ ok: true, provider: 'deepseek', display_name: 'DeepSeek', action: 'updated' })
    expect(loadEnvFile(join(s.state, '.env')).DEEPSEEK_API_KEY).toBe('sk-deepseek-12345')
    expect(statSync(join(s.state, '.env')).mode & 0o777).toBe(0o600)
    res = await post(s, '/api/providers', { provider: 'deepseek', api_key: 'short' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/providers', { provider: 'openai-codex', api_key: 'sk-whatever-1234' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/providers/delete', { provider: 'deepseek' })
    expect((await json(res)).action).toBe('removed')
    expect(loadEnvFile(join(s.state, '.env'))).not.toHaveProperty('DEEPSEEK_API_KEY')
    res = await s.get('/api/providers')
    body = await json(res)
    expect((body.providers as { id: string; has_key: boolean }[]).find((p) => p.id === 'deepseek')?.has_key).toBe(false)
  })

  it('a credential copied from the default profile .env at startup never counts for a named profile, and removing it retires the runtime copy', async () => {
    // Simulates `loadStartupEnv`: the default profile's .env put OPENAI_API_KEY into the process environment.
    const env = s.deps.config.env
    env.OPENAI_API_KEY = 'sk-from-home-dotenv-1234'
    env.HERMES_WEBUI_HOME_DOTENV_KEYS = 'OPENAI_API_KEY'
    writeEnvFile(join(s.state, '.env'), { OPENAI_API_KEY: 'sk-from-home-dotenv-1234' })
    mkdirSync(join(s.state, 'profiles', 'nokey'), { recursive: true })
    sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }, { name: 'nokey', path: join(s.state, 'profiles', 'nokey'), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
    s.deps.profiles.invalidate()
    s.deps.catalog.invalidate()
    try {
      const rows = async (cookie?: string): Promise<{ id: string; has_key: boolean; key_source: string }[]> => ((await json(await s.get('/api/providers', cookie ? { headers: { cookie } } : {}))).providers as { id: string; has_key: boolean; key_source: string }[])
      expect((await rows()).find((p) => p.id === 'openai')).toMatchObject({ has_key: true })
      const switched = await post(s, '/api/profile/switch', { name: 'nokey' })
      const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      expect((await rows(cookie)).find((p) => p.id === 'openai')).toMatchObject({ has_key: false, key_source: 'none' })
      // A key supplied by the process environment itself still applies everywhere.
      env.DEEPSEEK_API_KEY = 'sk-deepseek-process-1234'
      s.deps.catalog.invalidate()
      expect((await rows(cookie)).find((p) => p.id === 'deepseek')).toMatchObject({ has_key: true, key_source: 'env_var' })
      // Removing the dotenv-owned key on the default profile clears the runtime copy and tells the sidecar.
      const before = sidecar.calls.length
      expect((await json(await post(s, '/api/providers/delete', { provider: 'openai' }))).action).toBe('removed')
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.HERMES_WEBUI_HOME_DOTENV_KEYS).toBe('')
      expect(sidecar.calls.slice(before).find((c) => c.method === 'runtime.env')?.params).toEqual({ unset: ['OPENAI_API_KEY'] })
      expect((await rows()).find((p) => p.id === 'openai')).toMatchObject({ has_key: false })
      // A process-environment key is not touched by a delete.
      await post(s, '/api/providers/delete', { provider: 'deepseek' })
      expect(env.DEEPSEEK_API_KEY).toBe('sk-deepseek-process-1234')
      // A key the default profile did not have at startup becomes dotenv-owned and reaches the runtime and sidecar.
      const added = sidecar.calls.length
      expect((await json(await post(s, '/api/providers', { provider: 'openai', api_key: 'sk-added-later-1234' }))).action).toBe('updated')
      expect(env.OPENAI_API_KEY).toBe('sk-added-later-1234')
      expect(env.HERMES_WEBUI_HOME_DOTENV_KEYS).toBe('OPENAI_API_KEY')
      expect(sidecar.calls.slice(added).find((c) => c.method === 'runtime.env')?.params).toEqual({ set: { OPENAI_API_KEY: 'sk-added-later-1234' } })
      // The sidecar must confirm the change: a refused refresh fails the edit and leaves the file and runtime as they were.
      sidecar.respond('runtime.env', () => { throw new Error('sidecar busy') })
      const refused = await post(s, '/api/providers/delete', { provider: 'openai' })
      expect(refused.status).toBe(503)
      expect(String((await json(refused)).error)).toContain('did not apply')
      expect(env.OPENAI_API_KEY).toBe('sk-added-later-1234')
      expect(loadEnvFile(join(s.state, '.env')).OPENAI_API_KEY).toBe('sk-added-later-1234')
      sidecar.respond('runtime.env', () => ({ ok: true as const }))
      // A write failure after the sidecar accepted the change rolls the sidecar back to the previous value.
      chmodSync(s.state, 0o500)
      try {
        const envCalls = sidecar.calls.length
        const failed = await post(s, '/api/providers/delete', { provider: 'openai' })
        expect(failed.status).toBe(400)
        const runtimeEnv = sidecar.calls.slice(envCalls).filter((c) => c.method === 'runtime.env').map((c) => c.params)
        expect(runtimeEnv).toEqual([{ unset: ['OPENAI_API_KEY'] }, { set: { OPENAI_API_KEY: 'sk-added-later-1234' } }])
        expect(env.OPENAI_API_KEY).toBe('sk-added-later-1234')
      } finally {
        chmodSync(s.state, 0o700)
      }
      // If the compensating call fails too, the divergent child is recycled so its replacement starts from the unchanged environment.
      let envCalls2 = 0
      sidecar.respond('runtime.env', () => { envCalls2 += 1; if (envCalls2 === 2) throw new Error('sidecar restarting'); return { ok: true as const } })
      chmodSync(s.state, 0o500)
      try {
        const recycledBefore = sidecar.recycled.length
        expect((await post(s, '/api/providers/delete', { provider: 'openai' })).status).toBe(400)
        expect(sidecar.recycled.length).toBe(recycledBefore + 1)
        expect(sidecar.recycled.at(-1)).toContain('OPENAI_API_KEY')
        expect(env.OPENAI_API_KEY).toBe('sk-added-later-1234')
      } finally {
        chmodSync(s.state, 0o700)
        sidecar.status = 'ready'
        sidecar.respond('runtime.env', () => ({ ok: true as const }))
      }
      // Two overlapping root-profile edits run as one transaction each: the second sidecar apply waits for the first
      // edit to commit (out-of-order sidecar replies can no longer commit the wrong value), and both keep ownership.
      const gates: (() => void)[] = []
      sidecar.respond('runtime.env', () => new Promise((resolve) => { gates.push(() => { resolve({ ok: true as const }) }) }))
      const a = post(s, '/api/providers', { provider: 'anthropic', api_key: 'sk-ant-overlap-1234' })
      const b = post(s, '/api/providers', { provider: 'openrouter', api_key: 'sk-or-overlap-1234' })
      const waitForGates = async (n: number): Promise<void> => { const until = Date.now() + 5000; while (gates.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 10)) }
      await waitForGates(1)
      await new Promise((r) => setTimeout(r, 50))
      expect(gates).toHaveLength(1)
      gates[0]!()
      await waitForGates(2)
      expect(gates).toHaveLength(2)
      gates[1]!()
      sidecar.respond('runtime.env', () => ({ ok: true as const }))
      expect((await a).status).toBe(200)
      expect((await b).status).toBe(200)
      expect(env.HERMES_WEBUI_HOME_DOTENV_KEYS?.split(',').sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'])
      delete env.ANTHROPIC_API_KEY
      delete env.OPENROUTER_API_KEY
      // ...while an explicitly supplied process value keeps precedence when its provider key is (re)written.
      expect((await json(await post(s, '/api/providers', { provider: 'deepseek', api_key: 'sk-deepseek-file-1234' }))).action).toBe('updated')
      expect(env.DEEPSEEK_API_KEY).toBe('sk-deepseek-process-1234')
    } finally {
      delete env.OPENAI_API_KEY
      delete env.DEEPSEEK_API_KEY
      delete env.HERMES_WEBUI_HOME_DOTENV_KEYS
      sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
      s.deps.profiles.invalidate()
      s.deps.catalog.invalidate()
    }
  })

  it('deleting a provider credential removes YAML blocks stored under any alias of the provider', async () => {
    configs.set(s.state, { ...(configs.get(s.state) ?? {}), providers: { ramp: { api_key: 'sk-router-legacy-1234' }, 'ramp-router': { base_url: 'https://router.example' } } })
    s.deps.agentConfig.invalidate()
    s.deps.catalog.invalidate()
    expect(((await json(await s.get('/api/providers'))).providers as { id: string; has_key: boolean }[]).find((p) => p.id === 'router')).toMatchObject({ has_key: true })
    expect((await json(await post(s, '/api/providers/delete', { provider: 'router' }))).action).toBe('removed')
    expect(configs.get(s.state)?.providers).toEqual({ ramp: {}, 'ramp-router': { base_url: 'https://router.example' } })
    expect(((await json(await s.get('/api/providers'))).providers as { id: string; has_key: boolean }[]).find((p) => p.id === 'router')).toMatchObject({ has_key: false })
  })

  it('a failed YAML credential removal is the response, and the dotenv credential stays until every source is clear', async () => {
    writeEnvFile(join(s.state, '.env'), { ...loadEnvFile(join(s.state, '.env')), DEEPSEEK_API_KEY: 'sk-deepseek-keep-1234' })
    configs.set(s.state, { ...(configs.get(s.state) ?? {}), providers: { deepseek: { api_key: 'sk-deepseek-yaml-1234' } } })
    s.deps.agentConfig.invalidate()
    s.deps.catalog.invalidate()
    const original = sidecar.responderFor('config.set')
    sidecar.respond('config.set', () => { throw new SidecarError('config.yaml is not valid YAML', { condition: 'config_invalid' }) })
    try {
      const res = await post(s, '/api/providers/delete', { provider: 'deepseek' })
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(loadEnvFile(join(s.state, '.env')).DEEPSEEK_API_KEY).toBe('sk-deepseek-keep-1234')
      expect((configs.get(s.state)?.providers as Json).deepseek).toEqual({ api_key: 'sk-deepseek-yaml-1234' })
    } finally {
      if (original) sidecar.respond('config.set', original)
    }
    expect((await json(await post(s, '/api/providers/delete', { provider: 'deepseek' }))).action).toBe('removed')
    expect(loadEnvFile(join(s.state, '.env'))).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect((configs.get(s.state)?.providers as Json).deepseek).toEqual({})
  })

  it('the VS Code launcher honours vscode.command and the Docker path prefixes from config.yaml', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    const sid = String(((await json(await post(s, '/api/session/new', { workspace: ws }))).session as Json).session_id)
    writeFileSync(join(ws, 'note.txt'), 'x')
    configs.set(s.state, { ...(configs.get(s.state) ?? {}), vscode: { command: '/nonexistent/code-cli', container_path_prefix: '/app/workspace', host_path_prefix: '/Users/me/proj' } })
    s.deps.agentConfig.invalidate()
    await s.deps.agentConfig.read(s.state)
    const res = await post(s, '/api/file/open-vscode', { session_id: sid, path: 'note.txt' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe("VS Code command not found: '/nonexistent/code-cli'. Install VS Code and ensure the 'code' CLI is on PATH, or set vscode.command in config.yaml to the full path.")
    expect(s.deps.vscode().translate('/app/workspace/a.txt')).toBe('/Users/me/proj/a.txt')
    expect(s.deps.vscode().translate('/elsewhere/a.txt')).toBe('/elsewhere/a.txt')
    const cfg = configs.get(s.state) ?? {}
    Reflect.deleteProperty(cfg, 'vscode')
    configs.set(s.state, cfg)
    s.deps.agentConfig.invalidate()
  })

  it('quota endpoints answer per-provider status without network for unsupported providers', async () => {
    let res = await s.get('/api/provider/quota?provider=zai')
    expect(await json(res)).toMatchObject({ ok: false, provider: 'zai', supported: false, status: 'unsupported' })
    res = await s.get('/api/provider/cost-history?provider=zai&days=3')
    expect(await json(res)).toMatchObject({ ok: false, supported: false, status: 'unsupported' })
    res = await s.get('/api/provider/cost-history')
    expect(await json(res)).toMatchObject({ ok: false, status: 'missing_provider' })
    sidecar.respond('usage.account', (params) => ({ snapshot: { provider: params.provider, available: true, title: 'Claude limits', plan: 'max', windows: [{ label: '5h', used_percent: 12 }], details: [] } }))
    res = await s.get('/api/provider/quotas')
    const body = await json(res)
    expect(body.active_provider).toBe('anthropic')
    const sources = body.sources as { source_id: string; provider_id: string; status: string; is_active_provider: boolean; windows: unknown[] }[]
    const anthropic = sources.find((q) => q.provider_id === 'anthropic')
    expect(anthropic).toMatchObject({ status: 'available', is_active_provider: true })
    expect(anthropic?.windows).toHaveLength(1)
    // The stable-identity envelope the iOS widget persists: scope and profile ids, the requested source, and
    // `missing_source` when a persisted source id no longer exists. The scope id is derived from `.quota_scope_id`.
    const scopeFile = readFileSync(join(s.state, '.quota_scope_id'), 'utf8').trim()
    expect(scopeFile).toMatch(/^[0-9a-f]{32}$/)
    const expectedScope = `qscope_${createHash('sha256').update(`${scopeFile}\0default`).digest('hex').slice(0, 32)}`
    expect(body).toMatchObject({ version: 1, scope_id: expectedScope, profile_id: 'default', requested_source_id: null, missing_source: false })
    const anthropicId = `qsrc_${createHash('sha256').update(`${expectedScope}\0anthropic\0provider`).digest('hex').slice(0, 32)}`
    expect(anthropic?.source_id).toBe(anthropicId)
    const missing = await json(await s.get('/api/provider/quotas?source=qsrc_unknown'))
    expect(missing).toMatchObject({ requested_source_id: 'qsrc_unknown', missing_source: true, sources: [] })
    // The scope survives restarts: a second read answers the same id.
    expect((await json(await s.get(`/api/provider/quotas?source=${anthropicId}`))).sources).toHaveLength(1)
  })

  it('an available Agent snapshot, as the sidecar serialises it, loads as available (TAL-508)', async () => {
    // Asserted equal to `usage.account`'s output for a property-backed `available` in sidecar/tests/test_usage_account.py.
    const snapshot = AccountUsageSnapshotSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '../../../../sidecar/tests/fixtures/usage_account_available.json'), 'utf8')))
    sidecar.respond('usage.account', () => ({ snapshot }))
    expect(await json(await s.get('/api/provider/quota?provider=anthropic&refresh=1'))).toMatchObject({ ok: true, provider: 'anthropic', status: 'available', label: 'Claude limits' })
    const sources = (await json(await s.get('/api/provider/quotas?refresh=1'))).sources as { provider_id: string; status: string; windows: unknown[] }[]
    expect(sources.find((q) => q.provider_id === 'anthropic')).toMatchObject({ status: 'available', windows: [expect.objectContaining({ label: 'Current session', used_percent: 12 })] })
  })

  it('quota sources list each source id once, ordered by provider, account label, then source id (TAL-272)', async () => {
    const saved = configs.get(s.state)
    const reset = (config: Json | undefined): void => { configs.set(s.state, config ?? {}); s.deps.agentConfig.invalidate(); s.deps.catalog.invalidate() }
    // `My LLM` and `my-llm` share the `custom:my-llm` slug, so both entries derive one source id.
    reset({
      model: { default: 'claude-sonnet-4-6', provider: 'anthropic' },
      custom_providers: [{ name: 'Zeta', base_url: 'http://zeta.test/v1' }, { name: 'My LLM', base_url: 'http://a.test/v1' }, { name: 'my-llm', base_url: 'http://b.test/v1' }],
    })
    try {
      sidecar.respond('usage.account', (params) => ({ snapshot: { provider: params.provider, available: true, title: 'Limits', windows: [], details: [] } }))
      const sources = (await json(await s.get('/api/provider/quotas'))).sources as { source_id: string; provider_id: string; account_label: string }[]
      const ids = sources.map((q) => q.source_id)
      expect(ids).toEqual([...new Set(ids)])
      expect(sources.filter((q) => q.provider_id === 'custom:my-llm')).toHaveLength(1)
      expect(sources.map((q) => q.provider_id)).toEqual(expect.arrayContaining(['custom:my-llm', 'custom:zeta']))
      const key = (q: (typeof sources)[number]): string[] => [q.provider_id, q.account_label, q.source_id]
      const ordered = [...sources].sort((a, b) => { const [x, y] = [key(a), key(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1; return 0 })
      expect(sources).toEqual(ordered)
    } finally {
      reset(saved)
    }
  })

  it('a pooled provider lists one source per account; DeepSeek and OpenCode Go balances load (TAL-548)', async () => {
    const envFile = join(s.state, '.env')
    writeEnvFile(envFile, { DEEPSEEK_API_KEY: 'sk-synthetic-deepseek', OPENCODE_GO_API_KEY: 'sk-synthetic-opencode', GLM_API_KEY: 'sk-synthetic-zai' })
    s.deps.catalog.invalidate()
    const resetAt = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const pools: Record<string, SidecarResult<'usage.pool'>['entries']> = {
      zai: [
        // The configured GLM_API_KEY is the Work account, so the provider's own key adds no separate source.
        { credential_id: 'zai-work', label: 'Work', status: 'available', unavailable_reason: null, retry_after: null, matches_api_key: true },
        { credential_id: 'zai-home', label: 'Home', status: 'exhausted', unavailable_reason: 'Credential pool marked this credential exhausted after provider status 429.', retry_after: resetAt(1), matches_api_key: false },
      ],
      'opencode-go': [{ credential_id: 'oc-1', label: 'OPENCODE_GO_API_KEY', status: 'available', unavailable_reason: null, retry_after: null, matches_api_key: true }],
    }
    const empty = { status: 'ok' as const, http_status: null, quota: null, label: null, is_available: null, balances: [], windows: [] }
    sidecar.respond('usage.pool', (params) => ({ entries: pools[params.provider] ?? [] }))
    sidecar.respond('usage.balance', (params) => params.provider === 'deepseek'
      ? { ...empty, is_available: true, balances: [{ currency: 'USD' as const, total: 12.5, granted: 2.5, topped_up: 10 }] }
      : { ...empty, windows: [{ key: 'rolling' as const, used_percent: 40, reset_at: resetAt(2), rate_limited: false }, { key: 'weekly' as const, used_percent: 10, reset_at: resetAt(100), rate_limited: false }, { key: 'monthly' as const, used_percent: 5, reset_at: resetAt(400), rate_limited: true }] })
    try {
      const body = await json(await s.get('/api/provider/quotas'))
      const sources = body.sources as { source_id: string; provider_id: string; account_label: string; status: string; retry_after: unknown; windows: { label: string; used_percent: number; window_seconds: number | null; detail: string | null }[] }[]
      const sourceId = (pid: string, credential: string): string => `qsrc_${createHash('sha256').update(`${String(body.scope_id)}\0${pid}\0${credential}`).digest('hex').slice(0, 32)}`
      // One source per pool account, each with its own stable id, label, and local pool state.
      const zai = sources.filter((q) => q.provider_id === 'zai')
      expect(zai.map((q) => [q.source_id, q.account_label, q.status])).toEqual([[sourceId('zai', 'zai-home'), 'Home', 'exhausted'], [sourceId('zai', 'zai-work'), 'Work', 'available']])
      expect(zai[0]?.retry_after).toBe(pools.zai?.[1]?.retry_after)
      // DeepSeek has no pool, so its single source reads the configured key's balance.
      expect(sources.find((q) => q.provider_id === 'deepseek')).toMatchObject({ source_id: sourceId('deepseek', 'provider'), status: 'available', message: 'DeepSeek balance loaded.', balances: [{ currency: 'USD', total: 12.5, granted: 2.5, topped_up: 10 }] })
      // OpenCode Go's pool account reads its own usage windows.
      const opencode = sources.find((q) => q.provider_id === 'opencode-go')
      expect(opencode).toMatchObject({ source_id: sourceId('opencode-go', 'oc-1'), account_label: 'OPENCODE_GO_API_KEY', status: 'available' })
      expect(opencode?.windows.map((w) => [w.label, w.used_percent, w.window_seconds, w.detail])).toEqual([['5-hour', 40, 18_000, null], ['Weekly', 10, 604_800, null], ['Monthly', 5, null, 'Rate limited']])
      const balanceCalls = sidecar.calls.filter((c) => c.method === 'usage.balance').map((c) => c.params as Json)
      expect(balanceCalls).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'deepseek', api_key: 'sk-synthetic-deepseek' }), expect.objectContaining({ provider: 'opencode-go', credential_id: 'oc-1' })]))
      expect(balanceCalls.find((c) => c.provider === 'opencode-go')).not.toHaveProperty('api_key')
      // A widget's persisted pool-account id resolves to that one account.
      const one = await json(await s.get(`/api/provider/quotas?source=${sourceId('zai', 'zai-work')}`))
      expect(one).toMatchObject({ missing_source: false, sources: [{ account_label: 'Work', status: 'available' }] })
    } finally {
      sidecar.respond('usage.pool', () => ({ entries: [] }))
      writeEnvFile(envFile, { DEEPSEEK_API_KEY: null, OPENCODE_GO_API_KEY: null, GLM_API_KEY: null })
      s.deps.catalog.invalidate()
    }
  })

  it('a provider configured only through the credential pool lists its accounts (TAL-548)', async () => {
    sidecar.respond('usage.pool_providers', () => ({ providers: ['opencode-go'] }))
    sidecar.respond('usage.pool', (params) => ({ entries: params.provider === 'opencode-go' ? [{ credential_id: 'oc-pool', label: 'go@example.test', status: 'exhausted', unavailable_reason: 'Credential pool marked this credential exhausted.', retry_after: null, matches_api_key: false }] : [] }))
    s.deps.catalog.invalidate()
    try {
      const body = await json(await s.get('/api/provider/quotas'))
      const opencode = (body.sources as Json[]).filter((q) => q.provider_id === 'opencode-go')
      expect(opencode).toEqual([expect.objectContaining({ account_label: 'go@example.test', status: 'exhausted', source_id: `qsrc_${createHash('sha256').update(`${String(body.scope_id)}\0opencode-go\0oc-pool`).digest('hex').slice(0, 32)}` })])
    } finally {
      sidecar.respond('usage.pool_providers', () => ({ providers: [] }))
      sidecar.respond('usage.pool', () => ({ entries: [] }))
    }
  })

  it('a provider keyed only through the credential pool counts as configured in providers and models (TAL-638)', async () => {
    const zai = async (): Promise<Json | undefined> => ((await json(await s.get('/api/providers'))).providers as Json[]).find((p) => p.id === 'zai')
    const fail = (): never => { throw new SidecarError('usage.pool_providers timed out', { condition: 'timeout' }) }
    try {
      for (const answer of [() => ({ providers: [] }), fail]) {
        sidecar.respond('usage.pool_providers', answer)
        s.deps.catalog.invalidate()
        expect(await zai()).toMatchObject({ has_key: false, key_source: 'none' })
      }
      sidecar.respond('usage.pool_providers', () => ({ providers: ['zai'] }))
      s.deps.catalog.invalidate()
      expect(await zai()).toMatchObject({ has_key: true, configured: true, key_source: 'credential_pool' })
      const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string }[]
      expect(groups.map((g) => g.provider_id)).toContain('zai')
    } finally {
      sidecar.respond('usage.pool_providers', () => ({ providers: [] }))
      s.deps.catalog.invalidate()
    }
  })

  it('a failed pool lookup never reports a pool account as removed (TAL-548)', async () => {
    const envFile = join(s.state, '.env')
    writeEnvFile(envFile, { GLM_API_KEY: 'sk-synthetic-zai' })
    let failing = false
    const fail = (): never => { throw new SidecarError('usage.pool timed out', { condition: 'timeout' }) }
    sidecar.respond('usage.pool', (params) => (failing ? fail() : { entries: params.provider === 'zai' ? [{ credential_id: 'zai-work', label: 'Work', status: 'available', unavailable_reason: null, retry_after: null, matches_api_key: true }] : [] }))
    sidecar.respond('usage.pool_providers', () => (failing ? fail() : { providers: ['zai'] }))
    s.deps.catalog.invalidate()
    try {
      const first = await json(await s.get('/api/provider/quotas'))
      const work = (first.sources as Json[]).find((q) => q.provider_id === 'zai' && q.account_label === 'Work')
      expect(work).toBeDefined()
      // A transient failure keeps the accounts the last lookup found, so a widget's account id still resolves.
      failing = true
      const again = await json(await s.get(`/api/provider/quotas?source=${String(work?.source_id)}`))
      expect(again).toMatchObject({ missing_source: false, sources: [{ account_label: 'Work' }] })
      // Once a credential change drops that answer, a pool nobody can read is never reported as a removed account.
      s.deps.catalog.invalidate()
      const other = await json(await s.get('/api/provider/quotas?source=qsrc_unconfirmed'))
      expect(other).toMatchObject({ missing_source: false, sources: [] })
    } finally {
      sidecar.respond('usage.pool', () => ({ entries: [] }))
      sidecar.respond('usage.pool_providers', () => ({ providers: [] }))
      writeEnvFile(envFile, { GLM_API_KEY: null })
      s.deps.catalog.invalidate()
    }
  })

  it('a configured key that no pool account holds keeps its own source beside the pool accounts (TAL-548)', async () => {
    const envFile = join(s.state, '.env')
    writeEnvFile(envFile, { DEEPSEEK_API_KEY: 'sk-synthetic-deepseek' })
    sidecar.respond('usage.pool', (params) => ({ entries: params.provider === 'deepseek' ? [{ credential_id: 'ds-other', label: 'other@example.test', status: 'available', unavailable_reason: null, retry_after: null, matches_api_key: false }] : [] }))
    sidecar.respond('usage.balance', () => ({ status: 'ok', http_status: null, quota: null, label: null, is_available: true, balances: [{ currency: 'USD', total: 1, granted: null, topped_up: 1 }], windows: [] }))
    s.deps.catalog.invalidate()
    try {
      const body = await json(await s.get('/api/provider/quotas'))
      const id = (credential: string): string => `qsrc_${createHash('sha256').update(`${String(body.scope_id)}\0deepseek\0${credential}`).digest('hex').slice(0, 32)}`
      const deepseek = (body.sources as Json[]).filter((q) => q.provider_id === 'deepseek').map((q) => [q.source_id, q.account_label, q.status])
      expect(deepseek).toEqual([[id('provider'), 'DeepSeek', 'available'], [id('ds-other'), 'other@example.test', 'available']])
      // The sidecar compares the pool's keys with the configured one; the key itself never comes back.
      expect(sidecar.calls.filter((c) => c.method === 'usage.pool').map((c) => c.params as Json)).toContainEqual(expect.objectContaining({ provider: 'deepseek', api_key: 'sk-synthetic-deepseek' }))
    } finally {
      sidecar.respond('usage.pool', () => ({ entries: [] }))
      writeEnvFile(envFile, { DEEPSEEK_API_KEY: null })
      s.deps.catalog.invalidate()
    }
  })

  it('uniqueQuotaSources keeps the first row per source id and distinct ids of one provider (TAL-272)', () => {
    const row = (source_id: string, provider_id: string, account_label: string, n = 0) => ({ source_id, provider_id, account_label, n })
    expect(uniqueQuotaSources([row('qsrc_c', 'openai-codex', 'Work'), row('qsrc_z', 'anthropic', 'Claude'), row('qsrc_c', 'openai-codex', 'Work', 1), row('qsrc_b', 'openai-codex', 'Personal'), row('qsrc_a', 'openai-codex', 'Work')]))
      .toEqual([row('qsrc_z', 'anthropic', 'Claude'), row('qsrc_b', 'openai-codex', 'Personal'), row('qsrc_a', 'openai-codex', 'Work'), row('qsrc_c', 'openai-codex', 'Work')])
  })

  it('default-model and model/set write config.yaml; auxiliary slots round-trip through /api/model/auxiliary', async () => {
    let res = await post(s, '/api/default-model', { model: '@openrouter:anthropic/claude-opus-4.7', provider: 'auto' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, model: 'anthropic/claude-opus-4.7', provider: 'openrouter' })
    expect(configs.get(s.state)?.model).toEqual({ default: 'anthropic/claude-opus-4.7', provider: 'openrouter' })
    res = await post(s, '/api/model/set', { scope: 'auxiliary', task: 'vision', provider: 'openai', model: '@openai:gpt-4o' })
    expect(await json(res)).toMatchObject({ ok: true, task: 'vision', provider: 'openai', model: 'gpt-4o' })
    res = await post(s, '/api/model/set', { scope: 'auxiliary', task: 'nope', provider: 'auto', model: '' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/model/set', { scope: 'weird' })
    expect(res.status).toBe(400)
    res = await s.get('/api/model/auxiliary')
    const body = await json(res)
    const tasks = body.tasks as { task: string; provider: string; model: string }[]
    expect(tasks.find((t) => t.task === 'vision')).toMatchObject({ provider: 'openai', model: 'gpt-4o' })
    expect(tasks).toHaveLength(11)
    expect(body.main).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-opus-4.7', api_key_set: false })
    res = await post(s, '/api/model/set', { scope: 'main', provider: 'anthropic', model: 'claude-sonnet-4-6' })
    expect(await json(res)).toEqual({ ok: true, model: 'claude-sonnet-4-6', provider: 'anthropic' })
    // Python `_get_provider_base_url`: a `@provider:` pick carries `providers.<id>.base_url` into the model block.
    configs.set(s.state, { ...(configs.get(s.state) ?? {}), providers: { ...(dictOf(configs.get(s.state)?.providers)), lmstudio: { base_url: 'http://localhost:1234/v1/' } } })
    s.deps.agentConfig.invalidate()
    res = await post(s, '/api/default-model', { model: '@lmstudio:qwen3' })
    expect(await json(res)).toEqual({ ok: true, model: 'qwen3', provider: 'lmstudio' })
    expect(configs.get(s.state)?.model).toMatchObject({ default: 'qwen3', provider: 'lmstudio', base_url: 'http://localhost:1234/v1' })
    // A `vendor/model` id under a different configured provider routes through OpenRouter; a matching prefix is stripped.
    res = await post(s, '/api/default-model', { model: 'anthropic/claude-opus-4.7' })
    expect(await json(res)).toEqual({ ok: true, model: 'anthropic/claude-opus-4.7', provider: 'openrouter' })
    res = await post(s, '/api/default-model', { model: 'openrouter/free' })
    expect(await json(res)).toEqual({ ok: true, model: 'openrouter/free', provider: 'openrouter' })
    res = await post(s, '/api/model/set', { scope: 'main', provider: 'anthropic', model: 'claude-sonnet-4-6' })
    res = await post(s, '/api/default-model', { model: 'anthropic/claude-opus-4.6' })
    expect(await json(res)).toEqual({ ok: true, model: 'claude-opus-4.6', provider: 'anthropic' })
    res = await post(s, '/api/model/set', { scope: 'main', provider: 'anthropic', model: 'claude-sonnet-4-6' })
    expect(res.status).toBe(200)
    res = await post(s, '/api/model/set', { scope: 'auxiliary', task: '__reset__', provider: 'auto', model: '' })
    expect(res.status).toBe(200)
    expect((configs.get(s.state)?.auxiliary as Json).vision).toEqual({ provider: 'auto', model: '' })
  })

  it('auxiliary slots are typed, server-matched against the catalog, written one at a time, and profile-scoped (TAL-388)', async () => {
    const saved = configs.get(s.state)
    const reset = (config: Json): void => { configs.set(s.state, config); s.deps.agentConfig.invalidate(); s.deps.catalog.invalidate() }
    interface Task { task: string; provider: string; model: string; is_auto: boolean; value_label: string | null; provider_label: string | null; selected_option_id: string | null; in_catalog: boolean }
    const tasksOf = (body: Json): Task[] => body.tasks as Task[]
    const read = async (headers: Record<string, string> = {}): Promise<Task[]> => tasksOf(await json(await s.get('/api/model/auxiliary', { headers })))
    // Two custom providers list the same bare model id; only the saved provider's entry may match.
    reset({
      model: { default: 'claude-sonnet-4-6', provider: 'anthropic' },
      custom_providers: [{ name: 'alpha', base_url: 'http://alpha.test/v1', model: 'llama3' }, { name: 'beta', base_url: 'http://beta.test/v1/', model: 'llama3' }],
      auxiliary: { vision: { provider: 'openrouter', model: 'legacy/gone-model' } },
    })
    const profileHome = join(s.state, 'profiles', 'auxp')
    try {
      const groups = (await json(await s.get('/api/models'))).groups as { provider: string; provider_id: string; models: { id: string; label: string }[] }[]
      const beta = groups.find((g) => g.provider_id === 'custom:beta')!
      const alpha = groups.find((g) => g.provider_id === 'custom:alpha')!
      const betaOption = beta.models[0]!
      expect(alpha.models[0]!.id).not.toBe(betaOption.id)
      const mainOption = groups.find((g) => g.provider_id === 'anthropic')!.models.find((m) => m.id.endsWith('claude-sonnet-4-6'))!

      // Read: server order, Auto, and a saved model the catalog no longer lists stay explicit.
      let tasks = await read()
      expect(tasks.map((t) => t.task)).toEqual(['vision', 'web_extract', 'compression', 'approval', 'mcp', 'title_generation', 'skills_hub', 'curator', 'kanban_decomposer', 'profile_describer', 'triage_specifier'])
      expect(tasks.find((t) => t.task === 'title_generation')).toMatchObject({ label: 'Title generation', provider: 'auto', model: '', is_auto: true, value_label: mainOption.label, provider_label: 'Anthropic', selected_option_id: null, in_catalog: true })
      expect(tasks.find((t) => t.task === 'vision')).toMatchObject({ is_auto: false, value_label: 'legacy/gone-model', provider_label: 'OpenRouter', selected_option_id: null, in_catalog: false })
      // Auto names the effective main model, including an environment override the config section does not hold.
      const otherOption = groups.find((g) => g.provider_id === 'anthropic')!.models.find((m) => !m.id.startsWith('@') && m.id !== 'claude-sonnet-4-6')!
      s.deps.config.env.HERMES_MODEL = otherOption.id
      s.deps.catalog.invalidate()
      try {
        expect((await read()).find((t) => t.task === 'title_generation')).toMatchObject({ is_auto: true, value_label: otherOption.label, provider_label: 'Anthropic' })
      } finally {
        Reflect.deleteProperty(s.deps.config.env, 'HERMES_MODEL')
        s.deps.catalog.invalidate()
      }

      // Write one task with the picked catalog id: it answers the refreshed state and ticks exactly the beta entry.
      let res = await post(s, '/api/model/set', { scope: 'auxiliary', task: 'title_generation', provider: beta.provider_id, model: betaOption.id })
      expect(res.status).toBe(200)
      let body = await json(res)
      expect(body).toMatchObject({ ok: true, task: 'title_generation', provider: 'custom:beta', model: 'llama3' })
      const title = tasksOf(dictOf(body.auxiliary)).find((t) => t.task === 'title_generation')
      expect(title).toMatchObject({ is_auto: false, value_label: betaOption.label, provider_label: beta.provider, selected_option_id: betaOption.id, in_catalog: true })
      expect((configs.get(s.state)?.auxiliary as Json).title_generation).toEqual({ provider: 'custom:beta', model: 'llama3', base_url: 'http://beta.test/v1' })
      // The other ten slots and the main model are untouched.
      tasks = await read()
      expect(tasks.filter((t) => t.task !== 'title_generation' && t.task !== 'vision').every((t) => t.is_auto)).toBe(true)
      expect(tasks.find((t) => t.task === 'vision')).toMatchObject({ provider: 'openrouter', model: 'legacy/gone-model' })
      expect(configs.get(s.state)?.model).toEqual({ default: 'claude-sonnet-4-6', provider: 'anthropic' })

      // Invalid input is rejected without changing saved state.
      const before = JSON.stringify(configs.get(s.state))
      for (const bad of [
        { task: 'nope', provider: 'auto', model: '' },
        { task: 'title_generation', provider: 'openai', model: alpha.models[0]!.id },
        { task: 'title_generation', provider: 'auto', model: '@nocolon' },
        { task: 'title_generation', provider: 'auto', model: '@openai:' },
      ]) {
        res = await post(s, '/api/model/set', { scope: 'auxiliary', ...bad })
        expect(res.status).toBe(400)
      }
      expect(JSON.stringify(configs.get(s.state))).toBe(before)

      // Auto clears the override, including the custom endpoint's base_url.
      body = await json(await post(s, '/api/model/set', { scope: 'auxiliary', task: 'title_generation', provider: 'auto', model: '' }))
      expect(tasksOf(dictOf(body.auxiliary)).find((t) => t.task === 'title_generation')).toMatchObject({ is_auto: true, selected_option_id: null })
      expect((configs.get(s.state)?.auxiliary as Json).title_generation).toEqual({ provider: 'auto', model: '' })

      // Profiles keep separate selections.
      mkdirSync(profileHome, { recursive: true })
      writeFileSync(join(profileHome, 'config.yaml'), '# seed\n')
      configs.set(profileHome, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } })
      sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }, { name: 'auxp', path: profileHome, is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
      s.deps.profiles.invalidate()
      const cookie = ((await post(s, '/api/profile/switch', { name: 'auxp' })).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      res = await post(s, '/api/model/set', { scope: 'auxiliary', task: 'compression', provider: 'anthropic', model: 'claude-opus-4-7' }, { cookie })
      expect(res.status).toBe(200)
      expect((await read({ cookie })).find((t) => t.task === 'compression')).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-7' })
      expect((await read()).find((t) => t.task === 'compression')).toMatchObject({ is_auto: true })
      expect((await read({ cookie })).find((t) => t.task === 'vision')).toMatchObject({ is_auto: true })

      // Reset all returns every slot to Auto.
      body = await json(await post(s, '/api/model/set', { scope: 'auxiliary', task: '__reset__', provider: 'auto', model: '' }))
      expect(tasksOf(dictOf(body.auxiliary)).every((t) => t.is_auto)).toBe(true)
      expect(configs.get(s.state)?.model).toEqual({ default: 'claude-sonnet-4-6', provider: 'anthropic' })
    } finally {
      sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
      s.deps.profiles.invalidate()
      configs.delete(profileHome)
      if (saved) reset(saved)
    }
  })

  it('a renamed root profile (is_default from the Agent) is a root alias for switching, home lookup, and session visibility', async () => {
    sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'kinni', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
    s.deps.profiles.invalidate()
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    let res = await post(s, '/api/profile/switch', { name: 'kinni' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ active: 'kinni', is_default: true })
    expect(s.deps.isRootProfile('kinni')).toBe(true)
    expect(s.deps.profileHome('kinni')).toBe(s.state)
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect(cookie).toMatch(/^hermes_profile=kinni/)
    res = await s.get('/api/profile/active', { headers: { cookie } })
    expect(await json(res)).toMatchObject({ name: 'kinni', is_default: true, path: s.state })
    // Rows tagged `default` stay visible under the alias.
    res = await s.get(`/api/session?session_id=${sid}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(((await json(await s.get('/api/sessions', { headers: { cookie } }))).active_profile)).toBe('kinni')
    sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
    s.deps.profiles.invalidate()
  })

  it('profiles list/active/switch/create/delete go through the sidecar and set the profile cookie', async () => {
    let res = await s.get('/api/profiles')
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.active).toBe('default')
    expect(body.single_profile_mode).toBe(false)
    expect((body.profiles as Json[])[0]).toMatchObject({ name: 'default', is_active: true, is_default: true })
    res = await s.get('/api/profile/active')
    body = await json(res)
    expect(body).toMatchObject({ name: 'default', is_default: true, path: s.state })
    expect(typeof body.default_workspace).toBe('string')
    res = await post(s, '/api/profile/switch', {})
    expect(res.status).toBe(400)
    res = await post(s, '/api/profile/switch', { name: 'ghost' })
    expect(res.status).toBe(404)
    mkdirSync(join(s.state, 'profiles', 'alpha'), { recursive: true })
    sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }, { name: 'alpha', path: join(s.state, 'profiles', 'alpha'), is_default: false, gateway_running: false, model: 'm', provider: 'p', has_env: false, visible: true, skill_count: 1, enabled_skills: 1, total_skills: 2 }] }))
    res = await post(s, '/api/profile/switch', { profile: 'alpha' })
    expect(res.status).toBe(200)
    body = await json(res)
    expect(body.active).toBe('alpha')
    expect(body.is_default).toBe(false)
    expect((body.profiles as Json[]).find((p) => p.name === 'alpha')).toMatchObject({ is_active: true })
    expect(res.headers.get('set-cookie')).toContain('hermes_profile=')
    res = await post(s, '/api/profile/create', { name: 'Bad Name' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/profile/create', { name: 'beta', base_url: 'ftp://x' })
    expect(res.status).toBe(400)
    sidecar.respond('profiles.create', (params) => ({ profile: { name: params.name, path: join(s.state, 'profiles', params.name), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 } }))
    res = await post(s, '/api/profile/create', { name: 'beta', api_key: 'sk-beta-12345', model_provider: 'anthropic', default_model: '@anthropic:claude-sonnet-4-6' })
    expect(res.status).toBe(200)
    body = await json(res)
    expect(body.ok).toBe(true)
    expect(loadEnvFile(join(s.state, 'profiles', 'beta', '.env')).ANTHROPIC_API_KEY).toBe('sk-beta-12345')
    expect(configs.get(join(s.state, 'profiles', 'beta'))?.model).toEqual({ default: 'claude-sonnet-4-6', provider: 'anthropic' })
    res = await post(s, '/api/profile/create', { name: 'gamma', default_model: 'not-a-model', model_provider: 'anthropic' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('not available for provider')
    res = await post(s, '/api/profile/delete', { name: 'default' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/profile/delete', { name: 'beta' })
    expect(await json(res)).toEqual({ ok: true, name: 'beta' })
    expect(sidecar.calls.some((c) => c.method === 'profiles.delete' && (c.params as Json).name === 'beta')).toBe(true)
    // A delete issued while the same profile is still being created waits for the creation (sidecar create and the
    // follow-up config/env writes) to finish, so it removes a fully configured home rather than a half-built one.
    const order: string[] = []
    let finishCreate: () => void = () => undefined
    sidecar.respond('profiles.create', (params) => new Promise((resolve) => { finishCreate = () => { order.push('created'); resolve({ profile: { name: params.name, path: join(s.state, 'profiles', params.name), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 } }) } }))
    sidecar.respond('profiles.delete', (params) => { order.push('deleted'); rmSync(join(s.state, 'profiles', params.name), { recursive: true, force: true }); return { ok: true } })
    const creating = post(s, '/api/profile/create', { name: 'delta', api_key: 'sk-delta-12345', model_provider: 'anthropic', default_model: '@anthropic:claude-sonnet-4-6' })
    await new Promise((r) => setTimeout(r, 50))
    const deleting = post(s, '/api/profile/delete', { name: 'delta' })
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual([])
    finishCreate()
    expect((await creating).status).toBe(200)
    expect(configs.get(join(s.state, 'profiles', 'delta'))?.model).toEqual({ default: 'claude-sonnet-4-6', provider: 'anthropic' })
    expect(await json(await deleting)).toEqual({ ok: true, name: 'delta' })
    expect(order).toEqual(['created', 'deleted'])
    // The deletion tombstone survives a failed recreation: a stale-cookie write is still refused afterwards, and only
    // a fully successful recreation lifts it.
    const deltaCookie = 'hermes_profile=delta'
    sidecar.respond('profiles.create', () => { throw new Error('disk full') })
    expect((await post(s, '/api/profile/create', { name: 'delta' })).status).toBe(400)
    const staleWrite = await post(s, '/api/model/set', { scope: 'main', model: '@anthropic:claude-sonnet-4-6', provider: 'anthropic' }, { cookie: deltaCookie })
    expect(staleWrite.status).toBe(404)
    sidecar.respond('profiles.create', (params) => ({ profile: { name: params.name, path: join(s.state, 'profiles', params.name), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 } }))
    mkdirSync(join(s.state, 'profiles', 'delta'), { recursive: true })
    expect((await post(s, '/api/profile/create', { name: 'delta' })).status).toBe(200)
    expect((await post(s, '/api/model/set', { scope: 'main', model: '@anthropic:claude-sonnet-4-6', provider: 'anthropic' }, { cookie: deltaCookie })).status).toBe(200)
  })

  it('onboarding status reflects config.yaml and the local-origin gate protects setup/complete/probe', async () => {
    let res = await s.get('/api/onboarding/status')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.completed).toBe(true)
    expect(body.settings).toMatchObject({ bot_name: 'Hermes', password_enabled: false })
    expect((body.setup as Json).current).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    expect((body.system as Json).provider_configured).toBe(true)
    expect((body.system as Json).provider_ready).toBe(true)
    expect(((body.setup as Json).providers as Json[]).map((p) => p.id)).toContain('openrouter')
    expect((body.models as Json).active_provider).toBe('anthropic')
    res = await post(s, '/api/onboarding/setup', { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', api_key: 'sk-or-12345' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ error: 'config_exists', requires_confirm: true })
    const envCalls = sidecar.calls.length
    res = await post(s, '/api/onboarding/setup', { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', api_key: 'sk-or-12345', confirm_overwrite: true })
    expect(res.status).toBe(200)
    expect((await json(res)).completed).toBe(true)
    // A root-profile key written by setup reaches the running process and the sidecar like a settings-panel edit.
    expect(sidecar.calls.slice(envCalls).find((c) => c.method === 'runtime.env')?.params).toEqual({ set: { OPENROUTER_API_KEY: 'sk-or-12345' } })
    expect(s.deps.config.env.OPENROUTER_API_KEY).toBe('sk-or-12345')
    delete s.deps.config.env.OPENROUTER_API_KEY
    delete s.deps.config.env.HERMES_WEBUI_HOME_DOTENV_KEYS
    expect(configs.get(s.state)?.model).toEqual({ default: 'anthropic/claude-sonnet-4.6', provider: 'openrouter' })
    res = await post(s, '/api/onboarding/setup', { provider: 'custom', model: 'x' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/onboarding/setup', { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6', confirm_overwrite: true }, { 'x-forwarded-for': '203.0.113.9' })
    // Loopback peer with an (ignored) forwarded header stays local.
    expect(res.status).toBe(200)
    res = await post(s, '/api/onboarding/probe', { provider: 'custom', base_url: 'notaurl' })
    expect(await json(res)).toMatchObject({ ok: false, error: 'invalid_url' })
    res = await post(s, '/api/onboarding/probe', { provider: 'custom', base_url: `http://127.0.0.1:${String(await closedPort())}/v1` })
    expect(await json(res)).toMatchObject({ ok: false, error: 'connect_refused' })
    res = await post(s, '/api/onboarding/complete', {})
    expect((await json(res)).completed).toBe(true)
  })

  it('the auth-off local gate treats CGNAT/Tailscale peers as remote and private LANs as local', async () => {
    s.deps.config.env.HERMES_WEBUI_TRUST_FORWARDED_FOR = '1'
    try {
      // Past the gate, a probe without a URL answers invalid_url and a terminal start without a session answers 400.
      const gate = async (ip?: string): Promise<number[]> => {
        const headers: Record<string, string> = ip ? { 'x-forwarded-for': ip } : {}
        return [(await post(s, '/api/onboarding/probe', { provider: 'custom', base_url: 'notaurl' }, headers)).status, (await post(s, '/api/terminal/start', {}, headers)).status]
      }
      for (const ip of ['100.64.1.2', '100.100.100.100', '100.127.255.254', '::ffff:100.64.1.2', 'fd7a:115c:a1e0::1', '8.8.8.8']) expect(await gate(ip), ip).toEqual([403, 403])
      for (const ip of [undefined, '127.0.0.1', '::1', '192.168.1.10', '10.1.2.3', '172.16.0.1', '169.254.1.1', 'fd12::1', 'fe80::1', '::ffff:192.168.1.10']) expect(await gate(ip), String(ip)).toEqual([200, 400])
    } finally {
      delete s.deps.config.env.HERMES_WEBUI_TRUST_FORWARDED_FOR
    }
  })

  it('onboarding OAuth runs the device flow through the sidecar: success, expiry, denial and cancel', async () => {
    // Synthetic flows: each flow id answers its scripted statuses in order; nothing reaches a real provider or credential.
    const scripts = new Map<string, { provider: string; statuses: string[]; error?: string }>([
      ['flow-ok', { provider: 'openai-codex', statuses: ['pending', 'approved'] }],
      ['flow-late', { provider: 'nous', statuses: ['expired'], error: 'The sign-in code expired before it was approved.' }],
      ['flow-no', { provider: 'xai-oauth', statuses: ['denied'], error: 'Sign-in was declined.' }],
      ['flow-stop', { provider: 'minimax-oauth', statuses: ['pending'] }],
    ])
    const order = ['flow-ok', 'flow-late', 'flow-no', 'flow-stop']
    sidecar.respond('oauth.start', (params) => {
      const flowId = order.shift()!
      expect(scripts.get(flowId)?.provider).toBe(params.provider)
      return { flow_id: flowId, provider: params.provider, status: 'pending', user_code: `CODE-${flowId}`, verification_url: `https://auth.example.test/device?flow=${flowId}`, expires_in: 900, interval: 5 }
    })
    sidecar.respond('oauth.poll', (params) => {
      const script = scripts.get(params.flow_id)!
      const status = (script.statuses.length > 1 ? script.statuses.shift()! : script.statuses[0]!) as SidecarResult<'oauth.poll'>['status']
      return { flow_id: params.flow_id, provider: script.provider, status, error: status === 'expired' || status === 'denied' ? script.error ?? null : null }
    })
    sidecar.respond('oauth.cancel', (params) => {
      scripts.get(params.flow_id)!.statuses = ['cancelled']
      return { flow_id: params.flow_id, provider: scripts.get(params.flow_id)!.provider, status: 'cancelled', error: null }
    })
    const poll = async (flowId: string): Promise<Json> => json(await s.get(`/api/onboarding/oauth/poll?flow_id=${flowId}`))

    // Success: the start answers the code to show, polling reports pending, then approved.
    let res = await post(s, '/api/onboarding/oauth/start', { provider: 'openai-codex' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, status: 'pending', provider: 'openai-codex', flow_id: 'flow-ok', user_code: 'CODE-flow-ok', verification_url: 'https://auth.example.test/device?flow=flow-ok', expires_in: 900, interval: 5 })
    expect(sidecar.calls.filter((c) => c.method === 'oauth.start').at(-1)?.params).toEqual({ profile_home: s.state, provider: 'openai-codex' })
    expect(await poll('flow-ok')).toMatchObject({ ok: true, status: 'pending', flow_id: 'flow-ok' })
    expect(await poll('flow-ok')).toMatchObject({ ok: true, status: 'approved', flow_id: 'flow-ok', provider: 'openai-codex' })
    expect(sidecar.calls.filter((c) => c.method === 'oauth.poll').at(-1)?.params).toEqual({ profile_home: s.state, flow_id: 'flow-ok' })

    // Expiry and denial end the flow with the Agent's reason.
    expect((await post(s, '/api/onboarding/oauth/start', { provider: 'nous' })).status).toBe(200)
    expect(await poll('flow-late')).toMatchObject({ ok: false, status: 'expired', error: 'The sign-in code expired before it was approved.' })
    expect((await post(s, '/api/onboarding/oauth/start', { provider: 'xai-oauth' })).status).toBe(200)
    expect(await poll('flow-no')).toMatchObject({ ok: false, status: 'denied', error: 'Sign-in was declined.' })

    // Cancel stops the flow; a later poll reports it cancelled.
    expect((await post(s, '/api/onboarding/oauth/start', { provider: 'minimax-oauth' })).status).toBe(200)
    res = await post(s, '/api/onboarding/oauth/cancel', { flow_id: 'flow-stop' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, status: 'cancelled', flow_id: 'flow-stop' })
    expect(sidecar.calls.filter((c) => c.method === 'oauth.cancel').at(-1)?.params).toEqual({ profile_home: s.state, flow_id: 'flow-stop' })
    expect(await poll('flow-stop')).toMatchObject({ ok: false, status: 'cancelled' })

    // Only device-flow providers start; a flow id is required to poll or cancel.
    const starts = sidecar.calls.filter((c) => c.method === 'oauth.start').length
    expect((await post(s, '/api/onboarding/oauth/start', { provider: 'anthropic' })).status).toBe(400)
    expect((await post(s, '/api/onboarding/oauth/start', {})).status).toBe(400)
    expect(sidecar.calls.filter((c) => c.method === 'oauth.start')).toHaveLength(starts)
    expect((await s.get('/api/onboarding/oauth/poll')).status).toBe(400)
    expect((await post(s, '/api/onboarding/oauth/cancel', {})).status).toBe(400)

    // The onboarding gate still applies to every OAuth route: a remote client without the opt-in is refused.
    s.deps.config.env.HERMES_WEBUI_TRUST_FORWARDED_FOR = '1'
    try {
      // A global address is remote.
      const remote = { 'x-forwarded-for': '8.8.8.8' }
      expect((await post(s, '/api/onboarding/oauth/start', { provider: 'openai-codex' }, remote)).status).toBe(403)
      expect((await s.get('/api/onboarding/oauth/poll?flow_id=flow-ok', { headers: remote })).status).toBe(403)
      expect((await post(s, '/api/onboarding/oauth/cancel', { flow_id: 'flow-ok' }, remote)).status).toBe(403)
      expect(sidecar.calls.filter((c) => c.method === 'oauth.start')).toHaveLength(starts)
      s.deps.config.env.HERMES_WEBUI_ONBOARDING_OPEN = '1'
      expect((await s.get('/api/onboarding/oauth/poll?flow_id=flow-ok', { headers: remote })).status).toBe(200)
    } finally {
      delete s.deps.config.env.HERMES_WEBUI_TRUST_FORWARDED_FOR
      delete s.deps.config.env.HERMES_WEBUI_ONBOARDING_OPEN
    }
  })

  it('the onboarding wizard lists device-code sign-ins and saves one only after the Agent stored its credential', async () => {
    const providers = ((await json(await s.get('/api/onboarding/status'))).setup as Json).providers as Json[]
    expect(providers.filter((p) => p.oauth_flow === 'device_code').map((p) => p.id).sort()).toEqual(['minimax-oauth', 'nous', 'openai-codex', 'xai-oauth'])
    expect(providers.find((p) => p.id === 'openrouter')?.oauth_flow).toBeNull()
    expect(providers.find((p) => p.id === 'openai-codex')?.signed_in).toBe(false)
    expect(providers.find((p) => p.id === 'openrouter')).not.toHaveProperty('signed_in')
    // Every sign-in provider is an OAuth provider the catalog knows, so an approval brings its model group.
    const catalog = (await json(await s.get('/api/providers'))).providers as Json[]
    for (const id of ['minimax-oauth', 'nous', 'openai-codex', 'xai-oauth']) expect(catalog.find((p) => p.id === id), id).toMatchObject({ is_oauth: true })
    const authPath = join(s.state, 'auth.json')
    const savedAuth = existsSync(authPath) ? readFileSync(authPath, 'utf8') : null
    try {
      let res = await post(s, '/api/onboarding/setup', { provider: 'openai-codex', model: 'gpt-5.5', api_key: 'sk-ignored-12345', confirm_overwrite: true })
      expect(res.status).toBe(400)
      expect((await json(res)).error).toBe('Sign in to ChatGPT before continuing.')
      // A synthetic credential in the profile's own auth store, as the Agent writes it after an approved flow.
      writeFileSync(authPath, JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } } } }))
      const envCalls = sidecar.calls.length
      res = await post(s, '/api/onboarding/setup', { provider: 'openai-codex', model: 'gpt-5.5', api_key: 'sk-ignored-12345', confirm_overwrite: true })
      expect(res.status).toBe(200)
      expect(configs.get(s.state)?.model).toEqual({ default: 'gpt-5.5', provider: 'openai-codex' })
      const saved = await json(res)
      // A picker id from the model list is saved as its bare model; one for another provider is refused.
      expect((await post(s, '/api/onboarding/setup', { provider: 'openai-codex', model: '@openai-codex:gpt-5.4', confirm_overwrite: true })).status).toBe(200)
      expect(configs.get(s.state)?.model).toEqual({ default: 'gpt-5.4', provider: 'openai-codex' })
      res = await post(s, '/api/onboarding/setup', { provider: 'openai-codex', model: '@nous:anthropic/claude-sonnet-4.6', confirm_overwrite: true })
      expect(res.status).toBe(400)
      expect(configs.get(s.state)?.model).toEqual({ default: 'gpt-5.4', provider: 'openai-codex' })
      expect(((saved.setup as Json).providers as Json[]).find((p) => p.id === 'openai-codex')?.signed_in).toBe(true)
      expect(saved.system).toMatchObject({ provider_ready: true })
      // No API key is written for a sign-in provider.
      expect(sidecar.calls.slice(envCalls).some((c) => c.method === 'runtime.env')).toBe(false)
      rmSync(authPath)
      const system = (await json(await s.get('/api/onboarding/status'))).system as Json
      expect(system).toMatchObject({ provider_ready: false, provider_note_key: 'onboarding_notice_provider_sign_in_required', provider_note: 'Hermes has a saved provider/model selection but still needs you to sign in to ChatGPT.' })
    } finally {
      if (savedAuth === null) rmSync(authPath, { force: true })
      else writeFileSync(authPath, savedAuth)
      configs.set(s.state, { ...configs.get(s.state), model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } })
    }
  })

  it('a sidecar that cannot start the flow answers its reason, and no sidecar is a 503', async () => {
    sidecar.respond('oauth.start', () => { throw new SidecarError('OpenAI rejected the device-code login request.', { condition: 'oauth_failed' }) })
    let res = await post(s, '/api/onboarding/oauth/start', { provider: 'openai-codex' })
    expect(res.status).toBe(502)
    expect((await json(res)).error).toBe('OpenAI rejected the device-code login request.')
    sidecar.respond('oauth.poll', () => { throw new SidecarError('Unknown or expired sign-in.', { condition: 'oauth_flow_not_found' }) })
    res = await s.get('/api/onboarding/oauth/poll?flow_id=gone')
    expect(res.status).toBe(404)
    sidecar.respond('oauth.start', () => { throw new SidecarError('This profile uses the Nous free tier. Sign in from Hermes with `hermes portal`.', { condition: 'oauth_unsupported' }) })
    expect((await post(s, '/api/onboarding/oauth/start', { provider: 'nous' })).status).toBe(409)
    const previous = sidecar.status
    sidecar.status = 'stopped'
    try {
      expect((await post(s, '/api/onboarding/oauth/start', { provider: 'openai-codex' })).status).toBe(503)
    } finally {
      sidecar.status = previous
    }
  })

  it('providers/self-hosted writes the provider block and activates the model', async () => {
    const endpoint = createHttpServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'qwen3' }] } : {})) })
    await new Promise<void>((resolve) => { endpoint.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${String((endpoint.address() as { port: number }).port)}/v1`
    try {
      const res = await post(s, '/api/providers/self-hosted', { provider: 'lmstudio', model: 'qwen3', base_url: `${url}/`, api_key: 'lm-key-12345' })
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ ok: true, provider: 'lmstudio', base_url: url, model: 'qwen3' })
      expect((configs.get(s.state)?.providers as Json).lmstudio).toEqual({ base_url: url })
      expect(configs.get(s.state)?.model).toMatchObject({ provider: 'lmstudio', default: 'qwen3', base_url: url })
      expect(loadEnvFile(join(s.state, '.env')).LM_API_KEY).toBe('lm-key-12345')
    } finally {
      endpoint.close()
    }
    const bad = await post(s, '/api/providers/self-hosted', { provider: 'openai', model: 'x' })
    expect(bad.status).toBe(400)
  })

  it('providers/self-hosted refuses an endpoint that does not answer and keeps the working default (TAL-570)', async () => {
    const before = structuredClone(configs.get(s.state))
    const res = await post(s, '/api/providers/self-hosted', { provider: 'ollama', model: 'llama3.2', base_url: `http://127.0.0.1:${String(await closedPort())}/v1` })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toMatch(/connection refused/)
    expect(configs.get(s.state)).toEqual(before)
  })
})

async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

async function csrfFor(s: TestServer, cookie: string): Promise<string> {
  const res = await s.get('/api/bootstrap', { headers: { cookie } })
  const token = ((await res.json()) as Json).csrf_token
  return typeof token === 'string' ? token : ''
}

describe('provider quota windows carry server-computed pace (TAL-409)', () => {
  const NOW = Date.parse('2026-09-28T08:00:00Z') / 1000
  const FIXTURE = join(import.meta.dirname, '../../../../../contracts/fixtures/provider-quotas.json')
  let s: TestServer
  beforeAll(async () => {
    const sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => NOW })
    const configs = fakeConfigStore(sidecar)
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    configs.set(s.state, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' }, providers: { anthropic: { api_key: 'sk-ant-api03-synthetic-quota-test-key' } } })
    writeFileSync(join(s.state, '.quota_scope_id'), `${'0'.repeat(31)}1\n`)
    sidecar.respond('providers.model_ids', (params) => ({ provider: params.provider, model_ids: [] }))
    sidecar.respond('providers.auth_status', (params) => ({ status: { logged_in: false, provider: params.provider ?? '', error: 'not logged in' } }))
    // The pre-TAL-409 sidecar's `str(datetime)` form, a blank-label window, a 5h session, a weekly and a monthly window.
    sidecar.respond('usage.account', (params) => ({ snapshot: { provider: params.provider, available: true, title: 'Claude limits', plan: 'max', fetched_at: '2026-09-28 07:59:30+00:00', details: [], windows: [
      { label: '  ', used_percent: 50, reset_at: '2026-09-28 09:00:00+00:00' },
      { label: ' Session ', used_percent: 10, reset_at: '2026-09-28 12:00:00+00:00', detail: null },
      { label: 'Weekly', used_percent: 32, reset_at: '2026-10-03 08:00:00+00:00' },
      { label: 'Monthly', used_percent: 5, reset_at: '2026-10-15T00:00:00Z' },
    ] } }))
  })
  afterAll(() => s.close())

  const session = {
    label: 'Session', used_percent: 10, remaining_percent: 90, reset_at: '2026-09-28T12:00:00Z', detail: null, window_seconds: 18_000,
    pace: { expected_remaining_percent: 80, pace_delta_percent: 10, burn_rate: 0.5, minutes_to_reset: 240, projected_minutes_to_empty: 540, elapsed_minutes: 60, valid_until: '2026-09-28T12:00:00Z' },
    forecast: { outcome: 'safe', budget_unit: 'hour', budget_percent: 22.5, depletion_margin_minutes: 300 },
  }
  const weekly = {
    label: 'Weekly', used_percent: 32, remaining_percent: 68, reset_at: '2026-10-03T08:00:00Z', detail: null, window_seconds: 604_800,
    pace: { expected_remaining_percent: 71.4, pace_delta_percent: -3.4, burn_rate: 1.12, minutes_to_reset: 7200, projected_minutes_to_empty: 6120, elapsed_minutes: 2880, valid_until: '2026-10-03T08:00:00Z' },
    forecast: { outcome: 'warning', budget_unit: 'day', budget_percent: 13.6, depletion_margin_minutes: -1080 },
  }
  const monthly = { label: 'Monthly', used_percent: 5, remaining_percent: 95, reset_at: '2026-10-15T00:00:00Z', detail: null, window_seconds: null, pace: null, forecast: null }

  it('both quota endpoints normalise windows and ship pace, forecast, window indexes and computed_at', async () => {
    const quotas = await json(await s.get('/api/provider/quotas'))
    const anthropic = (quotas.sources as Json[]).find((q) => q.provider_id === 'anthropic')
    // TAL-411 classifies the quotas windows at the default thresholds; the singular route's are unclassified.
    expect(anthropic?.windows).toEqual([
      { ...session, pace: { ...session.pace, status: 'under' }, projection_eligible: false, urgency: { remaining: 'healthy', pace: 'healthy' } },
      { ...weekly, pace: { ...weekly.pace, status: 'over' }, projection_eligible: true, urgency: { remaining: 'healthy', pace: 'warning' } },
      { ...monthly, projection_eligible: false, urgency: { remaining: 'healthy', pace: 'healthy' } },
    ])
    expect(anthropic).toMatchObject({ urgency: { remaining: 'healthy', pace: 'warning' }, pace_window_index: 1, session_window_index: 0, weekly_window_index: 1, fetched_at: '2026-09-28T07:59:30Z' })
    expect(quotas.computed_at).toBe('2026-09-28T08:00:00Z')

    const quota = await json(await s.get('/api/provider/quota?provider=anthropic'))
    expect(quota.computed_at).toBe('2026-09-28T08:00:00Z')
    expect(quota.account_limits).toMatchObject({ windows: [session, weekly, monthly], pace_window_index: 1, session_window_index: 0, weekly_window_index: 1 })
    // Every branch of the singular route answers its contract: account usage, a keyless OpenRouter, an unsupported provider.
    for (const provider of ['anthropic', 'openrouter', 'zai']) {
      const res = await s.get(`/api/provider/quota?provider=${provider}`)
      expect(res.status).toBe(200)
      expect(ProviderQuotaSchema.safeParse(await res.json()).success).toBe(true)
    }

    // The shared fixture the App and Web decode is this exact response (`RECORD_TAL409=1` rewrites it).
    if (process.env.RECORD_TAL409) writeFileSync(FIXTURE, `${JSON.stringify(quotas, null, 2)}\n`)
    expect(quotas).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })

  it('urgency, projection eligibility and pace status follow the profile thresholds saved through /api/settings (TAL-411)', async () => {
    const DEFAULTS = { warning_remaining_percent: 25, critical_remaining_percent: 10, pace_tolerance_percent: 3, pace_warning_burn_rate_percent: 125, pace_critical_burn_rate_percent: 175, pace_minimum_elapsed_hours: 12 }
    const classified = async () => {
      const source = ((await json(await s.get('/api/provider/quotas'))).sources as Json[]).find((q) => q.provider_id === 'anthropic')!
      return { urgency: source.urgency, windows: (source.windows as Json[]).map((w) => [w.projection_eligible, w.urgency, w.pace === null ? null : dictOf(w.pace).status]) }
    }
    // Session: 10% used, 1h into its 5h window. Weekly: 32% used, 3.4 points over pace at a 1.12x burn. Monthly: no pace.
    expect(await classified()).toEqual({ urgency: { remaining: 'healthy', pace: 'warning' }, windows: [
      [false, { remaining: 'healthy', pace: 'healthy' }, 'under'],
      [true, { remaining: 'healthy', pace: 'warning' }, 'over'],
      [false, { remaining: 'healthy', pace: 'healthy' }, null],
    ] })
    expect(dictOf(await json(await s.get('/api/settings'))).provider_quota_thresholds).toEqual(DEFAULTS)

    // Critical clamps to at most warning; an out-of-range value keeps the stored one.
    const saved = await json(await post(s, '/api/settings', { provider_quota_thresholds: { warning_remaining_percent: 95, critical_remaining_percent: 99, pace_tolerance_percent: 4, pace_minimum_elapsed_hours: 500 } }))
    const changed = { ...DEFAULTS, warning_remaining_percent: 95, critical_remaining_percent: 95, pace_tolerance_percent: 4 }
    expect(saved.provider_quota_thresholds).toEqual(changed)
    expect(dictOf(await json(await s.get('/api/settings'))).provider_quota_thresholds).toEqual(changed)
    expect(await classified()).toEqual({ urgency: { remaining: 'critical', pace: 'healthy' }, windows: [
      [false, { remaining: 'critical', pace: 'healthy' }, 'under'],
      [true, { remaining: 'critical', pace: 'healthy' }, 'on'],
      [false, { remaining: 'critical', pace: 'critical' }, null],
    ] })

    await post(s, '/api/settings', { provider_quota_thresholds: DEFAULTS })
    expect((await classified()).urgency).toEqual({ remaining: 'healthy', pace: 'warning' })
  })
})

describe('OpenRouter cost history accrues on quota reads and ships server-computed pace (TAL-412)', () => {
  const NOW = Date.parse('2026-09-28T08:00:00Z') / 1000
  let s: TestServer
  let usage: number | null = 2.52
  let keyAvailable = true
  let snapshotFile = ''
  let configs: Map<string, Json>
  const seed = (snapshots: { date: string; used: number | null }[]): void => { mkdirSync(join(s.state, 'cost-snapshots'), { recursive: true }); writeFileSync(snapshotFile, JSON.stringify({ provider: 'openrouter', snapshots: snapshots.map((e) => ({ ...e, limit: null })) })) }
  const stored = (): { date: string; used: number | null }[] => (JSON.parse(readFileSync(snapshotFile, 'utf8')) as { snapshots: { date: string; used: number | null }[] }).snapshots
  const history = async (): Promise<Json> => json(await s.get('/api/provider/cost-history?provider=openrouter'))
  beforeAll(async () => {
    const sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => NOW })
    snapshotFile = join(s.state, 'cost-snapshots', 'openrouter.json')
    configs = fakeConfigStore(sidecar)
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    configs.set(s.state, { model: { default: 'anthropic/claude-sonnet-4.6', provider: 'openrouter' } })
    writeEnvFile(join(s.state, '.env'), { OPENROUTER_API_KEY: 'sk-or-synthetic-cost-history-1234' })
    sidecar.respond('providers.model_ids', (params) => ({ provider: params.provider, model_ids: [] }))
    sidecar.respond('providers.auth_status', (params) => ({ status: { logged_in: false, provider: params.provider ?? '', error: 'not logged in' } }))
    // The sidecar reads OpenRouter's key endpoint (TAL-548); `configuredDown` fails only the configured key's own read.
    sidecar.respond('usage.balance', (params) => {
      const ok = keyAvailable && !(configuredDown && !params.credential_id)
      return { status: ok ? 'ok' : 'http_error', http_status: ok ? null : 503, quota: ok ? { usage, limit: 100, limit_remaining: 50 } : null, label: ok ? 'synthetic' : null, is_available: null, balances: [], windows: [] }
    })
    sidecar.respond('usage.pool', (params) => ({ entries: params.provider === 'openrouter' ? pool : [] }))
  })
  let pool: SidecarResult<'usage.pool'>['entries'] = []
  let configuredDown = false
  afterAll(() => s.close())

  it('a quota read records today\'s snapshot, so cost history shows it without being called first', async () => {
    seed([{ date: '2026-09-27', used: 1.5 }])
    usage = 2.52
    expect((await json(await s.get('/api/provider/quota?provider=openrouter'))).status).toBe('available')
    expect(stored()).toEqual([{ date: '2026-09-27', used: 1.5, limit: null }, { date: '2026-09-28', used: 2.52, limit: 100 }])
    // The batched route updates the same day's snapshot in place.
    usage = 3
    const quotas = await json(await s.get('/api/provider/quotas'))
    expect((quotas.sources as Json[]).find((q) => q.provider_id === 'openrouter')).toMatchObject({ status: 'available' })
    expect(stored().at(-1)).toEqual({ date: '2026-09-28', used: 3, limit: 100 })
    // An unavailable key endpoint writes nothing, yet history still shows the snapshot the quota reads recorded.
    keyAvailable = false
    try {
      expect(await history()).toMatchObject({ status: 'unavailable', snapshots: [{ date: '2026-09-27', used: 1.5, delta: null, bar_percent: 0 }, { date: '2026-09-28', used: 3, delta: 1.5, bar_percent: 100 }], monthly_pace: 45, has_enough_data: true })
    } finally {
      keyAvailable = true
    }
  })

  it('a pooled OpenRouter account records the cost snapshot only when it is the configured key (TAL-548)', async () => {
    const account = { credential_id: 'or-1', label: 'work@example.test', status: 'available' as const, unavailable_reason: null, retry_after: null }
    try {
      // Another account's read records nothing; the configured key's own source is the one that would.
      rmSync(snapshotFile, { force: true })
      pool = [{ ...account, matches_api_key: false }]
      configuredDown = true
      usage = 4
      let sources = ((await json(await s.get('/api/provider/quotas'))).sources as Json[]).filter((q) => q.provider_id === 'openrouter')
      expect(sources.map((q) => [q.account_label, q.status])).toEqual([['OpenRouter', 'unavailable'], ['work@example.test', 'available']])
      expect(existsSync(snapshotFile)).toBe(false)
      // The account holding the configured key is its only source, and its read records the snapshot.
      pool = [{ ...account, matches_api_key: true }]
      configuredDown = false
      sources = ((await json(await s.get('/api/provider/quotas'))).sources as Json[]).filter((q) => q.provider_id === 'openrouter')
      expect(sources).toEqual([expect.objectContaining({ account_label: 'work@example.test', status: 'available', quota: { usage: 4, limit: 100, limit_remaining: 50 } })])
      expect(stored()).toEqual([{ date: '2026-09-28', used: 4, limit: 100 }])
    } finally {
      pool = []
      configuredDown = false
      usage = 2.52
    }
  })

  it('pace, budget percent and level, and bar heights follow the legacy formulas', async () => {
    // A null `used` breaks two deltas, a drop resets the delta to `used`, and a tiny positive delta takes the 2% floor.
    seed([{ date: '2026-09-22', used: 10 }, { date: '2026-09-23', used: null }, { date: '2026-09-24', used: 11 }, { date: '2026-09-25', used: 13 }, { date: '2026-09-26', used: 0.5 }, { date: '2026-09-27', used: 0.52 }])
    usage = 2.52
    await post(s, '/api/settings', { provider_cost_budget: null })
    const body = await history()
    expect(body).toMatchObject({ ok: true, status: 'available', window_days: 7, monthly_budget: null, monthly_pace: 33.9, has_enough_data: true, budget_percent: null, budget_level: null })
    expect(body.snapshots).toEqual([
      { date: '2026-09-22', used: 10, delta: null, bar_percent: 0 },
      { date: '2026-09-23', used: null, delta: null, bar_percent: 0 },
      { date: '2026-09-24', used: 11, delta: null, bar_percent: 0 },
      { date: '2026-09-25', used: 13, delta: 2, bar_percent: 100 },
      { date: '2026-09-26', used: 0.5, delta: 0.5, bar_percent: 25 },
      { date: '2026-09-27', used: 0.52, delta: 0.02, bar_percent: 2 },
      { date: '2026-09-28', used: 2.52, delta: 2, bar_percent: 100 },
    ])
    // round(33.9 / budget × 100): 79 is ok, 80 starts warn, 99 is still warn, 100 is over.
    for (const [budget, percent, level] of [[42.91, 79, 'ok'], [42.37, 80, 'warn'], [34.24, 99, 'warn'], [33.9, 100, 'over']] as const) {
      await post(s, '/api/settings', { provider_cost_budget: budget })
      expect(await history()).toMatchObject({ monthly_budget: budget, monthly_pace: 33.9, budget_percent: percent, budget_level: level })
    }
    // The live fixture the Web contract test parses is this exact response.
    await post(s, '/api/settings', { provider_cost_budget: 42.37 })
    expect(await history()).toEqual((JSON.parse(readFileSync(join(import.meta.dirname, '../../../frontend/src/contracts/__fixtures__/live/provider_cost_history.json'), 'utf8')) as { body: unknown }).body)
    await post(s, '/api/settings', { provider_cost_budget: null })
  })

  it('a single snapshot has no delta, so there is no pace, budget percent, or level', async () => {
    rmSync(snapshotFile, { force: true })
    await post(s, '/api/settings', { provider_cost_budget: 50 })
    await s.get('/api/provider/quota?provider=openrouter')
    expect(await history()).toMatchObject({ monthly_budget: 50, snapshots: [{ date: '2026-09-28', used: 2.52, delta: null, bar_percent: 0 }], monthly_pace: null, has_enough_data: false, budget_percent: null, budget_level: null })
    await post(s, '/api/settings', { provider_cost_budget: null })
  })

  it('a key stored as config.yaml model.api_key or under a provider alias records and shows history too', async () => {
    const envFile = join(s.state, '.env')
    writeEnvFile(envFile, { OPENROUTER_API_KEY: null })
    try {
      for (const config of [{ model: { default: 'anthropic/claude-sonnet-4.6', provider: 'openrouter', api_key: 'sk-or-synthetic-model-key-1234' } }, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' }, providers: { OpenRouter: { api_key: 'sk-or-synthetic-alias-key-1234' } } }]) {
        configs.set(s.state, config)
        s.deps.agentConfig.invalidate()
        s.deps.catalog.invalidate()
        rmSync(snapshotFile, { force: true })
        expect((await json(await s.get('/api/provider/quota?provider=openrouter'))).status).toBe('available')
        expect(stored()).toEqual([{ date: '2026-09-28', used: 2.52, limit: 100 }])
        expect(await history()).toMatchObject({ ok: true, status: 'available' })
      }
    } finally {
      writeEnvFile(envFile, { OPENROUTER_API_KEY: 'sk-or-synthetic-cost-history-1234' })
      configs.set(s.state, { model: { default: 'anthropic/claude-sonnet-4.6', provider: 'openrouter' } })
      s.deps.agentConfig.invalidate()
      s.deps.catalog.invalidate()
    }
  })

  it('every cost-history branch answers its contract', async () => {
    const { ProviderCostHistorySchema } = await import('@maudecode/talaria-web-contracts')
    for (const provider of ['openrouter', 'zai', '']) {
      const res = await s.get(`/api/provider/cost-history?provider=${provider}`)
      expect(ProviderCostHistorySchema.safeParse(await res.json()).success).toBe(true)
    }
  })
})

describe('env file writer', () => {
  it('preserves comments and order, removes keys, appends new ones, and refuses newlines', () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-env-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '.env')
    writeFileSync(path, '# keep me\nA=1\n\nB=2\n')
    chmodSync(path, 0o644)
    writeEnvFile(path, { B: null, C: 'three', A: '"one"' })
    expect(readFileSync(path, 'utf8')).toBe('# keep me\nA="one"\n\nC=three\n')
    expect(loadEnvFile(path)).toEqual({ A: 'one', C: 'three' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => { writeEnvFile(path, { D: 'x\ny' }) }).toThrow(/newline/)
  })
})

describe('catalog helpers', () => {
  it('labels, prefixes, and dedupe follow the Python rules', () => {
    expect(formatOllamaLabel('qwen3-vl:235b-instruct')).toBe('Qwen3 VL (235B Instruct)')
    expect(labelForModel('@nous:openai/gpt-5.4-mini', [])).toBe('GPT 5.4 Mini')
    expect(labelForModel('claude-opus-4.7', [{ provider: 'Anthropic', provider_id: 'anthropic', models: [{ id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' }] }])).toBe('Claude Opus 4.7')
    expect(applyProviderPrefix([{ id: 'x', label: 'x' }, { id: 'a/b', label: 'ab' }], 'zai', 'anthropic').map((m) => m.id)).toEqual(['@zai:x', 'a/b'])
    expect(applyProviderPrefix([{ id: 'a/b', label: 'ab' }], 'nous', null).map((m) => m.id)).toEqual(['@nous:a/b'])
    expect(applyProviderPrefix([{ id: 'x', label: 'x' }], 'zai', null).map((m) => m.id)).toEqual(['x'])
    const groups = [{ provider: 'B', provider_id: 'b', models: [{ id: 'gpt', label: 'g' }] }, { provider: 'A', provider_id: 'a', models: [{ id: 'gpt', label: 'g' }] }]
    deduplicateModelIds(groups)
    expect(groups.map((g) => g.models[0]?.id)).toEqual(['@b:gpt', 'gpt'])
  })

  it('parses provider-qualified ids and coerces efforts down the ladder', () => {
    expect(parseProviderQualifiedModel('@custom:backup:model-a:free')).toEqual(['model-a:free', 'custom:backup'])
    expect(parseProviderQualifiedModel('@custom:127.0.0.1:1234:llama')).toEqual(['llama', 'custom:127.0.0.1:1234'])
    expect(parseProviderQualifiedModel('@ollama:qwen3.8:27b')).toEqual(['qwen3.8:27b', 'ollama'])
    expect(parseProviderQualifiedModel('plain')).toBeNull()
    expect(customProviderSlug('Local (127.0.0.1:15721)')).toBe('custom:local-127.0.0.1-15721')
    expect(coerceReasoningEffort('max', ['low', 'medium', 'high'])).toBe('high')
    expect(coerceReasoningEffort('none', ['low'])).toBe('none')
    expect(coerceReasoningEffort('silly', ['low'])).toBe('')
    // No resolved capability list: `max` degrades to `xhigh` for an unknown/custom provider, stays for a known one.
    expect(coerceReasoningEffort('max', [], 'custom')).toBe('xhigh')
    expect(coerceReasoningEffort('ultra', [], 'custom:proxy')).toBe('xhigh')
    expect(coerceReasoningEffort('max', [], 'anthropic')).toBe('max')
    expect(coerceReasoningEffort('high', [], 'custom')).toBe('high')
    expect(coerceReasoningEffort('max', [])).toBe('xhigh')
    expect(splitProviderModel('@anthropic:claude-x', null)).toEqual(['claude-x', 'anthropic'])
  })
})

describe('isolated profile mode', () => {
  let s: TestServer
  let home = ''
  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'talaria-isolated-'))
    home = join(base, 'profiles', 'tenant')
    mkdirSync(home, { recursive: true })
    const sidecar = new FakeSidecar()
    sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: base, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }, { name: 'other', path: join(base, 'profiles', 'other'), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
    s = await bootTestServer({ sidecar, env: { HERMES_WEBUI_ISOLATED_PROFILE: '1', HERMES_HOME: home } })
  })
  afterAll(async () => { await s.close(); rmSync(join(home, '..', '..'), { recursive: true, force: true }) })

  it('pins the process to the HERMES_HOME profile and refuses every cross-profile surface', async () => {
    expect(s.deps.isolatedProfileMode()).toBe(true)
    expect(s.deps.activeProfile()).toBe('tenant')
    expect(s.deps.profileHome('tenant')).toBe(home)
    let body = await json(await s.get('/api/profiles'))
    expect((body.profiles as Json[]).map((p) => p.name)).toEqual(['tenant'])
    expect(body.single_profile_mode).toBe(true)
    let res = await post(s, '/api/profile/switch', { name: 'other' })
    expect(res.status).toBe(403)
    res = await post(s, '/api/profile/create', { name: 'other2' })
    expect(res.status).toBe(403)
    res = await post(s, '/api/profile/delete', { name: 'other' })
    expect(res.status).toBe(403)
    body = await json(await s.get('/api/sessions?all_profiles=1'))
    expect(body).toMatchObject({ active_profile: 'tenant', all_profiles: false })
    body = await json(await s.get('/api/crons?all_profiles=1'))
    expect(body.all_profiles).toBe(false)
  })
})

describe('settings save response keeps the derived fields a load returns', () => {
  const DERIVED = ['password_env_var', 'webui_version', 'agent_version', 'update_channel', 'update_channel_version'] as const
  it.each([{ password: '' }, { password: 'correct horse battery' }])('a single toggle save matches the next GET (env password: %j)', async ({ password }) => {
    const s = await bootTestServer({ env: password ? { HERMES_WEBUI_PASSWORD: password } : {} })
    try {
      let headers: Record<string, string> = {}
      if (password) {
        const login = await post(s, '/api/auth/login', { password })
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
        headers = { cookie, 'x-hermes-csrf-token': await csrfFor(s, cookie) }
      }
      const saved = await json(await post(s, '/api/settings', { ignore_agent_updates: true }, headers))
      const loaded = await json(await s.get('/api/settings', { headers }))
      expect(saved.password_env_var).toBe(Boolean(password))
      for (const key of DERIVED) expect(saved[key], key).toEqual(loaded[key])
    } finally { await s.close() }
  })
})
