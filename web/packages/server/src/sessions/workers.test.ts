import { testSessionDocuments } from '../test/storage.js'
import { jsonJournal } from '../test/storage.js'
import { JsonJournal } from './storage/json-journal.js'
import { JsonDocuments } from '../test/storage.js'
import { sessionPath, sessionDirectory } from '../test/storage.js'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SIDECAR_RPC_VERSION, type RuntimeDescribe, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { CompletionDrain, formatWakeupPrompt } from './completions.js'
import { nextSessionItem, StreamRegistry, type SessionChannels } from './streams.js'
import { HygieneTicker, rotateWebuiLog, webuiLogPaths } from '../tools/hygiene.js'
import { configFingerprint, McpHealthProber, probeServer } from '../tools/mcp-health.js'
import { agentHealth, processStartTime, remoteGatewayBaseUrl, runtimeStatusIsFresh } from '../tools/health.js'
import { str } from '../util.js'
import { withBackgroundUpdates, batchUpdate, recordBackgroundUpdate } from './background-updates.js'
import { HeldWakeups } from './wakeup-pause.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const completed = (text: string) => ({ status: 'completed' as const, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: text }], final_response: text, error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '', usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 1000 }, model: 'm', provider: 'p', compressed: false, agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [] })

describe('background completion drain', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  it('formats completion and watch prompts like the Python drain', () => {
    expect(formatWakeupPrompt({ type: 'completion', session_id: 'proc_1', command: 'make', exit_code: 0, output: 'ok' })).toBe('[IMPORTANT: Background process proc_1 completed (exit_code=0).\nCommand: make\nOutput:\nok]')
    expect(formatWakeupPrompt({ type: 'watch_match', session_id: 'p', command: 'tail', pattern: 'ERR', output: 'boom', suppressed: 2 })).toContain('(2 earlier matches were suppressed by rate limit)')
    expect(formatWakeupPrompt({ type: 'watch_disabled', message: 'too many' })).toBe('[IMPORTANT: too many]')
    expect(formatWakeupPrompt({ type: 'completion' })).toBeNull()
    expect(formatWakeupPrompt({ type: 'other' })).toBeNull()
  })

  it('routes immediate and coalesced completions to the owning profile outside request scope', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const owner = await s.deps.sessionStore.get(sid)
    owner.profile = 'work'
    await s.deps.sessionStore.save(owner)
    const root = s.deps.channels.subscribe(sid, 'default')
    const work = s.deps.channels.subscribe(sid, 'work')
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state), sidecar: () => sidecar,
      baseHome: s.state, profileHome: (profile) => s.deps.profileHome(profile ?? 'default'), activeProfile: () => 'default',
      store: s.deps.sessionStore, channels: s.deps.channels, registry: s.deps.registry,
      startTurn: () => { throw new Error('A display-only completion must not admit a turn') }, now: () => 100, log: () => undefined })
    try {
      for (const process_id of ['profile-first', 'profile-coalesced']) {
        expect(await drain.processOne({ process_id, type: 'completion', session_key: sid, consumed: false })).toBe(true)
        expect((await nextSessionItem(work, 2000))?.[0]).toBe('bg_task_complete')
        expect((await nextSessionItem(work, 200))?.[0]).toBe('process_complete')
        expect(root.queue).toEqual([])
      }
    } finally { drain.stop(); s.deps.channels.unsubscribe(sid, root); s.deps.channels.unsubscribe(sid, work) }
  })

  it('routes a completion to its session, emits bg_task_complete once, and starts a server-side wakeup turn', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const events = [{ process_id: 'proc_a', session_id: 'proc_a', type: 'completion', command: 'sleep 1', exit_code: 0, output: 'done', session_key: sid, origin_ui_session_id: sid, consumed: false }]
    let drains = 0
    sidecar.respond('process.drain', () => { drains += 1; return { events: drains === 1 ? events : [] } })
    const consumed: string[] = []
    sidecar.respond('process.mark_consumed', (params) => { consumed.push(params.process_id); return { ok: true } })
    const starts: string[] = []
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('woke up') })
    const sub = s.deps.channels.subscribe(sid)
    expect(await s.deps.completions.drainOnce()).toBe(1)
    const item = await nextSessionItem(sub, 1000)
    expect(item?.[0]).toBe('bg_task_complete')
    expect(item?.[1]).toMatchObject({ session_id: sid, task_id: 'proc_a', summary: expect.stringContaining('Background process proc_a completed') as unknown })
    expect(String((item?.[1] as Json).event_id)).toHaveLength(32)
    expect((await nextSessionItem(sub, 200))?.[0]).toBe('process_complete')
    await new Promise((r) => setTimeout(r, 300))
    expect(starts).toHaveLength(1)
    expect(starts[0]).toContain('[IMPORTANT: Background process proc_a completed (exit_code=0).')
    expect(consumed).toEqual(['proc_a'])
    // A replayed event is deduped; an already-consumed one is skipped.
    expect(await s.deps.completions.processOne(events[0]!)).toBe(true)
    expect(await s.deps.completions.processOne({ ...events[0]!, process_id: 'proc_b', consumed: true })).toBe(true)
    expect(starts).toHaveLength(1)
    s.deps.channels.unsubscribe(sid, sub)
  })

  it('defers the wakeup while a turn is active and delivers it at teardown', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const starts: string[] = []
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return starts.length === 1 ? new Promise((resolve) => { release = () => { resolve(completed('first')) } }) : completed('second') })
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    const started = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hello' }))
    expect(started.stream_id).toBeTruthy()
    await new Promise((r) => setTimeout(r, 100))
    expect(await s.deps.completions.processOne({ process_id: 'proc_c', session_id: 'proc_c', type: 'completion', command: 'build', exit_code: 1, output: 'failed', origin_ui_session_id: sid, consumed: false })).toBe(true)
    expect(s.deps.completions.deferredCount(sid)).toBe(1)
    expect(starts).toHaveLength(1)
    release()
    for (let i = 0; i < 50 && starts.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(starts).toHaveLength(2)
    expect(starts[1]).toContain('Background process proc_c completed (exit_code=1)')
    expect(s.deps.completions.deferredCount(sid)).toBe(0)
  })

  it('wakes the drain when a turn starts (TAL-1395)', async () => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    sidecar.respond('chat.start', () => completed('ok'))
    const wake = vi.spyOn(s.deps.completions, 'wake')
    try {
      expect((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hello' }))).stream_id).toBeTruthy()
      expect(wake).toHaveBeenCalled()
    } finally { wake.mockRestore() }
  })

  it('requeues async delegations it cannot route and drops orphan completions', async () => {
    const requeued: unknown[] = []
    sidecar.respond('process.drain', () => ({ events: [{ process_id: 'd1', type: 'async_delegation', session_key: 'nope', consumed: false }, { process_id: 'x', type: 'completion', session_key: 'nope', consumed: false }] }))
    sidecar.respond('process.requeue', (params) => { requeued.push(...params.events); return { requeued: params.events.length } })
    expect(await s.deps.completions.drainOnce()).toBe(0)
    expect(requeued).toHaveLength(1)
    expect((requeued[0] as Json).process_id).toBe('d1')
  })
})

