import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Transcript } from './Transcript'
import { LiveStatusPill } from './LiveTurnView'
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
    dispatch,
    reconnect() { dispatch({ type: 'connection', sessionId: 's', streamId: 'run', status: 'reconnecting' }) },
    get turn() { return state.turns.s! },
  }
}

function View({ run, mode = 'compact_worklog' }: { run: ReturnType<typeof liveRun>; mode?: ActivityMode }) {
  return <Transcript rows={[]} live={run.turn} assistantName="Assistant" mode={mode} renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />
}

const pills = (container: HTMLElement) => [...container.querySelectorAll('.live-run-status')]

describe('live status', () => {
  it("stays out of the transcript: the composer's top tab carries it (TAL-429)", () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Still generating' } })
    const view = render(<View run={run} />)
    expect(pills(view.container)).toHaveLength(0)
  })

  it('labels the run with the laurel, the rate, and the reconnect state', () => {
    const run = liveRun()
    run.emit({ event: 'metering', data: { tps: 42.14 } })
    const view = render(<LiveStatusPill turn={run.turn} />)
    const [pill, ...rest] = pills(view.container)
    expect(rest).toHaveLength(0)
    expect(pill).toHaveAttribute('role', 'status')
    expect(pill).toHaveTextContent('Responding…')
    expect(pill).toHaveTextContent('42.1 tok/s')
    expect(pill!.querySelectorAll('svg.live-laurel .laurel-leaf')).toHaveLength(10)
    run.reconnect()
    view.rerender(<LiveStatusPill turn={run.turn} />)
    expect(pills(view.container)[0]).toHaveTextContent('Reconnecting…')
  })
})

describe('live steering', () => {
  it('shows a sent steer as a pending user message until the Agent takes it', () => {
    const run = liveRun()
    run.emit({ event: 'tool', data: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } })
    run.dispatch({ type: 'steer', sessionId: 's', steerId: 's1', text: 'Check b too', status: 'sending' })
    const view = render(<View run={run} />)
    const pending = view.getByText('Check b too').closest('[data-role="user"]')
    expect(pending).toHaveTextContent('Steering hint · Sending')
    run.dispatch({ type: 'steer', sessionId: 's', steerId: 's1', text: 'Check b too', status: 'waiting' })
    view.rerender(<View run={run} />)
    expect(view.getByText('Check b too').closest('[data-role="user"]')).toHaveTextContent('Steering hint · Waiting for agent')
    run.emit({ event: 'steer_consumed', data: { steer_id: 's1', text: 'Check b too', after_tool_call_id: null } })
    view.rerender(<View run={run} />)
    expect(view.getAllByText('Check b too')).toHaveLength(1)
    expect(view.getByText('Check b too').closest('[data-role="user"]')).not.toHaveTextContent('Waiting')
  })

  it('renders a consumed steer as a user message where the agent took it', () => {
    const run = liveRun()
    run.emit({ event: 'tool', data: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } })
    run.emit({ event: 'tool_complete', data: { id: 'a', name: 'read_file' } })
    run.emit({ event: 'steer_consumed', data: { steer_id: 's1', text: 'Check b too', after_tool_call_id: 'a' } })
    run.emit({ event: 'token', data: { text: 'Checking b.' } })
    const view = render(<View run={run} />)
    const steer = view.getByText(/Check b too/)
    expect(steer.closest('[data-role="user"]')).not.toBeNull()
    expect(steer.compareDocumentPosition(view.getByText('Checking b.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
