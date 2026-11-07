import { afterEach, expect, it, vi } from 'vitest'
import { openGroupStream, openKanbanEventStream, openSessionListStream, openSessionStream, SSE_CLOSED, type SseHandle } from './sse'

vi.unmock('./sse')

afterEach(() => vi.unstubAllGlobals())

it('sends the cached persisted count, including zero, without inventing a missing count', () => {
  const urls: URL[] = []
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor(url: string) { super(); urls.push(new URL(url)) }
    close = vi.fn()
  })
  const cb = { onEvent: vi.fn() }
  openSessionStream('windowed', cb, 241).close()
  openSessionStream('empty', cb, 0).close()
  openSessionStream('uncached', cb).close()
  expect(urls.map((url) => url.searchParams.get('known_count'))).toEqual(['241', '0', null])
})

/** What a browser does when a response ends cleanly: it reports `error`, stays connecting, and reopens by itself. */
class RotatingSource extends EventTarget {
  static last: RotatingSource
  readyState = 1
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { super(); RotatingSource.last = this }
  close() { this.closed = true; this.readyState = 2 }
  rotate() { this.readyState = 0; this.onerror?.(); this.readyState = 1; this.onopen?.() }
  frame(name: string, data: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })) }
}

const emptyGroup = { available: false, reason: null, room: null, rows: [], paused: [], cursor: 0, has_more: false, next_before_seq: null }

it.each<{ feed: string; open: (onFrame: () => void) => SseHandle; name: string; data: unknown }>([
  { feed: 'session channel', open: (onEvent) => openSessionStream('s', { onEvent }), name: 'session-updated', data: { session_id: 's' } },
  { feed: 'merged sidebar', open: (onEvent) => openSessionListStream({ onEvent }), name: 'initial', data: {} },
  { feed: 'groups', open: (onView) => openGroupStream('room', onView), name: 'snapshot', data: emptyGroup },
  { feed: 'kanban', open: (onEvents) => openKanbanEventStream(undefined, 0, onEvents), name: 'events', data: { events: [{ id: 1 }] } },
])('the $feed feed keeps its source through a clean server end and delivers the next frame', ({ open, name, data }) => {
  vi.stubGlobal('EventSource', RotatingSource)
  const onFrame = vi.fn()
  const handle = open(onFrame)
  const source = RotatingSource.last
  source.rotate()
  expect(source.closed).toBe(false)
  expect(handle.readyState()).not.toBe(SSE_CLOSED)
  source.frame(name, data)
  expect(onFrame).toHaveBeenCalledOnce()
  handle.close()
})