describe('async delegation delivery claims (TAL-459)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const newSid = async (): Promise<string> => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    // A session is only addressable for routing once it has been persisted.
    const session = (await s.deps.sessionStore.get(sid))
    session.messages = [{ role: 'user', content: 'dispatch the delegation' }]
    await s.deps.sessionStore.save(session)
    return sid
  }
  const delegation = (sid: string, id: string): Json => ({ process_id: id, delegation_id: id, type: 'async_delegation', origin_ui_session_id: sid, consumed: false })
  /** The Agent's durable delivery ledger: a claim holds a pending row, completion marks it delivered for good. */
  const ledger = (): { delivered: Set<string>; calls: string[] } => {
    const state = { delivered: new Set<string>(), calls: [] as string[] }
    sidecar.respond('process.format_notification', (params) => ({ text: `[IMPORTANT: delegation ${str((params.event as Json).delegation_id)} finished]` }))
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    sidecar.respond('process.claim_delivery', (params) => {
      const id = str((params.event as Json).delegation_id)
      state.calls.push(`claim ${id}`)
      return { claim_id: state.delivered.has(id) ? null : `claim-${id}` }
    })
    sidecar.respond('process.complete_delivery', (params) => { const id = str((params.event as Json).delegation_id); state.calls.push(`complete ${id}`); state.delivered.add(id); return { ok: true } })
    sidecar.respond('process.release_delivery', (params) => { state.calls.push(`release ${str((params.event as Json).delegation_id)}`); return { ok: true } })
    sidecar.respond('process.defer_delivery', (params) => { state.calls.push(`defer ${str((params.event as Json).delegation_id)}`); return { ok: true } })
    return state
  }
  const drainWith = (startTurn: (prompt: string) => { _status?: number; stream_id?: string }): CompletionDrain => new CompletionDrain({ documents: new JsonDocuments(s.state),
    sidecar: () => sidecar, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore, channels: s.deps.channels, registry: s.deps.registry,
    startTurn: (_session, prompt) => startTurn(prompt), now: () => Date.now() / 1000, log: () => undefined,
  })

  it('recovers every profile\'s checkpointed processes in each new sidecar before draining it (TAL-533)', async () => {
    const fresh = new FakeSidecar()
    const handshake = (): RuntimeDescribe => ({ rpc_version: SIDECAR_RPC_VERSION }) as RuntimeDescribe
    fresh.describe = handshake()
    let failures = 2
    fresh.respond('process.recover', () => { if (failures-- > 0) throw new Error('busy'); return { homes: 2 } })
    const logged: string[] = []
    fresh.respond('process.drain', () => ({ events: [] }))
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => fresh, baseHome: '/base', profileHome: () => '/base/profiles/work', activeProfile: () => 'work', store: s.deps.sessionStore, channels: s.deps.channels,
      registry: s.deps.registry, startTurn: () => ({}), now: () => 0, log: (line) => { logged.push(line) },
    })
    // A failed recovery still drains and is retried on every pass (warned once); a recovered sidecar is not asked again until it restarts.
    for (let i = 0; i < 3; i += 1) await drain.drainOnce()
    fresh.describe = handshake()
    await drain.drainOnce()
    expect(fresh.calls.map((c) => c.method)).toEqual(['process.recover', 'process.drain', 'process.recover', 'process.drain', 'process.recover', 'process.drain', 'process.recover', 'process.drain'])
    expect(fresh.calls.filter((c) => c.method === 'process.recover').map((c) => c.params)).toEqual(Array(4).fill({ base_home: '/base' }))
    expect(logged.filter((l) => l.includes('recovery failed'))).toHaveLength(1)
  })

  it('logs a lasting drain failure once rather than on every poll (TAL-533)', async () => {
    const fresh = new FakeSidecar()
    let drains = 0
    fresh.respond('process.drain', () => { drains += 1; throw new Error('background process recovery failed for /base') })
    const logged: string[] = []
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => fresh, baseHome: '/base', profileHome: () => '/base', activeProfile: () => 'default', store: s.deps.sessionStore, channels: s.deps.channels,
      registry: s.deps.registry, startTurn: () => ({}), now: () => 0, log: (line) => { logged.push(line) }, pollMs: 5,
    })
    drain.start()
    await vi.waitFor(() => { expect(drains).toBeGreaterThanOrEqual(4) })
    drain.stop()
    expect(logged.filter((l) => l.includes('drain failed'))).toHaveLength(1)
  })

  it('backs empty drains off to 10 s and resets on routed events and wake() (TAL-1395)', async () => {
    vi.useFakeTimers()
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => null, baseHome: '/base', profileHome: () => '/base', activeProfile: () => 'default', store: s.deps.sessionStore, channels: s.deps.channels,
      registry: s.deps.registry, startTurn: () => ({}), now: () => 0, log: () => undefined,
    })
    const t0 = Date.now(), at: number[] = []
    let routed = 0
    vi.spyOn(drain, 'drainOnce').mockImplementation(() => { at.push(Date.now() - t0); return Promise.resolve(routed) })
    const gaps = (): number[] => at.slice(1).map((t, i) => t - at[i]!)
    try {
      drain.start()
      await vi.advanceTimersByTimeAsync(35_000)
      expect(gaps(), 'consecutive empty drains space out').toEqual([1000, 2000, 4000, 8000, 10_000, 10_000])
      routed = 1
      await vi.advanceTimersByTimeAsync(10_000)
      routed = 0
      await vi.advanceTimersByTimeAsync(4000)
      expect(gaps().slice(6), 'a routed drain resets the delay to 1 s').toEqual([10_000, 1000, 1000, 2000])
      await vi.advanceTimersByTimeAsync(1000)
      at.length = 0
      drain.wake()
      await vi.advanceTimersByTimeAsync(0)
      expect(at, 'wake() drains within one tick').toEqual([50_000])
      await vi.advanceTimersByTimeAsync(1000)
      expect(gaps(), 'wake() resets the delay').toEqual([1000])
    } finally {
      drain.stop()
      vi.useRealTimers()
    }
  })

  it('a restarted server does not deliver a delegation the previous one already delivered', async () => {
    const sid = await newSid()
    const state = ledger()
    const starts: string[] = []
    const event = delegation(sid, 'deleg_restart')
    // The Agent replays every still-pending completion when a new sidecar starts.
    for (const drain of [drainWith((p) => { starts.push(p); return { stream_id: 'first' } }), drainWith((p) => { starts.push(p); return { stream_id: 'second' } })]) {
      expect(await drain.processOne({ ...event })).toBe(true)
    }
    expect(starts).toHaveLength(1)
    expect(state.calls).toEqual(['claim deleg_restart', 'complete deleg_restart', 'claim deleg_restart'])
  })

  it('claims before the wakeup turn and acknowledges after it starts', async () => {
    const sid = await newSid()
    const state = ledger()
    const order: string[] = []
    const drain = drainWith((p) => { order.push(`start ${p.includes('deleg_order') ? 'deleg_order' : '?'}`); state.calls.push(order.at(-1)!); return { stream_id: 'run' } })
    expect(await drain.processOne(delegation(sid, 'deleg_order'))).toBe(true)
    expect(state.calls).toEqual(['claim deleg_order', 'start deleg_order', 'complete deleg_order'])
  })

  it("claims and acknowledges in the session's own profile ledger, not the active profile's (TAL-534)", async () => {
    const sid = await newSid()
    const session = (await s.deps.sessionStore.get(sid))
    session.profile = 'b'
    await s.deps.sessionStore.save(session)
    ledger()
    // Each profile has its own state.db ledger; only B's holds this delegation's pending row.
    const homes: string[] = []
    const delivered = new Set<string>()
    sidecar.respond('process.claim_delivery', (params) => { homes.push(`claim ${str(params.profile_home)}`); return { claim_id: params.profile_home === '/homes/b' ? 'claim-b' : '' } })
    sidecar.respond('process.complete_delivery', (params) => { homes.push(`complete ${str(params.profile_home)}`); if (params.profile_home === '/homes/b') delivered.add(str((params.event as Json).delegation_id)); return { ok: true } })
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => sidecar, baseHome: '/homes', profileHome: (profile) => `/homes/${profile ?? 'default'}`, activeProfile: () => 'a', store: s.deps.sessionStore, channels: s.deps.channels, registry: s.deps.registry,
      startTurn: () => ({ stream_id: 'run' }), now: () => Date.now() / 1000, log: () => undefined,
    })
    expect(await drain.processOne(delegation(sid, 'deleg_profile_b'))).toBe(true)
    expect(homes).toEqual(['claim /homes/b', 'complete /homes/b'])
    expect(delivered.has('deleg_profile_b')).toBe(true)
  })

  it('hands the claim back when the wakeup turn cannot start, so the row stays pending', async () => {
    const state = ledger()
    // A busy session (409) never admitted the delivery, so it costs no attempt; a failed start (500) spends one.
    for (const [status, handBack] of [[409, 'defer'], [500, 'release']] as const) {
      const sid = await newSid()
      state.calls.length = 0
      const drain = drainWith(() => ({ _status: status }))
      expect(await drain.processOne(delegation(sid, `deleg_${String(status)}`))).toBe(true)
      expect(state.calls).toEqual([`claim deleg_${String(status)}`, `${handBack} deleg_${String(status)}`])
      expect(state.delivered.has(`deleg_${String(status)}`)).toBe(false)
      expect(drain.deferredCount(sid)).toBe(1)
      drain.stop()
      await s.deps.sessionStore.delete(sid)
    }
  })

  it('leaves plain process completions to the in-memory consumed marker', async () => {
    const sid = await newSid()
    const state = ledger()
    const drain = drainWith(() => ({ stream_id: 'run' }))
    expect(await drain.processOne({ process_id: 'proc_plain', session_id: 'proc_plain', type: 'completion', command: 'make', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })).toBe(true)
    expect(state.calls).toEqual([])
  })

  /** A drain over its own registry, so a test can hold a synthetic turn open, with every notification counted. */
  const turnDrain = (startTurn: (prompt: string) => { _status?: number; stream_id?: string }): { drain: CompletionDrain; registry: StreamRegistry; notified: string[]; recorded: Json[] } => {
    const registry = new StreamRegistry()
    const notified: string[] = []
    const recorded: Json[] = []
    const channels = { emit: (_sid: string, name: string, payload: Json) => { if (name === 'bg_task_complete') notified.push(str(payload.task_id)); return 1 } } as unknown as SessionChannels
    // Each emit is past the coalescing window, so every notification surfaces at once and can be counted.
    let clock = 0
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => sidecar, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore, channels, registry,
      startTurn: (_session, prompt) => startTurn(prompt), now: () => (clock += 5), log: () => undefined,
      background: { recordEvent: (_sid, evt) => { recorded.push(evt) } },
    })
    return { drain, registry, notified, recorded }
  }
  const holdTurn = (registry: StreamRegistry, sid: string): void => { registry.registerActiveRun({ stream_id: 'held', session_id: sid, started_at: 0, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false }) }

  it('batches delegations and a process completion that land mid-turn into one continuation turn (TAL-228)', async () => {
    const sid = await newSid()
    const state = ledger()
    const consumed: string[] = []
    sidecar.respond('process.mark_consumed', (params) => { consumed.push(str(params.process_id)); return { ok: true } })
    const requeued: Json[] = []
    sidecar.respond('process.requeue', (params) => { requeued.push(...(params.events as Json[])); return { requeued: params.events.length } })
    const events = [
      delegation(sid, 'deleg_a'), delegation(sid, 'deleg_b'),
      { process_id: 'proc_x', session_id: 'proc_x', type: 'completion', command: 'make', exit_code: 0, output: 'built', origin_ui_session_id: sid, consumed: false },
      { process_id: 'proc_done', session_id: 'proc_done', type: 'completion', command: 'ls', exit_code: 0, output: 'seen', origin_ui_session_id: sid, consumed: true },
      delegation('no-such-session', 'deleg_lost'),
    ] as SidecarResult<'process.drain'>['events']
    let drains = 0
    sidecar.respond('process.drain', () => { drains += 1; return { events: drains === 1 ? events : [] } })
    const statuses: number[] = [409, 500, 200]
    const attempts: string[] = []
    const { drain, registry, notified } = turnDrain((prompt) => { attempts.push(prompt); const status = statuses.shift()!; return status === 200 ? { stream_id: 'wake' } : { _status: status } })
    holdTurn(registry, sid)
    try {
      expect(await drain.drainOnce()).toBe(4)
      // Nothing is claimed or started while the turn runs; the unroutable delegation goes back to the Agent's queue.
      expect(drain.deferredCount(sid)).toBe(3)
      expect(attempts).toEqual([])
      expect(state.calls).toEqual([])
      expect(requeued.map((e) => e.process_id)).toEqual(['deleg_lost'])
      expect(notified).toEqual(['deleg_a', 'deleg_b', 'proc_x'])
      // A teardown while the turn is still registered delivers nothing.
      expect(await drain.drainDeferred(sid)).toBe(0)
      registry.activeRuns.delete('held')
      // A busy session (409) defers every claim without spending a delivery attempt.
      expect(await drain.drainDeferred(sid)).toBe(0)
      expect(state.calls).toEqual(['claim deleg_a', 'claim deleg_b', 'defer deleg_a', 'defer deleg_b'])
      expect(drain.deferredCount(sid)).toBe(3)
      // A transient failure releases the claims and keeps every entry for redelivery.
      state.calls.length = 0
      expect(await drain.drainDeferred(sid)).toBe(0)
      expect(state.calls).toEqual(['claim deleg_a', 'claim deleg_b', 'release deleg_a', 'release deleg_b'])
      expect(drain.deferredCount(sid)).toBe(3)
      expect(consumed).toEqual([])
      state.calls.length = 0
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(attempts).toHaveLength(3)
      // Every attempt, and the one turn that started, carries exactly the three unconsumed results.
      for (const prompt of attempts) {
        expect(prompt).toContain('delegation deleg_a finished')
        expect(prompt).toContain('delegation deleg_b finished')
        expect(prompt).toContain('Background process proc_x completed')
        expect(prompt).not.toContain('proc_done')
        expect(prompt).not.toContain('deleg_lost')
      }
      expect(state.calls).toEqual(['claim deleg_a', 'claim deleg_b', 'complete deleg_a', 'complete deleg_b'])
      expect([...state.delivered].sort()).toEqual(['deleg_a', 'deleg_b'])
      // Delegations settle in their ledger; only the process exit is marked consumed.
      expect(consumed).toEqual(['proc_x'])
      expect(drain.deferredCount(sid)).toBe(0)
      expect(await drain.drainDeferred(sid)).toBe(0)
      expect(notified).toEqual(['deleg_a', 'deleg_b', 'proc_x'])
    } finally {
      drain.stop()
    }
  })

  it('keeps a delegation that overflows the wakeup batch claimable for the next teardown (TAL-228)', async () => {
    const sid = await newSid()
    const state = ledger()
    // Two results too large to share one wakeup turn.
    sidecar.respond('process.format_notification', (params) => ({ text: `[IMPORTANT: delegation ${str((params.event as Json).delegation_id)} finished]\n${'x'.repeat(15_000)}` }))
    const attempts: string[] = []
    const { drain, registry } = turnDrain((prompt) => { attempts.push(prompt); return { stream_id: 'wake' } })
    holdTurn(registry, sid)
    try {
      expect(await drain.processOne(delegation(sid, 'deleg_big1'))).toBe(true)
      expect(await drain.processOne(delegation(sid, 'deleg_big2'))).toBe(true)
      registry.activeRuns.delete('held')
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(drain.deferredCount(sid)).toBe(1)
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(attempts.map((p) => /deleg_big\d/.exec(p)?.[0])).toEqual(['deleg_big1', 'deleg_big2'])
      expect(state.calls).toEqual(['claim deleg_big1', 'complete deleg_big1', 'claim deleg_big2', 'complete deleg_big2'])
    } finally {
      drain.stop()
    }
  })

  it('drops a deferred completion the agent awaited in its own turn and still wakes for an unawaited sibling (TAL-532)', async () => {
    const sid = await newSid()
    ledger()
    const consumed: string[] = []
    sidecar.respond('process.mark_consumed', (params) => { consumed.push(str(params.process_id)); return { ok: true } })
    // The Agent marks a process consumed (wait/log) or poll-observed only after its completion event was drained.
    const awaited = new Set<string>()
    sidecar.respond('process.consumed', (params) => ({ consumed: params.process_ids.filter((id) => awaited.has(id)) }))
    const completion = (id: string): Json => ({ process_id: id, session_id: id, type: 'completion', command: `run ${id}`, exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
    const attempts: string[] = []
    const { drain, registry } = turnDrain((prompt) => { attempts.push(prompt); return { stream_id: 'wake' } })
    holdTurn(registry, sid)
    try {
      expect(await drain.processOne(completion('proc_awaited'))).toBe(true)
      expect(await drain.processOne(completion('proc_sibling'))).toBe(true)
      expect(drain.deferredCount(sid)).toBe(2)
      awaited.add('proc_awaited')
      registry.activeRuns.delete('held')
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toContain('Background process proc_sibling completed')
      expect(attempts[0]).not.toContain('proc_awaited')
      expect(consumed.sort()).toEqual(['proc_awaited', 'proc_sibling'])
      // Only an awaited process pending: no wakeup turn at all.
      holdTurn(registry, sid)
      expect(await drain.processOne(completion('proc_waited'))).toBe(true)
      awaited.add('proc_waited')
      registry.activeRuns.delete('held')
      expect(await drain.drainDeferred(sid)).toBe(0)
      expect(attempts).toHaveLength(1)
      expect(drain.deferredCount(sid)).toBe(0)
      // Waiting on a process consumes its exit, not a watch match it raised: that notice still wakes.
      holdTurn(registry, sid)
      expect(await drain.processOne({ process_id: 'proc_watched', session_id: 'proc_watched', type: 'watch_match', pattern: 'ERR', command: 'tail log', output: 'ERR boom', origin_ui_session_id: sid, consumed: false })).toBe(true)
      awaited.add('proc_watched')
      registry.activeRuns.delete('held')
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(attempts[1]).toContain('Background process proc_watched matched watch pattern "ERR"')
    } finally {
      drain.stop()
    }
  })

  /** One watched process's events as the Agent enqueues them: each match, the watch giving up, then the exit. */
  const watched = (sid: string, id: string): Record<'match' | 'disabled' | 'exit', Json> => ({
    match: { process_id: id, session_id: id, type: 'watch_match', pattern: 'ready', command: 'npm run dev', output: 'ready on :3000', origin_ui_session_id: sid, consumed: false },
    disabled: { process_id: id, session_id: id, type: 'watch_disabled', message: `Watch patterns disabled for ${id}; you'll get exactly one notification when the process exits.`, origin_ui_session_id: sid, consumed: false },
    exit: { process_id: id, session_id: id, type: 'completion', command: 'npm run dev', exit_code: 1, output: 'crashed', origin_ui_session_id: sid, consumed: false },
  })

  it('wakes an idle session for every event of a watched process, not only the first (TAL-724)', async () => {
    const sid = await newSid()
    ledger()
    const consumed: string[] = []
    sidecar.respond('process.mark_consumed', (params) => { consumed.push(str(params.process_id)); return { ok: true } })
    const attempts: string[] = []
    const { drain, notified, recorded } = turnDrain((prompt) => { attempts.push(prompt); return { stream_id: `w${String(attempts.length)}` } })
    const events = watched(sid, 'proc_w')
    try {
      expect(await drain.processOne(events.match)).toBe(true)
      expect(await drain.processOne(events.disabled)).toBe(true)
      expect(attempts, 'each watch event wakes the session').toHaveLength(2)
      expect(consumed, 'a wakeup carrying only watch events consumes no exit').toEqual([])
      expect(await drain.processOne(events.exit)).toBe(true)
      expect(attempts).toHaveLength(3)
      expect(attempts[0]).toContain('Background process proc_w matched watch pattern "ready"')
      expect(attempts[1]).toContain('Watch patterns disabled for proc_w')
      expect(attempts[2]).toContain('Background process proc_w completed (exit_code=1)')
      expect(notified).toEqual(['proc_w', 'proc_w', 'proc_w'])
      // The exit settles the background record with its output.
      expect(recorded.map((e) => e.type)).toEqual(['watch_match', 'watch_disabled', 'completion'])
      expect(consumed).toEqual(['proc_w'])
      // A completion enqueued twice (kill racing the reader thread) still wakes once.
      expect(await drain.processOne({ ...events.exit })).toBe(true)
      expect(attempts).toHaveLength(3)
      // Only that per-process delivery is remembered; a watch event cannot repeat, so it leaves nothing behind.
      expect((drain as unknown as { seen: Map<string, Set<string>> }).seen.get(sid)).toEqual(new Set(['proc_w']))
    } finally {
      drain.stop()
    }
  })

  it('defers a watch match and the exit of one process mid-turn and batches both at teardown (TAL-724)', async () => {
    const sid = await newSid()
    ledger()
    sidecar.respond('process.consumed', () => ({ consumed: [] }))
    const attempts: string[] = []
    const { drain, registry } = turnDrain((prompt) => { attempts.push(prompt); return { stream_id: 'wake' } })
    const events = watched(sid, 'proc_m')
    holdTurn(registry, sid)
    try {
      expect(await drain.processOne(events.match)).toBe(true)
      expect(await drain.processOne(events.exit)).toBe(true)
      expect(drain.deferredCount(sid)).toBe(2)
      registry.activeRuns.delete('held')
      expect(await drain.drainDeferred(sid)).toBe(1)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toContain('Background process proc_m matched watch pattern "ready"')
      expect(attempts[0]).toContain('Background process proc_m completed (exit_code=1)')
    } finally {
      drain.stop()
    }
  })
})

