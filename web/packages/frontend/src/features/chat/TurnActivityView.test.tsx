import sceneCases from './__fixtures__/activity-scene-boundaries.json'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Transcript } from './Transcript'
import { AssistantMessageRow } from './MessageRow'
import { TurnActivityView } from './TurnActivityView'
import { WorklogDisclosureProvider } from './blocks/Worklog'
import { groupAssistantTurns, liveActivity, persistedActivity, type TurnActivity } from './turnActivity'
import { projectMessages } from './useTranscript'
import { initialStreamState, streamReducer, type LiveTurn } from '../../stream/reducer'
import type { Message, Session } from '../../contracts'
import type { ChatEvent } from '../../contracts/sse'
import { MessageSchema } from '../../contracts/session'

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

/** Live frames as the server ships them: its kind and redacted target ride along with the args. */
function tool(id: string) { return { event: 'tool', data: { id, name: 'read_file', kind: 'read', target: `${id}.txt`, args: { path: `${id}.txt` } } } as const }
/** A settled turn as the server ships it: its scene decides the answer, the outcome and what folds. */
function settled(scene: Record<string, unknown>): TurnActivity {
  const message = { role: 'assistant', id: 'settled', content: '', _turn_id: 'turn', _anchor_activity_scene: { version: 'activity_scene_v1', terminal_state: 'completed', final_answer: '', ...scene } } as Message
  return persistedActivity(groupAssistantTurns(projectMessages([message]))[0]!)
}
const proseRow = (id: string, text: string) => ({ row_id: id, role: 'prose', text })
const toolRow = (id: string) => ({ row_id: `tool:${id}`, role: 'tool', tool: { id, name: 'read_file', kind: 'read', target: `${id}.txt`, preview: null, result: `Contents of ${id}`, done: true, is_error: false, duration: null, cost_usd: null } })
type SceneRows = NonNullable<Message['_anchor_activity_scene']>['activity_rows']
const rows = (...list: Record<string, unknown>[]): SceneRows => list.map((row, order_index) => ({ ...row, order_index })) as SceneRows
function completed(id: string) { return { event: 'tool_complete', data: { id, name: 'read_file', kind: 'read', target: `${id}.txt`, result: `Contents of ${id}` } } as const }

