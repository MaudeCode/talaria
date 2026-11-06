/** TAL-1912: a deny with an instruction is one server operation, in order, through the session's real owner. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { GatewaySessionResult, SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { attached, bootOwnerAttachment, ownerHelpers, sid as ownerSid, snapshot } from '../test/gateway-owner.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { str } from '../util.js'

type Json = Record<string, unknown>
const INSTRUCTION = 'Use INSERT OR REPLACE instead'
const finished = (text: string): SidecarResult<'chat.start'> => ({
  status: 'completed', messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'done' }], final_response: 'done', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})

describe('deny with an instruction in a direct chat', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let finishTurn: () => void
  let sid: string
  let approval: Json
  const post = (path: string, body: unknown) => s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const respond = (body: Json) => post('/api/approval/respond', { session_id: sid, approval_id: 'live-approval', ...body })
  const tell = () => respond({ choice: 'deny', instruction: INSTRUCTION })
  const sent = (method: string) => sidecar.calls.filter((c) => c.method === method).map((c) => c.params as Json)
  const order = () => sidecar.calls.map((c) => c.method).filter((m) => m === 'chat.steer' || m === 'approval.respond')

  const park = async (extra: Json = {}) => {
    approval = { request_id: 'live-approval', pattern_key: 'rm', command: 'rm -rf x', tool_name: 'terminal', cwd: '', ...extra }
    sidecar.respond('chat.start', (params, emit) => {
      if (params.user_message !== 'dangerous') return finished(str(params.user_message))
      emit({ event: 'approval', data: approval })
      return new Promise((resolve) => { finishTurn = () => { resolve(finished('dangerous')) } })
    })
    sid = str(((await (await post('/api/session/new', {})).json()) as { session: Json }).session.session_id)
    expect((await post('/api/chat/start', { session_id: sid, message: 'dangerous' })).status).toBe(200)
    await s.sse(`/api/approval/stream?session_id=${sid}`, (f) => Boolean((f.data as Json).pending))
  }

  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('approval.respond', () => ({ ok: true, resolved: 1, choice: 'deny' }))
    sidecar.respond('chat.steer', () => ({ accepted: true, fallback: null, can_redirect: false }))
  })
  afterEach(async () => { finishTurn(); await s.close() })

  it('steers the instruction into the running turn, then denies', async () => {
    await park()
    const res = await tell()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, choice: 'deny', instruction_outcome: 'steered' })
    expect(order()).toEqual(['chat.steer', 'approval.respond'])
    expect(sent('chat.steer')[0]).toMatchObject({ text: INSTRUCTION })
    expect(sent('approval.respond')[0]).toMatchObject({ session_id: sid, choice: 'deny', request_id: 'live-approval' })
  })

  it('queues a refused steer in the session it was aimed at and still denies', async () => {
    await park()
    sidecar.respond('chat.steer', () => ({ accepted: false, fallback: 'not_running' }))
    const other = str(((await (await post('/api/session/new', {})).json()) as { session: Json }).session.session_id)
    expect(await (await tell()).json()).toMatchObject({ ok: true, instruction_outcome: 'queued' })
    expect(order()).toEqual(['chat.steer', 'approval.respond'])
    finishTurn()
    await vi.waitFor(() => { expect(sent('chat.start').map((p) => p.user_message)).toEqual(['dangerous', INSTRUCTION]) })
    expect(sent('chat.start')[1]).toMatchObject({ session_id: sid })
    expect(sent('chat.start').some((p) => p.session_id === other)).toBe(false)
  })

  it('refuses a repeat and an allow while the steer is in flight, and steers once', async () => {
    await park()
    let release!: () => void
    sidecar.respond('chat.steer', () => new Promise((resolve) => { release = () => { resolve({ accepted: true, fallback: null, can_redirect: false }) } }))
    const first = tell()
    await vi.waitFor(() => { expect(sent('chat.steer')).toHaveLength(1) })
    for (const attempt of [tell(), respond({ choice: 'once' })]) expect((await attempt).status).toBe(409)
    expect(sent('approval.respond')).toEqual([])
    release()
    expect((await first).status).toBe(200)
    expect(order()).toEqual(['chat.steer', 'approval.respond'])
    expect(sent('approval.respond')[0]).toMatchObject({ choice: 'deny' })
  })

  it('after a failed deny only that deny can go out, and the instruction is not steered again', async () => {
    await park()
    sidecar.respond('approval.respond', () => { throw new Error('synthetic relay failure') })
    expect((await tell()).status).toBe(503)
    expect((await respond({ choice: 'once' })).status).toBe(409)
    sidecar.respond('approval.respond', () => ({ ok: true, resolved: 1, choice: 'deny' }))
    expect(await (await tell()).json()).toMatchObject({ ok: true, instruction_outcome: 'steered' })
    expect(sent('chat.steer')).toHaveLength(1)
  })

  it('refuses skipping approvals while any parked approval is committed to a deny, because skipping releases them all', async () => {
    await park()
    sidecar.respond('approval.set_yolo', () => ({ yolo_enabled: true, released: 1 }))
    const releases = () => sent('approval.set_yolo').filter((p) => p.enabled === true)
    s.deps.pending.submitApproval(sid, { approval_id: 'second-approval', request_id: 'second-approval', command: 'rm -rf y', session_id: sid, can_deny_with_instruction: true })
    let release!: () => void
    sidecar.respond('chat.steer', () => new Promise((resolve) => { release = () => { resolve({ accepted: true, fallback: null, can_redirect: false }) } }))
    const told = post('/api/approval/respond', { session_id: sid, approval_id: 'second-approval', choice: 'deny', instruction: INSTRUCTION })
    await vi.waitFor(() => { expect(sent('chat.steer')).toHaveLength(1) })
    expect((await post('/api/session/yolo', { session_id: sid, enabled: true })).status).toBe(409)
    expect(releases()).toEqual([])
    release()
    expect((await told).status).toBe(200)
    expect(releases()).toEqual([])
    expect((await post('/api/session/yolo', { session_id: sid, enabled: true })).status).toBe(200)
    expect(releases()).toHaveLength(1)
  })

  it('does not queue a steer whose outcome is unknown: it may have landed', async () => {
    await park()
    sidecar.respond('chat.steer', () => { throw new Error('synthetic lost acknowledgment') })
    expect(await (await tell()).json()).toMatchObject({ ok: true, instruction_outcome: 'unconfirmed' })
    finishTurn()
    await s.sse(`/api/chat/stream?stream_id=${str(((await (await s.get(`/api/session?session_id=${sid}`)).json()) as { session: Json }).session.active_stream_id)}`, (f) => f.event === 'stream_end').catch(() => [])
    expect(sent('chat.start').map((p) => p.user_message)).toEqual(['dangerous'])
  })

  it.each([
    ['a stale approval', { approval_id: 'stale-other' }, {}],
    ['an approval that does not offer deny', {}, { allowed_choices: ['once'] }],
    ['a choice other than deny', { choice: 'once' }, {}],
    ['a blank instruction', { instruction: '   ' }, {}],
    ['skipping every approval', { yolo: true }, {}],
  ])('never steers for %s', async (_, body, parked) => {
    await park(parked)
    const res = await respond({ choice: 'deny', instruction: INSTRUCTION, ...body })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(sent('chat.steer')).toEqual([])
  })

  it.each([
    ['offers deny', {}, true],
    ['names deny', { allowed_choices: ['once', 'deny'] }, true],
    ['does not offer deny', { allowed_choices: ['once'] }, false],
  ])('publishes can_deny_with_instruction when the approval %s', async (_, parked, expected) => {
    await park(parked)
    const envelope = await (await s.get(`/api/approval/pending?session_id=${sid}`)).json() as { pending: Json }
    expect(envelope.pending.can_deny_with_instruction).toBe(expected)
  })
})

describe('deny with an instruction in a native owner chat', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  beforeEach(async () => { ({ s, db, sidecar } = await bootOwnerAttachment()) })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))
  const prompts = [{ kind: 'approval', prompt_id: 'approval-native', execution_generation: 7, command: 'echo fixture', choices: ['once', 'deny'] }]
  const live = snapshot({ running: true, execution_generation: 7, prompts })
  const correction = (status: string) => ({ status, text: INSTRUCTION, execution_generation: 7, authority_epoch: 1 })
  const owner = (steer: () => GatewaySessionResult | Promise<GatewaySessionResult>) => {
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'steer') return steer()
      if (params.action === 'submit') return { ...attached(live), receipt: { admission_id: 'queued-instruction', sequence: 2, status: 'queued', outcome: null, authority_epoch: 1, execution_generation: 7, text: str(params.text), input_id: str(params.request_id) } }
      return attached(live)
    })
  }
  const accepted = (): GatewaySessionResult => ({ ...attached(live), receipt: correction('queued') as GatewaySessionResult['receipt'] })
  const tell = () => post('/api/approval/respond', { session_id: ownerSid, approval_id: 'approval-native', choice: 'deny', instruction: INSTRUCTION })
  const writes = () => sidecar.calls.filter((c) => c.method === 'gateway.session').map((c) => c.params as Json).filter((p) => ['steer', 'submit', 'approval'].includes(str(p.action)))

  it('steers through the owner with the prompt generation, then denies', async () => {
    owner(accepted)
    const res = await tell()
    expect(await res.json()).toMatchObject({ ok: true, choice: 'deny', instruction_outcome: 'steered' })
    expect(writes()).toEqual([
      expect.objectContaining({ session_id: ownerSid, action: 'steer', execution_generation: 7, text: INSTRUCTION }),
      expect.objectContaining({ session_id: ownerSid, action: 'approval', prompt_id: 'approval-native', execution_generation: 7, choice: 'deny' }),
    ])
  })

  it.each([
    ['the owner rejects it', (): GatewaySessionResult => ({ ...attached(live), receipt: correction('rejected') as GatewaySessionResult['receipt'] })],
    ['the owner refuses the control', (): GatewaySessionResult => ({ state: 'refused', reason: 'unsupported_control', snapshot: null, receipt: null })],
  ])('queues in this session and still denies when %s', async (_, steer) => {
    owner(steer)
    expect(await (await tell()).json()).toMatchObject({ ok: true, instruction_outcome: 'queued' })
    expect(writes().map((p) => p.action)).toEqual(['steer', 'submit', 'approval'])
    expect(writes()[1]).toMatchObject({ session_id: ownerSid, text: INSTRUCTION })
    expect(str(writes()[1]!.request_id)).not.toBe('')
  })

  it('reports an unknown steer unconfirmed: it queues nothing and still denies', async () => {
    owner(() => ({ state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }))
    expect(await (await tell()).json()).toMatchObject({ ok: true, instruction_outcome: 'unconfirmed' })
    expect(writes().map((p) => p.action)).toEqual(['steer', 'approval'])
  })

  it('keeps the command held when neither the steer nor the queue can take the text', async () => {
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'steer' || params.action === 'submit') return { state: 'refused', reason: 'gateway_restarting', snapshot: null, receipt: null }
      return attached(live)
    })
    const res = await tell()
    expect(res.status).toBe(409)
    expect(writes().some((p) => p.action === 'approval')).toBe(false)
    owner(accepted)
    expect(await (await tell()).json()).toMatchObject({ ok: true, instruction_outcome: 'steered' })
  })

  it('keeps the command held when the fallback admission settles refused at once', async () => {
    const refused = { admission_id: 'refused-instruction', sequence: 2, status: 'terminal' as const, outcome: 'failed', authority_epoch: 1, execution_generation: 7, text: INSTRUCTION, input_id: 'refused' }
    sidecar.respond('gateway.session', (params) => {
      if (params.action === 'steer') return { ...attached(live), receipt: correction('rejected') as GatewaySessionResult['receipt'] }
      if (params.action === 'submit') return { ...attached(live), receipt: refused }
      return attached(live)
    })
    expect((await tell()).status).toBe(409)
    expect(writes().map((p) => p.action)).toEqual(['steer', 'submit'])
  })

  it('refuses a repeat and an allow while the steer is in flight, and steers once', async () => {
    let release!: () => void
    owner(() => new Promise((resolve) => { release = () => { resolve(accepted()) } }))
    const first = tell()
    await vi.waitFor(() => { expect(writes().map((p) => p.action)).toEqual(['steer']) })
    for (const attempt of [tell(), post('/api/approval/respond', { session_id: ownerSid, approval_id: 'approval-native', choice: 'once' })]) expect((await attempt).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect(writes().map((p) => p.action)).toEqual(['steer', 'approval'])
    expect(writes()[1]).toMatchObject({ choice: 'deny' })
  })

  it.each([
    ['offers deny', prompts, undefined, true],
    ['does not offer deny', [{ ...prompts[0]!, choices: ['once'] }], undefined, false],
    ['belongs to an owner in its restart wait', prompts, true, false],
  ] as const)('publishes can_deny_with_instruction when the approval %s', async (_, offered, restarting, expected) => {
    sidecar.respond('gateway.session', () => ({ ...attached(snapshot({ running: true, execution_generation: 7, prompts: [...offered] })), ...(restarting ? { restarting } : {}) }))
    const envelope = await (await s.get(`/api/approval/pending?session_id=${ownerSid}`)).json() as { pending: Json }
    expect(envelope.pending.can_deny_with_instruction).toBe(expected)
  })

  it('never sends the owner a deny-with-instruction it refused to publish', async () => {
    sidecar.respond('gateway.session', () => attached(snapshot({ running: true, execution_generation: 7, prompts: [{ ...prompts[0]!, choices: ['once'] }] })))
    expect((await tell()).status).toBe(409)
    expect(writes()).toEqual([])
  })
})
