import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/fixtures'
import { claimAutoRead } from './autoReadClaim'
import * as api from '../../api/endpoints'
import { ttsEngine, type TtsEngine } from '../../extensions/registry'
import { claimAutomaticSpeech, speak, stopSpeaking } from './tts'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), prepareSpeech: vi.fn() }))

vi.mock(import('./autoReadClaim'), () => ({ claimAutoRead: vi.fn() }))

vi.mock(import('../../extensions/registry'), async (importOriginal) => ({ ...(await importOriginal()), ttsEngine: vi.fn() }))

/** The shared speech.prepare exchange (contracts/fixtures/speech-prepare.json). */
const exchange = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/speech-prepare.json'), 'utf8')) as { request: { text: string }; response: { spoken_text: string } }

const spoken: string[] = []
const browserCancel = vi.fn()
beforeEach(() => {
  browserCancel.mockClear()
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} })
  vi.stubGlobal('speechSynthesis', { speak: (utter: { text: string }) => { spoken.push(utter.text) }, cancel: browserCancel, getVoices: () => [] })
})
afterEach(() => {
  spoken.length = 0
  vi.unstubAllGlobals()
  vi.mocked(api.prepareSpeech).mockReset()
  vi.mocked(ttsEngine).mockReset()
})

describe('speak (TAL-906)', () => {
  it('does not cancel the browser speech engine when it is idle', () => {
    stopSpeaking()
    expect(browserCancel).not.toHaveBeenCalled()
  })

  it.each(['speaking', 'pending'])('cancels browser speech when %s', (state) => {
    Object.assign(window.speechSynthesis, { [state]: true })
    stopSpeaking()
    expect(browserCancel).toHaveBeenCalledOnce()
  })

  it('speaks the server spoken_text for the message, not the message itself', async () => {
    vi.mocked(api.prepareSpeech).mockResolvedValue(exchange.response)
    await speak(exchange.request.text)
    expect(api.prepareSpeech).toHaveBeenCalledExactlyOnceWith(exchange.request.text)
    expect(spoken).toEqual([exchange.response.spoken_text])
  })

  it('speaks the reply as written when the server cannot prepare it', async () => {
    vi.mocked(api.prepareSpeech).mockRejectedValue(new Error('404'))
    await speak(' Hello there. ')
    expect(spoken).toEqual(['Hello there.'])
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


describe('automatic speech admission', () => {
  it.each(['stop', 'manual read'] as const)('keeps a committed claim quiet after a pending %s', async (action) => {
    const claim = deferred<boolean>()
    vi.mocked(claimAutoRead).mockReturnValue(claim.promise)
    const pending = claimAutomaticSpeech('synthetic-turn')
    if (action === 'stop') stopSpeaking()
    else {
      vi.mocked(api.prepareSpeech).mockResolvedValue({ spoken_text: 'Manual read' })
      await speak('Manual read')
    }
    claim.resolve(true)
    expect(await pending).toBe(false)
  })
})


/** One fake extension clip: its object URL, play/pause calls and the media events the browser would fire. */
class FakeAudio {
  static made: FakeAudio[] = []
  static playResult: () => Promise<void> = () => Promise.resolve()
  readonly pause = vi.fn()
  readonly play = vi.fn(() => FakeAudio.playResult())
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly src: string) { FakeAudio.made.push(this) }
}

describe('extension speech playback (TAL-1297)', () => {
  const synthesis: { text: string; bytes: ReturnType<typeof deferred<ArrayBuffer>> }[] = []
  let urls = 0
  const created: string[] = []
  const revoked: string[] = []
  const live = () => FakeAudio.made.filter((a) => !revoked.includes(a.src)).map((a) => a.src)

  beforeEach(() => {
    stopSpeaking()
    FakeAudio.made = []
    FakeAudio.playResult = () => Promise.resolve()
    synthesis.length = 0
    created.length = 0
    revoked.length = 0
    vi.stubGlobal('Audio', FakeAudio)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { created.push(`blob:synthetic-${++urls}`); return created.at(-1)! })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url) })
    const engine: TtsEngine = { id: 'synthetic', label: 'Synthetic', extensionId: 'synthetic-ext', synthesize: (text) => {
      const bytes = deferred<ArrayBuffer>()
      synthesis.push({ text, bytes })
      return bytes.promise
    } }
    vi.mocked(ttsEngine).mockReturnValue(engine)
    vi.mocked(api.prepareSpeech).mockImplementation((text) => Promise.resolve({ spoken_text: text }))
  })
  afterEach(() => { stopSpeaking(); vi.restoreAllMocks() })

  /** Starts a read and waits until its extension synthesis is pending. */
  async function start(text: string) {
    const done = speak(text)
    await vi.waitFor(() => expect(synthesis.at(-1)?.text).toBe(text))
    return { done, bytes: synthesis.at(-1)!.bytes }
  }

  it('stays quiet when speech stops while the extension synthesizes', async () => {
    const a = await start('First')
    stopSpeaking()
    a.bytes.resolve(new ArrayBuffer(1))
    await a.done
    expect(FakeAudio.made).toEqual([])
    expect(created).toEqual([])
  })

  it('plays only the latest read when an earlier synthesis finishes last', async () => {
    const a = await start('First')
    const b = await start('Second')
    b.bytes.resolve(new ArrayBuffer(2))
    await b.done
    a.bytes.resolve(new ArrayBuffer(1))
    await a.done
    expect(FakeAudio.made).toHaveLength(1)
    expect(FakeAudio.made[0]!.play).toHaveBeenCalledOnce()
    expect(live()).toEqual([FakeAudio.made[0]!.src])
  })

  it.each([
    // A paused or failed clip never fires ended, so Stop and error must release it themselves.
    ['Stop', () => { stopSpeaking(); stopSpeaking() }],
    ['ended', (clip: FakeAudio) => { clip.onended?.(); stopSpeaking() }],
    ['error', (clip: FakeAudio) => { clip.onerror?.(); stopSpeaking() }],
  ] as const)('releases the clip URL exactly once after %s', async (_, end) => {
    const a = await start('First')
    a.bytes.resolve(new ArrayBuffer(1))
    await a.done
    const clip = FakeAudio.made[0]!
    end(clip)
    expect(revoked).toEqual([clip.src])
  })

  it('releases the clip URL once when the browser refuses to play it', async () => {
    FakeAudio.playResult = () => Promise.reject(new Error('NotAllowedError'))
    const a = await start('First')
    a.bytes.resolve(new ArrayBuffer(1))
    await expect(a.done).rejects.toThrow('NotAllowedError')
    stopSpeaking()
    expect(revoked).toEqual([FakeAudio.made[0]!.src])
  })

  it('settles quietly when Stop interrupts a pending play', async () => {
    const play = deferred<undefined>()
    FakeAudio.playResult = async () => { await play.promise }
    const a = await start('First')
    a.bytes.resolve(new ArrayBuffer(1))
    await vi.waitFor(() => expect(FakeAudio.made[0]?.play).toHaveBeenCalledOnce())
    stopSpeaking()
    play.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
    await expect(a.done).resolves.toBeUndefined()
    expect(revoked).toEqual([FakeAudio.made[0]!.src])
  })

  it('reports a media failure that fires error before play rejects', async () => {
    const play = deferred<undefined>()
    FakeAudio.playResult = async () => { await play.promise }
    const a = await start('First')
    a.bytes.resolve(new ArrayBuffer(1))
    await vi.waitFor(() => expect(FakeAudio.made[0]?.play).toHaveBeenCalledOnce())
    FakeAudio.made[0]!.onerror?.()
    play.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
    await expect(a.done).rejects.toThrow('no supported sources')
    expect(revoked).toEqual([FakeAudio.made[0]!.src])
  })

  it('releases the old clip on replacement, and its late events leave the new clip playing', async () => {
    const a = await start('First')
    a.bytes.resolve(new ArrayBuffer(1))
    await a.done
    const b = await start('Second')
    const [old] = FakeAudio.made
    expect(old!.pause).toHaveBeenCalledOnce()
    expect(revoked).toEqual([old!.src])
    b.bytes.resolve(new ArrayBuffer(2))
    await b.done
    const clip = FakeAudio.made[1]!
    old!.onended?.()
    old!.onerror?.()
    expect(revoked).toEqual([old!.src])
    expect(clip.pause).not.toHaveBeenCalled()
    stopSpeaking()
    expect(clip.pause).toHaveBeenCalledOnce()
    expect(revoked).toEqual([old!.src, clip.src])
  })
})