describe('process notifications follow the owning profile (TAL-933, TAL-907)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  /** A session on profile `b` while `a` is active; only the owning profile's config counts. An `Error` config is unreadable. */
  const setup = async (configs: Record<string, Json | Error>, opts: { env?: Record<string, string>; root?: string; profile?: string | null; fail?: () => boolean } = {}): Promise<{ sid: string; drain: CompletionDrain; starts: string[]; consumed: string[]; requeued: Json[]; notified: string[]; recorded: string[]; logs: string[] }> => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    session.profile = opts.profile === undefined ? 'b' : opts.profile
    session.messages = [{ role: 'user', content: 'delegate the build' }]
    await s.deps.sessionStore.save(session)
    const starts: string[] = []
    const consumed: string[] = []
    const requeued: Json[] = []
    const notified: string[] = []
    const recorded: string[] = []
    const logs: string[] = []
    sidecar.respond('process.mark_consumed', (params) => { consumed.push(str(params.process_id)); return { ok: true } })
    sidecar.respond('process.requeue', (params) => { requeued.push(...(params.events as Json[])); return { requeued: params.events.length } })
    const channels = { emit: (_sid: string, name: string, payload: Json) => { if (name === 'bg_task_complete') notified.push(str(payload.task_id)); return 1 } } as unknown as SessionChannels
    const drain = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => sidecar, baseHome: opts.root ?? '/homes', profileHome: (profile) => `${opts.root ?? '/homes'}/${profile ?? 'default'}`, activeProfile: () => 'a', store: s.deps.sessionStore, channels, registry: s.deps.registry,
      readConfig: (home: string) => { const config = configs[home]; return config instanceof Error ? Promise.reject(config) : Promise.resolve(config ?? {}) }, env: opts.env ?? {},
      background: { recordEvent: (_sid, evt) => { recorded.push(str(evt.process_id)) } },
      startTurn: (_session, prompt) => { if (opts.fail?.()) return { _status: 500, error: 'down' }; starts.push(prompt); return { stream_id: 'run' } }, now: () => Date.now() / 1000, log: (line) => { logs.push(line) },
    })
    return { sid, drain, starts, consumed, requeued, notified, recorded, logs }
  }
  const optIn = { delegation: { surface_child_process_notifications: true } }
  type Drained = SidecarResult<'process.drain'>['events'][number]
  const exit = (sid: string, id: string, child: boolean): Drained => ({ process_id: id, session_id: id, type: 'completion', command: 'npm test', exit_code: 0, output: 'ok', owner_task_id: child ? 'sa-0-abc' : '', session_key: sid, consumed: false, child_process: child })

  it("drops a subagent's process completion without waking the parent when the profile does not opt in", async () => {
    // The active profile's opt-in does not count for a session owned by profile b.
    const { sid, drain, starts, consumed, requeued, notified } = await setup({ '/homes/a': optIn })
    sidecar.respond('process.drain', () => ({ events: [exit(sid, 'proc_child', true)] }))
    expect(await drain.drainOnce()).toBe(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(starts).toEqual([])
    expect(notified).toEqual([])
    // Left unconsumed, so the child's teardown still reports an exit nobody read.
    expect(consumed).toEqual([])
    expect(requeued).toEqual([])
    drain.stop()
  })

  it('wakes the parent when the owning profile sets surface_child_process_notifications: true', async () => {
    const { sid, drain, starts, consumed } = await setup({ '/homes/b': optIn })
    expect(await drain.processOne(exit(sid, 'proc_child_on', true))).toBe(true)
    expect(starts).toHaveLength(1)
    expect(starts[0]).toContain('Background process proc_child_on completed')
    expect(consumed).toEqual(['proc_child_on'])
    drain.stop()
  })

  it("still wakes the session for its own process completion and routes async delegations unchanged", async () => {
    const { sid, drain, starts, requeued } = await setup({})
    sidecar.respond('process.format_notification', () => ({ text: '[ASYNC DELEGATION COMPLETE — deleg_sa]' }))
    sidecar.respond('process.claim_delivery', () => ({ claim_id: 'c' }))
    sidecar.respond('process.complete_delivery', () => ({ ok: true }))
    const delegation = (id: string, origin: string): Drained => ({ process_id: id, delegation_id: id, type: 'async_delegation', owner_task_id: 'sa-0-abc', origin_ui_session_id: origin, consumed: false, child_process: false })
    sidecar.respond('process.drain', () => ({ events: [exit(sid, 'proc_own', false), delegation('deleg_sa', sid), delegation('deleg_elsewhere', 'gone')] }))
    expect(await drain.drainOnce()).toBe(2)
    expect(starts.join('\n')).toContain('Background process proc_own completed')
    expect(starts.join('\n')).toContain('ASYNC DELEGATION COMPLETE — deleg_sa')
    expect(requeued.map((e) => e.process_id)).toEqual(['deleg_elsewhere'])
    drain.stop()
  })

  const notifications = (mode: unknown): Json => ({ display: { background_process_notifications: mode } })
  const watch = (sid: string, id: string): Drained => ({ process_id: id, session_id: id, type: 'watch_match', pattern: 'ERR', command: 'tail', output: 'ERR', session_key: sid, consumed: false })
  const beat = (sid: string, id: string): Drained => ({ process_id: id, session_id: id, type: 'heartbeat', session_key: sid, consumed: false })

  it('settles every process event without waking the session when the owning profile sets background_process_notifications: off', async () => {
    // The active profile's `all` does not count for a session owned by profile b.
    const { sid, drain, starts, notified, recorded } = await setup({ '/homes/a': notifications('all'), '/homes/b': notifications('off') })
    sidecar.respond('process.format_notification', () => ({ text: '[IMPORTANT: still running]' }))
    for (const evt of [exit(sid, 'proc_off', false), watch(sid, 'proc_watch'), beat(sid, 'proc_beat')]) expect(await drain.processOne(evt)).toBe(true)
    expect(starts).toEqual([])
    expect(drain.deferredCount(sid)).toBe(0)
    // The background record settles and the status row still reaches the session.
    expect(recorded).toEqual(['proc_off', 'proc_watch', 'proc_beat'])
    expect(notified).toEqual(['proc_off'])
    drain.stop()
  })

  it.each(['concise', 'all', 'result', undefined])('wakes the session as before when the owning profile sets %s', async (mode) => {
    const { sid, drain, starts } = await setup({ '/homes/a': notifications('off'), '/homes/b': notifications(mode) })
    expect(await drain.processOne(exit(sid, `proc_${String(mode)}`, false))).toBe(true)
    expect(starts).toHaveLength(1)
    drain.stop()
  })

  it('treats a YAML false as off and lets HERMES_BACKGROUND_NOTIFICATIONS override the config', async () => {
    const yamlOff = await setup({ '/homes/b': notifications(false) })
    expect(await yamlOff.drain.processOne(exit(yamlOff.sid, 'proc_false', false))).toBe(true)
    expect(yamlOff.starts).toEqual([])
    yamlOff.drain.stop()
    const envOff = await setup({ '/homes/b': notifications('all') }, { env: { HERMES_BACKGROUND_NOTIFICATIONS: ' OFF ' } })
    expect(await envOff.drain.processOne(exit(envOff.sid, 'proc_env', false))).toBe(true)
    expect(envOff.starts).toEqual([])
    envOff.drain.stop()
    const envOn = await setup({ '/homes/b': notifications('off') }, { env: { HERMES_BACKGROUND_NOTIFICATIONS: 'all' } })
    expect(await envOn.drain.processOne(exit(envOn.sid, 'proc_env_on', false))).toBe(true)
    expect(envOn.starts).toHaveLength(1)
    envOn.drain.stop()
  })

  it("honours HERMES_BACKGROUND_NOTIFICATIONS from the owning profile's .env over the server environment", async () => {
    const root = mkdtempSync(join(tmpdir(), 'tal907-'))
    try {
      mkdirSync(join(root, 'b'))
      // The Agent's dotenv load expands references against the file's earlier values, then the environment.
      for (const dotenv of ['HERMES_BACKGROUND_NOTIFICATIONS=off', 'MODE=off\nHERMES_BACKGROUND_NOTIFICATIONS=${MODE}', 'HERMES_BACKGROUND_NOTIFICATIONS="${UNSET:-off}"', 'HERMES_BACKGROUND_NOTIFICATIONS=${SHELL_MODE}']) {
        writeFileSync(join(root, 'b', '.env'), `${dotenv}\n`)
        const { sid, drain, starts } = await setup({ [`${root}/b`]: notifications('all') }, { root, env: { HERMES_BACKGROUND_NOTIFICATIONS: 'all', SHELL_MODE: 'off' } })
        expect(await drain.processOne(exit(sid, 'proc_profile_env', false))).toBe(true)
        expect(starts, dotenv).toEqual([])
        drain.stop()
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reads a session without a profile from the root profile, not the active one', async () => {
    const { sid, drain, starts } = await setup({ '/homes/default': notifications('off'), '/homes/a': notifications('all') }, { profile: null })
    expect(await drain.processOne(exit(sid, 'proc_root', false))).toBe(true)
    expect(starts).toEqual([])
    drain.stop()
  })

  it('applies off switched on while the wakeup waited for the active turn', async () => {
    const configs: Record<string, Json> = { '/homes/b': notifications('all') }
    const { sid, drain, starts } = await setup(configs)
    s.deps.registry.activeRuns.set('busy-907', { session_id: sid } as never)
    try {
      expect(await drain.processOne(exit(sid, 'proc_deferred', false))).toBe(true)
      expect(drain.deferredCount(sid)).toBe(1)
    } finally { s.deps.registry.activeRuns.delete('busy-907') }
    configs['/homes/b'] = notifications('off')
    expect(await drain.drainDeferred(sid)).toBe(0)
    expect(starts).toEqual([])
    expect(drain.deferredCount(sid)).toBe(0)
    drain.stop()
  })

  it('a muted wakeup resets the retry budget a failing provider spent', async () => {
    const configs: Record<string, Json> = { '/homes/b': notifications('all') }
    let failing = true
    const { sid, drain, logs } = await setup(configs, { fail: () => failing })
    for (let i = 0; i < 6; i += 1) await drain.processOne(exit(sid, `proc_fail_${String(i)}`, false))
    expect(logs.filter((l) => l.includes('retry budget exhausted'))).toHaveLength(1)
    configs['/homes/b'] = notifications('off')
    await drain.processOne(exit(sid, 'proc_muted', false))
    configs['/homes/b'] = notifications('all')
    await drain.processOne(exit(sid, 'proc_after', false))
    // A fresh failure after notifications came back gets its timed retry again.
    expect(logs.filter((l) => l.includes('retry budget exhausted'))).toHaveLength(1)
    failing = false
    drain.stop()
  })

  it('retains the wakeup without starting a turn while the setting is unreadable', async () => {
    const configs: Record<string, Json | Error> = { '/homes/b': new Error('config.yaml is being replaced') }
    const { sid, drain, starts } = await setup(configs)
    expect(await drain.processOne(exit(sid, 'proc_unreadable', false))).toBe(true)
    expect(starts).toEqual([])
    expect(drain.deferredCount(sid)).toBe(1)
    configs['/homes/b'] = notifications('concise')
    await drain.drainDeferred(sid)
    expect(starts).toHaveLength(1)
    drain.stop()
  })

  it('still delivers and acknowledges a subagent result when notifications are off', async () => {
    const { sid, drain, starts } = await setup({ '/homes/b': notifications('off') })
    const ledger: string[] = []
    sidecar.respond('process.format_notification', () => ({ text: '[ASYNC DELEGATION COMPLETE — deleg_off]' }))
    sidecar.respond('process.claim_delivery', () => { ledger.push('claim'); return { claim_id: 'c' } })
    sidecar.respond('process.complete_delivery', () => { ledger.push('complete'); return { ok: true } })
    expect(await drain.processOne({ process_id: 'deleg_off', delegation_id: 'deleg_off', type: 'async_delegation', origin_ui_session_id: sid, consumed: false })).toBe(true)
    expect(starts).toEqual(['[ASYNC DELEGATION COMPLETE — deleg_off]'])
    expect(ledger).toEqual(['claim', 'complete'])
    drain.stop()
  })
})

describe('background wakeups carry their update metadata (TAL-371)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const newSid = async (): Promise<string> => {
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    session.messages = [{ role: 'user', content: 'start the work', timestamp: 1 }, { role: 'assistant', content: 'Started.', timestamp: 2 }]
    await s.deps.sessionStore.save(session)
    return sid
  }
  const wakeupRow = async (sid: string): Promise<Json | undefined> => {
    for (let i = 0; i < 60; i += 1) {
      const messages = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1`))).session as Json).messages as Json[]
      const row = messages.find((m) => m._source === 'process_wakeup')
      if (row && typeof row._turn_id === 'string') {
        await s.deps.turns.finished(row._turn_id)
        const settled = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1`))).session as Json).messages as Json[]
        return settled.find((m) => m._source === 'process_wakeup')
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return undefined
  }
  beforeAll(() => {
    sidecar.respond('chat.start', (params) => ({ ...completed('Handled.'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Handled.' }] }))
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
    sidecar.respond('process.format_notification', (params) => ({ text: `[ASYNC DELEGATION BATCH COMPLETE — ${str((params.event as Json).delegation_id)}]\nresults` }))
  })

  it('a finished delegation batch is a delegation update', async () => {
    const sid = await newSid()
    const chat = sidecar.responderFor('chat.start')
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    let release = (): void => undefined
    sidecar.respond('chat.start', (params) => new Promise((resolve) => {
      release = () => { resolve({ ...completed('Handled.'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Handled.' }] }) }
      started()
    }))
    const get = s.get
    const read = vi.spyOn(s, 'get')
    try {
      await s.deps.completions.processOne({ process_id: 'deleg_ok', delegation_id: 'deleg_ok', type: 'async_delegation', origin_ui_session_id: sid, consumed: false, goals: ['Audit the PVCs', 'Check\nbackups'], results: [{ status: 'completed' }, { status: 'success' }] })
      await running
      const stream = (await s.deps.sessionStore.get(sid)).active_stream_id!
      // The response was projected while running, but the worker finishes before its caller reads it.
      read.mockImplementationOnce(async (path, init) => {
        const response = await get(path, init)
        await response.clone().text()
        release()
        await s.deps.turns.finished(stream)
        return response
      })
      const row = await wakeupRow(sid)
      expect(row, 'the wakeup row settled into the transcript').toBeDefined()
      // TAL-460: one completion line per finished agent, from the structured event.
      expect(row?._background_update).toEqual({ kind: 'delegation', attention: false, count: 1, summary: 'ASYNC DELEGATION BATCH COMPLETE — deleg_ok', review_state: 'reviewed', lines: [
        { kind: 'agent', status: 'completed', label: 'Audit the PVCs', review_state: 'reviewed' }, { kind: 'agent', status: 'completed', label: 'Check', review_state: 'reviewed' },
      ] })
    } finally { release(); read.mockRestore(); sidecar.respond('chat.start', chat) }
  })

  it('a failed process completion is a process update that needs attention', async () => {
    const sid = await newSid()
    await s.deps.completions.processOne({ process_id: 'proc_fail', session_id: 'proc_fail', type: 'completion', command: 'make test', exit_code: 2, output: '1 failed', origin_ui_session_id: sid, consumed: false })
    const row = await wakeupRow(sid)
    expect(row, 'the wakeup row settled into the transcript').toBeDefined()
    expect(row?._background_update).toEqual({ kind: 'process', attention: true, count: 1, summary: 'IMPORTANT: Background process proc_fail completed (exit_code=2).', review_state: 'reviewed', lines: [{ kind: 'command', status: 'failed', label: 'make test', exit_code: 2, review_state: 'failed' }] })
  })

  it('a heartbeat starts a background-origin turn and persists its prompt hidden (TAL-790)', async () => {
    const sid = await newSid()
    const formatter = sidecar.responderFor('process.format_notification')
    const prompt = '[Background process proc_beat heartbeat #1: tests are progressing]'
    let source: unknown
    const chat = sidecar.responderFor('chat.start')
    sidecar.respond('process.format_notification', () => ({ text: prompt }))
    sidecar.respond('chat.start', async (params) => {
      source = s.deps.registry.activeRuns.get((await s.deps.sessionStore.get(sid)).active_stream_id!)?.origin
      return { ...completed('Tests are progressing.'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Tests are progressing.' }] }
    })
    try {
      await s.deps.completions.processOne({ process_id: 'proc_beat', session_id: 'proc_beat', type: 'heartbeat', command: 'npm test', seq: 1, interval: 60, elapsed: 61, output: 'test passed', origin_ui_session_id: sid, consumed: false })
      const row = await wakeupRow(sid)
      expect(source).toBe('background')
      expect(row).toMatchObject({ content: prompt, _display: 'hidden', display_kind: 'hidden', _background_update: { kind: 'process', attention: false } })
      const document = JSON.parse(readFileSync(sessionPath(s.deps.sessionStore, sid), 'utf8')) as { messages: Json[] }
      expect(document.messages.find((m) => m._source === 'process_wakeup')).toMatchObject({ display_kind: 'hidden' })
      expect((await settled(sid)).findLast((m) => m.role === 'assistant')).toMatchObject({ content: 'Tests are progressing.', _background_reply: true, _display: 'row' })
    } finally {
      sidecar.respond('process.format_notification', formatter)
      sidecar.respond('chat.start', chat)
    }
  })

  it('a batch delivered after a turn is one mixed update', async () => {
    const sid = await newSid()
    s.deps.completions.recordDeferred(sid, 'deleg_mix', '[ASYNC DELEGATION BATCH COMPLETE — deleg_mix]\nresults', { process_id: 'deleg_mix', delegation_id: 'deleg_mix', type: 'async_delegation', goal: 'Scan the logs', results: [{ status: 'failed' }] })
    s.deps.completions.recordDeferred(sid, 'proc_mix', '[IMPORTANT: Background process proc_mix completed (exit_code=0).\nCommand: ls]', { process_id: 'proc_mix', type: 'completion', command: 'ls', exit_code: 0 })
    await s.deps.completions.drainDeferred(sid)
    const row = await wakeupRow(sid)
    expect(row, 'the wakeup row settled into the transcript').toBeDefined()
    expect(row?._background_update).toEqual({ kind: 'mixed', attention: true, count: 2, summary: 'ASYNC DELEGATION BATCH COMPLETE — deleg_mix', review_state: 'reviewed', lines: [
      { kind: 'agent', status: 'failed', label: 'Scan the logs', review_state: 'failed' }, { kind: 'command', status: 'completed', label: 'ls', exit_code: 0, review_state: 'reviewed' },
    ] })
  })

  const settled = async (sid: string): Promise<Json[]> => {
    await wakeupRow(sid)
    return ((await json(await s.get(`/api/session?session_id=${sid}&messages=1`))).session as Json).messages as Json[]
  }

  it('marks the reply to a background update, and a silence marker as a silent reply (TAL-460)', async () => {
    const replies = ['The backup finished; nothing to do.', '[SILENT]', ' no reply. ']
    for (const reply of replies) {
      const sid = await newSid()
      sidecar.respond('chat.start', (params) => ({ ...completed(reply), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: reply }] }))
      await s.deps.completions.processOne({ process_id: `proc_${String(replies.indexOf(reply))}`, session_id: 'p', type: 'completion', command: 'backup', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
      const answer = (await settled(sid)).findLast((m) => m.role === 'assistant')
      expect(answer?._background_reply, reply).toBe(true)
      if (reply === replies[0]) expect(answer, reply).not.toHaveProperty('_background_silent')
      else expect(answer?._background_silent, reply).toBe(true)
      // TAL-600: the server, not the client, hides a silent reply; the update's own row always shows.
      expect(answer?._display, reply).toBe(reply === replies[0] ? 'row' : 'hidden')
      expect((await wakeupRow(sid))?._display, reply).toBe('row')
      expect(((await wakeupRow(sid))?._background_update as Json)?.review_state, 'terminal parent review').toBe('reviewed')
    }
  })

  it('projects parent review from active admission through silent settlement, replay, paging and reload (TAL-1022)', async () => {
    const sid = await newSid()
    let release = (): void => undefined
    let prompt = ''
    const chat = sidecar.responderFor('chat.start')
    sidecar.respond('chat.start', (params) => {
      prompt = str(params.user_message)
      return new Promise((resolve) => { release = () => { resolve({ ...completed('[SILENT]'), messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: '[SILENT]' }] }) } })
    })
    try {
      await s.deps.completions.processOne({ process_id: 'review-live', delegation_id: 'review-live', type: 'async_delegation', origin_ui_session_id: sid, goals: ['Live review'], results: [{ status: 'completed' }] })
      await vi.waitFor(() => { expect(prompt).not.toBe('') })
      const stream = (await s.deps.sessionStore.get(sid)).active_stream_id!
      const detail = async (suffix = ''): Promise<Json[]> => ((await json(await s.get(`/api/session?session_id=${sid}&messages=1${suffix}`))).session as Json).messages as Json[]
      expect((await detail()).find((m) => m._background_update)?._background_update).toMatchObject({ review_state: 'reviewing', lines: [{ label: 'Live review', review_state: 'reviewing' }] })
      expect((await detail('&msg_limit=1')).find((m) => m._background_update)?._background_update).toMatchObject({ review_state: 'reviewing', lines: [{ review_state: 'reviewing' }] })
      release()
      await s.deps.turns.finished(stream)
      const frames = await s.sse(`/api/chat/stream?stream_id=${stream}&replay=1`, (f) => f.event === 'stream_end')
      const terminal = (frames.find((f) => f.event === 'done')?.data as Json).session as Json
      expect((terminal.messages as Json[]).find((m) => m._background_update)?._background_update).toMatchObject({ review_state: 'reviewed' })
      await s.deps.sessionStore.evictOverCap(0)
      for (const suffix of ['', '&msg_limit=1']) {
        const messages = await detail(suffix)
        expect(messages.find((m) => m._background_update)?._background_update).toMatchObject({ review_state: 'reviewed', lines: [{ review_state: 'reviewed' }] })
        expect(messages.every((m) => m._background_review_terminal === undefined)).toBe(true)
      }
    } finally { release(); sidecar.respond('chat.start', chat) }
  })

  it('never silences or marks a reply the user asked for', async () => {
    const sid = await newSid()
    sidecar.respond('chat.start', (params) => ({ ...completed('NO_REPLY'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'NO_REPLY' }] }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'say NO_REPLY' }))
    await s.sse(`/api/chat/stream?stream_id=${String(start.stream_id)}`, (f) => f.event === 'stream_end')
    const messages = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1`))).session as Json).messages as Json[]
    const answer = messages.findLast((m) => m.role === 'assistant')
    expect(answer?.content).toBe('NO_REPLY')
    expect(answer).not.toHaveProperty('_background_reply')
    expect(answer).not.toHaveProperty('_background_silent')
  })

  it('tells only background turns how to stay silent, and never streams a silence marker', async () => {
    const prompts: Record<string, string> = {}
    const streamed = async (sid: string, start: () => Promise<string>, chunks: string[]): Promise<string> => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      sidecar.respond('chat.start', async (params, emit) => {
        prompts[sid] = str(params.ephemeral_system_prompt)
        for (const text of chunks) emit({ event: 'token', data: { text } })
        await gate
        return { ...completed(chunks.join('')), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: chunks.join('') }] }
      })
      const streamId = await start().finally(release)
      const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
      return frames.filter((f) => f.event === 'token').map((f) => str((f.data as Json).text)).join('')
    }
    const background = (sid: string, id: string) => async (): Promise<string> => {
      await s.deps.completions.processOne({ process_id: id, session_id: id, type: 'completion', command: 'sync', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
      for (let i = 0; i < 60 && !(await s.deps.sessionStore.get(sid)).active_stream_id; i += 1) await new Promise((r) => setTimeout(r, 20))
      return str((await s.deps.sessionStore.get(sid)).active_stream_id)
    }
    const silentSid = await newSid()
    expect(await streamed(silentSid, background(silentSid, 'proc_silent'), [' [SIL', 'ENT', ']'])).toBe('')
    expect(prompts[silentSid]).toContain('This turn was started by a background result, not by the user. If it needs nothing from the user, reply exactly [SILENT]. Otherwise tell the user what matters.')
    const spokenSid = await newSid()
    expect(await streamed(spokenSid, background(spokenSid, 'proc_spoken'), ['[SIL', 'ENT] is not all: ', 'the sync failed'])).toBe('[SILENT] is not all: the sync failed')
    const userSid = await newSid()
    expect(await streamed(userSid, async () => str((await json(await post(s, '/api/chat/start', { session_id: userSid, message: 'hi' }))).stream_id), ['[SIL', 'ENT]'])).toBe('[SILENT]')
    expect(prompts[userSid]).not.toContain('started by a background result')
  })
})

describe('wakeups pause while the credential pool is empty (TAL-576)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let starts: string[]
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    writeFileSync(join(s.state, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'sk-old', last_status: 'exhausted', request_count: 9 }] } }))
  })
  afterAll(() => s.close())

  const poolEmpty = (): void => { sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return { ...completed(''), messages: [{ role: 'user', content: str(params.user_message) }], status: 'error' as const, failed: true, error: 'All 2 credential(s) exhausted for provider openrouter' } }) }
  const idle = async (): Promise<void> => { for (let i = 0; i < 100 && s.deps.registry.activeRuns.size; i += 1) await new Promise((r) => setTimeout(r, 20)) }
  const complete = async (sid: string, id: string): Promise<void> => {
    await s.deps.completions.processOne({ process_id: id, session_id: id, type: 'completion', command: 'make', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
    await new Promise((r) => setTimeout(r, 50))
    await idle()
  }
  const heldFile = (): Record<string, Json[]> => { try { return JSON.parse(readFileSync(join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json'), 'utf8')) as Record<string, Json[]> } catch { return {} } }
  const heldIndex = (): string[] => Object.keys(heldFile())
  const heldIds = (sid: string): unknown[] => (heldFile()[sid] ?? []).map((e) => e.process_id)
  const pausedSession = async (): Promise<string> => {
    starts = []
    poolEmpty()
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    await complete(sid, `${sid}_1`)
    expect(starts).toHaveLength(1)
    return sid
  }

  it('starts no further wakeup turn until the credentials change', async () => {
    const sid = await pausedSession()
    await complete(sid, `${sid}_2`)
    await complete(sid, `${sid}_3`)
    expect(starts, 'a paused session starts no wakeup turn').toHaveLength(1)
    // Held with their payload in one durable file, so a restart before the pause lifts loses none.
    expect(heldIds(sid), 'paused wakeups are held').toEqual([`${sid}_2`, `${sid}_3`])
    expect(str(heldFile()[sid]![0]!.wakeup_prompt)).toContain(`Background process ${sid}_2 completed`)
    expect(s.deps.completions.deferredCount(sid)).toBe(0)
    expect(heldIndex()).toContain(sid)
    expect((await s.deps.sessionStore.get(sid)).process_wakeup_pause).toMatchObject({ paused: true, classification: 'credential_pool_empty' })
    // Token refresh and request telemetry are no credential change.
    writeFileSync(join(s.state, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'sk-rotated', last_status: 'ok', request_count: 10 }] } }))
    await complete(sid, `${sid}_4`)
    expect(starts).toHaveLength(1)
    // An added key is.
    writeFileSync(join(s.state, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'sk-rotated' }, { api_key: 'sk-new' }] } }))
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('woke up') })
    await complete(sid, `${sid}_5`)
    // The new completion wakes the session; its teardown delivers the ones held while paused once its save commits.
    for (let i = 0; i < 100 && starts.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20))
    await idle()
    expect(starts).toHaveLength(3)
    expect(starts[1]).toContain(`Background process ${sid}_5 completed`)
    expect(starts[2]).toContain(`Background process ${sid}_2 completed`)
    expect(heldIndex()).not.toContain(sid)
    expect((await s.deps.sessionStore.get(sid)).process_wakeup_pause).toBeNull()
  })

  it('holds a watch match and the exit of one process as two wakeups and delivers both (TAL-724)', async () => {
    const sid = await pausedSession()
    const id = `${sid}_w`
    await s.deps.completions.processOne({ process_id: id, session_id: id, type: 'watch_match', pattern: 'ready', command: 'npm run dev', output: 'ready', origin_ui_session_id: sid, consumed: false })
    await complete(sid, id)
    expect(starts).toHaveLength(1)
    // Each held under its own id, so a reader that keys by process id alone (the Stable release after a rollback) keeps both.
    const ids = heldIds(sid)
    expect(ids, 'both events of the process are held').toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids[1]).toBe(id)
    expect((heldFile()[sid]![0]!.event as Json).process_id).toBe(id)
    writeFileSync(join(s.state, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'sk-724', label: 'added' }] } }))
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('woke up') })
    sidecar.respond('process.consumed', () => ({ consumed: [] }))
    await s.deps.completions.drainDeferred(sid)
    await idle()
    expect(starts).toHaveLength(2)
    expect(starts[1]).toContain(`Background process ${id} matched watch pattern "ready"`)
    expect(starts[1]).toContain(`Background process ${id} completed`)
    expect(heldIndex()).not.toContain(sid)
  })

  it('keeps the exit held after a watch match held under its bare process id before TAL-724', async () => {
    const sid = await pausedSession()
    const id = `${sid}_old`
    const path = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    writeFileSync(path, JSON.stringify({ ...heldFile(), [sid]: [{ process_id: id, wakeup_prompt: '[IMPORTANT: old watch matched]', event: { process_id: id, session_id: id, type: 'watch_match' } }] }))
    await complete(sid, id)
    expect(heldIds(sid)).toEqual([id, id])
    writeFileSync(join(s.state, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'sk-724', label: 'legacy' }] } }))
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('woke up') })
    sidecar.respond('process.consumed', () => ({ consumed: [] }))
    await s.deps.completions.drainDeferred(sid)
    await idle()
    expect(starts[1]).toContain('[IMPORTANT: old watch matched]')
    expect(starts[1]).toContain(`Background process ${id} completed`)
    expect(heldIndex()).not.toContain(sid)
  })

  it('a successful user turn clears the pause and delivers the held wakeups', async () => {
    const sid = await pausedSession()
    await complete(sid, `${sid}_2`)
    expect(starts).toHaveLength(1)
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('ok') })
    await json(await post(s, '/api/chat/start', { session_id: sid, message: 'hello' }))
    for (let i = 0; i < 100 && starts.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20))
    expect(starts[1]).toContain('hello')
    expect(starts[2]).toContain(`Background process ${sid}_2 completed`)
    await idle()
    expect((await s.deps.sessionStore.get(sid)).process_wakeup_pause).toBeNull()
  })

  it('keeps held wakeups until a turn admits them, and a restarted server resumes them', async () => {
    const sid = await pausedSession()
    await complete(sid, `${sid}_2`)
    expect(heldIds(sid)).toEqual([`${sid}_2`])
    writeFileSync(join(s.state, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ api_key: 'sk-a' }, { api_key: 'sk-b' }, { api_key: 'sk-c' }] } }))
    // The pause lifts but the turn is refused: the held copy stays on disk.
    const refused = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => sidecar, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore, channels: s.deps.channels, registry: s.deps.registry,
      startTurn: () => ({ _status: 500, error: 'boom' }), now: () => Date.now() / 1000, log: () => undefined,
    })
    await refused.drainDeferred(sid)
    refused.stop()
    expect((await s.deps.sessionStore.get(sid)).process_wakeup_pause).toBeNull()
    expect(heldIds(sid)).toEqual([`${sid}_2`])
    expect(heldIndex()).toContain(sid)
    // A new server's first drain resumes the session and the admitted wakeup leaves the disk.
    const prompts: string[] = []
    const restarted = new FakeSidecar()
    restarted.describe = { rpc_version: SIDECAR_RPC_VERSION } as RuntimeDescribe
    // One broken profile fails recovery; the held sessions resume regardless.
    restarted.respond('process.recover', () => { throw new Error('unrecoverable checkpoint') })
    restarted.respond('process.drain', () => ({ events: [] }))
    restarted.respond('process.mark_consumed', () => ({ ok: true }))
    const resumed = new CompletionDrain({ documents: new JsonDocuments(s.state),
      sidecar: () => restarted, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore, channels: s.deps.channels, registry: s.deps.registry,
      startTurn: (_session, prompt) => { prompts.push(prompt); return { stream_id: 'resumed' } }, now: () => Date.now() / 1000, log: () => undefined,
    })
    // A transient load failure on resume keeps the held copy.
    const load = vi.spyOn(s.deps.sessionStore, 'get').mockImplementationOnce(() => { throw new Error('EIO') })
    await resumed.drainOnce()
    await new Promise((r) => setTimeout(r, 50))
    load.mockRestore()
    expect(prompts).toEqual([])
    expect(heldIds(sid)).toEqual([`${sid}_2`])
    // The failed load arms the standard timed retry; firing it now stands in for the 30 s wait.
    const timers = (resumed as unknown as { retryTimers: Map<string, NodeJS.Timeout> }).retryTimers
    expect(timers.has(sid), 'a retry is scheduled').toBe(true)
    clearTimeout(timers.get(sid))
    timers.delete(sid)
    await resumed.drainDeferred(sid)
    for (let i = 0; i < 50 && !prompts.length; i += 1) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 50))
    expect(prompts[0]).toContain(`Background process ${sid}_2 completed`)
    expect(heldIds(sid)).toEqual([])
    expect(heldIndex()).not.toContain(sid)
  })

  it('does not hold a wakeup when the pause lifted during the pool lookup', async () => {
    const sid = await pausedSession()
    const session = (await s.deps.sessionStore.get(sid))
    session.model_provider = 'openrouter'
    session.process_wakeup_pause = { ...(session.process_wakeup_pause as Json), provider: 'openrouter' }
    await s.deps.sessionStore.save(session)
    // A user turn succeeds while the lookup is in flight; the pool itself still reports no usable entry.
    sidecar.respond('usage.pool', async () => { (await s.deps.sessionStore.get(sid)).process_wakeup_pause = null; return { entries: [] } })
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('ok') })
    await complete(sid, `${sid}_2`)
    sidecar.respond('usage.pool', () => { throw new Error('unset') })
    expect(starts[1]).toContain(`Background process ${sid}_2 completed`)
    expect(heldIds(sid)).toEqual([])
  })

  it('never overwrites a held file it cannot read', async () => {
    const path = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    const sid = await pausedSession()
    writeFileSync(path, '{"other": [{"process_id": "x", "wakeup_prompt": "kept"}]')
    await complete(sid, `${sid}_2`)
    expect(readFileSync(path, 'utf8')).toBe('{"other": [{"process_id": "x", "wakeup_prompt": "kept"}]')
    expect(s.deps.completions.deferredCount(sid), 'the wakeup is kept in memory instead').toBe(1)
    rmSync(path)
  })

  it('never revives a session deleted during the pool lookup', async () => {
    const sid = await pausedSession()
    const session = (await s.deps.sessionStore.get(sid))
    session.model_provider = 'openrouter'
    session.process_wakeup_pause = { ...(session.process_wakeup_pause as Json), provider: 'openrouter' }
    await s.deps.sessionStore.save(session)
    sidecar.respond('usage.pool', async () => { (await s.deps.sessionStore.delete(sid)); return { entries: [{ credential_id: 'k', label: 'k', status: 'available' as const, unavailable_reason: null, retry_after: null, matches_api_key: false }] } })
    await complete(sid, `${sid}_2`)
    sidecar.respond('usage.pool', () => { throw new Error('unset') })
    expect(starts).toHaveLength(1)
    expect(existsSync(sessionPath(s.deps.sessionStore, sid)), 'the deleted session stays deleted').toBe(false)
    expect(heldIndex()).not.toContain(sid)
  })

  const standalone = (startTurn: (prompt: string) => { _status?: number; stream_id?: string }): CompletionDrain => new CompletionDrain({ documents: new JsonDocuments(s.state),
    sidecar: () => sidecar, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore, channels: s.deps.channels, registry: s.deps.registry,
    startTurn: (_session, prompt) => startTurn(prompt), now: () => Date.now() / 1000, log: () => undefined,
  })

  it('rechecks later when the held store is unreadable', async () => {
    const path = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    writeFileSync(path, '{"partial": ')
    const drain = standalone(() => ({ stream_id: 'x' }))
    await drain.drainDeferred(sid)
    const timers = (drain as unknown as { retryTimers: Map<string, NodeJS.Timeout> }).retryTimers
    expect(timers.has(sid), 'an unreadable store is retried, not read as empty').toBe(true)
    drain.stop()
    rmSync(path)
  })

  it('serializes concurrent drains so a held wakeup is delivered once', async () => {
    const path = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    writeFileSync(path, JSON.stringify({ [sid]: [{ process_id: `${sid}_w`, wakeup_prompt: '[IMPORTANT: watch matched]', event: { type: 'watch_match' } }] }))
    const prompts: string[] = []
    const drain = standalone((prompt) => { prompts.push(prompt); return { stream_id: `w${String(prompts.length)}` } })
    await Promise.all([drain.drainDeferred(sid), drain.drainDeferred(sid)])
    drain.stop()
    expect(prompts).toEqual(['[IMPORTANT: watch matched]'])
    expect(heldIndex()).not.toContain(sid)
  })

  it('never redelivers an admitted wakeup whose release could not be written', async () => {
    const path = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    writeFileSync(path, JSON.stringify({ [sid]: [{ process_id: `${sid}_n`, wakeup_prompt: '[IMPORTANT: notice]', event: { type: 'watch_disabled' } }] }))
    const prompts: string[] = []
    const drain = standalone((prompt) => { prompts.push(prompt); return { stream_id: `n${String(prompts.length)}` } })
    const store = (drain as unknown as { heldWakeups: { release: (...args: unknown[]) => void } }).heldWakeups
    const release = vi.spyOn(store, 'release').mockImplementation(() => { throw new Error('EACCES') })
    await drain.drainDeferred(sid)
    await drain.drainDeferred(sid)
    expect(prompts, 'the admitted wakeup is not delivered again').toEqual(['[IMPORTANT: notice]'])
    // The release is retried and succeeds once the file is writable again.
    release.mockRestore()
    await drain.drainDeferred(sid)
    drain.stop()
    expect(prompts).toHaveLength(1)
    expect(heldIndex()).not.toContain(sid)
  })

  it('never rewrites a held file with a malformed entry', async () => {
    const path = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    const sid = await pausedSession()
    const malformed = JSON.stringify({ other: [{ process_id: 1, wakeup_prompt: 'kept' }] })
    writeFileSync(path, malformed)
    await complete(sid, `${sid}_2`)
    expect(readFileSync(path, 'utf8')).toBe(malformed)
    expect(s.deps.completions.deferredCount(sid)).toBe(1)
    rmSync(path)
  })

  it('drops the held wakeups of a deleted session', async () => {
    const sid = await pausedSession()
    await complete(sid, `${sid}_2`)
    expect(heldIds(sid)).toEqual([`${sid}_2`])
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
    await s.deps.completions.drainDeferred(sid)
    expect(heldIndex()).not.toContain(sid)
  })

  it('rechecks the pool at its retry deadline and delivers the held wakeups', async () => {
    // The session names no provider (the config's implicit one): only the pool of the provider the Agent resolved counts,
    // never another provider's usable key.
    const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
    expect((await s.deps.sessionStore.get(sid)).model_provider).toBeNull()
    // The pool stays exhausted until the test opens it, however slow the runner; each answer names a deadline 200 ms out,
    // so a recheck before the pool opens simply pauses again (TAL-975).
    let poolOpen = false
    const asked: string[] = []
    sidecar.respond('usage.pool', (params) => {
      asked.push(params.provider)
      const status = params.provider === 'openrouter' && !poolOpen ? 'exhausted' as const : 'available' as const
      return { entries: [{ credential_id: 'k1', label: 'k1', status, unavailable_reason: null, retry_after: new Date(Date.now() + 200).toISOString(), matches_api_key: false }] }
    })
    starts = []
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return { ...completed(''), provider: 'openrouter', messages: [{ role: 'user', content: str(params.user_message) }], status: 'error' as const, failed: true, error: 'All 2 credential(s) exhausted for provider openrouter' } })
    await complete(sid, `${sid}_1`)
    await complete(sid, `${sid}_2`)
    expect(starts).toHaveLength(1)
    sidecar.respond('chat.start', (params) => { starts.push(str(params.user_message)); return completed('ok') })
    poolOpen = true
    for (let i = 0; i < 100 && starts.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20))
    expect(starts[1], 'the deadline alone resumes the held wakeup').toContain(`Background process ${sid}_2 completed`)
    expect(new Set(asked)).toEqual(new Set(['openrouter']))
    await idle()
    expect((await s.deps.sessionStore.get(sid)).process_wakeup_pause).toBeNull()
  })
})

describe('hygiene tick', () => {
  it('copy-truncates oversized logs into <log>.1 and honours the size cap', () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-hygiene-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'bootstrap-8787.log')
    writeFileSync(log, 'x'.repeat(2048))
    const lines: string[] = []
    expect(rotateWebuiLog([log], 4096, (l) => lines.push(l))).toBe(false)
    expect(rotateWebuiLog([log], 1024, (l) => lines.push(l))).toBe(true)
    expect(statSync(log).size).toBe(0)
    expect(readFileSync(`${log}.1`, 'utf8')).toHaveLength(2048)
    expect(lines[0]).toContain('Rotated the WebUI log')
    expect(rotateWebuiLog([log], 0, () => undefined)).toBe(false)
    expect(webuiLogPaths({ HERMES_WEBUI_LOG_FILE: '/var/log/talaria.log' }, dir, 1)).toEqual(['/var/log/talaria.log'])
    expect(webuiLogPaths({ HERMES_WEBUI_LOG_FILE: 'relative.log' }, dir, 8787)).toEqual([log])
  })

  it('prunes settled run journals past retention while keeping the newest three and live writers', async () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-journal-${String(process.pid)}-${String(Date.now())}`)
    const journal = new JsonJournal(dir)
    const now = Date.now() / 1000
    for (let i = 0; i < 5; i += 1) {
      const w = (await journal.writer('sess1', `run${String(i)}`))
      await w.appendSseEvent('token', { text: 'hi' })
      await w.appendSseEvent('done', { session: {} })
      await w.appendSseEvent('stream_end', {})
      await w.close()
    }
    const live = (await journal.writer('sess1', 'live'))
    await live.appendSseEvent('done', { session: {} })
    await live.appendSseEvent('stream_end', {})
    await live.close()
    const dryRun = await journal.pruneSettled({ now: now + 30 * 86400, retentionSeconds: 14 * 86400, keepRecent: 3, dryRun: true })
    expect(dryRun).toMatchObject({ examined: 6, terminal: 6, pruned: 3 })
    // Files are brand new: nothing is older than the cutoff unless the clock says so.
    expect((await journal.pruneSettled({ now, retentionSeconds: 14 * 86400, keepRecent: 3 })).pruned).toBe(0)
    // The oldest run still has a live writer: retention must leave it alone; the two newest are kept.
    const activePath = journal.pathFor('sess1', 'run0')
    const result = await journal.pruneSettled({ now: now + 30 * 86400, retentionSeconds: 14 * 86400, keepRecent: 2, isActive: (p) => p === activePath })
    expect(result.pruned).toBe(3)
    expect(existsSync(activePath)).toBe(true)
    expect(existsSync(journal.pathFor('sess1', 'live'))).toBe(true)
    const summaries = ['run0', 'run1', 'run2', 'run3', 'run4', 'live'].filter((r) => existsSync(join(dir, '_run_journal', 'sess1', `${r}.summary.json`)))
    expect(summaries).toEqual(['run1', 'run2', 'run3'])
    const pruned = JSON.parse(readFileSync(join(dir, '_run_journal', 'sess1', `${summaries[0] ?? ''}.summary.json`), 'utf8')) as Json
    expect(pruned).toMatchObject({ journal_pruned: true, terminal: true, terminal_state: 'completed' })
    expect((await journal.latestRunSummary('sess1', summaries[0] ?? ''))).toMatchObject({ journal_pruned: true })
  })
})

describe('run-journal retention sweep', () => {
  const DAY = 86400
  const old = Date.now() / 1000 - 30 * DAY
  const writeRun = async (journal: JsonJournal, sid: string, runId: string, opts: { terminal?: boolean; bytes?: number; mtime?: number } = {}): Promise<string> => {
    const w = (await journal.writer(sid, runId))
    await w.appendSseEvent('token', { text: 'x'.repeat(opts.bytes ?? 2) })
    if (opts.terminal ?? true) { (await w.appendSseEvent('done', { session: {} })); (await w.appendSseEvent('stream_end', {})) }
    await w.close()
    const path = journal.pathFor(sid, runId)
    utimesSync(path, opts.mtime ?? old, opts.mtime ?? old)
    return path
  }
  const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => { const p = join(d.parentPath, d.name); return `${p}:${String(statSync(p).size)}:${String(statSync(p).mtimeMs)}` }).sort()
  const ticker = (journal: JsonJournal, clock: { now: number }, log: string[] = []) =>
    new HygieneTicker({ env: {}, stateDir: journal.sessionDir, port: () => 0, journal, now: () => clock.now, log: (line) => log.push(line) })
  const dirs: string[] = []
  const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'talaria-retention-')); dirs.push(dir); return dir }
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
  const gated = () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    return { gate, release }
  }

  it('answers HTTP while a retention sweep over a large backlog is still running', async () => {
    const s = await bootTestServer()
    // The sweep yields normally for its first units of work, then holds until HTTP has been answered.
    const { gate, release } = gated()
    try {
      const journal = jsonJournal(s.deps.journal)
      // Terminal and nonterminal journals, a few with tails past the 4 MiB read bound.
      for (let i = 0; i < 40; i += 1) {
        for (let r = 0; r < 5; r += 1) (await writeRun(journal, `sess${String(i)}`, `run${String(r)}`, { bytes: i < 2 ? 5 * 1024 * 1024 : 64 * 1024, mtime: old + r }))
        await writeRun(journal, `sess${String(i)}`, 'open', { terminal: false, mtime: old - 1 })
      }
      let reached!: () => void
      const midSweep = new Promise<void>((resolve) => { reached = resolve })
      let pauses = 0
      const prune = journal.pruneSettled.bind(journal)
      journal.pruneSettled = async (opts) => (await prune({ ...opts, pause: () => { pauses += 1; if (pauses < 20) return new Promise((resolve) => setImmediate(resolve)); reached(); return gate } }))
      let settled = false
      const sweep = Promise.resolve(s.deps.hygiene.tick()).then(() => { settled = true })
      await Promise.race([midSweep, sweep])
      const health = await s.get('/health')
      expect(health.status).toBe(200)
      expect(settled).toBe(false)
      release()
      await sweep
      for (const sid of ['sess0', 'sess39']) {
        expect(existsSync(journal.pathFor(sid, 'run0'))).toBe(false)
        expect(existsSync(journal.pathFor(sid, 'run2'))).toBe(true)
        expect(existsSync(journal.pathFor(sid, 'open'))).toBe(true)
      }
    } finally {
      // A failed assertion must not leave close() waiting on a held sweep.
      release()
      await s.close()
    }
  })

  it('waits for a running sweep on server close and stops it there', async () => {
    const s = await bootTestServer()
    const { gate, release } = gated()
    try {
      const journal = jsonJournal(s.deps.journal)
      for (let r = 0; r < 5; r += 1) (await writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r }))
      const prune = journal.pruneSettled.bind(journal)
      journal.pruneSettled = async (opts) => (await prune({ ...opts, pause: () => gate }))
      void s.deps.hygiene.tick()
      const before = tree(s.state)
      // The server's own close (the harness close also deletes the state dir).
      let closed = false
      const closing = s.running.close().then(() => { closed = true })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(closed).toBe(false)
      release()
      await closing
      expect(tree(s.state)).toEqual(before)
    } finally {
      release()
      await s.close()
    }
  })

  it('runs one sweep at a time, recovers after a failure, and stops on shutdown', async () => {
    const journal = new JsonJournal(tempDir())
    for (let r = 0; r < 5; r += 1) (await writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r }))
    const clock = { now: Date.now() / 1000 }
    const log: string[] = []
    const t = ticker(journal, clock, log)
    const prune = journal.pruneSettled.bind(journal)
    let calls = 0
    journal.pruneSettled = () => { calls += 1; return Promise.reject(new Error('disk gone')) }
    await t.tick()
    expect(log.at(-1)).toBe('[webui] WARNING: run-journal retention failed: disk gone')
    // A failed sweep releases its slot: the next interval runs a real one.
    let { gate, release } = gated()
    journal.pruneSettled = async (opts) => { calls += 1; return (await prune({ ...opts, pause: () => gate })) }
    clock.now += 6 * 3600
    const first = t.tick()
    expect(t.tick()).toBe(first)
    expect(calls).toBe(2)
    release()
    await first
    expect(log.at(-1)).toMatch(/^\[webui\] run-journal retention pruned 2 files/)
    // Stop aborts the in-flight sweep at its next yield and prevents later sweeps.
    for (let r = 5; r < 8; r += 1) (await writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r }))
    ;({ gate, release } = gated())
    clock.now += 6 * 3600
    const stopped = t.tick()
    const before = tree(journal.sessionDir)
    // stop() hands back the in-flight sweep so shutdown can wait for it.
    const stopping = t.stop()
    expect(stopping).toBe(stopped)
    release()
    await stopping
    expect(tree(journal.sessionDir)).toEqual(before)
    clock.now += 6 * 3600
    await t.tick()
    expect(calls).toBe(3)
  })

  it('drains asynchronous hygiene sweeps on stop and logs their failures', async () => {
    const journal = new JsonJournal(tempDir())
    const log: string[] = []
    let reject!: (error: Error) => void
    const gate = new Promise<void>((_, fail) => { reject = fail })
    void gate.catch(() => { /* the baseline ticker discards this promise */ })
    let calls = 0
    const ticker = new HygieneTicker({ env: {}, stateDir: journal.sessionDir, port: () => 0, journal, now: () => 1000, log: (line) => { log.push(line) }, sweeps: [() => { calls += 1; return gate }] })
    try {
      const first = ticker.tick()
      await new Promise<void>((resolve) => setImmediate(resolve))
      const second = ticker.tick()
      let stopped = false
      const stopping = ticker.stop().then(() => { stopped = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stopped, 'shutdown must wait for the pending storage sweep').toBe(false)
      expect(calls).toBe(1)
      reject(new Error('synthetic storage failure'))
      await Promise.all([first, second, stopping])
      expect(log).toContain('[webui] WARNING: hygiene sweep failed: synthetic storage failure')
      await ticker.tick()
      expect(calls).toBe(1)
    } finally { reject(new Error('test cleanup')); await ticker.stop() }
  })

  it('never compacts a journal that gains a writer or changes while the sweep yields', async () => {
    const journal = new JsonJournal(tempDir())
    const paths = await Promise.all(['run0', 'run1', 'run2', 'run3', 'run4', 'run5'].map(async (r, i) => (await writeRun(journal, 'sess', r, { mtime: old + i }))))
    const [activated, appended, replaced, racing, pruned] = paths as [string, string, string, string, string]
    const active = new Set<string>()
    // The racing journal already has a summary; rolling back restores it.
    writeFileSync(racing.replace(/\.jsonl$/, '.summary.json'), '{"prior":true}')
    let racingChecks = 0
    let pauses = 0
    const result = await journal.pruneSettled({
      now: Date.now() / 1000, retentionSeconds: 14 * DAY, keepRecent: 1,
      isActive: (p) => active.has(p) || (p === racing && (racingChecks += 1) > 1),
      // One pause opens the session and one follows each of its six parsed journals; the last precedes compaction.
      pause: async () => {
        pauses += 1
        if (pauses === 7) {
          active.add(activated)
          appendFileSync(appended, '\n')
          utimesSync(appended, old, old)
          // Rewritten in place with the same bytes and mtime: inode, size, and mtime all match, so only ctime tells it
          // apart. Wait past the filesystem's ctime granularity first.
          await new Promise((resolve) => setTimeout(resolve, 20))
          writeFileSync(replaced, readFileSync(replaced))
          utimesSync(replaced, old + 2, old + 2)
        }
      },
    })
    expect(result.pruned).toBe(1)
    for (const p of [activated, appended, replaced, racing]) {
      expect(existsSync(p)).toBe(true)
      expect(existsSync(p.replace(/\.jsonl$/, '.summary.json'))).toBe(p === racing)
    }
    expect(readFileSync(racing.replace(/\.jsonl$/, '.summary.json'), 'utf8')).toBe('{"prior":true}')
    expect(existsSync(pruned)).toBe(false)
    expect(existsSync(paths[5] ?? '')).toBe(true)
  })

  it('stops during the metadata pass before parsing any journal', async () => {
    const journal = new JsonJournal(tempDir())
    for (let r = 0; r < 6; r += 1) (await writeRun(journal, 'sess', `run${String(r)}`, { mtime: old + r }))
    const controller = new AbortController()
    // The abort lands on the next loop turn, while the sweep is listing and stat-ing the session's journals.
    const result = await journal.pruneSettled({ now: Date.now() / 1000, retentionSeconds: 14 * DAY, keepRecent: 1, signal: controller.signal, pause: () => { setImmediate(() => { controller.abort() }); return Promise.resolve() } })
    expect(result).toEqual({ examined: 6, terminal: 0, pruned: 0, bytes_reclaimed: 0 })
  })

  it('keeps nonterminal and recent journals, writes faithful summaries, and leaves dry runs and disabled retention untouched', async () => {
    const dir = tempDir()
    const journal = new JsonJournal(dir)
    const now = Date.now() / 1000
    await writeRun(journal, 'sess', 'a', { mtime: old })
    await writeRun(journal, 'sess', 'b', { mtime: old })
    await writeRun(journal, 'sess', 'c', { mtime: old })
    const live = (await writeRun(journal, 'sess', 'live', { terminal: false, mtime: old - DAY }))
    appendFileSync(journal.pathFor('sess', 'a'), '{not json\n')
    utimesSync(journal.pathFor('sess', 'a'), old, old)
    await writeRun(journal, 'small', 'only', { mtime: old })
    const before = tree(dir)
    expect(await new JsonJournal(dir, { HERMES_WEBUI_RUN_JOURNAL_RETENTION_DAYS: '0' }).pruneSettled({ now })).toEqual({ examined: 0, terminal: 0, pruned: 0, bytes_reclaimed: 0 })
    const dry = await journal.pruneSettled({ now, keepRecent: 1, dryRun: true })
    expect(dry).toMatchObject({ examined: 5, terminal: 3, pruned: 2 })
    expect(tree(dir)).toEqual(before)
    const expected = JsonJournal.summaryFromEvents('sess', 'a', (await journal.readRunEvents('sess', 'a')))
    expect(await journal.pruneSettled({ now, keepRecent: 1 })).toMatchObject({ pruned: 2 })
    // Equal mtimes keep the path that sorts last; the nonterminal journal and a session under the keep count stay.
    expect(['a', 'b', 'c', 'live'].map((r) => existsSync(journal.pathFor('sess', r)))).toEqual([false, false, true, true])
    expect(existsSync(live)).toBe(true)
    expect(existsSync(journal.pathFor('small', 'only'))).toBe(true)
    const summary = JSON.parse(readFileSync(join(dir, '_run_journal', 'sess', 'a.summary.json'), 'utf8')) as Json
    expect(summary).toMatchObject({ ...expected, journal_pruned: true, journal_pruned_at: now })
    expect(summary.original_mtime).toBeCloseTo(old, 3)
    expect((await journal.latestRunSummary('sess', 'a'))).toMatchObject({ journal_pruned: true, terminal_state: 'completed' })
  })
})

