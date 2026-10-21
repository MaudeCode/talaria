import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Transcript, type TranscriptProps } from './Transcript'
import { projectMessages } from './useTranscript'
import { dispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import { sessionFixture } from '../../test/fixtures'
import { requestScroll } from './sendMotion'
import * as turnActivity from './turnActivity'

let intersect: IntersectionObserverCallback
let resized: ResizeObserverCallback
const observe = vi.fn()
beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  resized = () => undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe = vi.fn((element: Element) => { if (element.id === 'msgInner') resized = this.callback })
    disconnect = vi.fn(); unobserve = vi.fn()
  })
  resetStreamStoreForTests()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { intersect = callback; observe(options) }
    observe = vi.fn()
    disconnect = vi.fn()
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 })
  HTMLElement.prototype.scrollTo = vi.fn()
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks() })

const props = (): TranscriptProps => ({
  rows: projectMessages([{ id: 121, role: 'user', content: 'Current window' }]),
  live: null, assistantName: 'Assistant', mode: 'compact_worklog', renderUserMarkdown: false,
  autoFollow: false, sessionId: 'history', actions: {}, tts: false, truncated: true,
  loadedFrom: 120, onLoadOlder: vi.fn(), loadingOlder: false, emptyState: null,
  showJumpButtons: false, virtualizeLongTranscripts: false,
})

it('keeps the row filter and user scans cached across ten streamed tokens', () => {
  const input = { ...props(), truncated: false, rows: projectMessages([
    { id: 1, role: 'user', content: 'Question', _turn_id: 'turn' },
    { id: 2, role: 'assistant', content: 'Persisted reply', _turn_id: 'turn' },
    { id: 3, role: 'assistant', content: 'Earlier reply', _turn_id: 'old' },
  ]) }
  const grouped = turnActivity.groupAssistantTurns(input.rows)
  vi.spyOn(turnActivity, 'groupAssistantTurns').mockReturnValue(grouped)
  const filter = vi.spyOn(grouped, 'filter')
  dispatch({ type: 'start', sessionId: 'history', streamId: 'run', turnId: 'turn', userMessageId: '1', userText: 'Question', now: 0 })
  const view = render(<Transcript {...input} live={getStreamState().turns.history!} />)
  const scans = vi.spyOn(filter.mock.results[0]!.value as typeof grouped, 'some')
  for (let token = 1; token <= 10; token++) {
    dispatch({ type: 'event', sessionId: 'history', streamId: 'run', event: { event: 'token', data: { text: 'word ' } }, lastEventId: `run:${token}`, now: token })
    view.rerender(<Transcript {...input} live={getStreamState().turns.history!} />)
  }
  expect(filter).toHaveBeenCalledTimes(1)
  expect(scans).not.toHaveBeenCalled()
  expect(view.container.querySelector('[data-message-key="2"]')).toBeNull()
  expect(view.container.querySelector('[data-message-key="3"]')).toBeInTheDocument()
  expect(view.container.querySelector('[data-live-user]')).toBeNull()
  expect(view.container.querySelector('[data-live]')).toHaveAttribute('data-status', 'streaming')
  const live = getStreamState().turns.history!
  view.rerender(<Transcript {...input} live={{ ...live, turnId: 'old' }} />)
  expect(view.container.querySelector('[data-message-key="2"]')).toBeInTheDocument()
  expect(view.container.querySelector('[data-message-key="3"]')).toBeNull()
  view.rerender(<Transcript {...input} live={{ ...live, streamId: 'old', turnId: null }} />)
  expect(view.container.querySelector('[data-message-key="3"]')).toBeNull()
  view.rerender(<Transcript {...input} live={{ ...live, claimsPersistedRows: false }} />)
  expect(view.container.querySelector('[data-message-key="2"]')).toBeInTheDocument()
  view.rerender(<Transcript {...input} live={{ ...live, userMessageId: 'new-user' }} />)
  expect(view.container.querySelector('[data-live-user]')).toHaveTextContent('Question')
  view.rerender(<Transcript {...input} live={{ ...live, status: 'done', doneSession: sessionFixture({ session_id: 'history' }) }} />)
  expect(view.container.querySelector('[data-message-key="2"]')).toBeInTheDocument()
  expect(view.container.querySelector('[data-message-key="3"]')).toBeInTheDocument()
  expect(view.container.querySelector('[data-live]')).toBeNull()
})

