import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), saveDraft: vi.fn() }))
import { readLocalDraft, useDraftPersistence } from './useDraft'

describe('useDraftPersistence', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('keeps keystrokes out of browser storage until typing pauses (TAL-278)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { rerender } = renderHook(({ text }) => { useDraftPersistence('s1', text) }, { initialProps: { text: 'H' } })
    for (const text of ['He', 'Hel', 'Hell', 'Hello']) { rerender({ text }); vi.advanceTimersByTime(50) }
    expect(setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(readLocalDraft('s1')).toBe('Hello')
  })

  it('writes a pending draft at once when the session changes, the page hides, or the composer unmounts', () => {
    const { rerender, unmount } = renderHook(({ sid, text }) => { useDraftPersistence(sid, text) }, { initialProps: { sid: 's1', text: 'first draft' } })
    rerender({ sid: 's2', text: 'first draft' })
    expect(readLocalDraft('s1')).toBe('first draft')
    // The switch renders once with the old text before the composer loads the new session's draft.
    rerender({ sid: 's2', text: '' })
    expect(readLocalDraft('s2')).toBe('')
    rerender({ sid: 's2', text: 'second draft' })
    window.dispatchEvent(new Event('pagehide'))
    expect(readLocalDraft('s2')).toBe('second draft')
    rerender({ sid: 's2', text: 'second draft, more' })
    unmount()
    expect(readLocalDraft('s2')).toBe('second draft, more')
  })

  it('drops the stored draft as soon as the text is cleared', () => {
    const { rerender } = renderHook(({ text }) => { useDraftPersistence('s1', text) }, { initialProps: { text: 'sent soon' } })
    vi.advanceTimersByTime(300)
    expect(readLocalDraft('s1')).toBe('sent soon')
    rerender({ text: '' })
    expect(readLocalDraft('s1')).toBe('')
    vi.advanceTimersByTime(2000)
    expect(readLocalDraft('s1')).toBe('')
  })
})
