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

/** A sidecar whose turns stream `partial` and then hold until released (completed) or interrupted (cancelled). */
function heldSidecar(): { sidecar: FakeSidecar; release: () => void; interrupts: string[] } {
  const sidecar = new FakeSidecar()
  const interrupts: string[] = []
  const held = new Map<string, (status: 'completed' | 'cancelled') => void>()
  sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
    held.set(params.stream_id, (status) => { resolve(result(params, status, status === 'completed' ? 'finished answer' : 'partial')) })
    emit({ event: 'token', data: { text: 'partial' } })
  }))
  sidecar.respond('chat.interrupt', (params) => {
    const streamId = params.stream_id ?? ''
    interrupts.push(streamId)
    held.get(streamId)?.('cancelled')
    return { ok: true, pending_steer: '' }
  })
  return { sidecar, interrupts, release: () => { for (const finish of held.values()) finish('completed') } }
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
