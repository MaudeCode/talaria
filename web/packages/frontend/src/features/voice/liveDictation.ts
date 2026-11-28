/**
 * TAL-802: dictation through the server's live stream (`TRANSCRIBE_STREAM_PATH`), offered when the transcribe capability
 * reports `streaming`. Microphone PCM goes up while the user speaks and the provider's partial text comes back. The same
 * microphone is recorded locally, so a stream that fails at any point falls back to transcribing the recording.
 */
import { TRANSCRIBE_STREAM_PATH, TranscribeStreamEventSchema, type TranscribeResult } from '@maudecode/talaria-web-contracts'
import { resolveApiUrl } from '../../api/client'
import { transcribeRecording } from '../../api/endpoints'
import type { DictationErrorKind } from './dictation'
import pcmTapUrl from './pcmTap.worklet.ts?worker&url'

export interface LiveDictation {
  /** End the recording: the stream's final transcript, else the recording's. Rejects when neither is available, with `NoSpeechError` when the server heard none. */
  stop: () => Promise<string>
  /** Drop the recording and close the stream without a transcript; a pending `stop` uploads nothing and rejects. */
  cancel: () => void
}

/** No usable final transcript; the composer shows its no-speech notice and keeps the draft. */
export class NoSpeechError extends Error {
  constructor() {
    super('No speech detected')
    this.name = 'NoSpeechError'
  }
}

/** The sidecar's finalize waits up to 20 s for the provider. */
const FINAL_TIMEOUT_MS = 25_000
/** An interrupted audio context can stop answering. Use the recording fallback instead of holding the microphone. */
const FLUSH_TIMEOUT_MS = 1_000
/** About 2.7 seconds of mono PCM at 48 kHz. A longer backlog is better served by the recording. */
const MAX_STREAM_BUFFER_BYTES = 256 * 1024

export function liveDictationSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioContext !== 'undefined' && typeof WebSocket !== 'undefined'
}

/** Start recording; `onPartial` receives the provider's text for the whole recording so far (each call replaces the last). */
export async function startLiveDictation(onPartial: (text: string) => void): Promise<LiveDictation> {
  const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const recorded: Blob[] = []
  const { recorder, audio, tap, source, ws } = await openCapture(media, recorded)
  const early: ArrayBuffer[] = []
  let earlyBytes = 0
  let final: (TranscribeResult & { no_speech?: boolean }) | null = null
  let failed = false
  let ended = false
  let cancelled = false
  /** TAL-1298: cancel aborts a fallback upload already in flight. */
  const upload = new AbortController()
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  let acknowledgeFlush: (flushed: true) => void = () => undefined
  const flushAcknowledged = new Promise<true>((resolve) => { acknowledgeFlush = resolve })
  const release = () => {
    if (ended) return
    ended = true
    tap.port.onmessage = null
    tap.port.close()
    tap.disconnect()
    source.disconnect()
    void audio.close()
  }
  const clearEarly = () => {
    early.length = 0
    earlyBytes = 0
  }
  const fail = () => {
    if (failed) return
    failed = true
    clearEarly()
    // Stop producing PCM, but leave the MediaRecorder running on the microphone until Stop or Cancel.
    release()
    ws.close()
    settle()
  }
  const send = (frame: string | ArrayBuffer) => {
    if (failed || ws.readyState !== WebSocket.OPEN) return false
    // The only text frames here are ASCII control frames.
    const bytes = typeof frame === 'string' ? frame.length : frame.byteLength
    if (ws.bufferedAmount + bytes > MAX_STREAM_BUFFER_BYTES) {
      fail()
      return false
    }
    ws.send(frame)
    return true
  }

  ws.onopen = () => {
    if (!send(JSON.stringify({ sample_rate: audio.sampleRate }))) return
    for (const chunk of early) if (!send(chunk)) break
    clearEarly()
  }
  ws.onmessage = (message) => {
    if (failed) return
    let parsed
    try {
      parsed = TranscribeStreamEventSchema.safeParse(JSON.parse(String(message.data)))
    } catch {
      return
    }
    if (!parsed.success) return
    const event = parsed.data
    if (event.type === 'partial') {
      if (final === null) onPartial(event.text)
    } else if (event.type === 'final') {
      final = event
      settle()
    } else fail()
  }
  ws.onerror = fail
  ws.onclose = () => { if (final === null) fail() }

  tap.port.onmessage = (event: MessageEvent<Float32Array | 'flushed'>) => {
    if (failed || ended) return
    if (event.data === 'flushed') { acknowledgeFlush(true); return }
    const pcm = toPcm16(event.data)
    if (ws.readyState === WebSocket.CONNECTING) {
      if (earlyBytes + pcm.byteLength > MAX_STREAM_BUFFER_BYTES) fail()
      else {
        early.push(pcm)
        earlyBytes += pcm.byteLength
      }
    } else send(pcm)
  }
  source.connect(tap)
  // Connected to the output so every browser renders it; the tap writes nothing, so nothing is heard.
  tap.connect(audio.destination)

  const flushCapture = async () => {
    if (failed || ws.readyState !== WebSocket.OPEN) return false
    tap.port.postMessage('flush')
    let timer: ReturnType<typeof setTimeout> | undefined
    const acknowledged = await Promise.race([flushAcknowledged, settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, FLUSH_TIMEOUT_MS) })])
    clearTimeout(timer)
    return acknowledged === true
  }
  // Stop and Cancel share one finalization, so the recorder and microphone stop once.
  let finalized: Promise<Blob | null> | null = null
  const recording = () => finalized ??= new Promise<Blob | null>((resolve) => {
    const done = () => {
      if (cancelled) recorded.length = 0
      resolve(recorded.length ? new Blob(recorded, { type: recorder?.mimeType || 'audio/webm' }) : null)
    }
    if (!recorder || recorder.state === 'inactive') done()
    else {
      recorder.addEventListener('stop', done, { once: true })
      recorder.stop()
    }
  }).finally(() => { for (const track of media.getTracks()) track.stop() })
  /** Every await in `stop` ends here: nothing after a cancel reaches the fallback upload or the caller. */
  const live = () => { if (cancelled) throw new DOMException('Dictation cancelled', 'AbortError') }

  let stopping: Promise<string> | null = null
  return {
    stop: () => {
      stopping ??= (async () => {
        const flushed = await flushCapture()
        release()
        const blob = recording()
        if (!flushed || !send(JSON.stringify({ eos: true }))) fail()
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([settled, new Promise((resolve) => { timer = setTimeout(resolve, FINAL_TIMEOUT_MS) })])
        clearTimeout(timer)
        if (!failed) ws.close()
        live()
        let result = final
        if (result === null) {
          const file = await blob
          live()
          if (!file) throw new Error('nothing was recorded')
          result = await transcribeRecording(file, `dictation.${extension(file.type)}`, upload.signal)
          live()
        }
        const hasUsableTranscript = result.has_usable_transcript ?? !result.no_speech
        if (!hasUsableTranscript) throw new NoSpeechError()
        return result.transcript
      })()
      return stopping
    },
    cancel: () => {
      if (cancelled) return
      cancelled = true
      upload.abort()
      fail()
      recorded.length = 0
      void recording()
    },
  }
}

