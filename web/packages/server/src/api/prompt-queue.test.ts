import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

useJsonStorage()

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it('persists an explicitly started queue spanning two chats without dispatching on create', async () => {
  server = await bootTestServer({ sidecar: null })
  const a = await server.deps.sessionStore.newSession({ profile: 'default' })
  const b = await server.deps.sessionStore.newSession({ profile: 'default' })
  const response = await server.get('/api/prompt-queues', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: 'synthetic-queue', cards: [a, b].map((s, i) => ({ session_id: s.session_id, project_id: null, text: `Step ${i}` })) }),
  })
  expect(response.status).toBe(200)
  const run = await response.json() as { id: string; phase: string; cards: { session_id: string; status: string; request_id: string }[] }
  expect(run.phase).toBe('draft')
  expect(run.cards.map((c) => c.session_id)).toEqual([a.session_id, b.session_id])
  expect(run.cards.map((c) => c.status)).toEqual(['waiting', 'waiting'])
  expect(new Set(run.cards.map((c) => c.request_id)).size).toBe(2)
  expect(server.deps.registry.activeRuns.size).toBe(0)
  const read = await server.get('/api/prompt-queues')
  expect(await read.json()).toMatchObject({ runs: [{ id: run.id, phase: 'draft' }] })
})

import { vi } from 'vitest'
import type { PromptQueueRun, SidecarParams, SidecarResultInput, GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { JsonDocuments, useJsonStorage } from '../test/storage.js'
import { PromptQueues } from '../sessions/prompt-queues.js'

const completed = (params: SidecarParams<'chat.start'>): SidecarResultInput<'chat.start'> => ({
  status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'answer' }], final_response: 'answer', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
  usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false, agent_session_id: 'synthetic', token_sent: true, pending_steer: '', live_tool_calls: [],
})
const post = (path: string, body: unknown) => server!.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function setup() {
  const sidecar = new FakeSidecar()
  sidecar.respond('chat.start', completed)
  server = await bootTestServer({ sidecar })
  const sessions = await Promise.all([0, 1].map(() => server!.deps.sessionStore.newSession({ profile: 'default' })))
  const response = await post('/api/prompt-queues', { request_id: 'serial-proof', cards: sessions.map((s, i) => ({ session_id: s.session_id, project_id: null, text: `Synthetic prompt ${i}` })) })
  expect(response.status).toBe(200)
  return { sidecar, sessions, run: await response.json() as PromptQueueRun }
}
const read = async () => (await server!.deps.promptQueues.list()).runs[0]!
async function act(run: PromptQueueRun, action: string) {
  const response = await post(`/api/prompt-queues/${run.id}/action`, { revision: run.revision, action })
  expect(response.status).toBe(200)
  await server!.deps.promptQueues.settled()
  return read()
}
async function advance(run: PromptQueueRun) {
  const card = run.cards[run.current_step]
  if (card?.stream_id) await server!.deps.turns.finished(card.stream_id)
  server!.deps.promptQueues.wake(run.id)
  await server!.deps.promptQueues.settled()
  return read()
}

afterEach(() => { vi.restoreAllMocks() })

it('admits two direct chats exactly once, in order, only after their authoritative completion', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { sidecar, sessions, run } = await setup()
  const started: string[] = []
  sidecar.respond('chat.start', async (params) => { started.push(params.session_id); await gate; return completed(params) })
  let current = await act(run, 'start')
  await vi.waitFor(() => { expect(started).toEqual([sessions[0]!.session_id]) })
  server!.deps.promptQueues.wake(run.id)
  await server!.deps.promptQueues.settled()
  expect((await read()).cards.map((c) => c.status)).toEqual(['running', 'waiting'])
  release()
  current = await advance(current)
  current = await advance(current)
  expect(current.phase).toBe('completed')
  expect(current.cards.map((c) => c.status)).toEqual(['completed', 'completed'])
  expect(started).toEqual(sessions.map((s) => s.session_id))
  await advance(current)
  expect(started).toHaveLength(2)
})

it.each(['pause', 'cancel'])('holds successors when %s arrives during dispatch', async (action) => {
  const { run } = await setup()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entry = new Promise<void>((resolve) => { entered = resolve })
  const original = server!.deps.turns.start.bind(server!.deps.turns)
  vi.spyOn(server!.deps.turns, 'start').mockImplementation(async (...args) => { entered(); await gate; return original(...args) })
  const response = await post(`/api/prompt-queues/${run.id}/action`, { revision: run.revision, action: 'start' })
  expect(response.status).toBe(200)
  await entry
  const dispatching = await read()
  expect(dispatching.cards[0]!.status).toBe('dispatching')
  const held = await post(`/api/prompt-queues/${run.id}/action`, { revision: dispatching.revision, action })
  expect(held.status).toBe(200)
  release()
  await server!.deps.promptQueues.settled()
  let current = await advance(await read())
  expect(current.phase).toBe(action === 'pause' ? 'paused' : 'cancelled')
  expect(current.cards.map((c) => c.status)).toEqual(['completed', 'waiting'])
  if (action === 'pause') {
    current = await act(current, 'resume')
    current = await advance(current)
    expect(current.phase).toBe('completed')
  }
})

