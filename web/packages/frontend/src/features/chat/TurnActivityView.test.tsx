import sceneCases from './__fixtures__/activity-scene-boundaries.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Transcript } from './Transcript'
import { AssistantMessageRow } from './MessageRow'
import { TurnActivityView } from './TurnActivityView'
import { WorklogDisclosureProvider } from './blocks/Worklog'
import { groupAssistantTurns, liveActivity, persistedActivity, type TurnActivity } from './turnActivity'
import { projectMessages } from './useTranscript'
import { initialStreamState, streamReducer } from '../../stream/reducer'
import type { Message, Session } from '../../contracts'
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
/** A settled turn as the server ships it: its scene decides the answer, the outcome and what folds. */
function settled(scene: Record<string, unknown>): TurnActivity {
  const message = { role: 'assistant', id: 'settled', content: '', _turn_id: 'turn', _anchor_activity_scene: { version: 'activity_scene_v1', terminal_state: 'completed', final_answer: '', ...scene } } as Message
  return persistedActivity(groupAssistantTurns(projectMessages([message]))[0]!)
}
const proseRow = (id: string, text: string) => ({ row_id: id, role: 'prose', text })
const toolRow = (id: string) => ({ row_id: `tool:${id}`, role: 'tool', tool: { id, name: 'read_file', preview: null, result: `Contents of ${id}`, done: true, is_error: false, duration: null, cost_usd: null } })
type SceneRows = NonNullable<Message['_anchor_activity_scene']>['activity_rows']
const rows = (...list: Record<string, unknown>[]): SceneRows => list.map((row, order_index) => ({ ...row, order_index })) as SceneRows
function completed(id: string) { return { event: 'tool_complete', data: { id, name: 'read_file', result: `Contents of ${id}` } } as const }

