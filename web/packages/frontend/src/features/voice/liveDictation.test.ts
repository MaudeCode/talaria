import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { dictateLive, liveDictationErrorKind, toPcm16 } from './liveDictation'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), transcribeRecording: vi.fn() }))

/** The shared live dictation exchange (contracts/fixtures/transcribe-stream.json). */
const exchange = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/transcribe-stream.json'), 'utf8')) as {
  start: { sample_rate: number }
  events: { type: string; text?: string; transcript?: string }[]
  unavailable: { type: string; message: string }
}

class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static last: FakeSocket
  readonly sent: (string | ArrayBuffer)[] = []
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: URL) { FakeSocket.last = this }
  send(data: string | ArrayBuffer) { this.sent.push(data) }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
  text() { return this.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame) as unknown) }
  audioBytes() { return this.sent.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer).reduce((total, frame) => total + frame.byteLength, 0) }
}

const track = { stop: vi.fn() }
const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [track] }))

class FakeTap {
  static last: FakeTap | undefined
  port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() { FakeTap.last = this }
}

class FakeRecorder {
  /** Hold `stop` until `finish()`, as a browser does while it encodes the last chunk. */
  static deferStop = false
  static pending: (() => void)[] = []
  static finish() { for (const fire of FakeRecorder.pending.splice(0)) fire() }
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  private listeners: Record<string, ((event: { data: Blob }) => void)[]> = {}
  addEventListener(name: string, listener: (event: { data: Blob }) => void) { (this.listeners[name] ??= []).push(listener) }
  start() { this.state = 'recording' }
  stop() {
    const fire = () => {
      this.state = 'inactive'
      for (const listener of this.listeners.dataavailable ?? []) listener({ data: new Blob(['opus-bytes']) })
      for (const listener of this.listeners.stop ?? []) listener({ data: new Blob() })
    }
    if (FakeRecorder.deferStop) FakeRecorder.pending.push(fire)
    else fire()
  }
}

