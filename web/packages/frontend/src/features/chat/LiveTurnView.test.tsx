import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Transcript } from './Transcript'
import { LiveStatusPill, LiveTurnView } from './LiveTurnView'
import * as activityProjection from './turnActivity'
import { dispatch as storeDispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import type { StreamAction } from '../../stream/reducer'
import type { ChatEvent } from '../../contracts/sse'
import type { ActivityMode } from './blocks/Worklog'
import * as api from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { onReturnToComposer } from '../composer/composerReturn'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), withdrawSteer: vi.fn(), sendSteerNow: vi.fn() }))
vi.mock(import('../toast/toast'), async (importOriginal) => ({ ...(await importOriginal()), showToast: vi.fn() }))

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => { resetStreamStoreForTests(); Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }) })
afterEach(() => {
  cleanup()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

function liveRun() {
  storeDispatch({ type: 'start', sessionId: 's', streamId: 'run', turnId: 'turn', userMessageId: 'u', userText: 'Inspect', now: 0 })
  let seq = 0
  const dispatch = (action: StreamAction) => { act(() => { storeDispatch(action); if (vi.isFakeTimers()) vi.advanceTimersByTime(16) }) }
  return {
    emit(event: ChatEvent) { dispatch({ type: 'event', sessionId: 's', streamId: 'run', event, lastEventId: `run:${++seq}`, now: seq }) },
    dispatch,
    reconnect() { dispatch({ type: 'connection', sessionId: 's', streamId: 'run', status: 'reconnecting' }) },
    get turn() { return getStreamState().turns.s! },
  }
}

function View({ run, mode = 'compact_worklog' }: { run: ReturnType<typeof liveRun>; mode?: ActivityMode }) {
  return <Transcript rows={[]} live={run.turn} assistantName="Assistant" mode={mode} renderUserMarkdown={false} autoFollow={false} sessionId="s" actions={{}} tts={false} truncated={false} loadedFrom={0} onLoadOlder={() => undefined} loadingOlder={false} emptyState={null} showJumpButtons={false} virtualizeLongTranscripts={false} />
}

it('measures live height at segment and status boundaries rather than each token (TAL-1203)', () => {
  const run = liveRun()
  run.emit({ event: 'token', data: { text: 'First line' } })
  const view = render(<LiveTurnView turn={run.turn} name="Assistant" mode="compact_worklog" userVisible />)
  const row = view.container.querySelector<HTMLElement>('.live-turn')!
  const measure = vi.spyOn(row, 'getBoundingClientRect')
  for (let line = 0; line < 20; line++) {
    run.emit({ event: 'token', data: { text: `Line ${line}\n` } })
    view.rerender(<LiveTurnView turn={run.turn} name="Assistant" mode="compact_worklog" userVisible />)
  }
  expect(measure).not.toHaveBeenCalled()
  run.emit({ event: 'tool', data: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } })
  view.rerender(<LiveTurnView turn={run.turn} name="Assistant" mode="compact_worklog" userVisible />)
  expect(measure).toHaveBeenCalledTimes(1)
  run.emit({ event: 'done', data: {} })
  view.rerender(<LiveTurnView turn={run.turn} name="Assistant" mode="compact_worklog" userVisible />)
  expect(measure).toHaveBeenCalledTimes(2)
  measure.mockRestore()
})

const pills = (container: HTMLElement) => [...container.querySelectorAll('.live-run-status')]

describe('live activity memoization', () => {
  it('reuses activity on metadata renders and updates every projection input', async () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Answer' } })
    const project = vi.spyOn(activityProjection, 'liveActivity')
    try {
      const draw = (omitToolIds?: ReadonlySet<string>) => <LiveTurnView turn={run.turn} name="Assistant" mode="transparent_stream" userVisible omitToolIds={omitToolIds} />
      const view = render(draw())
      expect(project).toHaveBeenCalledTimes(1)
      run.emit({ event: 'warning', data: { message: 'Notice' } })
      view.rerender(draw())
      expect(view.getByRole('status')).toHaveTextContent('Notice')
      expect(project).toHaveBeenCalledTimes(1)
      run.emit({ event: 'server_turn_started', data: { turn_id: 'assigned' } })
      view.rerender(draw())
      expect(project).toHaveLastReturnedWith(expect.objectContaining({ key: 'assigned' }))
      run.emit({ event: 'token', data: { text: ' updated' } })
      view.rerender(draw())
      expect(await view.findByText('Answer updated')).toBeInTheDocument()
      run.emit({ event: 'tool', data: { id: 'call', name: 'read_file', kind: 'read', target: 'sample.txt' } })
      view.rerender(draw())
      expect(view.container.querySelector('[data-tool-id="call"]')).not.toBeNull()
      const omitted = new Set(['call'])
      view.rerender(draw(omitted))
      expect(view.container.querySelector('[data-tool-id="call"]')).toBeNull()
      run.emit({ event: 'tool_complete', data: { id: 'call', name: 'read_file' } })
      view.rerender(draw(omitted))
      expect(project).toHaveBeenCalledTimes(6)
      run.emit({ event: 'done', data: { terminal_state: 'tool_limit_reached' } })
      view.rerender(draw(omitted))
      expect(project).toHaveLastReturnedWith(expect.objectContaining({ status: 'tool_limit_reached' }))
    } finally { project.mockRestore() }
  })
})

