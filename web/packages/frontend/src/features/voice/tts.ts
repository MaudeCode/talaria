/**
 * Text-to-speech: an extension engine when one is registered, a server engine
 * (`POST /api/tts`, OpenAI or ElevenLabs) when configured,
 * otherwise the browser's speechSynthesis. Voice, rate and pitch keep the
 * legacy localStorage keys.
 */
import { readPersisted } from '../../lib/persisted'
import { resolveApiUrl, csrfToken } from '../../api/client'
import { ttsEngine } from '../../extensions/registry'

let current: HTMLAudioElement | null = null

export function stopSpeaking(): void {
  if (current) { current.pause(); current = null }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export async function speak(text: string): Promise<void> {
  const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').trim()
  if (!clean) return
  stopSpeaking()
  const engine = readPersisted('hermes-tts-engine') ?? 'browser'
  const ext = ttsEngine(engine)
  if (ext) {
    const rate = parseFloat(readPersisted('hermes-tts-rate') ?? '')
    const pitch = parseFloat(readPersisted('hermes-tts-pitch') ?? '')
    const audioBuf = await ext.synthesize(clean.slice(0, 4000), { voice: readPersisted('hermes-tts-voice'), rate: Number.isNaN(rate) ? null : rate, pitch: Number.isNaN(pitch) ? null : pitch })
    const url = URL.createObjectURL(new Blob([audioBuf]))
    const audio = new Audio(url)
    current = audio
    audio.onended = () => { URL.revokeObjectURL(url); if (current === audio) current = null }
    await audio.play()
    return
  }
  if (!('speechSynthesis' in window)) return
  const utter = new SpeechSynthesisUtterance(clean.slice(0, 4000))
  const voiceName = readPersisted('hermes-tts-voice')
  if (voiceName) {
    const v = window.speechSynthesis.getVoices().find((x) => x.name === voiceName || x.voiceURI === voiceName)
    if (v) utter.voice = v
  }
  const rate = parseFloat(readPersisted('hermes-tts-rate') ?? '')
  const pitch = parseFloat(readPersisted('hermes-tts-pitch') ?? '')
  if (!Number.isNaN(rate)) utter.rate = rate
  if (!Number.isNaN(pitch)) utter.pitch = pitch
  utter.lang = document.documentElement.lang || 'en-US'
  window.speechSynthesis.speak(utter)
}
