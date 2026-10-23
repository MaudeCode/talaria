import { beforeEach, describe, expect, it, vi } from 'vitest'
import { audioPreferences, saveAudioPreferences, deliverCompletion, previewSound, AUDIO_KEY, DEFAULT_AUDIO, MAX_AUDIO_BYTES } from './completionAudio'
import { claimAutoRead } from './autoReadClaim'
vi.mock('./autoReadClaim', () => ({ claimAutoRead: vi.fn() }))
const play = vi.fn<() => Promise<void>>()
const pause = vi.fn()
let players: { src: string; volume: number }[] = []
const completion = () => ({ identity: 'run-1', scope: 'server-a-profile-a', profile: 'default', eligible: true, expires_at: Date.now() + 60_000 })
beforeEach(() => {
  localStorage.clear()
  players = []
  vi.clearAllMocks()
  vi.mocked(claimAutoRead).mockResolvedValue(true)
  play.mockResolvedValue()
  vi.stubGlobal('Audio', class { src: string; volume = 1; onended: unknown; onerror: unknown; play = play; pause = pause; removeAttribute = vi.fn(); constructor(src: string) { this.src = src; players.push(this) } })
})
describe('completion audio delivery', () => {
  it('plays a live eligible completion once across concurrent tabs using the server identity', async () => {
    const claimed = new Set<string>()
    vi.mocked(claimAutoRead).mockImplementation((key) => { if (claimed.has(key)) return Promise.resolve(false); claimed.add(key); return Promise.resolve(true) })
    await Promise.all([deliverCompletion(completion(), () => true), deliverCompletion(completion(), () => true)])
    expect(play).toHaveBeenCalledTimes(1)
    await deliverCompletion({ ...completion(), scope: 'other-server-profile' }, () => true)
    expect(play).toHaveBeenCalledTimes(2)
  })
  it('keeps expired, ineligible and muted deliveries quiet', async () => {
    await deliverCompletion({ ...completion(), expires_at: Date.now() - 1 }, () => true)
    await deliverCompletion({ ...completion(), eligible: false }, () => true)
    await deliverCompletion(completion(), () => false)
    expect(play).not.toHaveBeenCalled()
  })
  it('rechecks context and mute after the storage claim', async () => {
    let enabled = true
    vi.mocked(claimAutoRead).mockImplementation(() => { enabled = false; return Promise.resolve(true) })
    await deliverCompletion(completion(), () => enabled)
    expect(play).not.toHaveBeenCalled()
  })
  it('does not retry storage or autoplay failures', async () => {
    vi.mocked(claimAutoRead).mockResolvedValue(false)
    await deliverCompletion(completion(), () => true)
    expect(play).not.toHaveBeenCalled()
    vi.mocked(claimAutoRead).mockResolvedValue(true)
    play.mockRejectedValue(new Error('autoplay denied'))
    await expect(deliverCompletion(completion(), () => true)).resolves.toBeUndefined()
    expect(pause).toHaveBeenCalled()
  })
  it('supports a quiet period across midnight and a distinct quiet sound or none', async () => {
    saveAudioPreferences({ ...DEFAULT_AUDIO, quiet: true, start: '22:00', end: '07:00', quietSound: 'none' })
    await deliverCompletion(completion(), () => true, new Date(2026, 0, 1, 23, 30))
    await deliverCompletion(completion(), () => true, new Date(2026, 0, 2, 6, 30))
    expect(play).not.toHaveBeenCalled()
    saveAudioPreferences({ ...audioPreferences(), quietSound: 'bell' })
    await deliverCompletion(completion(), () => true, new Date(2026, 0, 2, 6, 30))
    expect(play).toHaveBeenCalledTimes(1)
    await deliverCompletion(completion(), () => true, new Date(2026, 0, 2, 12, 0))
    expect(play).toHaveBeenCalledTimes(2)
  })
  it('keeps missing and corrupt custom audio quiet, with no external URL fallback', async () => {
    saveAudioPreferences({ ...DEFAULT_AUDIO, sound: 'custom' })
    await deliverCompletion(completion(), () => true)
    expect(play).not.toHaveBeenCalled()
    localStorage.setItem(AUDIO_KEY, JSON.stringify({ ...DEFAULT_AUDIO, sound: 'custom', custom: 'https://example.com/track.mp3' }))
    expect(audioPreferences()).toEqual({ ...DEFAULT_AUDIO, sound: 'none' })
    await deliverCompletion(completion(), () => true)
    expect(play).not.toHaveBeenCalled()
  })
  it('bounds custom bytes and reports preference storage failures', () => {
    expect(() => saveAudioPreferences({ ...DEFAULT_AUDIO, custom: 'x'.repeat(MAX_AUDIO_BYTES * 2) })).toThrow()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    expect(() => saveAudioPreferences(DEFAULT_AUDIO)).toThrow('quota')
    expect(audioPreferences()).toEqual(DEFAULT_AUDIO)
  })
  it('previews only the explicitly selected sound', async () => {
    await previewSound({ ...DEFAULT_AUDIO, sound: 'none' })
    expect(play).not.toHaveBeenCalled()
    await previewSound({ ...DEFAULT_AUDIO, volume: 0.25 })
    expect(play).toHaveBeenCalledTimes(1)
    expect(players.at(-1)?.volume).toBe(0.25)
  })
})
