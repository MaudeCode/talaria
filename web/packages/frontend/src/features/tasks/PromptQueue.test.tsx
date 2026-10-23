import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PromptQueueRunSchema } from '@maudecode/talaria-web-contracts'
import fixtures from '../../../../../../contracts/fixtures/prompt-queues.json'
import { ApiError } from '../../contracts/common'
import { teardownAll } from '../../stream/connection'
import { useTasksWorkbench } from './TasksPage'

vi.mock(import('../../api/endpoints'), async (original) => ({
  ...await original(), fetchPromptQueues: vi.fn(), promptQueueAction: vi.fn(), editPromptQueue: vi.fn(), createPromptQueue: vi.fn(), fetchCrons: vi.fn(), fetchCronStatus: vi.fn(), fetchSessions: vi.fn(),
}))
vi.mock(import('../toast/errorToast'), async (original) => ({ ...await original(), showErrorToast: vi.fn() }))
import * as api from '../../api/endpoints'

const run = PromptQueueRunSchema.parse(fixtures.paused)
function Workbench() {
  const [selected, setSelected] = useState<string | null>(`queue:${run.id}`)
  const { sidebar, main } = useTasksWorkbench(selected, setSelected)
  return <><aside data-testid="sidebar">{sidebar}</aside><main data-testid="main">{main}</main></>
}
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><Workbench /></QueryClientProvider>)
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.mocked(api.fetchPromptQueues).mockResolvedValue({ runs: [run] })
  vi.mocked(api.fetchCrons).mockResolvedValue({ jobs: [], active_profile: 'default', all_profiles: false, other_profile_count: 0, unwritable_stores: [] })
  vi.mocked(api.fetchCronStatus).mockResolvedValue({ running: {} })
})
afterEach(() => { cleanup(); teardownAll(); vi.unstubAllGlobals() })

it('renders server progress in shared queue rows without dispatching during mount', async () => {
  mount()
  expect(await screen.findByRole('heading', { name: run.title })).toBeVisible()
  expect(screen.getByText('Review changes')).toBeVisible()
  expect(screen.getByText('Write checks')).toBeVisible()
  expect(screen.getByText('Completed')).toBeVisible()
  expect(screen.getByText('Queued')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled()
  expect(api.promptQueueAction).not.toHaveBeenCalled()
})

it('shows Resume immediately and rolls back a definite refusal using the existing mutation owner', async () => {
  let reject!: (error: unknown) => void
  vi.mocked(api.promptQueueAction).mockImplementation(() => new Promise((_yes, no) => { reject = no }))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Resume' }))
  await waitFor(() => expect(within(screen.getByTestId('main')).getByRole('status')).toHaveTextContent(/running/i))
  expect(within(screen.getByTestId('sidebar')).getByRole('button', { name: /Summarise the changes/ })).toHaveTextContent(/running/i)
  act(() => { reject(new ApiError({ kind: 'http', status: 409, path: '/api/prompt-queues', message: 'Stale revision' })) })
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeEnabled()
  expect(api.promptQueueAction).toHaveBeenCalledTimes(1)
  expect(api.promptQueueAction).toHaveBeenCalledWith({ id: run.id, revision: run.revision, action: 'resume' })
})

it('reconciles a lost action response and never replays it', async () => {
  vi.mocked(api.promptQueueAction).mockImplementation(() => {
    vi.mocked(api.fetchPromptQueues).mockResolvedValue({ runs: [PromptQueueRunSchema.parse(fixtures.unknown)] })
    return Promise.reject(new ApiError({ kind: 'network', path: '/api/prompt-queues', message: 'Lost ACK' }))
  })
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Resume' }))
  expect(await screen.findByRole('button', { name: 'Reconcile' })).toBeEnabled()
  expect(within(screen.getByTestId('main')).getByRole('status')).toHaveTextContent('Outcome unknown')
  expect(api.promptQueueAction).toHaveBeenCalledTimes(1)
})

it('fences a stale rendered action after the server/profile context changes', async () => {
  mount()
  const button = await screen.findByRole('button', { name: 'Resume' })
  act(() => { teardownAll() })
  await userEvent.click(button)
  expect(api.promptQueueAction).not.toHaveBeenCalled()
})

it('keeps two rapid saved-draft removals by carrying the first confirmed revision into the serialized edit', async () => {
  const third = { ...run.cards[1], session_id: 'synthetic-chat-c', request_id: 'synthetic-step-c', text: 'Publish the checks', title: 'Publish checks', status: 'waiting' as const }
  let saved = PromptQueueRunSchema.parse({ ...run, phase: 'draft', editable: true, actions: ['start', 'cancel'], cards: [...run.cards, third].map((card) => ({ ...card, status: 'waiting', stream_id: null, admission_id: null, outcome: null })) })
  vi.mocked(api.fetchPromptQueues).mockImplementation(() => Promise.resolve({ runs: [saved] }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let writes = 0
  vi.mocked(api.editPromptQueue).mockImplementation(async (input) => {
    writes += 1
    if (writes === 1) await gate
    if (input.revision !== saved.revision) throw new ApiError({ kind: 'http', status: 409, path: '/api/prompt-queues', message: 'Stale revision' })
    saved = { ...saved, revision: saved.revision + 1, cards: saved.cards.filter((card) => input.cards.some((next) => next.session_id === card.session_id)) }
    return saved
  })
  mount()
  const rows = () => within(screen.getByTestId('main')).getAllByRole('listitem')
  await screen.findByRole('heading', { name: run.title })
  await userEvent.click(screen.getAllByRole('button', { name: 'Cancel queued message' })[0]!)
  await waitFor(() => expect(api.editPromptQueue).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  await userEvent.click(screen.getAllByRole('button', { name: 'Cancel queued message' })[0]!)
  expect(rows()).toHaveLength(1)
  act(() => { release() })
  await waitFor(() => expect(api.editPromptQueue).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.editPromptQueue).mock.calls[1]?.[0].revision).toBe(run.revision + 1)
  await waitFor(() => expect(saved.cards).toHaveLength(1))
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toHaveTextContent('Publish the checks')
})
