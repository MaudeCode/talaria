import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetOwnSteer, rememberOwnSteer } from './composerReturn'

describe('own steers', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('keeps this tab\'s steer when sessionStorage is unavailable (TAL-743)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    rememberOwnSteer('private-mode')
    expect(forgetOwnSteer('private-mode')).toBe(true)
    expect(forgetOwnSteer('private-mode')).toBe(false)
  })
})