describe('MCP health prober', () => {
  const fetchFor = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const calls: { method: string; headers: Record<string, string> }[] = []
    const f: typeof fetch = (input, init) => {
      calls.push({ method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) })
      if (typeof input !== 'string') throw new Error('string url expected')
      return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }))
    }
    return { f, calls }
  }

  it('classifies initialize replies, auth failures, protocol mismatches, and stdio commands', async () => {
    const ok = fetchFor(200, { jsonrpc: '2.0', id: 'hermes-webui-health', result: { protocolVersion: '2025-06-18', capabilities: {} } }, { 'Mcp-Session-Id': 'sess-1' })
    expect(await probeServer({ url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } }, ok.f)).toEqual(['healthy', 'HTTP 200'])
    expect(ok.calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
    expect(ok.calls[1]?.headers).toMatchObject({ 'mcp-session-id': 'sess-1', 'mcp-protocol-version': '2025-06-18', authorization: 'Bearer t' })
    const sse = fetchFor(200, 'event: message\ndata: {"jsonrpc":"2.0","id":"hermes-webui-health","result":{"protocolVersion":"2025-03-26"}}\n\n')
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, sse.f)).toEqual(['healthy', 'HTTP 200'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(401, '').f)).toEqual(['needs_auth', 'HTTP 401'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(404, '').f)).toEqual(['unknown', 'HTTP 404 (protocol mismatch)'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(500, '').f)).toEqual(['unhealthy', 'HTTP 500'])
    expect(await probeServer({ url: 'https://mcp.example/mcp' }, fetchFor(200, { jsonrpc: '2.0', error: { message: 'nope' } }).f)).toEqual(['unhealthy', 'initialize rejected: nope'])
    expect(await probeServer({ url: 'ftp://mcp.example' }, ok.f)).toEqual(['unhealthy', 'unsupported url scheme'])
    expect(await probeServer({ command: 'sh' }, ok.f)).toEqual(['unknown', 'stdio server not probed'])
    expect(await probeServer({ command: 'definitely-missing-binary-xyz' }, ok.f)).toEqual(['unhealthy', 'command not found: definitely-missing-binary-xyz'])
    expect(await probeServer('nope', ok.f)).toEqual(['unhealthy', 'invalid config'])
    expect(configFingerprint({ b: 1, a: [2] })).toBe(configFingerprint({ a: [2], b: 1 }))
  })

  it('keys verdicts by config fingerprint and reports pending while a probe runs', async () => {
    let now = 1000
    const ok = fetchFor(200, { jsonrpc: '2.0', id: 'x', result: { protocolVersion: '2025-06-18' } })
    const prober = new McpHealthProber({ fetch: () => ok.f, now: () => now, log: () => undefined })
    const servers = { one: { url: 'https://one.example/mcp' } }
    expect(prober.refreshAndRead(servers).one).toEqual({ pending: true })
    await prober.settle()
    expect(prober.refreshAndRead(servers).one).toMatchObject({ health: 'healthy', detail: 'HTTP 200', checked_at: 1000, pending: false })
    expect(ok.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    // An edited config is a different identity and starts pending again; the old verdict never leaks.
    expect(prober.refreshAndRead({ one: { url: 'https://two.example/mcp' } }).one).toEqual({ pending: true })
    now += 200
    await prober.settle()
    expect(prober.refreshAndRead(servers).one).toMatchObject({ pending: true, health: 'healthy' })
  })

  describe('SSE initialize replies', () => {
    const enc = new TextEncoder()
    const INIT_OK = '{"jsonrpc":"2.0","id":"hermes-webui-health","result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"ℳcp ✓"}}}'
    const NOTIFY = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n'
    const sseServer = (chunks: (string | Uint8Array)[], opts: { open?: boolean; pull?: (c: ReadableStreamDefaultController<Uint8Array>) => void } = {}) => {
      const state = { cancelled: false, calls: [] as { method: string; headers: Record<string, string> }[] }
      const f: typeof fetch = (_input, init) => {
        state.calls.push({ method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> })
        if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
        const body = new ReadableStream<Uint8Array>({
          start(c) { for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk); if (!opts.open && !opts.pull) c.close() },
          ...(opts.pull ? { pull: opts.pull } : {}),
          cancel() { state.cancelled = true },
        })
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-sse' } }))
      }
      return { f, state }
    }
    const probeAfter = async (f: typeof fetch, ms: number) => {
      let verdict: [string, string] | undefined
      void probeServer({ url: 'https://synthetic.invalid/mcp' }, f).then((v) => { verdict = v })
      await vi.advanceTimersByTimeAsync(ms)
      return verdict
    }

    it('finishes on the matching frame without waiting for EOF and releases the body, timer, and probe slot', async () => {
      vi.useFakeTimers()
      try {
        const server = sseServer([NOTIFY, `event: message\ndata: ${INIT_OK}\n\n`], { open: true })
        expect(await probeAfter(server.f, 1)).toEqual(['healthy', 'HTTP 200'])
        expect(server.state.cancelled).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
        expect(server.state.calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
        expect(server.state.calls[1]?.headers).toMatchObject({ 'Mcp-Session-Id': 'sess-sse', 'MCP-Protocol-Version': '2025-06-18' })

        const prober = new McpHealthProber({ fetch: () => sseServer([`data: ${INIT_OK}\n\n`], { open: true }).f, now: () => 1000, log: () => undefined })
        expect(prober.refreshAndRead({ one: { url: 'https://synthetic.invalid/mcp' } }).one).toEqual({ pending: true })
        await vi.advanceTimersByTimeAsync(1)
        expect(prober.refreshAndRead({ one: { url: 'https://synthetic.invalid/mcp' } }).one).toMatchObject({ health: 'healthy', pending: false })
      } finally { vi.useRealTimers() }
    })

    it('dispatches a CR-terminated reply on an open stream without awaiting another chunk', async () => {
      vi.useFakeTimers()
      try {
        const server = sseServer([`: ping\r\r`, `data: ${INIT_OK}\r\r`], { open: true })
        expect(await probeAfter(server.f, 1)).toEqual(['healthy', 'HTTP 200'])
        expect(server.state.cancelled).toBe(true)
      } finally { vi.useRealTimers() }
    })

    it('skips comments, notifications, server requests, and unrelated ids before the matching reply', async () => {
      const body = [': heartbeat\n\n', NOTIFY, 'data: {"jsonrpc":"2.0","id":7,"method":"ping"}\n\n', 'data: {"jsonrpc":"2.0","id":"other","result":{"protocolVersion":"2025-06-18"}}\n\n', 'data: {"jsonrpc":"2.0","id":"other","error":{"message":"not ours"}}\n\n', `id: 4\nevent: message\ndata: ${INIT_OK}\n\n`]
      expect(await probeServer({ url: 'https://synthetic.invalid/mcp' }, sseServer(body).f)).toEqual(['healthy', 'HTTP 200'])
    })

    it('reassembles split UTF-8, CRLF across chunk boundaries, and multiline data', async () => {
      const frame = enc.encode(`: ping\r\n\r\n${NOTIFY.replaceAll('\n', '\r\n')}event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata:"id":"hermes-webui-health",\r\ndata: "result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"ℳcp ✓"}}}\r\n\r\n`)
      const bytes = [...frame].map((b) => Uint8Array.of(b))
      const server = sseServer(bytes, { open: true })
      expect(await probeServer({ url: 'https://synthetic.invalid/mcp' }, server.f)).toEqual(['healthy', 'HTTP 200'])
      expect(server.state.cancelled).toBe(true)
    })

    it('classifies a matching JSON-RPC error frame as rejected', async () => {
      const body = [NOTIFY, 'data: {"jsonrpc":"2.0","id":"hermes-webui-health","error":{"code":-32600,"message":"boom"}}\n\n']
      expect(await probeServer({ url: 'https://synthetic.invalid/mcp' }, sseServer(body, { open: true }).f)).toEqual(['unhealthy', 'initialize rejected: boom'])
    })

    it('reports unknown for malformed, truncated, or reply-less streams', async () => {
      for (const body of [['data: {not json}\n\n'], [NOTIFY, 'data: {"jsonrpc":"2.0","id":"hermes-webui-health","res'], [NOTIFY], []]) {
        expect(await probeServer({ url: 'https://synthetic.invalid/mcp' }, sseServer(body).f)).toEqual(['unknown', 'unexpected initialize reply'])
      }
      // A final event without its blank-line terminator still counts once the stream closes.
      expect(await probeServer({ url: 'https://synthetic.invalid/mcp' }, sseServer([NOTIFY, `data: ${INIT_OK}`]).f)).toEqual(['healthy', 'HTTP 200'])
    })

    it('stops at the byte budget when the stream never sends the reply', async () => {
      const server = sseServer([], { pull: (c) => { c.enqueue(enc.encode(NOTIFY.repeat(64))) } })
      expect(await probeServer({ url: 'https://synthetic.invalid/mcp' }, server.f)).toEqual(['unknown', 'unexpected initialize reply'])
      expect(server.state.cancelled).toBe(true)
    })

    it('times out at the probe deadline, releases the body, and skips cleanup with no budget left', async () => {
      vi.useFakeTimers()
      try {
        const server = sseServer([NOTIFY], { open: true })
        let verdict: [string, string] | undefined
        void probeServer({ url: 'https://synthetic.invalid/mcp' }, server.f).then((v) => { verdict = v })
        await vi.advanceTimersByTimeAsync(7999)
        expect(verdict).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        expect(verdict).toEqual(['unknown', 'unexpected initialize reply'])
        expect(server.state.cancelled).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
        expect(server.state.calls.map((c) => c.method)).toEqual(['POST'])
      } finally { vi.useRealTimers() }
    })
  })
})

