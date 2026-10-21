import { deferred, sessionFixture } from '../test/fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import ownerFixture from '../../../../../contracts/fixtures/gateway-owner.json'
import { ChatStartResponseSchema } from '@maudecode/talaria-web-contracts'
import { keys } from '../api/queryKeys'
import { ApiError } from '../contracts/common'
import type { ChatEvent } from '../contracts/sse'
import { parseChatEvent } from '../contracts/sse'

let readyState = 1
const opened: { streamId: string; replay: { afterSeq: number; afterEventId: string } | null; onEvent: (event: ChatEvent, lastEventId: string) => void; onOpen: () => void; close: ReturnType<typeof vi.fn> }[] = []

vi.mock('../api/endpoints', () => ({
  fetchStreamStatus: vi.fn(() => Promise.resolve({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })),
  fetchSession: vi.fn(),
  startChat: vi.fn(),
  cancelChat: vi.fn(),
  ackBackgroundTask: vi.fn(() => Promise.resolve({})),
}))
vi.mock('../features/toast/toast', () => ({ showToast: vi.fn() }))
vi.mock('../api/sse', () => ({
  SSE_CLOSED: 2,
  openChatStream: (streamId: string, replay: { afterSeq: number; afterEventId: string } | null, cb: { onEvent: (event: ChatEvent, lastEventId: string) => void; onOpen: () => void }) => {
    const close = vi.fn()
    opened.push({ streamId, replay, onEvent: cb.onEvent, onOpen: cb.onOpen, close })
    return { close, readyState: () => close.mock.calls.length ? 2 : readyState }
  },
}))

const { attachToStream, resetConnectionsForTests, teardown, teardownAll, discardSession, configureStream, hasLiveConnection, reconcileSession, startTurn, cancelTurn, retryPendingTurn } = await import('./connection')
const { onReturnToComposer, rememberOwnSteer, returnToComposer } = await import('../features/composer/composerReturn')
const withdrawn = (steer_id: string | null, reason: string, text: string) => parseChatEvent('steer_withdrawn', JSON.stringify({ steer_id, reason, text }))!
const { getStreamState, resetStreamStoreForTests, getTurnIntent } = await import('./store')
const { beginFirstSend, bindFirstSend, getFirstSend } = await import('../features/chat/firstSend')
const { liveText } = await import('./reducer')

const api = await import('../api/endpoints')
const { showToast } = await import('../features/toast/toast')

const SID = 'sess-1'
const token = (text: string): ChatEvent => parseChatEvent('token', JSON.stringify({ text }))!