describe('turn worklog presentation', () => {
  it('shows live work inline without a turn-level disclosure and preserves settled choices through remount', () => {
    // A stored collapse for this turn must not hide live work.
    localStorage.setItem('hermes-worklog:v1:profile/s', JSON.stringify({ [JSON.stringify(['user:u', 'turn'])]: false }))
    const run = liveRun()
    run.emit({ event: 'reasoning', data: { text: 'Planning' } })
    run.emit({ event: 'token', data: { text: 'Reading a.' } })
    run.emit(tool('a'))
    run.emit(completed('a'))
    run.emit({ event: 'token', data: { text: 'Final answer' } })
    const view = render(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toBeNull()
    expect(view.container.textContent).not.toContain('Responding…')
    expect(view.container.querySelector('[data-tool-id="a"]')).toBeVisible()
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(0)
    run.emit({ event: 'done', data: {} })
    // Without the server's scene a finished turn stays as it streamed: the client never folds it.
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toBeNull()
    expect(view.container.querySelector('[data-tool-id="a"]')).toBeVisible()
    // The server's scene folds it.
    const scene = settled({ final_answer: 'Final answer', activity_rows: rows({ row_id: 'r', role: 'reasoning', text: 'Planning' }, proseRow('p', 'Reading a.'), toolRow('a')) })
    view.rerender(<View activity={scene} />)
    const summary = view.container.querySelector('.tool-worklog-summary')!
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(summary.textContent).toContain('Worked')
    fireEvent.click(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.querySelector('[data-final-answer]')?.closest('.activity-body')).toBeNull()
    view.unmount()
    const remount = render(<View activity={scene} />)
    expect(remount.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    remount.rerender(<View scope="other/s" activity={scene} />)
    expect(remount.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps live work flat and forms nested groups only once the turn settles', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Before tools' } })
    run.emit(tool('a')); run.emit(tool('b'))
    run.emit({ event: 'token', data: { text: 'Between batches' } })
    run.emit(tool('c'))
    const view = render(<View activity={liveActivity(run.turn)} />)
    const order = () => [...view.container.querySelectorAll('.msg-body, [data-tool-id]')].map((el) => el.getAttribute('data-tool-id') ?? el.textContent)
    expect(order()).toEqual(['Before tools', 'a', 'b', 'Between batches', 'c'])
    // While live, rows never regroup into collapsed nested groups, so nothing above the newest row changes shape.
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(0)
    for (const id of ['a', 'b', 'c']) expect(view.container.querySelector(`[data-tool-id="${id}"]`)).toBeVisible()
    run.emit({ event: 'token', data: { text: 'Done' } })
    run.emit({ event: 'done', data: {} })
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(0)
    // Groups form from the server's settled scene.
    view.rerender(<View activity={settled({ final_answer: 'Done', activity_rows: rows(proseRow('p1', 'Before tools'), toolRow('a'), toolRow('b'), proseRow('p2', 'Between batches'), toolRow('c')) })} />)
    fireEvent.click(view.container.querySelector('.tool-worklog-summary')!)
    expect(order()).toEqual(['Before tools', 'a', 'b', 'Between batches', 'c', 'Done'])
    const nested = view.container.querySelector('[data-activity-sequence-group] > button')!
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(1)
    expect(nested).toHaveAttribute('aria-expanded', 'false')
    expect(nested.textContent).not.toContain('Worked')
    fireEvent.click(nested)
    fireEvent.click(view.container.querySelector('[data-tool-id="a"] button')!)
    expect(nested).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.querySelector('[data-tool-id="b"] button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('folds normal completion, keeps errors readable, and never calls cancellation or no-answer completion Worked', () => {
    const activity = settled({ terminal_state: 'no_response', expanded_by_default: true, activity_rows: rows(toolRow('a')) })
    const view = render(<View activity={activity} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.textContent).not.toContain('Worked')
    // Settled turns take the outcome and the default disclosure from the server scene.
    view.rerender(<View activity={{ ...activity, status: 'error', expandedByDefault: true }} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
    view.rerender(<View activity={{ ...activity, status: 'cancelled', expandedByDefault: false }} />)
    expect(view.container.textContent).not.toContain('Worked')
    view.rerender(<View activity={{ ...activity, status: 'completed', finalAnswer: 'Done', expandedByDefault: false }} />)
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Done', { exact: true })).toBeVisible()
  })

  it('preserves chronological transparent mode and suppresses activity in final-only mode', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Progress' } }); run.emit(tool('a'))
    run.emit({ event: 'token', data: { text: 'Answer' } }); run.emit({ event: 'done', data: {} })
    const activity = settled({ final_answer: 'Answer', activity_rows: rows(proseRow('p', 'Progress'), toolRow('a')) })
    const view = render(<View activity={activity} mode="transparent_stream" />)
    expect(view.container.querySelector('.tool-worklog-summary')).toBeNull()
    expect([...view.container.querySelectorAll('.msg-body, [data-tool-id]')].map((el) => el.getAttribute('data-tool-id') ?? el.textContent)).toEqual(['Progress', 'a', 'Answer'])
    view.rerender(<View activity={activity} mode="hide_all_activity" />)
    expect(view.container.textContent).toBe('Answer')
  })

  it('labels a finished live turn with the server\'s terminal outcome and never splits an answer out itself', () => {
    const run = liveRun()
    run.emit({ event: 'interim_assistant', data: { text: 'Still inspecting' } })
    run.emit({ event: 'done', data: {} })
    expect(liveActivity(run.turn)).toMatchObject({ finalAnswer: '', status: 'completed', live: true })
    const limited = liveRun()
    limited.emit({ event: 'token', data: { text: 'Partial result' } })
    limited.emit({ event: 'done', data: { terminal_state: 'tool_limit_reached' } })
    expect(liveActivity(limited.turn)).toMatchObject({ finalAnswer: '', status: 'tool_limit_reached' })
    const interrupted = liveRun()
    interrupted.emit(tool('a'))
    interrupted.emit({ event: 'apperror', data: { type: 'interrupted', message: 'Connection lost' } })
    expect(liveActivity(interrupted.turn).status).toBe('interrupted')
  })

  it.each(['compact_worklog', 'transparent_stream', 'hide_all_activity'] as const)('keeps terminal outcomes visible in %s with and without work', (mode) => {
    const run = liveRun()
    run.emit(tool('a'))
    const base = liveActivity(run.turn)
    const view = render(<View activity={base} mode={mode} />)
    for (const [status, label] of [['no_response', 'No final answer'], ['tool_limit_reached', 'Tool limit reached'], ['compression_exhausted', 'Context limit reached'], ['error', 'The response failed'], ['cancelled', 'Task cancelled'], ['interrupted', 'Task interrupted']]) {
      for (const items of [base.items, []]) {
        view.rerender(<View activity={{ ...base, status: status!, items }} mode={mode} />)
        expect(screen.getByRole('status')).toHaveTextContent(label!)
      }
    }
  })

  it.each([null, 'u'])('settles tool-limit snapshots once with user identity %s', (userMessageId) => {
    const session: Session = { session_id: 's', title: 'Limited turn', _messages_offset: 40, messages: [
      { role: 'user', id: 'u', content: 'Inspect' },
      { role: 'assistant', id: 'a', content: 'Working', tool_calls: [{ id: 'a', name: 'read_file' }], _turn_id: 'run' },
      // The server persists the tool-limit outcome and ships it in the settled turn's scene.
      { role: 'assistant', id: 'closing', content: 'Tool budget exhausted; here is the saved explanation.', _turn_id: 'run', _terminal_state: 'tool_limit_reached', _anchor_activity_scene: {
        version: 'activity_scene_v1', final_answer: 'Tool budget exhausted; here is the saved explanation.', terminal_state: 'tool_limit_reached', expanded_by_default: true, activity_rows: [
          { row_id: 'a:prose', order_index: 0, role: 'prose', text: 'Working' },
          { row_id: 'tool:a', order_index: 1, role: 'tool', tool: { id: 'a', name: 'read_file', preview: null, done: true, is_error: false, duration: null, cost_usd: null } },
        ] } },
    ] }
    if (userMessageId === null) session.messages = session.messages?.map((message) => { const copy: Message = { ...message }; delete copy.id; return copy })
    const run = liveRun()
    run.emit(tool('a'))
    run.emit({ event: 'done', data: { session, terminal_state: 'tool_limit_reached' } })
    const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    try {
      const view = render(<Transcript rows={projectMessages(session.messages ?? [], 40)} live={{ ...run.turn, userMessageId }} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
      expect(view.container.querySelectorAll('.assistant-turn')).toHaveLength(1)
      expect(view.container.querySelector('.live-turn')).toBeNull()
      expect(screen.getByText('Tool budget exhausted; here is the saved explanation.')).toBeVisible()
      expect(screen.getByRole('status')).toHaveTextContent('Tool limit reached')
      view.unmount()
    } finally {
      if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
  })

  it.each(['apperror', 'cancel'] as const)('replaces the live turn with the server\'s settled turn on %s', (event) => {
    const session: Session = { session_id: 's', title: 'Failed turn', messages: [
      { role: 'user', id: 'u', content: 'Inspect' },
      { role: 'assistant', id: 'e', content: '**Error:** boom', _error: true, _turn_id: 'run', _anchor_activity_scene: {
        version: 'activity_scene_v1', final_answer: '**Error:** boom', terminal_state: 'error', expanded_by_default: true, activity_rows: rows(toolRow('a')) } },
    ] }
    const run = liveRun()
    run.emit(tool('a'))
    run.emit(event === 'apperror' ? { event, data: { type: 'error', message: 'boom', session } } : { event, data: { session } })
    const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    try {
      const view = render(<Transcript rows={projectMessages(session.messages ?? [])} live={run.turn} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
      expect(view.container.querySelector('.live-turn')).toBeNull()
      expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('status')).toHaveTextContent('The response failed')
      view.unmount()
    } finally {
      if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
  })

  it.each(['compact_worklog', 'transparent_stream', 'hide_all_activity'] as const)('preserves recovered steering boundaries in %s', (mode) => {
    const activity = persistedActivity(projectMessages([sceneCases.steering as Message])[0]!)
    const view = render(<View activity={activity} mode={mode} />)
    if (mode === 'compact_worklog') fireEvent.click(view.container.querySelector('.tool-worklog-summary')!)
    expect(view.container.querySelector('[data-activity-steering]')).toHaveTextContent('Stop after the next sleep')
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(0)
    if (mode === 'hide_all_activity') expect(view.container.querySelectorAll('[data-tool-id]')).toHaveLength(0)
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
