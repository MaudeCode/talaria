import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { keys } from '../../api/queryKeys'
import { invalidateSessionQueries } from '../../api/sessionQueries'
import { teardownAll } from '../../stream/connection'
import { useSessionListStream } from './useSessionListStream'

let sources: { url: string; readyState: number; close: () => void; emit: (name: string, data: unknown) => void }[] = []

beforeEach(() => {
  sources = []
  vi.stubGlobal('EventSource', class {
    readyState = 1
    private readonly listeners = new Map<string, (ev: Event) => void>()
    constructor(readonly url: string) { sources.push(this) }
    emit(name: string, data: unknown) { this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) })) }
    addEventListener(name: string, fn: (ev: Event) => void) { this.listeners.set(name, fn) }
    close = vi.fn(() => { this.readyState = 2 })
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** The stream opens once this browser's push endpoint is read. */
async function mountWithCache() {
  const qc = new QueryClient()
  const list = keys.sessions.list({})
  for (const key of [list, keys.sessions.detail('a'), keys.sessions.detail('b'), keys.sessions.status('a'), keys.background('b'), keys.decisionReviews]) qc.setQueryData(key, {})
  const { unmount } = renderHook(() => { useSessionListStream() }, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
  await act(async () => { await Promise.resolve() })
  const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated
  return { qc, unmount, list, invalidated, emit: (name: string, data: unknown) => { act(() => { sources[0]?.emit(name, data) }) } }
}

describe('useSessionListStream invalidation (TAL-1209)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  /** The sidebar rows follow the paced list refresh (TAL-2261). */
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(300) })

  it('refreshes the list and the named session, leaving other sessions cached', async () => {
    const { list, invalidated, emit } = await mountWithCache()
    emit('sessions_changed', { type: 'sessions_changed', version: 2, reason: 'title', session_id: 'b' })
    expect(invalidated(keys.sessions.detail('b'))).toBe(true)
    expect(invalidated(keys.background('b'))).toBe(true)
    expect(invalidated(keys.sessions.detail('a'))).toBe(false)
    expect(invalidated(keys.sessions.status('a'))).toBe(false)
    await settle()
    expect(invalidated(list)).toBe(true)
  })

  it('refreshes only the list for an initial frame', async () => {
    const { list, invalidated, emit } = await mountWithCache()
    emit('initial', {})
    await settle()
    expect(invalidated(list)).toBe(true)
    expect(invalidated(keys.sessions.detail('a'))).toBe(false)
  })

  it('refreshes the Decisions list when a review opens or closes, and only then (TAL-1966)', async () => {
    const { invalidated, emit } = await mountWithCache()
    emit('sessions_changed', { type: 'sessions_changed', version: 2, reason: 'title', session_id: 'b' })
    expect(invalidated(keys.decisionReviews)).toBe(false)
    emit('sessions_changed', { type: 'sessions_changed', version: 3, reason: 'decision_review', session_id: 'b' })
    expect(invalidated(keys.decisionReviews)).toBe(true)
  })

  it('refreshes every session for an event that names none, such as a delete from another tab', async () => {
    const { list, invalidated, emit } = await mountWithCache()
    emit('sessions_changed', { type: 'sessions_changed', version: 3, reason: 'session_delete' })
    expect(invalidated(keys.sessions.detail('a'))).toBe(true)
    expect(invalidated(keys.sessions.status('a'))).toBe(true)
    await settle()
    expect(invalidated(list)).toBe(true)
  })
})

