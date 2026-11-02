import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import fixture from '../../../../../../contracts/fixtures/web-native-todos.json'
import { keys } from '../../api/queryKeys'

vi.mock('../../api/endpoints', () => ({ fetchSession: vi.fn(), fetchStreamStatus: vi.fn(), switchProfile: vi.fn(() => Promise.resolve({})) }))
vi.mock('../../api/sse', () => ({ SSE_CLOSED: 2, SSE_OPEN: 1, openSessionStream: vi.fn(() => ({ close: vi.fn(), readyState: () => 1 })), openChatStream: vi.fn() }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }))
const api = await import('../../api/endpoints')
const { TodosPage } = await import('./TodosPage')
const { useTranscript } = await import('../chat/useTranscript')
const { configureStream, resetConnectionsForTests } = await import('../../stream/connection')
const { useSwitchProfile } = await import('../../app/queries')

afterEach(() => { resetConnectionsForTests(); vi.mocked(api.fetchSession).mockReset() })

// TAL-1121: the real transcript query is the task list's only store, so every authoritative session replacement converges it.
it('hydrates a cold session task list and clears it on an accepted clear and a profile switch', async () => {
  const sid = fixture.session.session_id
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  configureStream({ queryClient: qc })
  vi.mocked(api.fetchSession).mockResolvedValue({ session: fixture.session } as Awaited<ReturnType<typeof api.fetchSession>>)
  let refresh!: ReturnType<typeof useTranscript>['refresh']
  let switchProfile!: ReturnType<typeof useSwitchProfile>['mutateAsync']
  // oxlint-disable-next-line react/globals -- the test harness hands its hook results to the test body.
  const Harness = () => { refresh = useTranscript(sid).refresh; switchProfile = useSwitchProfile().mutateAsync; return <TodosPage sessionId={sid} /> }
  render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>)
  expect(await screen.findByText('Owner task')).toBeVisible()

  const withoutTodos = { ...fixture.session, todo_state: undefined }
  await act(() => refresh({ ...withoutTodos, messages: [] }, true))
  expect(screen.queryByText('Owner task')).not.toBeInTheDocument()
  expect(screen.getByText('No task list for this conversation yet.')).toBeVisible()

  act(() => { qc.setQueryData(keys.sessions.detail(sid), { session: fixture.session }) })
  expect(await screen.findByText('Owner task')).toBeVisible()
  vi.mocked(api.fetchSession).mockResolvedValue({ session: { ...withoutTodos, messages: [] } } as Awaited<ReturnType<typeof api.fetchSession>>)
  await act(() => switchProfile('other'))
  expect(await screen.findByText('No task list for this conversation yet.')).toBeVisible()
  expect(screen.queryByText('Owner task')).not.toBeInTheDocument()
})
