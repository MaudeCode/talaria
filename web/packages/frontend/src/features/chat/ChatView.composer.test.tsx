import type { FunctionComponent, MemoExoticComponent } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { configureClient, resetClientForTests } from '../../api/client'
import { createMemoryAdapter } from '../../contracts/adapters/memory'
import * as toast from '../toast/toast'
import { keys } from '../../api/queryKeys'
import { sessionFixture } from '../../test/fixtures'
import type { ChatEvent } from '../../contracts/sse'
import { dispatch, resetStreamStoreForTests } from '../../stream/store'
import { resetConnectionsForTests } from '../../stream/connection'

const { composerRenders, statusRenders, navigate } = vi.hoisted(() => ({ composerRenders: vi.fn(), statusRenders: vi.fn(), navigate: vi.fn() }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<object>(), useNavigate: () => navigate, useSearch: () => ({}) }))
vi.mock('../../shell/AppShell', () => ({ MAIN_VIEW: '' }))
vi.mock('../../app/bootstrap', async (original) => {
  const { DEFAULT_BOOTSTRAP } = await import('../../contracts/adapters/memory')
  return { ...await original<object>(), useBootstrap: () => DEFAULT_BOOTSTRAP }
})
vi.mock('../../app/queries', async (original) => {
  const settings = { auto_scroll_follow: false }
  return { ...await original<object>(), useSettingsQuery: () => ({ data: settings }), useWorkspacesQuery: () => ({ data: { workspaces: [] } }) }
})
vi.mock('./ChatSidePanel', () => ({ ChatSidePanel: () => null }))
vi.mock('./useMarkViewed', () => ({ useMarkViewed: () => undefined }))
vi.mock('../../shell/ProfileMenu', () => ({ ProfileMenu: () => null }))
vi.mock('../../api/endpoints', async (original) => ({
  ...await original<object>(), fetchSession: vi.fn(),
  fetchSessionYolo: () => Promise.resolve({ yolo_enabled: false }),
  fetchReasoning: () => Promise.resolve({ reasoning_effort: null }),
  fetchClarifyPending: () => Promise.resolve({ pending: null }),
  fetchAgentHealth: () => Promise.resolve({ alive: true }),
  fetchTranscribeCapability: () => Promise.resolve({ streaming: false }),
  fetchBackgroundTasks: () => Promise.resolve({ tasks: [] }),
  fetchCommands: () => Promise.resolve({ commands: [] }),
  fetchModels: () => Promise.resolve({ models: [], groups: [] }),
  fetchToolsetsCatalog: () => Promise.resolve({ toolsets: [] }),
  fetchDraft: () => Promise.resolve({ draft: { text: '' }, draft_version: '0' }),
  saveDraft: () => Promise.resolve({ draft_version: '1' }),
}))
// Count the real body, retaining React.memo when present. No production test props.
vi.mock('../composer/Composer', async (original) => {
  const module = await original<typeof import('../composer/Composer')>()
  const component = module.Composer
  if (typeof component === 'function') return { ...module, Composer: (props: Parameters<typeof component>[0]) => { composerRenders(); return component(props) } }
  const memo = component as MemoExoticComponent<FunctionComponent<import('../composer/Composer').ComposerProps>>
  return { ...module, Composer: { ...memo, type: (props: import('../composer/Composer').ComposerProps) => { composerRenders(); return memo.type(props) } } }
})
vi.mock('./LiveTurnView', async (original) => {
  const module = await original<typeof import('./LiveTurnView')>()
  return { ...module, LiveStatusPill: (props: Parameters<typeof module.LiveStatusPill>[0]) => { statusRenders(); return module.LiveStatusPill(props) } }
})

const { ChatView } = await import('./ChatView')
const api = await import('../../api/endpoints')

