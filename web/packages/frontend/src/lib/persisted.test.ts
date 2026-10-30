import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPersisted, removePersisted, writePersisted } from './persisted'

afterEach(() => { vi.restoreAllMocks() })

describe('persisted', () => {
  it('reads back a write that storage refused instead of the older stored value', () => {
    window.localStorage.setItem('persisted-test', 'old')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    writePersisted('persisted-test', 'new')
    expect(window.localStorage.getItem('persisted-test')).toBe('old')
    expect(readPersisted('persisted-test')).toBe('new')
    // Once a write succeeds again, storage is authoritative.
    setItem.mockRestore()
    writePersisted('persisted-test', 'saved')
    window.localStorage.setItem('persisted-test', 'from another tab')
    expect(readPersisted('persisted-test')).toBe('from another tab')
    removePersisted('persisted-test')
    expect(readPersisted('persisted-test')).toBeNull()
  })
})
