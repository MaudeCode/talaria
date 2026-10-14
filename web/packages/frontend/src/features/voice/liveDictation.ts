/**
 * TAL-802: dictation through the server's live stream (`TRANSCRIBE_STREAM_PATH`), offered when the transcribe capability
 * reports `streaming`. Microphone PCM goes up while the user speaks and the provider's partial text comes back. The same
 * microphone is recorded locally, so a stream that fails at any point falls back to transcribing the recording.
 */
import { TRANSCRIBE_STREAM_PATH, TranscribeStreamEventSchema } from '@maudecode/talaria-web-contracts'
import { resolveApiUrl } from '../../api/client'
import { transcribeRecording } from '../../api/endpoints'
import type { DictationErrorKind } from './dictation'
import pcmTapUrl from './pcmTap.worklet.ts?worker&url'

export interface LiveDictation {
  /** End the recording: the stream's final transcript, else the recording's. Rejects when neither is available. */
  stop: () => Promise<string>
  /** Drop the recording and close the stream without a transcript. */
  cancel: () => void
}

/** The sidecar's finalize waits up to 20 s for the provider. */
const FINAL_TIMEOUT_MS = 25_000

export function liveDictationSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioContext !== 'undefined' && typeof WebSocket !== 'undefined'
}

/** Start recording; `onPartial` receives the provider's text for the whole recording so far (each call replaces the last). */
export async function startLiveDictation(onPartial: (text: string) => void): Promise<LiveDictation> {
  const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const recorder = typeof MediaRecorder !== 'undefined' ? new MediaRecorder(media) : null
  const recorded: Blob[] = []
  recorder?.addEventListener('dataavailable', (event) => { if (event.data.size) recorded.push(event.data) })
  recorder?.start()
  const audio = new AudioContext()
  let tap: AudioWorkletNode
  try {
    await audio.audioWorklet.addModule(pcmTapUrl)
    tap = new AudioWorkletNode(audio, 'pcm-tap')
  } catch (error) {
    recorder?.stop()
    for (const track of media.getTracks()) track.stop()
    void audio.close()
    throw error
  }
  const source = audio.createMediaStreamSource(media)

  const url = resolveApiUrl(TRANSCRIBE_STREAM_PATH)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url)
  const early: ArrayBuffer[] = []
  let final: string | null = null
  let failed = false
  let ended = false
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  const fail = () => { failed = true; settle() }

  ws.onopen = () => {
    ws.send(JSON.stringify({ sample_rate: audio.sampleRate }))
    for (const chunk of early.splice(0)) ws.send(chunk)
  }
  ws.onmessage = (message) => {
    let parsed
    try {
      parsed = TranscribeStreamEventSchema.safeParse(JSON.parse(String(message.data)))
    } catch {
      return
    }
    if (!parsed.success) return
    const event = parsed.data
    if (event.type === 'partial') {
      if (!failed && final === null) onPartial(event.text)
    } else if (event.type === 'final') {
      final = event.transcript
      settle()
    } else fail()
  }
  ws.onerror = fail
  ws.onclose = () => { if (final === null) fail() }

  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (failed || ended) return
    const pcm = toPcm16(event.data)
    if (ws.readyState === WebSocket.OPEN) ws.send(pcm)
    else if (ws.readyState === WebSocket.CONNECTING) early.push(pcm)
  }
  source.connect(tap)
  // Connected to the output so every browser renders it; the tap writes nothing, so nothing is heard.
  tap.connect(audio.destination)

  const release = () => {
    ended = true
    tap.port.onmessage = null
    tap.disconnect()
    source.disconnect()
    void audio.close()
  }
  const recording = () => new Promise<Blob | null>((resolve) => {
    const done = () => { resolve(recorded.length ? new Blob(recorded, { type: recorder?.mimeType || 'audio/webm' }) : null) }
    if (!recorder || recorder.state === 'inactive') done()
    else {
      recorder.addEventListener('stop', done, { once: true })
      recorder.stop()
    }
  })
  const stopTracks = () => { for (const track of media.getTracks()) track.stop() }

  let stopping: Promise<string> | null = null
  return {
    stop: () => {
      stopping ??= (async () => {
        release()
        const blob = recording().finally(stopTracks)
        if (ws.readyState === WebSocket.OPEN && !failed) ws.send(JSON.stringify({ eos: true }))
        else fail()
        await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, FINAL_TIMEOUT_MS))])
        ws.close()
        if (final !== null) return final
        const file = await blob
        if (!file) throw new Error('nothing was recorded')
        return (await transcribeRecording(file, `dictation.${extension(file.type)}`)).transcript.trim()
      })()
      return stopping
    },
    cancel: () => {
      failed = true
      release()
      void recording().finally(stopTracks)
      ws.close()
    },
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

/** A refused microphone reads as `denied`; anything else is a plain error. */
export function liveDictationErrorKind(error: unknown): DictationErrorKind {
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
