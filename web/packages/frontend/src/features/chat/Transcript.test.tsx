import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Transcript, type TranscriptProps } from './Transcript'
import { projectMessages } from './useTranscript'
import { dispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import { sessionFixture } from '../../test/fixtures'
import { requestScroll } from './sendMotion'

let intersect: IntersectionObserverCallback
const observe = vi.fn()
beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn() })
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

it.each([false, true])('preserves an upward reader scroll before its scroll event when content arrives: autoFollow=%s', async (autoFollow) => {
  const view = render(<Transcript {...props()} autoFollow={autoFollow} />)
  const pane = view.container.querySelector<HTMLElement>('#messages')
  const inner = view.container.querySelector<HTMLElement>('#msgInner')
  if (!pane || !inner) throw new Error('Missing transcript')
  Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 2600 }, clientHeight: { configurable: true, value: 600 } })
  vi.spyOn(pane, 'scrollTo').mockImplementation((options: ScrollToOptions | number) => {
    pane.scrollTop = Math.min(typeof options === 'number' ? options : options.top ?? 0, 2000)
  })
  act(() => requestScroll('end'))
  expect(pane.scrollTop).toBe(2000)
  fireEvent.wheel(pane, { deltaY: -1 })
  pane.scrollTop = 300
  // DOM insertion can precede the queued browser scroll event, as a deferred renderer reveals.
  await act(async () => { inner.append(document.createTextNode('Deferred content')); await Promise.resolve() })
  expect(pane.scrollTop).toBe(300)
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
  let resized: ResizeObserverCallback = () => undefined
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe = (element: Element) => { if (element.id === 'msgInner') resized = this.callback }
    disconnect = vi.fn(); unobserve = vi.fn()
  }
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
