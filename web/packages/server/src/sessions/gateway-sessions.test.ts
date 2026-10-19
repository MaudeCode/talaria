import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEnvelopeSchema, ClarifyPendingEnvelopeSchema, type GatewaySnapshot, type GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { StreamFrame } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { CANONICAL_READ_ONLY_REASON } from './state-db.js'

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: Record<string, string>; diagnostic: Record<'safe' | 'ignore_config' | 'fresh', string>; schema: string[]; inserts: string[] }
const sid = fixture.sessions.cli!
const snapshot = (extra: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({ session_id: sid, stored_session_id: sid,
  messages: [{ role: 'user', content: 'native question' }, { role: 'assistant', content: 'owner answer' }], message_count: 2,
  running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 4, subscription_id: 'viewer', revision: 2,
  execution_generation: 1, pending: [], prompts: [], info: { title: 'Native chat', model: 'native-model' }, ...extra })
const attached = (snap: GatewaySnapshot): GatewaySessionResult => ({ state: 'attached', reason: null, receipt: null, snapshot: snap })
const admission = (status: 'queued' | 'started' | 'unknown' | 'terminal' = 'started') => ({ admission_id: 'native-input', sequence: 1, status, outcome: null, authority_epoch: 1, execution_generation: 1, text: 'native work', input_id: 'stable-input' })

describe('canonical owner attachment', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await s.deps.settings.save({ show_cli_sessions: true })
  })
  afterEach(async () => { db.close(); await s.close() })
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('opens the canonical transcript through its owner while keeping direct writes fenced', async () => {
    const sid = fixture.sessions.cli!
    sidecar.respond('gateway.session', () => ({ state: 'attached', reason: null, receipt: null, snapshot: {
      session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'native question' }, { role: 'assistant', content: 'owner answer' }],
      message_count: 2, running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 4,
      subscription_id: 'viewer', revision: 2, execution_generation: 1, pending: [], prompts: [], info: { title: 'Native chat', model: 'native-model' },
    } }))
    const response = await s.get(`/api/session?session_id=${sid}`)
    const body = await response.json() as { session: Record<string, unknown> }
    expect(body.session.owner_attachment).toMatchObject({ state: 'attached', can_submit: true })
    expect(body.session.read_only).toBe(true)
    expect(body.session.composer_state_key).toMatch(/^owner-[a-f0-9]{64}$/)
    expect(body.session.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'owner answer' })]))
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('preserves an explicit null provider in the owner model projection', async () => {
    const option = vi.spyOn(s.deps.sessions.deps, 'modelOptionFor').mockImplementation((model, provider) => JSON.stringify([model, provider]))
    const base = { session_id: sid, read_only_reason: CANONICAL_READ_ONLY_REASON, model: 'old-model', model_provider: 'old-backend', workspace: s.state }
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { model: 'native-model', provider: null } })))
    const cleared = await s.deps.sessions.owner!.project(base)
    expect(cleared.model_provider).toBeNull()
    expect(cleared.model_option_id).toBe('["native-model",null]')
    expect(option).toHaveBeenLastCalledWith('native-model', null)
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { model: 'native-model' } })))
    const absent = await s.deps.sessions.owner!.project(base)
    expect(absent.model_provider).toBe('old-backend')
    expect(absent.model_option_id).toBe('["native-model","old-backend"]')
  })

  it('retains the compatibility gate when the installed owner protocol is missing', async () => {
    sidecar.respond('gateway.session', () => ({ state: 'incompatible', reason: 'native_sessions_unavailable', snapshot: null, receipt: null }))
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ state: 'incompatible', can_submit: false, can_interrupt: false })
    expect((await post('/api/chat/start', { session_id: sid, message: 'follow up', submission_id: 'stable' })).status).toBe(403)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toEqual([])
  })

  it('forwards the retained submission identity without materializing a second writer', async () => {
    sidecar.respond('gateway.session', (params) => ({ ...attached(snapshot()), receipt: params.action === 'submit' ? admission('terminal') : null }))
    for (let i = 0; i < 2; i++) {
      const response = await post('/api/chat/start', { session_id: sid, message: 'follow up', submission_id: 'same-request' })
      expect(response.status, await response.text()).toBe(200)
    }
    const calls = sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')
    expect(calls.map((c) => c.params)).toEqual(Array(2).fill(expect.objectContaining({ request_id: 'same-request', session_id: sid, profile_home: s.state })))
    expect(await s.deps.sessionStore.exists(sid)).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('keeps a confirmed admission successful when its post-ACK snapshot becomes unavailable', async () => {
    sidecar.respond('gateway.session', (params) => params.action === 'submit'
      ? { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: admission('queued') }
      : attached(snapshot()))
    const response = await post('/api/chat/start', { session_id: sid, message: 'accepted work', submission_id: 'retained-request' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ admission_id: 'native-input', owner_attachment: { state: 'unavailable', can_submit: false } })
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('holds unknown work until explicit recovery and returns Retry to the draft without submitting', async () => {
    const original = "native work with OPENAI_API_KEY=sk-synthetic-retry-key-123456789012345"
    let snap = snapshot({ pending: [{ ...admission('unknown'), text: original }] })
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'discard') snap = snapshot()
      return { ...attached(snap), receipt: params.action === 'discard' ? admission('terminal') : null }
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ can_submit: false, admissions: [{ actions: ['retry', 'discard'] }] })
    expect((await post('/api/chat/start', { session_id: sid, message: 'retry automatically', submission_id: 'different' })).status).toBe(409)
    const result = await post('/api/chat/owner-action', { session_id: sid, action: 'retry', admission_id: 'native-input', execution_generation: 1 })
    expect(result.status, await result.clone().text()).toBe(200)
    expect(await result.json()).toMatchObject({ draft: original, session: { owner_attachment: { can_submit: true } } })
    expect(sidecar.calls.some((c) => c.method === 'chat.start' || c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toBe(false)
  })

  it.each([undefined, ''])('withholds Retry without recoverable admission text (%s)', async (text) => {
    const lost: GatewaySnapshot['pending'][number] = { ...admission('unknown') }
    if (text === undefined) delete lost.text
    else lost.text = text
    sidecar.respond('gateway.session', () => attached(snapshot({ pending: [lost] })))
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment?.admissions[0]?.actions).toEqual(['discard'])
    const response = await post('/api/chat/owner-action', { session_id: sid, action: 'retry', admission_id: lost.admission_id, execution_generation: 1 })
    expect(response.status).toBe(409)
    expect(sidecar.calls.some((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'discard')).toBe(false)
  })

  it('redacts owner input previews on admission refusals as well as session reads', async () => {
    const secret = 'sk-synthetic-unknown-preview-secret-123456789012345'
    sidecar.respond('gateway.session', () => attached(snapshot({ pending: [{ ...admission('unknown'), text: `OPENAI_API_KEY=${secret}` }] })))
    const response = await post('/api/chat/start', { session_id: sid, message: 'another input', submission_id: 'new-input' })
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain(secret)
  })

  it('refuses incomplete mutations, unsafe workspace selections, file uploads, and blocking chat before owner dispatch', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot()))
    expect((await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'reset', payload: {} })).status).toBe(400)
    expect((await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'workspace', payload: { cwd: '/untrusted-owner-fixture' }, request_id: 'change-workspace', expected_revision: 2, execution_generation: 1 })).status).toBe(400)
    expect((await post('/api/chat/start', { session_id: sid, submission_id: 'image', message: 'file', attachments: [{ path: '/untrusted-owner-fixture/key', mime: 'image/png' }] })).status).toBe(400)
    expect((await post('/api/chat', { session_id: sid, message: 'blocking' })).status).toBe(409)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session').every((call) => (call.params as { action: string }).action === 'snapshot')).toBe(true)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('normalizes approval and clarify through their owner with the prompt generation', async () => {
    const prompts = [
      { kind: 'approval', prompt_id: 'approval-native', execution_generation: 7, command: 'echo fixture', description: 'Approve fixture?', choices: ['once', 'deny'] },
      { kind: 'clarify', prompt_id: 'clarify-native', execution_generation: 7, question: 'Which color?', choices: ['red', 'blue'] },
    ]
    sidecar.respond('gateway.session', () => attached(snapshot({ execution_generation: 7, prompts })))
    const pending = ClarifyPendingEnvelopeSchema.parse(await (await s.get(`/api/clarify/pending?session_id=${sid}`)).json())
    expect(pending.pending?.steps).toMatchObject([{ qid: 'q0', question: 'Which color?', choices: ['red', 'blue'] }])
    expect((await post('/api/clarify/respond', { session_id: sid, clarify_id: 'clarify-native', answers: { q0: 'blue' } })).status).toBe(200)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'approval-native', choice: 'once' })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session').map((c) => c.params)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'clarify', prompt_id: 'clarify-native', execution_generation: 7, text: 'blue' }),
      expect.objectContaining({ action: 'approval', prompt_id: 'approval-native', execution_generation: 7, choice: 'once' }),
    ]))
    expect(sidecar.calls.some((c) => c.method === 'approval.respond' || c.method === 'clarify.respond')).toBe(false)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'expired-native', choice: 'once' })).status).toBe(409)
  })

  it('streams owner events, replaces a replay gap, and settles from its authoritative snapshot', async () => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)); }, { once: true }); })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    expect(stream).toMatch(/^owner-/)
    const read = s.sse(`/api/chat/stream?stream_id=${stream}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1); })
    const event = (type: string, payload: Record<string, unknown>) => { emit!({ event: 'event', data: { type, payload, authority_epoch: 1, execution_generation: 1, session_id: sid } }); }
    event('message.delta', { text: 'before gap' })
    emit!({ event: 'snapshot', data: { ...attached(snap), replay_gap: true } })
    event('message.delta', { text: 'after gap' })
    snap = snapshot()
    // Session-info state uses its own payload stamp after the native execution stamp was cleared.
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    const frames = await read
    expect(frames.filter((f) => f.event === 'token').map((f) => f.data)).toEqual([{ text: 'before gap' }, { text: 'after gap' }])
    expect(frames.some((f) => f.event === 'session_snapshot' && (f.data as { replay_gap: boolean }).replay_gap)).toBe(true)
    const done = frames.find((f) => f.event === 'done')?.data as { session: { messages: { content?: unknown }[] } } | undefined
    expect(done?.session.messages.some((message) => message.content === 'owner answer')).toBe(true)
    expect(await s.deps.sessionStore.exists(sid)).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it('uses the selected home for same-id attachments and redacts pending text', async () => {
    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = new DatabaseSync(otherPath)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      sidecar.respond('gateway.session', (params) => attached(snapshot({ info: { title: params.profile_home }, pending: [{ ...admission('unknown'), text: 'OPENAI_API_KEY=sk-synthetic-private-owner-secret-1234567890' }] })))
      const row = await s.deps.sessions.owner!.project({ session_id: sid, profile: 'work', read_only: true, read_only_reason: CANONICAL_READ_ONLY_REASON })
      const root = await s.deps.sessions.owner!.project({ session_id: sid, profile: 'default', read_only: true, read_only_reason: CANONICAL_READ_ONLY_REASON })
      expect(row.composer_state_key).not.toBe(root.composer_state_key)
      expect(row.title).toBe(join(s.state, 'profiles', 'work'))
      expect(JSON.stringify(row)).not.toContain('sk-synthetic-private-owner-secret-1234567890')
      expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { profile_home: string }).profile_home.endsWith('/profiles/work')).at(-1)?.params).toMatchObject({ profile_home: join(s.state, 'profiles', 'work') })
    } finally { other.close() }
  })

  it('retires an observed queue that is cancelled before any execution starts', async () => {
    let snap = snapshot({ pending: [admission('queued')] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'cancelled' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'cancel')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    expect((await read).some((frame) => frame.event === 'cancel')).toBe(true)
    await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
  })

  it('refuses another profile stream even when both homes contain the same session id', async () => {
    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = new DatabaseSync(otherPath)
    try {
      other.exec(fixture.schema.join('\n'))
      for (const sql of fixture.inserts) other.exec(sql)
      const snap = snapshot({ running: true, pending: [admission()] })
      sidecar.respond('gateway.session', (params, _emit, opts) => params.action === 'watch'
        ? new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) }) : attached(snap))
      const root = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
      const stream = root.session.active_stream_id!
      for (const path of ['/api/chat/stream', '/api/chat/stream/status', '/api/chat/cancel']) {
        const response = await s.get(`${path}?stream_id=${stream}`, { headers: { cookie: 'hermes_profile=work' } })
        expect(response.status, path).toBe(404)
      }
      expect(s.deps.requestScope.run({ requestProfile: 'work' }, () => s.deps.registry.activeRunStreamForSession(sid))).toBeNull()
      await s.deps.sessions.owner!.close()
      // The scope guard still holds for journal replay after the live channel has retired.
      expect((await s.get(`/api/chat/stream?stream_id=${stream}`, { headers: { cookie: 'hermes_profile=work' } })).status).toBe(404)
    } finally { other.close() }
  })
})

describe('diagnostic execution modes (TAL-1040)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  const ids = { cli: fixture.sessions.cli!, ...fixture.diagnostic }
  const fresh = (session: string): GatewaySnapshot => snapshot({ session_id: session, stored_session_id: session, messages: [], message_count: 0, revision: 1, execution_generation: 0, info: { model: 'fixture', source: 'cli' } })
  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await s.deps.settings.save({ show_cli_sessions: true })
    sidecar.respond('gateway.session', (params) => attached(fresh(params.session_id)))
  })
  afterEach(async () => { db.close(); await s.close() })
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it.each([['safe', ids.safe], ['ignore_config', ids.ignore_config]] as const)('starts a %s chat through its owner and shows the frozen mode', async (mode, created) => {
    sidecar.respond('gateway.create', () => attached(fresh(created)))
    const response = await post('/api/session/new', { execution_mode: mode, model: 'fixture', model_provider: 'custom' })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = SessionEnvelopeSchema.parse(await response.json())
    expect(body.session).toMatchObject({ session_id: created, execution_mode: mode, read_only: true, owner_attachment: { state: 'attached', can_submit: true } })
    const calls = sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params as Record<string, unknown>)
    expect(calls).toEqual([expect.objectContaining({ profile_home: s.state, execution_mode: mode, model: 'fixture', provider: 'custom' })])
    expect(String(calls[0]!.cwd)).toMatch(/^\//)
    expect(calls[0]!.request_id).toMatch(/^talaria-web:[0-9a-f-]{36}$/)
    expect(JSON.stringify(calls)).not.toMatch(/api_key/)
    expect(await s.deps.sessionStore.exists(created)).toBe(false)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
  })

  it.each([
    ['lmstudio', 'lmstudio', 'http://127.0.0.1:1234/v1'],
    ['custom:local-box', 'custom', 'http://127.0.0.1:9000/v1'],
  ] as const)('launches %s at its configured endpoint, not only the profile default route', async (provider, sent, url) => {
    writeFileSync(join(s.state, 'config.yaml'), 'model: {}\n')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { model: { provider: 'openrouter', default: 'other' }, providers: { lmstudio: { base_url: 'http://127.0.0.1:1234/v1' } },
      custom_providers: [{ name: 'local box', base_url: 'http://127.0.0.1:9000/v1' }] } }))
    await s.deps.agentConfig.read(s.state)
    sidecar.respond('gateway.create', () => attached(fresh(ids.safe)))
    const response = await post('/api/session/new', { execution_mode: 'safe', model: 'fixture', model_provider: provider })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params)).toEqual([expect.objectContaining({ provider: sent, base_url: url })])
  })

  it('keeps Web-created diagnostic chats in the sidebar when external Agent sessions are hidden', async () => {
    await s.deps.settings.save({ show_cli_sessions: false })
    const listed = (await (await s.get('/api/sessions')).json() as { sessions: { session_id: string; execution_mode?: string }[] }).sessions
    // The Web-created chat whose first turn never ran stays discoverable too; another client's config-only chat does not.
    expect(listed.map((row) => row.session_id).sort()).toEqual([ids.safe, ids.fresh].sort())
    for (const row of listed) expect(row).toMatchObject({ execution_mode: 'safe', read_only: true })
  })

  it('reads every effective mode from the owner receipt, so it survives a server restart', async () => {
    for (const [sid, mode] of [[ids.safe, 'safe'], [ids.ignore_config, 'ignore_config'], [ids.cli, 'normal']] as const) {
      const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
      expect(row.session.execution_mode, sid).toBe(mode)
    }
  })

  it.each([
    [{ state: 'incompatible', reason: 'native_sessions_unavailable' }, 'agent_unsupported'],
    [{ state: 'incompatible', reason: 'execution_mode_unavailable' }, 'agent_unsupported'],
    [{ state: 'incompatible', reason: 'served_profile_sessions_unavailable' }, 'served_profile'],
    [{ state: 'stopped', reason: 'stopped' }, 'gateway_stopped'],
    [{ state: 'unavailable', reason: 'owner_connection_lost' }, 'gateway_unavailable'],
  ] as const)('refuses a diagnostic chat the owner cannot start (%o) without a local fallback', async (refusal, reason) => {
    sidecar.respond('gateway.create', () => ({ ...refusal, snapshot: null, receipt: null }))
    const response = await post('/api/session/new', { execution_mode: 'safe', model: 'fixture' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'execution_mode_unavailable', reason })
    const modes = await (await s.get('/api/session/execution-modes')).json()
    expect(modes).toEqual({ modes: [{ mode: 'normal', available: true, reason: null, can_attach: true }, { mode: 'ignore_config', available: false, reason, can_attach: false }, { mode: 'safe', available: false, reason, can_attach: false }] })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params)).toContainEqual({ profile_home: s.state, probe: true })
    expect((await (await s.get('/api/sessions')).json() as { sessions: { session_id: string }[] }).sessions.map((row) => row.session_id).sort()).toEqual([ids.cli, fixture.sessions.tui!, fixture.sessions.acp!, ids.safe, ids.ignore_config, ids.fresh].sort())
  })

  it('reports available modes from a capable owner and keeps normal chats on the local path', async () => {
    sidecar.respond('gateway.create', () => ({ state: 'attached', reason: null, snapshot: null, receipt: null }))
    expect(await (await s.get('/api/session/execution-modes')).json()).toEqual({ modes: [
      { mode: 'normal', available: true, reason: null, can_attach: true }, { mode: 'ignore_config', available: true, reason: null, can_attach: false },
      { mode: 'safe', available: true, reason: null, can_attach: false }] })
    const normal = await post('/api/session/new', { execution_mode: 'normal', model: 'fixture' })
    expect(normal.status).toBe(200)
    expect(SessionEnvelopeSchema.parse(await normal.json()).session).not.toHaveProperty('owner_attachment')
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => c.params)).toEqual([{ profile_home: s.state, probe: true }])
  })

  it('reuses the client creation id so a retried creation recovers the same owner session', async () => {
    sidecar.respond('gateway.create', () => attached(fresh(ids.safe)))
    for (let i = 0; i < 2; i++) expect((await post('/api/session/new', { execution_mode: 'safe', model: 'fixture', request_id: 'stable-creation' })).status).toBe(200)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create').map((c) => (c.params as { request_id: string }).request_id)).toEqual(['talaria-web:stable-creation', 'talaria-web:stable-creation'])
    expect((await post('/api/session/new', { execution_mode: 'safe', model: 'fixture', request_id: 'bad id!' })).status).toBe(400)
  })

  it('answers with the shared App fixture: modes, a created and an existing diagnostic chat, and the refusal (TAL-1045)', async () => {
    const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/execution-modes.json', import.meta.url), 'utf8')) as Record<'available' | 'unavailable' | 'create_request' | 'created' | 'existing' | 'refusal', unknown>
    sidecar.respond('gateway.create', (params) => (params as { probe?: boolean }).probe ? { state: 'attached', reason: null, snapshot: null, receipt: null } : attached(fresh(ids.safe)))
    expect(await (await s.get('/api/session/execution-modes')).json()).toEqual(shared.available)
    const created = await post('/api/session/new', shared.create_request)
    expect(created.status, await created.clone().text()).toBe(200)
    expect(await created.json()).toMatchObject(shared.created as object)
    expect(sidecar.calls.filter((c) => c.method === 'gateway.create' && !(c.params as { probe?: boolean }).probe).map((c) => (c.params as { request_id: string }).request_id)).toEqual(['talaria-web:fixture-creation-1'])
    expect(await (await s.get(`/api/session?session_id=${ids.ignore_config}`)).json()).toMatchObject(shared.existing as object)
    sidecar.respond('gateway.create', () => ({ state: 'stopped', reason: 'stopped', snapshot: null, receipt: null }))
    expect(await (await s.get('/api/session/execution-modes')).json()).toEqual(shared.unavailable)
    const refused = await post('/api/session/new', shared.create_request)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual(shared.refusal)
  })

  it('refuses a diagnostic chat without an explicit model or with a worktree', async () => {
    sidecar.respond('gateway.create', () => attached(fresh(ids.safe)))
    expect((await post('/api/session/new', { execution_mode: 'safe', worktree: true, model: 'fixture' })).status).toBe(400)
    expect((await post('/api/session/new', { execution_mode: 'bogus' })).status).toBe(400)
    expect(sidecar.calls.some((c) => c.method === 'gateway.create')).toBe(false)
  })
})