class FakeAudioContext {
  static closes = 0
  sampleRate = exchange.start.sample_rate
  destination = {}
  audioWorklet = { addModule: vi.fn(() => Promise.resolve()) }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() } }
  close() { FakeAudioContext.closes += 1; return Promise.resolve() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Start a dictation and wait until its socket exists (the microphone and worklet resolve first). */
async function start() {
  const texts: string[] = []
  const ends: unknown[] = []
  const handle = dictateLive((text) => texts.push(text), (error) => ends.push(error))
  await vi.waitFor(() => { expect(FakeTap.last).toBeDefined() })
  const ws = FakeSocket.last
  ws.open()
  return { handle, texts, ends, ws }
}

describe('live dictation (TAL-802)', () => {
  beforeEach(() => {
    FakeTap.last = undefined
    FakeSocket.last = undefined as never
    getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] })
    vi.mocked(api.transcribeRecording).mockReset().mockResolvedValue({ ok: true, transcript: ' from the recording ', filtered: false })
    track.stop.mockReset()
    FakeRecorder.deferStop = false
    FakeRecorder.pending = []
    FakeAudioContext.closes = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('AudioWorkletNode', FakeTap)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('streams PCM, shows partials while recording, and ends on the final without uploading', async () => {
    const { handle, texts, ends, ws } = await start()
    FakeTap.last?.port.onmessage?.({ data: new Float32Array(4096).fill(0.5) })
    expect(ws.url.pathname).toBe('/api/transcribe/stream')
    expect(ws.url.protocol).toBe('ws:')
    expect(ws.text()).toEqual([exchange.start])
    expect(ws.audioBytes()).toBe(8192)
    const [first, second, final] = exchange.events
    ws.receive(first)
    ws.receive(second)
    expect(texts).toEqual([first?.text, second?.text])
    handle.stop()
    await flush()
    expect(ws.text()).toEqual([exchange.start, { eos: true }])
    ws.receive(final)
    await vi.waitFor(() => { expect(ends).toEqual([null]) })
    expect(texts.at(-1)).toBe(final?.transcript)
    expect(api.transcribeRecording).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
  })

  it('falls back to transcribing the recording when the server reports an error', async () => {
    const { handle, texts, ends, ws } = await start()
    ws.receive(exchange.unavailable)
    FakeTap.last?.port.onmessage?.({ data: new Float32Array(4096) })
    expect(ws.audioBytes()).toBe(0)
    handle.stop()
    await vi.waitFor(() => { expect(ends).toEqual([null]) })
    expect(texts).toEqual(['from the recording'])
    expect(api.transcribeRecording).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.transcribeRecording).mock.calls[0]?.[1]).toBe('dictation.webm')
    expect(ws.text()).toEqual([exchange.start])
  })

  it('falls back when the stream closes mid-recording, ignoring late partials', async () => {
    const { handle, texts, ends, ws } = await start()
    ws.receive(exchange.events[0])
    ws.close()
    ws.receive(exchange.events[1])
    handle.stop()
    await vi.waitFor(() => { expect(ends).toEqual([null]) })
    expect(texts).toEqual([exchange.events[0]?.text, 'from the recording'])
  })

  it('reports the error when the fallback upload fails too', async () => {
    vi.mocked(api.transcribeRecording).mockRejectedValue(new Error('Speech-to-text is unavailable on this server'))
    const { handle, ends, ws } = await start()
    ws.close()
    handle.stop()
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })
    expect((ends[0] as Error).message).toBe('Speech-to-text is unavailable on this server')
  })

  it('cancel closes the stream and releases the microphone without any callback', async () => {
    const { handle, texts, ends, ws } = await start()
    handle.cancel()
    ws.receive(exchange.events[0])
    await flush()
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
    expect(track.stop).toHaveBeenCalled()
    expect(texts).toEqual([])
    expect(ends).toEqual([])
    expect(api.transcribeRecording).not.toHaveBeenCalled()
  })

  it('a stream final clears the final-wait timer (TAL-1298)', async () => {
    const { handle, ends, ws } = await start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handle.stop()
    await vi.advanceTimersByTimeAsync(0)
    ws.receive(exchange.events[2])
    await vi.waitFor(() => { expect(ends).toEqual([null]) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel after Stop, before the final, uploads nothing and calls back nothing (TAL-1298)', async () => {
    const { handle, texts, ends, ws } = await start()
    handle.stop()
    await flush()
    handle.cancel()
    await flush()
    await flush()
    expect(api.transcribeRecording).not.toHaveBeenCalled()
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
    expect(texts).toEqual([])
    expect(ends).toEqual([])
  })

  it('cancel while the recorder is still finalizing ignores its late data (TAL-1298)', async () => {
    FakeRecorder.deferStop = true
    const { handle, texts, ends, ws } = await start()
    ws.close()
    handle.stop()
    await flush()
    handle.cancel()
    FakeRecorder.finish()
    await flush()
    await flush()
    expect(api.transcribeRecording).not.toHaveBeenCalled()
    expect(texts).toEqual([])
    expect(ends).toEqual([])
  })

  it('cancel aborts a fallback upload already in flight and ignores its late answer (TAL-1298)', async () => {
    let answer: (value: { ok: true; transcript: string; filtered: boolean }) => void = () => undefined
    vi.mocked(api.transcribeRecording).mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const { handle, texts, ends, ws } = await start()
    ws.close()
    handle.stop()
    await vi.waitFor(() => { expect(api.transcribeRecording).toHaveBeenCalledTimes(1) })
    const signal = vi.mocked(api.transcribeRecording).mock.calls[0]?.[2]
    expect(signal?.aborted).toBe(false)
    handle.cancel()
    expect(signal?.aborted).toBe(true)
    answer({ ok: true, transcript: 'too late', filtered: false })
    await flush()
    expect(texts).toEqual([])
    expect(ends).toEqual([])
  })

  it.each([
    ['cancel, stop, cancel', (handle: { stop: () => void; cancel: () => void }) => { handle.cancel(); handle.stop(); handle.cancel() }],
    ['stop, cancel, cancel', (handle: { stop: () => void; cancel: () => void }) => { handle.stop(); handle.cancel(); handle.cancel() }],
  ])('releases the microphone, audio graph and socket once (%s, TAL-1298)', async (_order, run) => {
    const { handle, texts, ends, ws } = await start()
    const tap = FakeTap.last
    run(handle)
    await flush()
    await flush()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(tap?.disconnect).toHaveBeenCalledTimes(1)
    expect(FakeAudioContext.closes).toBe(1)
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
    expect(api.transcribeRecording).not.toHaveBeenCalled()
    expect(texts).toEqual([])
    expect(ends).toEqual([])
  })

  it.each(['MediaRecorder', 'AudioContext'])('releases the microphone when %s setup throws after it is acquired', async (failing) => {
    const broken = new Error(`${failing} failed`)
    vi.stubGlobal(failing, vi.fn(function construct() { throw broken }))
    const ends: unknown[] = []
    dictateLive(() => undefined, (error) => ends.push(error))
    await vi.waitFor(() => { expect(ends).toEqual([broken]) })
    expect(track.stop).toHaveBeenCalled()
    expect(FakeSocket.last?.readyState ?? FakeSocket.CLOSED).toBe(FakeSocket.CLOSED)
  })

  it('reports a refused microphone as denied', async () => {
    const refused = new DOMException('Permission denied', 'NotAllowedError')
    getUserMedia.mockRejectedValue(refused)
    const ends: unknown[] = []
    dictateLive(() => undefined, (error) => ends.push(error))
    await vi.waitFor(() => { expect(ends).toEqual([refused]) })
    expect(liveDictationErrorKind(refused)).toBe('denied')
    expect(liveDictationErrorKind(new Error('x'))).toBe('other')
  })

  it('encodes float samples as clamped s16le', () => {
    expect(Array.from(new Int16Array(toPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]))))).toEqual([0, 32767, -32768, 32767, -32768, 16383])
  })
})
