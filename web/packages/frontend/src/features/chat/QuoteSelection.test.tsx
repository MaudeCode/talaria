import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Transcript, type TranscriptProps } from './Transcript'
import { preloadMarkdownRenderer } from './render/Markdown'

Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })

// jsdom lays nothing out: each test states the selection's end line, the pane and the action's size.
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
let selectionEnd = box(0, 0, 0, 0)
let pane = box(0, 0, 0, 0)
Range.prototype.getClientRects = function () { return [selectionEnd] as unknown as DOMRectList }
Range.prototype.getBoundingClientRect = function () { return selectionEnd }
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals(); selectionEnd = box(0, 0, 0, 0) })
function layOut(view: { container: HTMLElement }) {
  vi.spyOn(view.container.querySelector<HTMLElement>('#messages')!, 'getBoundingClientRect').mockImplementation(() => pane)
  vi.spyOn(HTMLButtonElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLButtonElement.prototype, 'offsetHeight', 'get').mockReturnValue(44)
}
// The client entry preloads the renderer before any history arrives; a transcript holds its rows until then (TAL-2410).
beforeAll(() => preloadMarkdownRenderer())
const props = (sessionId = 's1', onQuoteSelection = vi.fn()): TranscriptProps => ({
  rows: [{ key: 'u1', index: 0, message: { role: 'user', content: 'Displayed café 🦜\nsecond line' } }],
  sessionId, actions: { onQuoteSelection }, live: null, assistantName: 'Assistant', mode: 'compact_worklog',
  renderUserMarkdown: false, autoFollow: false, tts: false, truncated: false, loadedFrom: 0,
  onLoadOlder: vi.fn(), loadingOlder: false, emptyState: null, showJumpButtons: false, virtualizeLongTranscripts: false,
})
function select(node: Node) {
  act(() => {
    const range = document.createRange()
    range.selectNodeContents(node)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

it('offers one accessible quote action for displayed transcript selection without replacing native selection', () => {
  const p = props()
  const view = render(<Transcript {...p} />)
  select(view.container.querySelector('.msg-body')!)
  const action = screen.getByRole('button', { name: 'Quote selection' })
  fireEvent.pointerDown(action)
  expect(window.getSelection()?.toString()).toBe('Displayed café 🦜\nsecond line')
  fireEvent.click(action)
  expect(p.actions.onQuoteSelection).toHaveBeenCalledWith('Displayed café 🦜\nsecond line')
})

it('discards an action crossing a chat switch and a detached selection', () => {
  const p = props()
  const view = render(<Transcript {...p} />)
  select(view.container.querySelector('.msg-body')!)
  const action = screen.getByRole('button', { name: 'Quote selection' })
  const next = props('s2')
  view.rerender(<Transcript {...next} />)
  fireEvent.click(action)
  expect(p.actions.onQuoteSelection).not.toHaveBeenCalled()
  expect(next.actions.onQuoteSelection).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
})

it('does not quote toolbar text, empty selections or selections outside this transcript', () => {
  const view = render(<><Transcript {...props()} /><p>Outside</p></>)
  select(screen.getByText('Outside'))
  expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
  select(view.container.querySelector('.msg-foot')!)
  expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
})

it('drops a range whose displayed text was removed before the action', () => {
  const p = props()
  const view = render(<Transcript {...p} />)
  const body = view.container.querySelector('.msg-body')!
  select(body)
  const action = screen.getByRole('button', { name: 'Quote selection' })
  body.replaceChildren(document.createTextNode('Replaced'))
  fireEvent.click(action)
  expect(p.actions.onQuoteSelection).not.toHaveBeenCalled()
})

it('hides the action when the selection exceeds its bound or collapses', () => {
  const p = props()
  p.rows[0]!.message.content = 'x'.repeat(16_001)
  const view = render(<Transcript {...p} />)
  select(view.container.querySelector('.msg-body')!)
  expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
  act(() => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
})

it('places the action under the end of the selection, inside the visible pane', () => {
  const view = render(<Transcript {...props()} />)
  layOut(view)
  pane = box(0, 0, 800, 600)
  selectionEnd = box(100, 200, 300, 220)
  select(view.container.querySelector('.msg-body')!)
  const action = screen.getByRole('button', { name: 'Quote selection' })
  expect([action.style.left, action.style.top]).toEqual(['250px', '228px'])
  // Near the bottom-right corner it flips above the line and stays clear of the pane's edge.
  selectionEnd = box(700, 560, 790, 580)
  select(view.container.querySelector('.msg-body')!)
  expect([action.style.left, action.style.top]).toEqual(['692px', '508px'])
})

it('follows the selection as the transcript scrolls and hides once it leaves the pane', () => {
  const view = render(<Transcript {...props()} />)
  layOut(view)
  pane = box(0, 0, 800, 600)
  selectionEnd = box(100, 200, 300, 220)
  select(view.container.querySelector('.msg-body')!)
  const scroller = view.container.querySelector('#messages')!
  selectionEnd = box(100, 100, 300, 120)
  fireEvent.scroll(scroller)
  expect(screen.getByRole('button', { name: 'Quote selection' }).style.top).toBe('128px')
  selectionEnd = box(100, -60, 300, -40)
  fireEvent.scroll(scroller)
  expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
})

it('re-places the action when the transcript pane resizes without a window resize', () => {
  let resized: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe = vi.fn(); disconnect = vi.fn() })
  const view = render(<Transcript {...props()} />)
  layOut(view)
  pane = box(0, 0, 800, 600)
  selectionEnd = box(100, 200, 300, 220)
  select(view.container.querySelector('.msg-body')!)
  // A dragged side panel narrows the pane and rewraps the selection.
  pane = box(0, 0, 500, 600)
  selectionEnd = box(100, 240, 480, 260)
  act(() => resized!())
  expect(screen.getByRole('button', { name: 'Quote selection' }).style.left).toBe('392px')
})
