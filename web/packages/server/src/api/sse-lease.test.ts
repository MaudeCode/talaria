import { mkdirSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { groupFixture } from '../test/group-fixture.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'
import { TerminalRegistry, type PtyModuleLike } from '../tools/terminal.js'

const LEASE_MS = 150
/** Far past the lease, so a stream that ignores it fails its assertion rather than the test's timeout. */
const ENDS_WITHIN = { timeout: 3_000, interval: 10 }

/** A proxy that keeps reading after its browser left: it never closes the socket, so only the server can end the stream. */
function abandoned(port: number, path: string): { socket: Socket; readonly text: string; readonly ended: boolean; readonly closed: boolean } {
  let text = ''
  let ended = false
  let closed = false
  const socket = connect({ host: '127.0.0.1', port }, () => { socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`) })
  socket.setEncoding('latin1')
  socket.on('data', (chunk: string) => { text += chunk; if (text.endsWith('0\r\n\r\n')) ended = true })
  socket.on('end', () => { ended = true })
  socket.on('close', () => { ended = true; closed = true })
  socket.on('error', () => undefined)
  return {
    socket,
    get text() { return text },
    get ended() { return ended },
    get closed() { return closed },
  }
}

const sockets: Socket[] = []
const open = (s: TestServer, path: string): ReturnType<typeof abandoned> => {
  const reader = abandoned(s.running.port, path)
  sockets.push(reader.socket)
  return reader
}
afterEach(() => { for (const socket of sockets.splice(0)) socket.destroy() })

/** The newest `id:` a client saw, which is what `EventSource` sends back as `Last-Event-ID`. */
const lastId = (frames: SseFrame[]): string => {
  const id = frames.filter((frame) => frame.id).at(-1)?.id
  expect(id, 'the stream writes a cursor').toBeTruthy()
  return id!
}
const sessionUrl = (sid: string, known?: number): string => `/api/session/stream?session_id=${sid}${known === undefined ? '' : `&known_count=${String(known)}`}`
const untilLease = (s: TestServer, path: string, headers: Record<string, string> = {}): Promise<SseFrame[]> => s.sse(path, () => false, { headers, timeoutMs: 1_500 })

describe('every feed with no natural end stops at its lease', () => {
  let s: TestServer
  let sid = ''
  beforeAll(async () => {
    const sidecar = new FakeSidecar()
    groupFixture(sidecar)
    sidecar.respond('kanban.events', (params) => ({ events: [], cursor: params.since ?? 0, latest_event_id: 0, read_only: false }))
    s = await bootTestServer({ sidecar, gatewayPollMs: 100, deps: (deps) => {
      deps.streamLeaseMs = LEASE_MS
      deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true }, { name: 'helper' }])
    } })
    const pty: PtyModuleLike = { spawn: () => ({ pid: 4242, write: () => undefined, resize: () => undefined, kill: () => undefined, onData: () => undefined, onExit: () => undefined }) }
    ;(s.deps as { terminals: TerminalRegistry }).terminals = new TerminalRegistry({ env: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', HOME: s.state }, now: () => Date.now(), log: () => undefined, pty })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: {} }))
    mkdirSync(join(s.state, 'workspace'), { recursive: true })
    sid = (await s.deps.sessionStore.newSession()).session_id
    await s.deps.settings.save({ show_cli_sessions: true })
    const started = await s.get('/api/terminal/start', { method: 'POST', body: JSON.stringify({ session_id: sid }), headers: { 'content-type': 'application/json' } })
    expect(started.status).toBe(200)
  })
  afterAll(async () => { s.deps.terminals.closeAll({ immediate: true }); s.deps.gatewayWatchers.stopAll(); await s.close() })

  it.each([
    { feed: 'session channel', path: () => sessionUrl(sid), close: false },
    { feed: 'session list', path: () => '/api/sessions/events', close: false },
    { feed: 'merged sidebar', path: () => '/api/sessions/events?gateway=1', close: false },
    { feed: 'gateway', path: () => '/api/sessions/gateway/stream', close: false },
    { feed: 'session journal', path: () => `/api/sessions/${sid}/events`, close: false },
    { feed: 'groups', path: () => '/api/groups/stream?room_id=discussion', close: false },
    { feed: 'kanban', path: () => '/api/kanban/events/stream', close: true },
    { feed: 'terminal', path: () => `/api/terminal/output?session_id=${sid}`, close: true },
  ])('ends an abandoned $feed stream and frees its slot, adding no Connection: close', async ({ path, close }) => {
    await vi.waitFor(() => { expect(s.deps.streamSlots.active).toBe(0) })
    const reader = open(s, path())
    await vi.waitFor(() => { expect(reader.text).toContain('HTTP/1.1 200') })
    expect(/^connection: close\r$/im.test(reader.text)).toBe(close)
    await vi.waitFor(() => { expect(reader.ended).toBe(true) }, ENDS_WITHIN)
    await vi.waitFor(() => { expect(s.deps.streamSlots.active).toBe(0) })
  })

  it('releases the native observation and channel subscriber at the lease', async () => {
    const release = vi.fn()
    const observe = vi.spyOn(s.deps.sessions.owner!, 'observe').mockResolvedValue({ release, ended: new Promise(() => undefined) })
    try {
      const reader = open(s, sessionUrl(sid))
      await vi.waitFor(() => { expect(observe).toHaveBeenCalledTimes(1) })
      await vi.waitFor(() => { expect(reader.ended).toBe(true) }, ENDS_WITHIN)
      await vi.waitFor(() => {
        expect(release).toHaveBeenCalledTimes(1)
        expect(s.deps.channels.subscriberCount(sid)).toBe(0)
      })
    } finally { observe.mockRestore() }
  })

  it('cuts off a reader that stopped draining, since ending its response could never finish', async () => {
    // The frames land as the stream subscribes, far past what the socket buffers can take, so it stalls inside its lease.
    const large = 'x'.repeat(256 * 1024)
    const subscribe = s.deps.channels.subscribe.bind(s.deps.channels)
    const flood = vi.spyOn(s.deps.channels, 'subscribe').mockImplementation((...args) => {
      const sub = subscribe(...args)
      for (let n = 0; n < 64; n += 1) s.deps.channels.emit(sid, 'bg_task_complete', { session_id: sid, n, large })
      return sub
    })
    try {
      const reader = open(s, sessionUrl(sid))
      reader.socket.pause()
      await vi.waitFor(() => { expect(flood).toHaveBeenCalledTimes(1) })
      await vi.waitFor(() => {
        expect(s.deps.channels.subscriberCount(sid)).toBe(0)
        expect(s.deps.streamSlots.active).toBe(0)
      }, ENDS_WITHIN)
      reader.socket.resume()
      await vi.waitFor(() => { expect(reader.closed).toBe(true) }, ENDS_WITHIN)
      expect(reader.text.endsWith('0\r\n\r\n')).toBe(false)
    } finally { flood.mockRestore() }
  })

  it('leaves chat and pending streams open past the lease, while their run lasts', async () => {
    const channel = s.deps.registry.create('run-outlives-lease', sid)
    try {
      const chat = open(s, '/api/chat/stream?stream_id=run-outlives-lease')
      const approval = open(s, `/api/approval/stream?session_id=${sid}`)
      const clarify = open(s, `/api/clarify/stream?session_id=${sid}`)
      await vi.waitFor(() => { expect(channel.subscriberCount).toBe(1); expect(s.deps.streamSlots.active).toBe(3) })
      // A leased feed opened after them ends first; it is the clock the excluded streams must outlive.
      const leased = open(s, '/api/sessions/events')
      await vi.waitFor(() => { expect(leased.ended).toBe(true) }, ENDS_WITHIN)
      expect([chat.ended, approval.ended, clarify.ended]).toEqual([false, false, false])
      channel.put(['token', { text: 'after the lease' }, 'run-outlives-lease:1'])
      await vi.waitFor(() => { expect(chat.text).toContain('after the lease') })
    } finally { s.deps.registry.retire('run-outlives-lease') }
  })
})

describe('a full budget', () => {
  let s: TestServer
  // Long enough that the refused request lands inside the lease.
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_MAX_SSE_CLIENTS: '1' }, deps: (deps) => { deps.streamLeaseMs = 1_000 } }) })
  afterAll(() => s.close())

  it('answers 503 while an abandoned connection holds the slot, then 200 once its lease ends', async () => {
    const reader = open(s, '/api/sessions/events')
    await vi.waitFor(() => { expect(s.deps.streamSlots.active).toBe(1) })
    const refused = await s.get('/api/sessions/events')
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ condition: 'client_stream_limit' })
    await vi.waitFor(() => { expect(reader.ended).toBe(true) }, ENDS_WITHIN)
    const controller = new AbortController()
    try { expect((await s.get('/api/sessions/events', { signal: controller.signal })).status).toBe(200) }
    finally { controller.abort() }
  })
})

describe('the session stream bridges a rotation', () => {
  let s: TestServer
  let sid = ''
  beforeAll(async () => { s = await bootTestServer({ deps: (deps) => { deps.streamLeaseMs = LEASE_MS } }) })
  afterAll(() => s.close())
  afterEach(() => { for (const id of [...s.deps.registry.activeRuns.keys()]) s.deps.registry.retire(id) })
  const emit = (event: string, n: number): void => { s.deps.channels.emit(sid, event, { session_id: sid, n }) }
  const body = (frames: SseFrame[]): [string, unknown][] => frames.filter((frame) => frame.event !== 'initial').map((frame) => [frame.event, (frame.data as { n?: number }).n])

  it('replays every frame after the cursor once and in order, including interleaved completions', async () => {
    sid = (await s.deps.sessionStore.newSession()).session_id
    // Only this connection needs time to receive a live frame; the replays below end at the short lease.
    s.deps.streamLeaseMs = 30_000
    const first = s.sse(sessionUrl(sid), (frame) => frame.event === 'bg_task_complete', { timeoutMs: 3_000 })
    await vi.waitFor(() => { expect(s.deps.channels.subscriberCount(sid)).toBe(1) })
    s.deps.streamLeaseMs = LEASE_MS
    emit('bg_task_complete', 1)
    const seen = await first
    expect(body(seen)).toEqual([['bg_task_complete', 1]])
    await vi.waitFor(() => { expect(s.deps.channels.subscriberCount(sid)).toBe(0) })
    // The completion aliases interleave across two tasks while no client is attached.
    emit('bg_task_complete', 2)
    emit('process_complete', 2)
    emit('process_complete', 1)
    emit('session-updated', 3)
    const cursor = lastId(seen)
    const second = await untilLease(s, sessionUrl(sid), { 'last-event-id': cursor })
    expect(second[0]).toMatchObject({ event: 'initial', id: cursor })
    expect(body(second)).toEqual([['bg_task_complete', 2], ['process_complete', 2], ['process_complete', 1], ['session-updated', 3]])
    // Each frame carries its own cursor, so a client cut off here resumes after the frame it really saw.
    expect(new Set(second.map((frame) => frame.id)).size).toBe(second.length)
    const third = await untilLease(s, sessionUrl(sid), { 'last-event-id': lastId(second) })
    expect(body(third)).toEqual([])
  })

  it('a client between connections that saw only the initial frame still gets what it missed', async () => {
    sid = (await s.deps.sessionStore.newSession()).session_id
    const seen = await untilLease(s, sessionUrl(sid))
    expect(body(seen)).toEqual([])
    await vi.waitFor(() => { expect(s.deps.channels.subscriberCount(sid)).toBe(0) })
    emit('bg_task_complete', 1)
    expect(body(await untilLease(s, sessionUrl(sid), { 'last-event-id': lastId(seen) }))).toEqual([['bg_task_complete', 1]])
  })

  it('a fresh tab with no cursor receives no old frames', async () => {
    sid = (await s.deps.sessionStore.newSession()).session_id
    const seen = await untilLease(s, sessionUrl(sid))
    await vi.waitFor(() => { expect(s.deps.channels.subscriberCount(sid)).toBe(0) })
    emit('bg_task_complete', 1)
    expect(String(seen[0]?.id)).toMatch(/^session-channel:[0-9a-f]+@0$/)
    expect(body(await untilLease(s, sessionUrl(sid)))).toEqual([])
  })

  const staleCursors: { kind: string; cursor: (held: string) => string }[] = [
    { kind: 'evicted', cursor: (held) => held },
    { kind: 'malformed', cursor: () => 'not-a-cursor' },
    { kind: 'non-numeric', cursor: (held) => held.replace(/@\d+$/, '@abc') },
    { kind: 'ahead of the channel', cursor: (held) => held.replace(/@\d+$/, '@9999') },
    { kind: 'previous incarnation', cursor: (held) => held.replace(/:[0-9a-f]+@/, ':0123456789abcdef@') },
  ]

  /** A session whose channel holds more retained frames than the history bound, reached from `held`. */
  const staleChannel = async (): Promise<string> => {
    sid = (await s.deps.sessionStore.newSession()).session_id
    const session = await s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'persisted' }]
    await s.deps.sessionStore.save(session)
    const seen = await untilLease(s, sessionUrl(sid))
    await vi.waitFor(() => { expect(s.deps.channels.subscriberCount(sid)).toBe(0) })
    for (let n = 1; n <= 33; n += 1) emit('bg_task_complete', n)
    return lastId(seen)
  }

  it.each(staleCursors)('stale cursor ($kind) replays nothing and still gets known_count recovery', async ({ cursor }) => {
    const held = await staleChannel()
    const frames = await untilLease(s, sessionUrl(sid, 0), { 'last-event-id': cursor(held) })
    expect(frames.map((frame) => frame.event)).toEqual(['initial', 'session-updated'])
    expect(frames[1]?.data).toMatchObject({ source: 'subscribe_recovery', known_count: 0, message_count: 1 })
  })

  it.each(staleCursors)('stale cursor ($kind) replays nothing and still gets active-run recovery', async ({ cursor }) => {
    const held = await staleChannel()
    s.deps.registry.registerActiveRun({ stream_id: `run-${sid}`, session_id: sid, started_at: 0, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false })
    const frames = await untilLease(s, sessionUrl(sid), { 'last-event-id': cursor(held) })
    expect(frames.map((frame) => frame.event)).toEqual(['initial', 'server_turn_started'])
    expect(frames[1]?.data).toMatchObject({ source: 'subscribe_recovery', stream_id: `run-${sid}` })
  })
})