beforeEach(() => {
  vi.clearAllMocks()
  resetStreamStoreForTests()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { resetClientForTests(); resetConnectionsForTests(); vi.restoreAllMocks() })

it('renders the composer once for a draft while only its status pill follows three token frames', async () => {
  const session = sessionFixture({ session_id: 'composer-chat', worktree_branch: 'synthetic-worktree', messages: [{ id: 1, role: 'user', content: 'Question' }] })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  dispatch({ type: 'start', sessionId: session.session_id, streamId: 'live-run', turnId: null, userMessageId: null, userText: 'Next question', now: Date.now() })
  const view = render(<QueryClientProvider client={qc}><ChatView sessionId={session.session_id} /></QueryClientProvider>)
  await waitFor(() => expect(qc.isFetching()).toBe(0))
  composerRenders.mockClear()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Check the logs too' } })
  expect(composerRenders).toHaveBeenCalledOnce()
  statusRenders.mockClear()
  for (const [index, text] of ['First', ' second', ' third'].entries()) {
    act(() => dispatch({ type: 'event', sessionId: session.session_id, streamId: 'live-run', event: { event: 'token', data: { text } }, lastEventId: `live-run:${index + 1}`, now: Date.now() }))
    await screen.findByText(['First', 'First second', 'First second third'][index]!)
  }
  expect(composerRenders).toHaveBeenCalledOnce()
  expect(statusRenders).toHaveBeenCalledTimes(3)
  expect(screen.getByRole('textbox')).toHaveValue('Check the logs too')
  expect(view.container.querySelector('#btnStop')).toBeInTheDocument()

  let seq = 3
  const emit = (event: ChatEvent) => act(() => dispatch({ type: 'event', sessionId: session.session_id, streamId: 'live-run', event, lastEventId: `live-run:${++seq}`, now: Date.now() }))
  emit({ event: 'metering', data: { tps: 42 } })
  await screen.findByText('42.0 tok/s')
  expect(composerRenders).toHaveBeenCalledOnce()
  act(() => dispatch({ type: 'connection', sessionId: session.session_id, streamId: 'live-run', status: 'reconnecting' }))
  expect(view.container.querySelector('.live-run-label')).toHaveTextContent('Reconnecting')
  expect(composerRenders).toHaveBeenCalledOnce()

  emit({ event: 'warning', data: { message: 'Synthetic provider warning' } })
  await waitFor(() => expect(view.container.querySelector('[data-notice="runtime:provider_failure"]')).toBeInTheDocument())
  const withWarning = composerRenders.mock.calls.length
  emit({ event: 'token', data: { text: ' fourth' } })
  await screen.findByText('First second third fourth')
  expect(composerRenders).toHaveBeenCalledTimes(withWarning)

  // Real metadata and terminal transitions must still cross the memo boundary.
  act(() => qc.setQueryData(keys.sessions.detail(session.session_id), { session: { ...session, model: 'updated-model' } }))
  await waitFor(() => expect(view.container.querySelector('#composerModelChip')).toHaveTextContent('updated-model'))
  emit({ event: 'done', data: {} })
  await waitFor(() => expect(view.container.querySelector('#btnStop')).not.toBeInTheDocument())
  expect(screen.getByRole('textbox')).toHaveValue('Check the logs too')
  view.unmount()
  qc.clear()
})

it.each(['high', 'default'])('routes native /reasoning %s with the current conversation and never retries globally', async (effort) => {
  const session = sessionFixture({ session_id: 'native-reasoning', model: 'native-model', model_provider: 'openai', read_only: true,
    owner_attachment: { state: 'attached', reason: null, restarting: false, can_submit: true, can_interrupt: false, can_attach: false, revision: 1, execution_generation: 1, admissions: [] } })
  const adapter = createMemoryAdapter({ routes: { 'POST /api/reasoning': () => [409, { error: 'Reasoning changes are unavailable for this conversation', code: 'reasoning_unsupported' }] } })
  configureClient({ transport: adapter })
  const ownerAction = vi.spyOn(api, 'ownerAction')
  const showToast = vi.spyOn(toast, 'showToast').mockImplementation(() => undefined)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  const view = render(<QueryClientProvider client={qc}><ChatView sessionId={session.session_id} /></QueryClientProvider>)
  await waitFor(() => expect(qc.isFetching()).toBe(0))
  expect(view.container.querySelector('.composer-reasoning-wrap')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: `/reasoning ${effort}` } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(adapter.calls.filter((call) => call.url.pathname.endsWith('/api/reasoning'))).toHaveLength(1))
  expect(JSON.parse(adapter.calls.find((call) => call.url.pathname.endsWith('/api/reasoning'))!.body as string)).toEqual({ effort: effort === 'default' ? '' : effort, model: session.model, provider: session.model_provider, session_id: session.session_id })
  await waitFor(() => expect(showToast).toHaveBeenCalledWith('Reasoning changes are unavailable for this conversation', 4000, 'error'))
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(ownerAction).not.toHaveBeenCalled()
  expect(adapter.calls.filter((call) => call.url.pathname.endsWith('/api/reasoning'))).toHaveLength(1)
  view.unmount()
  qc.clear()
})

