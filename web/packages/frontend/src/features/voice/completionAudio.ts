/** Device-local Web audio. The server alone supplies completion identity and eligibility. */
import { z } from 'zod'
import { appRoot } from '../../lib/appRoot'
import { claimAutoRead } from './autoReadClaim'
import type { WebAudioCompletion } from '@maudecode/talaria-web-contracts'

export const AUDIO_KEY = 'talaria-completion-audio-v1'
export const MAX_AUDIO_BYTES = 1024 * 1024
export const SOUND_CHOICES = ['none', 'chime', 'bell', 'tap', 'custom'] as const
const Sound = z.enum(SOUND_CHOICES)
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const Preferences = z.object({
  sound: Sound, volume: z.number().min(0).max(1), quiet: z.boolean(), start: Time, end: Time, quietSound: Sound,
  custom: z.string().max(Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 64).regex(/^data:audio\/(wav|mpeg|ogg|mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/).nullable().refine((value) => {
    if (!value) return true
    const base64 = value.slice(value.indexOf(',') + 1)
    return base64.length * 3 / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) <= MAX_AUDIO_BYTES
  }),
})
export type AudioPreferences = z.infer<typeof Preferences>
export const DEFAULT_AUDIO: AudioPreferences = { sound: 'chime', volume: 0.5, quiet: false, start: '22:00', end: '07:00', quietSound: 'none', custom: null }

export function audioPreferences(): AudioPreferences {
  try {
    const raw = localStorage.getItem(AUDIO_KEY)
    if (!raw) return DEFAULT_AUDIO
    if (raw.length > MAX_AUDIO_BYTES * 1.4 + 512) return { ...DEFAULT_AUDIO, sound: 'none' }
    const parsed = Preferences.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : { ...DEFAULT_AUDIO, sound: 'none' }
  } catch { return { ...DEFAULT_AUDIO, sound: 'none' } }
}

export function saveAudioPreferences(value: AudioPreferences): void {
  localStorage.setItem(AUDIO_KEY, JSON.stringify(Preferences.parse(value)))
}

/** Small PCM WAV presets are generated locally; no URL or download can reach playback. */
function preset(sound: 'chime' | 'bell' | 'tap'): string {
  const rate = 16000, duration = sound === 'tap' ? 0.12 : 0.65
  const samples = Math.floor(rate * duration)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    const frequency = sound === 'tap' ? 440 : sound === 'bell' ? 1046.5 : t < 0.23 ? 659.25 : 880
    const envelope = Math.min(t * 100, 1) * Math.exp(-t * (sound === 'tap' ? 35 : 7))
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * frequency * t) * envelope * 16000, true)
  }
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(binary)}`
}

let stop: (() => void) | undefined
async function play(sound: AudioPreferences['sound'], preferences: AudioPreferences): Promise<void> {
  stop?.()
  if (sound === 'none' || preferences.volume === 0) return
  const source = sound === 'custom' ? preferences.custom : preset(sound)
  if (!source) return
  const audio = new Audio(source)
  audio.volume = preferences.volume
  const cleanup = () => {
    clearTimeout(timer)
    audio.pause()
    audio.removeAttribute('src')
    if (stop === cleanup) stop = undefined
  }
  // A local file can never leave an unbounded player running.
  const timer = setTimeout(cleanup, 10_000)
  stop = cleanup
  audio.onended = cleanup
  audio.onerror = cleanup
  try { await audio.play() } catch (error) { cleanup(); throw error }
}

export async function previewSound(preferences: AudioPreferences): Promise<void> {
  await play(preferences.sound, Preferences.parse(preferences))
}

export async function deliverCompletion(completion: WebAudioCompletion, enabled: () => boolean, now = new Date()): Promise<void> {
  if (!completion.eligible || completion.expires_at <= Date.now()) return
  try {
    // Share the existing bounded IndexedDB claim owner, with a separate identity namespace from speech.
    if (!await claimAutoRead(JSON.stringify(['completion-audio', appRoot().href, completion.scope, completion.identity]))) return
    if (!enabled() || completion.expires_at <= Date.now()) return
    const preferences = audioPreferences()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const quiet = preferences.quiet && (preferences.start < preferences.end
      ? time >= preferences.start && time < preferences.end
      : time >= preferences.start || time < preferences.end)
    await play(quiet ? preferences.quietSound : preferences.sound, preferences)
  } catch { /* A failed storage claim or autoplay attempt is never replayed. */ }
}

export async function readLocalAudio(file: File): Promise<string> {
  if (!file.size || file.size > MAX_AUDIO_BYTES || !/^audio\/(wav|mpeg|ogg|mp4|webm)$/.test(file.type)) throw new Error('invalid audio')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const source = `data:${file.type};base64,${btoa(binary)}`
  // Decode before retaining bytes; malformed audio never replaces the last confirmed choice.
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(bytes.buffer)
    if (decoded.duration > 10) throw new Error('audio too long')
  } finally { await context.close() }
  return source
}
