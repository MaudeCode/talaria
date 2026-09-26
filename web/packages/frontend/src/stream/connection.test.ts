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
