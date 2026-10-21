import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { keys } from '../../api/queryKeys'
import { useSessionListStream } from './SessionListPanel'

let sources: { emit: (name: string, data: unknown) => void }[] = []

beforeEach(() => {
  sources = []
  vi.stubGlobal('EventSource', class {
    readyState = 1
    private readonly listeners = new Map<string, (ev: Event) => void>()
    constructor() { sources.push({ emit: (name, data) => { this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) })) } }) }
    addEventListener(name: string, fn: (ev: Event) => void) { this.listeners.set(name, fn) }
    close() { /* nothing to release */ }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

function mountWithCache() {
  const qc = new QueryClient()
  const list = keys.sessions.list({})
  for (const key of [list, keys.sessions.detail('a'), keys.sessions.detail('b'), keys.sessions.status('a'), keys.background('b')]) qc.setQueryData(key, {})
  renderHook(() => { useSessionListStream() }, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
  const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated
  return { list, invalidated, emit: (name: string, data: unknown) => { act(() => { sources[0]?.emit(name, data) }) } }
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