it.each([
  ['shown', 200, null],
  ['refused', 400, 'Reasoning display is locked'],
] as const)('finishes /reasoning hide at once and reports only a refusal: %s (TAL-1384)', async (_, status, error) => {
  let answer!: () => void
  const held = new Promise<void>((resolve) => { answer = resolve })
  const adapter = createMemoryAdapter({ routes: { 'POST /api/reasoning': async () => { await held; return status === 200 ? [200, { show_reasoning: false }] : [status, { error }] } } })
  configureClient({ transport: adapter })
  const showToast = vi.spyOn(toast, 'showToast').mockImplementation(() => undefined)
  const session = sessionFixture({ session_id: 'display-chat', model: 'shared-model' })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api.fetchSession).mockResolvedValue({ session })
  qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  const view = render(<QueryClientProvider client={qc}><ChatView sessionId={session.session_id} /></QueryClientProvider>)
  await waitFor(() => expect(qc.isFetching()).toBe(0))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/reasoning hide' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
  await waitFor(() => expect(adapter.calls.filter((call) => call.url.pathname.endsWith('/api/reasoning'))).toHaveLength(1))
  expect(JSON.parse(adapter.calls.find((call) => call.url.pathname.endsWith('/api/reasoning'))!.body as string)).toEqual({ display: 'hide' })
  answer()
  if (error) await waitFor(() => expect(showToast).toHaveBeenCalledWith(error, 4000, 'error'))
  else { await waitFor(() => expect(qc.isMutating()).toBe(0)); expect(showToast).not.toHaveBeenCalledWith(expect.anything(), 4000, 'error') }
  view.unmount()
  qc.clear()
})

it('routes picker effort and reset through the current direct-chat identity after navigation', async () => {
  const adapter = createMemoryAdapter({ routes: { 'POST /api/reasoning': () => [200, { show_reasoning: false, reasoning_effort: 'high' }] } })
  configureClient({ transport: adapter })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const first = sessionFixture({ session_id: 'first-direct', model: 'shared-model' })
  const second = sessionFixture({ session_id: 'second-direct', model: 'shared-model' })
  for (const session of [first, second]) qc.setQueryData(keys.sessions.detail(session.session_id), { session })
  vi.mocked(api.fetchSession).mockImplementation((id) => Promise.resolve({ session: id === first.session_id ? first : second }))
  const view = render(<QueryClientProvider client={qc}><ChatView sessionId={first.session_id} /></QueryClientProvider>)
  await waitFor(() => expect(qc.isFetching()).toBe(0))
  fireEvent.click(view.container.querySelector('#composerReasoningChip')!)
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'high' }))
  await waitFor(() => expect(adapter.calls).toHaveLength(1))
  expect(JSON.parse(adapter.calls[0]!.body as string)).toEqual({ effort: 'high', model: 'shared-model', session_id: first.session_id })
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(view.container.querySelector('#composerReasoningChip')).toHaveAttribute('aria-expanded', 'false'))
  view.rerender(<QueryClientProvider client={qc}><ChatView sessionId={second.session_id} /></QueryClientProvider>)
  await waitFor(() => expect(qc.isFetching()).toBe(0))
  fireEvent.click(view.container.querySelector('#composerReasoningChip')!)
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Default' }))
  await waitFor(() => expect(adapter.calls).toHaveLength(2))
  expect(JSON.parse(adapter.calls[1]!.body as string)).toEqual({ effort: '', model: 'shared-model', session_id: second.session_id })
  view.unmount()
  qc.clear()
})
