import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { MAX_TRANSCRIBE_STREAMS } from './transcribe-stream.js'
import { TRANSCRIBE_STREAM_PATH, TranscribeStreamEventSchema, type TranscribeStreamEvent } from '@maudecode/talaria-web-contracts'
import { SidecarError, type StreamFrame } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

/**
 * A stubbed provider session behind the fake sidecar: each pushed chunk raises a partial naming the bytes heard so far,
 * and `end` finalizes with the total, so ordering and the final text are observable.
 */
class LiveSession {
  readonly pushes: { bytes: number; end: boolean }[] = []
  readonly opened: { profile_home: string; sample_rate: number }[] = []
  cancelled = false
  private heard = 0
  private emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | null = null
  private finish: (() => void) | null = null

  install(sidecar: FakeSidecar): void {
    sidecar.respond('stt.stream', (params, emit, opts) => new Promise((resolve, reject) => {
      this.opened.push(params)
      this.emit = emit
      this.finish = () => { resolve({ transcript: `final ${String(this.heard)} bytes`, provider: 'fake-live' }) }
      opts.signal?.addEventListener('abort', () => {
        this.cancelled = true
        reject(new SidecarError('cancelled', { condition: 'cancelled' }))
      }, { once: true })
      emit({ event: 'ready', data: { stream_id: 'stream-1' } })
    }))
    sidecar.respond('stt.stream_audio', (params) => {
      if (params.stream_id !== 'stream-1') throw new SidecarError('Live transcription stream is closed', { condition: 'stt_stream_closed' })
      const bytes = Buffer.from(params.audio_b64 ?? '', 'base64').length
      this.pushes.push({ bytes, end: params.end === true })
      this.heard += bytes
      if (bytes) this.emit?.({ event: 'partial', data: { text: `heard ${String(this.heard)} bytes` } })
      if (params.end) this.finish?.()
      return { ok: true as const }
    })
  }
}

interface Dictation { events: TranscribeStreamEvent[]; status: number | null; closed: boolean }

/** One recording: start, the PCM chunks, then the end frame (unless `hangUp`, which closes after the audio instead). */
function dictate(s: TestServer, chunks: Buffer[], opts: { origin?: string; hangUp?: (ws: WebSocket) => void; sampleRate?: number } = {}): Promise<Dictation> {
  return new Promise((resolve) => {
    const result: Dictation = { events: [], status: null, closed: false }
    const ws = new WebSocket(s.base.replace(/^http/, 'ws') + TRANSCRIBE_STREAM_PATH, { headers: opts.origin ? { origin: opts.origin } : {} })
    ws.on('message', (data: Buffer) => { result.events.push(TranscribeStreamEventSchema.parse(JSON.parse(data.toString('utf8')))) })
    ws.on('unexpected-response', (_req, res) => { result.status = res.statusCode ?? null; res.resume(); resolve(result) })
    ws.on('error', () => { resolve(result) })
    ws.on('close', () => { result.closed = true; resolve(result) })
    ws.on('open', () => {
      ws.send(JSON.stringify({ sample_rate: opts.sampleRate ?? 48_000 }))
      for (const chunk of chunks) ws.send(chunk)
      if (opts.hangUp) opts.hangUp(ws)
      else ws.send(JSON.stringify({ eos: true }))
    })
  })
}