function animationFrames() {
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++next, callback); return next }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
  return () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) })
}

it('streams 20 lines while following without measuring persisted rows (TAL-1203)', async () => {
  let resize: ResizeObserverCallback = () => undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn()
  })
  dispatch({ type: 'start', sessionId: 'history', streamId: 'run', turnId: null, userMessageId: null, userText: '', now: 0 })
  const input = { ...props(), autoFollow: true, truncated: false }
  const view = render(<Transcript {...input} live={getStreamState().turns.history!} />)
  const pane = view.container.querySelector<HTMLElement>('#messages')!
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 2600 })
  vi.spyOn(pane, 'scrollTo').mockImplementation(() => { pane.scrollTop = 2000 })
  act(() => requestScroll('end'))
  const row = view.container.querySelector<HTMLElement>('[data-message-key]')!
  const measure = vi.spyOn(row, 'getBoundingClientRect')
  for (let line = 1; line <= 20; line++) {
    await act(async () => {
      dispatch({ type: 'event', sessionId: 'history', streamId: 'run', event: { event: 'token', data: { text: `Line ${line}\n` } }, lastEventId: `run:${line}`, now: line })
      view.rerender(<Transcript {...input} live={getStreamState().turns.history!} />)
      await Promise.resolve()
      resize([], {} as ResizeObserver)
    })
    fireEvent.scroll(pane)
  }
  expect(measure).not.toHaveBeenCalled()
})

it('coalesces reader anchor scans into one frame while content grows and cancels on teardown (TAL-1203)', async () => {
  vi.stubGlobal('CSS', { escape: (key: string) => key })
  const flush = animationFrames()
  const view = render(<Transcript {...props()} autoFollow />)
  const pane = view.container.querySelector<HTMLElement>('#messages')!
  const inner = view.container.querySelector<HTMLElement>('#msgInner')!
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 2600 })
  vi.spyOn(pane, 'scrollTo').mockImplementation(() => { pane.scrollTop = 2000 })
  act(() => requestScroll('end'))
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect)
  const row = view.container.querySelector<HTMLElement>('[data-message-key]')!
  row.getBoundingClientRect = () => ({ top: 100, bottom: 200 } as DOMRect)
  const scan = vi.spyOn(pane, 'querySelectorAll')
  pane.scrollTop = 300
  for (let line = 0; line < 20; line++) {
    fireEvent.scroll(pane)
    await act(async () => { inner.append(document.createTextNode(`Line ${line}\n`)); await Promise.resolve() })
  }
  expect(scan).not.toHaveBeenCalled()
  flush()
  expect(scan).toHaveBeenCalledTimes(1)
  for (let event = 0; event < 20; event++) fireEvent.scroll(pane)
  expect(scan).toHaveBeenCalledTimes(1)
  flush()
  expect(scan).toHaveBeenCalledTimes(2)
  fireEvent.scroll(pane)
  view.unmount()
  flush()
  expect(scan).toHaveBeenCalledTimes(2)
})

it('captures a reader anchor when streaming starts with auto-follow off (TAL-1203)', () => {
  vi.stubGlobal('CSS', { escape: (key: string) => key })
  const flush = animationFrames()
  let resize: ResizeObserverCallback = () => undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe = (element: Element) => { if (element.id === 'msgInner') resize = this.callback }
    disconnect = vi.fn(); unobserve = vi.fn()
  })
  const input = { ...props(), truncated: false }
  const view = render(<Transcript {...input} />)
  const pane = view.container.querySelector<HTMLElement>('#messages')!
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 2600 })
  vi.spyOn(pane, 'scrollTo').mockImplementation(() => { pane.scrollTop = 2000 })
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect)
  let rowY = 100
  const row = view.container.querySelector<HTMLElement>('[data-message-key]')!
  row.getBoundingClientRect = () => ({ top: rowY, bottom: rowY + 100 } as DOMRect)
  act(() => requestScroll('end'))
  dispatch({ type: 'start', sessionId: 'history', streamId: 'run', turnId: null, userMessageId: null, userText: '', now: 0 })
  view.rerender(<Transcript {...input} live={getStreamState().turns.history!} />)
  // Streaming turns off entry settling, without the reader scrolling.
  act(() => resize([], {} as ResizeObserver))
  flush()
  rowY -= 300
  act(() => resize([], {} as ResizeObserver))
  expect(pane.scrollTop).toBe(1700)
})

