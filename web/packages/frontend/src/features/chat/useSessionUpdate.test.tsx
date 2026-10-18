import { beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
vi.mock(import('../../api/endpoints'), async (original) => ({ ...(await original()), updateSession: vi.fn() }))
import * as api from '../../api/endpoints'
import { sessionFixture } from '../../test/fixtures'
import { ApiError } from '../../contracts/common'
import { teardownAll } from '../../stream/connection'
import { useSessionUpdate } from './useSessionUpdate'
const refresh = vi.fn(async () => undefined)
const body = { model: 'contributor', model_provider: 'custom' }
const refusal = (token: string, message = 'This model may train on your conversation.') => new ApiError({ kind: 'http', status: 409, path: '/api/session/update', message, body: { error: message, type: 'model_confirmation_required', confirm_token: token, warnings: [{ kind: 'data_policy', title: 'Warning', model: 'contributor', provider: 'custom', message }] } })
function Chat({ sid = 's1' }: { sid?: string }) {
  const { updateSession, dialog } = useSessionUpdate(sid, refresh)
  return <><button onClick={() => { void updateSession(body) }}>Pick model</button>{dialog}</>
}
beforeEach(() => { vi.mocked(api.updateSession).mockReset(); refresh.mockClear() })
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
  await act(async () => { reject(refusal('foreign')) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  await userEvent.click(screen.getByText('Pick model'))
  teardownAll()
  await act(async () => { reject(refusal('foreign')) })
  expect(screen.queryByRole('alertdialog')).toBeNull(); expect(refresh).not.toHaveBeenCalled()
  view.unmount()
})
