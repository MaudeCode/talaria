/**
 * Nous picker signals, import scrubbing, ephemeral turn projection, and
 * runner event projection regressions.
 */
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { atomicWriteText, atomicWriteTextAsync } from '../fs/atomic.js'
import { AgentConfig, ConfigUnavailable } from '../config/agent-config.js'
import { probeServer } from '../tools/mcp-health.js'
import { agentHealth } from '../tools/health.js'
import { githubJson } from '../tools/updates.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

  it('a logged-in Nous account puts the Nous group in the picker', async () => {
    loggedIn = true
    liveIds = ['Hermes-4-70B', 'Hermes-4-405B']
    const nous = (await groups()).find((g) => g.provider_id === 'nous')
    expect(nous?.models.map((m) => m.id.replace(/^@nous:/, ''))).toEqual(['Hermes-4-70B', 'Hermes-4-405B'])
  })

  it('without a key or a login the Nous group is absent', async () => {
    loggedIn = false
    liveIds = ['Hermes-4-70B']
    expect((await groups()).map((g) => g.provider_id)).not.toContain('nous')
  })

  it('a logged-in account with an empty live catalog shows no Nous group', async () => {
    loggedIn = true
    liveIds = []
    expect((await groups()).map((g) => g.provider_id)).not.toContain('nous')
  })

  it('when the live lookup fails the curated Nous models answer', async () => {
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

  it('an import drops provider sidecars and row-id aliases but keeps nested alias-named keys', async () => {
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

  it('a non-list tool_calls answers 400 and creates nothing', async () => {
    const before = s.deps.sessionStore.persistedIds().size
    const res = await post(s, '/api/session/import', { messages: [{ role: 'user', content: 'hi' }], tool_calls: { name: 'not a list' } })
    expect(res.status).toBe(400)
    expect(s.deps.sessionStore.persistedIds().size).toBe(before)
  })

  it('a btw turn ends with only role and content per message', async () => {
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

  it('session snapshots inside runner events lose api_content but keep the envelope', () => {
    const out = projectRunnerEventPayload({ id: 'evt', status: 'running', session: { session_id: 's', messages: [message] } }) as Json
    expect(out.status).toBe('running')
    expect(((out.session as Json).messages as Json[])[0]).toEqual({ role: 'assistant', content: 'visible' })
  })

  it('a bare message-shaped payload is projected the same way', () => {
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
    // The rename response waits for the state.db acknowledgement, so an immediate insights read sees the new title.
    let ackSync: () => void = () => undefined
    sidecar.respond('state_db.sync_title', (params) => new Promise((resolve) => { ackSync = () => { synced.push(params); resolve({ ok: true as const }) } }))
    const renaming = post(s, '/api/session/rename', { session_id: sid, title: 'loud' })
    let settled = false
    void renaming.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 60))
    expect(settled).toBe(false)
    ackSync()
    expect((await renaming).status).toBe(200)
    sidecar.respond('state_db.sync_title', (params) => { synced.push(params); return { ok: true as const } })
    expect(synced.at(-1)).toMatchObject({ session_id: sid, title: 'loud', profile_home: s.state })
    // Regenerating a manually named session applies the full generated-title transition (manual flag cleared,
    // generated flag set) and syncs the new title the same way a rename does.
    const manual = s.deps.sessionStore.get(sid)
    manual.messages = [{ role: 'user', content: 'How do I rotate the deploy key on the staging cluster safely?' }, { role: 'assistant', content: 'Rotate it in two steps: add the new key, then remove the old one once every node picked it up.' }]
    s.deps.sessionStore.save(manual)
    expect(s.deps.sessionStore.get(sid).manual_title).toBe(true)
    sidecar.respond('aux.complete', () => ({ model: 'aux', text: 'Rotate staging deploy key', usage: null }))
    const regenerated = await post(s, '/api/session/title/regenerate', { session_id: sid })
    expect(regenerated.status, await regenerated.clone().text()).toBe(200)
    expect((await json(regenerated)).title).toBe('Rotate staging deploy key')
    const after = s.deps.sessionStore.get(sid)
    expect([after.title, after.manual_title, after.llm_title_generated]).toEqual(['Rotate staging deploy key', false, true])
    await new Promise((r) => setTimeout(r, 20))
    expect(synced.at(-1)).toMatchObject({ session_id: sid, title: 'Rotate staging deploy key' })
    await s.deps.settings.save({ sync_to_insights: false })
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
  // TAL-276 tests swap the Agent's answer; every later test gets the default one back.
  const agentAnswer = (params: Record<string, unknown>) => { sent = params.user_message; return { status: 'completed' as const, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } }
  afterEach(() => { sidecar.respond('chat.start', agentAnswer) })
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

  /** One settled turn whose Agent transcript echoes the prompt it was given, as the real Agent persists it. */
  const echoTurn = async (message: string, attachments: Json[]): Promise<{ sid: string; prompt: unknown; users: Json[] }> => {
    sent = null
    sidecar.respond('chat.start', (params) => { sent = params.user_message; return { status: 'completed', messages: [{ role: 'user', content: params.user_message }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] } })
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const res = await post(s, '/api/chat/start', { session_id: sid, message, attachments })
    expect(res.status).toBe(200)
    await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    const users = (((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]).filter((m) => m.role === 'user')
    return { sid, prompt: sent, users }
  }

  it('admits an image-only turn as one empty user row carrying the image, and still refuses an empty turn (TAL-276)', async () => {
    mode = 'native'
    writeFileSync(join(ws(), 'only.png'), png)
    const { sid, prompt, users } = await echoTurn('  ', [{ path: join(ws(), 'only.png'), mime: 'image/png', name: 'only.png' }])
    // The image rides natively, and the text part names it too.
    expect((prompt as Json[])[1]).toMatchObject({ type: 'image_url' })
    expect(String((prompt as Json[])[0]!.text)).toContain(`[Attached files: ${join(ws(), 'only.png')}]`)
    expect(users).toHaveLength(1)
    expect(users[0]!.content).toBe('')
    expect((users[0]!.attachments as Json[]).map((a) => a.name)).toEqual(['only.png'])
    const empty = await post(s, '/api/chat/start', { session_id: sid, message: ' ', attachments: [] })
    expect(empty.status).toBe(400)
    expect(JSON.stringify(await json(empty))).toContain('message is required')
    // An attachment with no file behind it is no content either.
    expect((await post(s, '/api/chat/start', { session_id: sid, message: '', attachments: [{}, 'name-only'] })).status).toBe(400)
  })

  it('names attached files in the model prompt, and shows only the typed text (TAL-276)', async () => {
    mode = 'native'
    const doc = join(ws(), 'notes.pdf')
    const only = await echoTurn('', [{ path: doc, mime: 'application/pdf', name: 'notes.pdf' }])
    expect(String(only.prompt)).toMatch(/^\[Workspace::v1: [^\]]+\]\n/)
    expect(String(only.prompt).endsWith(`]\n\n\n[Attached files: ${doc}]`)).toBe(true)
    expect(only.users).toHaveLength(1)
    expect(only.users[0]!.content).toBe('')
    expect((only.users[0]!.attachments as Json[]).map((a) => a.name)).toEqual(['notes.pdf'])
    const typed = await echoTurn('summarise this', [{ path: doc, mime: 'application/pdf', name: 'notes.pdf' }])
    expect(String(typed.prompt)).toMatch(/summarise this\n\n\[Attached files: .*notes\.pdf\]$/)
    expect(typed.users).toHaveLength(1)
    expect(typed.users[0]!.content).toBe('summarise this')
    // A text-mode model gets the image's path the same way.
    mode = 'text'
    writeFileSync(join(ws(), 'textmode.png'), png)
    const image = await echoTurn('', [{ path: join(ws(), 'textmode.png'), mime: 'image/png', name: 'textmode.png' }])
    expect(String(image.prompt)).toContain(`[Attached files: ${join(ws(), 'textmode.png')}]`)
    expect(image.users[0]!.content).toBe('')
    mode = 'native'
  })

  it('keeps two attachment-only turns apart when the Agent answers both the same (TAL-276)', async () => {
    mode = 'native'
    const reply = (params: Record<string, unknown>) => ({ status: 'completed' as const, messages: [...(params.conversation_history as Json[]), { role: 'user', content: params.user_message }, { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] })
    sidecar.respond('chat.start', reply)
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    for (const name of ['a.pdf', 'b.pdf']) {
      const res = await post(s, '/api/chat/start', { session_id: sid, message: '', attachments: [{ path: join(ws(), name), mime: 'application/pdf', name }] })
      await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    }
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages.filter((m) => m.role === 'user').map((m) => (m.attachments as Json[]).map((a) => a.name))).toEqual([['a.pdf'], ['b.pdf']])
  })

  it('keeps each attachment-only prompt when the Agent returns only its answer (TAL-276)', async () => {
    mode = 'native'
    sidecar.respond('chat.start', (params) => ({ status: 'completed' as const, messages: [...(params.conversation_history as Json[]), { role: 'assistant', content: 'ok' }], final_response: 'ok', error: null, result_status: 'completed', tool_limit_reached: false, usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] }))
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    for (const name of ['c.pdf', 'd.pdf']) {
      const res = await post(s, '/api/chat/start', { session_id: sid, message: '', attachments: [{ path: join(ws(), name), mime: 'application/pdf', name }] })
      await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    }
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages as Json[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages.filter((m) => m.role === 'user').map((m) => (m.attachments as Json[]).map((a) => a.name))).toEqual([['c.pdf'], ['d.pdf']])
  })

  it('keeps an attachment-only prompt when its turn fails or its stream goes stale (TAL-276)', async () => {
    mode = 'native'
    const doc = { path: join(ws(), 'kept.pdf'), mime: 'application/pdf', name: 'kept.pdf' }
    sidecar.respond('chat.start', () => { throw new SidecarError('provider down', { condition: 'provider_error' }) })
    const failed = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const res = await post(s, '/api/chat/start', { session_id: failed, message: '', attachments: [doc] })
    await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    const afterError = ((await json(await s.get(`/api/session?session_id=${failed}`))).session as Json).messages as Json[]
    expect(afterError.filter((m) => m.role === 'user').map((m) => (m.attachments as Json[]).map((a) => a.name))).toEqual([['kept.pdf']])
    // A stream that died with the server: recovery turns the in-flight prompt into a durable row.
    const stale = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = s.deps.sessionStore.get(stale)
    Object.assign(session, { active_stream_id: 'dead-stream', pending_user_message: '', pending_attachments: [doc], pending_started_at: Date.now() / 1000 - 120 })
    s.deps.sessionStore.save(session)
    expect(s.deps.sessions.clearStaleStreamState(s.deps.sessionStore.get(stale))).toBe(true)
    const recovered = s.deps.sessionStore.get(stale).messages
    expect(recovered.filter((m) => m.role === 'user').map((m) => (m.attachments as Json[]).map((a) => a.name))).toEqual([['kept.pdf']])
  })

  it('sends plain text when the Agent resolves text mode for the model', async () => {
    mode = 'text'
    writeFileSync(join(ws(), 'shot2.png'), png)
    const message = await turn([{ path: join(ws(), 'shot2.png'), mime: 'image/png', name: 'shot2.png' }])
    expect(typeof message).toBe('string')
  })

  it('an unknown vision capability forwards natively, and BMP/SVG attachments are accepted', async () => {
    // Canonical "text" with `supports_vision: null` and no explicit text signal → native (the Agent retries on rejection).
    sidecar.respond('text.image_mode', () => ({ mode: 'text', reason: 'unknown model', supports_vision: null }))
    writeFileSync(join(ws(), 'unknown.png'), png)
    let message = await turn([{ path: join(ws(), 'unknown.png'), mime: 'image/png', name: 'unknown.png' }])
    expect(Array.isArray(message)).toBe(true)
    writeFileSync(join(ws(), 'pic.bmp'), Buffer.from('BM' + '\u0000'.repeat(40), 'latin1'))
    writeFileSync(join(ws(), 'pic.svg'), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
    message = await turn([{ path: join(ws(), 'pic.bmp'), mime: 'image/bmp', name: 'pic.bmp' }, { path: join(ws(), 'pic.svg'), mime: 'image/svg+xml', name: 'pic.svg' }])
    const urls = (message as { type: string; image_url?: { url: string } }[]).filter((p) => p.type === 'image_url').map((p) => p.image_url?.url.split(';')[0])
    expect(urls).toEqual(['data:image/bmp', 'data:image/svg+xml'])
    sidecar.respond('text.image_mode', () => ({ mode, reason: 'test', supports_vision: mode === 'native' }))
  })

  it('a cancel during a hung image-mode lookup releases the session promptly instead of waiting for the sidecar', async () => {
    mode = 'native'
    writeFileSync(join(ws(), 'slow.png'), png)
    let release: (() => void) | null = null
    sidecar.respond('text.image_mode', () => new Promise((resolve) => { release = () => { resolve({ mode: 'native', reason: 'late', supports_vision: true }) } }))
    try {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      const started = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'look', attachments: [{ path: join(ws(), 'slow.png'), mime: 'image/png', name: 'slow.png' }] }))
      const streamId = String(started.stream_id)
      expect((await post(s, '/api/chat/start', { session_id: sid, message: 'again' })).status).toBe(409)
      expect(await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).toMatchObject({ ok: true, cancelled: true })
      // The turn reaches teardown without the lookup ever answering, so a new turn is admitted.
      const deadline = Date.now() + 5000
      let res = await post(s, '/api/chat/start', { session_id: sid, message: 'after cancel' })
      while (res.status === 409 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 25)); res = await post(s, '/api/chat/start', { session_id: sid, message: 'after cancel' }) }
      expect(res.status).toBe(200)
      await s.sse(`/api/chat/stream?stream_id=${String((await json(res)).stream_id)}&replay=1`, (f) => f.event === 'done' || f.event === 'apperror')
    } finally {
      (release as (() => void) | null)?.()
      sidecar.respond('text.image_mode', () => ({ mode, reason: 'test', supports_vision: mode === 'native' }))
    }
  })

  it('a cancel that lands before the image-mode lookup starts never waits on the sidecar', async () => {
    mode = 'native'
    writeFileSync(join(ws(), 'pre.png'), png)
    let lookups = 0
    sidecar.respond('text.image_mode', () => { lookups += 1; return new Promise(() => undefined) })
    try {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      const session = s.deps.sessionStore.get(sid)
      const controller = new AbortController()
      controller.abort()
      interface Builder { buildUserMessage: (ctx: string, text: string, atts: Record<string, unknown>[], workspace: string, sid: string, session: unknown, opts: Record<string, unknown>, signal: AbortSignal) => Promise<unknown> }
      const built = await (s.deps.turns as unknown as Builder).buildUserMessage('', 'look', [{ path: join(ws(), 'pre.png'), mime: 'image/png', name: 'pre.png' }], ws(), sid, session, {}, controller.signal)
      expect(built).toBe('look')
      expect(lookups).toBe(0)
    } finally {
      sidecar.respond('text.image_mode', () => ({ mode, reason: 'test', supports_vision: mode === 'native' }))
    }
  })

  it('never embeds a symlink or hard link out of the workspace or a non-image labelled as an image', async () => {
    mode = 'native'
    writeFileSync(join(s.state, 'secret.env'), 'TOKEN=leak\n')
    symlinkSync(join(s.state, 'secret.env'), join(ws(), 'looks-like.png'))
    writeFileSync(join(ws(), 'notes.png'), 'just text, not an image')
    writeFileSync(join(s.state, 'private.png'), png)
    linkSync(join(s.state, 'private.png'), join(ws(), 'hard-link.png'))
    const message = await turn([{ path: join(ws(), 'looks-like.png'), mime: 'image/png', name: 'looks-like.png' }, { path: join(ws(), 'notes.png'), mime: 'image/png', name: 'notes.png' }, { path: join(ws(), 'hard-link.png'), mime: 'image/png', name: 'hard-link.png' }])
    expect(typeof message).toBe('string')
    expect(String(message)).not.toContain('leak')
  })
})