describe('agent health', () => {
  it('probes a remote gateway over HTTP with the api key on /health/detailed and caches for 5 s', async () => {
    const urls: string[] = []
    let now = 100
    const f: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url + ((init?.headers as Record<string, string> | undefined)?.Authorization ? ' [auth]' : ''))
      if (url.endsWith('/health/detailed')) return Promise.resolve(new Response('nope', { status: 404 }))
      return Promise.resolve(Response.json({ gateway_state: 'running' }))
    }
    const deps = { env: { HERMES_API_URL: 'http://gw:8642/health', HERMES_WEBUI_GATEWAY_API_KEY: 'k' }, hermesHome: '/nonexistent', profileHome: () => '/nonexistent', fetch: () => f, now: () => now }
    expect(remoteGatewayBaseUrl(deps.env)).toBe('http://gw:8642')
    const first = await agentHealth(deps)
    expect(first).toMatchObject({ alive: true, details: { state: 'alive', reason: 'remote_gateway', endpoint: 'http://gw:8642/health', status_code: 200, gateway_state: 'running' }, gateway_chat: { enabled: false, api_key_configured: true } })
    expect(urls).toEqual(['http://gw:8642/health/detailed [auth]', 'http://gw:8642/health'])
    await agentHealth(deps)
    expect(urls).toHaveLength(2)
    now += 10
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))
    expect(await agentHealth({ ...deps, fetch: () => down })).toMatchObject({ alive: false, details: { state: 'down', reason: 'remote_gateway_unreachable', error: 'TypeError' } })
  })

  it('reads the local gateway pid and state file with the freshness rules', async () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `talaria-gw-${String(process.pid)}-${String(Date.now())}`)
    mkdirSync(dir, { recursive: true })
    const deps = { env: {}, hermesHome: dir, profileHome: () => dir, fetch: () => fetch, now: () => Date.now() / 1000 }
    expect(await agentHealth(deps)).toMatchObject({ alive: null, details: { state: 'unknown', reason: 'gateway_not_configured' } })
    writeFileSync(join(dir, 'gateway.pid'), String(process.pid))
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: new Date().toISOString(), active_agents: 2, platforms: { telegram: { state: 'connected' }, discord: { state: 'connected' } } }))
    expect(await agentHealth(deps)).toMatchObject({ alive: true, details: { state: 'alive', gateway_state: 'running', active_agents: 2, platform_count: 2, platform_states: { connected: 2 } } })
    writeFileSync(join(dir, 'gateway.pid'), '999999999')
    expect(await agentHealth(deps)).toMatchObject({ alive: true, details: { reason: 'cross_container_freshness' } })
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'running', updated_at: old }))
    expect(await agentHealth(deps)).toMatchObject({ alive: null, details: { reason: 'gateway_stale_running_state' } })
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped', updated_at: old }))
    expect(await agentHealth(deps)).toMatchObject({ alive: null, details: { reason: 'gateway_stale_stopped_state' } })
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'stopped', updated_at: new Date().toISOString() }))
    expect(await agentHealth(deps)).toMatchObject({ alive: false, details: { state: 'down', reason: 'gateway_not_running' } })
    // TAL-950: the Agent writes a JSON pid record; a live gateway still starting under a stale `draining` state is alive.
    writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ gateway_state: 'draining', updated_at: old }))
    const record = { pid: process.pid, kind: 'hermes-gateway', argv: ['hermes', 'gateway'], start_time: null, hermes_home: dir }
    writeFileSync(join(dir, 'gateway.pid'), JSON.stringify(record))
    expect(await agentHealth(deps)).toMatchObject({ alive: true, details: { state: 'alive', gateway_state: 'draining' } })
    const started = await processStartTime(process.pid)
    expect(started).toEqual(expect.any(Number))
    writeFileSync(join(dir, 'gateway.pid'), JSON.stringify({ ...record, start_time: started }))
    expect(await agentHealth(deps)).toMatchObject({ alive: true, details: { state: 'alive', gateway_state: 'draining' } })
    // A recorded start time that disagrees with the live process is a reused pid, not the gateway.
    writeFileSync(join(dir, 'gateway.pid'), JSON.stringify({ ...record, start_time: 1 }))
    expect(await agentHealth(deps)).toMatchObject({ alive: false, details: { state: 'down', reason: 'gateway_not_running' } })
    writeFileSync(join(dir, 'gateway.pid'), JSON.stringify({ pid: 999999999, kind: 'hermes-gateway' }))
    expect(await agentHealth(deps)).toMatchObject({ alive: false, details: { state: 'down', reason: 'gateway_not_running' } })
    expect(runtimeStatusIsFresh({ gateway_state: 'running', updated_at: '2026-01-01T00:00:00' }, Date.now() / 1000)).toBe(false)
  })
})

