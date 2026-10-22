import type { FunctionComponent, MemoExoticComponent, NamedExoticComponent } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VisibleMessage } from './useTranscript'
import { keys } from '../../api/queryKeys'
import { sessionFixture } from '../../test/fixtures'
import { dispatch, resetStreamStoreForTests } from '../../stream/store'
import { resetConnectionsForTests } from '../../stream/connection'
import { ApiError } from '../../contracts/common'

const { renders, navigate, composer } = vi.hoisted(() => ({ renders: vi.fn(), navigate: vi.fn(), composer: vi.fn() }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<object>(), useNavigate: () => navigate, useSearch: () => ({}) }))
vi.mock('../../shell/AppShell', () => ({ MAIN_VIEW: '' }))
vi.mock('../../app/bootstrap', async (original) => {
  const bootstrap = { profile: { name: 'default' }, assistant_name: 'Assistant', features: {} }
  return { ...await original<object>(), useBootstrap: () => bootstrap }
})
vi.mock('../../app/queries', () => ({ useSettingsQuery: () => ({ data: { auto_scroll_follow: false } }), useWorkspacesQuery: () => ({ data: { workspaces: [] } }) }))
vi.mock('../composer/Composer', () => ({ Composer: (props: unknown) => { composer(props); return null } }))
vi.mock('./ChatSidePanel', () => ({ ChatSidePanel: () => null }))
vi.mock('./useMarkViewed', () => ({ useMarkViewed: () => undefined }))
vi.mock('../../api/endpoints', async (original) => ({
  ...await original<object>(),
  fetchSession: vi.fn(),
  fetchSessionYolo: () => Promise.resolve({ yolo_enabled: false }),
  fetchReasoning: () => Promise.resolve({ reasoning_effort: null }),
  fetchClarifyPending: () => Promise.resolve({ pending: null }),
  fetchAgentHealth: () => Promise.resolve({ available: true }),
  branchSession: vi.fn(() => Promise.resolve({ session_id: 'branched' })),
  clearSession: vi.fn(), undoSession: vi.fn(), setSessionToolsets: vi.fn(), setSessionYolo: vi.fn(), setReasoningEffort: vi.fn(), setPersonality: vi.fn(), ownerAction: vi.fn(),
}))
// Probe the real row bodies inside their existing React.memo boundary, without a production test prop.
vi.mock('./MessageRow', async (original) => {
  const rows = await original<typeof import('./MessageRow')>()
  function probe<P extends { row: VisibleMessage }>(row: NamedExoticComponent<P>) {
    const component = row as unknown as MemoExoticComponent<FunctionComponent<P>>
    const body = component.type
    return { ...component, type: (props: P) => { renders(props.row.key); return body(props) } }
  }
  return { ...rows, UserMessageRow: probe(rows.UserMessageRow), AssistantMessageRow: probe(rows.AssistantMessageRow) }
})

const { ChatView } = await import('./ChatView')
const api = await import('../../api/endpoints')

