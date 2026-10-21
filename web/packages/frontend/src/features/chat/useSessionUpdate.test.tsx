import { beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
vi.mock(import('../../api/endpoints'), async (original) => ({ ...(await original()), updateSession: vi.fn(), ownerAction: vi.fn() }))
import * as api from '../../api/endpoints'
import { sessionFixture } from '../../test/fixtures'
import { ApiError } from '../../contracts/common'
import { teardownAll } from '../../stream/connection'
import type { OwnerAttachment } from '@maudecode/talaria-web-contracts'
import { useSessionUpdate } from './useSessionUpdate'
const refresh = vi.fn(() => Promise.resolve())
const body = { model: 'contributor', model_provider: 'custom' }
const nativeOwner: OwnerAttachment = { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 8, execution_generation: 3, admissions: [] }
const refusal = (token: string, message = 'This model may train on your conversation.') => new ApiError({ kind: 'http', status: 409, path: '/api/session/update', message, body: { error: message, type: 'model_confirmation_required', confirm_token: token, warnings: [{ kind: 'data_policy', title: 'Warning', model: 'contributor', provider: 'custom', message }] } })
function Chat({ sid = 's1', owner, change = body }: { sid?: string; owner?: OwnerAttachment; change?: Parameters<typeof api.updateSession>[1] }) {
  const { updateSession, dialog } = useSessionUpdate(sid, refresh, owner)
  return <><button onClick={() => { void updateSession(change) }}>Pick model</button>{dialog}</>
}
beforeEach(() => { vi.mocked(api.updateSession).mockReset(); vi.mocked(api.ownerAction).mockReset(); refresh.mockClear() })
it('Cancel leaves the selection unchanged, Confirm sends the exact server token', async () => {
  vi.mocked(api.updateSession).mockRejectedValueOnce(refusal('one')).mockRejectedValueOnce(refusal('two')).mockResolvedValueOnce({ session: sessionFixture({ session_id: 's1', model: 'contributor' }) })
  render(<Chat />)
  await userEvent.click(screen.getByText('Pick model'))
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('This model may train on your conversation.')
  await userEvent.click(screen.getByText('Cancel'))
  expect(api.updateSession).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Pick model'))
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByText('Confirm'))
  expect(api.updateSession).toHaveBeenLastCalledWith('s1', { ...body, confirm_token: 'two' })
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
})
it('a stale confirmation displays the fresh server warning and requires another confirmation', async () => {
  vi.mocked(api.updateSession).mockRejectedValueOnce(refusal('one')).mockRejectedValueOnce(refusal('two', 'Context has grown. Switching rereads it uncached.')).mockResolvedValueOnce({ session: sessionFixture({ session_id: 's1' }) })
  render(<Chat />)
  await userEvent.click(screen.getByText('Pick model'))
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByText('Confirm'))
  await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveTextContent('Context has grown.'))
  expect(refresh).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Confirm'))
  expect(api.updateSession).toHaveBeenLastCalledWith('s1', { ...body, confirm_token: 'two' })
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
})
it('fences late refusals after navigation, unmount and authentication changes', async () => {
  let reject!: (error: unknown) => void
  vi.mocked(api.updateSession).mockImplementation(() => new Promise((_, r) => { reject = r }))
  const view = render(<Chat />)
  await userEvent.click(screen.getByText('Pick model'))
  view.rerender(<Chat sid="other" />)
  await act(() => { reject(refusal('foreign')); return Promise.resolve() })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  await userEvent.click(screen.getByText('Pick model'))
  teardownAll()
  await act(() => { reject(refusal('foreign')); return Promise.resolve() })
  expect(screen.queryByRole('alertdialog')).toBeNull(); expect(refresh).not.toHaveBeenCalled()
  view.unmount()
})
it('does not restore an old prompt when navigating away and back', async () => {
  vi.mocked(api.updateSession).mockRejectedValueOnce(refusal('old'))
  const view = render(<Chat />)
  await userEvent.click(screen.getByText('Pick model'))
  expect(await screen.findByRole('alertdialog')).toBeVisible()
  view.rerender(<Chat sid="other" />)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  view.rerender(<Chat />)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(api.updateSession).toHaveBeenCalledOnce()
})

