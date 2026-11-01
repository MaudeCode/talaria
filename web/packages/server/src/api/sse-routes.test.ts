import { useJsonStorage } from '../test/storage.js'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { JsonJournal } from '../sessions/storage/json-journal.js'
import type { StreamChannel, StreamSubscriber } from '../sessions/streams.js'

useJsonStorage()

const io = vi.hoisted(() => ({ full: [] as string[], asyncFull: [] as string[], tails: [] as { path: string; position: number }[] }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, readdirSync: vi.fn(real.readdirSync), readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith('.jsonl')) io.full.push(String(args[0]))
    return real.readFileSync(...args)
  }) }
})
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fsp>()
  const paths = new WeakMap<fsp.FileHandle, string>()
  return { ...real, open: vi.fn(async (...args: Parameters<typeof fsp.open>) => {
    const handle = await real.open(...args)
    const path = String(args[0])
    paths.set(handle, path)
    if (path.endsWith('.jsonl') && args[1] === 'r') {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof read>) => {
        io.tails.push({ path, position: Number(Array.from(readArgs)[3]) })
        return read(...readArgs)
      })
    }
    return handle
  }), readFile: vi.fn(async (...args: Parameters<typeof fsp.readFile>) => {
    const path = typeof args[0] === 'object' && 'fd' in args[0] ? paths.get(args[0]) ?? '' : String(args[0])
    if (path.endsWith('.jsonl')) { io.full.push(path); io.asyncFull.push(path) }
    return real.readFile(...args)
  }) }
})

let server: TestServer | undefined
afterEach(async () => { vi.restoreAllMocks(); await server?.close(); server = undefined })

it.each(['/api/sessions/events', '/api/sessions/events?gateway=1'])('sends initial first on every connection to %s', async (path) => {
  const s = server = await bootTestServer()
  for (let connection = 0; connection < 2; connection++) {
    const frames = await s.sse(path, () => true, { timeoutMs: 1000 })
    expect(frames[0]).toMatchObject({ event: 'initial', data: {} })
  }
})

it.each([true, false])('reconnect reads each journal once and only the active tail, initially attached=%s', async (initiallyAttached) => {
  const s = server = await bootTestServer()
  const session = await s.deps.sessionStore.newSession()
  const sid = session.session_id
  const journal = s.deps.journal
  const old = await journal.writer(sid, 'past')
  await old.appendSseEvent('token', { text: 'past' }, { createdAt: 1 })
  await old.appendSseEvent('done', {}, { createdAt: 2 })
  await old.close()
  const active = await journal.writer(sid, 'active')
  const first = await active.appendSseEvent('token', { text: 'before reconnect 🌲' }, { createdAt: 3 })
  const channel = s.deps.registry.create('active', sid)
  channel.put(['token', first.payload, first.event_id])
  s.deps.registry.registerActiveRun({ stream_id: 'active', session_id: sid, started_at: 3, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false })
  if (!initiallyAttached) vi.spyOn(s.deps.registry, 'activeRunStreamForSession').mockReturnValueOnce(null)
  const full = journal.readSessionRunEvents.bind(journal)
  vi.spyOn(journal, 'readSessionRunEvents').mockImplementationOnce(async (...args) => {
    const replay = await full(...args)
    for (const [event, payload] of [['token', { text: 'during reconnect' }], ['stream_end', {}]] as const) {
      const row = await active.appendSseEvent(event, payload)
      channel.put([event, row.payload, row.event_id])
    }
    return replay
  })
  io.full.length = 0; io.asyncFull.length = 0; io.tails.length = 0
  const frames = await s.sse(`/api/sessions/${sid}/events`, (f) => f.event === 'stream_end', { headers: { 'Last-Event-ID': 'past:1' } })
  expect(frames.map((f) => f.id)).toEqual(['past:2', 'active:1', 'active:2', 'active:3'])
  for (const rid of ['past', 'active']) expect(io.full.filter((path) => path.endsWith(`/${rid}.jsonl`))).toHaveLength(1)
  expect(io.asyncFull).toHaveLength(2)
  expect(io.tails.length).toBeLessThanOrEqual(1)
  expect(io.tails.every(({ path, position }) => path.endsWith('/active.jsonl') && position > Buffer.byteLength(JSON.stringify(first)))).toBe(true)
  await active.close()
})

