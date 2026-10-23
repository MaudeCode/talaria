import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OutboundDraft } from '@maudecode/talaria-web-contracts'
import { queryWrapper, deferred } from '../../../test/fixtures'
import { ApiError } from '../../../contracts/common'

vi.mock('../../../api/endpoints', () => ({ fetchOutboundDraft: vi.fn(), actOnOutboundDraft: vi.fn() }))
vi.mock('../../toast/errorToast', () => ({ showErrorToast: vi.fn() }))
import * as api from '../../../api/endpoints'
import { OutboundDraftResult } from './OutboundDraftResult'

afterEach(() => { cleanup(); vi.resetAllMocks() })
const reference = { draft_id: 'd_1234abcd', card: 1 }
const fixture = (): OutboundDraft => ({ ...reference, producer: 'draft-cards', producer_revision: 'reviewed-pin', kind: 'email', platform: '', version: 2, revision: 'raw-v2', fields: { from: '', to: ['recipient@example.invalid'], cc: [], bcc: [], subject: 'Review', body: 'Reviewed body' }, state: 'draft', can_edit: true, can_approve: true, masked: false })
const mount = () => render(<OutboundDraftResult sessionId="synthetic" callId="call" reference={reference} />, { wrapper: queryWrapper() })

it('shows approval immediately, reconciles a lost acknowledgment and never retries the write', async () => {
  const draft = fixture()
  vi.mocked(api.fetchOutboundDraft).mockResolvedValue({ draft })
  const reply = deferred<{ draft: OutboundDraft | null }>()
  vi.mocked(api.actOnOutboundDraft).mockReturnValue(reply.promise)
  mount()
  await screen.findByText('Reviewed body')
  await userEvent.click(screen.getByRole('button', { name: 'Approve this version' }))
  expect(screen.getByRole('status')).toHaveTextContent('Approved')
  expect(screen.queryByRole('button', { name: 'Approve this version' })).not.toBeInTheDocument()
  vi.mocked(api.fetchOutboundDraft).mockResolvedValue({ draft: { ...draft, state: 'approved', can_approve: false } })
  await act(async () => { reply.reject(new Error('lost acknowledgment')); await reply.promise.catch(() => undefined) })
  await waitFor(() => expect(api.fetchOutboundDraft).toHaveBeenCalledTimes(2))
  expect(api.actOnOutboundDraft).toHaveBeenCalledTimes(1)
  expect(api.actOnOutboundDraft).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve', version: 2, revision: 'raw-v2' }))
  expect(screen.getByRole('status')).toHaveTextContent('Approved')
})

it('closes an edit form and shows the edited body before acknowledgment, then rolls back refusal', async () => {
  const draft = fixture()
  vi.mocked(api.fetchOutboundDraft).mockResolvedValue({ draft })
  const reply = deferred<{ draft: OutboundDraft | null }>()
  vi.mocked(api.actOnOutboundDraft).mockReturnValue(reply.promise)
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  await userEvent.clear(screen.getByRole('textbox', { name: 'Body' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Body' }), 'Edited body')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText('Edited body')).toBeInTheDocument()
  await act(async () => { reply.reject(new ApiError({ kind: 'http', status: 409, path: 'draft', message: 'Changed version' })); await reply.promise.catch(() => undefined) })
  await screen.findByText('Reviewed body')
  expect(api.actOnOutboundDraft).toHaveBeenCalledTimes(1)
})

it('renders masked and unavailable states without an action the server refused', async () => {
  vi.mocked(api.fetchOutboundDraft).mockResolvedValue({ draft: { ...fixture(), masked: true, can_edit: false, can_approve: false } })
  mount()
  await screen.findByText('Sensitive content is masked. Editing and approval are unavailable.')
  expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve this version' })).not.toBeInTheDocument()
  vi.mocked(api.fetchOutboundDraft).mockResolvedValue({ draft: null })
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Draft unavailable')
})