describe('stream attach cursor (TAL-316)', () => {
  it('retains the complete live turn through A -> B -> A and resumes only unseen frames (TAL-1050)', async () => {
    await attachToStream(SID, 'run-a', { transcript_seq: { stream_id: 'run-a', seq: 0 } })
    const original = opened[0]!
    original.onEvent(token('Hello'), 'run-a:1')
    original.onEvent(parseChatEvent('reasoning', JSON.stringify({ text: 'Checking.' }))!, 'run-a:2')
    original.onEvent(parseChatEvent('tool', JSON.stringify({ id: 'tool-a', name: 'read_file' }))!, 'run-a:3')
    original.onEvent(token(' world'), 'run-a:4')
    const before = getStreamState().turns[SID]!
    teardown(SID)
    expect(getStreamState().turns[SID]?.segments).toEqual(before.segments)
    expect(getStreamState().turns[SID]?.lastEventId).toBe('run-a:4')
    await attachToStream('session-b', 'run-b')
    teardown('session-b')
    await attachToStream(SID, 'run-a', { transcript_seq: { stream_id: 'run-a', seq: 0 } })
    const resumed = opened[2]!
    expect(resumed.replay).toEqual({ afterSeq: 4, afterEventId: 'run-a:4' })
    original.onEvent(token('STALE'), 'run-a:5')
    resumed.onEvent(token(' world'), 'run-a:4')
    resumed.onEvent(token('!'), 'run-a:5')
    expect(liveText(getStreamState().turns[SID]!)).toBe('Hello world!')
    expect(getStreamState().turns[SID]?.toolOrder).toEqual(['tool-a'])
    expect(getStreamState().turns[SID]?.reasoningText).toBe('Checking.')
  })

  beforeEach(() => { opened.length = 0; readyState = 1; resetStreamStoreForTests() })
  afterEach(() => { resetConnectionsForTests() })

  it('resumes a reloaded session from the detail transcript cursor for that stream', async () => {
    await attachToStream(SID, 'run-a', { transcript_seq: { stream_id: 'run-a', seq: 0 } })
    expect(opened.map((o) => [o.streamId, o.replay])).toEqual([['run-a', { afterSeq: 0, afterEventId: '' }]])
  })

  it('attaches live without replay when the detail states no cursor, or a cursor for another stream', async () => {
    await attachToStream(SID, 'run-a')
    teardown(SID)
    await attachToStream(SID, 'run-b', { transcript_seq: { stream_id: 'run-a', seq: 7 } })
    expect(opened.map((o) => [o.streamId, o.replay])).toEqual([['run-a', null], ['run-b', null]])
  })

  it('an in-page reconnect keeps its own same-stream cursor, and replayed events render once', async () => {
    await attachToStream(SID, 'run-a', { transcript_seq: { stream_id: 'run-a', seq: 0 } })
    opened[0]!.onEvent(token('Hello'), 'run-a:1')
    opened[0]!.onEvent(token(' world'), 'run-a:2')
    // The first connection drops; the page reattaches to the same stream with its own cursor, not the detail's.
    readyState = 2
    await attachToStream(SID, 'run-a', { transcript_seq: { stream_id: 'run-a', seq: 0 } })
    expect(opened[1]?.replay).toEqual({ afterSeq: 2, afterEventId: 'run-a:2' })
    // An overlapping frame the server still delivers is dropped by its sequence, never by its text.
    opened[1]!.onEvent(token(' world'), 'run-a:2')
    opened[1]!.onEvent(token('!'), 'run-a:3')
    expect(liveText(getStreamState().turns[SID]!)).toBe('Hello world!')
  })
})

describe('server pending steers on attach and Stop (TAL-425)', () => {
  beforeEach(() => { opened.length = 0; readyState = 1; resetStreamStoreForTests() })
  afterEach(() => { resetConnectionsForTests() })
  const steer = (steer_id: string) => ({ steer_id, text: steer_id, submitted_at: 1, state: 'pending' as const, actions: { edit: true, cancel: true, send_now: true } })

  it('a reloaded tab shows the run\'s pending steers from the session detail', async () => {
    await attachToStream(SID, 'run-a', { pending_steers: [steer('s1'), steer('s2')] })
    expect(getStreamState().turns[SID]!.pendingSteers.map((p) => p.steerId)).toEqual(['s1', 's2'])
  })

  it('a Stop puts a withdrawn steer back in the composer of the tab that sent it, and nowhere else', async () => {
    await attachToStream(SID, 'run-a', { pending_steers: [steer('mine'), steer('theirs')] })
    const returned: string[] = []
    const stop = onReturnToComposer(SID, (text) => { returned.push(text) })
    rememberOwnSteer('mine')
    for (const id of ['mine', 'theirs', 'mine']) opened[0]!.onEvent(parseChatEvent('steer_withdrawn', JSON.stringify({ steer_id: id, reason: 'stopped', text: `${id} text` }))!, '')
    opened[0]!.onEvent(parseChatEvent('steer_withdrawn', JSON.stringify({ steer_id: null, reason: 'stopped', text: 'another surface' }))!, '')
    expect(returned).toEqual(['mine text'])
    expect(getStreamState().turns[SID]!.pendingSteers).toEqual([])
    stop()
  })

  it('remembers this tab\'s steers across a reload, forgets them once closed, and holds text until the composer is there', async () => {
    rememberOwnSteer('kept')
    rememberOwnSteer('taken')
    // The ids live in this tab's sessionStorage, so a reloaded page still knows what it sent.
    expect(JSON.parse(sessionStorage.getItem('talaria-own-steers') ?? '[]')).toEqual(expect.arrayContaining(['kept', 'taken']))
    await attachToStream(SID, 'run-a', { pending_steers: [steer('kept'), steer('taken')] })
    opened[0]!.onEvent(parseChatEvent('steer_consumed', JSON.stringify({ steer_id: 'taken', text: 'taken' }))!, '')
    expect(JSON.parse(sessionStorage.getItem('talaria-own-steers') ?? '[]')).not.toContain('taken')
    // No composer is mounted for the session yet: the stopped text waits for it instead of being dropped.
    opened[0]!.onEvent(withdrawn('kept', 'stopped', 'kept text'), '')
    const returned: string[] = []
    const stop = onReturnToComposer(SID, (text) => { returned.push(text) })
    expect(returned).toEqual(['kept text'])
    stop()
  })
})