describe('useSessionListStream list refresh cadence (TAL-2261)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  const changed = (version: number) => ({ type: 'sessions_changed', version, reason: 'title', session_id: 'b' })
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  /** A mounted sidebar list whose reads take `latency` ms; `reads()` counts list query-function runs. */
  async function mountList(latency = 0) {
    const mounted = await mountWithCache()
    let reads = 0
    const observer = new QueryObserver(mounted.qc, { queryKey: mounted.list, staleTime: Infinity, queryFn: () => new Promise<number>((resolve) => { const n = ++reads; setTimeout(() => { resolve(n) }, latency) }) })
    const stop = observer.subscribe(() => undefined)
    return { ...mounted, stop, reads: () => reads }
  }

  it('reads the list once per burst and at most once per 5 seconds, then once more for the last event', async () => {
    const { reads, emit } = await mountList()
    emit('sessions_changed', changed(1))
    await advance(299)
    expect(reads()).toBe(0)
    await advance(1)
    expect(reads()).toBe(1)
    for (let version = 2; version <= 20; version++) { emit('sessions_changed', changed(version)); await advance(250) }
    expect(reads()).toBe(1)
    vi.setSystemTime(0) // a wall-clock step back cannot hold the trailing read
    await advance(550)
    expect(reads()).toBe(2)
    await advance(60_000)
    expect(reads()).toBe(2)
  })

  it('lets a slow list read finish, then reads once for the events it missed', async () => {
    const { qc, list, reads, emit } = await mountList(8_000)
    emit('sessions_changed', changed(1))
    await advance(300)
    for (let version = 2; version <= 30; version++) { emit('sessions_changed', changed(version)); await advance(250) }
    expect(reads()).toBe(1)
    await advance(750)
    expect(qc.getQueryData(list)).toBe(1)
    expect(reads()).toBe(2)
  })

  it('refreshes at once for a direct mutation and for the named session while the list waits', async () => {
    const { qc, reads, emit, invalidated } = await mountList()
    emit('sessions_changed', changed(1))
    expect(invalidated(keys.sessions.detail('b'))).toBe(true)
    expect(reads()).toBe(0)
    act(() => { void invalidateSessionQueries(qc) })
    await advance(0)
    expect(reads()).toBe(1)
  })

  it.each([
    ['unmount', (m: { unmount: () => void }) => { m.unmount() }],
    ['a profile or server change', () => { teardownAll() }],
  ])('drops a pending list refresh on %s', async (_, end) => {
    const mounted = await mountList()
    mounted.emit('sessions_changed', changed(1))
    act(() => { end(mounted) })
    await advance(10_000)
    expect(mounted.reads()).toBe(0)
  })
})

describe('useSessionListStream fallback polling', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible') })

  it.each([0, 2])('polls a visible disconnected stream at 60 seconds (readyState=%s)', async (readyState) => {
    const { qc } = await mountWithCache()
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

  it('does not poll a hidden tab or after unmount', async () => {
    const { qc, unmount } = await mountWithCache()
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

describe('useSessionListStream completion notifications (TAL-2157)', () => {
  const notification = { title: 'Release', body: 'Shipped it', url: '/session/a', tag: 'a' }
  const completion = { identity: 'run-1', scope: 'scope', profile: 'default', eligible: true, expires_at: Date.now() + 60_000, notification }
  let shown: { title: string; options: NotificationOptions; onclick: (() => void) | null }[]
  const showNotification = vi.fn()
  let subscription: { endpoint: string } | null
  let active: object | null

  beforeEach(() => {
    shown = []
    subscription = null
    active = {}
    showNotification.mockReset()
    vi.stubGlobal('Notification', class {
      static permission = 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options: NotificationOptions) { shown.push(this as unknown as typeof shown[number]); Object.assign(this, { title, options }) }
      close = vi.fn()
    })
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => Promise.resolve({ active, showNotification, pushManager: { getSubscription: () => Promise.resolve(subscription) } }) } })
  })
  afterEach(() => { Reflect.deleteProperty(navigator, 'serviceWorker') })

  async function finish(visibility: DocumentVisibilityState, enabled = true, sent: object = completion) {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility)
    const qc = new QueryClient()
    qc.setQueryData(keys.settings, { notifications_enabled: enabled, sound_enabled: false })
    renderHook(() => { useSessionListStream() }, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      sources.at(-1)?.emit('sessions_changed', { type: 'sessions_changed', version: 2, reason: 'web_completion', session_id: 'a', web_audio: [sent] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('shows one notification tagged with the chat through the service worker only while the tab is hidden and the setting is on', async () => {
    await finish('visible')
    await finish('hidden', false)
    expect(showNotification).not.toHaveBeenCalled()
    await finish('hidden')
    expect(showNotification).toHaveBeenCalledExactlyOnceWith('Release', { body: 'Shipped it', tag: 'a', data: { url: '/session/a' } })
  })

  it('names this browser\'s push endpoint on the stream and leaves a completion to Web Push only when the server says it delivers it (TAL-2478)', async () => {
    subscription = { endpoint: 'https://push.example/1' }
    await finish('hidden', true, { ...completion, push_delivers: true })
    expect(new URL(sources.at(-1)!.url, window.location.href).searchParams.get('push_endpoint')).toBe('https://push.example/1')
    expect(showNotification).not.toHaveBeenCalled()
    await finish('hidden', true, { ...completion, push_delivers: false })
    expect(showNotification).toHaveBeenCalledOnce()
  })

  it('falls back to a page notification without an active worker; clicking it focuses the tab on the chat', async () => {
    active = null
    const assign = vi.fn()
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    await finish('hidden')
    expect(shown).toHaveLength(1)
    vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, assign })
    shown[0]!.onclick?.()
    expect(focus).toHaveBeenCalled()
    expect(assign).toHaveBeenCalledExactlyOnceWith(new URL('session/a', window.location.href).href)
  })
})