beforeEach(() => {
  vi.clearAllMocks()
  resetStreamStoreForTests()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => { resetConnectionsForTests() })

function chat(streaming = true) {
  const session = sessionFixture({ session_id: 'memo-chat', messages: [
    { id: 1, role: 'user', content: 'Persisted question' },
    { id: 2, role: 'assistant', content: 'Persisted answer' },
  ] })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  if (streaming) dispatch({ type: 'start', sessionId: session.session_id, streamId: 'live-run', turnId: null, userMessageId: null, userText: 'Next question', now: Date.now() })
  const view = render(<QueryClientProvider client={qc}><ChatView sessionId={session.session_id} /></QueryClientProvider>)
  return { ...view, qc, session }
}

it('renders each persisted message once while three token frames update the live turn', async () => {
  const { container } = chat()
  await screen.findByText('Persisted answer')
  const persistedKeys = [...container.querySelectorAll('[data-message-key]:not([data-live-user])')].map((row) => row.getAttribute('data-message-key'))
  expect(persistedKeys).toHaveLength(2)
  for (const [index, text] of ['First', ' second', ' third'].entries()) {
    act(() => dispatch({ type: 'event', sessionId: 'memo-chat', streamId: 'live-run', event: { event: 'token', data: { text } }, lastEventId: `live-run:${index + 1}`, now: Date.now() }))
    await screen.findByText(['First', 'First second', 'First second third'][index]!)
  }
  expect(Object.fromEntries(persistedKeys.map((key) => [key, renders.mock.calls.filter(([rendered]) => rendered === key).length]))).toEqual(Object.fromEntries(persistedKeys.map((key) => [key, 1])))
})

it('updates streamed text without rendering composer controls again until turn state changes', async () => {
  chat()
  await screen.findByText('Persisted answer')
  const token = (text: string, seq: number) => act(() => dispatch({ type: 'event', sessionId: 'memo-chat', streamId: 'live-run', event: { event: 'token', data: { text } }, lastEventId: `live-run:${seq}`, now: Date.now() }))
  token('First', 1)
  await screen.findByText('First')
  composer.mockClear()
  let text = 'First'
  for (let seq = 2; seq <= 11; seq++) {
    token(` word${seq}`, seq)
    text += ` word${seq}`
    await screen.findByText(text)
  }
  expect(composer).not.toHaveBeenCalled()
  act(() => dispatch({ type: 'event', sessionId: 'memo-chat', streamId: 'live-run', event: { event: 'cancel', data: {} }, lastEventId: 'live-run:12', now: Date.now() }))
  await waitFor(() => expect(composer).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false })))
})

it('locks sending and shows the server restart state on a gateway-owned session', async () => {
  const owner = { state: 'attached' as const, reason: null, restarting: true, can_submit: false, can_interrupt: true, can_attach: false, revision: 1, execution_generation: 1, admissions: [] }
  const session = sessionFixture({ session_id: 'owner-chat', read_only: true, owner_attachment: owner })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  render(<QueryClientProvider client={qc}><ChatView sessionId={session.session_id} /></QueryClientProvider>)
  await waitFor(() => { expect(composer).toHaveBeenLastCalledWith(expect.objectContaining({ locked: true, notices: expect.arrayContaining([expect.objectContaining({ id: 'owner-restarting' })]) })) })
  act(() => { qc.setQueryData(keys.sessions.detail(session.session_id), { session: { ...session, owner_attachment: { ...owner, restarting: false, can_submit: true } } }) })
  await waitFor(() => { expect(composer).toHaveBeenLastCalledWith(expect.objectContaining({ locked: false })) })
  expect((composer.mock.lastCall?.[0] as { notices: { id: string }[] }).notices.some((notice) => notice.id === 'owner-restarting')).toBe(false)
})

it('updates row controls when the server changes read-only and branching capabilities', async () => {
  const { qc, session } = chat(false)
  expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Branch from here' }))
  await waitFor(() => expect(api.branchSession).toHaveBeenCalledWith('memo-chat', 1))
  act(() => { qc.setQueryData(keys.sessions.detail(session.session_id), { session: { ...session, read_only: true, can_branch: false } }) })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Regenerate response' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Branch from here' })).not.toBeInTheDocument()
  act(() => { qc.setQueryData(keys.sessions.detail(session.session_id), { session }) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Branch from here' })).toBeInTheDocument()
})

interface ComposerProps { session: { enabled_toolsets?: string[] | null; owner_attachment?: { admissions: { admission_id: string }[] } } | null; yolo: boolean; reasoning: string | null
  onToolsetsChange: (t: string[] | null) => void; onToggleYolo: () => void; onReasoningChange: (level: string | null) => void
  onLocalCommand: (name: string, args: string) => Promise<boolean | 'refused'>; onOwnerAction: (request: object) => Promise<void> }
const lastComposer = () => composer.mock.calls.at(-1)![0] as ComposerProps