it.each([
  { autoFollow: false, scrollTop: 300 },
  { autoFollow: true, scrollTop: 300 },
  { autoFollow: true, scrollTop: 2000 },
  { autoFollow: false, scrollTop: 2000 },
])('honors the reader position before queued scroll events: autoFollow=$autoFollow, scrollTop=$scrollTop', async ({ autoFollow, scrollTop }) => {
  // At the tail with follow disabled, a running turn must still preserve a reader anchor.
  const flush = animationFrames()
  const notFollowing = !autoFollow && scrollTop === 2000
  if (notFollowing) dispatch({ type: 'start', sessionId: 'history', streamId: 'run', turnId: null, userMessageId: null, userText: '', now: 0 })
  const view = render(<Transcript {...props()} autoFollow={autoFollow} live={notFollowing ? getStreamState().turns.history! : null} />)
  const pane = view.container.querySelector<HTMLElement>('#messages')
  const inner = view.container.querySelector<HTMLElement>('#msgInner')
  if (!pane || !inner) throw new Error('Missing transcript')
  Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 2600 }, clientHeight: { configurable: true, value: 600 } })
  vi.spyOn(pane, 'scrollTo').mockImplementation((options: ScrollToOptions | number) => {
    pane.scrollTop = Math.min(typeof options === 'number' ? options : options.top ?? 0, 2000)
  })
  act(() => requestScroll('end'))
  expect(pane.scrollTop).toBe(2000)
  const history = view.container.querySelector<HTMLElement>('[data-message-key="121"]')!
  const measured = vi.spyOn(history, 'getBoundingClientRect')
  if (scrollTop < 2000) fireEvent.wheel(pane, { deltaY: -1 })
  pane.scrollTop = scrollTop
  // DOM insertion can precede the queued browser scroll event, as a deferred renderer reveals.
  await act(async () => { inner.append(document.createTextNode('Deferred content')); await Promise.resolve() })
  expect(pane.scrollTop).toBe(scrollTop)
  flush()
  if (scrollTop === 2000 && autoFollow) expect(measured).not.toHaveBeenCalled()
  if (notFollowing) expect(measured).toHaveBeenCalled()
})

it('prefetches from a sentinel one viewport before the top, with no load button', () => {
  const input = props()
  const view = render(<Transcript {...input} />)
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ root: view.container.querySelector('#messages'), rootMargin: '600px 0px 0px 0px' }))
  expect(view.queryByRole('button', { name: 'Load older messages' })).toBeNull()
  act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  expect(input.onLoadOlder).toHaveBeenCalledTimes(1)
})

it('shows progress, pauses after a failure, and retries from the same slot', () => {
  const input = props()
  const view = render(<Transcript {...input} loadingOlder />)
  expect(view.getByRole('status')).toHaveTextContent('Loading...')
  expect(observe).not.toHaveBeenCalled()
  view.rerender(<Transcript {...input} olderError />)
  expect(view.getByRole('alert')).toHaveTextContent('Something went wrong')
  expect(observe).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  expect(input.onLoadOlder).toHaveBeenCalledWith(true, expect.any(Function))
})

it('stops observing when the last page arrives', () => {
  const input = props()
  const view = render(<Transcript {...input} truncated={false} />)
  expect(observe).not.toHaveBeenCalled()
  expect(view.container.querySelector('[data-history-sentinel]')).toBeNull()
})

