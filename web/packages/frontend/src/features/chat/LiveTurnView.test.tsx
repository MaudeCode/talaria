import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Transcript } from './Transcript'
import { LiveStatusPill } from './LiveTurnView'
import { initialStreamState, streamReducer, type StreamAction } from '../../stream/reducer'
import type { ChatEvent } from '../../contracts/sse'
import type { ActivityMode } from './blocks/Worklog'
import * as api from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { onReturnToComposer } from '../composer/composerReturn'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), withdrawSteer: vi.fn(), sendSteerNow: vi.fn() }))
vi.mock(import('../toast/toast'), async (importOriginal) => ({ ...(await importOriginal()), showToast: vi.fn() }))

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
    vi.mocked(api.sendSteerNow).mockResolvedValueOnce({ redirected: true }).mockResolvedValueOnce({ redirected: false })
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
