import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../contracts/sse'
import { parseChatEvent } from '../contracts/sse'

let readyState = 1
const opened: { streamId: string; replay: { afterSeq: number; afterEventId: string } | null; onEvent: (event: ChatEvent, lastEventId: string) => void }[] = []

vi.mock('../api/endpoints', () => ({
  fetchStreamStatus: vi.fn(() => Promise.resolve({ active: true, replay_available: true })),
}))
vi.mock('../api/sse', () => ({
  SSE_CLOSED: 2,
  openChatStream: (streamId: string, replay: { afterSeq: number; afterEventId: string } | null, cb: { onEvent: (event: ChatEvent, lastEventId: string) => void }) => {
    opened.push({ streamId, replay, onEvent: cb.onEvent })
    return { close: () => undefined, readyState: () => readyState }
  },
}))

const { attachToStream, resetConnectionsForTests, teardown } = await import('./connection')
const { onReturnToComposer, rememberOwnSteer } = await import('../features/composer/composerReturn')
const { getStreamState, resetStreamStoreForTests } = await import('./store')
const { liveText } = await import('./reducer')

const SID = 'sess-1'
const token = (text: string): ChatEvent => parseChatEvent('token', JSON.stringify({ text }))!

describe('stream attach cursor (TAL-316)', () => {
  beforeEach(() => { opened.length = 0; readyState = 1; resetStreamStoreForTests() })
  afterEach(() => { resetConnectionsForTests() })

  it('resumes a reloaded session from the detail transcript cursor for that stream', async () => {
    await attachToStream(SID, 'run-a', { stream_id: 'run-a', seq: 0 })
    expect(opened.map((o) => [o.streamId, o.replay])).toEqual([['run-a', { afterSeq: 0, afterEventId: '' }]])
  })

  it('attaches live without replay when the detail states no cursor, or a cursor for another stream', async () => {
    await attachToStream(SID, 'run-a', null)
    teardown(SID)
    await attachToStream(SID, 'run-b', { stream_id: 'run-a', seq: 7 })
    expect(opened.map((o) => [o.streamId, o.replay])).toEqual([['run-a', null], ['run-b', null]])
  })

  it('an in-page reconnect keeps its own same-stream cursor, and replayed events render once', async () => {
    await attachToStream(SID, 'run-a', { stream_id: 'run-a', seq: 0 })
    opened[0]!.onEvent(token('Hello'), 'run-a:1')
    opened[0]!.onEvent(token(' world'), 'run-a:2')
    // The first connection drops; the page reattaches to the same stream with its own cursor, not the detail's.
    readyState = 2
    await attachToStream(SID, 'run-a', { stream_id: 'run-a', seq: 0 })
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
    await attachToStream(SID, 'run-a', null, [steer('s1'), steer('s2')])
    expect(getStreamState().turns[SID]!.pendingSteers.map((p) => p.steerId)).toEqual(['s1', 's2'])
  })

  it('a Stop puts a withdrawn steer back in the composer of the tab that sent it, and nowhere else', async () => {
    await attachToStream(SID, 'run-a', null, [steer('mine'), steer('theirs')])
    const returned: string[] = []
    const stop = onReturnToComposer(SID, (text) => { returned.push(text) })
    rememberOwnSteer('mine')
    for (const id of ['mine', 'theirs', 'mine']) opened[0]!.onEvent(parseChatEvent('steer_withdrawn', JSON.stringify({ steer_id: id, reason: 'stopped', text: `${id} text` }))!, '')
    opened[0]!.onEvent(parseChatEvent('steer_withdrawn', JSON.stringify({ steer_id: null, reason: 'stopped', text: 'another surface' }))!, '')
    expect(returned).toEqual(['mine text'])
    expect(getStreamState().turns[SID]!.pendingSteers).toEqual([])
    stop()
  })
})
