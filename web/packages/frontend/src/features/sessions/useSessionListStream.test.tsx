import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { keys } from '../../api/queryKeys'
import { useSessionListStream } from './SessionListPanel'

let sources: { readyState: number; close: () => void; emit: (name: string, data: unknown) => void }[] = []

beforeEach(() => {
  sources = []
  vi.stubGlobal('EventSource', class {
    readyState = 1
    private readonly listeners = new Map<string, (ev: Event) => void>()
    constructor() { sources.push(this) }
    emit(name: string, data: unknown) { this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) })) }
    addEventListener(name: string, fn: (ev: Event) => void) { this.listeners.set(name, fn) }
    close = vi.fn(() => { this.readyState = 2 })
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mountWithCache() {
  const qc = new QueryClient()
  const list = keys.sessions.list({})
  for (const key of [list, keys.sessions.detail('a'), keys.sessions.detail('b'), keys.sessions.status('a'), keys.background('b')]) qc.setQueryData(key, {})
  const { unmount } = renderHook(() => { useSessionListStream() }, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
  const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated
  return { qc, unmount, list, invalidated, emit: (name: string, data: unknown) => { act(() => { sources[0]?.emit(name, data) }) } }
}

describe('useSessionListStream invalidation (TAL-1209)', () => {
  it('refreshes the list and the named session, leaving other sessions cached', () => {
    const { list, invalidated, emit } = mountWithCache()
    emit('sessions_changed', { type: 'sessions_changed', version: 2, reason: 'title', session_id: 'b' })
    expect(invalidated(list)).toBe(true)
    expect(invalidated(keys.sessions.detail('b'))).toBe(true)
    expect(invalidated(keys.background('b'))).toBe(true)
    expect(invalidated(keys.sessions.detail('a'))).toBe(false)
    expect(invalidated(keys.sessions.status('a'))).toBe(false)
  })

  it('refreshes only the list for an initial frame', () => {
    const { list, invalidated, emit } = mountWithCache()
    emit('initial', {})
    expect(invalidated(list)).toBe(true)
    expect(invalidated(keys.sessions.detail('a'))).toBe(false)
  })

  it('refreshes every session for an event that names none, such as a delete from another tab', () => {
    const { invalidated, emit } = mountWithCache()
    emit('sessions_changed', { type: 'sessions_changed', version: 3, reason: 'session_delete' })
    expect(invalidated(keys.sessions.detail('a'))).toBe(true)
    expect(invalidated(keys.sessions.status('a'))).toBe(true)
  })
})

describe('useSessionListStream fallback polling', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible') })

  it('does not refetch a healthy stream over five minutes', async () => {
    const { qc, list } = mountWithCache()
    const fetchList = vi.fn(() => Promise.resolve([]))
    const observer = new QueryObserver(qc, { queryKey: list, queryFn: fetchList, staleTime: Infinity })
    const unsubscribe = observer.subscribe(() => undefined)
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(fetchList).not.toHaveBeenCalled()
    unsubscribe()
  })

  it.each([0, 2])('polls a visible disconnected stream at 60 seconds (readyState=%s)', async (readyState) => {
    const { qc } = mountWithCache()
    sources[0]!.readyState = readyState
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
    expect(invalidate).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(invalidate).toHaveBeenCalledTimes(1)
    sources[0]!.readyState = 1
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('resyncs once on reconnect initial and stops polling when open', async () => {
    const { qc, emit } = mountWithCache()
    emit('initial', {})
    sources[0]!.readyState = 0
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    sources[0]!.readyState = 1
    emit('initial', {})
    expect(invalidate).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not poll a hidden tab or after unmount', async () => {
    const { qc, unmount } = mountWithCache()
    sources[0]!.readyState = 0
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(invalidate).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    unmount()
    expect(sources[0]!.close).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(invalidate).not.toHaveBeenCalled()
  })
})