it('falls back to a snapshot when an unseen run finishes before idle attachment', async () => {
  const s = server = await bootTestServer()
  const session = await s.deps.sessionStore.newSession()
  const sid = session.session_id
  const journal = s.deps.journal
  const past = await journal.writer(sid, 'past')
  await past.appendSseEvent('token', { text: 'cursor' }, { createdAt: 1 })
  await past.close()
  const full = journal.readSessionRunEvents.bind(journal)
  const readReplay = vi.spyOn(journal, 'readSessionRunEvents').mockImplementationOnce(async (...args) => {
    const replay = await full(...args)
    const missed = await journal.writer(sid, 'missed')
    await missed.appendSseEvent('token', { text: 'finished while idle' }, { createdAt: 2 })
    await missed.appendSseEvent('stream_end', {}, { createdAt: 3 })
    await missed.close()
    const active = await journal.writer(sid, 'successor')
    const channel = s.deps.registry.create('successor', sid)
    for (const event of ['token', 'stream_end']) {
      const row = await active.appendSseEvent(event, { text: 'successor' }, { createdAt: 4 })
      channel.put([event, row.payload, row.event_id])
    }
    await active.close()
    s.deps.registry.registerActiveRun({ stream_id: 'successor', session_id: sid, started_at: 4, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false })
    return replay
  })
  io.full.length = 0; io.asyncFull.length = 0; io.tails.length = 0
  const frames = await s.sse(`/api/sessions/${sid}/events`, (f) => f.event === 'session_snapshot' || f.event === 'stream_end', { headers: { 'Last-Event-ID': 'past:1' } })
  expect(frames.map((f) => f.event)).toEqual(['session_snapshot'])
  expect(readReplay).toHaveBeenCalledTimes(1)
  expect(io.full).toHaveLength(1)
})

it('filters coalesced Web audio instructions to the SSE request profile and never replays them', async () => {
  const s = server = await bootTestServer()
  const received = s.sse('/api/sessions/events', (frame) => {
    if (frame.event === 'initial') {
      for (const profile of ['default', 'foreign']) s.deps.events.publish('web_completion', { profile, webAudio: { identity: profile, scope: profile, profile, eligible: true, expires_at: Date.now() + 60_000 } })
    }
    return frame.event === 'sessions_changed'
  })
  const frames = await received
  expect(frames.find((frame) => frame.event === 'sessions_changed')?.data).toMatchObject({ web_audio: [{ identity: 'default', profile: 'default' }] })
  const reconnect = await s.sse('/api/sessions/events', () => true)
  expect(reconnect[0]).toMatchObject({ event: 'initial', data: { stream: 'sessions' } })
  expect(reconnect[0]?.data).not.toHaveProperty('web_audio')
})

// TAL-1561: a replay never re-opens a prompt its own run already settled.
const clarifyTool = { name: 'clarify', tid: 'call-clarify', args: { question: 'Which?' } }
const clarifyDone = { name: 'clarify', tid: 'call-clarify', preview: '{"outcome": "submitted"}' }
const question = (id: string) => ({ clarify_id: id, question: `Question ${id}?`, choices_offered: ['A', 'B'], kind: 'clarify', pending_count: 1 })
const approval = (id: string, pending = 1) => ({ approval_id: id, request_id: id, command: 'rm -rf /tmp/probe', description: 'delete', pending_count: pending })

async function writeRun(s: TestServer, sid: string, runId: string, rows: [string, unknown][], createdAt: number, live?: StreamChannel): Promise<void> {
  const writer = await s.deps.journal.writer(sid, runId)
  for (const [index, [event, payload]] of rows.entries()) {
    const row = await writer.appendSseEvent(event, payload, { createdAt: createdAt + index })
    live?.put([event, row.payload, row.event_id])
  }
  await writer.close()
}

function liveRun(s: TestServer, sid: string, streamId: string): StreamChannel {
  const channel = s.deps.registry.create(streamId, sid)
  s.deps.registry.registerActiveRun({ stream_id: streamId, session_id: sid, started_at: 1, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false })
  return channel
}

