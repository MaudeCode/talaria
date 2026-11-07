/** TAL-1833: `${VAR}` references stay raw on disk; model and workspace readers use the Agent's resolution of them. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidecarLike } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { AgentConfig } from './agent-config.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

describe('config.yaml env references', () => {
  let s: TestServer | undefined
  afterEach(async () => { await s?.close(); s = undefined })

  /** A server whose sidecar answers `config.get` with this raw document and resolution; `saved()` is the document on disk. */
  const boot = async (config: Json, resolved: Json | null, env: Record<string, string> = {}): Promise<{ server: TestServer; saved: () => Json }> => {
    let stored = structuredClone(config)
    let writes = 0
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: structuredClone(stored), resolved }))
    sidecar.respond('config.set', (params) => {
      stored = params.config
      writes += 1
      const at = Date.now() / 1000 + writes
      writeFileSync(params.config_path, `# ${String(writes)}\n`)
      utimesSync(params.config_path, at, at)
      return { ok: true as const, path: params.config_path }
    })
    const server = await bootTestServer({ sidecar, env })
    s = server
    writeFileSync(join(server.state, 'config.yaml'), '# seed\n')
    await server.deps.agentConfig.read(server.state)
    return { server, saved: () => stored }
  }

  it('settings, the model picker and a new session use the resolved model', async () => {
    const { server } = await boot({ model: { default: '${SYNTH_MODEL}', provider: '${SYNTH_PROVIDER}' } }, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } })
    expect((await json(await server.get('/api/settings'))).default_model).toBe('claude-sonnet-4-6')
    const models = await json(await server.get('/api/models'))
    expect(models).toMatchObject({ default_model: 'claude-sonnet-4-6', default_provider_id: 'anthropic' })
    const session = (await json(await post(server, '/api/session/new', {}))).session as Json
    expect(session).toMatchObject({ model: 'claude-sonnet-4-6', model_provider: 'anthropic' })
  })

  const unresolved = { model: { default: '${MISSING}', provider: '${MISSING_PROVIDER}' }, workspace: '${MISSING_DIR}', terminal: { backend: 'ssh', cwd: '${MISSING_DIR}' } }
  it.each([
    ['still unresolved after the Agent expanded it', unresolved],
    ['unresolvable because the Agent could not be imported', null],
  ])('a reference %s counts as unset', async (_name, resolved) => {
    const { server } = await boot(unresolved, resolved, { HERMES_WEBUI_DEFAULT_MODEL: 'global-model' })
    expect((await json(await server.get('/api/models'))).default_model).toBe('global-model')
    expect((await json(await server.get('/api/settings'))).default_model).toBe('')
    const session = (await json(await post(server, '/api/session/new', {}))).session as Json
    expect(JSON.stringify([session.model, session.model_provider, session.workspace])).not.toContain('${')
    expect(server.deps.workspaces.remoteTerminalCwd(null)).toBeNull()
    expect(server.deps.workspaces.profileConfigDefaultWorkspace(null)).not.toContain('${')
  })

  it.each([
    ['still unresolved after the Agent expanded it', { terminal: { backend: '${MISSING_BACKEND}' } }, false],
    ['unresolvable because the Agent could not be imported', null, false],
    ['resolved to the local backend', { terminal: { backend: 'local' } }, true],
  ])('local I/O for a backend reference %s', async (_name, resolved, local) => {
    const { server } = await boot({ terminal: { backend: '${MISSING_BACKEND}' } }, resolved)
    expect(server.deps.workspaces.profileSupportsLocalIo(null)).toBe(local)
  })

  it('a sidecar that recovers re-resolves what the broken Agent could not', async () => {
    let restarted: (() => void) | undefined
    class RestartingSidecar extends FakeSidecar {
      onHandshake: NonNullable<SidecarLike['onHandshake']> = (listener) => { restarted = () => { listener(this.describe!) }; return () => undefined }
    }
    const sidecar = new RestartingSidecar()
    let resolved: Json | null = null
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: { model: '${SYNTH_MODEL}' }, resolved }))
    const server = await bootTestServer({ sidecar })
    s = server
    writeFileSync(join(server.state, 'config.yaml'), '# seed\n')
    await server.deps.agentConfig.read(server.state)
    expect((await json(await server.get('/api/settings'))).default_model).toBe('')
    resolved = { model: 'claude-sonnet-4-6' }
    restarted?.()
    await vi.waitFor(async () => { expect((await json(await server.get('/api/settings'))).default_model).toBe('claude-sonnet-4-6') })
  })

  it('workspace resolution follows the resolved paths', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'talaria-env-ref-'))
    const { server } = await boot({ workspace: '${SYNTH_DIR}', terminal: { backend: 'ssh', cwd: '${SYNTH_REMOTE}' } }, { workspace, terminal: { backend: 'ssh', cwd: '/srv/synth' } })
    expect(server.deps.workspaces.remoteTerminalCwd(null)).toBe('/srv/synth')
    expect(server.deps.workspaces.profileConfigDefaultWorkspace(null)).toBe(workspace)
    rmSync(workspace, { recursive: true, force: true })
  })

  it.each([
    ['the mapping form', { model: { default: '${SYNTH_MODEL}', provider: '${SYNTH_PROVIDER}', base_url: '${SYNTH_URL}' } }, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic', base_url: 'https://llm.example/v1' } }],
    ['the bare string form', { model: '${SYNTH_MODEL}' }, { model: 'claude-sonnet-4-6' }],
  ])('re-saving the displayed model keeps the references of %s on disk', async (_name, raw, resolved) => {
    const { server, saved } = await boot(raw, resolved)
    expect((await post(server, '/api/default-model', { model: 'claude-sonnet-4-6', provider: typeof raw.model === 'string' ? null : 'anthropic' })).status).toBe(200)
    expect(saved().model).toEqual(typeof raw.model === 'string' ? { default: raw.model } : raw.model)
  })

  it('saving a different model writes the new literal and keeps the unchanged references', async () => {
    const { server, saved } = await boot({ model: { default: '${SYNTH_MODEL}', provider: '${SYNTH_PROVIDER}', base_url: '${SYNTH_URL}' } }, { model: { default: 'claude-sonnet-4-6', provider: 'anthropic', base_url: 'https://llm.example/v1' } })
    expect((await post(server, '/api/default-model', { model: 'claude-opus-4-6', provider: 'anthropic' })).status).toBe(200)
    expect(saved().model).toEqual({ default: 'claude-opus-4-6', provider: '${SYNTH_PROVIDER}', base_url: '${SYNTH_URL}' })
  })

  it('a provider change still drops an unresolved base_url reference', async () => {
    const { server, saved } = await boot({ model: { default: 'old-model', provider: 'custom', base_url: '${MISSING_URL}' } }, { model: { default: 'old-model', provider: 'custom', base_url: '${MISSING_URL}' } })
    expect((await post(server, '/api/default-model', { model: 'claude-opus-4-6', provider: 'anthropic' })).status).toBe(200)
    expect(saved().model).toEqual({ default: 'claude-opus-4-6', provider: 'anthropic' })
  })

  it('a resolved secret never reaches a settings, model, provider or MCP response', async () => {
    const secret = 'sk-synth-secret-0001'
    const { server } = await boot(
      { model: { default: '${SYNTH_MODEL}', provider: 'synth' }, providers: { synth: { api_key: '${SYNTH_KEY}', base_url: 'https://llm.example/v1' } }, mcp_servers: { synth: { url: 'https://mcp.example', headers: { Authorization: '${SYNTH_KEY}' } } } },
      { model: { default: 'synth-model', provider: 'synth' }, providers: { synth: { api_key: secret, base_url: 'https://llm.example/v1' } }, mcp_servers: { synth: { url: 'https://mcp.example', headers: { Authorization: secret } } } },
    )
    for (const path of ['/api/settings', '/api/models', '/api/providers', '/api/mcp/servers']) {
      const res = await server.get(path)
      expect(res.status).toBe(200)
      expect(await res.text()).not.toContain(secret)
    }
  })
})