describe('finished background work (TAL-372)', () => {
  beforeEach(() => { opened.length = 0; readyState = 1; resetStreamStoreForTests(); vi.mocked(showToast).mockClear() })
  afterEach(() => { resetConnectionsForTests() })

  it('is the server\'s record in the background card, never a toast or a per-tab acknowledgement', async () => {
    await attachToStream(SID, 'run-a')
    opened[0]!.onEvent(parseChatEvent('bg_task_complete', JSON.stringify({ session_id: SID, task_id: 'proc_1', summary: 'Background process proc_1 completed (exit_code=2).' }))!, '')
    expect(showToast).not.toHaveBeenCalled()
    expect((api as Record<string, unknown>).ackBackgroundTask).not.toHaveBeenCalled()
  })
})



describe('navigation ownership and retention (TAL-1050)', () => {
  beforeEach(() => {
    opened.length = 0
    readyState = 1
    resetStreamStoreForTests()
    vi.mocked(api.fetchStreamStatus).mockReset().mockResolvedValue({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })
    vi.mocked(api.fetchSession).mockReset()
  })
  afterEach(() => resetConnectionsForTests())

  it('coalesces pending attaches and ignores a status response after suspension', async () => {
    const status = deferred<Awaited<ReturnType<typeof api.fetchStreamStatus>>>()
    vi.mocked(api.fetchStreamStatus).mockReturnValueOnce(status.promise)
    const first = attachToStream(SID, 'run-a')
    const second = attachToStream(SID, 'run-a')
    expect(first).toBe(second)
    teardown(SID)
    await attachToStream('b', 'run-b')
    status.resolve({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })
    await first
    expect(opened.map((entry) => entry.streamId)).toEqual(['run-b'])
    expect(getStreamState().turns[SID]).toBeUndefined()
  })

  it('a superseded attach and late open/frame cannot replace the new stream', async () => {
    await attachToStream(SID, 'run-old')
    const old = opened[0]!
    old.onEvent(token('Old text'), 'run-old:8')
    const status = deferred<Awaited<ReturnType<typeof api.fetchStreamStatus>>>()
    vi.mocked(api.fetchStreamStatus).mockReturnValueOnce(status.promise)
    readyState = 2
    const stale = attachToStream(SID, 'run-old')
    await attachToStream(SID, 'run-new', { transcript_seq: { stream_id: 'run-new', seq: 0 } })
    status.resolve({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })
    await stale
    old.onOpen()
    old.onEvent(token('STALE'), 'run-old:9')
    expect(opened).toHaveLength(2)
    expect(opened[1]!.replay).toEqual({ afterSeq: 0, afterEventId: '' })
    expect(getStreamState().turns[SID]?.streamId).toBe('run-new')
    expect(liveText(getStreamState().turns[SID]!)).toBe('')
  })

  it.each(['done', 'cancel', 'apperror'] as const)('replays a hidden %s outcome into its authoritative transcript', async (event) => {
    await attachToStream(SID, 'run-a')
    opened[0]!.onEvent(token('Partial'), 'run-a:1')
    teardown(SID)
    vi.mocked(api.fetchStreamStatus).mockResolvedValueOnce({ active: false, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })
    await attachToStream(SID, 'run-a')
    const session = { session_id: SID, messages: [{ role: 'assistant' as const, content: 'Settled' }] }
    opened[1]!.onEvent(parseChatEvent(event, JSON.stringify({ session, terminal_state: event === 'done' ? 'completed' : event === 'cancel' ? 'cancelled' : 'error', type: 'error', message: 'Failed' }))!, 'run-a:2')
    expect(getStreamState().turns[SID]?.doneSession).toEqual(session)
    teardown(SID)
    expect(getStreamState().turns[SID]).toBeUndefined()
  })

  it('converges a pruned stream on fresh detail and cannot settle or close its replacement', async () => {
    const qc = new QueryClient()
    configureStream({ queryClient: qc })
    await attachToStream(SID, 'run-a')
    opened[0]!.onEvent(token('Partial'), 'run-a:1')
    teardown(SID)
    vi.mocked(api.fetchStreamStatus).mockResolvedValueOnce({ active: false, replay_available: false, stream_id: 'run-a', blocking_stream_id: null })
    vi.mocked(api.fetchSession).mockResolvedValueOnce({ session: sessionFixture({ session_id: SID, messages: [] }) })
    await attachToStream(SID, 'run-a')
    expect(getStreamState().turns[SID]?.doneSession?.messages).toEqual([])
    expect(qc.getQueryData(keys.sessions.detail(SID))).toEqual({ session: sessionFixture({ session_id: SID, messages: [] }) })

    const detail = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
    vi.mocked(api.fetchSession).mockReturnValueOnce(detail.promise)
    vi.mocked(api.fetchStreamStatus).mockResolvedValueOnce({ active: false, replay_available: false, stream_id: 'run-a', blocking_stream_id: null })
    const stale = attachToStream(SID, 'run-a')
    await Promise.resolve()
    await attachToStream(SID, 'run-new')
    detail.resolve({ session: sessionFixture({ session_id: SID, messages: [{ role: 'assistant', content: 'STALE' }] }) })
    await stale
    expect(hasLiveConnection(SID)).toBe(true)
    expect(getStreamState().turns[SID]?.streamId).toBe('run-new')
    expect(qc.getQueryData(keys.sessions.detail(SID))).not.toEqual({ session: sessionFixture({ session_id: SID, messages: [{ role: 'assistant', content: 'STALE' }] }) })
  })

  it('a bare stream_end cannot reopen a hidden session after its detail request resolves', async () => {
    await attachToStream(SID, 'run-a')
    const detail = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
    vi.mocked(api.fetchSession).mockReturnValueOnce(detail.promise)
    opened[0]!.onEvent(parseChatEvent('stream_end', '{}')!, 'run-a:1')
    teardown(SID)
    detail.resolve({ session: sessionFixture({ session_id: SID, active_stream_id: 'run-a' }) })
    await detail.promise
    await Promise.resolve()
    expect(opened).toHaveLength(1)
    expect(hasLiveConnection(SID)).toBe(false)
  })

  it('evicts whole inactive turns oldest first; an evicted turn cold-attaches', async () => {
    for (let index = 0; index < 21; index++) {
      await attachToStream(`session-${index}`, `run-${index}`)
      opened.at(-1)!.onEvent(token('Retained'), `run-${index}:3`)
      teardown(`session-${index}`)
    }
    expect(Object.keys(getStreamState().turns)).toHaveLength(20)
    expect(getStreamState().turns['session-0']).toBeUndefined()
    await attachToStream('session-0', 'run-0', { transcript_seq: { stream_id: 'run-0', seq: 0 } })
    expect(opened.at(-1)!.replay).toEqual({ afterSeq: 0, afterEventId: '' })
    opened.at(-1)!.onEvent(token('x'.repeat(2_000_000)), 'run-0:1')
    teardown('session-0')
    expect(Object.keys(getStreamState().turns)).toHaveLength(0)
  })

  it('deletion and context reset clear retained and pending work before identical ids can be reused', async () => {
    await attachToStream(SID, 'run-a')
    opened[0]!.onEvent(token('Private'), 'run-a:9')
    teardown(SID)
    discardSession(SID)
    expect(getStreamState().turns[SID]).toBeUndefined()
    await attachToStream(SID, 'run-a')
    opened[1]!.onEvent(token('Another context'), 'run-a:9')
    teardown(SID)
    const status = deferred<Awaited<ReturnType<typeof api.fetchStreamStatus>>>()
    vi.mocked(api.fetchStreamStatus).mockReturnValueOnce(status.promise)
    const pending = attachToStream('b', 'run-b')
    teardownAll()
    status.resolve({ active: true, replay_available: true, stream_id: 'run-a', blocking_stream_id: null })
    await pending
    expect(getStreamState().turns).toEqual({})
    await attachToStream(SID, 'run-a', { transcript_seq: { stream_id: 'run-a', seq: 0 } })
    expect(opened.at(-1)!.replay).toEqual({ afterSeq: 0, afterEventId: '' })
    expect(liveText(getStreamState().turns[SID]!)).toBe('')
  })

  it('a suppressed control message keeps the existing live transport and scene', async () => {
    await attachToStream(SID, 'run-a')
    opened[0]!.onEvent(token('Working'), 'run-a:1')
    vi.mocked(api.startChat).mockResolvedValueOnce({ status: 'suppressed' })
    await startTurn({ sessionId: SID, message: '/control', request: {} })
    expect(opened[0]!.close).not.toHaveBeenCalled()
    expect(hasLiveConnection(SID)).toBe(true)
    opened[0]!.onEvent(token(' still'), 'run-a:2')
    expect(liveText(getStreamState().turns[SID]!)).toBe('Working still')
  })

  it('a delayed send response cannot reopen a session after navigation or context reset', async () => {
    const response = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValueOnce(response.promise)
    const sending = startTurn({ sessionId: SID, message: 'Go', request: {} })
    teardown(SID)
    response.resolve({ session_id: SID, stream_id: 'run-a' })
    await sending
    expect(opened).toHaveLength(0)
  })

  it('a delayed cancel acknowledgement cannot close a newer run', async () => {
    await attachToStream(SID, 'run-a')
    const response = deferred<Awaited<ReturnType<typeof api.cancelChat>>>()
    vi.mocked(api.cancelChat).mockReturnValueOnce(response.promise)
    const cancelling = cancelTurn(SID)
    await attachToStream(SID, 'run-b')
    response.resolve({ ok: true, cancelled: false })
    await cancelling
    expect(hasLiveConnection(SID)).toBe(true)
    expect(getStreamState().turns[SID]?.streamId).toBe('run-b')
  })

  it.each(['apperror', 'error'] as const)('fresh detail preserves the %s continuation link until navigation', async (event) => {
    await attachToStream(SID, 'run-a')
    const session = sessionFixture({ session_id: SID, messages: [] })
    opened[0]!.onEvent(parseChatEvent(event, JSON.stringify({ session, type: 'context_limit', message: 'Continue in another chat', continuation_session_id: 'continuation-a' }))!, 'run-a:1')
    reconcileSession(SID, session, 'run-a')
    expect(getStreamState().turns[SID]?.error?.continuationSessionId).toBe('continuation-a')
    expect(getStreamState().turns[SID]?.doneSession).toEqual(session)
    teardown(SID)
    expect(getStreamState().turns[SID]).toBeUndefined()
  })

  it('fresh detail retires only its original run when that run ended or was replaced', async () => {
    await attachToStream(SID, 'run-a')
    teardown(SID)
    reconcileSession(SID, sessionFixture({ session_id: SID, messages: [] }), 'run-a')
    expect(getStreamState().turns[SID]).toBeUndefined()
    await attachToStream(SID, 'run-b')
    reconcileSession(SID, sessionFixture({ session_id: SID, messages: [] }), 'run-a')
    expect(getStreamState().turns[SID]?.streamId).toBe('run-b')
  })
})


