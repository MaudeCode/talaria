import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Transcript } from './Transcript'
import { initialStreamState, streamReducer, type StreamAction } from '../../stream/reducer'
import type { ChatEvent } from '../../contracts/sse'
import type { ActivityMode } from './blocks/Worklog'

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }) })
afterEach(() => {
  cleanup()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

function liveRun() {
  let state = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'run', turnId: 'turn', userMessageId: 'u', userText: 'Inspect', now: 0 })
  let seq = 0
  const dispatch = (action: StreamAction) => { state = streamReducer(state, action) }
  return {
    emit(event: ChatEvent) { dispatch({ type: 'event', sessionId: 's', streamId: 'run', event, lastEventId: `run:${++seq}`, now: seq }) },
    reconnect() { dispatch({ type: 'connection', sessionId: 's', streamId: 'run', status: 'reconnecting' }) },
    get turn() { return state.turns.s! },
  }
}

function View({ run, mode = 'compact_worklog' }: { run: ReturnType<typeof liveRun>; mode?: ActivityMode }) {
  return <Transcript rows={[]} live={run.turn} assistantName="Assistant" mode={mode} renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />
}

const pills = (container: HTMLElement) => [...container.querySelectorAll('.live-run-status')]

describe('live status pill', () => {
  it('shows one labelled laurel pill outside the transcript flow before content arrives', () => {
    const run = liveRun()
    const view = render(<View run={run} />)
    const [pill, ...rest] = pills(view.container)
    expect(rest).toHaveLength(0)
    expect(pill).toHaveAttribute('role', 'status')
    // Docked over the transcript, not inside it, so it can come and go without moving any message.
    expect(pill!.closest('#msgInner')).toBeNull()
    expect(pill).toHaveTextContent('Responding…')
    const wreath = pill!.querySelector('svg.live-laurel')!
    expect(wreath).toHaveAttribute('width', '24')
    expect(wreath.querySelectorAll('.laurel-leaf')).toHaveLength(10)
  })

  it.each(['compact_worklog', 'transparent_stream', 'hide_all_activity'] as const)('keeps one pill while streaming and removes it on done in %s', (mode) => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Before tools' } })
    run.emit({ event: 'tool', data: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } })
    run.emit({ event: 'token', data: { text: 'Still generating' } })
    run.emit({ event: 'metering', data: { tps: 42.14 } })
    const view = render(<View run={run} mode={mode} />)
    expect(pills(view.container)).toHaveLength(1)
    expect(view.container.querySelector('.live-turn .live-run-status')).toBeNull()
    expect(pills(view.container)[0]).toHaveTextContent('Responding…')
    expect(pills(view.container)[0]).toHaveTextContent('42.1 tok/s')
    run.reconnect()
    view.rerender(<View run={run} mode={mode} />)
    expect(pills(view.container)).toHaveLength(1)
    expect(view.container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(pills(view.container)[0]).toHaveTextContent('Reconnecting…')
    run.emit({ event: 'done', data: {} })
    view.rerender(<View run={run} mode={mode} />)
    expect(pills(view.container)).toHaveLength(0)
  })
})