/** Recorder, audio graph and socket for an acquired microphone; a step that throws releases everything before it. */
async function openCapture(media: MediaStream, recorded: Blob[]) {
  let recorder: MediaRecorder | null = null
  let audio: AudioContext | null = null
  try {
    recorder = typeof MediaRecorder !== 'undefined' ? new MediaRecorder(media) : null
    recorder?.addEventListener('dataavailable', (event) => { if (event.data.size) recorded.push(event.data) })
    recorder?.start()
    audio = new AudioContext()
    await audio.audioWorklet.addModule(pcmTapUrl)
    const tap = new AudioWorkletNode(audio, 'pcm-tap')
    const source = audio.createMediaStreamSource(media)
    const url = resolveApiUrl(TRANSCRIBE_STREAM_PATH)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return { recorder, audio, tap, source, ws: new WebSocket(url) }
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    for (const track of media.getTracks()) track.stop()
    void audio?.close()
    throw error
  }
}

export interface LiveDictationHandle {
  /** End the recording; `onText` then gets the final transcript and `onEnd` follows. */
  stop: () => void
  /** Drop the recording: no further callbacks. */
  cancel: () => void
}

/**
 * One dictation from start to transcript. `onText` receives each partial and then the final transcript (each replaces
 * the last); `onEnd` follows once, with the error when no transcript came (microphone refused, nothing recorded, the
 * fallback upload failed). Neither is called after `cancel`.
 */
export function dictateLive(onText: (text: string) => void, onEnd: (error: unknown) => void): LiveDictationHandle {
  let cancelled = false
  let stopRequested = false
  let session: LiveDictation | null = null
  const finish = (started: LiveDictation) => {
    started.stop().then((transcript) => {
      if (cancelled) return
      onText(transcript)
      onEnd(null)
    }, (error: unknown) => { if (!cancelled) onEnd(error) })
  }
  startLiveDictation((text) => { if (!cancelled) onText(text) }).then((started) => {
    session = started
    if (cancelled) started.cancel()
    else if (stopRequested) finish(started)
  }, (error: unknown) => { if (!cancelled) onEnd(error) })
  return {
    stop: () => {
      if (stopRequested || cancelled) return
      stopRequested = true
      if (session) finish(session)
    },
    cancel: () => {
      cancelled = true
      session?.cancel()
    },
  }
}

/** A refused microphone reads as `denied` and an unusable final transcript as `no_speech`; anything else is a plain error. */
export function liveDictationErrorKind(error: unknown): DictationErrorKind {
  if (error instanceof NoSpeechError) return 'no_speech'
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : 'other'
}

/** Float samples in [-1, 1] as s16le PCM (every browser platform is little-endian). */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

const extension = (mime: string) => (/^audio\/(webm|ogg|mp4|mpeg|wav)\b/.exec(mime)?.[1] ?? 'webm')
