import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SseWriter, StreamSlots } from './sse-routes.js'
import type { RequestContext } from '../http/context.js'
import { bootTestServer, parseSseChunk, type SseFrame, type TestServer } from '../test/harness.js'

const FRAME_TEXT = 'x'.repeat(2000)
/** Tool output as a shell prints it: redaction scans one long identifier run (FRAME_TEXT) several times slower. */
const TOOL_TEXT = 'tool output line '.repeat(118)
const frameBytes = (i: number): number => Buffer.byteLength(`id: run:${String(i)}\nevent: token\ndata: ${JSON.stringify({ text: FRAME_TEXT })}\n\n`)

/**
 * A reader on a real local socket; `paused` holds it until `resume()`, so the server's socket buffer fills. The server
 * shares this process, so its response can arrive after a `resume()`: the call is remembered, and `opened` resolves once
 * the response has.
 */
function read(url: string, paused = false): { done: Promise<{ text: string; error: string | null }>; opened: Promise<void>; resume: () => void; destroy: () => void } {
  let res: IncomingMessage | null = null
  let hold = paused
  let text = ''
  let onOpen: () => void = () => undefined
  const opened = new Promise<void>((resolve) => { onOpen = resolve })
  const req = get(url)
  const done = new Promise<{ text: string; error: string | null }>((resolve) => {
    let error: string | null = null
    req.on('error', (e: NodeJS.ErrnoException) => { error = e.code ?? e.message; onOpen(); resolve({ text, error }) })
    req.on('response', (r) => {
      res = r
      r.setEncoding('utf8')
      if (hold) r.pause()
      r.on('data', (chunk: string) => { text += chunk })
      r.on('error', (e: NodeJS.ErrnoException) => { error = e.code ?? e.message })
      r.on('close', () => { resolve({ text, error: error ?? (r.complete ? null : 'aborted') }) })
      onOpen()
    })
  })
  return { done, opened, resume: () => { hold = false; res?.resume() }, destroy: () => { req.destroy() } }
}

/** One `SseWriter` per request on a real HTTP server, so backpressure comes from a real socket. */
async function serve(handler: (sse: SseWriter, res: ServerResponse) => Promise<void> | void, release: () => void = () => undefined): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    const ctx = { res, pendingCookies: [], securityHeaders: () => ({}), markFinished: () => undefined, deps: { log: () => undefined } } as unknown as RequestContext
    void handler(new SseWriter(ctx, release, true), res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }) }
}

describe('SseWriter backpressure on a real socket', () => {
  it('delivers a synchronous burst far past 4 MiB to a local reader', async () => {
    const count = 4500
    const server = await serve((sse) => {
      sse.start()
      for (let i = 1; i <= count; i += 1) sse.event('token', { text: FRAME_TEXT }, `run:${String(i)}`)
      sse.end()
    })
    const { text, error } = await read(server.url).done
    await server.close()
    let expected = 0
    for (let i = 1; i <= count; i += 1) expected += frameBytes(i)
    expect(expected).toBeGreaterThan(8 * 1024 * 1024)
    expect({ bytes: Buffer.byteLength(text), error }).toEqual({ bytes: expected, error: null })
  })

  it('ready() waits while the reader is paused and resolves once it reads again', async () => {
    let ready: Promise<boolean> = Promise.resolve(false)
    let wrote: () => void = () => undefined
    const written = new Promise<void>((resolve) => { wrote = resolve })
    const server = await serve((sse) => {
      sse.start()
      for (let i = 1; i <= 4500; i += 1) sse.event('token', { text: FRAME_TEXT }, `run:${String(i)}`)
      ready = sse.ready()
      wrote()
    })
    const client = read(server.url, true)
    await written
    let settled = false
    void ready.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 200))
    expect(settled).toBe(false)
    client.resume()
    expect(await ready).toBe(true)
    client.destroy()
    await server.close()
  })

  it('ready() resolves false and releases the stream slot when the reader disconnects mid-drain', async () => {
    const slots = new StreamSlots(() => 1)
    let ready: Promise<boolean> = Promise.resolve(true)
    let wrote: () => void = () => undefined
    const written = new Promise<void>((resolve) => { wrote = resolve })
    const server = await serve((sse) => {
      sse.start()
      for (let i = 1; i <= 4500; i += 1) sse.event('token', { text: FRAME_TEXT }, `run:${String(i)}`)
      ready = sse.ready()
      wrote()
      void ready.then(() => { sse.end() })
    }, slots.claim('reader')!)
    const client = read(server.url, true)
    await written
    client.destroy()
    expect(await ready).toBe(false)
    await new Promise((r) => setTimeout(r, 50))
    expect(slots.active).toBe(0)
    expect(slots.claim('reader')).not.toBeNull()
    await server.close()
  })
})

