/**
 * One-to-one ports of the remaining Python regression cases (TAL-245): the
 * Nous picker signals, import scrubbing, ephemeral turn projection, and
 * runner event projection. Markers `[py:<file>::<case>]` are verified by
 * scripts/check-regression-port.js.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteText } from '../fs/atomic.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { writeEnvFile } from '../providers/env-file.js'
import { projectRunnerEventPayload } from '../api/automation-raw.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

describe('Nous picker signals', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let loggedIn = false
  let liveIds: string[] | Error = []
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'anthropic', default: 'claude-sonnet-4-6' } } }))
    sidecar.respond('providers.auth_status', (params) => ({ status: params.provider === 'nous' ? { logged_in: loggedIn, error: loggedIn ? null : 'not logged in' } : { logged_in: false, error: 'not logged in' } }))
    sidecar.respond('providers.model_ids', (params) => { if (liveIds instanceof Error) throw liveIds; return { provider: params.provider, model_ids: params.provider === 'nous' ? liveIds : [] } })
    s = await bootTestServer({ sidecar })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    writeEnvFile(join(s.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-1234' })
  })
  afterAll(() => s.close())
  const groups = async (): Promise<{ provider_id: string; models: { id: string }[] }[]> => { s.deps.catalog.invalidate(); return (await json(await s.get('/api/models'))).groups as { provider_id: string; models: { id: string }[] }[] }

  it('[py:test_issue1567_nous_picker_capacity_and_symmetry.py::test_picker_includes_nous_when_get_auth_status_logged_in] a logged-in Nous account puts the Nous group in the picker', async () => {
    loggedIn = true
    liveIds = ['Hermes-4-70B', 'Hermes-4-405B']
    const nous = (await groups()).find((g) => g.provider_id === 'nous')
    expect(nous?.models.map((m) => m.id.replace(/^@nous:/, ''))).toEqual(['Hermes-4-70B', 'Hermes-4-405B'])
  })

  it('[py:test_issue1567_nous_picker_capacity_and_symmetry.py::test_picker_omits_nous_when_both_auth_signals_false] without a key or a login the Nous group is absent', async () => {
    loggedIn = false
    liveIds = ['Hermes-4-70B']
    expect((await groups()).map((g) => g.provider_id)).not.toContain('nous')
  })

  it('[py:test_issue1567_nous_picker_capacity_and_symmetry.py::test_authenticated_empty_catalog_omits_nous_group] a logged-in account with an empty live catalog shows no Nous group', async () => {
    loggedIn = true
    liveIds = []
    expect((await groups()).map((g) => g.provider_id)).not.toContain('nous')
  })

  it('[py:test_issue1567_nous_picker_capacity_and_symmetry.py::test_hermes_cli_unavailable_falls_back_to_static_4] when the live lookup fails the curated Nous models answer', async () => {
    loggedIn = true
    liveIds = new SidecarError('hermes_cli unavailable', { condition: 'sidecar_error' })
    const nous = (await groups()).find((g) => g.provider_id === 'nous')
    expect(nous).toBeDefined()
    expect(nous!.models.length).toBeGreaterThanOrEqual(4)
    expect(nous!.models.every((m) => m.id.startsWith('@nous:'))).toBe(true)
  })
})

describe('import scrubbing and ephemeral projection', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => { sidecar = new FakeSidecar(); s = await bootTestServer({ sidecar }) })
  afterAll(() => s.close())

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_json_import_strips_internal_aliases_before_persistence] an import drops provider sidecars and row-id aliases but keeps nested alias-named keys', async () => {
    const res = await post(s, '/api/session/import', {
      messages: [{ role: 'user', content: { text: 'hi', api_content: 'nested stays' }, api_content: 'provider only', _state_db_row_id: 4, state_db_row_id: 5 }, { role: 'assistant', content: 'yo', _db_row_id: 6 }],
      tool_calls: [{ name: 'read', api_content: 'gone', _state_db_row_id: 7 }],
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const sid = String(((await json(res)).session as Json).session_id)
    const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
    const messages = raw.messages as Json[]
    for (const m of messages) for (const k of ['api_content', '_state_db_row_id', 'state_db_row_id', '_db_row_id']) expect(m, k).not.toHaveProperty(k)
    expect((messages[0]!.content as Json).api_content).toBe('nested stays')
    expect((raw.tool_calls as Json[])[0]).not.toHaveProperty('api_content')
    expect((raw.tool_calls as Json[])[0]).not.toHaveProperty('_state_db_row_id')
  })

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_json_import_rejects_non_list_session_tool_calls] a non-list tool_calls answers 400 and creates nothing', async () => {
    const before = s.deps.sessionStore.persistedIds().size
    const res = await post(s, '/api/session/import', { messages: [{ role: 'user', content: 'hi' }], tool_calls: { name: 'not a list' } })
    expect(res.status).toBe(400)
    expect(s.deps.sessionStore.persistedIds().size).toBe(before)
  })

  it('[py:test_issue6751_api_content_agent_replay.py::test_issue6751_ephemeral_terminal_sse_projects_agent_messages] a btw turn ends with only role and content per message', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    sidecar.respond('chat.start', (params) => ({
      status: 'completed', messages: [{ role: 'user', content: str(params.user_message), api_content: 'secret', _state_db_row_id: 1 }, { role: 'assistant', content: 'because', api_content: 'secret' }], final_response: 'because', error: null, result_status: 'completed',
      tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
    }))
    const started = await json(await post(s, '/api/btw', { session_id: sid, question: 'why?' }))
    const frames = await s.sse(`/api/chat/stream?stream_id=${String(started.stream_id)}&replay=1`, (f) => f.event === 'done')
    const done = frames.find((f) => f.event === 'done')?.data as Json
    expect(done.ephemeral).toBe(true)
    const session = done.session as Json
    expect(session.session_id).toBe(started.session_id)
    expect(session.messages).toEqual([{ role: 'user', content: expect.any(String) as unknown }, { role: 'assistant', content: 'because' }])
    expect(existsSync(join(s.state, 'sessions', `${String(started.session_id)}.json`))).toBe(false)
  })
})

describe('runner event projection', () => {
  const message = { role: 'assistant', content: 'visible', api_content: 'provider', _state_db_row_id: 3 }

  it('[py:test_issue6757_redaction_and_runner_sse_fixes.py::test_project_runner_event_payload_strips_api_content_from_session] session snapshots inside runner events lose api_content but keep the envelope', () => {
    const out = projectRunnerEventPayload({ id: 'evt', status: 'running', session: { session_id: 's', messages: [message] } }) as Json
    expect(out.status).toBe('running')
    expect(((out.session as Json).messages as Json[])[0]).toEqual({ role: 'assistant', content: 'visible' })
  })

  it('[py:test_issue6757_redaction_and_runner_sse_fixes.py::test_project_runner_event_payload_strips_api_content_from_message_shaped] a bare message-shaped payload is projected the same way', () => {
    const out = projectRunnerEventPayload({ id: 'evt', messages: [message] }) as Json
    expect(out.id).toBe('evt')
    expect((out.messages as Json[])[0]).toEqual({ role: 'assistant', content: 'visible' })
  })
})

describe('runtime seams from review round 10', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const synced: Json[] = []
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('state_db.sync_title', (params) => { synced.push(params); return { ok: true as const } })
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('a provider-qualified model is split before it is persisted or sent to the sidecar', async () => {
    const created = (await json(await post(s, '/api/session/new', { model: '@nous:openai/gpt-5.4-mini' }))).session as Json
    expect(created).toMatchObject({ model: 'openai/gpt-5.4-mini', model_provider: 'nous' })
    let seen: Json | null = null
    sidecar.respond('chat.start', (params) => { seen = params; return { status: 'completed', messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } })
    const started = await json(await post(s, '/api/chat/start', { session_id: created.session_id, message: 'hi', model: '@nous:openai/gpt-5.4-mini' }))
    await s.sse(`/api/chat/stream?stream_id=${String(started.stream_id)}&replay=1`, (f) => f.event === 'done')
    expect(seen).toMatchObject({ model: 'openai/gpt-5.4-mini', model_provider: 'nous' })
    const updated = (await json(await post(s, '/api/session/update', { session_id: created.session_id, model: '@openrouter:anthropic/claude-sonnet-4.6' }))).session as Json
    expect(updated).toMatchObject({ model: 'anthropic/claude-sonnet-4.6', model_provider: 'openrouter' })
  })

  it('renaming a session syncs the title to state.db only when sync_to_insights is on', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    await post(s, '/api/session/rename', { session_id: sid, title: 'quiet' })
    expect(synced).toEqual([])
    await s.deps.settings.save({ sync_to_insights: true })
    await post(s, '/api/session/rename', { session_id: sid, title: 'loud' })
    await new Promise((r) => setTimeout(r, 20))
    expect(synced.at(-1)).toMatchObject({ session_id: sid, title: 'loud', profile_home: s.state })
  })

  it('the bootstrap feature flags come from runtime state', async () => {
    const features = (await json(await s.get('/api/bootstrap'))).features as Json
    expect(features).toEqual({ dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false })
  })

  it('a model switch resolves the context length from the sidecar with the profile config inputs and the detail load reports it', async () => {
    let seenInputs: Json | null = null
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: { model: { provider: 'custom', base_url: 'https://llm.example/v1' }, providers: { custom: { api_key: 'sk-custom-1234', models: [{ id: 'big-model', context_length: 1_000_000 }] } } } }))
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    s.deps.agentConfig.invalidate()
    sidecar.respond('models.context_length', (params) => { seenInputs = params; return { model: params.model, context_length: params.config_context_length ?? 200_000 } })
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const updated = (await json(await post(s, '/api/session/update', { session_id: sid, model: 'big-model', model_provider: 'custom' }))).session as Json
    expect(updated.context_length).toBe(1_000_000)
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect(detail.context_length).toBe(1_000_000)
    expect(s.deps.sessions.deps.contextLengthFor('big-model', 'custom')).toBe(1_000_000)
    expect(seenInputs).toMatchObject({ model: 'big-model', provider: 'custom', base_url: 'https://llm.example/v1', api_key: 'sk-custom-1234', config_context_length: 1_000_000 })
  })

  it('the per-identity stream budget defaults to eight', () => {
    const claims: (() => void)[] = []
    for (let i = 0; i < 8; i += 1) { const c = s.deps.streamSlots.claim('one'); expect(c, String(i)).not.toBeNull(); if (c) claims.push(c) }
    expect(s.deps.streamSlots.claim('one')).toBeNull()
    expect(s.deps.streamSlots.claim('two')).not.toBeNull()
    for (const c of claims) c()
  })
})

describe('image attachments in user messages (review round 14)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let mode: 'native' | 'text' = 'native'
  let sent: unknown = null
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('text.image_mode', () => ({ mode, reason: 'test', supports_vision: mode === 'native' }))
    sidecar.respond('chat.start', (params) => { sent = params.user_message; return { status: 'completed', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } })
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)])
  const turn = async (attachments: Json[]): Promise<unknown> => {
    sent = null
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const started = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'look', attachments }))
    await s.sse(`/api/chat/stream?stream_id=${String(started.stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    return sent
  }
  const ws = (): string => join(s.state, 'workspace')

  it('embeds a real image from the workspace as a native part when the Agent resolves native mode', async () => {
    mode = 'native'
    writeFileSync(join(ws(), 'shot.png'), png)
    const message = (await turn([{ path: join(ws(), 'shot.png'), mime: 'image/png', name: 'shot.png' }])) as Json[]
    expect(Array.isArray(message)).toBe(true)
    expect(message[1]).toMatchObject({ type: 'image_url' })
    expect(String((message[1]!.image_url as Json).url)).toMatch(/^data:image\/png;base64,/)
  })

  it('sends plain text when the Agent resolves text mode for the model', async () => {
    mode = 'text'
    writeFileSync(join(ws(), 'shot2.png'), png)
    const message = await turn([{ path: join(ws(), 'shot2.png'), mime: 'image/png', name: 'shot2.png' }])
    expect(typeof message).toBe('string')
  })

  it('never embeds a symlink out of the workspace or a non-image labelled as an image', async () => {
    mode = 'native'
    writeFileSync(join(s.state, 'secret.env'), 'TOKEN=leak\n')
    symlinkSync(join(s.state, 'secret.env'), join(ws(), 'looks-like.png'))
    writeFileSync(join(ws(), 'notes.png'), 'just text, not an image')
    const message = await turn([{ path: join(ws(), 'looks-like.png'), mime: 'image/png', name: 'looks-like.png' }, { path: join(ws(), 'notes.png'), mime: 'image/png', name: 'notes.png' }])
    expect(typeof message).toBe('string')
    expect(String(message)).not.toContain('leak')
  })
})

describe('atomic writes honour the umask for new files', () => {
  it('a new file is created under the process umask while an existing mode is preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-atomic-'))
    const previous = process.umask(0o077)
    try {
      atomicWriteText(join(dir, 'fresh.json'), '{}')
      expect(statSync(join(dir, 'fresh.json')).mode & 0o777).toBe(0o600)
      writeFileSync(join(dir, 'open.json'), '{}', { mode: 0o644 })
      chmodSync(join(dir, 'open.json'), 0o644)
      atomicWriteText(join(dir, 'open.json'), '{"a":1}')
      expect(statSync(join(dir, 'open.json')).mode & 0o777).toBe(0o644)
    } finally {
      process.umask(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