describe('turn worklog presentation', () => {
  it('labels a tool from the server kind and target, never from its name or args', () => {
    const run = liveRun()
    run.emit({ event: 'tool', data: { id: 'x', name: 'merge_pull_request', kind: 'shell', target: 'git status', args: { command: 'rm -rf /', path: 'secret.txt' } } })
    run.emit({ event: 'tool', data: { id: 'y', name: 'read_file', args: { path: 'a.txt' } } })
    const view = render(<View activity={liveActivity(run.turn)} />)
    const x = view.container.querySelector('[data-tool-id="x"]')!
    expect(x).toHaveAttribute('data-tool-kind', 'shell')
    expect(x.querySelector('.tool-card-name')).toHaveTextContent('Running git status')
    // An older server sends neither field: the card is an unknown tool with no target, not a client guess.
    const y = view.container.querySelector('[data-tool-id="y"]')!
    expect(y).toHaveAttribute('data-tool-kind', 'unknown')
    expect(y.querySelector('.tool-card-name')).not.toHaveTextContent('a.txt')
  })

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

  it('hides inline thinking and tool-call XML in live tokens, and renders a settled turn\'s fields as shipped (TAL-302)', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: '<think>Still planning' } })
    let view = render(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelector('.msg-body')).toBeNull()
    expect(view.container.textContent).not.toContain('<think>')
    run.emit({ event: 'token', data: { text: '</think>Answer <function_calls><invoke' } })
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelector('.msg-body')).toHaveTextContent(/^Answer$/)
    view.unmount()
    // A settled answer that talks about these tags keeps them: the server already split the row.
    view = render(<View activity={settled({ final_answer: 'Use `<think>` and `<function_calls>` tags.', activity_rows: rows({ row_id: 'r', role: 'reasoning', text: 'About <tool_call> tags' }) })} />)
    expect(view.container.querySelector('[data-final-answer]')).toHaveTextContent('Use <think> and <function_calls> tags.')
    fireEvent.click(view.container.querySelector('.tool-worklog-summary')!)
    fireEvent.click(view.container.querySelector('.thinking-card-header')!)
    expect(view.container.querySelector('.thinking-card-body')).toHaveTextContent('About <tool_call> tags')
  })

  it('expands and collapses every tool row in the turn, nested groups included (TAL-615)', () => {
    const view = render(<View activity={settled({ final_answer: 'Done', activity_rows: rows(toolRow('a'), toolRow('b'), proseRow('p', 'Between'), toolRow('c')) })} />)
    fireEvent.click(view.container.querySelector('.tool-worklog-summary')!)
    const headers = () => [...view.container.querySelectorAll('.tool-card-header')].map((header) => header.getAttribute('aria-expanded'))
    const group = () => view.container.querySelector('[data-activity-sequence-group] > button')!
    expect(headers()).toEqual(['false', 'false', 'false'])
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(headers()).toEqual(['true', 'true', 'true'])
    expect(group()).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.querySelector('[data-tool-id="a"] .tool-card-detail')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(headers()).toEqual(['false', 'false', 'false'])
    expect(group()).toHaveAttribute('aria-expanded', 'false')
    // The turn's own disclosure stays open: the control only reaches the rows inside it.
    expect(view.container.querySelector('.tool-worklog-summary')).toHaveAttribute('aria-expanded', 'true')
  })

  it('expands every row of a worklog longer than the stored-choice cap (TAL-615)', () => {
    const ids = Array.from({ length: 205 }, (_, i) => `t${i}`)
    const view = render(<View activity={settled({ final_answer: 'Done', activity_rows: rows(...ids.map(toolRow)) })} />)
    fireEvent.click(view.container.querySelector('.tool-worklog-summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    const headers = () => [...view.container.querySelectorAll('.tool-card-header')].map((header) => header.getAttribute('aria-expanded'))
    expect(headers().filter((expanded) => expanded !== 'true')).toEqual([])
    // A row chosen after the bulk action keeps that choice.
    fireEvent.click(view.container.querySelector('[data-tool-id="t0"] .tool-card-header')!)
    expect(view.container.querySelector('[data-tool-id="t0"] .tool-card-header')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(headers().filter((expanded) => expanded !== 'false')).toEqual([])
  })

  it('groups consecutive live reasoning and tools until prose while leaving a singleton inline', () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Before tools' } })
    run.emit(tool('a'))
    run.emit({ event: 'token', data: { text: 'Between batches' } })
    run.emit({ event: 'reasoning', data: { text: 'Planning the second batch' } })
    run.emit(tool('b')); run.emit(tool('c'))
    const view = render(<View activity={liveActivity(run.turn)} />)
    const group = view.container.querySelector('[data-activity-sequence-group]')!
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(1)
    expect(group).toHaveAttribute('data-live-activity-current', '1')
    expect(group.querySelector(':scope > button')).toHaveAttribute('aria-expanded', 'false')
    expect(group.querySelector(':scope > button')).toHaveTextContent('Reading c.txt')
    expect(group.querySelector('[data-tool-id="b"]')).not.toBeVisible()
    expect(group.querySelector('[data-tool-id="c"]')).not.toBeVisible()
    expect(view.container.querySelector('[data-tool-id="a"]')).toBeVisible()
    expect(view.container.querySelector('[data-tool-id="a"]')?.closest('[data-activity-sequence-group]')).toBeNull()
    run.emit(completed('c'))
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelector('[data-activity-sequence-group] > button')).toHaveTextContent('Read c.txt')
    run.emit({ event: 'token', data: { text: 'Done' } })
    run.emit({ event: 'done', data: {} })
    view.rerender(<View activity={liveActivity(run.turn)} />)
    expect(view.container.querySelectorAll('[data-activity-sequence-group]')).toHaveLength(1)
    expect(view.container.querySelector('[data-activity-sequence-group]')).not.toHaveAttribute('data-live-activity-current')
    expect(view.container.querySelector('[data-activity-sequence-group] > button')).toBeVisible()
    expect(view.container.querySelector('[data-tool-id="a"]')).toBeVisible()
    expect(view.container.textContent).not.toContain('Worked')
    // The server's settled scene retains the same grouping and adds the outer Worklog.
    view.rerender(<View activity={settled({ final_answer: 'Done', activity_rows: rows(proseRow('p1', 'Before tools'), toolRow('a'), proseRow('p2', 'Between batches'), { row_id: 'r', role: 'reasoning', text: 'Planning the second batch' }, toolRow('b'), toolRow('c')) })} />)
    fireEvent.click(view.container.querySelector('.tool-worklog-summary')!)
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
    run.emit({ event: 'done', data: { terminal_state: 'completed' } })
    expect(liveActivity(run.turn)).toMatchObject({ finalAnswer: '', status: 'completed', live: true })
    const limited = liveRun()
    limited.emit({ event: 'token', data: { text: 'Partial result' } })
    limited.emit({ event: 'done', data: { terminal_state: 'tool_limit_reached' } })
    expect(liveActivity(limited.turn)).toMatchObject({ finalAnswer: '', status: 'tool_limit_reached' })
    const interrupted = liveRun()
    interrupted.emit(tool('a'))
    interrupted.emit({ event: 'apperror', data: { type: 'interrupted', terminal_state: 'interrupted', message: 'Connection lost' } })
    expect(liveActivity(interrupted.turn).status).toBe('interrupted')
  })

  it.each(['compact_worklog', 'transparent_stream', 'hide_all_activity'] as const)('keeps terminal outcomes visible in %s with and without work', (mode) => {
    const run = liveRun()
    run.emit(tool('a'))
    const base = liveActivity(run.turn)
    const view = render(<View activity={base} mode={mode} />)
    for (const [status, label] of [['no_response', 'No final answer'], ['tool_limit_reached', 'Tool limit reached'], ['compression_exhausted', 'Context limit reached'], ['error', 'The response failed'], ['cancelled', 'Stopped'], ['interrupted', 'Task interrupted']]) {
      for (const items of [base.items, []]) {
        view.rerender(<View activity={{ ...base, status: status!, items }} mode={mode} />)
        expect(screen.getByRole('status')).toHaveTextContent(label!)
      }
    }
  })

  it.each([null, 'u'])('settles tool-limit snapshots once with user identity %s', (userMessageId) => {
    const session: Session = { session_id: 's', title: 'Limited turn', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0, _messages_offset: 40, messages: [
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
      const view = render(<Transcript rows={projectMessages(session.messages ?? [], 40)} live={{ ...run.turn, userMessageId }} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
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
    const session: Session = { session_id: 's', title: 'Failed turn', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0, messages: [
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
      const view = render(<Transcript rows={projectMessages(session.messages ?? [])} live={run.turn} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />)
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

  it('keeps a consumed steer visible as a user message between Worked phases after the turn settles', () => {
    const steering = { row_id: 'steering:s1', role: 'steering', text: 'Check b too', steering: { steer_id: 's1', consumed: true, submitted_at: 1, consumed_at: 2 } }
    const view = render(<View activity={settled({ activity_rows: rows(toolRow('a'), steering, toolRow('b')), final_answer: 'Done.' })} />)
    const steer = screen.getByText(/Check b too/)
    expect(steer).toBeVisible()
    expect(steer.closest('[data-role="user"]')).not.toBeNull()
    expect(view.container.querySelectorAll('.tool-worklog-summary')).toHaveLength(2)
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

describe('a running turn with no journal to replay (TAL-374)', () => {
  const example = { messages: MessageSchema.array().parse((JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { running_scene_session: { messages: unknown } }).running_scene_session.messages) }
  const streamId = 'contract-run-r'
  /** A live turn attached without replay: it streams only what follows the rows the server persisted. */
  function attached() {
    let state = streamReducer(initialStreamState, { type: 'attach', sessionId: 's', streamId, now: 0, replay: false })
    let seq = 0
    return {
      emit(event: ChatEvent) { state = streamReducer(state, { type: 'event', sessionId: 's', streamId, event, lastEventId: `${streamId}:${String(++seq)}`, now: seq }) },
      get turn() { return state.turns.s! },
    }
  }
  const transcript = (messages: Message[], live: LiveTurn | null) => <Transcript rows={projectMessages(messages)} live={live} assistantName="Assistant" mode="compact_worklog" renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />
  /** Each assistant turn's blocks in document order: reasoning, tool cards and prose. */
  const blocks = (container: HTMLElement) => [...container.querySelectorAll('.assistant-turn')].map((turn) => [...turn.querySelectorAll('.thinking-card, [data-tool-id], .msg-body')].map((el) => (el.matches('.thinking-card') ? 'reasoning' : el.matches('[data-tool-id]') ? `tool:${el.getAttribute('data-tool-id') ?? ''}` : (el.textContent ?? '').trim())))
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }) })
  afterEach(() => {
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  })

  it('shows every persisted row open with no Worked disclosure or outcome, continues it with live rows, and settles to the completed scene once', () => {
    const run = attached()
    const view = render(transcript(example.messages, run.turn))
    const [, running] = view.container.querySelectorAll('.assistant-turn')
    expect(blocks(view.container).slice(0, 2)).toEqual([['Earlier answer.'], ['reasoning', 'Reading a.txt.', 'tool:contract-read', 'Now b.txt.']])
    expect(running!.querySelector('.tool-worklog-summary')).toBeNull()
    expect(running!.querySelector('[role="status"]')).toBeNull()
    expect(running!.querySelector('[data-final-answer]')).toBeNull()

    // Live frames append after the persisted rows; neither replaces the other.
    run.emit({ event: 'token', data: { text: 'Reading b.txt.' } })
    run.emit(tool('b'))
    view.rerender(transcript(example.messages, run.turn))
    expect(blocks(view.container)).toEqual([['Earlier answer.'], ['reasoning', 'Reading a.txt.', 'tool:contract-read', 'Now b.txt.'], ['Reading b.txt.', 'tool:b']])

    // The settled scene replaces both, once.
    const settledMessages = example.messages.map((message) => {
      const scene = message._anchor_activity_scene
      if (scene?.terminal_state !== 'running') return message
      return { ...message, _anchor_activity_scene: { ...scene, terminal_state: 'completed', final_answer: 'Both read.', expanded_by_default: false, activity_rows: rows(...scene.activity_rows, proseRow('b:prose', 'Reading b.txt.'), toolRow('b')) } }
    })
    const session: Session = { session_id: 's', title: 'Running', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0, messages: settledMessages }
    run.emit({ event: 'done', data: { session } })
    view.rerender(transcript(settledMessages, run.turn))
    expect(view.container.querySelector('.live-turn')).toBeNull()
    expect(blocks(view.container)).toEqual([['Earlier answer.'], ['reasoning', 'Reading a.txt.', 'tool:contract-read', 'Now b.txt.', 'Reading b.txt.', 'tool:b', 'Both read.']])
    expect(view.container.querySelectorAll('.tool-worklog-summary')).toHaveLength(1)
  })

  it('updates a running scene\'s tool in place from its live completion instead of adding a second card', () => {
    // The call persisted before its result: the scene shows the tool still running.
    const messages = example.messages.map((message) => {
      const scene = message._anchor_activity_scene
      if (scene?.terminal_state !== 'running') return message
      return { ...message, _anchor_activity_scene: { ...scene, activity_rows: scene.activity_rows.map((row) => (row.tool ? { ...row, tool: { ...row.tool, done: false, result: null } } : row)) } }
    })
    const run = attached()
    const view = render(transcript(messages, run.turn))
    const card = () => view.container.querySelectorAll('[data-tool-id="contract-read"]')
    expect(card()).toHaveLength(1)
    run.emit({ event: 'tool_complete', data: { id: 'contract-read', name: 'read_file', kind: 'read', target: 'a.txt', result_view: { text: 'A' } } })
    run.emit({ event: 'token', data: { text: 'Reading b.txt.' } })
    view.rerender(transcript(messages, run.turn))
    expect(blocks(view.container)).toEqual([['Earlier answer.'], ['reasoning', 'Reading a.txt.', 'tool:contract-read', 'Now b.txt.'], ['Reading b.txt.']])
    expect(card()).toHaveLength(1)
    expect(card()[0]).toHaveAttribute('data-tool-done', '1')
  })

  it('marks only the newest row active: the persisted tail until live frames arrive, then the live tail', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Go', _turn_id: streamId },
      { role: 'assistant', id: 'r1', content: 'Looking.', _turn_id: streamId, _anchor_activity_scene: { version: 'activity_scene_v1', terminal_state: 'running', final_answer: '', expanded_by_default: true, activity_rows: rows(proseRow('r1:prose', 'Looking.'), { row_id: 'r1:reasoning', role: 'reasoning', text: 'Still planning', titles: [] }) } },
    ]
    const run = attached()
    const view = render(transcript(messages, run.turn))
    const active = () => [...view.container.querySelectorAll('[data-reasoning-active]')].map((el) => (el.closest('.live-turn') ? 'live' : 'persisted'))
    expect(active()).toEqual(['persisted'])
    run.emit({ event: 'reasoning', data: { text: 'Comparing' } })
    view.rerender(transcript(messages, run.turn))
    expect(active()).toEqual(['live'])
  })
})
