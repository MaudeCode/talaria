import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { writeEnvFile } from '../test/env-file.js'

type Json = Record<string, unknown>
interface Group { provider: string; provider_id: string; models: { id: string; provider_id?: string; bare_id?: string }[] }
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const STAGED = 'tiny-test-Q4_K_M'

/** TAL-798: GGUFs downloaded for the Agent's managed llama.cpp runtime are a Local group in the model picker. */
describe('the Agent\'s local llama.cpp models in the picker', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let config: Json
  let staged: string[]
  let endpoint: string | null
  const models = async (): Promise<Json> => {
    // A changed file is a fresh config read.
    writeFileSync(join(s.state, 'config.yaml'), `# ${JSON.stringify(config)}\n`)
    s.deps.catalog.invalidate()
    return json(await s.get('/api/models'))
  }

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-test-1234' })
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
    sidecar.respond('providers.auth_status', (p) => ({ status: { logged_in: false, provider: p.provider ?? '' } }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'anthropic' ? ['claude-sonnet-4-6'] : [] }))
    sidecar.respond('providers.local_models', () => ({ provider_id: 'llamacpp', models: staged, current_endpoint: endpoint }))
  })
  beforeEach(() => {
    config = { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } }
    staged = [STAGED]
    endpoint = null
  })
  afterAll(() => s.close())

  it('a staged GGUF is a Local group; with nothing staged no group appears', async () => {
    const groups = (await models()).groups as Group[]
    expect(groups[0]).toMatchObject({ provider_id: 'anthropic' })
    expect(groups.find((g) => g.provider_id === 'llamacpp')).toMatchObject({ provider: 'Local', provider_id: 'llamacpp', models: [expect.objectContaining({ id: `@llamacpp:${STAGED}`, label: STAGED, provider_id: 'llamacpp', bare_id: STAGED })] })

    staged = []
    expect(((await models()).groups as Group[]).some((g) => g.provider_id === 'llamacpp')).toBe(false)
  })

  it('a profile on a llama.cpp alias, or on the running server\'s endpoint, has the Local group active', async () => {
    for (const provider of ['llamacpp', 'llama.cpp', 'llama-cpp']) {
      config = { model: { default: STAGED, provider } }
      const catalog = await models()
      expect(catalog).toMatchObject({ active_provider: 'llamacpp', default_provider_id: 'llamacpp' })
      expect((catalog.groups as Group[])[0]).toMatchObject({ provider: 'Local', provider_id: 'llamacpp', models: [{ id: STAGED }] })
    }
    endpoint = 'http://127.0.0.1:8781/v1'
    config = { model: { default: STAGED, provider: 'custom', base_url: 'http://127.0.0.1:8781/v1/' } }
    const catalog = await models()
    expect(catalog.active_provider).toBe('llamacpp')
    const groups = catalog.groups as Group[]
    expect(groups[0]).toMatchObject({ provider_id: 'llamacpp', models: [{ id: STAGED }] })
    expect(groups.some((g) => g.provider_id === 'custom')).toBe(false)
  })

  it('a failed listing leaves every other provider usable', async () => {
    sidecar.respond('providers.local_models', () => { throw new SidecarError('local runtime unavailable', { condition: 'providers_unavailable' }) })
    try {
      const groups = (await models()).groups as Group[]
      expect(groups[0]).toMatchObject({ provider_id: 'anthropic' })
      expect(groups.some((g) => g.provider_id === 'llamacpp')).toBe(false)
    } finally {
      sidecar.respond('providers.local_models', () => ({ provider_id: 'llamacpp', models: staged, current_endpoint: endpoint }))
    }
  })

  it('selecting a local model starts the turn on the llamacpp provider with its bare model', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    let started: Json | null = null
    sidecar.respond('chat.start', (params) => {
      started = params
      return { status: 'completed', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: STAGED, provider: 'llamacpp', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }
    })
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'hi', model: `@llamacpp:${STAGED}`, model_provider: 'llamacpp' })
    expect(res.status).toBe(200)
    await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}`, (f) => f.event === 'stream_end')
    expect(started).toMatchObject({ model: STAGED, model_provider: 'llamacpp' })
    expect((await s.deps.sessionStore.get(sid))).toMatchObject({ model: STAGED, model_provider: 'llamacpp' })
  })

  it('a turn while the local server is off says so instead of asking for a key', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    sidecar.respond('chat.start', () => { throw new SidecarError('The local model server is turned off.', { condition: 'local_runtime_unavailable' }) })
    const res = await post(s, '/api/chat/start', { session_id: sid, message: 'hi', model: `@llamacpp:${STAGED}`, model_provider: 'llamacpp' })
    const frames = await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}&replay=1`, (f) => f.event === 'apperror')
    const error = frames.find((f) => f.event === 'apperror')?.data as Json
    expect(error).toMatchObject({ type: 'local_runtime_unavailable', message: 'The local model server is turned off.' })
    expect(String(error.hint)).not.toMatch(/credential|API key/i)
  })
})
