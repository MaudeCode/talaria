import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openChatStream, type ChatStreamCallbacks } from '../../api/sse'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import type { Session, Settings } from '../../contracts'
import * as api from '../../api/endpoints'
import { ApiError } from '../../contracts/common'
import { dispatch, getStreamState, resetStreamStoreForTests, getTurnIntent } from '../../stream/store'
import { isTerminal, type LiveTurn } from '../../stream/reducer'
import type { QueuedTurn } from './queue'
import { deferred } from '../../test/fixtures'
import { resetConnectionsForTests } from '../../stream/connection'
import { endFirstSend, getFirstSend } from '../chat/firstSend'
import { returnToComposer } from './composerReturn'
import { showToast } from '../toast/toast'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), cancelChat: vi.fn(), fetchStreamStatus: vi.fn(), fetchSession: vi.fn(), uploadFile: vi.fn(), rollbackUpload: vi.fn(), saveDraft: vi.fn(), fetchDraft: vi.fn(), steerChat: vi.fn(), startChat: vi.fn(), startBackground: vi.fn(), fetchBackgroundTasks: vi.fn(), askBtw: vi.fn(), fetchCommands: vi.fn(), execCommand: vi.fn(), fetchTranscribeCapability: vi.fn(), fetchExecutionModes: vi.fn(() => Promise.resolve({ modes: [{ mode: 'normal', available: true, reason: null, can_attach: true }, { mode: 'ignore_config', available: true, reason: null, can_attach: false }, { mode: 'safe', available: true, reason: null, can_attach: false }] } satisfies ExecutionModes)) }))
// jsdom has no EventSource: a followed turn opens a stream handle that does nothing.
vi.mock(import('../toast/toast'), async (importOriginal) => ({ ...(await importOriginal()), showToast: vi.fn() }))
vi.mock(import('../../api/sse'), async (importOriginal) => ({ ...(await importOriginal()), openChatStream: vi.fn(() => ({ close: () => undefined, readyState: () => 0 })) }))
vi.mock(import('../voice/liveDictation'), async (importOriginal) => ({ ...(await importOriginal()), dictateLive: vi.fn(), liveDictationSupported: vi.fn(() => true) }))
const renders = vi.hoisted(() => ({ controls: 0, model: 0, attachments: 0, notices: 0 }))
vi.mock('./ComposerControls', async (original) => {
  const controls = await original<typeof import('./ComposerControls')>()
  const { countRenders } = await import('../../test/countRenders')
  return { ...controls, ComposerControls: countRenders(controls.ComposerControls, () => renders.controls++) }
})
vi.mock('./chips', async (original) => {
  const chips = await original<typeof import('./chips')>()
  const { countRenders } = await import('../../test/countRenders')
  return { ...chips, ModelChip: countRenders(chips.ModelChip, () => renders.model++) }
})
vi.mock('./Attachments', async (original) => {
  const attachments = await original<typeof import('./Attachments')>()
  const { countRenders } = await import('../../test/countRenders')
  return { ...attachments, AttachmentTray: countRenders(attachments.AttachmentTray, () => renders.attachments++) }
})
vi.mock('./ComposerNotices', async (original) => {
  const notices = await original<typeof import('./ComposerNotices')>()
  const { countRenders } = await import('../../test/countRenders')
  return { ...notices, ComposerNotices: countRenders(notices.ComposerNotices, () => renders.notices++) }
})
import { Composer, type ComposerProps } from './Composer'
import type { ExecutionModes } from '@maudecode/talaria-web-contracts'
import { dictateLive, NoSpeechError } from '../voice/liveDictation'
import * as browserDictation from '../voice/dictation'

