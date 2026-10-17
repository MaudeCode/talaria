import { deferred, sessionFixture } from '../../test/fixtures'
import type { ReactNode } from 'react'
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
  expect(result.current.live && liveText(result.current.live)).toBe('Already visible. Unseen.')
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
