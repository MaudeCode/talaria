import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Transcript, type TranscriptProps } from './Transcript'
import { projectMessages } from './useTranscript'
import { dispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import { sessionFixture } from '../../test/fixtures'

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
