/**
 * Text-to-speech: an extension engine when one is registered, otherwise the
 * browser's speechSynthesis (the Edge server engine was removed; `POST /api/tts`
 * still serves OpenAI and ElevenLabs to API clients). Engine, voice, rate and pitch are
 * device-local preferences on the legacy localStorage keys (Settings > Speech).
 */
import { readPersisted } from '../../lib/persisted'
import { ttsEngine } from '../../extensions/registry'

export const TTS_PREF = { engine: 'hermes-tts-engine', voice: 'hermes-tts-voice', rate: 'hermes-tts-rate', pitch: 'hermes-tts-pitch' } as const

let current: HTMLAudioElement | null = null

export function stopSpeaking(): void {
  if (current) { current.pause(); current = null }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export async function speak(text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim()
  if (!clean) return
  stopSpeaking()
  const engine = readPersisted(TTS_PREF.engine) ?? 'browser'
  const ext = ttsEngine(engine)
  if (ext) {
    const rate = parseFloat(readPersisted(TTS_PREF.rate) ?? '')
    const pitch = parseFloat(readPersisted(TTS_PREF.pitch) ?? '')
    const audioBuf = await ext.synthesize(clean.slice(0, 4000), { voice: readPersisted(TTS_PREF.voice), rate: Number.isNaN(rate) ? null : rate, pitch: Number.isNaN(pitch) ? null : pitch })
    const url = URL.createObjectURL(new Blob([audioBuf]))
    const audio = new Audio(url)
    current = audio
    audio.onended = () => { URL.revokeObjectURL(url); if (current === audio) current = null }
    await audio.play()
    return
  }
  if (!('speechSynthesis' in window)) return
  const utter = new SpeechSynthesisUtterance(clean.slice(0, 4000))
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
