import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openChatStream, type ChatStreamCallbacks } from '../../api/sse'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import type { Session, Settings } from '../../contracts'
import * as api from '../../api/endpoints'
import { dispatch, getStreamState, resetStreamStoreForTests, getTurnIntent } from '../../stream/store'
import type { LiveTurn } from '../../stream/reducer'
import type { QueuedTurn } from './queue'
import { deferred } from '../../test/fixtures'
import { resetConnectionsForTests } from '../../stream/connection'
import { endFirstSend, getFirstSend } from '../chat/firstSend'
import { returnToComposer } from './composerReturn'
import { showToast } from '../toast/toast'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), cancelChat: vi.fn(), fetchStreamStatus: vi.fn(), fetchSession: vi.fn(), uploadFile: vi.fn(), rollbackUpload: vi.fn(), saveDraft: vi.fn(), fetchDraft: vi.fn(), steerChat: vi.fn(), startChat: vi.fn(), startBackground: vi.fn(), fetchBackgroundTasks: vi.fn(), askBtw: vi.fn(), fetchCommands: vi.fn(), execCommand: vi.fn(), fetchTranscribeCapability: vi.fn() }))
// jsdom has no EventSource: a followed turn opens a stream handle that does nothing.
vi.mock(import('../toast/toast'), async (importOriginal) => ({ ...(await importOriginal()), showToast: vi.fn() }))
vi.mock(import('../../api/sse'), async (importOriginal) => ({ ...(await importOriginal()), openChatStream: vi.fn(() => ({ close: () => undefined, readyState: () => 0 })) }))
vi.mock(import('../voice/liveDictation'), async (importOriginal) => ({ ...(await importOriginal()), dictateLive: vi.fn(), liveDictationSupported: vi.fn(() => true) }))
import { Composer, type ComposerProps } from './Composer'
import { dictateLive } from '../voice/liveDictation'

const noop = (): void => undefined
function renderComposer(session: Session | null, live: LiveTurn | null = null, onQueue: (entry: QueuedTurn) => void = noop, settings?: Settings, onEnsureSession: () => Promise<Session> = () => Promise.resolve(session!), onLocalCommand: ComposerProps['onLocalCommand'] = () => Promise.resolve(false), overrides: Partial<ComposerProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (turn: LiveTurn | null, record = session) => (
    <QueryClientProvider client={qc}>
      <BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}>
        <Composer
          sessionId={record?.session_id ?? null} session={record} live={turn} settings={settings} onEnsureSession={onEnsureSession} onLocalCommand={onLocalCommand}
          terminalOpen={false} onToggleTerminal={noop} onModelChange={noop} onWorkspaceChange={noop} onToolsetsChange={noop} onReasoningChange={noop} reasoning={null}
          yolo={false} onToggleYolo={noop} queued={[]} onQueue={onQueue} onQueueChange={noop} {...overrides}
        />
      </BootstrapContext.Provider>
    </QueryClientProvider>
  )
  const view = render(tree(live))
  return { ...view, rerenderWith: (turn: LiveTurn | null) => view.rerender(tree(turn)), rerenderSession: (record: Session) => view.rerender(tree(live, record)) }
}

