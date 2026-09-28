/**
 * Startup and environment regressions: `.env` handling, provider key
 * detection from environment variables and config, and the password env-var
 * lock.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootstrapSchema } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'
import { loadEnvFile, writeEnvFile } from '../providers/env-file.js'
import { OAUTH_PROVIDERS, PROVIDER_ENV_VAR, PROVIDER_ENV_VAR_ALIASES, SUPPORTED_PROVIDER_SETUPS } from '../providers/tables.js'

type Json = Record<string, unknown>
interface Provider { id: string; has_key: boolean; key_source: string; configurable: boolean; is_oauth: boolean }
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

describe('.env writer', () => {
  it('writing to a missing .env creates it with exactly the new key', () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-env-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '.env')
    expect(existsSync(path)).toBe(false)
    writeEnvFile(path, { NEW_KEY: 'value' })
    expect(readFileSync(path, 'utf8').trim()).toBe('NEW_KEY=value')
    expect(loadEnvFile(path)).toEqual({ NEW_KEY: 'value' })
  })
})

describe('provider key detection', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let configs: Map<string, Json>
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    configs = new Map()
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('config.set', (params) => { configs.set(params.profile_home, params.config); return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
  })
  afterAll(() => s.close())
  const setConfig = (cfg: Json): void => { configs.set(s.state, cfg); s.deps.agentConfig.invalidate(); s.deps.catalog.invalidate() }
  const setEnv = (keys: Record<string, string | null>): void => { writeEnvFile(join(s.state, '.env'), keys); s.deps.catalog.invalidate() }
  const providers = async (): Promise<Provider[]> => (await json(await s.get('/api/providers'))).providers as Provider[]
  const provider = async (id: string): Promise<Provider | undefined> => (await providers()).find((p) => p.id === id)
  const clearEnv = (): void => { const current = loadEnvFile(join(s.state, '.env')); setEnv(Object.fromEntries(Object.keys(current).map((k) => [k, null]))) }

  it('LM Studio reads LM_API_KEY with LMSTUDIO_API_KEY as an alias', () => {
    expect(PROVIDER_ENV_VAR.lmstudio).toBe('LM_API_KEY')
    expect(PROVIDER_ENV_VAR_ALIASES.lmstudio).toContain('LMSTUDIO_API_KEY')
  })

  it('the onboarding setup for LM Studio names the canonical variable and its alias', () => {
    expect(SUPPORTED_PROVIDER_SETUPS.lmstudio?.env_var).toBe('LM_API_KEY')
    expect(SUPPORTED_PROVIDER_SETUPS.lmstudio?.env_var_aliases).toContain('LMSTUDIO_API_KEY')
  })

  it('LM_API_KEY marks LM Studio as keyed and configurable', async () => {
    setConfig({ model: { provider: 'lmstudio', default: 'gpt-4o-mini' } })
    setEnv({ LM_API_KEY: 'lm-studio' })
    const lm = await provider('lmstudio')
    expect(lm).toMatchObject({ has_key: true, configurable: true })
    expect(['env_file', 'env_var']).toContain(lm?.key_source)
  })

  it('only LM_API_KEY keys LM Studio and no other API-key provider', async () => {
    clearEnv()
    setEnv({ LM_API_KEY: 'lm-studio' })
    const all = await providers()
    expect(all.find((p) => p.id === 'lmstudio')?.has_key).toBe(true)
    for (const p of all) if (p.id !== 'lmstudio' && !p.is_oauth && !OAUTH_PROVIDERS.has(p.id) && !p.id.startsWith('custom:')) expect(p.has_key, p.id).toBe(false)
  })

  it('providers.lmstudio.api_key in config.yaml counts as a key from config', async () => {
    clearEnv()
    setConfig({ model: { provider: 'lmstudio' }, providers: { lmstudio: { api_key: 'cfg-key' } } })
    expect(await provider('lmstudio')).toMatchObject({ has_key: true, key_source: 'config_yaml' })
  })

  it('LM Studio stays listed and configurable without any key', async () => {
    clearEnv()
    setConfig({})
    expect(await provider('lmstudio')).toMatchObject({ has_key: false, configurable: true })
  })

  it('the legacy LMSTUDIO_API_KEY alone still counts', async () => {
    clearEnv()
    setEnv({ LMSTUDIO_API_KEY: 'legacy' })
    const lm = await provider('lmstudio')
    expect(lm?.has_key).toBe(true)
    expect(['env_file', 'env_var']).toContain(lm?.key_source)
  })

  it('both variables set keeps LM Studio keyed and configurable', async () => {
    clearEnv()
    setEnv({ LM_API_KEY: 'canonical', LMSTUDIO_API_KEY: 'legacy' })
    expect(await provider('lmstudio')).toMatchObject({ has_key: true, configurable: true })
  })

  it('key presence honours the alias but not unrelated keys', async () => {
    clearEnv()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    expect((await provider('lmstudio'))?.has_key).toBe(false)
    setEnv({ LMSTUDIO_API_KEY: 'legacy' })
    expect((await provider('lmstudio'))?.has_key).toBe(true)
  })

  it('XIAOMI_API_KEY keys the Xiaomi provider', async () => {
    expect(PROVIDER_ENV_VAR.xiaomi).toBe('XIAOMI_API_KEY')
    clearEnv()
    setEnv({ XIAOMI_API_KEY: 'xm-1234' })
    expect((await provider('xiaomi'))?.has_key).toBe(true)
  })

  it('the onboarding setup for Xiaomi names the variable, base URL, and MiMo model', () => {
    const setup = SUPPORTED_PROVIDER_SETUPS.xiaomi
    expect(setup?.env_var).toBe('XIAOMI_API_KEY')
    expect(setup?.default_base_url).toBe('https://api.xiaomimimo.com/v1')
    expect(JSON.stringify(setup)).toContain('mimo-v2.5-pro')
  })

  it('a Xiaomi key surfaces a Xiaomi model group in /api/models', async () => {
    clearEnv()
    setEnv({ XIAOMI_API_KEY: 'xm-1234' })
    // Python forced the Agent import to fail so the static table answered; here the live id lookup fails the same way.
    sidecar.respond('providers.model_ids', () => { throw new SidecarError('hermes_cli unavailable', { condition: 'sidecar_error' }) })
    s.deps.catalog.invalidate()
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string; provider: string; models: { id: string }[] }[]
    const xiaomi = groups.find((g) => g.provider_id === 'xiaomi')
    expect(xiaomi, JSON.stringify(groups.map((g) => g.provider_id))).toBeDefined()
    expect(xiaomi?.models.some((m) => m.id.includes('mimo-v2.5-pro'))).toBe(true)
  })

  it('NeuralWatt reads NEURALWATT_API_KEY', () => {
    expect(PROVIDER_ENV_VAR.neuralwatt).toBe('NEURALWATT_API_KEY')
  })

  // Python asserted the `_provider_has_key` helper: NeuralWatt has an env var but no display row, so neither backend lists it in /api/providers.
  const hasKey = async (pid: string): Promise<boolean> => {
    const catalog = s.deps.catalog as unknown as { providerHasKey: (pid: string, config: Json, env: Record<string, string>, profileHome: string) => boolean }
    return catalog.providerHasKey(pid, await s.deps.agentConfig.read(s.state), loadEnvFile(join(s.state, '.env')), s.state)
  }

  it('NEURALWATT_API_KEY keys the provider', async () => {
    clearEnv()
    setEnv({ NEURALWATT_API_KEY: 'nw-1234' })
    expect(await hasKey('neuralwatt')).toBe(true)
  })

  it('without the variable NeuralWatt has no key', async () => {
    clearEnv()
    expect(await hasKey('neuralwatt')).toBe(false)
  })

  it('a NeuralWatt key plus configured models yields a model group', async () => {
    clearEnv()
    setEnv({ NEURALWATT_API_KEY: 'nw-1234' })
    setConfig({ providers: { neuralwatt: { models: ['nw-alpha', 'nw-beta'] } } })
    const groups = (await json(await s.get('/api/models'))).groups as { provider_id: string; models: { id: string }[] }[]
    const nw = groups.find((g) => g.provider_id === 'neuralwatt')
    expect(nw, JSON.stringify(groups.map((g) => g.provider_id))).toBeDefined()
    expect(nw?.models.length).toBeGreaterThan(0)
    setConfig({})
  })
})

describe('password env var lock', () => {
  let s: TestServer
  let cookie = ''
  let csrf = ''
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: 'env-secret-123' } })
    const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'env-secret-123' }) })
    expect(res.status).toBe(200)
    cookie = cookieHeader(res.headers.getSetCookie(), 'hermes_session') ?? ''
    csrf = BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers: { cookie } })).json()).csrf_token
  })
  afterAll(() => s.close())
  const headers = (): Record<string, string> => ({ cookie, origin: s.base, host: s.base.replace('http://', ''), 'X-Hermes-CSRF-Token': csrf })

  it('setting a password while HERMES_WEBUI_PASSWORD is set answers 409 naming the variable', async () => {
    const res = await post(s, '/api/settings', { _set_password: 'another-secret' }, headers())
    expect(res.status).toBe(409)
    expect(String((await json(res)).error)).toContain('HERMES_WEBUI_PASSWORD')
  })

  it('clearing the password is refused the same way', async () => {
    const res = await post(s, '/api/settings', { _clear_password: true }, headers())
    expect(res.status).toBe(409)
    expect(String((await json(res)).error)).toContain('HERMES_WEBUI_PASSWORD')
  })
})
