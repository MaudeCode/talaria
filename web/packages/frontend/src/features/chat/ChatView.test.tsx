import type { FunctionComponent, MemoExoticComponent, NamedExoticComponent } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VisibleMessage } from './useTranscript'
import { keys } from '../../api/queryKeys'
import { sessionFixture } from '../../test/fixtures'
import { dispatch, resetStreamStoreForTests } from '../../stream/store'
import { resetConnectionsForTests } from '../../stream/connection'

const { renders, navigate } = vi.hoisted(() => ({ renders: vi.fn(), navigate: vi.fn() }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<object>(), useNavigate: () => navigate, useSearch: () => ({}) }))
vi.mock('../../shell/AppShell', () => ({ MAIN_VIEW: '' }))
vi.mock('../../app/bootstrap', () => {
  const bootstrap = { profile: { name: 'default' }, assistant_name: 'Assistant', features: {} }
  return { useBootstrap: () => bootstrap }
})
vi.mock('../../app/queries', () => ({ useSettingsQuery: () => ({ data: { auto_scroll_follow: false } }), useWorkspacesQuery: () => ({ data: { workspaces: [] } }) }))
vi.mock('../composer/Composer', () => ({ Composer: () => null }))
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
