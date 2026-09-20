/** Browser dictation through SpeechRecognition (feature-detected; secure context required). */
interface RecognitionLike { lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; start(): void; stop(): void }

export function dictationSupported(): boolean {
  return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) && window.isSecureContext
}

export function createRecognition(lang: string): RecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  const r = new Ctor()
  r.lang = lang
  r.interimResults = true
  r.continuous = false
  return r
}

export type DictationErrorKind = 'denied' | 'insecure' | 'no_speech' | 'network' | 'other'
export function classifyDictationError(code: string): DictationErrorKind {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'denied'
  if (code === 'no-speech') return 'no_speech'
  if (code === 'network') return 'network'
  return 'other'
}
