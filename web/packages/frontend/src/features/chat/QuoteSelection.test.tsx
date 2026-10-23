import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Transcript, type TranscriptProps } from './Transcript'

Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges() })
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