it.each(['done', 'cancel', 'apperror'])('chat replay of a run that ended with %s omits its settled approval and clarify', async (terminal) => {
  const s = server = await bootTestServer()
  const sid = (await s.deps.sessionStore.newSession()).session_id
  await writeRun(s, sid, 'ended', [['token', { text: 'hi' }], ['tool', clarifyTool], ['clarify', question('q1')], ['tool_complete', clarifyDone], ['approval', approval('a1', 2)], [terminal, terminal === 'apperror' ? { message: 'boom' } : {}]], 1)
  const frames = await s.sse('/api/chat/stream?stream_id=ended&after_seq=0', () => false, { timeoutMs: 2000 })
  expect(frames.map((f) => [f.event, f.id])).toEqual([['token', 'ended:1'], ['tool', 'ended:2'], ['tool_complete', 'ended:4'], [terminal, 'ended:6']])
})

// `journal`: another tab was attached, so the reconnecting tab replays the journal; `buffer`: no tab was, so the channel
// buffered the frames for the next subscriber.
it.each(['journal', 'buffer'])('chat %s replay of an active run omits a settled clarify but keeps a pending approval, a later question and unproven prompts', async (source) => {
  const s = server = await bootTestServer()
  const sid = (await s.deps.sessionStore.newSession()).session_id
  const channel = liveRun(s, sid, 'live')
  const [otherTab] = channel.subscribeWithSnapshot()
  if (source === 'buffer') channel.unsubscribe(otherTab)
  // A completion without a readable tool name proves nothing about the question before it.
  await writeRun(s, sid, 'live', [['tool', clarifyTool], ['clarify', question('q1')], ['tool_complete', clarifyDone], ['approval', approval('a1', 2)], ['tool', clarifyTool], ['clarify', question('q2')], ['tool_complete', { preview: 'unnamed' }]], 1, channel)
  channel.unsubscribe(otherTab)
  const replay = vi.spyOn(s.deps.journal, 'iterRunEvents')
  const frames = await s.sse('/api/chat/stream?stream_id=live&after_seq=0', (f) => f.id === 'live:7', { timeoutMs: 2000 })
  expect(frames.map((f) => [f.event, f.id])).toEqual([['tool', 'live:1'], ['tool_complete', 'live:3'], ['approval', 'live:4'], ['tool', 'live:5'], ['clarify', 'live:6'], ['tool_complete', 'live:7']])
  expect(frames.find((f) => f.event === 'approval')?.data).toMatchObject({ approval_id: 'a1', pending_count: 2 })
  expect(frames.find((f) => f.event === 'clarify')?.data).toMatchObject({ clarify_id: 'q2' })
  // The frames came through the path under test, and the settlement lookahead read only the replay's own window.
  const windows = replay.mock.calls.map((call) => call[2])
  expect(windows.some((w) => w?.afterSeq === 0 && w.maxSeq === 7)).toBe(source === 'journal')
  expect(windows).toContainEqual({ afterSeq: 2, maxSeq: 7 })
})

it('per-session journal replay settles prompts only from their own run', async () => {
  const s = server = await bootTestServer()
  const sid = (await s.deps.sessionStore.newSession()).session_id
  await writeRun(s, sid, 'past', [['token', { text: 'cursor' }], ['done', {}]], 1)
  await writeRun(s, sid, 'errored', [['approval', approval('a0')], ['tool', clarifyTool], ['clarify', question('q0')], ['tool_complete', clarifyDone], ['apperror', { message: 'boom' }]], 10)
  const channel = liveRun(s, sid, 'active')
  // Seqs 2 and 3 sit below the errored run's settlement rows; another run's evidence never settles them.
  await writeRun(s, sid, 'active', [['token', { text: 'working' }], ['clarify', question('q7')], ['approval', approval('a2', 2)]], 20, channel)
  const frames = await s.sse(`/api/sessions/${sid}/events`, (f) => f.id === 'active:3', { headers: { 'Last-Event-ID': 'past:1' }, timeoutMs: 2000 })
  expect(frames.filter((f) => f.id).map((f) => [f.event, f.id])).toEqual([['done', 'past:2'], ['tool', 'errored:2'], ['tool_complete', 'errored:4'], ['apperror', 'errored:5'], ['token', 'active:1'], ['clarify', 'active:2'], ['approval', 'active:3']])
})

