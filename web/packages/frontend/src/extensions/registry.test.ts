import { describe, expect, it } from 'vitest'
import { registerTtsEngine, ttsEngine, type TtsEngine } from './registry'

const engine = (label: string): TtsEngine => ({ id: 'voicebox', label, extensionId: 'voicebox', synthesize: () => Promise.resolve(new ArrayBuffer(1)) })

describe('TTS engine registry (TAL-568)', () => {
  it('keeps the background registration when the open panel closes', () => {
    const background = engine('background')
    const panel = engine('panel')
    const offBackground = registerTtsEngine(background)
    const offPanel = registerTtsEngine(panel)
    expect(ttsEngine('voicebox')).toBe(panel)
    offPanel()
    expect(ttsEngine('voicebox')).toBe(background)
    offPanel()
    expect(ttsEngine('voicebox')).toBe(background)
    offBackground()
    expect(ttsEngine('voicebox')).toBeUndefined()
  })
})
