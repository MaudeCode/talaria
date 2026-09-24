import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LiveTurnView } from './LiveTurnView'
import { initialStreamState, streamReducer, type StreamAction } from '../../stream/reducer'
import type { ChatEvent } from '../../contracts/sse'

afterEach(cleanup)

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

function spinners(container: HTMLElement) { return [...container.querySelectorAll('.live-run-status')] }

describe('live turn spinner', () => {
  it('shows one labelled spinner before any content arrives', () => {
    const run = liveRun()
    const view = render(<LiveTurnView turn={run.turn} name="Assistant" mode="compact_worklog" userVisible />)
    const [status, ...rest] = spinners(view.container)
    expect(rest).toHaveLength(0)
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent('Responding…')
    const wreath = status!.querySelector('svg.live-laurel')!
    expect(wreath).toHaveAttribute('width', '24')
    expect(wreath.querySelectorAll('.laurel-leaf')).toHaveLength(10)
    expect(status!.querySelector('.live-run-label')).toBeVisible()
  })

  it.each(['compact_worklog', 'transparent_stream', 'hide_all_activity'] as const)('keeps one spinner after all streamed content in %s', (mode) => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Before tools' } })
    run.emit({ event: 'tool', data: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } })
    run.emit({ event: 'token', data: { text: 'Still generating' } })
    const view = render(<LiveTurnView turn={run.turn} name="Assistant" mode={mode} userVisible />)
    const all = spinners(view.container)
    expect(all).toHaveLength(1)
    const status = all[0]!
    expect(status).toHaveAttribute('role', 'status')
    expect(status.querySelector('svg.live-laurel')).not.toBeNull()
    // The label stays visible once content arrives, so the row never changes shape.
    expect(status.querySelector('.live-run-label')).toBeVisible()
    expect(status.querySelector('.live-run-label')).not.toHaveClass('sr-only')
    expect(status.querySelector('.live-run-label')).toHaveTextContent('Responding…')
    for (const node of view.container.querySelectorAll('.msg-body, [data-tool-id]')) {
      expect(node.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    run.reconnect()
    view.rerender(<LiveTurnView turn={run.turn} name="Assistant" mode={mode} userVisible />)
    expect(spinners(view.container)).toHaveLength(1)
    expect(view.container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(spinners(view.container)[0]).toHaveTextContent('Reconnecting…')
    run.emit({ event: 'done', data: {} })
    view.rerender(<LiveTurnView turn={run.turn} name="Assistant" mode={mode} userVisible />)
    expect(spinners(view.container)).toHaveLength(0)
  })
})
