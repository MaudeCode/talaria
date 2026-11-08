/**
 * TAL-1628: an orderly stop drains the server's own local runs through the real `RunningServer.close`. A run that finishes
 * inside the drain budget stays completed; one still running at the deadline is saved with its prompt, its partial output
 * and exactly one interrupted terminal row and journal event before storage closes. Gateway-owned observations are left
 * alone. Each case drives the run with events and a zero or held budget, never a wall-clock wait.
 */
import { readFileSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidecarParams, SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer as bootServer, type BootOptions, type TestServer } from '../test/harness.js'
import { sessionPath, useJsonStorage } from '../test/storage.js'
import { join } from 'node:path'
import { writeContinuation } from '../tools/update-continuation.js'
import type { UpdateServiceDeps } from '../tools/updates.js'

// The cases read the saved session file after storage closed, which only the JSON backend leaves readable.
useJsonStorage()

const states: string[] = []
/** Each case closes its server itself (that is what it tests); its state directory goes afterwards. */
async function bootTestServer(opts: BootOptions): Promise<TestServer> {
  const server = await bootServer(opts)
  states.push(server.state)
  return server
}
afterEach(() => { for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true }) })

interface Row { role?: string; content?: unknown; _terminal_state?: string; _partial?: boolean; _error?: boolean }

function result(params: SidecarParams<'chat.start'>, status: 'completed' | 'cancelled', answer: string): SidecarResultInput<'chat.start'> {
  return {
    status, messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: answer }], final_response: answer, error: null, failed: false, partial: status !== 'completed', compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
    agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
  }
}

/** A sidecar whose turns stream `partial` and then hold until released (completed) or interrupted (cancelled); a turn started after release completes at once. */
function heldSidecar(): { sidecar: FakeSidecar; release: () => void; interrupts: string[] } {
  const sidecar = new FakeSidecar()
  const interrupts: string[] = []
  const held = new Map<string, (status: 'completed' | 'cancelled') => void>()
  let released = false
  sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
    held.set(params.stream_id, (status) => { resolve(result(params, status, status === 'completed' ? 'finished answer' : 'partial')) })
    emit({ event: 'token', data: { text: 'partial' } })
    if (released) held.get(params.stream_id)!('completed')
  }))
  sidecar.respond('chat.interrupt', (params) => {
    const streamId = params.stream_id ?? ''
    interrupts.push(streamId)
    held.get(streamId)?.('cancelled')
    return { ok: true, pending_steer: '' }
  })
  return { sidecar, interrupts, release: () => { released = true; for (const finish of held.values()) finish('completed') } }
}

async function startTurn(server: TestServer, message: string): Promise<{ sid: string; streamId: string }> {
  const session = await server.deps.sessionStore.newSession()
  const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: session.session_id, message }), headers: { 'content-type': 'application/json' } })
  const { stream_id: streamId } = await start.json() as { stream_id: string }
  await expect.poll(() => server.deps.registry.liveText.get(streamId)?.text).toBe('partial')
  return { sid: session.session_id, streamId }
}

const durable = (server: TestServer, sid: string): { active_stream_id: string | null; messages: Row[] } => JSON.parse(readFileSync(sessionPath(server.deps.sessionStore, sid), 'utf8')) as never

const terminalEvents = async (server: TestServer, sid: string, streamId: string) => (await server.deps.journal.readRunEvents(sid, streamId)).filter((e) => e.terminal && e.event !== 'stream_end')

