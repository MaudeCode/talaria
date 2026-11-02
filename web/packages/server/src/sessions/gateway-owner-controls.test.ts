import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEnvelopeSchema, ClarifyPendingEnvelopeSchema, ChatEventSchema, type GatewaySnapshot, type GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { StreamFrame } from '../sidecar/client.js'
import { type TestServer, openStateDb } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { CANONICAL_READ_ONLY_REASON } from './state-db.js'
import { GatewaySessions } from './gateway-sessions.js'
import { admission, attached, bootOwnerAttachment, fixture, ownerEvents, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

describe('canonical owner attachment', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => { ({ s, db, sidecar } = await bootOwnerAttachment()) })
  afterEach(async () => { db.close(); await s.close() })
  const { post, observeOwner } = ownerHelpers(() => ({ s, sidecar }))

  it.each([false, true])('accepts a voice stop without an admission or replacing an owner watch, running=%s', async (running) => {
    const snap = snapshot({ running, pending: running ? [admission()] : [] })
    const watch = running ? await observeOwner(snap) : null
    const original = sidecar.responderFor('gateway.session')
    sidecar.respond('gateway.session', (params, emit, opts) => params.action === 'submit'
      ? { ...attached(snap), receipt: { voice_stopped: true } }
      : original ? original(params, emit, opts) : attached(snap))
    try {
      const response = await post('/api/chat/start', { session_id: sid, message: 'stop', submission_id: 'voice-stop-once' })
      expect(response.status, await response.clone().text()).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ ok: true, status: 'suppressed', reason: 'voice_stopped', owner_attachment: { state: 'attached' }, session: { session_id: sid } })
      expect(body).not.toHaveProperty('admission_id')
      expect(body).not.toHaveProperty('stream_id')
      expect(body).not.toHaveProperty('outcome_unknown')
      expect(s.deps.registry.activeRunStreamForSession(sid)).toBe(watch?.stream ?? null)
      expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toHaveLength(1)
      expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'watch')).toHaveLength(running ? 1 : 0)
      expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    } finally { if (watch) { watch.finish(); await watch.read } }
  })

  it.each([{ voice_stopped: false }, { voice_stopped: 'true' }, { voice_stopped: true, extra: 'ambiguous' }, { ...admission(), voice_stopped: true }])('keeps an invalid voice-stop receipt unknown (%j)', async (receipt) => {
    // Inject untrusted output so the fake validates it exactly as the real client does.
    sidecar.respond('gateway.session', (params) => ({ ...attached(snapshot()), receipt: params.action === 'submit' ? receipt as GatewaySessionResult['receipt'] : null }))
    const response = await post('/api/chat/start', { session_id: sid, message: 'stop', submission_id: 'invalid-stop' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ outcome_unknown: true, owner_attachment: { state: 'unavailable' } })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toHaveLength(1)
  })

  it('keeps the owner watch attached when the reasoning preference is unavailable', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    s.deps.sessions.owner = new GatewaySessions({ service: s.deps.sessions, sidecar: s.deps.sidecar,
      registry: s.deps.registry, journal: s.deps.journal, events: s.deps.events, channels: s.deps.channels, profileHome: s.deps.profileHome,
      activeProfile: s.deps.activeProfile, redactEnabled: s.deps.sessions.deps.redactEnabled, now: s.deps.nowSeconds, log: s.deps.log,
      showReasoning: async () => { await gate; throw new Error('synthetic config unavailable') },
    })
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    release()
    await vi.waitFor(() => { expect(watch.attached || s.deps.registry.activeRunStreamForSession(sid) === null).toBe(true) })
    if (watch.attached) {
      watch.event('reasoning.delta', { text: 'Hidden reasoning' })
      watch.event('message.delta', { text: 'Still observable' })
      watch.finish()
    }
    const frames = await watch.read
    expect.soft(frames.filter((frame) => frame.event === 'token').map((frame) => frame.data)).toEqual([{ text: 'Still observable' }])
    expect.soft(frames.some((frame) => frame.event === 'apperror')).toBe(false)
    expect.soft(frames.some((frame) => frame.event === 'reasoning')).toBe(false)
    expect.soft(sidecar.calls.find((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')?.params).toMatchObject({ show_reasoning: true })
  })

  it('preserves canonical counters when native usage also carries its compact nested view (TAL-1508)', async () => {
    const gauge = { id: 'day', label: 'Today', used_bp: 8300, resets_at_ms: null }
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('session.usage', { api_calls: 1, prompt_tokens: 100, input_tokens: 20, completion_tokens: 30,
      cache_read_tokens: 80, cache_write_tokens: 0,
      usage: { calls: 1, prompt: 100, input: 20, output: 30, cache_hit_pct: 80, plan_gauge: gauge } })
    watch.finish()
    const frames = await watch.read
    expect(frames.find((f) => f.event === 'metering')?.data).toMatchObject({ usage: {
      input_tokens: 100, output_tokens: 30, cache_read_tokens: 80, cache_write_tokens: 0, cache_hit_percent: 80, plan_gauge: gauge,
    } })
  })

  it('retains a gauge on partial owner ticks and clears it on complete omission (TAL-1508)', async () => {
    const gauge = { id: 'day', label: 'Today', used_bp: 8300, resets_at_ms: null }
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    watch.event('session.usage', { usage: { calls: 1, input: 100, output: 20, cache_read_tokens: 0, cache_write_tokens: 0, plan_gauge: gauge } })
    watch.event('session.usage', { usage: { output: 30 } })
    watch.event('session.usage', { usage: { calls: 2, output: 40 } })
    watch.finish()
    const frames = await watch.read
    const meters = frames.filter((f) => f.event === 'metering').map((f) => (f.data as Record<string, unknown>).usage)
    expect(meters).toEqual(expect.arrayContaining([
      expect.objectContaining({ output_tokens: 20, plan_gauge: gauge }),
      expect.objectContaining({ output_tokens: 30, plan_gauge: gauge }),
      expect.objectContaining({ output_tokens: 40, plan_gauge: null }),
    ]))
  })

  it('clears prior reasoning titles and usage when a queued execution advances the generation', async () => {
    const watch = await observeOwner(snapshot({ running: false, execution_generation: 1, pending: [{ ...admission('queued'), execution_generation: null }] }))
    watch.event('reasoning.delta', { text: '**Previous heading**\nPrevious execution\n' })
    watch.event('message.delta', { text: 'Previous answer' })
    watch.event('session.usage', { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, tokens_per_s: 20 })
    watch.event('session.info', { authority_epoch: 1, execution_generation: 2, running: true, pending: [{ ...admission(), execution_generation: 2 }] })
    watch.event('reasoning.delta', { text: '**Current heading**\nCurrent execution\n' }, 2)
    watch.event('message.delta', { text: 'Current answer' }, 2)
    watch.finish(2)
    const frames = await watch.read
    expect.soft(frames.findLast((frame) => frame.event === 'reasoning')?.data).toMatchObject({ titles: ['Current heading'] })
    expect.soft(frames.find((frame) => frame.event === 'done')?.data).not.toHaveProperty('usage')
    expect.soft(frames.some((frame) => frame.event === 'apperror')).toBe(false)
  })

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

  it('reopens the native gauge through detail and the existing usage endpoint without keeping an omitted gauge (TAL-1508)', async () => {
    const gauge = { id: 'day', label: 'Today', used_bp: 8300, resets_at_ms: null }
    let current: typeof gauge | null = gauge
    sidecar.respond('gateway.session', () => attached(snapshot({ plan_gauge: current })))
    for (const expected of [gauge, null]) {
      const detail = await s.get(`/api/session?session_id=${sid}`)
      expect((await detail.json() as { session: { plan_gauge: unknown } }).session.plan_gauge).toEqual(expected)
      const usage = await s.get(`/api/session/usage?session_id=${sid}`)
      expect(await usage.json()).toMatchObject({ plan_gauge: expected, input_tokens: expect.any(Number) as number })
      current = null
    }
  })

  it('preserves an explicit null provider in the owner model projection', async () => {
    const option = vi.spyOn(s.deps.sessions.deps, 'modelOptionFor').mockImplementation((model, provider) => JSON.stringify([model, provider]))
    const base = { session_id: sid, read_only_reason: CANONICAL_READ_ONLY_REASON, model: 'old-model', model_provider: 'old-backend', served_model: 'web-fallback', served_model_provider: 'web-provider', workspace: s.state }
    sidecar.respond('gateway.session', () => attached(snapshot({ info: { model: 'native-model', provider: null } })))
    const cleared = await s.deps.sessions.owner!.project(base)
    expect(cleared.model_provider).toBeNull()
    // TAL-978: the Web copy's fallback route never labels the owner's turns.
    expect(cleared).toMatchObject({ served_model: null, served_model_provider: null })
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

  it('records a lost submit acknowledgement as unknown without replaying admission', async () => {
    sidecar.respond('gateway.session', (params) => params.action === 'submit'
      ? { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }
      : attached(snapshot()))
    const result = await post('/api/chat/start', { session_id: sid, message: 'PRIVATE_PROMPT', submission_id: 'stable-input' })
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ outcome_unknown: true })
    const records = s.logs.filter((line) => line.includes('"event":"chat_start_timing"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))) as unknown) as { stage: string; outcome: string; spans: Record<string, unknown> }[]
    expect(records.find((record) => record.stage === 'terminal')).toMatchObject({ outcome: 'unknown', spans: {
      owner_snapshot: { outcome: 'ok', duration_ms: (expect.any(Number) as unknown) }, owner_detail: { outcome: 'ok', duration_ms: (expect.any(Number) as unknown) }, owner_submit: { outcome: 'unknown', duration_ms: (expect.any(Number) as unknown) },
    } })
    expect(sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'submit')).toHaveLength(1)
    expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    expect(JSON.stringify(records)).not.toContain('PRIVATE_PROMPT')
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

  it.each([
    [{ operation: 'model', model: 'picked', revision: 3, execution_generation: 1 }, { state: 'applied' }],
    [{ operation: 'model', status: 'deferred', model: 'picked' }, { state: 'deferred', model: 'picked' }],
    [{ operation: 'model', status: 'confirmation_required', confirm: 'owner-token', confirm_message: 'Guard warning' }, { state: 'confirmation_required', confirm: 'owner-token', message: 'Guard warning', model: 'picked' }],
    [{ operation: 'model', status: 'refused', reason: 'model_resolution_failed' }, { state: 'refused', message: 'model_resolution_failed' }],
  ])('projects a model mutation receipt to its response and subsequent view (%j)', async (receipt, change) => {
    sidecar.respond('gateway.session', (params) => ({ ...attached(snapshot()), receipt: params.action === 'mutate' ? receipt : null }))
    const response = await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked', provider: null }, request_id: 'pick', expected_revision: 2, execution_generation: 1 })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ model_change: change, session: { owner_attachment: { model_change: change } } })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ model_change: change })
  })

  it.each([
    { operation: 'model', status: 'refused', reason: 'model_resolution_failed' },
    { operation: 'model', status: 'confirmation_required', confirm: 'later-token', confirm_message: 'Later guard', payload: { model: 'picked', provider: null } },
  ])('keeps observing a deferred pick past idle until its unstamped outcome arrives (%j)', async (outcome) => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'mutate' ? { operation: 'model', status: 'deferred', model: 'picked' } : params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    await post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'pick', expected_revision: 2, execution_generation: 1 })
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'stream_end')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    emit!({ event: 'event', data: { type: 'session.updated', session_id: sid, payload: outcome } })
    const frames = await read
    const change = outcome.status === 'refused' ? { state: 'refused', message: 'model_resolution_failed' } : { state: 'confirmation_required', confirm: 'later-token', model: 'picked' }
    expect(frames.find((f) => f.event === 'done')?.data).toMatchObject({ session: { owner_attachment: { model_change: change } } })
    expect(await (await s.get(`/api/session?session_id=${sid}`)).json()).toMatchObject({ session: { owner_attachment: { model_change: change } } })
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

  it.each([
    ['null', null, []], ['an object', { once: true }, []], ['a scalar', 'once', []], ['a mixed array', ['once', 3], []],
    ['missing', undefined, []], ['partly unknown', ['once', 'view', 'deny'], ['once', 'deny']],
  ] as const)('publishes only the approval choices the owner names when they are %s, over HTTP and the chat stream (TAL-1414)', async (_, choices, allowed) => {
    const prompts = [{ kind: 'approval', prompt_id: 'approval-native', execution_generation: 1, command: 'echo fixture', ...(choices === undefined ? {} : { choices }) }]
    const snap = snapshot({ running: true, pending: [admission()], prompts })
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return attached(snap)
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const res = await s.get(`/api/approval/pending?session_id=${sid}`)
    expect(res.status).toBe(200)
    expect((await res.json() as { pending: unknown }).pending).toMatchObject({ approval_id: 'approval-native', allowed_choices: allowed, can_enable_yolo: false })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const frames = await s.sse(`/api/chat/stream?stream_id=${row.session.active_stream_id!}`, (frame) => frame.event === 'approval')
    expect(frames.at(-1)?.data).toMatchObject({ approval_id: 'approval-native', allowed_choices: allowed, can_enable_yolo: false })
  })

  it('refuses an approval choice its owner did not offer without sending it (TAL-1414)', async () => {
    const prompts = [
      { kind: 'approval', prompt_id: 'offered', execution_generation: 1, command: 'echo fixture', choices: ['once', 'deny'] },
      { kind: 'approval', prompt_id: 'malformed', execution_generation: 1, command: 'echo fixture', choices: null },
    ]
    sidecar.respond('gateway.session', () => attached(snapshot({ prompts })))
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'offered', choice: 'always' })).status).toBe(409)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'malformed', choice: 'once' })).status).toBe(409)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'malformed', choice: 'deny' })).status).toBe(409)
    expect(sidecar.calls.filter((c) => (c.params as { action?: string }).action === 'approval')).toEqual([])
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'offered', choice: 'deny' })).status).toBe(200)
    expect(sidecar.calls.filter((c) => (c.params as { action?: string }).action === 'approval').map((c) => c.params))
      .toEqual([expect.objectContaining({ prompt_id: 'offered', choice: 'deny' })])
  })

  it('projects an owner clarify batch as one card and locks each answer, keeping the owner-reported progress', async () => {
    const snap = snapshot({ running: true, pending: [admission()] })
    const questions = [{ qid: 'q0', question: 'Pick a color', choices: ['blue (Recommended)', 'green'], multi_select: false },
      { qid: 'q1', question: 'Pick sizes', choices: ['s', 'm'], multi_select: true }]
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let remaining = ['q0', 'q1']
    let failed = false
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'clarify_lock') {
        // The second answer fails once, so the first stays locked on the owner.
        if (params.question_id === 'q1' && !failed) { failed = true; return { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null } }
        remaining = remaining.filter((qid) => qid !== params.question_id)
        return { ...attached(snap), lock: { status: 'ok', remaining } }
      }
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'clarify' && (frame.data as { status?: string }).status === 'resolved')
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    emit!({ event: 'clarify_batch', data: { request_id: 'srq-batch', questions } })
    const pendingSteps = async () => ClarifyPendingEnvelopeSchema.parse(await (await s.get(`/api/clarify/pending?session_id=${sid}`)).json()).pending?.steps?.map((step) => [step.qid, step.answered]) ?? null
    await vi.waitFor(async () => { expect(await pendingSteps()).toEqual([['q0', false], ['q1', false]]) })
    const respond = () => post('/api/clarify/respond', { session_id: sid, clarify_id: 'srq-batch', answers: { q0: 'green', q1: ['s', 'm'] } })
    // An unconfirmed lock keeps the card for a retry, with q0 answered as the owner reported.
    expect((await respond()).status).toBe(503)
    expect(await pendingSteps()).toEqual([['q0', true], ['q1', false]])
    expect((await respond()).status).toBe(200)
    expect(await pendingSteps()).toBeNull()
    const locks = sidecar.calls.filter((c) => (c.params as { action?: string }).action === 'clarify_lock').map((c) => c.params)
    expect(locks).toEqual([
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q0', answer: 'green' }),
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q1', answer: '["s","m"]' }),
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q0', answer: 'green' }),
      expect.objectContaining({ request_id: 'srq-batch', question_id: 'q1', answer: '["s","m"]' }),
    ])
    expect(sidecar.calls.some((c) => (c.params as { action?: string }).action === 'clarify')).toBe(false)
    // A batch settled elsewhere clears from the owner's own withdrawal event.
    emit!({ event: 'clarify_batch', data: { request_id: 'srq-other', questions: questions.slice(0, 1) } })
    await vi.waitFor(async () => { expect(await pendingSteps()).toEqual([['q0', false]]) })
    emit!({ event: 'event', data: { type: 'request.cancel', session_id: sid, payload: { id: 'srq-other', method: 'clarify', reason: 'resolved' } } })
    await vi.waitFor(async () => { expect(await pendingSteps()).toBeNull() })
    const frames = await read
    expect(frames.find((f) => f.event === 'clarify')?.data).toMatchObject({ clarify_id: 'srq-batch', steps: [{ qid: 'q0' }, { qid: 'q1', multi_select: true }] })
  })

  it('ships the restart wait so clients stop sending while the parked approval stays answerable', async () => {
    const prompts = [{ kind: 'approval', prompt_id: 'approval-native', execution_generation: 1, command: 'echo fixture', description: 'Approve fixture?', choices: ['once', 'deny'] }]
    sidecar.respond('gateway.session', (params) => params.action === 'submit'
      ? { state: 'refused', reason: 'gateway_restarting', snapshot: null, receipt: null }
      : { ...attached(snapshot({ prompts })), restarting: true })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ state: 'attached', restarting: true, can_submit: false })
    expect((await post('/api/chat/start', { session_id: sid, message: 'follow up', submission_id: 'during-restart' })).status).toBe(409)
    expect(sidecar.calls.some((c) => (c.params as { action?: string }).action === 'submit')).toBe(false)
    expect((await post('/api/approval/respond', { session_id: sid, approval_id: 'approval-native', choice: 'once' })).status).toBe(200)
    sidecar.respond('gateway.session', () => attached(snapshot()))
    const after = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(after.session.owner_attachment).toMatchObject({ restarting: false, can_submit: true })
  })

  it('pushes the restart wait an open watch observes, so clients stop sending without another read', async () => {
    const snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    expect(row.session.owner_attachment).toMatchObject({ restarting: false, can_submit: true })
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'session_snapshot' && (frame.data as { session: { owner_attachment?: { restarting?: boolean } } }).session.owner_attachment?.restarting === true)
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    emit!({ event: 'restarting', data: { restarting: true } })
    const pushed = (await read).at(-1)?.data as { session: { owner_attachment: unknown } }
    expect(pushed.session.owner_attachment).toMatchObject({ state: 'attached', restarting: true, can_submit: false, can_interrupt: true })
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

  it('applies Show to an already-attached owner watch that started hidden (TAL-996)', async () => {
    let show = false
    writeFileSync(join(s.state, 'config.yaml'), '# synthetic display preference')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { display: { platforms: { webui: { show_reasoning: show } } } } }))
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    await vi.waitFor(() => { expect(watch.attached).toBe(true) })
    show = true
    s.deps.agentConfig.invalidate()
    watch.event('reasoning.delta', { text: 'Restored owner reasoning' })
    watch.finish()
    const frames = await watch.read
    expect(frames.some((frame) => frame.event === 'reasoning' && (frame.data as { text?: string }).text === 'Restored owner reasoning')).toBe(true)
  })

  it.each([true, false])('projects recorded v0.22.3 reasoning, subagent activity and usage through existing chat frames (reasoning=%s)', async (show) => {
    writeFileSync(join(s.state, 'config.yaml'), '# synthetic display preference')
    sidecar.respond('config.get', () => ({ path: join(s.state, 'config.yaml'), exists: true, config: { display: { show_reasoning: !show, platforms: { webui: { show_reasoning: show } } } } }))
    const watch = await observeOwner(snapshot({ running: true, pending: [admission()] }))
    for (const recorded of ownerEvents.events) {
      // Old executions never contaminate the current turn's reasoning, progress or counters.
      watch.event(String(recorded.type), recorded.payload as Record<string, unknown>, 0)
      watch.event(String(recorded.type), recorded.payload as Record<string, unknown>)
    }
    watch.event('session.usage', { prompt_tokens: 100, input_tokens: 20, completion_tokens: 20, cache_read_tokens: 80, cache_write_tokens: 0 })
    watch.finish()
    const frames = await watch.read
    const reasoning = frames.filter((f) => f.event === 'reasoning').map((f) => (f.data as { text: string }).text).join('')
    expect.soft(reasoning).toBe(show ? ownerEvents.events.filter((e) => e.type === 'reasoning.delta').map((e) => (e.payload as { text: string }).text).join('') : '')
    expect.soft(sidecar.calls.find((c) => c.method === 'gateway.session' && (c.params as { action: string }).action === 'watch')?.params).toMatchObject({ show_reasoning: true })
    for (const frame of frames.filter((f) => ['reasoning', 'tool', 'tool_complete', 'metering', 'done'].includes(f.event))) expect.soft(ChatEventSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true)
    const progress = frames.filter((f) => f.event === 'tool' || f.event === 'tool_complete')
    expect.soft(progress).toHaveLength(ownerEvents.events.filter((e) => String(e.type).startsWith('subagent.')).length)
    expect.soft(progress[0]?.data).toMatchObject({ id: 'owner-subagent-detail-child', name: 'subagent_progress', kind: 'delegate', target: 'Inspect the supplied facts' })
    expect.soft(progress.at(-1)?.data).toMatchObject({ id: 'owner-subagent-detail-child', is_error: false, preview: 'Owner detail complete.' })
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 80, cache_write_tokens: 0, context_length: 256000, last_prompt_tokens: 20 }
    expect.soft(frames.findLast((f) => f.event === 'metering')?.data).toMatchObject({ usage, estimated: false })
    expect.soft(frames.find((f) => f.event === 'done')?.data).toMatchObject({ usage, session: usage })
    expect.soft(await s.deps.sessionStore.exists(sid)).toBe(false)
  })

  it('keeps a later model event when a deferred HTTP receipt arrives after it', async () => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let acknowledge!: (result: GatewaySessionResult) => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'mutate') return new Promise((resolve) => { acknowledge = resolve })
      if (params.action !== 'watch') return attached(snap)
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    await s.get(`/api/session?session_id=${sid}`)
    const action = post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'racing-pick', expected_revision: 2, execution_generation: 1 })
    await vi.waitFor(() => { expect(acknowledge).toBeDefined(); expect(emit).toBeDefined() })
    snap = { ...snap, revision: 3, info: { model: 'picked' } }
    emit!({ event: 'event', data: { type: 'session.updated', session_id: sid, payload: { operation: 'model', model: 'picked', revision: 3 } } })
    await vi.waitFor(async () => { expect(await (await s.get(`/api/session?session_id=${sid}`)).json()).toMatchObject({ session: { owner_attachment: { model_change: { state: 'applied' } } } }) })
    acknowledge({ ...attached(snap), receipt: { operation: 'model', status: 'deferred', model: 'picked' } })
    expect(await (await action).json()).toMatchObject({ model_change: { state: 'applied' } })
  })

  it.each([
    [{ operation: 'model', model: 'picked', revision: 3 }, { state: 'applied' }],
    [{ operation: 'model', status: 'refused', reason: 'model_resolution_failed' }, { state: 'refused', message: 'model_resolution_failed' }],
    [{ operation: 'model', status: 'confirmation_required', confirm: 'racing-token', confirm_message: 'Guard warning', payload: { model: 'picked' } }, { state: 'confirmation_required', confirm: 'racing-token' }],
  ])('retains the owner outcome when idle precedes the mutation ACK (%j)', async (outcome, change) => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let acknowledge!: (result: GatewaySessionResult) => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'mutate') return new Promise((resolve) => { acknowledge = resolve })
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => frame.event === 'stream_end')
    const action = post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'idle-before-ack', expected_revision: 2, execution_generation: 1 })
    await vi.waitFor(() => { expect(acknowledge).toBeDefined(); expect(emit).toBeDefined(); expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'event', data: { type: 'session.info', session_id: sid, payload: { authority_epoch: 1, execution_generation: 1, running: false, pending: [] } } })
    emit!({ event: 'event', data: { type: 'session.updated', session_id: sid, payload: outcome } })
    let response!: Response
    try {
      await vi.waitFor(async () => { expect(await (await s.get(`/api/session?session_id=${sid}`)).json()).toMatchObject({ session: { owner_attachment: { model_change: change } } }) })
    } finally {
      acknowledge({ ...attached(snap), receipt: { operation: 'model', status: 'deferred', model: 'picked' } })
      response = await action
    }
    expect(await response.json()).toMatchObject({ model_change: change })
    expect((await read).find((f) => f.event === 'done')?.data).toMatchObject({ session: { owner_attachment: { model_change: change } } })
    await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
  })

  it.each(['applied', 'refused', 'disconnect'])('releases the in-flight model fence after an idle snapshot and %s ACK', async (outcome) => {
    let snap = snapshot({ running: true, pending: [admission()] })
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    let acknowledge!: () => void
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'mutate') return new Promise((resolve, reject) => {
        acknowledge = () => {
          if (outcome === 'disconnect') reject(new Error('synthetic owner disconnect'))
          else resolve(outcome === 'refused' ? { state: 'refused', reason: 'revision_conflict', snapshot: null, receipt: null }
            : { ...attached(snap), receipt: { operation: 'model', model: 'picked', revision: 3 } })
        }
      })
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), outcome: 'completed' } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json())
    const stream = row.session.active_stream_id!
    let seenIdle!: () => void
    const idle = new Promise<void>((resolve) => { seenIdle = resolve })
    const read = s.sse(`/api/chat/stream?stream_id=${stream}`, (frame) => {
      if (frame.event === 'session_snapshot' && !(frame.data as { session: { owner_attachment: { can_interrupt: boolean } } }).session.owner_attachment.can_interrupt) seenIdle()
      return frame.event === 'stream_end'
    })
    const action = post('/api/chat/owner-action', { session_id: sid, action: 'mutate', operation: 'model', payload: { model: 'picked' }, request_id: 'release-fence', expected_revision: 2, execution_generation: 1 })
    await vi.waitFor(() => { expect(acknowledge).toBeDefined(); expect(emit).toBeDefined(); expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    snap = snapshot()
    emit!({ event: 'snapshot', data: attached(snap) })
    await idle
    acknowledge()
    expect((await action).status).toBe(outcome === 'applied' ? 200 : 409)
    expect((await read).some((f) => f.event === 'done')).toBe(true)
    await vi.waitFor(() => { expect(s.deps.registry.activeRunStreamForSession(sid)).toBeNull() })
  })

  it('uses the selected home for same-id attachments and redacts pending text', async () => {
    const otherPath = join(s.state, 'profiles', 'work', 'state.db')
    mkdirSync(join(otherPath, '..'), { recursive: true })
    const other = openStateDb(otherPath)
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
    const other = openStateDb(otherPath)
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