describe('live status', () => {
  it("stays out of the transcript: the composer's top tab carries it (TAL-429)", () => {
    const run = liveRun()
    run.emit({ event: 'token', data: { text: 'Still generating' } })
    const view = render(<View run={run} />)
    expect(pills(view.container)).toHaveLength(0)
  })

  it('labels the run with the laurel, the rate, and the reconnect state', async () => {
    const run = liveRun()
    run.emit({ event: 'metering', data: { tps: 42.14 } })
    const view = render(<LiveStatusPill sessionId={run.turn.sessionId} />)
    const [pill, ...rest] = pills(view.container)
    expect(rest).toHaveLength(0)
    expect(pill).toHaveAttribute('role', 'status')
    expect(pill).toHaveTextContent('Working')
    await waitFor(() => expect(pill).toHaveTextContent('42.1 tok/s'))
    expect(pill!.querySelectorAll('svg.live-laurel .laurel-leaf')).toHaveLength(10)
    run.reconnect()
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    expect(pills(view.container)[0]).toHaveTextContent('Reconnecting…')
  })
})

describe('server-selected prompt reading (TAL-1058)', () => {
  it('renders known and unknown progress in the existing accessible status, and clears terminal state', async () => {
    const run = liveRun()
    const view = render(<LiveStatusPill sessionId={run.turn.sessionId} />)
    for (const progress_percent of [0, 42, 100, null]) {
      run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'prompt_reading', progress_percent } } })
      view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
      await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(progress_percent === null ? /^Reading prompt$/ : `Reading prompt · ${progress_percent}%`))
      expect(view.container.querySelectorAll('.live-laurel')).toHaveLength(1)
    }
    run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'compressing' } } })
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(/^Compressing context$/))
    run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'working' } } })
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('Working'))
    run.emit({ event: 'done', data: {} })
    expect(run.turn.runStatus).toBeNull()
    run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'prompt_reading', progress_percent: 42 } } })
    expect(run.turn.runStatus).toBeNull()
  })

  it('keeps newer server progress when a retained stream resumes from a cached session snapshot', async () => {
    const run = liveRun()
    run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'prompt_reading', progress_percent: 42 } } })
    const cursor = run.turn.lastEventId
    run.dispatch({ type: 'attach', sessionId: 's', streamId: 'run', now: 2, replay: true, serverRunStatus: { phase: 'prompt_reading', progress_percent: 0 } })
    run.dispatch({ type: 'connection', sessionId: 's', streamId: 'run', status: 'open' })
    const view = render(<LiveStatusPill sessionId={run.turn.sessionId} />)
    expect(view.getByRole('status')).toHaveTextContent('Reading prompt · 42%')
    expect(run.turn.lastEventId).toBe(cursor)
    run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'working' } } })
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('Working'))
  })

  it('attaches current server status without replay and replaces stale status, including explicit null', () => {
    const run = liveRun()
    run.dispatch({ type: 'attach', sessionId: 's', streamId: 'run', now: 1, replay: false, serverRunStatus: { phase: 'prompt_reading', progress_percent: 42 } })
    expect(run.turn.runStatus).toEqual({ phase: 'prompt_reading', progress_percent: 42 })
    run.dispatch({ type: 'attach', sessionId: 's', streamId: 'run', now: 2, replay: false, serverRunStatus: null })
    expect(run.turn.runStatus).toBeNull()
    run.emit({ event: 'run_status', data: { session_id: 's', status: { phase: 'prompt_reading', progress_percent: 42 } } })
    run.dispatch({ type: 'attach', sessionId: 's', streamId: 'replacement', now: 3, replay: false })
    expect(run.turn.runStatus).toBeNull()
  })
})

