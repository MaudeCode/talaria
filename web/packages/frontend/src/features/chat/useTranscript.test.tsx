import { deferred, sessionFixture } from '../../test/fixtures'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../../contracts/sse'
import { parseChatEvent } from '../../contracts/sse'
import { keys } from '../../api/queryKeys'
import { TRANSCRIPT_WINDOW } from '@maudecode/talaria-web-contracts'

const streams: { event: (event: ChatEvent, id: string) => void; replay: unknown; close: ReturnType<typeof vi.fn> }[] = []
vi.mock('../../api/endpoints', () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ sound_enabled: false })), fetchSession: vi.fn(), fetchStreamStatus: vi.fn() }))
vi.mock('../../api/sse', () => ({
  SSE_CLOSED: 2,
  SSE_OPEN: 1,
  openSessionStream: vi.fn(() => ({ close: vi.fn(), readyState: () => 1 })),
  openSessionListStream: vi.fn(() => ({ close: vi.fn(), readyState: () => 1 })),
  openChatStream: (_id: string, replay: unknown, cb: { onEvent: (event: ChatEvent, id: string) => void }) => {
    const close = vi.fn()
    streams.push({ event: cb.onEvent, replay, close })
    return { close, readyState: () => close.mock.calls.length ? 2 : 1 }
  },
}))
const api = await import('../../api/endpoints')
const { useTranscript } = await import('./useTranscript')
const { liveText } = await import('../../stream/reducer')
const { resetStreamStoreForTests } = await import('../../stream/store')
const { resetConnectionsForTests, configureStream, attachToStream, teardown } = await import('../../stream/connection')
const { useSessionListStream } = await import('../sessions/SessionListPanel')