describe('AgentConfig resolved view', () => {
  const tempDir = (): string => mkdtempSync(join(tmpdir(), 'talaria-env-ref-'))

  it('re-resolves when the profile .env changes, because .env is an input of the expansion', async () => {
    const home = tempDir()
    writeFileSync(join(home, 'config.yaml'), 'model: ${SYNTH_MODEL}\n')
    let value = '${SYNTH_MODEL}'
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: { model: '${SYNTH_MODEL}' }, resolved: { model: value } }))
    const config = new AgentConfig({ sidecar: () => sidecar, env: {} })
    expect((await config.readResolved(home)).model).toBeUndefined()
    value = 'claude-sonnet-4-6'
    writeFileSync(join(home, '.env'), 'SYNTH_MODEL=claude-sonnet-4-6\n')
    expect(config.peekResolved(home)).toBeNull()
    await vi.waitFor(() => { expect(config.peekResolved(home)?.model).toBe('claude-sonnet-4-6') })
    rmSync(home, { recursive: true, force: true })
  })

  it('homes sharing an HERMES_CONFIG_PATH override never share a resolution', async () => {
    const root = tempDir()
    const [a, b] = [join(root, 'a'), join(root, 'b')]
    mkdirSync(a)
    mkdirSync(b)
    const override = join(root, 'shared.yaml')
    writeFileSync(override, '# shared\n')
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: { model: '${SYNTH_MODEL}' }, resolved: { model: params.profile_home === a ? 'model-a' : '${SYNTH_MODEL}' } }))
    const config = new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: override } })
    expect((await config.readResolved(a)).model).toBe('model-a')
    expect((await config.readResolved(b)).model).toBeUndefined()
    expect(config.peekResolved(a)?.model).toBe('model-a')
    rmSync(root, { recursive: true, force: true })
  })
})