describe('server close drains local runs (TAL-1628)', () => {
  it('saves a partially streamed turn as interrupted before storage closes', async () => {
    const { sidecar, release, interrupts } = heldSidecar()
    const server = await bootTestServer({ sidecar, drain: { waitMs: 0, settleMs: 5_000 } })
    try {
      const { sid, streamId } = await startTurn(server, 'hello')
      await server.running.close()
      const saved = durable(server, sid)
      expect(saved.active_stream_id).toBeNull()
      expect(saved.messages.map((m) => [m.role, m._terminal_state ?? null])).toEqual([['user', null], ['assistant', null], ['assistant', 'interrupted']])
      expect(saved.messages[0]?.content).toBe('hello')
      expect(saved.messages[1]).toMatchObject({ content: 'partial', _partial: true })
      expect(saved.messages.some((m) => m._terminal_state === 'cancelled')).toBe(false)
      expect(interrupts).toEqual([streamId])
      const terminal = await terminalEvents(server, sid, streamId)
      expect(terminal.map((e) => [e.event, (e.payload as { terminal_state?: string }).terminal_state])).toEqual([['apperror', 'interrupted']])
      expect(server.deps.registry.activeRuns.has(streamId)).toBe(false)
    } finally { release() }
  })

  it('lets a turn that finishes inside the budget complete, refusing new turns meanwhile', async () => {
    const { sidecar, release, interrupts } = heldSidecar()
    const server = await bootTestServer({ sidecar, drain: { waitMs: 60_000, settleMs: 5_000 } })
    try {
      const { sid, streamId } = await startTurn(server, 'hello')
      const other = await server.deps.sessionStore.newSession()
      let closed = false
      const closing = server.running.close().then(() => { closed = true })
      await expect.poll(() => server.deps.turns.draining).toBe(true)
      expect(await server.deps.turns.startServerTurn(other, { msg: 'wake up', source: 'process_wakeup' })).toMatchObject({ _status: 503 })
      expect(await server.deps.turns.start(other, { msg: 'hi', workspace: server.deps.config.defaultWorkspace, model: null, modelProvider: null })).toMatchObject({ _status: 503 })
      expect(closed).toBe(false)
      release()
      await closing
      const saved = durable(server, sid)
      expect(saved.active_stream_id).toBeNull()
      expect(saved.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'finished answer' })
      expect(saved.messages.some((m) => m._terminal_state === 'interrupted' || m._terminal_state === 'cancelled')).toBe(false)
      expect((await terminalEvents(server, sid, streamId)).map((e) => e.event)).toEqual(['done'])
      expect(interrupts).toEqual([])
      expect(other.active_stream_id).toBeNull()
    } finally { release() }
  })

  it('settles many runs once each and shares one drain across repeated and escalated stops', async () => {
    const { sidecar, release, interrupts } = heldSidecar()
    const server = await bootTestServer({ sidecar, drain: { waitMs: 60_000, settleMs: 5_000 } })
    try {
      const runs = [await startTurn(server, 'one'), await startTurn(server, 'two')]
      const first = server.running.close()
      const second = server.deps.turns.drain({ waitMs: 0, settleMs: 5_000 })
      await expect.poll(() => server.deps.turns.draining).toBe(true)
      server.running.escalate()
      server.running.escalate()
      await first
      expect(await second).toMatchObject({ interrupted: 2, unresolved: [] })
      expect(interrupts.sort()).toEqual(runs.map((r) => r.streamId).sort())
      for (const { sid, streamId } of runs) {
        expect(durable(server, sid).messages.filter((m) => m._terminal_state === 'interrupted')).toHaveLength(1)
        expect((await terminalEvents(server, sid, streamId)).map((e) => e.event)).toEqual(['apperror'])
      }
    } finally { release() }
  })

  it('reports an unresolved run truthfully when its interrupted outcome cannot be saved', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar, drain: { waitMs: 0, settleMs: 5_000 } })
    try {
      const { sid, streamId } = await startTurn(server, 'hello')
      const save = server.deps.sessionStore.save.bind(server.deps.sessionStore)
      vi.spyOn(server.deps.sessionStore, 'save').mockImplementation(async (s, opts) => {
        if (s.session_id === sid) throw new Error('disk full')
        return save(s, opts)
      })
      await expect(server.running.close()).rejects.toThrow(/local runs/)
      expect(durable(server, sid).active_stream_id).toBe(streamId)
      expect(server.logs.join('\n')).toContain(streamId)
    } finally { release(); vi.restoreAllMocks() }
  })

  it('reports a launch still persisting at the deadline as unresolved and never starts its worker', async () => {
    const { sidecar } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    const session = await server.deps.sessionStore.newSession()
    let entered!: () => void
    const persisting = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const save = server.deps.sessionStore.save.bind(server.deps.sessionStore)
    vi.spyOn(server.deps.sessionStore, 'save').mockImplementation(async (s, opts) => {
      if (s.session_id === session.session_id && s.pending_user_message) { entered(); await gate }
      return save(s, opts)
    })
    try {
      const admitting = server.deps.turns.start(session, { msg: 'hi', workspace: server.deps.config.defaultWorkspace, model: null, modelProvider: null })
      await persisting
      const streamId = String(session.active_stream_id)
      expect(await server.deps.turns.drain({ waitMs: 0, settleMs: 20 })).toEqual({ completed: 0, interrupted: 0, unresolved: [streamId] })
      release()
      expect(await admitting).toMatchObject({ _status: 503 })
      expect(server.deps.registry.activeRuns.has(streamId)).toBe(false)
      expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
      expect(durable(server, session.session_id).active_stream_id).toBe(streamId)
    } finally { release(); vi.restoreAllMocks(); await server.running.close().catch(() => undefined) }
  })

  it('returns at once with no local runs and leaves Gateway-owned observations running', async () => {
    const { sidecar } = heldSidecar()
    const server = await bootTestServer({ sidecar, drain: { waitMs: 60_000, settleMs: 5_000 } })
    server.deps.registry.registerActiveRun({ stream_id: 'owner:gateway-run', session_id: 'gateway-session', started_at: 1, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false, origin: 'user' })
    expect(await server.deps.turns.drain({ waitMs: 60_000, settleMs: 5_000 })).toEqual({ completed: 0, interrupted: 0, unresolved: [] })
    expect(server.deps.registry.activeRuns.has('owner:gateway-run')).toBe(true)
    expect(sidecar.calls.some((c) => c.method === 'chat.interrupt')).toBe(false)
    await server.running.close()
  })

  it('settles local runs through the same drain before a requested restart exits', async () => {
    const { sidecar } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const drain = vi.spyOn(server.deps.turns, 'drain')
    try {
      server.deps.requestRestart()
      await expect.poll(() => exit.mock.calls).toEqual([[75]])
      expect(drain.mock.calls).toEqual([[{ waitMs: 0, settleMs: expect.any(Number) as number }]])
      expect(server.deps.turns.draining).toBe(true)
      expect(await server.deps.turns.drain({ waitMs: 60_000, settleMs: 5_000 })).toEqual({ completed: 0, interrupted: 0, unresolved: [] })
    } finally { vi.restoreAllMocks(); await server.running.close().catch(() => undefined) }
  })
})