describe('wakeup turns pass the user-turn admission (TAL-577)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const starts: Json[] = []
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('chat.start', (params) => { starts.push(params); return { ...completed('Handled.'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Handled.' }] } })
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
  })
  afterAll(() => s.close())

  const newSid = async (): Promise<string> => String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
  const completion = (sid: string, id: string): Json => ({ process_id: id, session_id: id, type: 'completion', command: 'make', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 60 && s.deps.registry.activeRuns.size; i += 1) await new Promise((r) => setTimeout(r, 50))
  }

  it('runs a wakeup for a session whose workspace was deleted in the recovered workspace', async () => {
    const sid = await newSid()
    const session = (await s.deps.sessionStore.get(sid))
    const recovered = session.workspace
    const worktree = join(recovered, 'removed-worktree')
    mkdirSync(worktree, { recursive: true })
    session.workspace = worktree
    await s.deps.sessionStore.save(session)
    rmSync(worktree, { recursive: true })
    starts.length = 0
    expect(await s.deps.completions.processOne(completion(sid, 'proc_gone'))).toBe(true)
    await settled()
    expect(starts.map((p) => p.workspace)).toEqual([recovered])
    expect((await s.deps.sessionStore.get(sid)).workspace).toBe(recovered)
  })

  it('defers a wakeup while the Agent runtime is stale', async () => {
    const sid = await newSid()
    starts.length = 0
    sidecar.respond('runtime.ensure_current', () => { throw new SidecarError('restart required', { condition: 'agent_runtime_stale' }) })
    // No turn ends in an idle session, so only the retry timer delivers the wakeup once the runtime is current.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      expect(await s.deps.completions.processOne(completion(sid, 'proc_stale'))).toBe(true)
      expect(starts).toEqual([])
      expect(s.deps.completions.deferredCount(sid)).toBe(1)
      sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
      await vi.advanceTimersByTimeAsync(30_000)
    } finally {
      vi.useRealTimers()
      sidecar.respond('runtime.ensure_current', () => ({ current: true as const, agent_revision: null }))
    }
    await settled()
    expect(starts).toHaveLength(1)
    expect(s.deps.completions.deferredCount(sid)).toBe(0)
  })
})

