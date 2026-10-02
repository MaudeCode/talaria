import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), markSessionViewed: vi.fn(() => Promise.resolve({ ok: true as const })) }))
import * as api from '../../api/endpoints'
import { useMarkViewed } from './useMarkViewed'

let visibility: DocumentVisibilityState = 'visible'
const setVisibility = (next: DocumentVisibilityState): void => {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.mocked(api.markSessionViewed).mockClear()
})
afterEach(() => { vi.restoreAllMocks() })

it('marks a session viewed once its transcript loads from the server, never from a cached snapshot', () => {
  const { rerender } = renderHook(({ loaded }) => { useMarkViewed('s1', loaded, null) }, { initialProps: { loaded: false } })
  expect(api.markSessionViewed).not.toHaveBeenCalled()
  rerender({ loaded: true })
  expect(api.markSessionViewed).toHaveBeenCalledExactlyOnceWith('s1')
})

it('marks again when a run in the open session ends, deferring a hidden tab until it is visible', () => {
  const { rerender } = renderHook(({ ended }) => { useMarkViewed('s1', true, ended) }, { initialProps: { ended: null as string | null } })
  rerender({ ended: 'stream-1' })
  expect(api.markSessionViewed).toHaveBeenCalledTimes(2)
  setVisibility('hidden')
  rerender({ ended: 'stream-2' })
  expect(api.markSessionViewed).toHaveBeenCalledTimes(2)
  setVisibility('visible')
  expect(api.markSessionViewed).toHaveBeenCalledTimes(3)
})

it('stops marking a session the tab has left and ignores a missing session', () => {
  const { rerender, unmount } = renderHook(({ sid }) => { useMarkViewed(sid, true, null) }, { initialProps: { sid: null as string | null } })
  expect(api.markSessionViewed).not.toHaveBeenCalled()
  rerender({ sid: 's1' })
  rerender({ sid: 's2' })
  expect(vi.mocked(api.markSessionViewed).mock.calls).toEqual([['s1'], ['s2']])
  unmount()
  setVisibility('hidden')
  setVisibility('visible')
  expect(api.markSessionViewed).toHaveBeenCalledTimes(2)
})