it('rejects stale actions and draft edits after start without another admission', async () => {
  const { run } = await setup()
  await act(run, 'start')
  expect((await post(`/api/prompt-queues/${run.id}/action`, { revision: run.revision, action: 'start' })).status).toBe(409)
  const response = await server!.get(`/api/prompt-queues/${run.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: run.revision, cards: run.cards }) })
  expect(response.status).toBe(409)
})

it.each(['busy', 'project', 'profile'])('refuses a changed %s target before dispatch', async (change) => {
  const { run, sessions } = await setup()
  const s = sessions[0]!
  if (change === 'busy') vi.spyOn(server!.deps.sessions, 'activeRunBlocking').mockResolvedValue('synthetic-busy')
  else { if (change === 'project') s.project_id = 'moved-project'; else s.profile = 'other-profile'; await server!.deps.sessionStore.save(s) }
  const dispatch = vi.spyOn(server!.deps.turns, 'start')
  const current = await act(run, 'start')
  expect(current.phase).toBe('refused')
  expect(current.cards[1]!.status).toBe('waiting')
  expect(dispatch).not.toHaveBeenCalled()
})

it('fails closed on a target move during shared admission preparation', async () => {
  const { run, sessions } = await setup()
  const s = sessions[0]!
  const original = server!.deps.sessions.turnWorkspace.bind(server!.deps.sessions)
  vi.spyOn(server!.deps.sessions, 'turnWorkspace').mockImplementation(async (...args) => {
    const workspace = await original(...args)
    s.project_id = 'moved-during-admission'
    return workspace
  })
  const current = await act(run, 'start')
  expect(current.phase).toBe('refused')
  expect(server!.deps.registry.activeRuns.size).toBe(0)
})

it('stops on a failed turn and never advances to the next chat', async () => {
  const { sidecar, run } = await setup()
  sidecar.respond('chat.start', (params) => ({ ...completed(params), status: 'error', failed: true, final_response: '', error: 'synthetic refusal' }))
  const current = await advance(await act(run, 'start'))
  expect(current.phase).toBe('failed')
  expect(current.cards.map((c) => c.status)).toEqual(['failed', 'waiting'])
})

it('reconciles restart and lost-ACK claims without replaying uncertain admissions', async () => {
  const { run } = await setup()
  const dispatch = vi.spyOn(server!.deps.turns, 'start').mockRejectedValueOnce(new Error('synthetic lost ACK'))
  let current = await act(run, 'start')
  expect(current.phase).toBe('unknown')
  expect(dispatch).toHaveBeenCalledTimes(1)
  await server!.deps.promptQueues.close()
  const documents = new JsonDocuments(server!.state)
  const restarted = new PromptQueues(documents, () => server!.deps)
  server!.deps.promptQueues = restarted
  await restarted.initialize()
  await restarted.settled()
  current = await read()
  expect(current.phase).toBe('unknown')
  await act(current, 'reconcile')
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect((await read()).cards[1]!.status).toBe('waiting')
  await documents.close()
})

it('hides queues across authenticated owners and profiles', async () => {
  const { run } = await setup()
  const deps = server!.deps
  await deps.requestScope.run({ requestProfile: 'default', notificationOwner: 'another-owner' }, async () => {
    expect((await deps.promptQueues.list()).runs).toEqual([])
    await expect(deps.promptQueues.action(run.id, run.revision, 'start')).rejects.toMatchObject({ status: 404 })
  })
  await deps.requestScope.run({ requestProfile: 'other-profile', notificationOwner: 'local-owner' }, async () => {
    expect((await deps.promptQueues.list()).runs).toEqual([])
    await expect(deps.promptQueues.action(run.id, run.revision, 'start')).rejects.toMatchObject({ status: 404 })
  })
})

it('uses native submission and exact admission receipts, with no direct worker or unknown replay', async () => {
  const { sessions } = await setup()
  const deps = server!.deps
  const sid = sessions[0]!.session_id
  const receipt = { admission_id: 'native-step', sequence: 1, status: 'started' as const, outcome: null as string | null, authority_epoch: 7, execution_generation: 1 }
  const snapshot = { session_id: sid, stored_session_id: sid, messages: [], message_count: 0, running: false, authority_epoch: 7, replay_epoch: 'synthetic-epoch', last_sequence: 0, subscription_id: 'synthetic', revision: 1, execution_generation: 1, pending: [], prompts: [], info: {} }
  let outcome: GatewaySessionResult = { state: 'attached', reason: null, snapshot, receipt }
  const owner = deps.sessions.owner!
  vi.spyOn(owner, 'isOwned').mockImplementation((id) => Promise.resolve(id === sid))
  const lookup = vi.spyOn(owner, 'queueReceipt').mockImplementation((id, admissionId) => Promise.resolve(id === sid ? admissionId ? outcome : { ...outcome, receipt: null } : null))
  const submit = vi.spyOn(owner, 'submit').mockResolvedValue({ admission_id: receipt.admission_id })
  const direct = vi.spyOn(deps.turns, 'start')
  const run = await deps.promptQueues.create('native-proof', [{ session_id: sid, project_id: null, text: 'Native prompt' }, { session_id: sessions[1]!.session_id, project_id: null, text: 'Later prompt' }])
  await deps.promptQueues.action(run.id, run.revision, 'start')
  await deps.promptQueues.settled()
  expect(submit).toHaveBeenCalledWith(sid, expect.objectContaining({ submission_id: run.cards[0]!.request_id }), undefined, expect.objectContaining({ authority_epoch: 7 }))
  expect(direct).not.toHaveBeenCalled()
  outcome = { ...outcome, state: 'unavailable', snapshot: null, receipt: null }
  deps.promptQueues.wake(run.id); await deps.promptQueues.settled()
  expect((await deps.promptQueues.list()).runs.find((r) => r.id === run.id)?.phase).toBe('unknown')
  outcome = { state: 'attached', reason: null, snapshot, receipt: { ...receipt, status: 'terminal', outcome: 'completed' } }
  deps.promptQueues.wake(run.id); await deps.promptQueues.settled()
  const reconciled = (await deps.promptQueues.list()).runs.find((r) => r.id === run.id)!
  expect(reconciled.phase).toBe('paused')
  expect(reconciled.cards.map((c) => c.status)).toEqual(['completed', 'waiting'])
  expect(submit).toHaveBeenCalledTimes(1)
  expect(lookup).toHaveBeenCalledWith(sid, receipt.admission_id)
})

it('preserves a Pause committed while an authoritative completion receipt is being read', async () => {
  const { run } = await setup()
  let current = await act(run, 'start')
  await server!.deps.turns.finished(current.cards[0]!.stream_id!)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entry = new Promise<void>((resolve) => { entered = resolve })
  const original = server!.deps.journal.summary.bind(server!.deps.journal)
  vi.spyOn(server!.deps.journal, 'summary').mockImplementation(async (...args) => { entered(); await gate; return original(...args) })
  server!.deps.promptQueues.wake(run.id)
  await entry
  const response = await post(`/api/prompt-queues/${run.id}/action`, { revision: current.revision, action: 'pause' })
  expect(response.status).toBe(200)
  release()
  await server!.deps.promptQueues.settled()
  current = await read()
  expect(current.phase).toBe('paused')
  expect(current.cards.map((c) => c.status)).toEqual(['completed', 'waiting'])
})

it('recovers persisted direct receipts after a queue-worker restart without admitting a step twice', async () => {
  const { run } = await setup()
  const dispatch = vi.spyOn(server!.deps.turns, 'start')
  let current = await act(run, 'start')
  await server!.deps.turns.finished(current.cards[0]!.stream_id!)
  await server!.deps.promptQueues.close()
  const documents = new JsonDocuments(server!.state)
  const restarted = new PromptQueues(documents, () => server!.deps)
  server!.deps.promptQueues = restarted
  await restarted.initialize(); await restarted.settled()
  current = await advance(await read())
  expect(current.phase).toBe('completed')
  expect(dispatch).toHaveBeenCalledTimes(2)
  expect(new Set(dispatch.mock.calls.map(([s]) => s.session_id)).size).toBe(2)
  await documents.close()
})

it('accepts immediate Pause from the Start acknowledgement despite receipt-only progress', async () => {
  const { run } = await setup()
  const response = await post(`/api/prompt-queues/${run.id}/action`, { revision: run.revision, action: 'start' })
  const acknowledged = await response.json() as PromptQueueRun
  await server!.deps.promptQueues.settled()
  expect((await read()).cards[0]!.status).toBe('running')
  const pause = await post(`/api/prompt-queues/${run.id}/action`, { revision: acknowledged.revision, action: 'pause' })
  expect(pause.status).toBe(200)
  expect((await read()).phase).toBe('paused')
})
