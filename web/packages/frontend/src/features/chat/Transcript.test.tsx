import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Transcript, type TranscriptProps } from './Transcript'
import { dispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import { sessionFixture } from '../../test/fixtures'

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn() }
  HTMLElement.prototype.scrollTo = vi.fn()
  resetStreamStoreForTests()
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
