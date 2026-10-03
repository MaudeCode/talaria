import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import type { Session, Settings } from '../../contracts'
import * as api from '../../api/endpoints'
import { dispatch, getStreamState, resetStreamStoreForTests } from '../../stream/store'
import type { LiveTurn } from '../../stream/reducer'
import type { QueuedTurn } from './Composer'
import { endFirstSend, getFirstSend } from '../chat/firstSend'
import { returnToComposer } from './composerReturn'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), saveDraft: vi.fn(), steerChat: vi.fn(), startChat: vi.fn(), startBackground: vi.fn(), fetchBackgroundTasks: vi.fn() }))
// jsdom has no EventSource: a followed turn opens a stream handle that does nothing.
vi.mock(import('../../api/sse'), async (importOriginal) => ({ ...(await importOriginal()), openChatStream: vi.fn(() => ({ close: () => undefined, readyState: () => 0 })) }))
import { Composer } from './Composer'

const noop = (): void => undefined
function renderComposer(session: Session | null, live: LiveTurn | null = null, onQueue: (entry: QueuedTurn) => void = noop, settings?: Settings, onEnsureSession: () => Promise<Session> = () => Promise.resolve(session!)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (turn: LiveTurn | null) => (
    <QueryClientProvider client={qc}>
      <BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}>
        <Composer
          sessionId={session?.session_id ?? null} session={session} live={turn} settings={settings} onEnsureSession={onEnsureSession} onLocalCommand={() => Promise.resolve(false)}
          terminalOpen={false} onToggleTerminal={noop} onModelChange={noop} onWorkspaceChange={noop} onToolsetsChange={noop} onReasoningChange={noop} reasoning={null}
          yolo={false} onToggleYolo={noop} queued={[]} onQueue={onQueue}
        />
      </BootstrapContext.Provider>
    </QueryClientProvider>
  )
  const view = render(tree(live))
  return { ...view, rerenderWith: (turn: LiveTurn | null) => view.rerender(tree(turn)) }
}