it('keeps the prepend anchor when a duplicate observer callback is rejected', () => {
  vi.stubGlobal('CSS', { escape: (key: string) => key })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  let rowTop = 80
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.messageKey === '121' ? rowTop : 0
    return { top, bottom: top + 100, left: 0, right: 400, width: 400, height: 100, x: 0, y: top, toJSON: () => ({}) }
  })
  let capture: (() => void) | undefined
  const input = { ...props(), onLoadOlder: vi.fn((_retry?: boolean, beforePrepend?: () => void) => { capture ??= beforePrepend }) }
  const view = render(<Transcript {...input} />)
  const pane = view.container.querySelector<HTMLElement>('#messages')
  if (!pane) throw new Error('Missing transcript pane')
  pane.scrollTop = 20
  act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  act(() => capture?.())
  // The hook rejects this duplicate without committing another page.
  act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  rowTop = 380
  view.rerender(<Transcript {...input} loadedFrom={0} rows={projectMessages([{ id: 1, role: 'user', content: 'Older' }, { id: 121, role: 'user', content: 'Current window' }])} />)
  expect(pane.scrollTop).toBe(320)
  rect.mockRestore()
})

it('reader input cancels prepend and stale reader anchors at the top', () => {
  let mutated: MutationCallback = () => undefined
  vi.stubGlobal('MutationObserver', class {
    constructor(private callback: MutationCallback) {}
    observe = (element: Element) => { if (element.id === 'msgInner') mutated = this.callback }
    disconnect = vi.fn()
  })
  vi.stubGlobal('CSS', { escape: (key: string) => key })
  const flush = animationFrames()
  let oldTop = 100, olderHeight = 60
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const pane = document.getElementById('messages')!
    const top = this.dataset.messageKey === '121' ? oldTop - pane.scrollTop : this.dataset.messageKey === '1' ? 20 - pane.scrollTop : 0
    const height = this.id === 'messages' ? 600 : this.dataset.messageKey === '1' ? olderHeight : 100
    return { top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON: () => ({}) }
  })
  let capture: (() => void) | undefined
  const input = { ...props(), onLoadOlder: vi.fn((_retry?: boolean, beforePrepend?: () => void) => { capture = beforePrepend }) }
  const view = render(<Transcript {...input} />), pane = view.container.querySelector<HTMLElement>('#messages')!
  Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 2600 }, clientHeight: { configurable: true, value: 600 } })
  vi.spyOn(pane, 'scrollTo').mockImplementation((options: ScrollToOptions | number) => { pane.scrollTop = Math.min(typeof options === 'number' ? options : options.top ?? 0, 2000) })
  act(() => requestScroll('end'))
  pane.scrollTop = 20
  fireEvent.scroll(pane)
  flush()
  act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
  act(() => capture?.())
  oldTop = 80
  view.rerender(<Transcript {...input} loadedFrom={0} truncated={false} rows={projectMessages([{ id: 1, role: 'user', content: 'Older content' }, { id: 121, role: 'user', content: 'Current window' }])} />)
  expect(pane.scrollTop).toBe(0)
  // The reader stays at the start while newly revealed content acquires its full height.
  fireEvent.wheel(pane, { deltaY: -1 })
  pane.scrollTop = 0
  oldTop = 380; olderHeight = 360
  act(() => { resized([], {} as ResizeObserver); mutated([], {} as MutationObserver) })
  flush()
  expect(pane.scrollTop).toBe(0)
})

