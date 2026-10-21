import { deferred, sessionFixture } from '../../test/fixtures'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../../contracts/sse'
import { parseChatEvent } from '../../contracts/sse'
import { keys } from '../../api/queryKeys'

const streams: { event: (event: ChatEvent, id: string) => void; replay: unknown; close: ReturnType<typeof vi.fn> }[] = []
vi.mock('../../api/endpoints', () => ({ fetchSession: vi.fn(), fetchStreamStatus: vi.fn() }))
vi.mock('../../api/sse', () => ({
  SSE_CLOSED: 2,
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
const { resetConnectionsForTests } = await import('../../stream/connection')

beforeEach(() => { vi.resetAllMocks(); streams.length = 0; resetStreamStoreForTests() })
afterEach(() => { cleanup(); resetConnectionsForTests() })

function historyHook(loadOnMount = false) {
  const session = sessionFixture({ session_id: 'history', messages: [{ id: 241, role: 'user', content: 'latest' }], _messages_offset: 240, _messages_truncated: true })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(keys.sessions.detail('history'), { session })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return renderHook(({ sid }) => {
    const transcript = useTranscript(sid)
    const { loadOlder } = transcript
    const started = useRef(false)
    useLayoutEffect(() => {
      if (loadOnMount && !started.current) { started.current = true; void loadOlder() }
    }, [loadOlder])
    return transcript
  }, { initialProps: { sid: 'history' }, wrapper })
}

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
  vi.mocked(api.fetchSession).mockImplementation(() => page.promise)
  const { result, rerender } = historyHook()
  let pending!: Promise<unknown>
  act(() => { pending = result.current.loadOlder() })
  rerender({ sid: 'other' })
  await act(async () => { page.resolve({ session: sessionFixture({ session_id: 'history', messages: [{ id: 121, role: 'user', content: 'wrong session' }] }) }); await pending })
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
