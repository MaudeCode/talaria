import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { DecisionReviewList } from '@maudecode/talaria-web-contracts'

vi.mock(import('../../api/endpoints'), async (original) => ({ ...await original(), fetchDecisionReviews: vi.fn() }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ title, children }: { title: string; children: React.ReactNode }) => <main><h1>{title}</h1>{children}</main> }))
import * as api from '../../api/endpoints'
import { DecisionsPage } from './DecisionsPage'

const progress = (answered: number, total: number) => ({ total, answered, deferred: 0, needs_review: 0 })
const LIST: DecisionReviewList = { empty: null, reviews: [
  { review_id: 'dr_00000002', session_id: 'sess_b', session_title: 'Release prep', title: 'Release choices', status: 'open', created_at: 2, progress: progress(1, 3) },
  { review_id: 'dr_00000001', session_id: 'sess_a', session_title: null, title: 'Storage choices', status: 'submitted', created_at: 1, progress: progress(2, 2) },
] }

afterEach(() => { cleanup(); vi.resetAllMocks() })

async function mount(list: DecisionReviewList) {
  vi.mocked(api.fetchDecisionReviews).mockResolvedValue(list)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> })
  const page = createRoute({ getParentRoute: () => root, path: '/decisions', component: DecisionsPage })
  const review = createRoute({ getParentRoute: () => root, path: '/decisions/$reviewId', component: () => <p>Review page</p> })
  const session = createRoute({ getParentRoute: () => root, path: '/session/$sessionId', component: () => <p>Session page</p> })
  const router = createRouter({ routeTree: root.addChildren([page, review, session]), history: createMemoryHistory({ initialEntries: ['/decisions'] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-section="decisions"] [data-decision-review]')]

it('lists the reviews in the server order with title, session title, answered of total and status (TAL-1966)', async () => {
  await mount(LIST)
  await screen.findByText('Release choices')
  expect(rows().map((row) => row.dataset.decisionReview)).toEqual(['dr_00000002', 'dr_00000001'])
  const [first, second] = rows() as [HTMLElement, HTMLElement]
  expect(first).toHaveAttribute('data-review-status', 'open')
  for (const text of ['Release choices', 'Open', 'Release prep', '1 of 3 answered']) expect(within(first).getByText(text)).toBeInTheDocument()
  // A session without a title still names the chat the review belongs to.
  for (const text of ['Storage choices', 'Submitted', 'Untitled', '2 of 2 answered']) expect(within(second).getByText(text)).toBeInTheDocument()
})

it('opens the review from its row and the chat from its session title', async () => {
  const router = await mount(LIST)
  await userEvent.click(await screen.findByRole('link', { name: 'Release choices' }))
  expect(router.state.location.pathname).toBe('/decisions/dr_00000002')
  await router.navigate({ to: '/decisions' })
  await userEvent.click(await screen.findByRole('link', { name: 'Open chat: Release prep' }))
  expect(router.state.location.pathname).toBe('/session/sess_b')
})

it('offers Open and Open chat in the row context menu', async () => {
  const router = await mount(LIST)
  await screen.findByText('Storage choices')
  fireEvent.contextMenu(rows()[1]!)
  const menu = await screen.findByRole('menu', { name: 'Decision review actions' })
  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open', 'Open chat'])
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Open chat' }))
  expect(router.state.location.pathname).toBe('/session/sess_a')
})

it.each([['none', 'No decision reviews yet'], ['closed', 'Every decision review is applied or cancelled']] as const)('shows the server\'s %s reason when nothing is listed', async (empty, text) => {
  await mount({ reviews: [], empty })
  expect(await screen.findByText(text)).toBeInTheDocument()
  expect(rows()).toEqual([])
})