it.each(['before', 'after'] as const)('keeps the terminal window without a detail fetch when the sidebar arrives %s done', async (order) => {
  const feeds = await import('../../api/sse')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const session = sessionFixture({ session_id: 'terminal', messages: [] })
  qc.setQueryData(keys.sessions.detail('terminal'), { session })
  qc.setQueryData(keys.sessions.detail('other'), { session: sessionFixture({ session_id: 'other' }) })
  qc.setQueryData(keys.sessions.list({}), { sessions: [] })
  configureStream({ queryClient: qc })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  vi.mocked(api.fetchStreamStatus).mockResolvedValue({ active: true, replay_available: true, stream_id: 'terminal-run', blocking_stream_id: null })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const { result } = renderHook(() => { useSessionListStream(); return useTranscript('terminal') }, { wrapper })
  await act(async () => { await attachToStream('terminal', 'terminal-run') })
  expect(TRANSCRIPT_WINDOW).toBe(120)
  const settled = sessionFixture({ session_id: 'terminal', messages: Array.from({ length: 120 }, (_, i) => ({ id: i, role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` })) })
  const staleRead = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  vi.mocked(api.fetchSession).mockReturnValueOnce(staleRead.promise)
  let reading!: Promise<void>
  act(() => { reading = qc.refetchQueries({ queryKey: keys.sessions.detail('terminal') }) })
  vi.mocked(api.fetchSession).mockClear()
  const sidebar = () => vi.mocked(feeds.openSessionListStream).mock.calls[0]![0].onEvent({ event: 'sessions_changed', data: { reason: 'session_done', session_id: 'terminal' } })
  await act(async () => {
    streams[0]!.event(parseChatEvent('token', JSON.stringify({ text: 'Final answer' }))!, 'terminal-run:1')
    if (order === 'before') sidebar()
    streams[0]!.event(parseChatEvent('done', JSON.stringify({ session: settled }))!, 'terminal-run:2')
    if (order === 'after') sidebar()
    streams[0]!.event(parseChatEvent('title', JSON.stringify({ title: 'Settled title' }))!, 'terminal-run:3')
    staleRead.resolve({ session })
    await reading
  })
  expect(api.fetchSession).not.toHaveBeenCalled()
  expect(result.current.session?.messages).toHaveLength(120)
  expect(result.current.session?.title).toBe('Settled title')
  expect(qc.getQueryState(keys.sessions.list({}))?.isInvalidated).toBe(true)
  expect(qc.getQueryState(keys.sessions.detail('other'))?.isInvalidated).toBe(false)
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001)
  try {
    await act(() => Promise.resolve(vi.mocked(feeds.openSessionListStream).mock.calls[0]![0].onEvent({ event: 'sessions_changed', data: { reason: 'session_done', session_id: 'terminal' } })))
    expect(api.fetchSession).toHaveBeenCalledTimes(1)
  } finally { now.mockRestore() }
  await act(async () => { await attachToStream('terminal', 'next-run'); teardown('terminal') })
  vi.mocked(api.fetchSession).mockClear()
  await act(() => Promise.resolve(sidebar()))
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
})

beforeEach(() => { vi.resetAllMocks(); streams.length = 0; resetStreamStoreForTests() })
afterEach(() => { cleanup(); resetConnectionsForTests(); focusManager.setFocused(undefined) })

function historyHook(loadOnMount = false) {
  const session = sessionFixture({ session_id: 'history', message_count: 241, messages: [{ id: 241, role: 'user', content: 'latest' }], _messages_offset: 240, _messages_truncated: true })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(keys.sessions.detail('history'), { session })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const hook = renderHook(({ sid }) => {
    const transcript = useTranscript(sid)
    const { loadOlder } = transcript
    const started = useRef(false)
    useLayoutEffect(() => {
      if (loadOnMount && !started.current) { started.current = true; void loadOlder() }
    }, [loadOlder])
    return transcript
  }, { initialProps: { sid: 'history' }, wrapper })
  return { ...hook, qc }
}

it('a terminal snapshot retires loaded and in-flight pages before admitting contiguous history', async () => {
  const page = (offset: number) => Array.from({ length: 120 }, (_, i) => ({ id: offset + i, role: 'user', content: `Message ${offset + i}` }))
  const stale = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  vi.mocked(api.fetchSession).mockResolvedValueOnce({ session: sessionFixture({ session_id: 'history', messages: page(120) }) }).mockReturnValueOnce(stale.promise)
  vi.mocked(api.fetchStreamStatus).mockResolvedValue({ active: true, replay_available: true, stream_id: 'history-run', blocking_stream_id: null })
  const { result, qc } = historyHook()
  configureStream({ queryClient: qc })
  await act(async () => { await attachToStream('history', 'history-run'); await result.current.loadOlder() })
  expect(result.current.rows[0]?.index).toBe(120)
  let loading!: Promise<void>
  act(() => { loading = result.current.loadOlder() })
  const settled = sessionFixture({ session_id: 'history', messages: page(242), _messages_offset: 242, _messages_truncated: true })
  act(() => { streams[0]!.event(parseChatEvent('done', JSON.stringify({ session: settled }))!, 'history-run:1') })
  await waitFor(() => expect(result.current.rows[0]?.index).toBe(242))
  expect(result.current.rows).toHaveLength(120)
  expect(result.current.loadingOlder).toBe(false)
  await act(async () => { stale.resolve({ session: sessionFixture({ session_id: 'history', messages: page(0) }) }); await loading })
  expect(result.current.rows[0]?.message.content).toBe('Message 242')
  vi.mocked(api.fetchSession).mockResolvedValueOnce({ session: sessionFixture({ session_id: 'history', messages: page(122) }) })
  await act(async () => { await result.current.loadOlder() })
  expect(api.fetchSession).toHaveBeenLastCalledWith('history', { messages: true, msg_limit: 120, msg_before: 242, resolve_model: false })
  expect(result.current.rows.map((row) => row.index)).toEqual(Array.from({ length: 240 }, (_, i) => i + 122))
})

it('keeps a cached entry page requested during layout when mount effects run', async () => {
  const page = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  vi.mocked(api.fetchSession).mockImplementation(() => page.promise)
  const { result } = historyHook(true)
  await act(async () => { page.resolve({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'cached entry history' }] }) }); await page.promise })
  await waitFor(() => expect(result.current.rows[0]?.message.content).toBe('cached entry history'))
  expect(result.current.loadingOlder).toBe(false)
})

it('admits only one older page before React renders the loading state', async () => {
  const page = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  vi.mocked(api.fetchSession).mockImplementation(() => page.promise)
  const { result } = historyHook()
  let first!: Promise<unknown>
  let second!: Promise<unknown>
  act(() => { first = result.current.loadOlder(); second = result.current.loadOlder() })
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
  await act(async () => { page.resolve({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'older' }] }) }); await Promise.all([first, second]) })
  expect(result.current.rows.map((r) => r.message.content)).toEqual(['older', 'latest'])
})

it('contains page failures and blocks automatic requests until explicit retry', async () => {
  vi.mocked(api.fetchSession).mockRejectedValue(new Error('synthetic failure'))
  const { result } = historyHook()
  let failure: unknown
  await act(async () => { try { await result.current.loadOlder() } catch (error) { failure = error } })
  expect(failure).toBeUndefined()
  expect(result.current).toMatchObject({ olderError: true, loadingOlder: false })
  await act(async () => { await result.current.loadOlder() })
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
  vi.mocked(api.fetchSession).mockResolvedValue({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'retried' }] }) })
  await act(async () => { await result.current.loadOlder(true) })
  expect(result.current).toMatchObject({ olderError: false, loadingOlder: false })
  expect(result.current.rows[0]?.message.content).toBe('retried')
  expect(api.fetchSession).toHaveBeenCalledTimes(2)
})

it('discards a page that finishes after the reader changes sessions', async () => {
  const page = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  vi.mocked(api.fetchSession).mockImplementation((sid) => sid === 'history' ? page.promise : Promise.resolve({ session: sessionFixture({ session_id: sid, messages: [] }) }))
  const { result, rerender } = historyHook()
  let pending!: Promise<unknown>
  act(() => { pending = result.current.loadOlder() })
  rerender({ sid: 'other' })
  await act(async () => { page.resolve({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'wrong session' }] }) }); await pending })
  await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
  expect(result.current.rows).toEqual([])
})

it('paints retained output before delayed detail/status and reconnects once on A -> B -> A', async () => {
  const session = sessionFixture({ session_id: 'a', active_stream_id: 'run-a', transcript_seq: { stream_id: 'run-a', seq: 0 }, messages: [] })
  const detail = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  const status = deferred<Awaited<ReturnType<typeof api.fetchStreamStatus>>>()
  vi.mocked(api.fetchSession).mockImplementation(() => detail.promise)
  vi.mocked(api.fetchStreamStatus).mockResolvedValue({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.sessions.detail('a'), { session })
  qc.setQueryData(keys.sessions.detail('b'), { session: { session_id: 'b', messages: [] } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ sid }) => useTranscript(sid), { initialProps: { sid: 'a' }, wrapper })
  await waitFor(() => expect(streams).toHaveLength(1))
  act(() => streams[0]!.event(parseChatEvent('token', JSON.stringify({ text: 'Already visible.' }))!, 'run-a:7'))
  await waitFor(() => expect(result.current.live && liveText(result.current.live)).toBe('Already visible.'))
  rerender({ sid: 'b' })
  expect(streams[0]!.close).toHaveBeenCalledOnce()
  await qc.invalidateQueries({ queryKey: keys.sessions.detail('a'), refetchType: 'none' })
  vi.mocked(api.fetchStreamStatus).mockImplementation(() => status.promise)
  rerender({ sid: 'a' })
  expect(result.current.live && liveText(result.current.live)).toBe('Already visible.')
  expect(streams).toHaveLength(1)
  await waitFor(() => expect(api.fetchSession).toHaveBeenCalled())
  await act(async () => { status.resolve({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null }); await Promise.resolve() })
  await waitFor(() => expect(streams).toHaveLength(2))
  expect(streams[1]!.replay).toEqual({ afterSeq: 7, afterEventId: 'run-a:7' })
  await act(async () => { detail.resolve({ session }); await Promise.resolve() })
  expect(streams).toHaveLength(2)
  act(() => {
    streams[1]!.event(parseChatEvent('token', JSON.stringify({ text: 'Already visible.' }))!, 'run-a:7')
    streams[1]!.event(parseChatEvent('token', JSON.stringify({ text: ' Unseen.' }))!, 'run-a:8')
  })
  await waitFor(() => expect(result.current.live && liveText(result.current.live)).toBe('Already visible. Unseen.'))
})


it('an accepted history cut fences an older page that was already loading', async () => {
  const prior = sessionFixture({ session_id: 'cut', messages: [{ role: 'user', id: 5, content: 'Current' }], _messages_offset: 4, _messages_truncated: true })
  const page = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
  vi.mocked(api.fetchSession).mockReturnValue(page.promise)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(keys.sessions.detail('cut'), { session: prior })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useTranscript('cut'), { wrapper })
  let loading!: Promise<void>
  act(() => { loading = result.current.loadOlder() })
  await act(async () => { await result.current.refresh(sessionFixture({ session_id: 'cut', messages: [] })) })
  expect(result.current.rows).toEqual([])
  await act(async () => { page.resolve({ session: sessionFixture({ session_id: 'cut', messages: [{ role: 'user', id: 1, content: 'Removed' }] }) }); await loading })
  expect(result.current.rows).toEqual([])
})

for (const outcome of ['resolve', 'reject'] as const) {
  it(`retiring a history page admits its replacement and ignores a late ${outcome}`, async () => {
    const oldPage = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
    const newPage = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
    vi.mocked(api.fetchSession).mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise)
    const { result } = historyHook()
    const captureOld = vi.fn()
    let oldLoad!: Promise<void>
    act(() => { oldLoad = result.current.loadOlder(false, captureOld) })
    await act(async () => { await result.current.refresh(sessionFixture({ session_id: 'history', messages: [{ id: 241, role: 'user', content: 'replacement latest' }], _messages_offset: 240, _messages_truncated: true })) })
    expect(result.current).toMatchObject({ loadingOlder: false, olderError: false })
    let newLoad!: Promise<void>
    act(() => { newLoad = result.current.loadOlder() })
    expect(api.fetchSession).toHaveBeenCalledTimes(2)
    expect(result.current.loadingOlder).toBe(true)
    await act(async () => {
      if (outcome === 'resolve') oldPage.resolve({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'obsolete' }] }) })
      else oldPage.reject(new Error('obsolete page failed'))
      await oldLoad
    })
    expect(captureOld).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ loadingOlder: true, olderError: false })
    expect(result.current.rows.map((row) => row.message.content)).toEqual(['replacement latest'])
    await act(async () => { newPage.resolve({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'replacement older' }] }) }); await newLoad })
    expect(result.current).toMatchObject({ loadingOlder: false, olderError: false })
    expect(result.current.rows.map((row) => row.message.content)).toEqual(['replacement older', 'replacement latest'])
  })
}


it('refreshes idle notice detail and retires the viewed-session feed on session and context changes', async () => {
  const feeds = await import('../../api/sse')
  const { teardownAll } = await import('../../stream/connection')
  vi.mocked(api.fetchSession).mockImplementation((sid) => Promise.resolve({ session: sessionFixture({ session_id: sid, notices: [{ key: 'plugin', level: 'info', text: 'Plugin finished', expires_at: null }] }) }))
  const { result, rerender, unmount } = historyHook()
  const open = vi.mocked(feeds.openSessionStream)
  expect(open).toHaveBeenCalledWith('history', expect.any(Object), 241)
  const first = open.mock.calls[0]![1]
  const closed = open.mock.results[0]!.value.close
  act(() => { first.onEvent({ event: 'session-updated', data: { session_id: 'history' } }) })
  await waitFor(() => { expect(result.current.session?.notices?.[0]?.text).toBe('Plugin finished') })
  rerender({ sid: 'other' })
  expect(closed).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(result.current.session?.session_id).toBe('other') })
  vi.mocked(api.fetchSession).mockClear()
  act(() => { first.onEvent({ event: 'session-updated', data: { session_id: 'history' } }) })
  expect(api.fetchSession).not.toHaveBeenCalled()
  const previous = open.mock.results.at(-1)!.value.close
  act(() => { teardownAll() })
  expect(previous).toHaveBeenCalledTimes(1)
  expect(open.mock.calls.at(-1)![0]).toBe('other')
  unmount()
  expect(open.mock.results.at(-1)!.value.close).toHaveBeenCalledTimes(1)
})


it('skips the first initial on fresh cached detail and resyncs once per reconnect', async () => {
  const feeds = await import('../../api/sse')
  vi.mocked(api.fetchSession).mockResolvedValue({ session: sessionFixture({ session_id: 'history', messages: [] }) })
  historyHook()
  const feed = vi.mocked(feeds.openSessionStream).mock.calls[0]![1]
  await act(async () => { feed.onEvent({ event: 'initial', data: { session_id: 'history' } }); await Promise.resolve() })
  expect(api.fetchSession).not.toHaveBeenCalled()
  await act(async () => { feed.onEvent({ event: 'initial', data: { session_id: 'history' } }); await Promise.resolve() })
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
})

it('does not refetch stale transcript detail on window focus with its feed open', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } })
  const key = keys.sessions.detail('focus')
  const data = { session: sessionFixture({ session_id: 'focus', messages: [] }) }
  qc.setQueryData(key, data)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  renderHook(() => useTranscript('focus'), { wrapper })
  await act(async () => {
    qc.setQueryData(key, data, { updatedAt: Date.now() - 10_000 })
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await Promise.resolve()
  })
  expect(api.fetchSession).not.toHaveBeenCalled()
  focusManager.setFocused(undefined)
})

it('aborts an in-flight transcript fetch when invalidation replaces it', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = keys.sessions.detail('abort')
  qc.setQueryData(key, { session: sessionFixture({ session_id: 'abort', messages: [] }) })
  const aborted = vi.fn()
  vi.mocked(api.fetchSession).mockImplementation((_sid, _params, signal) => {
    signal?.addEventListener('abort', aborted)
    return new Promise(() => undefined)
  })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  renderHook(() => useTranscript('abort'), { wrapper })
  act(() => { void qc.invalidateQueries({ queryKey: key }) })
  await waitFor(() => expect(api.fetchSession).toHaveBeenCalledTimes(1))
  act(() => { void qc.invalidateQueries({ queryKey: key }) })
  await waitFor(() => expect(api.fetchSession).toHaveBeenCalledTimes(2))
  expect(aborted).toHaveBeenCalledTimes(1)
})

it('fetches once for a background completion and its legacy twin, then refreshes later updates', async () => {
  const feeds = await import('../../api/sse')
  vi.mocked(api.fetchSession).mockResolvedValue({ session: sessionFixture({ session_id: 'history' }) })
  historyHook()
  const feed = vi.mocked(feeds.openSessionStream).mock.calls[0]![1]
  const data = { session_id: 'history', task_id: 'task-1', summary: 'Finished' }
  await act(() => Promise.resolve(feed.onEvent({ event: 'bg_task_complete', data })))
  await act(() => Promise.resolve(feed.onEvent({ event: 'process_complete', data })))
  expect(api.fetchSession).toHaveBeenCalledTimes(1)
  await act(() => Promise.resolve(feed.onEvent({ event: 'process_complete', data: { ...data, task_id: 'legacy-only' } })))
  expect(api.fetchSession).toHaveBeenCalledTimes(2)
  await act(() => Promise.resolve(feed.onEvent({ event: 'session-updated', data: { session_id: 'history' } })))
  expect(api.fetchSession).toHaveBeenCalledTimes(3)
})
