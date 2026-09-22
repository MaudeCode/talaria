import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AssistantMessageRow } from './MessageRow'
import { TurnActivityView } from './TurnActivityView'
import { WorklogDisclosureProvider } from './blocks/Worklog'
import { groupAssistantTurns, liveActivity, persistedActivity, type TurnActivity } from './turnActivity'
import { projectMessages } from './useTranscript'
import { initialStreamState, streamReducer } from '../../stream/reducer'
import type { ChatEvent } from '../../contracts/sse'

afterEach(() => { cleanup(); localStorage.clear() })

function liveRun() {
  let state = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'run', turnId: 'turn', userMessageId: 'u', userText: 'Inspect', now: 0 })
  let seq = 0
  return {
    emit(event: ChatEvent) { state = streamReducer(state, { type: 'event', sessionId: 's', streamId: 'run', event, lastEventId: `run:${++seq}`, now: seq }); return state.turns.s! },
    get turn() { return state.turns.s! },
  }
}

function View({ activity, mode = 'compact_worklog', scope = 'profile/s' }: { activity: TurnActivity; mode?: 'compact_worklog' | 'transparent_stream' | 'hide_all_activity'; scope?: string }) {
  return <WorklogDisclosureProvider key={scope} scope={scope}><TurnActivityView activity={activity} mode={mode} /></WorklogDisclosureProvider>
}

function tool(id: string) { return { event: 'tool', data: { id, name: 'read_file', args: { path: `${id}.txt` } } } as const }
function completed(id: string) { return { event: 'tool_complete', data: { id, name: 'read_file', result: `Contents of ${id}` } } as const }

describe('turn worklog presentation', () => {
  it('keeps live work open after the current tools finish and preserves explicit choices through settlement and remount', () => {
    const run = liveRun()
    run.emit(tool('a'))
    run.emit(completed('a'))
    const view = render(<View activity={liveActivity(run.turn)} />)
    const summary = view.container.querySelector('.tool-worklog-summary')!
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(summary.textContent).not.toContain('Worked')
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(0)
    fireEvent.click(summary)
    run.emit({ event: 'token', data: { text: 'Final answer' } })
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(summary)
    run.emit({ event: 'done', data: {} })
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(summary.textContent).toContain('Worked')
    expect(view.container.querySelector('[data-final-answer]')?.closest('.activity-body')).toBeNull()
    view.unmount()
    const remount = render(<View activity={liveActivity(run.turn)} />)
    expect(remount.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    remount.rerender(<View scope="other/s" activity={liveActivity(run.turn)} />)
    expect(remount.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'false')
  })

  it('groups consecutive support rows, preserves intervening prose, and isolates nested toggles', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Before tools' } })
    run.emit(tool('a')); run.emit(tool('b'))
    run.emit({ event: 'token', data: { text: 'Between batches' } })
    run.emit(tool('c'))
    const view = render(<View activity={liveActivity(run.turn)} />)
    expect([...view.container.querySelectorAll('.msg-body, [data-tool-id]')].map((el) => el.getAttribute('data-tool-id') ?? el.textContent)).toEqual(['Before tools', 'a', 'b', 'Between batches', 'c'])
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(1)
    const nested = view.container.querySelector('[data-activity-sequence-group] > button')!
    expect(nested).toHaveAttribute('aria-expanded', 'false')
    expect(nested.textContent).not.toContain('Worked')
    fireEvent.click(nested)
    fireEvent.click(view.container.querySelector('[data-tool-id="a"] button')!)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    expect(nested).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.querySelector('[data-tool-id="b"] button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('folds normal completion, keeps errors readable, and never calls cancellation or no-answer completion Worked', () => {
    const run = liveRun()
    run.emit(tool('a')); run.emit(completed('a'))
    run.emit({ event: 'done', data: {} })
    const activity = liveActivity(run.turn)
    const view = render(<View activity={activity} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.textContent).not.toContain('Worked')
    view.rerender(<View activity={{ ...activity, status: 'error' }} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    view.rerender(<View activity={{ ...activity, status: 'cancelled' }} />)
    expect(view.container.textContent).not.toContain('Worked')
    view.rerender(<View activity={{ ...activity, status: 'completed', finalAnswer: 'Done' }} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Done', { exact: true })).toBeVisible()
  })

  it('preserves chronological transparent mode and suppresses activity in final-only mode', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Progress' } }); run.emit(tool('a'))
    run.emit({ event: 'token', data: { text: 'Answer' } }); run.emit({ event: 'done', data: {} })
    const activity = liveActivity(run.turn)
    const view = render(<View activity={activity} mode="transparent_stream" />)
    expect(view.container.querySelector('.tool-worklog-summary')).toBeNull()
    expect([...view.container.querySelectorAll('.msg-body, [data-tool-id]')].map((el) => el.getAttribute('data-tool-id') ?? el.textContent)).toEqual(['Progress', 'a', 'Answer'])
    view.rerender(<View activity={activity} mode="hide_all_activity" />)
    expect(view.container.textContent).toBe('Answer')
  })

  it('does not promote interim-only or explicitly limited turns to successful completion', () => {
    const run = liveRun()
    run.emit({ event: 'interim_assistant', data: { text: 'Still inspecting' } })
    run.emit({ event: 'done', data: {} })
    expect(liveActivity(run.turn)).toMatchObject({ finalAnswer: '', status: 'no_response' })
    const limited = liveRun()
    limited.emit({ event: 'token', data: { text: 'Partial result' } })
    limited.emit({ event: 'done', data: { terminal_state: 'tool_limit_reached' } })
    expect(liveActivity(limited.turn)).toMatchObject({ finalAnswer: '', status: 'tool_limit_reached' })
    const interrupted = liveRun()
    interrupted.emit(tool('a'))
    interrupted.emit({ event: 'apperror', data: { type: 'interrupted', message: 'Connection lost' } })
    expect(liveActivity(interrupted.turn).status).toBe('interrupted')
  })

  it('copies a partial reply when there is no final answer', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const row = groupAssistantTurns(projectMessages([{ role: 'assistant', id: 1, content: 'Partial output', _partial: true }]))[0]!
    render(<AssistantMessageRow row={row} name="Assistant" mode="compact_worklog" actions={{}} tts={false} isLast />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith('Partial output')
  })

  it('shows prose-only answers without empty worklogs', () => {
    const row = groupAssistantTurns(projectMessages([{ role: 'assistant', id: 1, content: 'Answer' }]))[0]!
    const view = render(<View activity={persistedActivity(row)} />)
    expect(view.container.querySelector('.activity')).toBeNull()
    expect(screen.getByText('Answer')).toBeVisible()
  })
})
