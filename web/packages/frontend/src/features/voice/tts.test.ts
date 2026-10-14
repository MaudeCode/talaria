import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { speak, stopSpeaking } from './tts'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), prepareSpeech: vi.fn() }))

/** The shared speech.prepare exchange (contracts/fixtures/speech-prepare.json). */
const exchange = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/speech-prepare.json'), 'utf8')) as { request: { text: string }; response: { spoken_text: string } }

const spoken: string[] = []
beforeEach(() => {
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} })
  vi.stubGlobal('speechSynthesis', { speak: (utter: { text: string }) => { spoken.push(utter.text) }, cancel: vi.fn(), getVoices: () => [] })
})
afterEach(() => {
  spoken.length = 0
  vi.unstubAllGlobals()
  vi.mocked(api.prepareSpeech).mockReset()
})

describe('speak (TAL-906)', () => {
  it('speaks the server spoken_text for the message, not the message itself', async () => {
    vi.mocked(api.prepareSpeech).mockResolvedValue(exchange.response)
    await speak(exchange.request.text)
    expect(api.prepareSpeech).toHaveBeenCalledExactlyOnceWith(exchange.request.text)
    expect(spoken).toEqual([exchange.response.spoken_text])
  })

  it('stays quiet when the script is empty or speech stopped while it was prepared', async () => {
    vi.mocked(api.prepareSpeech).mockResolvedValueOnce({ spoken_text: '' })
    await speak('```\nls\n```')
    let release: (value: { spoken_text: string }) => void = () => undefined
    vi.mocked(api.prepareSpeech).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const pending = speak('Hello')
    stopSpeaking()
    release({ spoken_text: 'Hello' })
    await pending
    expect(spoken).toEqual([])
  })
})