const noop = (): void => undefined
function renderComposer(session: Session | null, live: LiveTurn | null = null, onQueue: (entry: QueuedTurn) => void = noop, settings?: Settings, onEnsureSession: () => Promise<Session> = () => Promise.resolve(session!), onLocalCommand: ComposerProps['onLocalCommand'] = () => Promise.resolve(false), overrides: Partial<ComposerProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (turn: LiveTurn | null, record = session) => (
    <QueryClientProvider client={qc}>
      <BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}>
        <Composer
          sessionId={record?.session_id ?? null} session={record} busy={!!turn && !isTerminal(turn.status)} streamId={turn?.streamId ?? null} settings={settings} onEnsureSession={onEnsureSession} onLocalCommand={onLocalCommand}
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
  it.each([false, true])('does not render unrelated controls, attachments or notices while typing ten characters, busy: %s', async (busy) => {
    renderComposer(writable, busy ? running() : null)
    const box = screen.getByRole('textbox')
    await userEvent.click(box)
    await act(() => Promise.resolve())
    const before = { ...renders }
    await userEvent.type(box, 'abcdefghij', { skipClick: true })
    expect(Object.fromEntries(Object.keys(before).map((key) => [key, renders[key as keyof typeof renders] - before[key as keyof typeof before]]))).toEqual({ controls: 0, model: 0, attachments: 0, notices: 0 })
    expect(box).toHaveValue('abcdefghij')
  })

  it('offers no attachment before a fresh chat starts in a mode the server says cannot attach (TAL-1040)', async () => {
    const onEnsureSession = vi.fn(() => Promise.reject(new Error('must not create')))
    const view = renderComposer(null, null, noop, undefined, onEnsureSession, undefined, { onExecutionModeChange: vi.fn(), pendingChoices: { execution_mode: 'safe' } })
    await waitFor(() => { expect(view.container.querySelector('#btnAttach')).toBeNull() })
    view.unmount()
    renderComposer(null, null, noop, undefined, onEnsureSession, undefined, { onExecutionModeChange: vi.fn(), pendingChoices: { execution_mode: 'normal' } })
    await waitFor(() => { expect(document.querySelector('#btnAttach')).not.toBeNull() })
    expect(onEnsureSession).not.toHaveBeenCalled()
  })

  it('keeps the fresh-chat Agent mode reachable when the other strip controls are hidden (TAL-1040)', () => {
    const settings = { hide_composer_workspace: true, hide_composer_toolsets: true, hide_composer_profile: true } as unknown as Settings
    renderComposer(null, null, noop, settings, undefined, undefined, { onExecutionModeChange: vi.fn() })
    expect(screen.getByRole('button', { name: 'Agent mode: Normal' })).toBeInTheDocument()
  })

  it.each([false, true])('keeps an early attachment when its upload completes before transcript load: %s', async (completedBeforeLoad) => {
    const upload = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    const receipt = { filename: 'early.png', path: '/synthetic/early.png', size: 1, mime: 'image/png', rollback_token: 'early-receipt' }
    vi.mocked(api.uploadFile).mockReturnValue(upload.promise)
    const view = renderComposer(null, null, noop, undefined, undefined, undefined, { sessionId: 'loading' })
    const file = new File(['x'], 'early.png', { type: 'image/png', lastModified: 1 })
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [file] } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledWith('loading', file))
    expect(screen.getByRole('button', { name: 'Remove early.png' })).toBeVisible()
    if (completedBeforeLoad) await act(async () => { upload.resolve(receipt); await upload.promise })
    view.rerenderSession({ ...writable, session_id: 'loading' })
    if (!completedBeforeLoad) {
      expect(document.querySelector('.attach-tray [data-status="uploading"]')).not.toBeNull()
      await act(async () => { upload.resolve(receipt); await upload.promise })
    }
    expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull()
    expect(api.uploadFile).toHaveBeenCalledOnce()
    expect(api.rollbackUpload).not.toHaveBeenCalled()
  })

  it('keeps an early attachment failure retryable after transcript load', async () => {
    const receipt = { filename: 'early.png', path: '/synthetic/early.png', size: 1, mime: 'image/png' }
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new Error('synthetic upload failure')).mockResolvedValue(receipt)
    const view = renderComposer(null, null, noop, undefined, undefined, undefined, { sessionId: 'loading' })
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [new File(['x'], 'early.png', { type: 'image/png', lastModified: 1 })] } })
    await screen.findByRole('button', { name: 'Retry early.png' })
    view.rerenderSession({ ...writable, session_id: 'loading' })
    await userEvent.click(screen.getByRole('button', { name: 'Retry early.png' }))
    await waitFor(() => expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull())
    expect(api.uploadFile).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.uploadFile).mock.calls.map(([id]) => id)).toEqual(['loading', 'loading'])
  })

  it('does not restore a removed early attachment when transcript and upload finish', async () => {
    const upload = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    vi.mocked(api.uploadFile).mockReturnValue(upload.promise)
    const view = renderComposer(null, null, noop, undefined, undefined, undefined, { sessionId: 'loading' })
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [new File(['x'], 'early.png', { type: 'image/png', lastModified: 1 })] } })
    await userEvent.click(screen.getByRole('button', { name: 'Remove early.png' }))
    view.rerenderSession({ ...writable, session_id: 'loading' })
    await act(async () => { upload.resolve({ filename: 'early.png', path: '/synthetic/early.png', size: 1, mime: 'image/png', rollback_token: 'removed-receipt' }); await upload.promise })
    expect(document.querySelector('.attach-tray')).toBeNull()
    expect(api.rollbackUpload).toHaveBeenCalledExactlyOnceWith('loading', ['removed-receipt'])
  })

  it('keeps each chat\'s failed, pending and completed files with its text across A -> B -> A (TAL-1074)', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    const receipt = (name: string) => ({ filename: name, path: `/synthetic/${name}`, size: 1, mime: 'text/plain', rollback_token: `receipt-${name}` })
    vi.mocked(api.uploadFile).mockImplementation((_id, file) => file.name === 'failed.txt' ? Promise.reject(new Error('synthetic offline')) : file.name === 'pending.txt' ? pending.promise : Promise.resolve(receipt(file.name)))
    const a = { ...writable, session_id: 'a', is_streaming: false }
    const b = { ...writable, session_id: 'b', is_streaming: false }
    const view = renderComposer(a)
    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'Text for A')
    const picked = ['failed.txt', 'pending.txt', 'done.txt'].map((name) => new File(['x'], name, { type: 'text/plain', lastModified: 1 }))
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: picked } })
    await screen.findByRole('button', { name: 'Retry failed.txt' })
    await waitFor(() => expect(document.querySelectorAll('.attach-tray [data-status="done"]')).toHaveLength(1))
    view.rerenderSession(b)
    await waitFor(() => expect(box).toHaveValue(''))
    expect(document.querySelector('.attach-tray')).toBeNull()
    // A's upload finishes while B is shown: B never receives it, and A keeps it.
    await act(async () => { pending.resolve(receipt('pending.txt')); await pending.promise })
    expect(document.querySelector('.attach-tray')).toBeNull()
    view.rerenderSession(a)
    await waitFor(() => expect(box).toHaveValue('Text for A'))
    const tray = screen.getByRole('list', { name: 'Attachments' })
    expect([...tray.querySelectorAll('li')].map((li) => `${li.querySelector('span')?.textContent}:${li.getAttribute('data-status')}`)).toEqual(['failed.txt:error', 'pending.txt:done', 'done.txt:done'])
    expect(screen.getByText('synthetic offline')).toBeInTheDocument()
    // The failed file uploads again from the same File, without picking it again.
    vi.mocked(api.uploadFile).mockResolvedValueOnce(receipt('failed.txt'))
    await userEvent.click(screen.getByRole('button', { name: 'Retry failed.txt' }))
    await waitFor(() => expect(tray.querySelectorAll('[data-status="done"]')).toHaveLength(3))
    expect(vi.mocked(api.uploadFile).mock.calls.at(-1)).toEqual(['a', picked[0]])
    expect(api.rollbackUpload).not.toHaveBeenCalled()
    vi.mocked(api.startChat).mockResolvedValueOnce({ stream_id: 'run-a', session_id: 'a' })
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.startChat).toHaveBeenCalledOnce())
    expect(vi.mocked(api.startChat).mock.calls[0]?.[0]).toMatchObject({ message: 'Text for A', attachments: ['failed.txt', 'pending.txt', 'done.txt'].map(receipt) })
    // A sent tray is released: leaving and returning shows nothing.
    view.rerenderSession(b)
    view.rerenderSession(a)
    expect(document.querySelector('.attach-tray')).toBeNull()
  })

  it('returns a send refused while another chat is shown to its own chat with its files, next to files staged since (TAL-1074)', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.startChat>>>()
    vi.mocked(api.startChat).mockReturnValueOnce(start.promise)
    vi.mocked(api.uploadFile).mockImplementation((_id, file) => Promise.resolve({ filename: file.name, path: `/synthetic/${file.name}`, size: 1, mime: 'text/plain', rollback_token: `receipt-${file.name}` }))
    const a = { ...writable, session_id: 'a', is_streaming: false }
    const b = { ...writable, session_id: 'b', is_streaming: false }
    const view = renderComposer(a)
    const box = screen.getByRole('textbox')
    const input = document.querySelector<HTMLInputElement>('#fileInput')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'sent.txt', { type: 'text/plain', lastModified: 1 })] } })
    await waitFor(() => expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull())
    await userEvent.type(box, 'Refused{Enter}')
    expect(document.querySelector('.attach-tray')).toBeNull()
    fireEvent.change(input, { target: { files: [new File(['y'], 'newer.txt', { type: 'text/plain', lastModified: 1 })] } })
    await waitFor(() => expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull())
    view.rerenderSession(b)
    await act(async () => { start.resolve({ ok: false, reason: 'Admission refused' }); await start.promise })
    expect(document.querySelector('.attach-tray')).toBeNull()
    expect(box).toHaveValue('')
    view.rerenderSession(a)
    await waitFor(() => expect(box).toHaveValue('Refused'))
    expect([...screen.getByRole('list', { name: 'Attachments' }).querySelectorAll('li span:first-of-type')].map((span) => span.textContent)).toEqual(['newer.txt', 'sent.txt'])
    expect(api.rollbackUpload).not.toHaveBeenCalled()
  })

  it('restores an attachment-only draft after the composer unmounts, keeps an offscreen completion, and fences a newer removal (TAL-1074)', async () => {
    const first = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    const second = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    vi.mocked(api.uploadFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = { ...writable, session_id: 'a', is_streaming: false }
    const view = renderComposer(a)
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: ['shot.png', 'later.png'].map((name) => new File(['x'], name, { type: 'image/png', lastModified: 1 })) } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2))
    view.unmount()
    await act(async () => { first.resolve({ filename: 'shot.png', path: '/synthetic/shot.png', size: 1, mime: 'image/png', rollback_token: 'shot-receipt' }); await first.promise })
    const back = renderComposer(a)
    await waitFor(() => expect(document.querySelectorAll('.attach-tray [data-status]')).toHaveLength(2))
    expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull()
    expect(document.querySelector('.attach-tray [data-status="uploading"]')).not.toBeNull()
    // Removed after returning: the late receipt is rolled back exactly once and never brings the chip back.
    await userEvent.click(screen.getByRole('button', { name: 'Remove later.png' }))
    await act(async () => { second.resolve({ filename: 'later.png', path: '/synthetic/later.png', size: 1, mime: 'image/png', rollback_token: 'later-receipt' }); await second.promise })
    expect(api.rollbackUpload).toHaveBeenCalledExactlyOnceWith('a', ['later-receipt'])
    expect(document.querySelectorAll('.attach-tray [data-status]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    // Logout or a profile switch discards the page's staged files.
    back.unmount()
    resetConnectionsForTests()
    renderComposer(a)
    expect(document.querySelector('.attach-tray')).toBeNull()
  })

  it('does not bring back a discussion send refused after auth or profile teardown (TAL-1074)', async () => {
    const sent = deferred<boolean>()
    const room = { identity: 'room-a', maxUploadBytes: 1_000_000, maxAttachments: 4, canSend: true, onSend: vi.fn(() => sent.promise), onUpload: vi.fn((file: File) => Promise.resolve({ attachment_id: file.name } as never)) }
    const tree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><Composer room={room} settings={undefined} /></BootstrapContext.Provider>
      </QueryClientProvider>
    )
    const view = render(tree())
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [new File(['x'], 'kept.txt', { type: 'text/plain', lastModified: 1 })] } })
    await waitFor(() => expect(document.querySelector('.attach-tray [data-status="done"]')).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(room.onSend).toHaveBeenCalledOnce()
    view.unmount()
    resetConnectionsForTests()
    await act(async () => { sent.resolve(false); await sent.promise })
    render(tree())
    expect(document.querySelector('.attach-tray')).toBeNull()
  })

  it.each(['session', 'owner', 'attachment refusal', 'capability refusal'].flatMap((replacement) => [false, true].map((completedBeforeReplacement) => ({ replacement, completedBeforeReplacement }))))('leaves attachment identity on $replacement (completed: $completedBeforeReplacement), rolling back only a refused receipt', async ({ replacement, completedBeforeReplacement }) => {
    const upload = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    const receipt = { filename: 'early.png', path: '/synthetic/early.png', size: 1, mime: 'image/png', rollback_token: 'obsolete-receipt' }
    vi.mocked(api.uploadFile).mockReturnValue(upload.promise)
    const initial = replacement === 'attachment refusal' ? null : { ...writable, session_id: 'loading', composer_state_key: 'original-owner' }
    const view = renderComposer(initial, null, noop, undefined, undefined, undefined, initial ? {} : { sessionId: 'loading' })
    if (replacement === 'capability refusal') await userEvent.type(screen.getByRole('textbox'), 'Keep newer text')
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: [new File(['x'], 'early.png', { type: 'image/png', lastModified: 1 })] } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled())
    if (completedBeforeReplacement) await act(async () => { upload.resolve(receipt); await upload.promise })
    view.rerenderSession({ ...writable, session_id: replacement === 'session' ? 'other' : 'loading', composer_state_key: replacement === 'capability refusal' ? 'original-owner' : 'replacement-owner',
      ...(replacement.endsWith('refusal') ? { owner_attachment: { state: 'attached' as const, reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [] } } : {}) })
    if (!completedBeforeReplacement) await act(async () => { upload.resolve(receipt); await upload.promise })
    expect(document.querySelector('.attach-tray')).toBeNull()
    // Another chat or owner never shows the file; it stays staged for its own identity (TAL-1074). A refusal drops it.
    if (replacement.endsWith('refusal')) expect(api.rollbackUpload).toHaveBeenCalledExactlyOnceWith('loading', ['obsolete-receipt'])
    else expect(api.rollbackUpload).not.toHaveBeenCalled()
    expect(api.uploadFile).toHaveBeenCalledOnce()
    if (replacement === 'capability refusal') expect(screen.getByRole('textbox')).toHaveValue('Keep newer text')
  })

  it('rolls back all completed early attachments and separately fences a pending upload on refusal', async () => {
    const late = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
    vi.mocked(api.uploadFile)
      .mockResolvedValueOnce({ filename: 'one.png', path: '/synthetic/one.png', size: 1, mime: 'image/png', rollback_token: 'completed-one' })
      .mockResolvedValueOnce({ filename: 'two.png', path: '/synthetic/two.png', size: 1, mime: 'image/png', rollback_token: 'completed-two' })
      .mockReturnValueOnce(late.promise)
    const view = renderComposer({ ...writable, session_id: 'loading', composer_state_key: 'same-owner' })
    fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: ['one.png', 'two.png', 'three.png'].map((name) => new File(['x'], name, { type: 'image/png', lastModified: 1 })) } })
    await waitFor(() => expect(document.querySelectorAll('.attach-tray [data-status="done"]')).toHaveLength(2))
    view.rerenderSession({ ...writable, session_id: 'loading', composer_state_key: 'same-owner', owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [] } })
    expect(api.rollbackUpload).toHaveBeenCalledExactlyOnceWith('loading', ['completed-one', 'completed-two'])
    await act(async () => { late.resolve({ filename: 'three.png', path: '/synthetic/three.png', size: 1, mime: 'image/png', rollback_token: 'late-three' }); await late.promise })
    expect(api.rollbackUpload).toHaveBeenNthCalledWith(2, 'loading', ['late-three'])
    expect(api.rollbackUpload).toHaveBeenCalledTimes(2)
    expect(api.uploadFile).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.attach-tray')).toBeNull()
  })

  it('shows pending images as thumbnails in a strip on the card\'s top edge, files in the card, and revokes each preview (TAL-1552)', async () => {
    const created: string[] = []
    const createObjectURL = vi.fn((file: Blob) => { const url = `blob:synthetic/${(file as File).name}`; created.push(url); return url })
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }))
    try {
      vi.mocked(api.uploadFile).mockImplementation((_id, file) => Promise.resolve({ filename: file.name, path: `/synthetic/${file.name}`, size: 1, mime: file.type }))
      const view = renderComposer({ ...writable, session_id: 'thumbs' })
      const files = [new File(['x'], 'shot.png', { type: 'image/png', lastModified: 1 }), new File(['y'], 'other.png', { type: 'image/png', lastModified: 1 }), new File(['z'], 'notes.txt', { type: 'text/plain', lastModified: 1 })]
      fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files } })
      const card = document.querySelector<HTMLElement>('#composerBox')!
      await waitFor(() => expect(document.querySelectorAll('.composer-strip--top img')).toHaveLength(2))
      const strip = document.querySelector<HTMLElement>('.composer-strip--top')!
      expect(card.contains(strip)).toBe(false)
      expect(strip.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect([...strip.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['blob:synthetic/shot.png', 'blob:synthetic/other.png'])
      expect(within(card).queryByText('shot.png')).toBeNull()
      expect(within(card).getByText('notes.txt')).toBeVisible()
      await waitFor(() => expect(strip.querySelectorAll('[data-status="done"]')).toHaveLength(2))
      await userEvent.click(screen.getByRole('button', { name: 'Enlarge other.png' }))
      expect(await screen.findByRole('dialog', { name: 'other.png' })).toBeVisible()
      await userEvent.keyboard('{Escape}')
      await userEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }))
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:synthetic/shot.png')
      expect(strip.querySelectorAll('img')).toHaveLength(1)
      // The strip takes drops like the card does.
      fireEvent.drop(strip, { dataTransfer: { files: [new File(['w'], 'dropped.png', { type: 'image/png', lastModified: 1 })] } })
      await waitFor(() => expect(strip.querySelectorAll('img')).toHaveLength(2))
      view.unmount()
      expect(revokeObjectURL.mock.calls.map(([url]) => url as string).sort()).toEqual([...created].sort())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the enlarged pending image open when an earlier one finishes uploading (TAL-1552)', async () => {
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: (file: Blob) => `blob:synthetic/${(file as File).name}`, revokeObjectURL: vi.fn() }))
    try {
      const first = deferred<Awaited<ReturnType<typeof api.uploadFile>>>()
      vi.mocked(api.uploadFile).mockImplementation((_id, file) => file.name === 'first.png' ? first.promise : Promise.resolve({ filename: file.name, path: `/synthetic/${file.name}`, size: 1, mime: file.type }))
      renderComposer({ ...writable, session_id: 'enlarged' })
      fireEvent.change(document.querySelector<HTMLInputElement>('#fileInput')!, { target: { files: ['first.png', 'second.png'].map((name) => new File(['x'], name, { type: 'image/png', lastModified: 1 })) } })
      await userEvent.click(await screen.findByRole('button', { name: 'Enlarge second.png' }))
      expect(await screen.findByRole('dialog', { name: 'second.png' })).toBeVisible()
      await act(async () => { first.resolve({ filename: 'first.png', path: '/synthetic/first.png', size: 1, mime: 'image/png' }); await first.promise })
      expect(screen.getByRole('dialog', { name: 'second.png' })).toBeVisible()
    } finally {
      vi.unstubAllGlobals()
    }
  })

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
      state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [] } })
    expect(screen.getByRole('textbox')).toHaveValue('Early typing')
    fireEvent(window, new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem('hermes-draft:owner-complete-identity')!).text).toBe('Early typing')
    expect(localStorage.getItem(`hermes-draft:${session_id}`)).toBeNull()
  })

  it('continues an attached owner without offering unsupported local controls or file uploads', async () => {
    const owner = { state: 'attached' as const, reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 2, execution_generation: 1, admissions: [] }
    const native = { ...writable, read_only: true, owner_attachment: owner }
    vi.mocked(api.startChat).mockResolvedValue({ session: native, owner_attachment: owner })
    renderComposer(native)
    expect(screen.queryByRole('button', { name: /attach files/i })).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox'), 'Continue with the same Agent{Enter}')
    await waitFor(() => expect(api.startChat).toHaveBeenCalledWith(expect.objectContaining({ session_id: native.session_id, message: 'Continue with the same Agent', submission_id: expect.stringMatching(/^[a-f0-9]{32}$/) })))
  })

  it('explains an unsupported native CLI batch without offering a send', () => {
    renderComposer({ ...writable, read_only: true, owner_attachment: { state: 'incompatible', reason: 'native_clarify_batch_unavailable', can_submit: false, can_interrupt: false, can_attach: false, restarting: false, revision: null, execution_generation: null, admissions: [] } })
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

  it.each([true, false])('a no-speech recording restores the starting draft and says so, append: %s (TAL-1608)', async (append) => {
    vi.mocked(api.fetchTranscribeCapability).mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: true, warm_supported: false })
    let onText: (text: string) => void = noop
    let onEnd: (error: unknown) => void = noop
    vi.mocked(dictateLive).mockImplementation((text, end) => { onText = text; onEnd = end; return { stop: vi.fn(), cancel: vi.fn() } })
    vi.mocked(showToast).mockClear()
    renderComposer({ ...writable, is_streaming: false }, null, noop, { dictation_append: append })
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'Note:' } })
    await userEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => { onText('Ship the') })
    await userEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    act(() => { onEnd(new NoSpeechError()) })
    expect(box).toHaveValue('Note:')
    expect(showToast).toHaveBeenCalledWith('No speech detected. Try again.', 3000, 'error')
    expect(api.startChat).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Dictate' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('a no-speech result before any partial leaves text typed during the recording alone (TAL-1608)', async () => {
    vi.mocked(api.fetchTranscribeCapability).mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: true, warm_supported: false })
    let onEnd: (error: unknown) => void = noop
    vi.mocked(dictateLive).mockImplementation((_text, end) => { onEnd = end; return { stop: vi.fn(), cancel: vi.fn() } })
    vi.mocked(showToast).mockClear()
    renderComposer({ ...writable, is_streaming: false })
    const box = screen.getByRole('textbox')
    await userEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    fireEvent.change(box, { target: { value: 'typed meanwhile' } })
    act(() => { onEnd(new NoSpeechError()) })
    expect(box).toHaveValue('typed meanwhile')
    expect(showToast).toHaveBeenCalledWith('No speech detected. Try again.', 3000, 'error')
  })

  it('a no-speech result keeps edits made after a partial (TAL-1608)', async () => {
    vi.mocked(api.fetchTranscribeCapability).mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: true, warm_supported: false })
    let onText: (text: string) => void = noop
    let onEnd: (error: unknown) => void = noop
    vi.mocked(dictateLive).mockImplementation((text, end) => { onText = text; onEnd = end; return { stop: vi.fn(), cancel: vi.fn() } })
    vi.mocked(showToast).mockClear()
    renderComposer({ ...writable, is_streaming: false })
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'Note:' } })
    await userEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => { onText('Ship the') })
    await userEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    fireEvent.change(box, { target: { value: 'Note: Ship the docs' } })
    act(() => { onEnd(new NoSpeechError()) })
    expect(box).toHaveValue('Note: Ship the docs')
    expect(showToast).toHaveBeenCalledWith('No speech detected. Try again.', 3000, 'error')
  })

  it('a genuine dictation failure stays a visible error and keeps the partial text (TAL-1608)', async () => {
    vi.mocked(api.fetchTranscribeCapability).mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: true, warm_supported: false })
    let onText: (text: string) => void = noop
    let onEnd: (error: unknown) => void = noop
    vi.mocked(dictateLive).mockImplementation((text, end) => { onText = text; onEnd = end; return { stop: vi.fn(), cancel: vi.fn() } })
    vi.mocked(showToast).mockClear()
    renderComposer({ ...writable, is_streaming: false })
    const box = screen.getByRole('textbox')
    await userEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
    act(() => { onText('Ship the') })
    act(() => { onEnd(new Error("STT command provider 'x' exited with code 3")) })
    expect(box).toHaveValue('Ship the')
    expect(showToast).toHaveBeenCalledWith("Voice input error: STT command provider 'x' exited with code 3", 3000, 'error')
  })

  it.each([
    ['live', true], ['live', false], ['browser', true], ['browser', false],
  ] as const)('keeps quotes after late %s dictation results, append: %s', async (backend, append) => {
    let onText: (text: string) => void = noop
    let onEnd: (error: unknown) => void = noop
    const cancel = vi.fn()
    const stop = vi.fn()
    const recognizer: NonNullable<ReturnType<typeof browserDictation.createRecognition>> = {
      lang: 'en', interimResults: true, continuous: false, onresult: null, onerror: null, onend: null, start: vi.fn(), stop,
    }
    const supported = vi.spyOn(browserDictation, 'dictationSupported').mockReturnValue(backend === 'browser')
    const create = vi.spyOn(browserDictation, 'createRecognition').mockReturnValue(recognizer)
    if (backend === 'live') {
      vi.mocked(api.fetchTranscribeCapability).mockResolvedValue({ ok: true, available: true, provider: 'openai', streaming: true, warm_supported: false })
      vi.mocked(dictateLive).mockImplementation((text, end) => { onText = text; onEnd = end; return { stop, cancel } })
    }
    const view = renderComposer(writable, null, noop, { dictation_append: append })
    try {
      const box = screen.getByRole('textbox')
      fireEvent.change(box, { target: { value: 'Note:' } })
      await userEvent.click(await screen.findByRole('button', { name: 'Dictate' }))
      if (backend === 'browser') {
        const result = recognizer.onresult!
        const end = recognizer.onend!
        onText = (text) => result({ results: [Object.assign([{ transcript: text }], { isFinal: false })] })
        onEnd = () => end()
      }
      const lateText = onText, lateEnd = onEnd
      act(() => { onText('spoken') })
      const expected = `${append ? 'Note: spoken' : 'spoken'}\n\n> Selected\n\n`
      act(() => { returnToComposer('s1', 'Selected', 'quote') })
      act(() => { lateText('late speech'); lateEnd(null) })
      expect(box).toHaveValue(expected)
      expect(backend === 'live' ? cancel : stop).toHaveBeenCalledOnce()
      expect(screen.getByRole('button', { name: 'Dictate' })).toHaveAttribute('aria-pressed', 'false')
      await userEvent.click(screen.getByRole('button', { name: 'Dictate' }))
      act(() => { lateText('older capture'); lateEnd(null) })
      expect(box).toHaveValue(expected)
      expect(screen.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true')
    } finally { view.unmount(); supported.mockRestore(); create.mockRestore() }
  })

  it('keeps the browser recognizer path when the server reports no streaming (TAL-802)', async () => {
    renderComposer({ ...writable, is_streaming: false })
    await waitFor(() => { expect(api.fetchTranscribeCapability).toHaveBeenCalled() })
    // jsdom has no SpeechRecognition, so without the stream there is no dictation control at all.
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull()
    expect(dictateLive).not.toHaveBeenCalled()
  })

  it('offers no send, command or session controls for a session the server marks read-only (TAL-312)', () => {
    renderComposer({ session_id: 'child', title: 'Delegated child', is_streaming: false, read_only: true, can_branch: false, can_pin: false, can_archive: false, can_delete: false, can_duplicate: false, can_share: true, source_tag: 'subagent', source_kind: 'subagent', is_messaging_session: false, sort_ts: 0 })
    expect(screen.getByRole('note')).toHaveTextContent('read-only')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull()
  })

  const writable: Session = { session_id: 's1', title: 'Mine', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0 }
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
    await userEvent.click(await screen.findByRole('button', { name: 'Background work · 1' }))
    expect(within(await screen.findByRole('dialog', { name: 'Background work' })).getByRole('region', { name: 'Background work' })).toHaveTextContent('summarize repo')
  })

  it('shows a /background launch at once and puts the prompt back when the server refuses it (TAL-1384)', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.startBackground).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [] })
    renderComposer({ ...writable, is_streaming: false })
    await waitFor(() => expect(api.fetchBackgroundTasks).toHaveBeenCalled())
    await userEvent.type(screen.getByRole('textbox'), '/background summarize repo{Enter}')
    expect(await screen.findByRole('button', { name: 'Background work · 1' })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
    await act(async () => { refuse(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'Background work is off' })); await Promise.resolve() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Background work · 1' })).toBeNull())
    expect(screen.getByRole('textbox')).toHaveValue('/background summarize repo')
    expect(api.startBackground).toHaveBeenCalledOnce()
  })

  it.each([
    ['started', true],
    ['never started', false],
  ] as const)('rereads background work after a lost /background answer and restores the prompt only if nothing started: %s (TAL-1384)', async (_, started) => {
    vi.mocked(api.startBackground).mockRejectedValue(new ApiError({ kind: 'network', path: '/x', message: 'Network down' }))
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [] })
    renderComposer({ ...writable, is_streaming: false })
    await waitFor(() => expect(api.fetchBackgroundTasks).toHaveBeenCalled())
    const reads = vi.mocked(api.fetchBackgroundTasks).mock.calls.length
    if (started) vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [{ task_id: 'bg9', kind: 'background_command', status: 'running', title: 'summarize repo', started_at: 1, updated_at: 1, completed_at: null, result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true }] })
    await userEvent.type(screen.getByRole('textbox'), '/background summarize repo{Enter}')
    await waitFor(() => expect(vi.mocked(api.fetchBackgroundTasks).mock.calls.length).toBeGreaterThan(reads))
    if (started) {
      expect(await screen.findByRole('button', { name: 'Background work · 1' })).toBeInTheDocument()
      expect(screen.getByRole('textbox')).toHaveValue('')
    } else {
      await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('/background summarize repo'))
      expect(screen.queryByRole('button', { name: /Background work/ })).toBeNull()
    }
    expect(api.startBackground).toHaveBeenCalledOnce()
  })

  it('adopts the started background task in place of its provisional chip, without a duplicate (TAL-1384)', async () => {
    let start!: (value: { ok: true; task_id: string; stream_id: string; session_id: string }) => void
    vi.mocked(api.startBackground).mockReturnValue(new Promise((resolve) => { start = resolve }) as never)
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [] })
    renderComposer({ ...writable, is_streaming: false })
    await waitFor(() => expect(api.fetchBackgroundTasks).toHaveBeenCalled())
    await userEvent.type(screen.getByRole('textbox'), '/background summarize repo{Enter}')
    expect(await screen.findByRole('button', { name: 'Background work · 1' })).toBeInTheDocument()
    const reads = vi.mocked(api.fetchBackgroundTasks).mock.calls.length
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 's1', agent_available: true, tasks: [{ task_id: 'bg1', kind: 'background_command', status: 'running', title: 'summarize repo', started_at: 1, updated_at: 1, completed_at: null, result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true }] })
    await act(async () => { start({ ok: true, task_id: 'bg1', stream_id: 'bgs', session_id: 'hidden' }); await Promise.resolve() })
    await waitFor(() => expect(vi.mocked(api.fetchBackgroundTasks).mock.calls.length).toBeGreaterThan(reads))
    await userEvent.click(await screen.findByRole('button', { name: 'Background work · 1' }))
    const card = within(await screen.findByRole('dialog', { name: 'Background work' })).getByRole('region', { name: 'Background work' })
    expect(within(card).getAllByText('summarize repo')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Background work · 2' })).toBeNull()
    expect(api.startBackground).toHaveBeenCalledOnce()
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
    await waitFor(() => expect(api.execCommand).toHaveBeenCalledWith('/reload_skills', 's1', expect.any(AbortSignal)))
    const openOutput = async () => { await userEvent.click(await screen.findByRole('button', { name: /^Command output: \/reload/ })); return screen.findByRole('region', { name: 'Command output' }) }
    await waitFor(() => expect(screen.getByRole('button', { name: /^Command output:/ })).not.toHaveTextContent('Running'))
    // Screen readers hear the output without opening it.
    expect(within(document.querySelector<HTMLElement>('[data-notice="command"]')!).getByRole('status')).toHaveTextContent('Total skills: 5')
    const output = await openOutput()
    await waitFor(() => { expect(output).toHaveTextContent('Total skills: 5') }, { timeout: 5000 })
    await userEvent.keyboard('{Escape}')
    expect(box).toHaveValue('')
    expect(onLocalCommand).not.toHaveBeenCalled()
    expect(api.startChat).not.toHaveBeenCalled()

    vi.mocked(api.execCommand).mockRejectedValue(new Error('Hermes Agent sidecar is not running'))
    await userEvent.type(box, '/reload-skills {Enter}')
    await waitFor(() => expect(document.querySelector('[data-notice="command"]')).toHaveAttribute('data-tone', 'error'))
    expect(await openOutput()).toHaveTextContent('Command failed: Hermes Agent sidecar is not running')
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
    await userEvent.click(await screen.findByRole('button', { name: 'Side question — not in history: how big is it?' }))
    const panel = await screen.findByRole('region', { name: 'Side question — not in history' })
    expect(panel).toHaveTextContent('how big is it?')
    await waitFor(() => expect(side).not.toBeNull())
    act(() => { side!.onEvent({ event: 'token', data: { text: 'Three' } }, 'side:1') })
    expect(panel).toHaveTextContent('Three')
    act(() => { side!.onEvent({ event: 'done', data: { ephemeral: true, answer: 'Three nodes.', terminal_state: 'completed' } }, 'side:2') })
    expect(panel).toHaveTextContent('Three nodes.')
    expect(closed).toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
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

  it('quotes multi-line selected text after the exact draft and preserves its cursor and attachments', async () => {
    vi.mocked(api.uploadFile).mockResolvedValue({ filename: 'notes.txt', path: '/synthetic/notes.txt', size: 1, mime: 'text/plain' })
    const view = renderComposer(writable)
    const box = screen.getByRole<HTMLTextAreaElement>('textbox')
    fireEvent.change(box, { target: { value: 'Draft  ' } })
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    await screen.findByText('notes.txt')
    box.setSelectionRange(2, 4, 'backward')
    act(() => { returnToComposer('s1', '**Markdown**\n\n```ts\nconst café = "🦜"\n```', 'quote') })
    expect(box).toHaveValue('Draft  \n\n> **Markdown**\n> \n> ```ts\n> const café = "🦜"\n> ```\n\n')
    expect([box.selectionStart, box.selectionEnd, box.selectionDirection]).toEqual([2, 4, 'backward'])
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    expect(api.startChat).not.toHaveBeenCalled()
    expect(api.steerChat).not.toHaveBeenCalled()
  })

  it('ignores empty, oversized, wrong-chat and unmounted selection quotes without buffering them', () => {
    const view = renderComposer(writable)
    const box = screen.getByRole('textbox')
    for (const selected of ['', '  \n', 'x'.repeat(16_001)]) act(() => { returnToComposer('s1', selected, 'quote') })
    act(() => { returnToComposer('other-session', 'wrong chat', 'quote') })
    expect(box).toHaveValue('')
    view.unmount()
    act(() => { returnToComposer('s1', 'after unmount', 'quote') })
    renderComposer(writable)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('does not deliver a quote across a chat switch', () => {
    const view = renderComposer(writable)
    view.rerenderSession({ ...writable, session_id: 'other-session' })
    act(() => { returnToComposer('s1', 'old selection', 'quote') })
    view.rerenderSession(writable)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('preserves the last composer cursor when browser selection resets the inactive textarea', () => {
    renderComposer(writable, null, noop, undefined, undefined, undefined, { locked: true })
    const box = screen.getByRole<HTMLTextAreaElement>('textbox')
    fireEvent.change(box, { target: { value: 'My draft' } })
    act(() => { box.focus(); box.setSelectionRange(2, 4, 'backward') })
    fireEvent.select(box)
    act(() => { box.blur(); box.setSelectionRange(0, 0) })
    act(() => { returnToComposer('s1', 'Selected', 'quote') })
    expect(box).toHaveValue('My draft\n\n> Selected\n\n')
    expect([box.selectionStart, box.selectionEnd, box.selectionDirection]).toEqual([2, 4, 'backward'])
    expect(api.startChat).not.toHaveBeenCalled()
  })

  it('keeps the composer for a writable session', () => {
    renderComposer({ session_id: 'mine', title: 'Mine', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0 })
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
  it('shows the running turn as a floating chip and fades it out when the turn ends (TAL-1078)', async () => {
    const { container, rerenderWith } = renderComposer(writable, running())
    expect(container.querySelector('.composer-notices .live-run-status')).toHaveTextContent('Working')
    dispatch({ type: 'event', sessionId: 's1', streamId: 'run', event: { event: 'done', data: {} }, lastEventId: 'run:1', now: 1 })
    rerenderWith(getStreamState().turns.s1!)
    // The ended chip stays inert for its exit fade, then the row is gone and leaves no space.
    expect(container.querySelector('[data-notice="live"]')).toHaveClass('is-leaving')
    expect(container.querySelector('[data-notice="live"]')).toHaveAttribute('inert')
    await waitFor(() => expect(container.querySelector('.composer-notices')).toBeNull())
  })
  it('floats the run status beside a separate queued-count chip that opens the queue in a dialog (TAL-1078)', async () => {
    const queued: QueuedTurn[] = [{ id: 'q1', text: 'Queued one', attachments: [], request: { profile: 'default' } }, { id: 'q2', text: 'Queued two', attachments: [], request: { profile: 'default' } }]
    const onQueueChange = vi.fn()
    renderComposer(writable, running(), noop, undefined, undefined, undefined, { queued, onQueueChange })
    await userEvent.type(screen.getByRole('textbox'), 'Draft kept')
    expect(document.querySelector('.composer-tab')).toBeNull()
    const run = document.querySelector<HTMLElement>('[data-notice="live"]')!
    expect(run).toHaveTextContent('Working')
    // The run status is not a control, and the queue's rows stay out of the composer until asked for.
    expect(within(run).queryByRole('button')).toBeNull()
    expect(screen.queryByText('Queued one')).toBeNull()
    const chip = screen.getByRole('button', { name: '2 queued' })
    await userEvent.click(chip)
    const dialog = await screen.findByRole('dialog', { name: '2 queued' })
    expect(within(dialog).getByText('Queued one')).toBeVisible()
    expect(within(dialog).getByText('Queued two')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(chip).toHaveFocus()
    expect(onQueueChange).not.toHaveBeenCalled()
    expect(api.startChat).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('Draft kept')
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

  it('keeps the phone settings panel open for presses inside a menu it opened, and closes it for presses elsewhere (TAL-1131)', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia
    // jsdom lays nothing out; a measured footer lets the phone fit pass move the chips into the panel.
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320)
    renderComposer({ ...writable, is_streaming: false })
    act(() => screen.getByRole('textbox').focus())
    const toggle = document.querySelector<HTMLElement>('#composerMobileConfigBtn')!
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(within(document.querySelector<HTMLElement>('#composerMobileConfigPanel')!).getByRole('button', { name: /^Reasoning effort:/ }))
    // The menu is portaled outside the composer box, yet a press in it belongs to the panel that opened it.
    fireEvent.pointerDown(await screen.findByRole('menuitemradio', { name: 'high' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerDown(document.body)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    width.mockRestore()
  })

  it('keeps a phone composer\'s empty strip while its chips take focus or a tap, and folds it once focus leaves (TAL-698)', async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: noop, removeEventListener: noop })) as unknown as typeof window.matchMedia
    renderComposer({ ...writable, is_streaming: false })
    const strip = () => document.querySelector('.composer-strip')
    const outside = document.body.appendChild(document.createElement('button'))
    expect(strip()).toBeNull()
    act(() => screen.getByRole('textbox').focus())
    const chip = document.querySelector<HTMLElement>('.composer-toolsets-chip')!
    act(() => chip.focus())
    expect(strip()).not.toBeNull()
    // iOS focuses nothing on a tapped button: the blur lands on no element, but the tap began in the strip.
    fireEvent.pointerDown(chip)
    act(() => chip.blur())
    expect(strip()).not.toBeNull()
    fireEvent.click(chip)
    // Once the tap has run its course, the chip's open menu still holds the strip.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(strip()).not.toBeNull()
    act(() => outside.focus())
    expect(strip()).toBeNull()
    // A tap on a bare part of the strip moves focus nowhere and opens nothing, so the composer folds when it ends.
    act(() => screen.getByRole('textbox').focus())
    fireEvent.pointerDown(strip()!)
    act(() => screen.getByRole('textbox').blur())
    fireEvent.click(strip()!)
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(strip()).toBeNull()
    // Focus leaving for nowhere without a tap in the composer (a dismissed keyboard) folds it too.
    act(() => screen.getByRole('textbox').focus())
    expect(strip()).not.toBeNull()
    act(() => screen.getByRole('textbox').blur())
    expect(strip()).toBeNull()
    outside.remove()
  })
})
