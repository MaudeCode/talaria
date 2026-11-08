import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionReview } from '@maudecode/talaria-web-contracts'
import { DecisionsSearchSchema } from '../../contracts/url'
import { ApiError } from '../../contracts/common'
import { deferred } from '../../test/fixtures'

vi.mock(import('../../api/endpoints'), async (original) => ({ ...await original(), fetchDecisionReview: vi.fn(), answerDecision: vi.fn(), submitDecisionReview: vi.fn() }))
vi.mock(import('../../api/sse'), async (original) => ({ ...await original(), openSessionStream: vi.fn() }))
vi.mock('../toast/errorToast', () => ({ showErrorToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { openSessionStream } from '../../api/sse'
import { DecisionReviewPage } from './DecisionReviewPage'
import { DecisionReviewResult } from '../chat/blocks/OutboundDraftResult'

/** The recorded `decision_review_read` result (TAL-1963), reopened: a review the user is still answering. */
const recorded = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/sidecar/decisions.json'), 'utf8')) as { 'server.decision_review_read': { result: DecisionReview }[] })['server.decision_review_read'][0]!.result
const openReview = (): DecisionReview => ({ ...structuredClone(recorded), status: 'open', submitted_at: null, submit: { allowed: true, reason: null } })
const ID = recorded.review_id

afterEach(() => { cleanup(); vi.resetAllMocks() })
beforeEach(() => {
  window.scrollTo = vi.fn()
  vi.mocked(openSessionStream).mockReturnValue({ close: vi.fn(), readyState: () => 1 })
})

async function mount(path: string, review: DecisionReview = openReview()) {
  vi.mocked(api.fetchDecisionReview).mockResolvedValue(review)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Outlet /></QueryClientProvider> })
  const page = createRoute({ getParentRoute: () => root, path: '/decisions/$reviewId', validateSearch: DecisionsSearchSchema, component: function Page() {
    const { reviewId } = useParams({ strict: false }) as { reviewId: string }
    return <DecisionReviewPage reviewId={reviewId} search={useSearch({ strict: false })} />
  } })
  const session = createRoute({ getParentRoute: () => root, path: '/session/$sessionId', component: () => <p>Session page</p> })
  const router = createRouter({ routeTree: root.addChildren([page, session]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return { router, client }
}
const item = (id: string) => document.querySelector(`[data-decision-item="${id}"]`) as HTMLElement

describe('decision review: decide (TAL-1964)', () => {
  it('opens on the first item in the server order with every part of the decision', async () => {
    const review = openReview()
    // The retention item, which carries an example and sources, leads here.
    review.items = [review.items[2]!, review.items[0]!, review.items[1]!]
    await mount(`/decisions/${ID}`, review)
    const shown = await screen.findByRole('heading', { name: 'Session log retention' })
    expect(shown.closest('[data-section="decisions"]')).toHaveAttribute('data-decision-item', 'retention')
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    for (const text of ['How long should session logs be kept?', 'For example', 'With 30 days, a chat from early October is gone by November.', 'What happens today', 'Logs are kept forever.', 'Recommendation', 'Older logs are deleted nightly.']) expect(screen.getByText(text)).toBeInTheDocument()
    const choices = within(screen.getByRole('radiogroup')).getAllByRole('radio')
    expect(choices).toHaveLength(3)
    expect(document.querySelector('[data-recommended]')).toHaveAttribute('data-choice', '90d')
    expect(within(document.querySelector<HTMLElement>('[data-recommended]')!).getByText('Recommended')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com/docs/logging' })).toHaveAttribute('href', 'https://example.com/docs/logging')
    expect(screen.getByText('Technical details and sources').closest('details')).toBeInTheDocument()
    for (const name of ['Come back to this later', 'Use my notes as the answer', 'Back', 'Save & next']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument()
    // The saved answer is pre-selected and kept.
    expect(screen.getByRole('radio', { name: /Keep 30 days/ })).toBeChecked()
    expect(screen.getByText('Your earlier answer is kept')).toHaveAttribute('role', 'status')
  })

  it('shows a save at once, opens the next item and sends one versioned PUT', async () => {
    const reply = deferred<DecisionReview>()
    vi.mocked(api.answerDecision).mockReturnValue(reply.promise)
    await mount(`/decisions/${ID}`)
    await screen.findByRole('heading', { name: 'Autosave drafts' })
    await userEvent.click(screen.getByRole('radio', { name: /Save drafts/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Notes' }), 'Phones too')
    await userEvent.click(screen.getByRole('button', { name: 'Save & next' }))
    expect(await screen.findByRole('heading', { name: 'Crash reports' })).toBeInTheDocument()
    expect(api.answerDecision).toHaveBeenCalledTimes(1)
    expect(api.answerDecision).toHaveBeenCalledWith({ review_id: ID, item_id: 'autosave', value: 'on', notes: 'Phones too', deferred: false, custom: false, expected_version: 0, content_hash: recorded.items[0]!.content_hash })
    // Back to the saved item before the server answers: the selection is already there.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('radio', { name: /Save drafts/ })).toBeChecked()
    expect(item('autosave')).toHaveAttribute('data-answer', 'answered')
  })

  it('rolls a 409 answer_conflict back to the stored answer, keeps the typed notes and names the conflict', async () => {
    const stored = { value: 'off', label: 'Do not save', effect: 'Drafts are lost on reload.', notes: 'From the phone', deferred: false, custom: false, version: 1, updated_at: 1_794_000_200 }
    const reply = deferred<DecisionReview>()
    vi.mocked(api.answerDecision).mockReturnValue(reply.promise)
    await mount(`/decisions/${ID}`)
    await screen.findByRole('heading', { name: 'Autosave drafts' })
    await userEvent.click(screen.getByRole('radio', { name: /Save drafts/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Notes' }), 'Desktop only')
    await userEvent.click(screen.getByRole('button', { name: 'Save & next' }))
    await screen.findByRole('heading', { name: 'Crash reports' })
    const refreshed = openReview()
    refreshed.items[0]!.answer = stored
    vi.mocked(api.fetchDecisionReview).mockResolvedValue(refreshed)
    await act(async () => { reply.reject(new ApiError({ kind: 'http', status: 409, code: 'answer_conflict', body: { error: 'This answer changed since it was loaded.', code: 'answer_conflict', answer: stored }, path: 'decisions', message: 'This answer changed since it was loaded.' })); await reply.promise.catch(() => undefined) })
    expect(await screen.findByRole('heading', { name: 'Autosave drafts' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Do not save/ })).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('Desktop only')
    expect(screen.getByRole('alert')).toHaveTextContent('This answer changed elsewhere')
    expect(api.answerDecision).toHaveBeenCalledTimes(1)
  })

  it('defers without a choice, and saves notes as a custom answer only when there are notes', async () => {
    vi.mocked(api.answerDecision).mockImplementation(() => new Promise(() => undefined))
    await mount(`/decisions/${ID}`)
    await screen.findByRole('heading', { name: 'Autosave drafts' })
    await userEvent.click(screen.getByRole('button', { name: 'Come back to this later' }))
    expect(api.answerDecision).toHaveBeenLastCalledWith(expect.objectContaining({ item_id: 'autosave', value: null, deferred: true, custom: false }))
    await screen.findByRole('heading', { name: 'Crash reports' })
    const own = screen.getByRole('button', { name: 'Use my notes as the answer' })
    expect(own).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: 'Notes' }), 'Only for nightly builds')
    await userEvent.click(own)
    expect(api.answerDecision).toHaveBeenLastCalledWith(expect.objectContaining({ item_id: 'telemetry', value: null, notes: 'Only for nightly builds', deferred: false, custom: true }))
  })

  it('says when the content changed since the answer', async () => {
    const review = openReview()
    review.items[0]!.answer = { value: 'on', label: 'Save drafts', effect: 'Drafts come back after a reload.', notes: '', deferred: false, custom: false, version: 1, updated_at: 1 }
    review.items[0]!.needs_review = true
    await mount(`/decisions/${ID}`, review)
    expect(await screen.findByText('This changed since you answered')).toHaveAttribute('role', 'status')
    expect(item('autosave')).toHaveAttribute('data-needs-review', 'true')
  })
})

describe('decision review: answers (TAL-1964)', () => {
  const answered = () => {
    const review = openReview()
    review.items[0]!.answer = { value: null, label: null, effect: null, notes: '', deferred: true, custom: false, version: 1, updated_at: 1 }
    review.items[1]!.answer = { value: null, label: null, effect: null, notes: 'Only nightly', deferred: false, custom: true, version: 1, updated_at: 1 }
    review.items[1]!.needs_review = true
    review.items[2]!.outcome = { state: 'applied', note: 'Set to 30 days' }
    review.filters = { new: ['autosave', 'telemetry'], pending: [] }
    review.next_item_id = 'autosave'
    return review
  }

  it('lists every item with its answer, marks and outcome, and narrows by the server filters', async () => {
    await mount(`/decisions/${ID}?view=answers`, answered())
    await waitFor(() => expect(item('retention')).toBeInTheDocument())
    expect([item('autosave'), item('telemetry'), item('retention')].map((row) => row.getAttribute('data-answer'))).toEqual(['deferred', 'custom', 'answered'])
    expect(within(item('autosave')).getByText('Deferred')).toBeInTheDocument()
    expect(within(item('telemetry')).getByText('Own answer')).toBeInTheDocument()
    expect(within(item('telemetry')).getByText('Changed')).toBeInTheDocument()
    expect(within(item('telemetry')).getByText('Only nightly')).toBeInTheDocument()
    expect(within(item('retention')).getByText('Keep 30 days')).toBeInTheDocument()
    expect(within(item('retention')).getByText('Applied')).toBeInTheDocument()
    expect(within(item('retention')).getByText('Set to 30 days')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('combobox', { name: 'Show' }))
    await userEvent.click(await screen.findByRole('option', { name: 'New or changed' }))
    await waitFor(() => expect(item('retention')).toBeNull())
    expect(item('autosave')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('combobox', { name: 'Show' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Not answered' }))
    expect(await screen.findByText('Nothing to show')).toBeInTheDocument()
  })

  it('continues at the server\'s next item', async () => {
    await mount(`/decisions/${ID}?view=answers`, answered())
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: 'Autosave drafts' })).toBeInTheDocument()
  })

  it('keeps Submit disabled with the server\'s reason, then submits at once and disables the choices', async () => {
    const closed = { ...openReview(), submit: { allowed: false, reason: 'nothing_answered' as const } }
    const first = await mount(`/decisions/${ID}?view=answers`, closed)
    expect(await screen.findByRole('button', { name: 'Submit' })).toBeDisabled()
    expect(screen.getByText('Answer a decision to submit')).toBeInTheDocument()
    cleanup()
    first.client.clear()

    const reply = deferred<DecisionReview>()
    vi.mocked(api.submitDecisionReview).mockReturnValue(reply.promise)
    const { router } = await mount(`/decisions/${ID}?view=answers`)
    await userEvent.click(await screen.findByRole('button', { name: 'Submit' }))
    expect(api.submitDecisionReview).toHaveBeenCalledWith(ID)
    expect(document.querySelector('[data-review-status]')).toHaveAttribute('data-review-status', 'submitted')
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    await act(async () => { await router.navigate({ to: '/decisions/$reviewId', params: { reviewId: ID }, search: {} }) })
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    // Still readable: Next moves through the items without saving.
    expect(screen.queryByRole('button', { name: 'Save & next' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('heading', { name: 'Crash reports' })).toBeInTheDocument()
    expect(api.answerDecision).not.toHaveBeenCalled()
  })

  it('clears an answer from the row menu', async () => {
    vi.mocked(api.answerDecision).mockImplementation(() => new Promise(() => undefined))
    await mount(`/decisions/${ID}?view=answers`)
    await waitFor(() => expect(item('retention')).toBeInTheDocument())
    await userEvent.pointer({ keys: '[MouseRight]', target: item('retention') })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Clear answer' }))
    expect(api.answerDecision).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'retention', value: null, deferred: false, custom: false, expected_version: 1 }))
    await waitFor(() => expect(item('retention')).toHaveAttribute('data-answer', 'open'))
  })
})

describe('decision review transcript card (TAL-1964)', () => {
  it('shows the title, progress, status and an Open link, following the review as it changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(api.fetchDecisionReview).mockResolvedValue(openReview())
    const root = createRootRoute({ component: () => <QueryClientProvider client={client}><DecisionReviewResult reference={{ review_id: ID, title: recorded.title, progress: { total: 3, answered: 0, deferred: 0, needs_review: 0 } }} /></QueryClientProvider> })
    const router = createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: '/decisions/$reviewId' })]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await router.load()
    render(<RouterProvider router={router} />)
    expect(screen.getByText('Hermes audit decisions')).toBeInTheDocument()
    expect(await screen.findByText('Open · 1 of 3 answered')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/decisions/${ID}`)
    // A `decision_review` event invalidates the review; the card shows the new status and progress.
    vi.mocked(api.fetchDecisionReview).mockResolvedValue({ ...openReview(), status: 'submitted', progress: { total: 3, answered: 2, deferred: 0, needs_review: 0 } })
    await act(async () => { await client.invalidateQueries({ queryKey: ['decision-review', ID] }) })
    expect(await screen.findByText('Submitted · 2 of 3 answered')).toBeInTheDocument()
  })
})
