import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Proposal } from '@maudecode/talaria-web-contracts'
import { deferred } from '../../../test/fixtures'
import { ApiError } from '../../../contracts/common'
import { keys } from '../../../api/queryKeys'

vi.mock('../../../api/endpoints', () => ({ fetchProposal: vi.fn(), approveProposal: vi.fn(), rejectProposal: vi.fn() }))
vi.mock('../../toast/errorToast', () => ({ showErrorToast: vi.fn() }))
import * as api from '../../../api/endpoints'
import { ProposalResult } from './OutboundDraftResult'

/** The recorded `proposal_read` result (TAL-1967), reopened for the owner: a pending setting change. */
const recorded = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/sidecar/proposals.json'), 'utf8')) as { 'server.proposal_read': { result: Proposal }[] })['server.proposal_read'][0]!.result
const pending = (): Proposal => ({ ...structuredClone(recorded), status: 'pending', decided_at: null, actions: { can_approve: true, can_reject: true, reason: null } })
const ID = recorded.proposal_id

afterEach(() => { cleanup(); vi.resetAllMocks() })

function mount(proposal: Proposal) {
  vi.mocked(api.fetchProposal).mockResolvedValue(proposal)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ProposalResult reference={{ proposal_id: ID, kind: 'setting', summary: recorded.summary }} /></QueryClientProvider>)
  return client
}

it('renders the server\'s change and shows an approval at once, then the outcome the server applied', async () => {
  mount(pending())
  const card = within(await screen.findByRole('region', { name: 'Proposal' }))
  await waitFor(() => { expect(card.getByRole('status')).toHaveTextContent('Waiting for approval') })
  expect(card.getByLabelText('Change')).toHaveTextContent('-show_token_usage: false+show_token_usage: true')
  const reply = deferred<Proposal>()
  vi.mocked(api.approveProposal).mockReturnValue(reply.promise)
  await userEvent.click(card.getByRole('button', { name: 'Approve' }))
  expect(card.getByRole('status')).toHaveTextContent('Approved')
  expect(card.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  expect(api.approveProposal).toHaveBeenCalledWith({ proposal_id: ID, payload_hash: recorded.payload_hash })
  const applied: Proposal = { ...pending(), status: 'applied', outcome: { text: 'Set show_token_usage to true.', error: null }, actions: { can_approve: false, can_reject: false, reason: 'closed' } }
  vi.mocked(api.fetchProposal).mockResolvedValue(applied)
  await act(async () => { reply.resolve(applied); await reply.promise })
  await waitFor(() => { expect(card.getByRole('status')).toHaveTextContent('Applied') })
  expect(card.getByText('Set show_token_usage to true.')).toBeInTheDocument()
})

it('offers the same decisions on a right-click or long-press of the card', async () => {
  mount(pending())
  await screen.findByRole('button', { name: 'Approve' })
  vi.mocked(api.rejectProposal).mockReturnValue(deferred<Proposal>().promise)
  await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('Change setting show_token_usage') })
  const menu = await screen.findByRole('menu', { name: 'Change setting show_token_usage' })
  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Approve', 'Reject'])
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Reject' }))
  expect(api.rejectProposal).toHaveBeenCalledWith({ proposal_id: ID })
  expect(within(screen.getByRole('region', { name: 'Proposal' })).getByRole('status')).toHaveTextContent('Rejected')
})

it('rolls a refused rejection back to the proposal as it was', async () => {
  mount(pending())
  const card = within(await screen.findByRole('region', { name: 'Proposal' }))
  const reply = deferred<Proposal>()
  vi.mocked(api.rejectProposal).mockReturnValue(reply.promise)
  await userEvent.click(await card.findByRole('button', { name: 'Reject' }))
  expect(card.getByRole('status')).toHaveTextContent('Rejected')
  await act(async () => { reply.reject(new ApiError({ kind: 'http', status: 409, path: 'proposal', message: 'proposal expired' })); await reply.promise.catch(() => undefined) })
  await waitFor(() => { expect(card.getByRole('status')).toHaveTextContent('Waiting for approval') })
  expect(card.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
})

it('offers no action the server withholds, and follows a `proposal` event to the new status', async () => {
  const client = mount({ ...pending(), actions: { can_approve: false, can_reject: false, reason: 'not_owner' } })
  const card = within(await screen.findByRole('region', { name: 'Proposal' }))
  await waitFor(() => { expect(card.getByRole('status')).toHaveTextContent('Waiting for approval') })
  expect(card.queryByRole('button')).not.toBeInTheDocument()
  vi.mocked(api.fetchProposal).mockResolvedValue({ ...pending(), status: 'failed', outcome: { text: null, error: 'This Agent does not offer prepared compaction.' }, actions: { can_approve: false, can_reject: false, reason: 'not_owner' } })
  await act(async () => { await client.invalidateQueries({ queryKey: keys.proposal(ID) }) })
  expect(await card.findByText('This Agent does not offer prepared compaction.')).toBeInTheDocument()
  expect(card.getByRole('status')).toHaveTextContent('Failed')
})