describe('Composer', () => {
  beforeEach(() => {
    vi.mocked(api.fetchBackgroundTasks).mockReset().mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [] })
    // jsdom has no matchMedia; the composer asks whether it is on a phone-width viewport.
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia
    globalThis.ResizeObserver = class { observe = noop; unobserve = noop; disconnect = noop }
  })

  it('offers no send, command or session controls for a session the server marks read-only (TAL-312)', () => {
    renderComposer({ session_id: 'child', title: 'Delegated child', is_streaming: false, read_only: true, can_branch: false, can_pin: false, can_archive: false, can_duplicate: false, source_tag: 'subagent', source_kind: 'subagent', is_messaging_session: false })
    expect(screen.getByRole('note')).toHaveTextContent('read-only')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  const writable: Session = { session_id: 's1', title: 'Mine', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false }
  const running = (): LiveTurn => {
    resetStreamStoreForTests()
    dispatch({ type: 'start', sessionId: 's1', streamId: 'run', turnId: 'turn', userMessageId: 'u', userText: 'Inspect', now: 0 })
    return getStreamState().turns.s1!
  }

  it('runs /background through the server and shows its record in the background card, not as a message (TAL-372)', async () => {
    vi.mocked(api.startBackground).mockResolvedValue({ ok: true, task_id: 'bg1', stream_id: 'bgs', session_id: 'hidden' })
    renderComposer({ ...writable, is_streaming: false })
    await waitFor(() => expect(api.fetchBackgroundTasks).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Background work' })).not.toBeInTheDocument()
    // The server records the task once it starts; the refresh after the start shows it.
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize repo', started_at: 1, updated_at: 1, completed_at: null, result_available: false, child_session_id: null, exit_code: null, agents: null, pinned: true, dismissible: false, active: true }] })
    await userEvent.type(screen.getByRole('textbox'), '/background summarize repo{Enter}')
    await waitFor(() => expect(api.startBackground).toHaveBeenCalledWith('s1', 'summarize repo'))
    expect(api.startChat).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(await screen.findByRole('region', { name: 'Background work' })).toHaveTextContent('summarize repo')
  })

  it('sends a steer with its id and shows it as sending until the server has it (TAL-425)', async () => {
    vi.mocked(api.steerChat).mockResolvedValue({ accepted: true, steer_id: 'ignored' })
    renderComposer(writable, running())
    await userEvent.type(screen.getByRole('textbox'), 'Check b too{Enter}')
    await waitFor(() => expect(api.steerChat).toHaveBeenCalled())
    expect(getStreamState().turns.s1!.pendingSteers).toMatchObject([{ text: 'Check b too', state: 'sending' }])
    const steerId = getStreamState().turns.s1!.pendingSteers[0]!.steerId
    expect(api.steerChat).toHaveBeenCalledWith({ session_id: 's1', text: 'Check b too', steer_id: steerId })
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('keeps a refused steer in the box and out of the turn', async () => {
    vi.mocked(api.steerChat).mockResolvedValue({ accepted: false, fallback: 'not_running' })
    renderComposer(writable, running())
    await userEvent.type(screen.getByRole('textbox'), 'Check b too{Enter}')
    await waitFor(() => expect(api.steerChat).toHaveBeenCalled())
    await waitFor(() => expect(getStreamState().turns.s1!.pendingSteers).toEqual([]))
    expect(screen.getByRole('textbox')).toHaveValue('Check b too')
  })

  it('follows the turn the server started when a message lands during a background turn (TAL-460)', async () => {
    vi.mocked(api.steerChat).mockResolvedValue({ accepted: true, fallback: null, stream_id: 'mine', steer_id: 'ignored', started_turn: { stream_id: 'mine', session_id: 's1', turn_id: 'mine' } })
    renderComposer({ ...writable, active_stream_id: 'run', active_turn_origin: 'background' }, running())
    expect(screen.getByRole('status')).toHaveTextContent('Working on background results')
    await userEvent.type(screen.getByRole('textbox'), 'What about my question?{Enter}')
    await waitFor(() => expect(getStreamState().turns.s1).toMatchObject({ streamId: 'mine', turnId: 'mine', userText: 'What about my question?', pendingSteers: [] }))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('keeps only Stop while a turn runs and the draft is empty', () => {
    renderComposer(writable, running())
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Steer current response' })).toBeNull()
  })

  it('shows a steer arrow beside Stop once a draft is typed mid-turn, and steers on click (TAL-428)', async () => {
    vi.mocked(api.steerChat).mockResolvedValue({ accepted: true, steer_id: 'ignored' })
    renderComposer(writable, running())
    await userEvent.type(screen.getByRole('textbox'), 'Check b too')
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Steer current response' }))
    await waitFor(() => expect(api.steerChat).toHaveBeenCalledWith(expect.objectContaining({ session_id: 's1', text: 'Check b too' })))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('labels the mid-turn arrow by the queue busy mode and queues on click', async () => {
    const onQueue = vi.fn()
    renderComposer(writable, running(), onQueue, { default_message_mode: 'queue' })
    await userEvent.type(screen.getByRole('textbox'), 'Then do z')
    await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({ text: 'Then do z' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('never queues a leftover steer: the server sends it as the next turn (TAL-424, TAL-425)', () => {
    const onQueue = vi.fn()
    const run = running()
    dispatch({ type: 'event', sessionId: 's1', streamId: 'run', event: { event: 'pending_steer_leftover', data: { steer_id: 's1', text: 'Also do y' } }, lastEventId: 'run:9', now: 9 })
    renderComposer(writable, getStreamState().turns.s1 ?? run, onQueue)
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('takes back a steer\'s text after the draft, with a blank line between, and focuses the box', async () => {
    renderComposer(writable, running())
    await userEvent.type(screen.getByRole('textbox'), 'Draft so far')
    act(() => { returnToComposer('s1', 'Check b too') })
    expect(screen.getByRole('textbox')).toHaveValue('Draft so far\n\nCheck b too')
    expect(screen.getByRole('textbox')).toHaveFocus()
    act(() => { returnToComposer('other-session', 'not here') })
    expect(screen.getByRole('textbox')).toHaveValue('Draft so far\n\nCheck b too')
  })

  it('keeps the composer for a writable session', () => {
    renderComposer({ session_id: 'mine', title: 'Mine', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByRole('note')).toBeNull()
  })
  it("shows a new chat's first send at once, sends it once, and hands the text back when it fails (TAL-429)", async () => {
    endFirstSend()
    let fail!: (e: Error) => void
    const ensure = vi.fn(() => new Promise<Session>((_, reject) => { fail = reject }))
    renderComposer(null, null, noop, undefined, ensure)
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Plan the release{Enter}')
    expect(getFirstSend()).toEqual({ text: 'Plan the release', sessionId: null, failed: false })
    expect(box).toHaveValue('')
    await userEvent.type(box, 'again{Enter}')
    expect(ensure).toHaveBeenCalledTimes(1)
    await userEvent.clear(box)
    fail(new Error('synthetic failure'))
    await waitFor(() => expect(box).toHaveValue('Plan the release'))
    expect(getFirstSend()).toBeNull()
  })
  it('shows the running turn in the top tab and slides it out when the turn ends (TAL-429)', async () => {
    const { container, rerenderWith } = renderComposer(writable, running())
    expect(container.querySelector('.composer-tab .live-run-status')).toHaveTextContent('Responding…')
    dispatch({ type: 'event', sessionId: 's1', streamId: 'run', event: { event: 'done', data: {} }, lastEventId: 'run:1', now: 1 })
    rerenderWith(getStreamState().turns.s1!)
    // The ended row stays for its exit slide, with the tab leaving alongside it, then both are gone.
    expect(container.querySelector('[data-notice="live"]')).toHaveClass('is-leaving')
    expect(container.querySelector('.composer-tab')).toHaveClass('is-leaving')
    await waitFor(() => expect(container.querySelector('.composer-tab')).toBeNull())
  })
  it('hands the text back when the chat start fails after the session exists (TAL-274)', async () => {
    endFirstSend()
    vi.mocked(api.startChat).mockRejectedValue(new Error('synthetic start failure'))
    const created: Session = { ...writable, session_id: 'fresh', is_streaming: false }
    renderComposer(null, null, noop, undefined, () => Promise.resolve(created))
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Plan the release{Enter}')
    await waitFor(() => expect(box).toHaveValue('Plan the release'))
    expect(api.startChat).toHaveBeenCalledTimes(1)
    expect(getFirstSend()).toBeNull()
  })
})