it('a terminal snapshot that beats admission replaces the pending row by server identity, including identical text', () => {
  dispatch({ type: 'start', sessionId: 's1', streamId: 'new', turnId: 'turn-new', userMessageId: '3', userText: 'Same', now: 1 })
  dispatch({ type: 'event', sessionId: 's1', streamId: 'new', event: { event: 'done', data: { session: sessionFixture({ session_id: 's1' }) } }, lastEventId: 'new:2', now: 2 })
  const props: TranscriptProps = {
    rows: [{ index: 0, key: '1', message: { role: 'user', id: 1, content: 'Same', _turn_id: 'old' } }, { index: 1, key: '3', message: { role: 'user', id: 3, content: 'Same', _turn_id: 'turn-new' } }],
    live: getStreamState().turns.s1!, assistantName: 'Hermes', mode: 'compact_worklog', renderUserMarkdown: false, autoFollow: false, sessionId: 's1', actions: {}, tts: false,
    truncated: false, loadedFrom: 0, onLoadOlder: vi.fn(), loadingOlder: false, emptyState: null, pendingUserText: 'Same', pendingPreviousStreamId: 'old', showJumpButtons: false, virtualizeLongTranscripts: false,
  }
  const view = render(<Transcript {...props} />)
  expect(screen.getAllByText('Same', { exact: true })).toHaveLength(2)
  expect(document.querySelector('[data-live-user]')).toBeNull()
  // The previous terminal turn cannot absorb another identical submission.
  view.rerender(<Transcript {...props} pendingPreviousStreamId="new" />)
  expect(screen.getAllByText('Same', { exact: true })).toHaveLength(3)
  expect(document.querySelectorAll('[data-live-user]')).toHaveLength(1)
  view.rerender(<Transcript {...props} live={null} pendingUserText="" pendingAttachments={[{ filename: 'only.txt', path: '/synthetic/only.txt' }]} />)
  expect(document.querySelector('[data-live-user]')).toHaveTextContent('only.txt')
  dispatch({ type: 'start', sessionId: 's1', streamId: 'files', turnId: 'files-turn', userMessageId: '4', userText: '', userAttachments: [{ filename: 'accepted.txt', path: '/synthetic/accepted.txt' }], now: 3 })
  view.rerender(<Transcript {...props} live={getStreamState().turns.s1!} pendingUserText={undefined} />)
  expect(document.querySelector('[data-live-user]')).toHaveTextContent('accepted.txt')
})

it('preserves the visible row offset when terminal excerpts shrink an earlier reply (TAL-1114)', () => {
  const flush = animationFrames()
  const props: TranscriptProps = {
    rows: [{ index: 0, key: 'a', message: { role: 'assistant', message_id: 'a', content: 'A'.repeat(6000), _turn_id: 'A' } },
      { index: 1, key: 'anchor', message: { role: 'user', message_id: 'anchor', content: 'Visible anchor', _turn_id: 'B' } }],
    live: null, assistantName: 'Hermes', mode: 'compact_worklog', renderUserMarkdown: false, autoFollow: true, sessionId: 's1', actions: {}, tts: false,
    truncated: false, loadedFrom: 0, onLoadOlder: vi.fn(), loadingOlder: false, emptyState: null, showJumpButtons: false, virtualizeLongTranscripts: false,
  }
  const view = render(<Transcript {...props} />), pane = view.container.querySelector<HTMLElement>('#messages')!
  Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 8000 }, clientHeight: { value: 600 } })
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect)
  let rowY = 80
  const anchor = view.container.querySelector<HTMLElement>('[data-message-key="anchor"]')!
  anchor.getBoundingClientRect = () => ({ top: rowY, bottom: rowY + 100 } as DOMRect)
  const a = view.container.querySelector<HTMLElement>('[data-message-key="a"]')!
  a.getBoundingClientRect = () => ({ top: -2000, bottom: 50 } as DOMRect)
  pane.scrollTop = 7400
  fireEvent.scroll(pane)
  pane.scrollTop = 4000
  fireEvent.scroll(pane)
  flush()
  const collapsed = { ...props.rows[0]!, message: { ...props.rows[0]!.message, _display_truncated: true, _display_excerpt: 'A'.repeat(3000) } }
  view.rerender(<Transcript {...props} rows={[collapsed, props.rows[1]!]} />)
  rowY -= 1200
  act(() => resized([], {} as ResizeObserver))
  expect(pane.scrollTop).toBe(2800)
  // A late authoritative reconciliation with identical metadata is stationary too.
  rowY = 80
  view.rerender(<Transcript {...props} rows={[{ ...collapsed }, { ...props.rows[1]! }]} />)
  act(() => resized([], {} as ResizeObserver))
  expect(pane.scrollTop).toBe(2800)
})