describe('pending admission and cancellation intent (TAL-1079)', () => {
  it('holds an HTTP admission with an explicitly unknown owner outcome', async () => {
    vi.mocked(api.startChat).mockRejectedValue(new ApiError({ kind: 'http', status: 409, path: '/api/chat/start', message: 'Owner outcome unknown', body: { outcome_unknown: true } }))
    await expect(startTurn({ sessionId: SID, message: 'Retain this work', request: { submission_id: 'retained-owner-request' } })).rejects.toThrow('Owner outcome unknown')
    expect(getTurnIntent(SID).send).toMatchObject({ uncertain: true, request: { submission_id: 'retained-owner-request' } })
    expect(retryPendingTurn(SID)).toBeUndefined()
    expect(api.startChat).toHaveBeenCalledOnce()
  })
  beforeEach(() => {
    opened.length = 0
    readyState = 1
    resetConnectionsForTests()
    resetStreamStoreForTests()
    vi.mocked(api.startChat).mockReset()
    vi.mocked(api.fetchStreamStatus).mockReset().mockResolvedValue({ active: true, stream_id: 'run-a', blocking_stream_id: 'run-a' })
    vi.mocked(api.fetchSession).mockReset().mockResolvedValue({ session: sessionFixture({ session_id: SID, messages: [] }) })
  })
  afterEach(() => { vi.useRealTimers(); resetConnectionsForTests() })

  it('deduplicates unresolved sends and does not let an old auth response settle a new identical session', async () => {
    const old = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    const fresh = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = startTurn({ sessionId: SID, message: 'Same', request: {} })
    expect(startTurn({ sessionId: SID, message: 'Same', request: {} })).toBe(first)
    expect(api.startChat).toHaveBeenCalledOnce()
    teardownAll()
    const next = startTurn({ sessionId: SID, message: 'Same', request: {} })
    old.resolve({ stream_id: 'old' })
    await first
    expect(getTurnIntent(SID).send?.text).toBe('Same')
    expect(opened).toHaveLength(0)
    fresh.resolve({ stream_id: 'new' })
    await next
    expect(opened.map((s) => s.streamId)).toEqual(['new'])
    expect(getTurnIntent(SID).send).toBeUndefined()
  })

  it.each([false, true])('settles no-stream ownership with embedded session=%s without an eager detail refresh', async (embedded) => {
    const session = sessionFixture({ session_id: SID, messages: [{ role: 'user', id: 1, content: 'First occurrence' }] })
    const detail = deferred<Awaited<ReturnType<typeof api.fetchSession>>>()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    configureStream({ queryClient: qc })
    const observer = new QueryObserver(qc, { queryKey: keys.sessions.detail(SID), queryFn: () => api.fetchSession(SID, { messages: true, msg_limit: 120 }), initialData: { session: sessionFixture({ session_id: SID, messages: [] }) }, staleTime: Infinity })
    const off = observer.subscribe(() => undefined)
    beginFirstSend('First occurrence')
    bindFirstSend(SID)
    vi.mocked(api.startChat).mockResolvedValue({ status: 'suppressed', ...(embedded ? { session } : {}) })
    vi.mocked(api.fetchSession).mockReturnValue(detail.promise)
    const sending = startTurn({ sessionId: SID, message: 'First occurrence', request: {} })
    await Promise.resolve()
    expect(api.fetchSession).toHaveBeenCalledTimes(embedded ? 0 : 1)
    if (!embedded) {
      expect(getTurnIntent(SID).send?.text).toBe('First occurrence')
      expect(getFirstSend()?.text).toBe('First occurrence')
      expect(qc.getQueryData<{ session: typeof session }>(keys.sessions.detail(SID))?.session.messages).toEqual([])
      detail.resolve({ session })
    }
    await sending
    expect(getTurnIntent(SID).send).toBeUndefined()
    expect(getFirstSend()).toBeNull()
    expect(qc.getQueryData<{ session: typeof session }>(keys.sessions.detail(SID))?.session.messages).toEqual(session.messages)
    expect(opened).toHaveLength(0)
    off()
    qc.clear()
  })

  it.each([false, true])('settles an owner voice stop without a new stream or retry, running=%s', async (running) => {
    const response = ChatStartResponseSchema.parse(ownerFixture.voice_stop_response)
    const sessionId = response.session_id!
    const qc = new QueryClient()
    configureStream({ queryClient: qc })
    if (running) {
      await attachToStream(sessionId, 'run-a')
      opened[0]!.onEvent(token('Existing answer'), 'run-a:1')
    }
    beginFirstSend('stop')
    bindFirstSend(sessionId)
    vi.mocked(api.startChat).mockResolvedValue(response)
    await startTurn({ sessionId, message: 'stop', request: { submission_id: 'voice-stop-once' } })
    expect(getTurnIntent(sessionId).send).toBeUndefined()
    expect(getFirstSend()).toBeNull()
    expect(api.startChat).toHaveBeenCalledOnce()
    expect(api.fetchSession).not.toHaveBeenCalled()
    expect(opened).toHaveLength(running ? 1 : 0)
    if (running) {
      expect(opened[0]!.close).not.toHaveBeenCalled()
      expect(liveText(getStreamState().turns[sessionId]!)).toBe('Existing answer')
    }
    expect(showToast).not.toHaveBeenCalled()
    qc.clear()
  })

  it('does not restart a turn whose terminal event arrived before its start response', async () => {
    const response = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValue(response.promise)
    const sending = startTurn({ sessionId: SID, message: 'Go', request: {} })
    await attachToStream(SID, 'run-a')
    opened[0]!.onEvent(parseChatEvent('done', JSON.stringify({ session: sessionFixture({ session_id: SID }), terminal_state: 'completed' }))!, 'run-a:2')
    response.resolve({ stream_id: 'run-a' })
    await sending
    expect(opened).toHaveLength(1)
    expect(getStreamState().turns[SID]?.status).toBe('done')
  })

  it('reconciles an uncertain transport outcome without replaying or declaring it accepted', async () => {
    vi.mocked(api.startChat).mockRejectedValue(new ApiError({ kind: 'timeout', path: '/api/chat/start', message: 'Timed out' }))
    await expect(startTurn({ sessionId: SID, message: 'Same', request: {}, recover: true })).rejects.toThrow('Timed out')
    expect(api.fetchSession).toHaveBeenCalledOnce()
    expect(getTurnIntent(SID).send).toMatchObject({ text: 'Same', uncertain: true })
    await expect(startTurn({ sessionId: SID, message: 'Same', request: {} })).rejects.toThrow('Send could not be confirmed')
    expect(api.startChat).toHaveBeenCalledOnce()
  })

  it('retries a refused resend with the exact prompt and attachment payload without another history cut', async () => {
    const request = { profile: 'default', attachments: [{ path: '/synthetic/notes.txt', filename: 'notes.txt' }] }
    vi.mocked(api.startChat).mockResolvedValueOnce({ ok: false, reason: 'Refused' }).mockResolvedValueOnce({ status: 'suppressed' })
    await expect(startTurn({ sessionId: SID, message: 'Original prompt', request, recover: true })).rejects.toThrow('Refused')
    await retryPendingTurn(SID)
    expect(api.startChat).toHaveBeenNthCalledWith(2, { session_id: SID, message: 'Original prompt', ...request })
    expect(getTurnIntent(SID).send).toBeUndefined()
  })

  it('context reset drops buffered composer returns before the same session id is reused', () => {
    returnToComposer(SID, 'Previous identity')
    teardownAll()
    const returned = vi.fn()
    const off = onReturnToComposer(SID, returned)
    expect(returned).not.toHaveBeenCalled()
    off()
  })

  it('a deleted resource cannot be repopulated by its delayed admission', async () => {
    const response = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValue(response.promise)
    const sending = startTurn({ sessionId: SID, message: 'Private', request: {}, recover: true })
    discardSession(SID)
    response.resolve({ stream_id: 'deleted-run' })
    await sending
    expect(getTurnIntent(SID).send).toBeUndefined()
    expect(opened).toHaveLength(0)
  })

  it('holds queued delivery until the server reports worker release, including across navigation', async () => {
    vi.useFakeTimers()
    await attachToStream(SID, 'run-a')
    vi.mocked(api.cancelChat).mockResolvedValue({ ok: true, cancelled: true })
    const status = deferred<Awaited<ReturnType<typeof api.fetchStreamStatus>>>()
    vi.mocked(api.fetchStreamStatus).mockReturnValueOnce(status.promise).mockResolvedValue({ active: false, stream_id: 'run-a', blocking_stream_id: null })
    const stopping = cancelTurn(SID)
    expect(cancelTurn(SID)).toBe(stopping)
    await Promise.resolve()
    opened[0]!.onEvent(parseChatEvent('cancel', '{}')!, 'run-a:2')
    teardown(SID)
    status.resolve({ active: false, stream_id: 'run-a', blocking_stream_id: 'run-a' })
    await Promise.resolve()
    expect(getTurnIntent(SID).stop).toBeDefined()
    await vi.advanceTimersByTimeAsync(500)
    await stopping
    expect(getTurnIntent(SID).stop).toBeUndefined()
    expect(api.cancelChat).toHaveBeenCalledOnce()
  })
})