describe('a Stop holds automatic turns until the next user message (TAL-899)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const starts: string[] = []
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
    sidecar.respond('process.mark_consumed', () => ({ ok: true }))
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
  })
  afterAll(() => s.close())

  const newSid = async (): Promise<string> => String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
  const completion = (sid: string, id: string): Json => ({ process_id: id, session_id: id, type: 'completion', command: 'make', exit_code: 0, output: 'ok', origin_ui_session_id: sid, consumed: false })
  const held = async (sid: string): Promise<unknown> => ((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).automatic_turns_held
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 60 && s.deps.registry.activeRuns.size; i += 1) await new Promise((r) => setTimeout(r, 50))
  }
  // The user's first turn runs until stopped; every later turn answers at once.
  const stoppableThenAnswer = (): void => {
    starts.length = 0
    sidecar.respond('chat.start', (params, emit, opts) => {
      starts.push(str(params.user_message))
      if (starts.length > 1) return completed('answered')
      return new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'working' } })
        opts.signal?.addEventListener('abort', () => { resolve({ ...completed(''), status: 'cancelled' }) })
      })
    })
  }
  const startAndStop = async (sid: string): Promise<string> => {
    const stream = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'long task' }))).stream_id)
    await s.sse(`/api/chat/stream?stream_id=${stream}`, (f) => f.event === 'token')
    return stream
  }
  const stop = async (stream: string): Promise<void> => {
    expect(await json(await s.get(`/api/chat/cancel?stream_id=${stream}`))).toMatchObject({ cancelled: true })
    await s.deps.turns.finished(stream)
    await settled()
  }

  it.each(['load', 'save'] as const)('still interrupts when the Stop hold cannot %s', async (operation) => {
    const sid = await newSid()
    stoppableThenAnswer()
    const stream = await startAndStop(sid)
    const before = sidecar.calls.filter((call) => call.method === 'chat.interrupt').length
    const spy = vi.spyOn(s.deps.sessionStore, operation === 'load' ? 'get' : 'save').mockImplementation(() => { throw new Error('synthetic storage failure') })
    try {
      const outcome = await s.deps.turns.cancel(stream).catch(() => null)
      const after = sidecar.calls.filter((call) => call.method === 'chat.interrupt').length
      expect(after - before, 'Stop must reach the Agent despite a failed durable hold write').toBe(1)
      expect(outcome).toMatchObject({ cancelled: true })
      expect((await s.deps.turns.automaticTurnsHeld(sid))).toBe(true)
    } finally {
      spy.mockRestore()
      await s.deps.turns.cancel(stream)
      await s.deps.turns.finished(stream)
      await settled()
    }
  })

  it('a completion deferred during a stopped turn waits for the next user turn to end', async () => {
    const sid = await newSid()
    stoppableThenAnswer()
    const stream = await startAndStop(sid)
    expect(await s.deps.completions.processOne(completion(sid, 'proc_stop_deferred'))).toBe(true)
    expect(s.deps.completions.deferredCount(sid)).toBe(1)
    await stop(stream)
    await s.deps.completions.drainDeferred(sid)
    expect(starts, 'no wakeup at the stopped turn\'s teardown').toHaveLength(1)
    expect(s.deps.completions.deferredCount(sid)).toBe(1)
    expect(await held(sid)).toBe(true)

    const next = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'next question' }))).stream_id)
    expect(await held(sid)).toBe(false)
    await s.deps.turns.finished(next)
    await vi.waitFor(() => { expect(starts).toHaveLength(3) })
    expect(starts[1]).toContain('next question')
    expect(starts[2]).toContain('Background process proc_stop_deferred completed')
    await settled()
    expect(s.deps.completions.deferredCount(sid)).toBe(0)
  })

  it('a completion that arrives after the Stop starts no turn but still reports', async () => {
    const sid = await newSid()
    stoppableThenAnswer()
    await stop(await startAndStop(sid))
    const sub = s.deps.channels.subscribe(sid)
    try {
      expect(await s.deps.completions.processOne(completion(sid, 'proc_after_stop'))).toBe(true)
      expect((await nextSessionItem(sub, 1000))?.[0]).toBe('bg_task_complete')
    } finally {
      s.deps.channels.unsubscribe(sid, sub)
    }
    await settled()
    expect(starts).toHaveLength(1)
    expect(s.deps.completions.deferredCount(sid)).toBe(1)
    expect((await s.deps.sessionStore.get(sid)).active_stream_id).toBeNull()
  })

  it('a deleted session leaves no hold behind once the hygiene sweep runs', async () => {
    const sid = await newSid()
    stoppableThenAnswer()
    await stop(await startAndStop(sid))
    expect((await s.deps.turns.automaticTurnsHeld(sid))).toBe(true)
    await s.deps.turns.sweep()
    expect((await s.deps.turns.automaticTurnsHeld(sid)), 'a live session keeps its hold').toBe(true)
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
    await s.deps.turns.sweep()
    expect((await s.deps.turns.automaticTurnsHeld(sid))).toBe(false)
  })

  it('a background turn that yields to the user does not hold automatic turns', async () => {
    const sid = await newSid()
    starts.length = 0
    sidecar.respond('chat.start', (params, emit, opts) => {
      starts.push(str(params.user_message))
      return new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'working' } })
        opts.signal?.addEventListener('abort', () => { resolve({ ...completed(''), status: 'cancelled' }) })
      })
    })
    expect(await s.deps.completions.processOne(completion(sid, 'proc_yield'))).toBe(true)
    await vi.waitFor(() => { expect(starts).toHaveLength(1) })
    expect(await s.deps.turns.yieldBackgroundTurn(sid)).toBe(true)
    await settled()
    expect(await held(sid)).toBe(false)
  })
})

