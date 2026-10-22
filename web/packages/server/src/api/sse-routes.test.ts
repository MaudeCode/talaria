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