describe('Composer', () => {
  it('loads the saved draft before persisting a newly resolved identity', async () => {
    const session_id = 'loading-draft'
    localStorage.setItem(`hermes-draft:${session_id}`, JSON.stringify({ text: 'Draft 日本', updatedAt: Date.now() }))
    const view = renderComposer(null, null, noop, undefined, undefined, undefined, { sessionId: session_id })
    view.rerenderSession({ ...writable, session_id })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Draft 日本'))
  })

  it('persists text typed before the owner identity arrives on the resolved scope', async () => {
    const session_id = 'loading-owner'
    const view = renderComposer(null, null, noop, undefined, undefined, undefined, { sessionId: session_id })
    await userEvent.type(screen.getByRole('textbox'), 'Early typing')
    view.rerenderSession({ ...writable, session_id, composer_state_key: 'owner-complete-identity', owner_attachment: {
      state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, revision: 1, execution_generation: 1, admissions: [] } })
    expect(screen.getByRole('textbox')).toHaveValue('Early typing')
    fireEvent(window, new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem('hermes-draft:owner-complete-identity')!).text).toBe('Early typing')
    expect(localStorage.getItem(`hermes-draft:${session_id}`)).toBeNull()
  })

  it('continues an attached owner without offering unsupported local controls or file uploads', async () => {
    const owner = { state: 'attached' as const, reason: null, can_submit: true, can_interrupt: false, can_attach: false, revision: 2, execution_generation: 1, admissions: [] }
    const native = { ...writable, read_only: true, owner_attachment: owner }
    vi.mocked(api.startChat).mockResolvedValue({ session: native, owner_attachment: owner })
    renderComposer(native)
    expect(screen.queryByRole('button', { name: /attach files/i })).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox'), 'Continue with the same Agent{Enter}')
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(expect.objectContaining({ session_id: native.session_id, message: 'Continue with the same Agent', submission_id: expect.stringMatching(/^[a-f0-9]{32}$/) })))
  })

  it('explains an unsupported native CLI batch without offering a send', () => {
    renderComposer({ ...writable, read_only: true, owner_attachment: { state: 'incompatible', reason: 'native_clarify_batch_unavailable', can_submit: false, can_interrupt: false, can_attach: false, revision: null, execution_generation: null, admissions: [] } })
    expect(screen.getByText(/Continue in its native client/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
  beforeEach(() => {
    resetConnectionsForTests()
    resetStreamStoreForTests()
    vi.mocked(api.startChat).mockReset()
    vi.mocked(api.cancelChat).mockReset()
    vi.mocked(api.uploadFile).mockReset()
    vi.mocked(api.rollbackUpload).mockReset().mockResolvedValue({ ok: true } as never)
    vi.mocked(api.fetchSession).mockReset().mockResolvedValue({ session: { ...writable, is_streaming: false, messages: [] } })
    vi.mocked(api.fetchStreamStatus).mockReset().mockResolvedValue({ active: false, stream_id: 'run', blocking_stream_id: null })
    vi.mocked(api.fetchBackgroundTasks).mockReset().mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [] })
    vi.mocked(api.fetchCommands).mockReset().mockResolvedValue({ commands: [] })
    vi.mocked(api.saveDraft).mockReset().mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null })
    vi.mocked(api.fetchDraft).mockReset().mockResolvedValue({ draft: { text: '', files: [] }, draft_version: null })
    vi.mocked(api.fetchTranscribeCapability).mockReset().mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: false, warm_supported: false })
    vi.mocked(dictateLive).mockReset()
    // jsdom has no matchMedia; the composer asks whether it is on a phone-width viewport.
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia
    globalThis.ResizeObserver = class { observe = noop; unobserve = noop; disconnect = noop }
  })

  it('clears an existing submitted draft before start resolves and preserves newer typing', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValue(start.promise)
    renderComposer({ ...writable, is_streaming: false })
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Plan the release{Enter}')
    expect(box).toHaveValue('')
    await userEvent.type(box, 'Next draft{Enter}')
    expect(api.startChat).toHaveBeenCalledOnce()
    await act(async () => { start.resolve({ stream_id: 'started', session_id: 's1' }); await start.promise })
    expect(box).toHaveValue('Next draft')
  })

  it('queues an interrupt and clears its draft while cancel is unresolved', async () => {
    const cancel = deferred<Awaited<ReturnType<typeof api.cancelChat>>>()
    vi.mocked(api.cancelChat).mockReturnValue(cancel.promise)
    const queue = vi.fn()
    renderComposer(writable, running(), queue, { default_message_mode: 'interrupt' })
    await userEvent.type(screen.getByRole('textbox'), 'Replacement{Enter}')
    expect(queue).toHaveBeenCalledOnce()
    expect(queue.mock.calls[0]?.[0].text).toBe('Replacement')
    expect(screen.getByRole('textbox')).toHaveValue('')
    await act(async () => { cancel.resolve({ ok: true, cancelled: true }); await cancel.promise })
  })

  it('shows Stopping immediately and sends only one cancellation', async () => {
    const cancel = deferred<Awaited<ReturnType<typeof api.cancelChat>>>()
    vi.mocked(api.cancelChat).mockReturnValue(cancel.promise)
    renderComposer(writable, running())
    await userEvent.click(screen.getByRole('button', { name: 'Stop response' }))
    const stopping = screen.getByRole('button', { name: 'Stopping' })
    expect(stopping).toBeDisabled()
    await userEvent.click(stopping)
    expect(api.cancelChat).toHaveBeenCalledOnce()
    await act(async () => { cancel.resolve({ ok: true, cancelled: true }); await cancel.promise })
  })

  it('restores a refused submitted draft after newer text and retries its exact attachment receipt', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValueOnce(start.promise)
    const receipt = { filename: 'plan.txt', path: '/synthetic/plan.txt', rollback_token: 'receipt-1', size: 4, mime: 'text/plain' }
    vi.mocked(api.uploadFile).mockResolvedValue(receipt)
    renderComposer({ ...writable, is_streaming: false })
    const box = screen.getByRole('textbox')
    const file = new File(['plan'], 'plan.txt', { type: 'text/plain', lastModified: 1 })
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [file] } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull())
    await userEvent.type(box, 'Submitted{Enter}')
    expect(document.querySelector('.attach-tray')).toBeNull()
    expect(getTurnIntent('s1').send?.attachments).toEqual([receipt])
    await userEvent.type(box, 'Newer')
    const newerReceipt = { ...receipt, path: '/synthetic/new-plan.txt', rollback_token: 'receipt-2' }
    vi.mocked(api.uploadFile).mockResolvedValueOnce(newerReceipt)
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [file] } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2))
    await act(async () => { start.resolve({ ok: false, reason: 'Admission refused' }); await start.promise })
    await waitFor(() => expect(box).toHaveValue('Newer\n\nSubmitted'))
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('plan.txt')
    expect(api.rollbackUpload).toHaveBeenCalledExactlyOnceWith('s1', ['receipt-1'])
    vi.mocked(api.startChat).mockResolvedValueOnce({ stream_id: 'retry', session_id: 's1' })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.startChat).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.startChat).mock.calls[1]?.[0].attachments).toEqual([newerReceipt])
    expect(box).toHaveValue('')
  })

  it('shows an attachment-only send while start is held and preserves a newly attached file on success', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValue(start.promise)
    vi.mocked(api.uploadFile).mockImplementation((_sid, file) => Promise.resolve({ filename: file.name, path: `/synthetic/${file.name}`, size: file.size, mime: file.type }))
    renderComposer({ ...writable, is_streaming: false })
    const input = document.querySelector<HTMLInputElement>('#fileInput')!
    fireEvent.change(input, { target: { files: [new File(['one'], 'one.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(getTurnIntent('s1').send).toMatchObject({ text: '', attachments: [{ filename: 'one.txt' }] })
    expect(document.querySelector('.attach-tray')).toBeNull()
    fireEvent.change(input, { target: { files: [new File(['two'], 'two.txt', { type: 'text/plain' })] } })
    await act(async () => { start.resolve({ stream_id: 'started', session_id: 's1' }); await start.promise })
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent('two.txt')
    expect(screen.getByRole('list', { name: 'Attachments' })).not.toHaveTextContent('one.txt')
  })

  it('keeps Stopping through an early terminal event and leaves a failed Stop retryable', async () => {
    const cancel = deferred<Awaited<ReturnType<typeof api.cancelChat>>>()
    vi.mocked(api.cancelChat).mockReturnValue(cancel.promise)
    const queue = vi.fn()
    const { rerenderWith } = renderComposer(writable, running(), queue)
    await userEvent.click(screen.getByRole('button', { name: 'Stop response' }))
    act(() => dispatch({ type: 'event', sessionId: 's1', streamId: 'run', event: { event: 'cancel', data: {} }, lastEventId: 'run:1', now: 1 }))
    rerenderWith(getStreamState().turns.s1!)
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), 'After the terminal event{Enter}')
    expect(queue).toHaveBeenCalledOnce()
    expect(api.startChat).not.toHaveBeenCalled()
    await act(async () => { cancel.resolve({ ok: false, cancelled: false, error: 'Cancellation refused' }); await cancel.promise })
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled()
    expect(getTurnIntent('s1').stop?.failed).toBe(true)
    vi.mocked(api.cancelChat).mockResolvedValueOnce({ ok: true, cancelled: true })
    await userEvent.click(screen.getByRole('button', { name: 'Stop response' }))
    await waitFor(() => expect(getTurnIntent('s1').stop).toBeUndefined())
    expect(api.cancelChat).toHaveBeenCalledTimes(2)
  })

  it('dictates through the live stream when the server reports streaming: partials, then the final (TAL-802)', async () => {
    vi.mocked(api.fetchTranscribeCapability).mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: true, warm_supported: false })
    const stop = vi.fn()
    let onText: (text: string) => void = noop
    let onEnd: (error: unknown) => void = noop
    vi.mocked(dictateLive).mockImplementation((text, end) => { onText = text; onEnd = end; return { stop, cancel: vi.fn() } })
    renderComposer({ ...writable, is_streaming: false })
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Note:')
    // jsdom has no SpeechRecognition: the control exists only because the server offers the stream.
    await userEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => { onText('Ship the') })
    expect(box).toHaveValue('Note: Ship the')
    await userEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    expect(stop).toHaveBeenCalledOnce()
    act(() => { onText('Ship the release notes.'); onEnd(null) })
    expect(box).toHaveValue('Note: Ship the release notes.')
    expect(screen.getByRole('button', { name: 'Dictate' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the browser recognizer path when the server reports no streaming (TAL-802)', async () => {
    renderComposer({ ...writable, is_streaming: false })
    await waitFor(() => { expect(api.fetchTranscribeCapability).toHaveBeenCalled() })
    // jsdom has no SpeechRecognition, so without the stream there is no dictation control at all.
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull()
    expect(dictateLive).not.toHaveBeenCalled()
  })

  it('offers no send, command or session controls for a session the server marks read-only (TAL-312)', () => {
    renderComposer({ session_id: 'child', title: 'Delegated child', is_streaming: false, read_only: true, can_branch: false, can_pin: false, can_archive: false, can_delete: false, can_duplicate: false, source_tag: 'subagent', source_kind: 'subagent', is_messaging_session: false, sort_ts: 0 })
    expect(screen.getByRole('note')).toHaveTextContent('read-only')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
  })

  const writable: Session = { session_id: 's1', title: 'Mine', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0 }
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
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize repo', started_at: 1, updated_at: 1, completed_at: null, result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true }] })
    await userEvent.type(screen.getByRole('textbox'), '/background summarize repo{Enter}')
    await waitFor(() => expect(api.startBackground).toHaveBeenCalledWith('s1', 'summarize repo'))
    expect(api.startChat).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(await screen.findByRole('region', { name: 'Background work' })).toHaveTextContent('summarize repo')
  })

  // TAL-314: the server catalog resolves a typed alias and says which client runs each command.
  it('runs a typed alias as its server catalog command and refuses a command Web cannot run', async () => {
    vi.mocked(api.fetchCommands).mockResolvedValue({ commands: [
      { name: 'branch', aliases: ['fork'], handler: 'client', clients: ['web', 'ios'] },
      { name: 'background', aliases: ['bg'], handler: 'client', clients: ['web', 'ios'] },
      { name: 'history', aliases: [], handler: 'agent', clients: [], unsupported_message: '/history runs only in the Hermes CLI.' },
    ] })
    vi.mocked(api.startBackground).mockResolvedValue({ ok: true, task_id: 'bg1', stream_id: 'bgs', session_id: 'hidden' })
    vi.mocked(api.startChat).mockClear()
    const onLocalCommand = vi.fn((name: string) => Promise.resolve(name === 'branch'))
    renderComposer({ ...writable, is_streaming: false }, null, noop, undefined, undefined, onLocalCommand)
    const box = screen.getByRole('textbox')
    // The palette shows the server's entry once the catalog arrives.
    await userEvent.type(box, '/fo')
    expect(await screen.findByRole('option', { name: /\/branch/ })).toBeInTheDocument()
    await userEvent.clear(box)
    await userEvent.type(box, '/fork Copy{Enter}')
    await waitFor(() => expect(onLocalCommand).toHaveBeenCalledWith('branch', 'Copy'))
    await userEvent.type(box, '/bg summarize repo{Enter}')
    await waitFor(() => expect(api.startBackground).toHaveBeenCalledWith('s1', 'summarize repo'))
    onLocalCommand.mockClear()
    await userEvent.type(box, '/history{Enter}')
    expect(box).toHaveValue('/history')
    expect(onLocalCommand).not.toHaveBeenCalled()
    expect(api.startChat).not.toHaveBeenCalled()
  })

  // TAL-882: a refused local command (`/goal gate add` without a goal) shows the server's reason and keeps the text.
  it('shows why a local command was refused and keeps the typed command', async () => {
    vi.mocked(api.fetchCommands).mockResolvedValue({ commands: [{ name: 'goal', aliases: [], handler: 'client', clients: ['web', 'ios'] }] })
    vi.mocked(showToast).mockClear()
    const onLocalCommand = vi.fn(() => Promise.reject(new Error('/goal gate add: no active goal')))
    renderComposer({ ...writable, is_streaming: false }, null, noop, undefined, undefined, onLocalCommand)
    const box = screen.getByRole('textbox')
    await userEvent.type(box, '/goal gate add true{Enter}')
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('/goal gate add: no active goal', 5000, 'error'))
    expect(onLocalCommand).toHaveBeenCalledWith('goal', 'gate add true')
    expect(box).toHaveValue('/goal gate add true')
  })

  it.each(['retry', 'undo', 'clear'])('restores a refused /%s after newer text', async (command) => {
    const decision = deferred<boolean | 'refused'>()
    renderComposer({ ...writable, is_streaming: false }, null, noop, undefined, undefined, () => decision.promise)
    const box = screen.getByRole('textbox')
    await userEvent.type(box, `/${command}{Enter}`)
    expect(box).toHaveValue('')
    await userEvent.type(box, 'Newer draft')
    await act(async () => { decision.resolve('refused'); await decision.promise })
    expect(box).toHaveValue(`Newer draft\n\n/${command}`)
  })

  it('restores a history command after a thrown failure but fences an auth change', async () => {
    const decision = deferred<boolean>()
    renderComposer({ ...writable, is_streaming: false }, null, noop, undefined, undefined, () => decision.promise.then(() => { throw new Error('Refused') }))
    const box = screen.getByRole('textbox')
    await userEvent.type(box, '/retry{Enter}')
    await userEvent.type(box, 'Newer identity')
    act(() => resetConnectionsForTests())
    await act(async () => { decision.resolve(false); await decision.promise })
    expect(box).toHaveValue('Newer identity')
  })

  // TAL-561: an entry the server marks `exec` runs through the exec route; its output shows above the composer.
  it('runs a server command through exec and shows its output, never starting a turn', async () => {
    vi.mocked(api.fetchCommands).mockResolvedValue({ commands: [{ name: 'reload-skills', aliases: ['reload_skills'], handler: 'agent', clients: ['web', 'ios'], exec: true }] })
    vi.mocked(api.execCommand).mockReset().mockResolvedValue({ output: 'Reloaded skills from disk.\nTotal skills: 5' })
    vi.mocked(api.startChat).mockClear()
    const onLocalCommand = vi.fn(() => Promise.resolve(false))
    renderComposer({ ...writable, is_streaming: false }, null, noop, undefined, undefined, onLocalCommand)
    await waitFor(() => expect(api.fetchCommands).toHaveBeenCalled())
    const box = screen.getByRole('textbox')
    await userEvent.type(box, '/reload_skills {Enter}')
    await waitFor(() => expect(api.execCommand).toHaveBeenCalledWith('/reload_skills', 's1'))
    expect(await screen.findByRole('region', { name: 'Command output' })).toHaveTextContent('Total skills: 5')
    expect(box).toHaveValue('')
    expect(onLocalCommand).not.toHaveBeenCalled()
    expect(api.startChat).not.toHaveBeenCalled()

    vi.mocked(api.execCommand).mockRejectedValue(new Error('Hermes Agent sidecar is not running'))
    await userEvent.type(box, '/reload-skills {Enter}')
    await waitFor(() => expect(screen.getByRole('region', { name: 'Command output' })).toHaveTextContent('Command failed: Hermes Agent sidecar is not running'))
    expect(api.startChat).not.toHaveBeenCalled()
  })

  // TAL-518: `/btw` asks the server's side-question route and shows the answer above the composer, running or idle.
  const askSideQuestion = async (session: Session, live: LiveTurn | null) => {
    vi.mocked(api.steerChat).mockClear()
    vi.mocked(api.startChat).mockClear()
    vi.mocked(api.askBtw).mockReset().mockResolvedValue({ stream_id: 'side', session_id: 'hidden', parent_session_id: 's1' })
    let side: ChatStreamCallbacks | null = null
    const closed = vi.fn()
    vi.mocked(openChatStream).mockImplementation((streamId, _replay, cb) => { if (streamId === 'side') side = cb; return { close: streamId === 'side' ? closed : noop, readyState: () => 1 } })
    renderComposer(session, live)
    await userEvent.type(screen.getByRole('textbox'), '/btw how big is it?{Enter}')
    await waitFor(() => expect(vi.mocked(api.askBtw).mock.calls.length + vi.mocked(api.steerChat).mock.calls.length + vi.mocked(api.startChat).mock.calls.length).toBeGreaterThan(0))
    expect(api.steerChat).not.toHaveBeenCalled()
    expect(api.startChat).not.toHaveBeenCalled()
    expect(api.askBtw).toHaveBeenCalledWith('s1', 'how big is it?')
    expect(screen.getByRole('textbox')).toHaveValue('')
    const panel = await screen.findByRole('region', { name: 'Side question — not in history' })
    expect(panel).toHaveTextContent('how big is it?')
    await waitFor(() => expect(side).not.toBeNull())
    act(() => { side!.onEvent({ event: 'token', data: { text: 'Three' } }, 'side:1') })
    expect(panel).toHaveTextContent('Three')
    act(() => { side!.onEvent({ event: 'done', data: { ephemeral: true, answer: 'Three nodes.', terminal_state: 'completed' } }, 'side:2') })
    expect(panel).toHaveTextContent('Three nodes.')
    expect(closed).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Side question — not in history' })).toBeNull())
  }

  it('answers /btw beside a running turn without steering it (TAL-518)', async () => {
    await askSideQuestion(writable, running())
    expect(getStreamState().turns.s1!.pendingSteers).toEqual([])
    expect(getStreamState().turns.s1!.userText).toBe('Inspect')
  })

  it('answers an idle /btw beside the chat instead of sending it as a message (TAL-518)', async () => {
    resetStreamStoreForTests()
    await askSideQuestion({ ...writable, is_streaming: false }, null)
    expect(getStreamState().turns.s1).toBeUndefined()
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

  it('renders the context ring from the server figures alone (TAL-299)', () => {
    const idle = { ...writable, is_streaming: false }
    // Raw counters without the server percent (a cumulative total, no window) show no percentage: no guessed window, never over 100.
    const { unmount } = renderComposer({ ...idle, input_tokens: 900_000, last_prompt_tokens: 900_000, context_usage_percent: null, context_used_tokens: 900_000, context_window_tokens: null })
    expect(document.getElementById('ctxIndicator')).toBeNull()
    unmount()
    const second = renderComposer({ ...idle, last_prompt_tokens: 120_000, post_compression_context_tokens_estimate: 10_347, context_length: 128_000, context_used_tokens: 10_347, context_window_tokens: 128_000, context_usage_percent: 8, context_threshold_percent: 78 })
    expect(document.getElementById('ctxPercent')).toHaveTextContent('8')
    expect(document.getElementById('ctxIndicator')?.getAttribute('aria-label')).toMatch(/: 8% \(10,347 \/ 128,000\) · .*: 78%$/)
    second.unmount()
    // A threshold under half a percent of a large window is the server's 0, still shown.
    renderComposer({ ...idle, context_used_tokens: 10_000, context_window_tokens: 1_000_000, context_usage_percent: 1, context_threshold_percent: 0 })
    expect(document.getElementById('ctxIndicator')?.getAttribute('aria-label')).toMatch(/ · .*: 0%$/)
  })

  it('opens the context ring into the server usage figures and a Compress now action (TAL-614)', async () => {
    const onLocalCommand = vi.fn(() => Promise.resolve(true))
    renderComposer({ ...writable, is_streaming: false, context_used_tokens: 10_347, context_window_tokens: 128_000, context_usage_percent: 8, context_threshold_percent: 78, input_tokens: 52_000, output_tokens: 3_400, cache_read_tokens: 40_000, cache_write_tokens: 2_000, cache_hit_percent: 77, estimated_cost: 0.1234, can_compress: true }, null, noop, undefined, undefined, onLocalCommand)
    await userEvent.click(document.getElementById('ctxIndicator')!)
    const popup = await screen.findByRole('dialog')
    expect(popup).toHaveTextContent('Context window usage: 8%')
    expect(popup).toHaveTextContent('10,347 / 128,000')
    expect(popup).toHaveTextContent('Automatic compression: 78%')
    expect(popup).toHaveTextContent('Input tokens: 52,000')
    expect(popup).toHaveTextContent('Output tokens: 3,400')
    expect(popup).toHaveTextContent('Estimated cost: $0.1234')
    expect(popup).toHaveTextContent('Cache: 77% hit (40,000 read / 2,000 write)')
    await userEvent.click(within(popup).getByRole('button', { name: 'Compress now' }))
    expect(onLocalCommand).toHaveBeenCalledWith('compress', '')
  })

  it('offers Compress now only when the server says it would start, and shows a zero cost (TAL-614)', async () => {
    renderComposer({ ...writable, is_streaming: false, context_used_tokens: 900, context_window_tokens: 128_000, context_usage_percent: 1, estimated_cost: 0, can_compress: false })
    await userEvent.click(document.getElementById('ctxIndicator')!)
    const popup = await screen.findByRole('dialog')
    expect(popup).toHaveTextContent('Estimated cost: $0.00')
    expect(within(popup).queryByRole('button', { name: 'Compress now' })).toBeNull()
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
    renderComposer({ session_id: 'mine', title: 'Mine', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0 })
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
    expect(container.querySelector('.composer-tab .live-run-status')).toHaveTextContent('Working')
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
