import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

const io = vi.hoisted(() => ({ full: [] as string[], asyncFull: [] as string[], tails: [] as { path: string; position: number }[] }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  return { ...real, readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) => {
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