describe('atomic writes honour the umask for new files', () => {
  it('a new file is created under the process umask while an existing mode is preserved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-atomic-'))
    const previous = process.umask(0o077)
    try {
      atomicWriteText(join(dir, 'fresh.json'), '{}')
      expect(statSync(join(dir, 'fresh.json')).mode & 0o777).toBe(0o600)
      writeFileSync(join(dir, 'open.json'), '{}', { mode: 0o644 })
      chmodSync(join(dir, 'open.json'), 0o644)
      atomicWriteText(join(dir, 'open.json'), '{"a":1}')
      expect(statSync(join(dir, 'open.json')).mode & 0o777).toBe(0o644)
      await atomicWriteTextAsync(join(dir, 'fresh-async.json'), '{}')
      expect(statSync(join(dir, 'fresh-async.json')).mode & 0o777).toBe(0o600)
      await atomicWriteTextAsync(join(dir, 'open.json'), '{"a":2}')
      expect(statSync(join(dir, 'open.json')).mode & 0o777).toBe(0o644)
    } finally {
      process.umask(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('config path override (review round 39)', () => {
  it('HERMES_CONFIG_PATH is the file the sidecar reads, writes, and the server fingerprints', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    const override = join(home, 'managed', 'override.yaml')
    mkdirSync(join(home, 'managed'))
    writeFileSync(override, 'webui_oidc:\n  issuer: https://idp.example\n')
    const sidecar = new FakeSidecar()
    const seen: string[] = []
    sidecar.respond('config.get', (params) => { seen.push(params.config_path); return { path: params.config_path, exists: true, config: { webui_oidc: { issuer: 'https://idp.example' } } } })
    sidecar.respond('config.set', (params) => { seen.push(params.config_path); writeFileSync(params.config_path, `# ${String(Math.random())}\n`); return { ok: true as const, path: params.config_path } })
    const config = new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: override } })
    expect(config.path(home)).toBe(override)
    // No <home>/config.yaml: without the override the read would short-circuit to {} and never reach the sidecar.
    expect(((await config.read(home)).webui_oidc as Json).issuer).toBe('https://idp.example')
    await config.update(home, (c) => { c.max_tokens = 1 })
    expect(seen).toEqual([override, override])
    expect(new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: '~/x.yaml' } }).path(home)).toBe(join(homedir(), 'x.yaml'))
    rmSync(home, { recursive: true, force: true })
  })
})

