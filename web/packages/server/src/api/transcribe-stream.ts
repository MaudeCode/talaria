/**
 * TAL-802: live dictation, `GET /api/transcribe/stream` upgraded to a WebSocket (protocol in the contracts'
 * `transcribe-stream.ts`). Each socket owns one sidecar `stt.stream` call: PCM frames are fed to it in order through
 * `stt.stream_audio`, its partials and final are relayed back, and every other exit (hang-up, error, shutdown) aborts the
 * call, which cancels the provider session. Provider keys never leave the sidecar.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { TranscribeStreamEndSchema, TranscribeStreamStartSchema, type TranscribeStreamEvent } from '@maudecode/talaria-web-contracts'
import { activeProfileName } from '../auth/gate.js'
import type { RequestContext } from '../http/context.js'
import { checkSameOriginBrowserRequest, csrfRejectionError } from '../http/origin.js'
import { SidecarError, type SidecarLike } from '../sidecar/client.js'

/** One PCM frame; a browser sends a few hundred milliseconds at a time. */
const MAX_FRAME_BYTES = 1024 * 1024
/** Audio waiting for the sidecar; more means the session fell behind and the client should fall back. */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024
const START_TIMEOUT_MS = 10_000
/** The longest dictation, after which the session is cancelled and the client uses its recording. */
const MAX_STREAM_MS = 15 * 60_000
/** Each dictation holds a sidecar call slot for its whole length; the cap keeps the rest of the sidecar's slots free. */
export const MAX_TRANSCRIBE_STREAMS = 8

const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
const upgrades = new WeakMap<IncomingMessage, { socket: Duplex; head: Buffer }>()

/** Record an upgrade's socket and buffered bytes before the request runs through the normal pipeline (auth, profile). */
export function rememberUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgrades.set(req, { socket, head })
}

/** Close every open dictation at shutdown; each close cancels its session. */
export function closeTranscribeStreams(): void {
  for (const ws of sockets.clients) ws.terminate()
}

export async function handleTranscribeStream(ctx: RequestContext): Promise<void> {
  const upgrade = upgrades.get(ctx.req)
  if (!upgrade || (ctx.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
    await ctx.json({ error: 'WebSocket upgrade required' }, { status: 426, headers: { Upgrade: 'websocket' } })
    return
  }
  // A browser cannot send the CSRF header on a handshake, so the origin check alone guards it (non-browser clients pass).
  const failure = checkSameOriginBrowserRequest({ origin: ctx.header('origin'), referer: ctx.header('referer'), host: ctx.header('host'), secFetchSite: ctx.header('sec-fetch-site'), forwardedHost: ctx.header('x-forwarded-host'), realHost: ctx.header('x-real-host') }, ctx.deps.config.env)
  if (failure) {
    await ctx.json({ error: csrfRejectionError(failure) }, { status: 403 })
    return
  }
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) {
    await ctx.json({ error: 'Speech-to-text is unavailable on this server' }, { status: 503 })
    return
  }
  if (sockets.clients.size >= MAX_TRANSCRIBE_STREAMS) {
    await ctx.json({ error: 'Too many live dictations are open' }, { status: 503 })
    return
  }
  const profileHome = ctx.deps.profileHome(activeProfileName(ctx))
  const log = ctx.deps.log
  ctx.res.detachSocket(upgrade.socket as Parameters<typeof ctx.res.detachSocket>[0])
  ctx.markFinished(101)
  sockets.handleUpgrade(ctx.req, upgrade.socket, upgrade.head, (ws) => { relay(ws, sidecar, profileHome, log) })
}

function relay(ws: WebSocket, sidecar: SidecarLike, profileHome: string, log: (line: string) => void): void {
  const abort = new AbortController()
  const queued: Buffer[] = []
  let backlog = 0
  let streamId: string | null = null
  let started = false
  let ending = false
  let pumping = false
  let done = false

  const send = (event: TranscribeStreamEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)) }
  const finish = (event: TranscribeStreamEvent | null) => {
    if (done) return
    done = true
    clearTimeout(startTimer)
    // Every exit but the final cancels the session (and any audio call in flight).
    if (event?.type !== 'final') abort.abort()
    if (event) send(event)
    ws.close(1000)
  }
  const fail = (message: string) => { finish({ type: 'error', message }) }
  const startTimer = setTimeout(() => { fail('No start frame') }, START_TIMEOUT_MS)

  // Feed queued audio in order, one `stt.stream_audio` at a time; the batch taken after the end frame carries `end`.
  const pump = async () => {
    if (pumping || streamId === null) return
    pumping = true
    try {
      while (!done && (queued.length || ending)) {
        const end = ending
        const audio = Buffer.concat(queued.splice(0))
        backlog = 0
        await sidecar.call('stt.stream_audio', { stream_id: streamId, ...(audio.length ? { audio_b64: audio.toString('base64') } : {}), ...(end ? { end: true } : {}) }, { signal: abort.signal })
        if (end) return
      }
    } catch (error) {
      fail(message(error))
    } finally {
      pumping = false
    }
  }

  const start = (sampleRate: number) => {
    started = true
    clearTimeout(startTimer)
    sidecar.call('stt.stream', { profile_home: profileHome, sample_rate: sampleRate }, {
      signal: abort.signal,
      timeoutMs: MAX_STREAM_MS,
      onStream: (frame) => {
        if (done) return
        const data = frame.data as { stream_id?: string; text?: string }
        if (frame.event === 'ready' && typeof data.stream_id === 'string') {
          streamId = data.stream_id
          void pump()
        } else if (frame.event === 'partial' && typeof data.text === 'string') {
          send({ type: 'partial', text: data.text })
        }
      },
    }).then((result) => { finish({ type: 'final', transcript: result.transcript, filtered: result.filtered, provider: result.provider }) }, (error: unknown) => {
      if (!done) log(`[webui] live transcription ended: ${message(error)}`)
      fail(message(error))
    })
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (done) return
    const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
    if (isBinary) {
      if (!started || ending) { fail('Audio outside a recording'); return }
      backlog += chunk.length
      if (backlog > MAX_BACKLOG_BYTES) { fail('Live transcription fell behind'); return }
      queued.push(chunk)
      void pump()
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(chunk.toString('utf8'))
    } catch {
      fail('Frames must be JSON or binary audio')
      return
    }
    if (!started) {
      const parsed = TranscribeStreamStartSchema.safeParse(frame)
      if (!parsed.success) { fail('The first frame must name a sample_rate from 8000 to 48000'); return }
      start(parsed.data.sample_rate)
    } else if (TranscribeStreamEndSchema.safeParse(frame).success && !ending) {
      ending = true
      void pump()
    }
  })
  // A hang-up or socket error before the final cancels the session.
  ws.on('close', () => { finish(null) })
  ws.on('error', () => { finish(null) })
}

function message(error: unknown): string {
  if (error instanceof SidecarError) return error.message || 'Live transcription failed'
  return 'Live transcription failed'
}
