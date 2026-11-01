/**
 * Text-to-speech: an extension engine when one is registered, otherwise the
 * browser's speechSynthesis. `POST /api/tts` serves the Agent's configured
 * speech providers to API clients. Engine, voice, rate and pitch are
 * device-local preferences on the legacy localStorage keys (Settings > Speech).
 * What is spoken is the server's `spoken_text` (TAL-906), played as is.
 */
import { readPersisted } from '../../lib/persisted'
import { ttsEngine } from '../../extensions/registry'
import { prepareSpeech } from '../../api/endpoints'
import { claimAutoRead } from './autoReadClaim'

export const TTS_PREF = { engine: 'hermes-tts-engine', voice: 'hermes-tts-voice', rate: 'hermes-tts-rate', pitch: 'hermes-tts-pitch' } as const

/** The playing extension clip; `release` pauses it and frees its Blob URL once, whichever exit comes first. */
let current: { release: () => void } | null = null
/** Bumped by every stop, so a reply still being prepared never starts after a later stop or speak. */
let generation = 0

/** A Stop or manual read while storage is pending also cancels this automatic attempt. */
export async function claimAutomaticSpeech(identity: string): Promise<boolean> {
  const turn = generation
  return await claimAutoRead(identity) && turn === generation
}

export function stopSpeaking(): void {
  generation += 1
  current?.release()
  if ('speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) window.speechSynthesis.cancel()
}

export async function speak(text: string): Promise<void> {
  stopSpeaking()
  const turn = generation
  // A server without `speech.prepare` (a Stable channel switch) or a dropped request speaks the reply as written.
  const spoken = await prepareSpeech(text).then((r) => r.spoken_text, () => text.trim().slice(0, 4000))
  if (turn !== generation || !spoken) return
  const engine = readPersisted(TTS_PREF.engine) ?? 'browser'
  const ext = ttsEngine(engine)
  if (ext) {
    const rate = parseFloat(readPersisted(TTS_PREF.rate) ?? '')
    const pitch = parseFloat(readPersisted(TTS_PREF.pitch) ?? '')
    const audioBuf = await ext.synthesize(spoken, { voice: readPersisted(TTS_PREF.voice), rate: Number.isNaN(rate) ? null : rate, pitch: Number.isNaN(pitch) ? null : pitch })
    if (turn !== generation) return
    const url = URL.createObjectURL(new Blob([audioBuf]))
    const audio = new Audio(url)
    let released = false
    const playback = { release: () => {
      if (released) return
      released = true
      audio.pause()
      URL.revokeObjectURL(url)
      if (current === playback) current = null
    } }
    current = playback
    audio.onended = audio.onerror = playback.release
    // A Stop during play() rejects it with AbortError; that is the requested silence, not a failure.
    try { await audio.play() } catch (err) { const stopped = released; playback.release(); if (!stopped) throw err }
    return
  }
  if (!('speechSynthesis' in window)) return
  const utter = new SpeechSynthesisUtterance(spoken)
  const voiceName = readPersisted(TTS_PREF.voice)
  if (voiceName) {
    const v = window.speechSynthesis.getVoices().find((x) => x.name === voiceName || x.voiceURI === voiceName)
    if (v) utter.voice = v
  }
  const rate = parseFloat(readPersisted(TTS_PREF.rate) ?? '')
  const pitch = parseFloat(readPersisted(TTS_PREF.pitch) ?? '')
  if (!Number.isNaN(rate)) utter.rate = rate
  if (!Number.isNaN(pitch)) utter.pitch = pitch
  utter.lang = document.documentElement.lang || 'en-US'
  window.speechSynthesis.speak(utter)
}