it('shows toolsets, YOLO and reasoning choices to the composer before the writes answer (TAL-1384)', async () => {
  const held = () => new Promise<never>(() => undefined)
  vi.mocked(api.setSessionToolsets).mockReturnValue(held())
  vi.mocked(api.setSessionYolo).mockReturnValue(held())
  vi.mocked(api.setReasoningEffort).mockReturnValue(held())
  chat(false)
  await screen.findByText('Persisted answer')
  await waitFor(() => expect(lastComposer().session).not.toBeNull())
  act(() => { lastComposer().onToolsetsChange(['web']) })
  await waitFor(() => expect(lastComposer().session?.enabled_toolsets).toEqual(['web']))
  act(() => { lastComposer().onToggleYolo() })
  await waitFor(() => expect(lastComposer().yolo).toBe(true))
  act(() => { lastComposer().onReasoningChange('high') })
  await waitFor(() => expect(lastComposer().reasoning).toBe('high'))
  expect(api.setSessionToolsets).toHaveBeenCalledWith('memo-chat', ['web'])
  expect(api.setSessionYolo).toHaveBeenCalledWith('memo-chat', true)
})

it('rolls a refused YOLO change back and finishes /personality without waiting (TAL-1384)', async () => {
  let refuse!: (error: unknown) => void
  vi.mocked(api.setSessionYolo).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
  vi.mocked(api.setPersonality).mockReturnValue(new Promise(() => undefined) as never)
  chat(false)
  await screen.findByText('Persisted answer')
  await waitFor(() => expect(lastComposer().session).not.toBeNull())
  act(() => { lastComposer().onToggleYolo() })
  await waitFor(() => expect(lastComposer().yolo).toBe(true))
  await act(async () => { refuse(new ApiError({ kind: 'http', status: 403, path: '/x', message: 'Not allowed' })); await Promise.resolve() })
  await waitFor(() => expect(lastComposer().yolo).toBe(false))
  await expect(lastComposer().onLocalCommand('personality', 'pirate')).resolves.toBe(true)
  expect(api.setPersonality).toHaveBeenCalledWith('memo-chat', 'pirate')
})

it('drops a discarded owner input from the composer at once (TAL-1384)', async () => {
  const owner = { state: 'attached' as const, reason: null, restarting: false, can_submit: true, can_interrupt: true, can_attach: false, revision: 1, execution_generation: 1,
    admissions: [{ admission_id: 'a1', text: 'first', status: 'unknown', actions: ['retry', 'discard'], execution_generation: 1 }, { admission_id: 'a2', text: 'second', status: 'queued', actions: ['cancel'], execution_generation: 1 }] }
  const session = sessionFixture({ session_id: 'owner-chat', owner_attachment: owner as never })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  vi.mocked(api.ownerAction).mockReturnValue(new Promise(() => undefined) as never)
  render(<QueryClientProvider client={qc}><ChatView sessionId={session.session_id} /></QueryClientProvider>)
  await waitFor(() => expect(lastComposer().session?.owner_attachment?.admissions).toHaveLength(2))
  void lastComposer().onOwnerAction({ session_id: 'owner-chat', action: 'discard', admission_id: 'a1', execution_generation: 1 })
  await waitFor(() => expect(lastComposer().session?.owner_attachment?.admissions.map((a) => a.admission_id)).toEqual(['a2']))
})

it('empties the transcript on /clear and drops the last exchange on /undo before the server answers (TAL-1384)', async () => {
  vi.mocked(api.undoSession).mockReturnValue(new Promise(() => undefined) as never)
  chat(false)
  await screen.findByText('Persisted answer')
  await waitFor(() => expect(lastComposer().session).not.toBeNull())
  void lastComposer().onLocalCommand('undo', '')
  await waitFor(() => expect(screen.queryByText('Persisted question')).toBeNull())
  expect(screen.queryByText('Persisted answer')).toBeNull()
})

it('brings the transcript back when /clear is refused (TAL-1384)', async () => {
  let refuse!: (error: unknown) => void
  vi.mocked(api.clearSession).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
  chat(false)
  await screen.findByText('Persisted answer')
  await waitFor(() => expect(lastComposer().session).not.toBeNull())
  const result = lastComposer().onLocalCommand('clear', '')
  await waitFor(() => expect(screen.queryByText('Persisted answer')).toBeNull())
  await act(async () => { refuse(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'Busy' })); await Promise.resolve() })
  expect(await screen.findByText('Persisted answer')).toBeInTheDocument()
  await expect(result).resolves.toBe('refused')
})
