import { deferred, sessionFixture } from '../test/fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { keys } from '../api/queryKeys'
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

const { attachToStream, resetConnectionsForTests, teardown, teardownAll, discardSession, configureStream, hasLiveConnection, reconcileSession, startTurn, cancelTurn } = await import('./connection')
const { onReturnToComposer, rememberOwnSteer } = await import('../features/composer/composerReturn')
const withdrawn = (steer_id: string | null, reason: string, text: string) => parseChatEvent('steer_withdrawn', JSON.stringify({ steer_id, reason, text }))!
const { getStreamState, resetStreamStoreForTests } = await import('./store')
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
