/**
 * One-to-one ports of the Python auth and provider-status regression cases
 * (TAL-245): login redirect sanitising, CSRF exemption and attempt
 * persistence, per-identity stream budgets, project-context walks, and
 * OAuth provider cards. Markers `[py:<file>::<case>]` are verified by
 * scripts/check-regression-port.py.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  it('[py:test_issue5578_login_next_nesting.py::test_rejects_login_self_reference] login-shaped destinations collapse to /', () => {
    for (const p of ['/login', '/session/login', '/session/login/', '/hermes/session/login']) expect(safeLoginRedirectPath(p), p).toBe('/')
  })

  it('[py:test_issue5578_login_next_nesting.py::test_rejects_deeply_encoded_login_chain] a six-level percent-encoded login chain collapses to /', () => {
    let chain = '/login'
    for (let i = 0; i < 6; i += 1) chain = `/login?next=${encodeURIComponent(chain)}`
    expect(chain).toContain('%25252525')
    expect(safeLoginRedirectPath(chain)).toBe('/')
  })

  it('[py:test_issue5578_login_next_nesting.py::test_preserves_non_login_path_carrying_its_own_next_key] a non-login destination with its own next key round-trips', () => {
    expect(safeLoginRedirectPath('/x?next=/y')).toBe('/x?next=/y')
    expect(safeLoginRedirectPath('/admin?action=foo&next=/real/path')).toBe('/admin?action=foo&next=/real/path')
  })

  it('[py:test_issue5578_login_next_nesting.py::test_rejects_overlong_next] an over-long next collapses to /', () => {
    expect(safeLoginRedirectPath(`/${'a'.repeat(3000)}`)).toBe('/')
  })

  it('[py:test_issue5578_login_next_nesting.py::test_the_exact_12k_explosion_collapses] a 40-deep exponential login chain collapses to /', () => {
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

  it('[py:test_issue1909_csrf_token.py::test_login_route_remains_csrf_exempt] the login route ignores a hostile Origin and needs no CSRF token', async () => {
    const res = await post(s, '/api/auth/login', { password: PASSWORD }, { origin: 'https://evil.example', host: s.base.replace('http://', '') })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true })
  })

  it('[py:test_issue1910_login_attempt_persistence.py::test_login_rate_limit_survives_reload] the attempt window persists on disk and a fresh store still rate-limits the address', async () => {
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
    const login = await post(s, '/api/auth/login', { password: PASSWORD })
    expect(login.status).toBe(200)
    const cookie = cookieHeader(login.headers.getSetCookie(), 'hermes_session') ?? ''
    expect((await json(await s.get('/api/auth/status', { headers: { cookie } }))).logged_in).toBe(true)
    expect((await s.get('/health')).status).toBe(200)
    const sessionsFile = join(s.state, '.sessions.json')
    expect(held).toEqual([sessionsFile])
    expect(existsSync(sessionsFile)).toBe(false)
    open()
    await s.deps.auth.flushPersistence()
    expect(Object.keys(JSON.parse(readFileSync(sessionsFile, 'utf8')) as object)).toEqual([AuthStore.tokenFromCookieValue(cookie.split('=')[1])])
  })
})

describe('authenticated stream budget', () => {
  let s: TestServer
  // Python keyed the per-client SSE budget by the reconciled trusted-auth username, else the peer address.
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Test-Identity', HERMES_WEBUI_MAX_SSE_CLIENTS: '2' } }) })
  afterAll(() => s.close())

  it('[py:test_issue5210_http_worker_bound.py::test_sse_per_client_cap_does_not_affect_another_authenticated_identity] a third stream for one identity answers 503 while another identity still opens one', async () => {
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

  it('[py:test_issue5210_http_worker_bound.py::test_sse_per_client_cap_falls_back_to_client_address] without an identity the cap keys on the client address', async () => {
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

  it('[py:test_issue4164_bound_non_git_project_context_walk.py::test_non_git_workspace_does_not_walk_above_workspace] a non-git workspace never surfaces a HERMES.md above it', () => {
    const ctx = readProjectContext(join(root, 'plain', 'ws'))
    expect(ctx.content).toBe('')
    expect(ctx.path).toBe('')
  })

  it('[py:test_issue4164_bound_non_git_project_context_walk.py::test_git_workspace_walk_to_git_root_is_unchanged] a git workspace still walks up to the repo root', () => {
    const ctx = readProjectContext(join(root, 'repo', 'apps', 'web'))
    expect(ctx.content).toBe('repo root context\n')
    expect(String(ctx.path).endsWith('/repo/HERMES.md')).toBe(true)
  })

  it('[py:test_issue4164_bound_non_git_project_context_walk.py::test_non_git_workspace_bound_is_workspace_not_first_parent] the workspace copy wins and the parent copy is neither content nor shadowed', () => {
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
  interface Card { id: string; has_key: boolean; key_source: string; auth_error: string | null; is_oauth: boolean; configurable: boolean; display_name: string; models: { id: string }[]; models_total: number }
  const cards = async (): Promise<Card[]> => (await json(await s.get('/api/providers'))).providers as Card[]

  it('[py:test_issue1202_oauth_provider_status.py::test_config_yaml_token_shows_configured_when_auth_logged_in] a logged-in OAuth provider reports key_source oauth even with a config token', async () => {
    reset({ providers: { 'openai-codex': { api_key: 'cfg-token' } } })
    auth.set('openai-codex', { logged_in: true })
    expect((await cards()).find((p) => p.id === 'openai-codex')).toMatchObject({ has_key: true, key_source: 'oauth' })
  })

  it('[py:test_issue1202_oauth_provider_status.py::test_config_yaml_token_shows_configured_when_auth_not_logged_in] a config token keeps has_key with key_source config_yaml when not logged in', async () => {
    reset({ providers: { 'openai-codex': { api_key: 'cfg-token' } } })
    auth.set('openai-codex', { logged_in: false, error: 'token expired' })
    expect((await cards()).find((p) => p.id === 'openai-codex')).toMatchObject({ has_key: true, key_source: 'config_yaml' })
  })

  it('[py:test_issue1202_oauth_provider_status.py::test_auth_error_preserved_when_not_logged_in_but_config_key_present] the auth error is still reported next to the config token', async () => {
    reset({ providers: { 'openai-codex': { api_key: 'cfg-token' } } })
    auth.set('openai-codex', { logged_in: false, error: 'token expired' })
    expect((await cards()).find((p) => p.id === 'openai-codex')).toMatchObject({ has_key: true, auth_error: 'token expired' })
  })

  it('[py:test_issue1202_oauth_provider_status.py::test_auth_error_field_present_on_all_oauth_providers] every provider card carries an auth_error key', async () => {
    reset()
    for (const card of await cards()) expect('auth_error' in card, card.id).toBe(true)
  })

  it('[py:test_issue2545_xai_oauth_provider.py::test_xai_oauth_provider_card_uses_oauth_status_and_models] the xAI OAuth card is OAuth-only with live models', async () => {
    reset({ model: { provider: 'xai-oauth', default: 'grok-4' } })
    auth.set('xai-oauth', { logged_in: true })
    liveIds.set('xai-oauth', ['grok-4', 'grok-4-mini'])
    const card = (await cards()).find((p) => p.id === 'xai-oauth')
    expect(card).toMatchObject({ display_name: 'xAI Grok OAuth', is_oauth: true, configurable: false, key_source: 'oauth', has_key: true })
    expect(card?.models.map((m) => m.id)).toEqual(['grok-4', 'grok-4-mini'])
    expect(card?.models_total).toBe(2)
  })

  it('[py:test_issue2545_xai_oauth_provider.py::test_xai_oauth_model_picker_group_uses_live_catalog] the model picker group for xAI OAuth uses the live ids and is the active provider', async () => {
    reset({ model: { provider: 'xai-oauth', default: 'grok-4' } })
    auth.set('xai-oauth', { logged_in: true })
    liveIds.set('xai-oauth', ['grok-4', 'grok-4-mini'])
    const body = await json(await s.get('/api/models'))
    expect(body.active_provider).toBe('xai-oauth')
    const group = (body.groups as { provider_id: string; provider: string; models: { id: string }[] }[]).find((g) => g.provider_id === 'xai-oauth')
    expect(group?.provider).toBe('xAI Grok OAuth')
    expect(group?.models.map((m) => m.id.replace(/^@xai-oauth:/, ''))).toEqual(['grok-4', 'grok-4-mini'])
  })

  it('[py:test_issue4770_anthropic_oauth_detection.py::test_anthropic_token_env_var_surfaces_anthropic_models] ANTHROPIC_TOKEN alone surfaces the Anthropic group', async () => {
    reset({ model: { provider: 'openrouter', default: 'auto' } }, { ANTHROPIC_TOKEN: 'sk-ant-oat-1234' })
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string; provider: string; models: unknown[] }[]
    const anthropic = groups.find((g) => g.provider_id === 'anthropic')
    expect(anthropic?.provider).toBe('Anthropic')
    expect(anthropic?.models.length).toBeGreaterThan(0)
  })

  it('[py:test_issue4770_anthropic_oauth_detection.py::test_claude_code_oauth_token_env_var_surfaces_anthropic_models] CLAUDE_CODE_OAUTH_TOKEN alone surfaces the Anthropic group', async () => {
    reset({ model: { provider: 'openrouter', default: 'auto' } }, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-5678' })
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string; models: unknown[] }[]
    expect(groups.find((g) => g.provider_id === 'anthropic')?.models.length).toBeGreaterThan(0)
  })

  it('[py:test_issue4770_anthropic_oauth_detection.py::test_whitespace_only_anthropic_oauth_env_vars_do_not_surface_anthropic] whitespace-only token variables do not surface Anthropic', async () => {
    reset({ model: { provider: 'openrouter', default: 'auto' } })
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_TOKEN: '   ', CLAUDE_CODE_OAUTH_TOKEN: ' ' })
    s.deps.catalog.invalidate()
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string }[]
    expect(groups.map((g) => g.provider_id)).not.toContain('anthropic')
  })
})