describe('durable parent admission for delivered delegation notifications (TAL-1021)', () => {
  it('admits exactly once across drain restart and persists the receipt with the pending turn', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    let restart: TestServer | undefined
    let release = (): void => undefined
    try {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      const session = (await s.deps.sessionStore.get(sid))
      session.messages = [{ role: 'user', content: 'dispatch work' }]
      await s.deps.sessionStore.save(session)
      const event = { type: 'async_delegation', process_id: 'deleg_unknown', delegation_id: 'deleg_unknown', origin_ui_session_id: sid, status: 'unknown', error: 'owner exited; outcome unknown', consumed: false, reconciliation_profile_home: s.state }
      // The sidecar verified the typed delivered notification. No global ledger claim is reopened.
      sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
      sidecar.respond('process.format_notification', () => ({ text: '[Delegation deleg_unknown: outcome unknown]' }))
      const starts: string[] = []
      sidecar.respond('chat.start', (params) => {
        starts.push(str(params.user_message))
        return new Promise((resolve) => { release = () => { resolve(completed('Handled.')) } })
      })
      await Promise.all([s.deps.completions.processOne(event), s.deps.completions.processOne(event)])
      await vi.waitFor(() => { expect(starts).toHaveLength(1) })
      const disk = JSON.parse(readFileSync(sessionPath(s.deps.sessionStore, sid), 'utf8')) as Json
      expect(disk.completion_acceptances, 'admission receipt is durable before the worker finishes').toEqual({
        [JSON.stringify([realpathSync(s.state), 'deleg_unknown'])]: disk.active_stream_id,
      })
      release()
      await s.deps.turns.finished(str(disk.active_stream_id))
      restart = await bootTestServer({ sidecar, env: { HERMES_HOME: s.state, HERMES_WEBUI_STATE_DIR: s.state, HERMES_WEBUI_DEFAULT_WORKSPACE: join(s.state, 'workspace') } })
      await restart.deps.completions.processOne(event)
      expect(starts).toHaveLength(1)
    } finally {
      release()
      await restart?.close()
      await s.close()
    }
  })

  it('uses the authoritative unknown result instead of the Agent completed_count shortcut', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      const session = (await s.deps.sessionStore.get(sid))
      const notification = { role: 'user', content: 'Recovered delegation result', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'deleg_unknown', completed_count: 1, failed_count: 0 } }
      session.messages = [notification]
      session.pre_compression_snapshot = true
      await s.deps.sessionStore.save(session)
      sidecar.respond('process.format_notification', () => ({ text: '[Outcome unknown]' }))
      await s.deps.completions.processOne({ type: 'async_delegation', process_id: 'deleg_unknown', delegation_id: 'deleg_unknown', origin_ui_session_id: sid, consumed: false, status: 'unknown', error: 'owner exited' })
      const rows = withBackgroundUpdates(session.messages, session)
      expect(rows[0]).toMatchObject({ _background_update: { attention: true, lines: [{ kind: 'agent', status: 'notice', label: 'owner exited', review_state: 'unknown' }] } })
      expect((JSON.parse(readFileSync(join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json'), 'utf8')) as Json)[sid]).toHaveLength(1)
    } finally { await s.close() }
  })

  it('keeps a claimed result pending and never crosses profiles during reconciliation', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    sidecar.respond('chat.start', async () => { await gate; return completed('done') })
    try {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      const session = (await s.deps.sessionStore.get(sid))
      session.messages = [{ role: 'user', content: 'dispatch' }]
      await s.deps.sessionStore.save(session)
      const event = { type: 'async_delegation', process_id: 'same-id', delegation_id: 'same-id', origin_ui_session_id: sid, consumed: false }
      sidecar.respond('process.format_notification', () => ({ text: '[Result]' }))
      let claims = 0
      sidecar.respond('process.claim_delivery', () => { claims += 1; return { claim_id: null, retryable: true } })
      expect(await s.deps.completions.processOne({ ...event, reconciliation_profile_home: join(s.state, 'profiles', 'foreign') })).toBe(false)
      expect(claims).toBe(0)
      await s.deps.completions.processOne(event)
      expect(claims).toBe(1)
      expect(s.deps.completions.deferredCount(sid)).toBe(1)
      expect(session.active_stream_id).toBeNull()
      sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
      await s.deps.completions.drainDeferred(sid)
      expect(session.active_stream_id).toBeTruthy()
      const streamId = session.active_stream_id!
      release()
      await s.deps.turns.finished(streamId)
    } finally { release(); await s.close() }
  })

  it('preserves a Stop hold across restart and releases the durable result after a user turn', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    let restart: TestServer | undefined
    try {
      const sid = String(((await json(await post(s, '/api/session/new', {}))).session as Json).session_id)
      sidecar.respond('chat.start', (_params, emit, opts) => new Promise((resolve) => {
        emit({ event: 'token', data: { text: 'working' } })
        opts.signal?.addEventListener('abort', () => { resolve({ ...completed(''), status: 'cancelled' }) })
      }))
      const first = str((await json(await post(s, '/api/chat/start', { session_id: sid, message: 'dispatch' }))).stream_id)
      await s.sse(`/api/chat/stream?stream_id=${first}`, (f) => f.event === 'token')
      await s.deps.turns.cancel(first)
      await s.deps.turns.finished(first)
      sidecar.respond('chat.start', (params) => ({ ...completed('Handled.'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Handled.' }] }))
      expect((await s.deps.turns.automaticTurnsHeld(sid))).toBe(true)
      sidecar.respond('process.format_notification', () => ({ text: '[Result deleg_held]' }))
      sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
      await s.deps.completions.processOne({ type: 'async_delegation', process_id: 'deleg_held', delegation_id: 'deleg_held', origin_ui_session_id: sid, consumed: false })
      restart = await bootTestServer({ sidecar, env: { HERMES_HOME: s.state, HERMES_WEBUI_STATE_DIR: s.state, HERMES_WEBUI_DEFAULT_WORKSPACE: join(s.state, 'workspace') } })
      await restart.deps.completions.drainOnce()
      await restart.deps.completions.drainDeferred(sid)
      expect((await restart.deps.turns.automaticTurnsHeld(sid))).toBe(true)
      expect((await restart.deps.sessionStore.get(sid)).active_stream_id).toBeNull()
      const userResponse = await json(await post(restart, '/api/chat/start', { session_id: sid, message: 'continue' }))
      expect(userResponse.stream_id, JSON.stringify(userResponse)).toBeTruthy()
      const user = str(userResponse.stream_id)
      await restart.deps.turns.finished(user)
      await vi.waitFor(async () => { expect((await restart!.deps.sessionStore.get(sid)).extra.completion_acceptances).toBeDefined() })
      const receipts = (await restart.deps.sessionStore.get(sid)).extra.completion_acceptances as Json
      expect(Object.keys(receipts)).toEqual([JSON.stringify([realpathSync(s.state), 'deleg_held'])])
      await restart.deps.turns.finished(str(Object.values(receipts)[0]))
    } finally { await restart?.close(); await s.close() }
  })

  it('finishes a saved admission handshake without rerunning its parent turn', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const session = (await s.deps.sessionStore.newSession())
      session.messages = [{ role: 'user', content: 'dispatch' }]
      session.extra.completion_acceptances = { [JSON.stringify([realpathSync(s.state), 'deleg_ack'])]: 'accepted-before-crash' }
      await s.deps.sessionStore.save(session)
      sidecar.respond('process.format_notification', () => ({ text: '[Result deleg_ack]' }))
      let acknowledgements = 0
      sidecar.respond('process.claim_delivery', () => ({ claim_id: 'retry-claim' }))
      sidecar.respond('process.complete_delivery', () => { acknowledgements += 1; return { ok: true } })
      let starts = 0
      sidecar.respond('chat.start', () => { starts += 1; return completed('unexpected') })
      await s.deps.completions.processOne({ type: 'async_delegation', process_id: 'deleg_ack', delegation_id: 'deleg_ack', origin_ui_session_id: session.session_id, consumed: false })
      expect(acknowledgements).toBe(1)
      expect(starts).toBe(0)
      expect((JSON.parse(readFileSync(join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json'), 'utf8')) as Json)[session.session_id]).toBeUndefined()
    } finally { await s.close() }
  })

  it('recognizes a proven legacy Web turn and keeps identical result text scoped to its owning session', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const prompt = '[Result deleg_legacy]'
      sidecar.respond('process.format_notification', () => ({ text: prompt }))
      sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
      let starts = 0
      sidecar.respond('chat.start', (params) => { starts += 1; return { ...completed('Handled'), messages: [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Handled' }] } })
      for (const accepted of [true, false]) {
        const session = (await s.deps.sessionStore.newSession())
        session.messages = [{ role: 'user', content: prompt, ...(accepted ? { _source: 'process_wakeup', _turn_id: 'legacy-admission' } : { display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'deleg_legacy' } }) }]
        await s.deps.sessionStore.save(session)
        await s.deps.completions.processOne({ type: 'async_delegation', process_id: 'deleg_legacy', delegation_id: 'deleg_legacy', origin_ui_session_id: session.session_id, consumed: false, reconciliation_profile_home: s.state })
        if (session.active_stream_id) await s.deps.turns.finished(session.active_stream_id)
        expect(starts).toBe(accepted ? 0 : 1)
      }
    } finally { await s.close() }
  })
  it.each(['held file', 'session save'] as const)('retries a live delegation automatically after a failed %s', async (failure) => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    const heldPath = join(sessionDirectory(s.deps.sessionStore), '_wakeup_held.json')
    let restore = (): void => undefined
    let drain: CompletionDrain | undefined
    try {
      const session = (await s.deps.sessionStore.newSession())
      session.messages = [{ role: 'user', content: 'dispatch' }]
      await s.deps.sessionStore.save(session)
      const event = { type: 'async_delegation', process_id: 'deleg_retry', delegation_id: 'deleg_retry', origin_ui_session_id: session.session_id, consumed: false }
      let offered = false
      sidecar.respond('process.drain', () => { const events = offered ? [] : [event]; offered = true; return { events } })
      sidecar.respond('process.format_notification', () => ({ text: '[Result deleg_retry]' }))
      sidecar.respond('process.claim_delivery', () => ({ claim_id: '' }))
      if (failure === 'held file') {
        mkdirSync(heldPath)
        restore = () => { rmSync(heldPath, { recursive: true, force: true }) }
      } else {
        const spy = vi.spyOn(s.deps.sessionStore, 'save').mockImplementation(() => { throw new Error('synthetic session write failure') })
        restore = () => { spy.mockRestore() }
      }
      let starts = 0
      drain = new CompletionDrain({ documents: new JsonDocuments(s.state), sidecar: () => sidecar, baseHome: s.state, profileHome: () => s.state, activeProfile: () => 'default', store: s.deps.sessionStore,
        channels: s.deps.channels, registry: s.deps.registry, startTurn: () => { starts += 1; return { stream_id: 'retry-admitted' } }, now: () => Date.now() / 1000, log: () => undefined })
      vi.useFakeTimers()
      const routed = await drain.drainOnce()
      expect(drain.deferredCount(session.session_id), 'the drained live event remains retained').toBe(1)
      expect(routed).toBe(1)
      expect(starts).toBe(0)
      restore()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(starts, 'retry admits the retained result without a user turn or Agent orphan sweep').toBe(1)
      expect(drain.deferredCount(session.session_id)).toBe(0)
    } finally {
      drain?.stop()
      vi.useRealTimers()
      restore()
      await s.close()
    }
  })

})

it('does not show Waiting when only a held delivery acknowledgement remains (TAL-1022)', async () => {
  const server = await bootTestServer()
  server.deps.completions.stop()
  try {
    const sid = String(((await json(await post(server, '/api/session/new', {}))).session as Json).session_id)
    const session = (await server.deps.sessionStore.get(sid)), turn = 'cancelled-review', delegation = 'ack-only'
    const event = { type: 'async_delegation', delegation_id: delegation, process_id: delegation, origin_ui_session_id: sid, goals: ['Cancelled review'], results: [{ status: 'completed' }] }
    const update = batchUpdate([{ event, prompt: 'result' }])
    session.messages = [
      { role: 'user', content: 'result', _source: 'process_wakeup', _turn_id: turn },
      { role: 'assistant', content: '', _error: true, _terminal_state: 'cancelled', _turn_id: turn },
      { role: 'user', content: 'Agent notification', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: delegation }, _turn_id: 'notification' },
    ]
    recordBackgroundUpdate(session, turn, update)
    recordBackgroundUpdate(session, `delegation:${delegation}`, update)
    await server.deps.sessionStore.save(session)
    await new HeldWakeups(testSessionDocuments(dirname(join(sessionDirectory(server.deps.sessionStore), '_wakeup_held.json')))).hold(sid, [{ process_id: delegation, wakeup_prompt: 'result', event }])
    const pending = (await json(await server.get(`/api/session?session_id=${sid}&messages=1&msg_limit=1`))).session as Json
    expect((pending.messages as Json[]).at(-1)?._background_update).toMatchObject({ review_state: 'waiting' })
    session.extra.completion_acceptances = { [JSON.stringify([realpathSync(server.state), delegation])]: turn }
    await server.deps.sessionStore.save(session)
    const page = (await json(await server.get(`/api/session?session_id=${sid}&messages=1&msg_limit=1`))).session as Json
    expect((page.messages as Json[]).at(-1)?._background_update).toMatchObject({ review_state: 'unknown', lines: [{ review_state: 'unknown' }] })
  } finally { await server.close() }
})