it('routes native model changes through the existing update flow with the owner fences', async () => {
  vi.mocked(api.ownerAction).mockResolvedValue({ ok: true, session: sessionFixture({ session_id: 's1' }) })
  render(<Chat owner={{ ...nativeOwner }} />)
  await userEvent.click(screen.getByText('Pick model'))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(api.ownerAction).toHaveBeenCalledWith({ session_id: 's1', action: 'mutate', request_id: expect.any(String),
    expected_revision: 8, execution_generation: 3, operation: 'model', payload: { model: 'contributor', provider: 'custom' } })
  expect(api.updateSession).not.toHaveBeenCalled()
})

it('preserves an explicit null provider in a native model selection', async () => {
  vi.mocked(api.ownerAction).mockResolvedValue({ ok: true, session: sessionFixture({ session_id: 's1' }) })
  render(<Chat change={{ model: 'automatic', model_provider: null }} owner={{ ...nativeOwner }} />)
  await userEvent.click(screen.getByText('Pick model'))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(api.ownerAction).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'model', payload: { model: 'automatic', provider: null } }))
})

it('opens the existing dialog for a native confirmation and resends the owner token', async () => {
  vi.mocked(api.ownerAction).mockResolvedValueOnce({ ok: true, model_change: { state: 'confirmation_required', confirm: 'native-token', message: 'Native guard warning', model: 'contributor', provider: 'custom' }, session: sessionFixture({ session_id: 's1' }) })
    .mockResolvedValueOnce({ ok: true, session: sessionFixture({ session_id: 's1' }) })
  render(<Chat owner={{ ...nativeOwner }} />)
  await userEvent.click(screen.getByText('Pick model'))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Native guard warning')
  await userEvent.click(within(dialog).getByText('Confirm'))
  expect(api.ownerAction).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'model', payload: { model: 'contributor', provider: 'custom', confirm: 'native-token' } }))
})

it('renders later owner decisions, keeps a cancelled token closed, and confirms with current fences', async () => {
  const owner: OwnerAttachment = { ...nativeOwner, model_change: { state: 'deferred', model: 'picked' } }
  const view = render(<Chat owner={owner} />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  const guarded: OwnerAttachment = { ...owner, revision: 11, execution_generation: 4, model_change: { state: 'confirmation_required', model: 'picked', provider: null, confirm: 'later', message: 'Later guard' } }
  view.rerender(<Chat owner={guarded} />)
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Later guard')
  await userEvent.click(screen.getByText('Cancel'))
  view.rerender(<Chat owner={{ ...guarded, model_change: { ...guarded.model_change! } }} />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  view.rerender(<Chat owner={{ ...guarded, model_change: { ...guarded.model_change!, confirm: 'new-token' } }} />)
  vi.mocked(api.ownerAction).mockResolvedValue({ ok: true, model_change: { state: 'applied' }, session: sessionFixture({ session_id: 's1' }) })
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByText('Confirm'))
  expect(api.ownerAction).toHaveBeenLastCalledWith(expect.objectContaining({ expected_revision: 11, execution_generation: 4, payload: { model: 'picked', provider: null, confirm: 'new-token' } }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
})

it('asks again for an intentional native pick after cancelling the same owner token', async () => {
  vi.mocked(api.ownerAction).mockResolvedValue({ ok: true, model_change: { state: 'confirmation_required', confirm: 'same-token', message: 'Guard warning', model: 'contributor', provider: 'custom' }, session: sessionFixture({ session_id: 's1' }) })
  render(<Chat owner={{ ...nativeOwner }} />)
  await userEvent.click(screen.getByText('Pick model'))
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByText('Cancel'))
  await userEvent.click(screen.getByText('Pick model'))
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Guard warning')
})

it('keeps a cancelled native confirmation closed when a workspace response repeats it', async () => {
  const owner: OwnerAttachment = { ...nativeOwner }
  const change: NonNullable<OwnerAttachment['model_change']> = { state: 'confirmation_required', confirm: 'cached-token', message: 'Guard warning', model: 'contributor', provider: 'custom' }
  vi.mocked(api.ownerAction).mockResolvedValue({ ok: true, model_change: change, session: sessionFixture({ session_id: 's1', owner_attachment: { ...owner, model_change: change } }) })
  const view = render(<Chat owner={owner} />)
  await userEvent.click(screen.getByText('Pick model'))
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByText('Cancel'))
  view.rerender(<Chat owner={{ ...owner, model_change: change }} change={{ workspace: '/trusted-workspace' }} />)
  await userEvent.click(screen.getByText('Pick model'))
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(api.ownerAction).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'workspace', payload: { cwd: '/trusted-workspace' } }))
  expect(api.ownerAction).toHaveBeenCalledTimes(2)
})