describe('rate-limit wait (TAL-821)', () => {
  afterEach(() => { vi.useRealTimers() })

  it("shows the server's provider and reset time in place of Working, until the server clears it", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 14, 10, 0).getTime() })
    const run = liveRun()
    const until = new Date(2026, 9, 14, 10, 17).getTime() / 1000
    run.emit({ event: 'rate_limit_wait', data: { session_id: 's', wait: { provider: 'openrouter', provider_label: 'OpenRouter', until, until_kind: 'reset' } } })
    const view = render(<LiveStatusPill sessionId={run.turn.sessionId} />)
    expect(pills(view.container)[0]).toHaveTextContent(/^OpenRouter rate limit until 10:17\sAM$/)
    run.emit({ event: 'rate_limit_wait', data: { session_id: 's', wait: { provider: null, provider_label: null, until, until_kind: 'reset' } } })
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    expect(pills(view.container)[0]).toHaveTextContent(/^Rate limited until 10:17\sAM$/)
    // No reset from the provider: the time is the Agent's next retry.
    run.emit({ event: 'rate_limit_wait', data: { session_id: 's', wait: { provider: 'openrouter', provider_label: 'OpenRouter', until, until_kind: 'retry' } } })
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    expect(pills(view.container)[0]).toHaveTextContent(/^OpenRouter rate limit · retry at 10:17\sAM$/)
    run.emit({ event: 'rate_limit_wait', data: { session_id: 's', wait: null } })
    view.rerender(<LiveStatusPill sessionId={run.turn.sessionId} />)
    expect(pills(view.container)[0]).toHaveTextContent(/^Working \d/)
  })
})

describe('live elapsed time (TAL-922)', () => {
  afterEach(() => { vi.useRealTimers() })
  const at = (startedAt: number, reconnecting = false) => {
    act(() => {
      storeDispatch({ type: 'start', sessionId: 's', streamId: 'run', turnId: null, userMessageId: null, userText: '', now: startedAt })
      if (reconnecting) storeDispatch({ type: 'connection', sessionId: 's', streamId: 'run', status: 'reconnecting' })
    })
    return 's'
  }

  it('reads "Working <elapsed>" from the turn start and ticks each second', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const view = render(<LiveStatusPill sessionId={at(1_000_000 - 59_000)} />)
    expect(pills(view.container)[0]).toHaveTextContent('Working 59s')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(pills(view.container)[0]).toHaveTextContent('Working 1m')
  })

  it("formats seconds, minutes, and hours in T3 Code's units", () => {
    vi.useFakeTimers({ now: 10_000_000 })
    const label = (ms: number) => { const v = render(<LiveStatusPill sessionId={at(10_000_000 - ms)} />); const t = pills(v.container)[0]!.textContent; v.unmount(); return t }
    expect(label(1_000)).toMatch(/Working 1s$/)
    expect(label(359_000)).toMatch(/Working 5m$/)
    expect(label(3_600_000)).toMatch(/Working 1h 0m$/)
    expect(label(5_400_000)).toMatch(/Working 1h 30m$/)
  })

  it('shows no time while reconnecting or on background work', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const view = render(<LiveStatusPill sessionId={at(0, true)} />)
    expect(pills(view.container)[0]).toHaveTextContent(/^Reconnecting…$/)
    view.rerender(<LiveStatusPill sessionId={at(0)} background />)
    expect(pills(view.container)[0]).toHaveTextContent(/^Working on background results$/)
  })
})

