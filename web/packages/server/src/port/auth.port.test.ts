/**
 * Auth and provider-status regressions: login redirect sanitising, CSRF
 * exemption and attempt persistence, per-identity stream budgets,
 * project-context walks, and OAuth provider cards.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'
import { safeLoginRedirectPath } from '../auth/gate.js'
import { AuthStore } from '../auth/store.js'
import { readProjectContext } from '../tools/memory.js'
import { writeEnvFile } from '../providers/env-file.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

describe('login redirect sanitiser', () => {
  it('login-shaped destinations collapse to /', () => {
    for (const p of ['/login', '/session/login', '/session/login/', '/hermes/session/login']) expect(safeLoginRedirectPath(p), p).toBe('/')
  })

  it('a six-level percent-encoded login chain collapses to /', () => {
    let chain = '/login'
    for (let i = 0; i < 6; i += 1) chain = `/login?next=${encodeURIComponent(chain)}`
    expect(chain).toContain('%25252525')
    expect(safeLoginRedirectPath(chain)).toBe('/')
  })

  it('a non-login destination with its own next key round-trips', () => {
    expect(safeLoginRedirectPath('/x?next=/y')).toBe('/x?next=/y')
    expect(safeLoginRedirectPath('/admin?action=foo&next=/real/path')).toBe('/admin?action=foo&next=/real/path')
  })

  it('an over-long next collapses to /', () => {
    expect(safeLoginRedirectPath(`/${'a'.repeat(3000)}`)).toBe('/')
  })

  it('a 40-deep exponential login chain collapses to /', () => {
    let chain = '/login'
    for (let i = 0; i < 40; i += 1) chain = `/login?next=${encodeURIComponent(chain)}`
    expect(safeLoginRedirectPath(chain)).toBe('/')
  })
})

describe('password login: CSRF exemption and attempt persistence', () => {
  let s: TestServer
  const PASSWORD = 'correct horse battery'
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD, HERMES_WEBUI_MAX_SSE_CLIENTS: '2' } }) })
  afterAll(() => s.close())

  it('the login route ignores a hostile Origin and needs no CSRF token', async () => {
    const res = await post(s, '/api/auth/login', { password: PASSWORD }, { origin: 'https://evil.example', host: s.base.replace('http://', '') })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
  })

  it('the attempt window persists on disk and a fresh store still rate-limits the address', async () => {
    for (let i = 0; i < 5; i += 1) await post(s, '/api/auth/login', { password: 'wrong' })
    expect((await post(s, '/api/auth/login', { password: PASSWORD })).status).toBe(429)
    await s.deps.auth.flushPersistence()
    const reloaded = new AuthStore({ stateDir: s.state, env: s.deps.config.env, settings: s.deps.settings })
    expect(reloaded.checkLoginRate('127.0.0.1')).toBe(false)
    s.deps.auth.clearLoginAttempts('127.0.0.1')
    await s.deps.auth.flushPersistence()
    expect(new AuthStore({ stateDir: s.state, env: s.deps.config.env, settings: s.deps.settings }).checkLoginRate('127.0.0.1')).toBe(true)
  })

})

describe('auth persistence off the request path', () => {
  let s: TestServer
  const PASSWORD = 'correct horse battery'
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD } }) })
  afterAll(() => s.close())

  it('answers login, the new session, and unrelated requests while the sessions write is held pending', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const land = s.deps.auth.persistWrite
    const held: string[] = []
    s.deps.auth.persistWrite = async (file, text) => { held.push(file); await gate; await land(file, text) }
    try {
      const login = await post(s, '/api/auth/login', { password: PASSWORD })
      expect(login.status).toBe(200)
      const cookie = cookieHeader(login.headers.getSetCookie(), 'hermes_session') ?? ''
      expect((await json(await s.get('/api/auth/status', { headers: { cookie } }))).logged_in).toBe(true)
      expect((await s.get('/health')).status).toBe(200)
      const sessionsFile = join(s.state, '.sessions.json')
      // The login reserves a rate-limit attempt before hashing and releases it on success (TAL-523).
      expect(held.toSorted()).toEqual([join(s.state, '.login_attempts.json'), sessionsFile])
      expect(existsSync(sessionsFile)).toBe(false)
      open()
      await s.deps.auth.flushPersistence()
      expect(Object.keys(JSON.parse(readFileSync(sessionsFile, 'utf8')) as object)).toEqual([AuthStore.tokenFromCookieValue(cookie.split('=')[1])])
    } finally {
      open()
      s.deps.auth.persistWrite = land
    }
  })

  it('answers logout only after the revoked session is on disk', async () => {
    const login = await post(s, '/api/auth/login', { password: PASSWORD })
    const cookie = cookieHeader(login.headers.getSetCookie(), 'hermes_session') ?? ''
    const token = AuthStore.tokenFromCookieValue(cookie.split('=')[1]) ?? ''
    await s.deps.auth.flushPersistence()
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const land = s.deps.auth.persistWrite
    s.deps.auth.persistWrite = async (file, text) => { await gate; await land(file, text) }
    try {
      let answered = false
      const logout = s.get('/api/auth/logout', { method: 'POST', headers: { cookie } }).then((res) => { answered = true; return res })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(answered).toBe(false)
      open()
      expect((await logout).status).toBe(200)
      expect(JSON.parse(readFileSync(join(s.state, '.sessions.json'), 'utf8'))).not.toHaveProperty(token)
    } finally {
      open()
      s.deps.auth.persistWrite = land
    }
  })
})

describe('orderly shutdown lands write-behind auth state', () => {
  const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

  it.each(SIGNALS)('%s exits only after the pending session write lands', async (signal) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const before = new Map(SIGNALS.map((name) => [name, process.listeners(name)]))
    const s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: 'correct horse battery' }, signals: true })
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const land = s.deps.auth.persistWrite
    s.deps.auth.persistWrite = async (file, text) => { await gate; await land(file, text) }
    try {
      const token = AuthStore.tokenFromCookieValue(s.deps.auth.createSession()) ?? ''
      process.emit(signal, signal)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(exit).not.toHaveBeenCalled()
      open()
      await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
      expect(JSON.parse(readFileSync(join(s.state, '.sessions.json'), 'utf8'))).toHaveProperty(token)
    } finally {
      open()
      exit.mockRestore()
      for (const name of SIGNALS) for (const listener of process.listeners(name)) if (!before.get(name)?.includes(listener)) process.off(name, listener)
      await s.close()
    }
  })
})

describe('authenticated stream budget', () => {
  let s: TestServer
  // Python keyed the per-client SSE budget by the reconciled trusted-auth username, else the peer address.
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Test-Identity', HERMES_WEBUI_MAX_SSE_CLIENTS: '2' } }) })
  afterAll(() => s.close())

  it('a third stream for one identity answers 503 while another identity still opens one', async () => {
    const alice = 'alice'
    const bob = 'bob'
    const controllers: AbortController[] = []
    const open = async (identity: string): Promise<Response> => { const c = new AbortController(); controllers.push(c); return fetch(`${s.base}/api/sessions/events`, { headers: { 'x-test-identity': identity }, signal: c.signal }) }
    try {
      const a1 = await open(alice)
      const a2 = await open(alice)
      const a3 = await open(alice)
      const b1 = await open(bob)
      expect([a1.status, a2.status, a3.status, b1.status]).toEqual([200, 200, 503, 200])
      expect(await a3.json()).toMatchObject({ condition: 'client_stream_limit' })
      expect((await s.get('/health')).status).toBe(200)
    } finally {
      for (const c of controllers) c.abort()
    }
  })
})

describe('anonymous stream budget', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_MAX_SSE_CLIENTS: '1' } }) })
  afterAll(() => s.close())

  it('without an identity the cap keys on the client address', async () => {
    const c = new AbortController()
    try {
      const first = await fetch(`${s.base}/api/sessions/events`, { signal: c.signal })
      expect(first.status).toBe(200)
      const second = await s.get('/api/sessions/events')
      expect(second.status).toBe(503)
      expect(await second.json()).toMatchObject({ condition: 'client_stream_limit' })
    } finally { c.abort() }
  })
})

describe('project context walk', () => {
  const git = (cwd: string, ...args: string[]): void => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr) }
  let root = ''
  beforeAll(() => {
    root = join(process.env.TMPDIR ?? '/tmp', `talaria-ctx-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(join(root, 'plain', 'ws'), { recursive: true })
    writeFileSync(join(root, 'plain', 'HERMES.md'), 'above the workspace\n')
    mkdirSync(join(root, 'repo', 'apps', 'web'), { recursive: true })
    git(join(root, 'repo'), 'init', '--quiet')
    writeFileSync(join(root, 'repo', 'HERMES.md'), 'repo root context\n')
    mkdirSync(join(root, 'both', 'ws'), { recursive: true })
    writeFileSync(join(root, 'both', 'HERMES.md'), 'parent copy\n')
    writeFileSync(join(root, 'both', 'ws', 'HERMES.md'), 'workspace copy\n')
  })

  it('a non-git workspace never surfaces a HERMES.md above it', () => {
    const ctx = readProjectContext(join(root, 'plain', 'ws'))
    expect(ctx.content).toBe('')
    expect(ctx.path).toBe('')
  })

  it('a git workspace still walks up to the repo root', () => {
    const ctx = readProjectContext(join(root, 'repo', 'apps', 'web'))
    expect(ctx.content).toBe('repo root context\n')
    expect(String(ctx.path).endsWith('/repo/HERMES.md')).toBe(true)
  })

  it('the workspace copy wins and the parent copy is neither content nor shadowed', () => {
    const ctx = readProjectContext(join(root, 'both', 'ws'))
    expect(ctx.content).toBe('workspace copy\n')
    expect(ctx.shadowed).toEqual([])
  })
})

describe('OAuth provider cards and model groups', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let configs: Map<string, Json>
  let auth: Map<string, Json>
  let liveIds: Map<string, string[]>
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    configs = new Map()
    auth = new Map()
    liveIds = new Map()
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('providers.auth_status', (params) => ({ status: { logged_in: false, ...(auth.get(params.provider ?? '') ?? { error: 'not logged in' }) } }))
    sidecar.respond('providers.model_ids', (params) => ({ provider: params.provider, model_ids: liveIds.get(params.provider) ?? [] }))
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
  })
  afterAll(() => s.close())
  const ENV_KEYS = ['ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
  const reset = (cfg: Json = {}, env: Record<string, string | null> = {}): void => { configs.set(s.state, cfg); writeEnvFile(join(s.state, '.env'), { ...Object.fromEntries(ENV_KEYS.map((k) => [k, null])), ...env }); s.deps.agentConfig.invalidate(); s.deps.catalog.invalidate() }
  interface Card { id: string; has_key: boolean; is_active: boolean; key_source: string; key_source_kind: string | null; auth_error: string | null; is_oauth: boolean; configurable: boolean; display_name: string; models: { id: string }[]; models_total: number }
  const cards = async (): Promise<Card[]> => (await json(await s.get('/api/providers'))).providers as Card[]

  it('a logged-in OAuth provider reports key_source oauth even with a config token', async () => {
    reset({ providers: { 'openai-codex': { api_key: 'cfg-token' } } })
    auth.set('openai-codex', { logged_in: true })
    expect((await cards()).find((p) => p.id === 'openai-codex')).toMatchObject({ has_key: true, key_source: 'oauth' })
  })

  it('a config token keeps has_key with key_source config_yaml when not logged in', async () => {
    reset({ providers: { 'openai-codex': { api_key: 'cfg-token' } } })
    auth.set('openai-codex', { logged_in: false, error: 'token expired' })
    expect((await cards()).find((p) => p.id === 'openai-codex')).toMatchObject({ has_key: true, key_source: 'config_yaml' })
  })

  it('the auth error is still reported next to the config token', async () => {
    reset({ providers: { 'openai-codex': { api_key: 'cfg-token' } } })
    auth.set('openai-codex', { logged_in: false, error: 'token expired' })
    expect((await cards()).find((p) => p.id === 'openai-codex')).toMatchObject({ has_key: true, auth_error: 'token expired' })
  })

  it('every provider card carries an auth_error key', async () => {
    reset()
    for (const card of await cards()) expect('auth_error' in card, card.id).toBe(true)
  })

  it('the xAI OAuth card is OAuth-only with live models', async () => {
    reset({ model: { provider: 'xai-oauth', default: 'grok-4' } })
    auth.set('xai-oauth', { logged_in: true })
    liveIds.set('xai-oauth', ['grok-4', 'grok-4-mini'])
    const card = (await cards()).find((p) => p.id === 'xai-oauth')
    expect(card).toMatchObject({ display_name: 'xAI Grok OAuth', is_oauth: true, configurable: false, key_source: 'oauth', has_key: true })
    expect(card?.models.map((m) => m.id)).toEqual(['grok-4', 'grok-4-mini'])
    expect(card?.models_total).toBe(2)
  })

  it('each card ships is_active, key_source_kind and a models_total that covers its list (TAL-603)', async () => {
    reset({ model: { provider: ' XAI-OAuth ', default: 'grok-4' }, providers: { nous: { models: ['extra-model'] }, 'openai-codex': { api_key: 'cfg-token' } } }, { ANTHROPIC_API_KEY: 'sk-ant-env-file-1234' })
    auth.set('xai-oauth', { logged_in: true })
    auth.set('nous', { logged_in: true })
    auth.set('openai-codex', { logged_in: false, error: 'token expired' })
    liveIds.set('nous', ['a/one', 'b/two'])
    const all = await cards()
    const card = (id: string): Card | undefined => all.find((p) => p.id === id)
    expect(all.filter((p) => p.is_active).map((p) => p.id)).toEqual(['xai-oauth'])
    expect(card('anthropic')).toMatchObject({ is_active: false, key_source: 'env_file', key_source_kind: 'env' })
    expect(card('xai-oauth')).toMatchObject({ key_source_kind: 'oauth' })
    expect(card('openai-codex')).toMatchObject({ key_source: 'config_yaml', key_source_kind: 'config' })
    expect(card('openai')).toMatchObject({ has_key: false, key_source_kind: null })
    expect(card('nous')?.models.length).toBe(3)
    expect(card('nous')?.models_total).toBe(3)
  })

  it('a custom provider keyed through the environment reports an env key_source_kind (TAL-603)', async () => {
    const env = s.deps.config.env
    env.TAL603_CUSTOM_KEY = 'sk-custom-env-1234'
    try {
      reset({ custom_providers: [{ name: 'Env Box', base_url: 'http://127.0.0.1:9/v1', key_env: 'TAL603_CUSTOM_KEY' }, { name: 'Ref Box', base_url: 'http://127.0.0.1:9/v1', api_key: '${TAL603_CUSTOM_KEY}' }, { name: 'Yaml Box', base_url: 'http://127.0.0.1:9/v1', api_key: 'sk-custom-yaml-1234' }] })
      const all = await cards()
      const named = (name: string): Card | undefined => all.find((p) => p.display_name === name)
      expect(named('Env Box')).toMatchObject({ has_key: true, key_source: 'env_var', key_source_kind: 'env' })
      expect(named('Ref Box')).toMatchObject({ has_key: true, key_source: 'env_var', key_source_kind: 'env' })
      expect(named('Yaml Box')).toMatchObject({ has_key: true, key_source: 'config_yaml', key_source_kind: 'config' })
    } finally {
      delete env.TAL603_CUSTOM_KEY
    }
  })

  it('the model picker group for xAI OAuth uses the live ids and is the active provider', async () => {
    reset({ model: { provider: 'xai-oauth', default: 'grok-4' } })
    auth.set('xai-oauth', { logged_in: true })
    liveIds.set('xai-oauth', ['grok-4', 'grok-4-mini'])
    const body = await json(await s.get('/api/models'))
    expect(body.active_provider).toBe('xai-oauth')
    const group = (body.groups as { provider_id: string; provider: string; models: { id: string }[] }[]).find((g) => g.provider_id === 'xai-oauth')
    expect(group?.provider).toBe('xAI Grok OAuth')
    expect(group?.models.map((m) => m.id.replace(/^@xai-oauth:/, ''))).toEqual(['grok-4', 'grok-4-mini'])
  })

  it('ANTHROPIC_TOKEN alone surfaces the Anthropic group', async () => {
    reset({ model: { provider: 'openrouter', default: 'auto' } }, { ANTHROPIC_TOKEN: 'sk-ant-oat-1234' })
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string; provider: string; models: unknown[] }[]
    const anthropic = groups.find((g) => g.provider_id === 'anthropic')
    expect(anthropic?.provider).toBe('Anthropic')
    expect(anthropic?.models.length).toBeGreaterThan(0)
  })

  it('CLAUDE_CODE_OAUTH_TOKEN alone surfaces the Anthropic group', async () => {
    reset({ model: { provider: 'openrouter', default: 'auto' } }, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-5678' })
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string; models: unknown[] }[]
    expect(groups.find((g) => g.provider_id === 'anthropic')?.models.length).toBeGreaterThan(0)
  })

  it('whitespace-only token variables do not surface Anthropic', async () => {
    reset({ model: { provider: 'openrouter', default: 'auto' } })
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_TOKEN: '   ', CLAUDE_CODE_OAUTH_TOKEN: ' ' })
    s.deps.catalog.invalidate()
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string }[]
    expect(groups.map((g) => g.provider_id)).not.toContain('anthropic')
  })
})
