import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Transcript } from './Transcript'
import { projectMessages } from './useTranscript'
import { initialStreamState, streamReducer, type LiveTurn } from '../../stream/reducer'
import type { Message, Session } from '../../contracts'
import { speak } from '../voice/tts'

vi.mock(import('../voice/tts'), async (importOriginal) => ({ ...(await importOriginal()), speak: vi.fn(() => Promise.resolve()) }))

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }) })
afterEach(() => {
  cleanup()
  vi.mocked(speak).mockClear()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

const question: Message = { role: 'user', id: 1, content: 'Inspect', _turn_id: 'run' }
const answer: Message = { role: 'assistant', id: 2, content: 'All files checked.', _turn_id: 'run' }

function turns() {
  const running = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'run', turnId: 'run', userMessageId: '1', userText: 'Inspect', now: 0 }).turns.s!
  const session = { session_id: 's', messages: [question, answer] } as Session
  const done = streamReducer({ turns: { s: running } }, { type: 'event', sessionId: 's', streamId: 'run', event: { event: 'done', data: { session } }, lastEventId: 'run:1', now: 1 }).turns.s!
  return { running, done }
}

function View({ messages, live, autoRead }: { messages: Message[]; live: LiveTurn; autoRead: boolean }) {
  return <Transcript rows={projectMessages(messages)} live={live} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} autoRead={autoRead} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />
}

describe('auto-read (TAL-568)', () => {
  it('speaks the reply once the server persists the turn this view watched', () => {
    const { running, done } = turns()
    const view = render(<View messages={[question]} live={running} autoRead />)
    expect(speak).not.toHaveBeenCalled()
    view.rerender(<View messages={[question, answer]} live={done} autoRead />)
    expect(speak).toHaveBeenCalledExactlyOnceWith('All files checked.')
    view.rerender(<View messages={[question, { ...answer }]} live={done} autoRead />)
    expect(speak).toHaveBeenCalledOnce()
  })

  it('stays quiet when auto-read is off or the turn finished before the view saw it run', () => {
    const { running, done } = turns()
    const off = render(<View messages={[question]} live={running} autoRead={false} />)
    off.rerender(<View messages={[question, answer]} live={done} autoRead={false} />)
    cleanup()
    render(<View messages={[question, answer]} live={done} autoRead />)
    expect(speak).not.toHaveBeenCalled()
  })
})