describe('live steering', () => {
  const pending = (steer_id: string, actions = { edit: true, cancel: true, send_now: true }) => ({ event: 'steer_pending' as const, data: { steer_id, text: 'Check b too', submitted_at: 1, state: 'pending' as const, actions } })

  it('shows the server\'s pending steer as a dashed user bubble until the Agent takes it (TAL-425)', () => {
    const run = liveRun()
    run.emit({ event: 'tool', data: { id: 'a', name: 'read_file', args: { path: 'a.txt' } } })
    run.dispatch({ type: 'steer_sending', sessionId: 's', steerId: 's1', text: 'Check b too' })
    const view = render(<View run={run} />)
    expect(view.getByText('Check b too').closest('[data-role="user"]')).toHaveTextContent('Steering hint · Sending')
    expect(view.queryByRole('button', { name: 'Send now' })).toBeNull()
    run.emit(pending('s1'))
    view.rerender(<View run={run} />)
    const bubble = view.getByText('Check b too').closest('[data-role="user"]')!
    expect(bubble).toHaveTextContent('Steering hint · Waiting for agent')
    expect(bubble).toHaveAttribute('data-steer-state', 'pending')
    for (const name of ['Send now', 'Edit steering message', 'Cancel steering message']) expect(view.getByRole('button', { name })).toBeInTheDocument()
    run.emit({ event: 'steer_consumed', data: { steer_id: 's1', text: 'Check b too', after_tool_call_id: null } })
    view.rerender(<View run={run} />)
    expect(view.getAllByText('Check b too')).toHaveLength(1)
    expect(view.getByText('Check b too').closest('[data-role="user"]')).not.toHaveTextContent('Waiting')
  })

  it('offers only the actions the server allows', () => {
    const run = liveRun()
    run.emit(pending('s1', { edit: true, cancel: true, send_now: false }))
    const view = render(<View run={run} />)
    expect(view.queryByRole('button', { name: 'Send now' })).toBeNull()
    expect(view.getByRole('button', { name: 'Edit steering message' })).toBeInTheDocument()
    run.emit({ event: 'steer_pending', data: { steer_id: 's1', text: 'Check b too', submitted_at: 1, state: 'sending_now', actions: { edit: false, cancel: false, send_now: false } } })
    view.rerender(<View run={run} />)
    expect(view.queryAllByRole('button', { name: /steering message|Send now/ })).toHaveLength(0)
  })

  it('Edit returns the text to the composer, Cancel and Send now ask the server, and a refusal says why', async () => {
    const run = liveRun()
    run.emit(pending('s1'))
    const returned: string[] = []
    const stop = onReturnToComposer('s', (text) => { returned.push(text) })
    vi.mocked(api.withdrawSteer).mockResolvedValueOnce({ withdrawn: true, text: 'Check b too' }).mockResolvedValueOnce({ withdrawn: false }).mockResolvedValueOnce({ withdrawn: true, text: 'Check b too' })
    vi.mocked(api.sendSteerNow).mockResolvedValueOnce({ redirected: true } as never).mockResolvedValueOnce({ redirected: false } as never)
    const view = render(<View run={run} />)
    fireEvent.click(view.getByRole('button', { name: 'Edit steering message' }))
    await waitFor(() => { expect(returned).toEqual(['Check b too']) })
    expect(api.withdrawSteer).toHaveBeenLastCalledWith({ session_id: 's', steer_id: 's1', reason: 'edit' })
    fireEvent.click(view.getByRole('button', { name: 'Edit steering message' }))
    await waitFor(() => { expect(showToast).toHaveBeenCalledWith('The agent already took this steering message.', 2500) })
    expect(returned).toEqual(['Check b too'])
    fireEvent.click(view.getByRole('button', { name: 'Cancel steering message' }))
    await waitFor(() => { expect(api.withdrawSteer).toHaveBeenLastCalledWith({ session_id: 's', steer_id: 's1', reason: 'cancel' }) })
    expect(returned).toEqual(['Check b too'])
    fireEvent.click(view.getByRole('button', { name: 'Send now' }))
    await waitFor(() => { expect(api.sendSteerNow).toHaveBeenCalledWith({ session_id: 's', steer_id: 's1' }) })
    fireEvent.click(view.getByRole('button', { name: 'Send now' }))
    await waitFor(() => { expect(showToast).toHaveBeenCalledWith('Nothing is running to take it now; it stays pending.', 2500) })
    stop()
  })

  it.each([
    ['delivered', true, null],
    ['next_step', false, 'The agent takes it at its next step.'],
    ['not_running', false, 'Nothing is running to take it now; it stays pending.'],
    ['taken', false, 'This steering message can no longer be changed.'],
    ['failed', false, "Couldn't send it now; it stays pending."],
  ] as const)('renders the server Send now outcome %s (TAL-1000)', async (outcome, redirected, notice) => {
    const run = liveRun()
    run.emit(pending('s1'))
    vi.mocked(showToast).mockClear()
    vi.mocked(api.sendSteerNow).mockResolvedValueOnce({ redirected, outcome })
    const view = render(<View run={run} />)
    fireEvent.click(view.getByRole('button', { name: 'Send now' }))
    await waitFor(() => { expect(view.getByRole('button', { name: 'Send now' })).toBeEnabled() })
    if (notice) expect(showToast).toHaveBeenCalledWith(notice, 2500)
    else expect(showToast).not.toHaveBeenCalled()
  })

  it.each(['future', null, 0, false, {}])('reports an unknown or malformed Send now outcome as failed (%j)', async (outcome) => {
    const run = liveRun()
    run.emit(pending('s1'))
    vi.mocked(showToast).mockClear()
    vi.mocked(api.sendSteerNow).mockResolvedValueOnce({ redirected: false, outcome } as never)
    const view = render(<View run={run} />)
    fireEvent.click(view.getByRole('button', { name: 'Send now' }))
    await waitFor(() => { expect(view.getByRole('button', { name: 'Send now' })).toBeEnabled() })
    expect(showToast).toHaveBeenCalledWith("Couldn't send it now; it stays pending.", 2500)
  })

  it('says so when the agent already took a steer being cancelled, and reports a failed request as an error', async () => {
    const run = liveRun()
    run.emit(pending('s1'))
    vi.mocked(showToast).mockClear()
    vi.mocked(api.withdrawSteer).mockResolvedValueOnce({ withdrawn: false }).mockRejectedValueOnce(new Error('Network down'))
    const view = render(<View run={run} />)
    fireEvent.click(view.getByRole('button', { name: 'Cancel steering message' }))
    await waitFor(() => { expect(showToast).toHaveBeenCalledWith('The agent already took this steering message.', 2500) })
    await waitFor(() => { expect(view.getByRole('button', { name: 'Cancel steering message' })).toBeEnabled() })
    fireEvent.click(view.getByRole('button', { name: 'Cancel steering message' }))
    await waitFor(() => { expect(showToast).toHaveBeenLastCalledWith('Network down', 4000, 'error') })
  })

  it('sends one request at a time from a pending steer\'s buttons', async () => {
    const run = liveRun()
    run.emit(pending('s1'))
    let release: (v: { redirected: boolean }) => void = () => undefined
    vi.mocked(api.sendSteerNow).mockClear().mockReturnValueOnce(new Promise((resolve) => { release = resolve }) as never)
    const view = render(<View run={run} />)
    fireEvent.click(view.getByRole('button', { name: 'Send now' }))
    fireEvent.click(view.getByRole('button', { name: 'Send now' }))
    expect(view.getByRole('button', { name: 'Edit steering message' })).toBeDisabled()
    release({ redirected: true })
    await waitFor(() => { expect(view.getByRole('button', { name: 'Send now' })).toBeEnabled() })
    expect(api.sendSteerNow).toHaveBeenCalledTimes(1)
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
