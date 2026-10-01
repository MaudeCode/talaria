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