const pcm = (samples: number) => Buffer.alloc(samples * 2, 1)

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('live dictation stream (TAL-802)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let session: LiveSession

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(async () => { await s.close() })
  beforeEach(() => {
    session = new LiveSession()
    session.install(sidecar)
  })

  it('relays partials before the final, and the final is the session finalize', async () => {
    const done = await dictate(s, [pcm(4800), pcm(4800)])
    const types = done.events.map((event) => event.type)
    expect(types.at(-1)).toBe('final')
    expect(types.slice(0, -1).length).toBeGreaterThan(0)
    expect(types.slice(0, -1).every((type) => type === 'partial')).toBe(true)
    expect(done.events.at(-2)).toEqual({ type: 'partial', text: 'heard 19200 bytes' })
    expect(done.events.at(-1)).toEqual({ type: 'final', transcript: 'final 19200 bytes', provider: 'fake-live' })
    expect(done.closed).toBe(true)
    expect(session.opened).toEqual([{ profile_home: s.deps.profileHome('default'), sample_rate: 48_000 }])
    // Every chunk reaches the session in order, and the end of speech comes last.
    expect(session.pushes.reduce((total, push) => total + push.bytes, 0)).toBe(19_200)
    expect(session.pushes.map((push) => push.end)).toEqual([...session.pushes.slice(1).map(() => false), true])
    expect(session.cancelled).toBe(false)
  })

  it('cancels the session when the client hangs up before the end of speech', async () => {
    const done = await dictate(s, [pcm(1600)], { hangUp: (ws) => { setTimeout(() => { ws.close() }, 50) } })
    expect(done.events.every((event) => event.type === 'partial')).toBe(true)
    await until(() => session.cancelled)
  })

  it('answers error when the profile has no live wire, so the client falls back to the upload', async () => {
    sidecar.respond('stt.stream', () => { throw new SidecarError('Live transcription is unavailable for the configured provider', { condition: 'stt_stream_unavailable' }) })
    const done = await dictate(s, [pcm(1600)])
    expect(done.events).toEqual([{ type: 'error', message: 'Live transcription is unavailable for the configured provider' }])
    expect(done.closed).toBe(true)
  })

  it('refuses a start frame outside the contract without opening a session', async () => {
    const done = await dictate(s, [pcm(1600)], { sampleRate: 96_000 })
    expect(done.events.map((event) => event.type)).toEqual(['error'])
    expect(session.opened).toEqual([])
  })

  it('refuses a cross-origin browser handshake before any session opens', async () => {
    const done = await dictate(s, [pcm(1600)], { origin: 'https://evil.example' })
    expect(done.status).toBe(403)
    expect(done.events).toEqual([])
    expect(session.opened).toEqual([])
  })

  it('refuses a dictation beyond the open-stream cap, keeping sidecar slots free', async () => {
    const held = Array.from({ length: MAX_TRANSCRIBE_STREAMS }, () => {
      let socket: WebSocket | null = null
      const done = dictate(s, [], { hangUp: (ws) => { socket = ws } })
      return { done, close: () => socket?.close() }
    })
    await until(() => session.opened.length === MAX_TRANSCRIBE_STREAMS)
    const refused = await dictate(s, [pcm(1600)])
    expect(refused.status).toBe(503)
    for (const stream of held) stream.close()
    await Promise.all(held.map((stream) => stream.done))
    await until(() => session.cancelled)
  })

  it('answers a plain request with 426 instead of upgrading', async () => {
    const res = await s.get(TRANSCRIBE_STREAM_PATH)
    expect(res.status).toBe(426)
  })

  it('reports streaming from the sidecar capability', async () => {
    sidecar.respond('stt.capability', () => ({ available: true, provider: 'openai', streaming: true }))
    expect(await (await s.get('/api/transcribe/capability')).json()).toEqual({ ok: true, available: true, provider: 'openai', streaming: true })
    sidecar.respond('stt.capability', undefined)
  })
})

describe('live dictation stream shutdown (TAL-802)', () => {
  it('closes an open stream and cancels its session when the server stops', async () => {
    const sidecar = new FakeSidecar()
    const session = new LiveSession()
    session.install(sidecar)
    const s = await bootTestServer({ sidecar })
    let closed: Promise<Dictation> | null = null
    closed = dictate(s, [pcm(1600)], { hangUp: () => undefined })
    await until(() => session.pushes.length > 0)
    await s.close()
    const done = await closed
    expect(done.closed).toBe(true)
    expect(done.events.some((event) => event.type === 'final')).toBe(false)
    await until(() => session.cancelled)
  })
})