it.each(['chat', 'session'])('%s stream backfill of dropped frames omits a settled clarify', async (kind) => {
  const s = server = await bootTestServer()
  const sid = (await s.deps.sessionStore.newSession()).session_id
  const channel = liveRun(s, sid, 'live')
  let subscribed!: (sub: StreamSubscriber) => void
  const attached = new Promise<StreamSubscriber>((resolve) => { subscribed = resolve })
  const subscribe = channel.subscribeWithSnapshot.bind(channel)
  vi.spyOn(channel, 'subscribeWithSnapshot').mockImplementation(() => { const result = subscribe(); subscribed(result[0]); return result })
  const received = s.sse(kind === 'chat' ? '/api/chat/stream?stream_id=live' : `/api/sessions/${sid}/events`, (f) => f.id === 'live:5', { timeoutMs: 2000 })
  const sub = await attached
  await writeRun(s, sid, 'live', [['tool', clarifyTool], ['clarify', question('q1')], ['tool_complete', clarifyDone], ['approval', approval('a1')]], 1)
  // The bounded queue dropped rows 1-4 while the writer waited on a slow reader; row 5 arrives live.
  sub.gap = { firstEventId: 'live:1', unjournaled: false, dropped: 4, signals: new Map() }
  const writer = await s.deps.journal.writer(sid, 'live')
  const row = await writer.appendSseEvent('token', { text: 'after' })
  await writer.close()
  channel.put(['token', row.payload, row.event_id])
  const frames = await received
  expect(frames.filter((f) => f.id).map((f) => [f.event, f.id])).toEqual([['tool', 'live:1'], ['tool_complete', 'live:3'], ['approval', 'live:4'], ['token', 'live:5']])
})

it('chat reconnect among 200 session journals lists the journals root once in total and never once warm', async () => {
  const s = server = await bootTestServer()
  const sid = (await s.deps.sessionStore.newSession()).session_id
  const journal = s.deps.journal as JsonJournal
  for (let i = 0; i < 200; i++) fs.mkdirSync(join(journal.root(), `s${String(i).padStart(3, '0')}`), { recursive: true })
  // A run written before a restart: another journal on the same directory leaves this server's owner map cold.
  const before = new JsonJournal(journal.sessionDir)
  const writer = await before.writer(sid, 'ended')
  for (const [event, payload] of [['token', { text: 'a' }], ['token', { text: 'b' }], ['done', {}]] as const) await writer.appendSseEvent(event, payload)
  await writer.close()
  await before.close()
  const lookups = vi.spyOn(journal, 'findRunSummary')
  const reconnect = async (streamId: string, until: string): Promise<{ ids: (string | null)[]; listings: number; lookups: number }> => {
    vi.mocked(fs.readdirSync).mockClear(); lookups.mockClear()
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.id === until, { headers: { 'Last-Event-ID': `${streamId}:1` }, timeoutMs: 2000 })
    return { ids: frames.map((f) => f.id), listings: vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => String(path) === journal.root()).length, lookups: lookups.mock.calls.length }
  }
  expect(await reconnect('ended', 'ended:3')).toEqual({ ids: ['ended:2', 'ended:3'], listings: 1, lookups: 1 })
  expect(await reconnect('ended', 'ended:3')).toEqual({ ids: ['ended:2', 'ended:3'], listings: 0, lookups: 1 })
  // A run started on this server is warm from its first row.
  const channel = liveRun(s, sid, 'live')
  const [otherTab] = channel.subscribeWithSnapshot()
  await writeRun(s, sid, 'live', [['token', { text: 'a' }], ['token', { text: 'b' }], ['token', { text: 'c' }]], 1, channel)
  channel.unsubscribe(otherTab)
  expect(await reconnect('live', 'live:3')).toEqual({ ids: ['live:2', 'live:3'], listings: 0, lookups: 1 })
})