describe('config file readability and shared-override locking (review round 40)', () => {
  it.skipIf(process.getuid?.() === 0)('an unreadable config.yaml is unavailable, never an empty config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    const dir = join(home, 'locked')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.yaml'), 'webui_oidc:\n  issuer: https://idp.example\n')
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', () => { throw new Error('must not be reached') })
    const config = new AgentConfig({ sidecar: () => sidecar, env: {} })
    chmodSync(dir, 0o000)
    try {
      await expect(config.read(dir)).rejects.toThrow(ConfigUnavailable)
      expect(config.peek(dir)).toBeNull()
    } finally {
      chmodSync(dir, 0o700)
      rmSync(home, { recursive: true, force: true })
    }
    // A genuinely absent file is still the empty config.
    expect(await config.read(join(tmpdir(), 'talaria-absent-home'))).toEqual({})
  })

  it('updates from different homes that share an HERMES_CONFIG_PATH override serialise on the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    const override = join(root, 'shared.yaml')
    writeFileSync(override, '# 0\n')
    let stored: Json = {}
    let n = 0
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => ({ path: params.config_path, exists: true, config: structuredClone(stored) }))
    sidecar.respond('config.set', async (params) => {
      await new Promise((r) => setTimeout(r, 5))
      stored = params.config
      n += 1
      const t = Date.now() / 1000 + n
      writeFileSync(override, `# ${String(n)}\n`)
      utimesSync(override, t, t)
      return { ok: true as const, path: params.config_path }
    })
    const config = new AgentConfig({ sidecar: () => sidecar, env: { HERMES_CONFIG_PATH: override } })
    await Promise.all([config.update(join(root, 'a'), (c) => { c.from_a = 1 }), config.update(join(root, 'b'), (c) => { c.from_b = 1 })])
    expect(stored).toEqual({ from_a: 1, from_b: 1 })
    config.invalidate(join(root, 'a'))
    expect(config.peek(join(root, 'b'))).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('config snapshot fingerprint (review round 15)', () => {
  it('a config.yaml replaced during the read is re-read, and reported unavailable if it keeps changing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-cfg-'))
    writeFileSync(join(home, 'config.yaml'), 'terminal:\n  backend: local\n')
    let calls = 0
    const sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => {
      calls += 1
      // Simulate an atomic replacement landing while the RPC is in flight: first answer is the old contents.
      if (calls === 1) { const t = Date.now() / 1000 + 5; writeFileSync(join(home, 'config.yaml'), 'terminal:\n  backend: ssh\n'); utimesSync(join(home, 'config.yaml'), t, t); return { path: join(params.profile_home, 'config.yaml'), exists: true, config: { terminal: { backend: 'local' } } } }
      return { path: join(params.profile_home, 'config.yaml'), exists: true, config: { terminal: { backend: 'ssh' } } }
    })
    const config = new AgentConfig({ sidecar: () => sidecar, env: {} })
    const first = await config.read(home)
    expect(calls).toBe(2)
    expect((first.terminal as Json).backend).toBe('ssh')
    expect((config.peek(home)?.terminal as Json).backend).toBe('ssh')
    // A file that keeps changing under the reader is unavailable rather than cached under the wrong key.
    let n = 0
    sidecar.respond('config.get', (params) => { n += 1; const t = Date.now() / 1000 + 10 + n; writeFileSync(join(home, 'config.yaml'), `# ${String(n)}\n`); utimesSync(join(home, 'config.yaml'), t, t); return { path: join(params.profile_home, 'config.yaml'), exists: true, config: {} } })
    config.invalidate()
    await expect(config.read(home)).rejects.toThrow(/changed while it was being read/)
    expect(config.peek(home)).toBeNull()
    rmSync(home, { recursive: true, force: true })
  })
})