describe('event streams deliver past the old 4 MiB cut-off', () => {
  let s: TestServer
  let sid = ''
  beforeAll(async () => {
    s = await bootTestServer()
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    sid = ((await res.json()) as { session: { session_id: string } }).session.session_id
  })
  afterAll(() => s.close())

  const frames = async (client: ReturnType<typeof read>): Promise<SseFrame[]> => parseSseChunk((await client.done).text).frames
  const ids = (list: SseFrame[]): (string | null)[] => list.map((f) => f.id)
  const expectedIds = (run: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${run}:${String(i + 1)}`)
  /** Journal `n` token frames and a `stream_end`; `put` also publishes each to the live channel, `journal: false` publishes only. */
  const run = (runId: string, n: number, opts: { put?: (item: [string, unknown, string]) => void; journal?: boolean } = {}): void => {
    const w = opts.journal === false ? null : s.deps.journal.writer(sid, runId)
    for (let i = 1; i <= n + 1; i += 1) {
      const event = i <= n ? 'token' : 'stream_end'
      const data = i <= n ? { text: FRAME_TEXT } : {}
      const id = w ? w.appendSseEvent(event, data).event_id : `${runId}:${String(i)}`
      opts.put?.([event, data, id])
    }
    w?.close()
  }

  it('a finished run replays every frame of a journal past 4 MiB', async () => {
    run('run-finished', 3000)
    const got = await frames(read(`${s.base}/api/chat/stream?stream_id=run-finished&replay=1`))
    expect(ids(got)).toEqual(expectedIds('run-finished', 3001))
  })

  it('a replay to a paused reader keeps unsent data near the socket high-water mark, then delivers every frame', async () => {
    run('run-paused', 4000)
    const spy = vi.spyOn(SseWriter.prototype, 'event')
    try {
      const client = read(`${s.base}/api/chat/stream?stream_id=run-paused&replay=1`, true)
      await client.opened
      await new Promise((r) => setTimeout(r, 300))
      const writer = spy.mock.contexts.at(-1) as { ctx: RequestContext }
      expect(writer.ctx.res.writableLength).toBeLessThan(1024 * 1024)
      client.resume()
      expect(ids(await frames(client))).toEqual(expectedIds('run-paused', 4001))
    } finally {
      spy.mockRestore()
    }
  })

  /** A journal from before tool frames carried a public `id`: `pairs` tool calls, odd ones with the Agent's `tid`, even ones without. */
  const legacyRun = (runId: string, pairs: number): void => {
    const w = s.deps.journal.writer(sid, runId)
    for (let k = 1; k <= pairs; k += 1) {
      const tid = k % 2 ? `call-${String(k)}` : ''
      w.appendSseEvent('tool', { tid, name: `tool-${String(k % 5)}`, preview: TOOL_TEXT })
      w.appendSseEvent('tool_complete', { tid, name: `tool-${String(k % 5)}`, result: TOOL_TEXT })
    }
    w.appendSseEvent('stream_end', {})
    w.close()
  }

  // Rows parsed beyond what the replay has sent: the run-summary lookups' bounded tails (512 rows each) plus a 64 KiB page
  // per reader. A legacy replay walks the journal twice (rows and tool pairing), so its sent rows count twice. How many rows
  // reach the socket before the stall depends on the OS socket buffers, so they are subtracted out.
  it.each([
    { kind: 'token', runId: 'run-paged', write: () => { run('run-paged', 6000) }, readsPerRow: 1 },
    { kind: 'pre-id tool', runId: 'run-legacy', write: () => { legacyRun('run-legacy', 3000) }, readsPerRow: 2 },
  ])('a $kind replay to a paused reader parses the journal a page at a time rather than whole', async ({ runId, write, readsPerRow }) => {
    write()
    const parse = vi.spyOn(JSON, 'parse')
    const event = vi.spyOn(SseWriter.prototype, 'event')
    try {
      const client = read(`${s.base}/api/chat/stream?stream_id=${runId}&replay=1`, true)
      await client.opened
      await new Promise((r) => setTimeout(r, 300))
      const parsedRows = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes(`"run_id":"${runId}"`)).length
      expect(parsedRows - readsPerRow * event.mock.calls.length).toBeLessThan(2500)
      client.resume()
      expect(ids(await frames(client))).toEqual(expectedIds(runId, 6001))
    } finally {
      parse.mockRestore()
      event.mockRestore()
    }
  })

  it('a pre-id tool journal replays each completion with its call\'s id', async () => {
    legacyRun('run-legacy-ids', 40)
    const got = (await frames(read(`${s.base}/api/chat/stream?stream_id=run-legacy-ids&replay=1`))).filter((f) => f.event !== 'stream_end')
    const toolIds = got.map((f) => (f.data as { id?: string }).id)
    for (let k = 1; k <= 40; k += 1) {
      const [call, done] = [got[2 * k - 2]!, got[2 * k - 1]!]
      expect([call.event, done.event]).toEqual(['tool', 'tool_complete'])
      expect(toolIds[2 * k - 1]).toBe(toolIds[2 * k - 2])
      expect(toolIds[2 * k - 2]).toBe(k % 2 ? `call-${String(k)}` : `tool-${call.id ?? ''}`)
    }
  })

  it('a stalled session channel keeps the newest refetch signal instead of refusing it', async () => {
    const client = read(`${s.base}/api/session/stream?session_id=${sid}`)
    await subscribed(() => s.deps.channels.subscriberCount(sid))
    for (let n = 1; n <= 200; n += 1) s.deps.channels.emit(sid, 'bg_task_complete', { session_id: sid, n })
    await new Promise((r) => setTimeout(r, 300))
    client.destroy()
    const got = await frames(client)
    expect(got.filter((f) => f.event === 'bg_task_complete').at(-1)?.data).toMatchObject({ n: 200 })
  })

  it('a live run resumes every journaled frame past 4 MiB', async () => {
    const channel = s.deps.registry.create('run-resume', sid)
    run('run-resume', 3000)
    channel.lastEventId = 'run-resume:3001'
    const got = await frames(read(`${s.base}/api/chat/stream?stream_id=run-resume&replay=1`))
    s.deps.registry.retire('run-resume')
    expect(ids(got)).toEqual(expectedIds('run-resume', 3001))
  })

  const subscribed = async (count: () => number): Promise<void> => {
    for (let i = 0; i < 200 && count() === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
    expect(count()).toBe(1)
  }

  it('a stalled chat subscriber gets the frames its queue dropped back from the journal, in order', async () => {
    const channel = s.deps.registry.create('run-gap', sid)
    const client = read(`${s.base}/api/chat/stream?stream_id=run-gap`, true)
    await subscribed(() => channel.subscriberCount)
    run('run-gap', 12_000, { put: (item) => { channel.put(item) } })
    client.resume()
    const got = await frames(client)
    s.deps.registry.retire('run-gap')
    expect(channel.subscriberDropped).toBeGreaterThan(0)
    expect(ids(got)).toEqual(expectedIds('run-gap', 12_001))
  })

  it('a stalled chat subscriber that dropped a refetch signal still gets every run frame, then the newest signal', async () => {
    const channel = s.deps.registry.create('run-signal', sid)
    const client = read(`${s.base}/api/chat/stream?stream_id=run-signal`, true)
    await subscribed(() => channel.subscriberCount)
    channel.put(['bg_task_complete', { session_id: sid, n: 1 }, null])
    channel.put(['bg_task_complete', { session_id: sid, n: 2 }, null])
    run('run-signal', 12_000, { put: (item) => { channel.put(item) } })
    client.resume()
    const got = await frames(client)
    s.deps.registry.retire('run-signal')
    expect(got.filter((f) => f.event === 'apperror')).toEqual([])
    expect(ids(got.filter((f) => f.event !== 'bg_task_complete'))).toEqual(expectedIds('run-signal', 12_001))
    expect(got.filter((f) => f.event === 'bg_task_complete').map((f) => (f.data as { n: number }).n).at(-1)).toBe(2)
  })

  it('a stalled chat subscriber whose dropped frames the journal lacks gets the interrupted recovery frame', async () => {
    const channel = s.deps.registry.create('run-lost', sid)
    const client = read(`${s.base}/api/chat/stream?stream_id=run-lost`, true)
    await subscribed(() => channel.subscriberCount)
    run('run-lost', 12_000, { put: (item) => { channel.put(item) }, journal: false })
    client.resume()
    const got = await frames(client)
    s.deps.registry.retire('run-lost')
    expect(got.at(-1)?.event).toBe('apperror')
    expect(got.at(-1)?.data).toMatchObject({ type: 'interrupted', recovery_control: true, session_id: sid, stream_id: 'run-lost' })
    // Whatever was sent before the recovery frame is a gap-free prefix.
    const tokens = got.slice(0, -1)
    expect(ids(tokens)).toEqual(expectedIds('run-lost', tokens.length))
    expect(tokens.length).toBeLessThan(12_000)
  })

  it('a stalled session-journal subscriber gets the frames its queue dropped back from the journal, in order', async () => {
    const channel = s.deps.registry.create('run-journal-gap', sid)
    s.deps.registry.registerActiveRun({ stream_id: 'run-journal-gap', session_id: sid, started_at: 0, phase: 'running', workspace: '', model: null, provider: null, ephemeral: false })
    const client = read(`${s.base}/api/sessions/${sid}/events`, true)
    await subscribed(() => channel.subscriberCount)
    run('run-journal-gap', 12_000, { put: (item) => { channel.put(item) } })
    client.resume()
    const got = (await frames(client)).filter((f) => f.event !== 'session_snapshot')
    s.deps.registry.retire('run-journal-gap')
    expect(channel.subscriberDropped).toBeGreaterThan(0)
    expect(ids(got)).toEqual(expectedIds('run-journal-gap', 12_001))
  })
})