describe('a confirmed Web update interrupts the named local runs (TAL-1629)', () => {
  it('saves exactly the named runs as interrupted with their partials, leaving the others running', async () => {
    const { sidecar, release, interrupts } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const named = await startTurn(server, 'one')
      const other = await startTurn(server, 'two')
      expect(server.deps.turns.interruptibleRuns()).toEqual([named.streamId, other.streamId].sort())
      expect(await server.deps.turns.interrupt([named.streamId], 5_000)).toEqual({ interrupted: 1, unresolved: [] })
      const saved = durable(server, named.sid)
      expect(saved.active_stream_id).toBeNull()
      expect(saved.messages.map((m) => [m.role, m._terminal_state ?? null])).toEqual([['user', null], ['assistant', null], ['assistant', 'interrupted']])
      expect(saved.messages[1]).toMatchObject({ content: 'partial', _partial: true })
      expect((await terminalEvents(server, named.sid, named.streamId)).map((e) => [e.event, (e.payload as { terminal_state?: string }).terminal_state])).toEqual([['apperror', 'interrupted']])
      expect(interrupts).toEqual([named.streamId])
      expect(server.deps.registry.activeRuns.has(other.streamId)).toBe(true)
      expect(server.deps.turns.interruptibleRuns()).toEqual([other.streamId])
      // An interruption is not a shutdown: new turns are admitted again once the update lock releases.
      expect(server.deps.turns.draining).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('reports a run whose interrupted outcome could not be saved', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'hello')
      const save = server.deps.sessionStore.save.bind(server.deps.sessionStore)
      vi.spyOn(server.deps.sessionStore, 'save').mockImplementation(async (s, opts) => {
        if (s.session_id === sid) throw new Error('disk full')
        return save(s, opts)
      })
      expect(await server.deps.turns.interrupt([streamId], 5_000)).toMatchObject({ unresolved: [streamId] })
    } finally { release(); vi.restoreAllMocks(); await server.running.close().catch(() => undefined) }
  })

  it('names no interruptible runs while a Gateway-owned run is active', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      await startTurn(server, 'hello')
      server.deps.registry.registerActiveRun({ stream_id: 'owner:gateway-run', session_id: 'gateway-session', started_at: 1, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false, origin: 'user' })
      expect(server.deps.turns.interruptibleRuns()).toBeNull()
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('refuses a turn whose admission checks passed just before an update fenced admission', async () => {
    const { sidecar } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const session = await server.deps.sessionStore.newSession()
      vi.spyOn(server.deps.updates, 'blocksNewWork').mockReturnValueOnce(false).mockReturnValue(true)
      expect(await server.deps.turns.start(session, { msg: 'hi', workspace: server.deps.config.defaultWorkspace, model: null, modelProvider: null })).toMatchObject({ _status: 503, error: 'Web is updating. Retry after it restarts.' })
      expect(server.deps.registry.activeRuns.size).toBe(0)
      expect(sidecar.calls.some((c) => c.method === 'chat.start')).toBe(false)
    } finally { vi.restoreAllMocks(); await server.running.close().catch(() => undefined) }
  })

  it('offers Update anyway over HTTP for the blocked Web update, and a confirmed update still refuses a source checkout', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    const post = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => (await server.get('/api/updates/apply', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json() as never
    try {
      const { sid, streamId } = await startTurn(server, 'hello')
      const blocked = await post({ target: 'webui', version: '2.0.0', tab_id: 'tab-interrupt' })
      expect(blocked).toMatchObject({ ok: false, restart_blocked: true, interrupt_confirmation: { runs: 1 }, notification_id: expect.any(String) as string })
      const token = (blocked.interrupt_confirmation as { token: string }).token
      // The confirmation names the exact update: another version is refused again with fresh consent.
      const other = await post({ target: 'webui', version: '1.0.0', interrupt_token: token, tab_id: 'tab-interrupt' })
      expect(other).toMatchObject({ restart_blocked: true, interrupt_confirmation: { runs: 1 } })
      const confirmed = await post({ target: 'webui', version: '1.0.0', interrupt_token: (other.interrupt_confirmation as { token: string }).token, tab_id: 'tab-interrupt' })
      expect(confirmed).toMatchObject({ ok: false, manual_update: true })
      expect(server.deps.registry.activeRuns.has(streamId)).toBe(true)
      expect(durable(server, sid).messages.some((m) => m._terminal_state === 'interrupted')).toBe(false)
      expect(server.deps.updates.blocksNewWork()).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })
})

describe('chats a confirmed Web update interrupted continue once Web is back (TAL-1990)', () => {
  type Deps = Pick<UpdateServiceDeps, 'continuationRuns' | 'identity'>
  const updateDeps = (server: TestServer): Deps => (server.deps.updates as unknown as { deps: Deps }).deps
  const running = (server: TestServer): string => { const revision = updateDeps(server).identity.release().sourceRevision; return typeof revision === 'string' ? revision : '' }
  /** What a confirmed Update anyway does before install: read the runs' chats, save them as interrupted, record them. */
  async function interruptForUpdate(server: TestServer, streamIds: string[], target = running(server)): Promise<void> {
    const runs = await updateDeps(server).continuationRuns!(streamIds)
    expect(await server.deps.turns.interrupt(streamIds, 5_000)).toMatchObject({ unresolved: [] })
    writeContinuation(server.deps.config.stateDir, { update_id: 'update-1', target_revision: target, target_version: '2.0.0', runs })
  }
  const continuations = (sidecar: FakeSidecar): string[] => sidecar.calls.filter((c) => c.method === 'chat.start' && (c.params as { user_message?: string }).user_message === 'Continue where you left off.').map((c) => String((c.params as { session_id?: string }).session_id))
  const recorded = (server: TestServer): boolean => { try { readFileSync(join(server.deps.config.stateDir, 'update-continuation.json')); return true } catch { return false } }

  it('starts exactly one update_continuation turn in each interrupted chat, with no client action', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const one = await startTurn(server, 'one')
      const two = await startTurn(server, 'two')
      await interruptForUpdate(server, [one.streamId, two.streamId])
      await server.deps.updates.resumeContinuations()
      // A second pass (another boot, a reconnect) finds nothing left to continue.
      await server.deps.updates.resumeContinuations()
      await expect.poll(() => continuations(sidecar).sort()).toEqual([one.sid, two.sid].sort())
      expect(recorded(server)).toBe(false)
      for (const { sid } of [one, two]) {
        const session = await server.deps.sessionStore.get(sid)
        expect(session.pending_user_source).toBe('update_continuation')
        expect(session.pending_user_message).toBe('Continue where you left off.')
      }
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('stamps the continuation prompt as the existing server-owned automatic row', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'one')
      await interruptForUpdate(server, [streamId])
      await server.deps.updates.resumeContinuations()
      await expect.poll(() => continuations(sidecar)).toEqual([sid])
      release()
      await expect.poll(async () => (await server.deps.sessionStore.get(sid)).active_stream_id).toBeNull()
      const served = ((await (await server.get(`/api/session?session_id=${sid}&messages=1`)).json()) as { session: { messages: Record<string, unknown>[] } }).session.messages
      const prompt = served.find((m) => m.role === 'user' && m.content === 'Continue where you left off.')
      expect(prompt).toMatchObject({ _source: 'update_continuation', _background_update: { kind: 'other', summary: 'Continue where you left off.', review_state: 'reviewed' } })
      expect(served.find((m) => m.role === 'user' && m.content === 'one')).not.toHaveProperty('_background_update')
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('keeps a chat whose continuation admission refused for now, and continues it on the next pass', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'one')
      await interruptForUpdate(server, [streamId])
      // Another update fences admission between the continuation's checks and its admission.
      vi.spyOn(server.deps.updates, 'blocksNewWork').mockReturnValueOnce(false).mockReturnValueOnce(true)
      await server.deps.updates.resumeContinuations()
      expect([...server.deps.registry.activeRuns.keys()]).toEqual([])
      expect(recorded(server)).toBe(true)
      vi.restoreAllMocks()
      await server.deps.updates.resumeContinuations()
      await expect.poll(() => continuations(sidecar)).toEqual([sid])
      expect(recorded(server)).toBe(false)
    } finally { vi.restoreAllMocks(); release(); await server.running.close().catch(() => undefined) }
  })

  it('skips a chat that was deleted', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'one')
      await interruptForUpdate(server, [streamId])
      expect((await server.get('/api/session/delete', { method: 'POST', body: JSON.stringify({ session_id: sid }), headers: { 'content-type': 'application/json' } })).status).toBe(200)
      await server.deps.updates.resumeContinuations()
      expect([...server.deps.registry.activeRuns.keys()]).toEqual([])
      expect(recorded(server)).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('skips a chat that is read-only', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'one')
      await interruptForUpdate(server, [streamId])
      const session = await server.deps.sessionStore.get(sid)
      session.read_only = true
      await server.deps.sessionStore.save(session)
      await server.deps.updates.resumeContinuations()
      expect([...server.deps.registry.activeRuns.keys()]).toEqual([])
      expect(recorded(server)).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('skips a chat with a newer turn than the interrupted one', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'one')
      await interruptForUpdate(server, [streamId])
      const start = await server.get('/api/chat/start', { method: 'POST', body: JSON.stringify({ session_id: sid, message: 'newer' }), headers: { 'content-type': 'application/json' } })
      const { stream_id: newer } = await start.json() as { stream_id: string }
      expect(await server.deps.turns.interrupt([newer], 5_000)).toMatchObject({ unresolved: [] })
      await server.deps.updates.resumeContinuations()
      expect([...server.deps.registry.activeRuns.keys()]).toEqual([])
      expect(recorded(server)).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('skips a chat whose turn finished on its own before the update stopped it', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { sid, streamId } = await startTurn(server, 'one')
      const runs = await updateDeps(server).continuationRuns!([streamId])
      release()
      await expect.poll(async () => (await server.deps.sessionStore.get(sid)).active_stream_id).toBeNull()
      expect(await server.deps.turns.interrupt([streamId], 5_000)).toMatchObject({ unresolved: [] })
      writeContinuation(server.deps.config.stateDir, { update_id: 'update-1', target_revision: running(server), target_version: '2.0.0', runs })
      await server.deps.updates.resumeContinuations()
      expect([...server.deps.registry.activeRuns.keys()]).toEqual([])
      expect(recorded(server)).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })

  it('skips every chat when Web is not running the update\'s target revision', async () => {
    const { sidecar, release } = heldSidecar()
    const server = await bootTestServer({ sidecar })
    try {
      const { streamId } = await startTurn(server, 'one')
      await interruptForUpdate(server, [streamId], 'f'.repeat(40))
      await server.deps.updates.resumeContinuations()
      expect([...server.deps.registry.activeRuns.keys()]).toEqual([])
      expect(recorded(server)).toBe(false)
    } finally { release(); await server.running.close().catch(() => undefined) }
  })
})