describe('onboarding probe cap (review round 16)', () => {
  it('an unbounded model-list response is cut off at the cap instead of buffered', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar, deps: (deps) => {
      (deps as { fetch: typeof fetch }).fetch = () => Promise.resolve(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)) } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      ;(deps.onboarding as unknown as { deps: { fetch?: typeof fetch } }).deps.fetch = deps.fetch
    } })
    try {
      const res = await post(s, '/api/onboarding/probe', { provider: 'custom', base_url: 'http://127.0.0.1:9/v1' })
      expect(await json(res)).toMatchObject({ ok: false, error: 'parse', detail: expect.stringContaining('exceeded') as unknown })
    } finally { await s.close() }
  })
})

describe('upstream probe caps', () => {
  const endless = (): Response => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)) } }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('the MCP health probe stops reading past its body cap', async () => {
    const started = Date.now()
    const [state] = await probeServer({ url: 'https://mcp.example/mcp' }, () => Promise.resolve(endless()))
    expect(Date.now() - started).toBeLessThan(5000)
    expect(state).not.toBe('healthy')
  })

  it('the remote gateway health probe stops reading past its body cap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-gw-'))
    try {
      const result = await agentHealth({ env: { HERMES_WEBUI_CHAT_BACKEND: 'gateway', HERMES_WEBUI_GATEWAY_URL: 'https://gw.example' }, hermesHome: home, profileHome: () => home, fetch: () => () => Promise.resolve(endless()), now: () => Date.now() / 1000 })
      expect(JSON.stringify(result)).not.toContain('gateway_state')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('the release metadata fetch aborts past two megabytes', async () => {
    const getJson = githubJson(() => Promise.resolve(endless()), {})
    await expect(getJson('/repos/x/y/releases/latest', { asset: false })).rejects.toThrow(/download limit/)
  })
})
