import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../test/fixtures'
import { teardownAll } from '../../stream/connection'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), truncateSession: vi.fn() }))
vi.mock(import('../composer/composerReturn'), async (importOriginal) => ({ ...(await importOriginal()), returnToComposer: vi.fn() }))
vi.mock(import('../toast/toast'), async (importOriginal) => ({ ...(await importOriginal()), showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { returnToComposer } from '../composer/composerReturn'
import { showToast } from '../toast/toast'
import { transcriptCut, useEditMessage } from './useEditMessage'
import { useResourceEffects } from '../sessions/useResourceMutation'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VisibleMessage } from './useTranscript'

const row: VisibleMessage = { index: 0, key: 'u1', message: { role: 'user', content: 'Plan the release' } }
const refresh = vi.fn(() => Promise.resolve())
const session = { session_id: 's1', title: 'Edit' } as never

/** ChatView's Edit wiring: the row's pencil and the confirmation the hook mounts. */
let client = new QueryClient()
function Chat({ sid = 's1' }: { sid?: string }) {
  return <QueryClientProvider client={client}><EditHarness sid={sid} /></QueryClientProvider>
}
function EditHarness({ sid }: { sid: string }) {
  const { onEdit, dialog, operation } = useEditMessage(sid, refresh)
  const cutFrom = useResourceEffects<number>()[transcriptCut(sid)]?.value
  return <><button type="button" onClick={() => { void onEdit(row, 'Plan the release') }}>Edit message</button>{operation && <span role="status">{operation}</span>}{typeof cutFrom === 'number' && <output aria-label="cut">{cutFrom}</output>}{dialog}</>
}

describe('Edit asks before a cut the server refuses (TAL-929)', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    vi.mocked(api.truncateSession).mockReset()
    vi.mocked(returnToComposer).mockReset()
    refresh.mockClear()
  })

  it('returns accepted editable text without waiting for a detail refresh', async () => {
    refresh.mockImplementationOnce(() => new Promise(() => undefined))
    vi.mocked(api.truncateSession).mockResolvedValueOnce({ ok: true, session })
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    await act(() => Promise.resolve())
    expect(returnToComposer).toHaveBeenCalledExactlyOnceWith('s1', 'Plan the release')
  })

  it('cuts the transcript at the row at once, suppresses duplicates, and fences an auth change (TAL-1384)', async () => {
    const cut = deferred<Awaited<ReturnType<typeof api.truncateSession>>>()
    vi.mocked(api.truncateSession).mockReturnValueOnce(cut.promise)
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(await screen.findByLabelText('cut')).toHaveTextContent('0')
    expect(screen.queryByText(/Editing/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(api.truncateSession).toHaveBeenCalledOnce()
    teardownAll()
    await act(async () => { cut.resolve({ ok: true, session }); await cut.promise })
    expect(refresh).not.toHaveBeenCalled()
    expect(returnToComposer).not.toHaveBeenCalled()
  })

  it('does not return text or refresh after navigation/unmount', async () => {
    const cut = deferred<Awaited<ReturnType<typeof api.truncateSession>>>()
    vi.mocked(api.truncateSession).mockReturnValueOnce(cut.promise)
    const view = render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    view.rerender(<Chat sid="other" />)
    await act(async () => { cut.resolve({ ok: true, session }); await cut.promise })
    expect(refresh).not.toHaveBeenCalled()
    expect(returnToComposer).not.toHaveBeenCalled()
  })

  it('shows the server counts and cuts nothing until Discard resends with the flag', async () => {
    vi.mocked(api.truncateSession).mockResolvedValueOnce({ ok: false, confirm_required: true, discard_user_turns: 3, discard_messages: 7, confirm_token: 'tok-1' }).mockResolvedValueOnce({ ok: true, session })
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Editing this message will discard 7 later messages.')
    expect(api.truncateSession).toHaveBeenCalledExactlyOnceWith('s1', 0, undefined)
    expect(refresh).not.toHaveBeenCalled()
    expect(returnToComposer).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(returnToComposer).toHaveBeenCalledExactlyOnceWith('s1', 'Plan the release'))
    expect(api.truncateSession).toHaveBeenLastCalledWith('s1', 0, 'tok-1')
    expect(refresh).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('Cancel changes neither the transcript nor the composer', async () => {
    vi.mocked(api.truncateSession).mockResolvedValueOnce({ ok: false, confirm_required: true, discard_user_turns: 2, discard_messages: 4, confirm_token: 'tok-2' })
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.truncateSession).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
    expect(returnToComposer).not.toHaveBeenCalled()
  })

  it('a Discard the server asks again about shows the new count and resends its token', async () => {
    vi.mocked(api.truncateSession)
      .mockResolvedValueOnce({ ok: false, confirm_required: true, discard_user_turns: 2, discard_messages: 3, confirm_token: 'tok-1' })
      .mockResolvedValueOnce({ ok: false, confirm_required: true, discard_user_turns: 3, discard_messages: 5, confirm_token: 'tok-2' })
      .mockResolvedValueOnce({ ok: true, session })
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveTextContent('Editing this message will discard 5 later messages.'))
    expect(returnToComposer).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(returnToComposer).toHaveBeenCalledOnce())
    expect(vi.mocked(api.truncateSession).mock.calls.map((c) => c[2])).toEqual([undefined, 'tok-1', 'tok-2'])
  })

  it('a cut the server cannot make says why and leaves the composer alone', async () => {
    vi.mocked(api.truncateSession).mockRejectedValueOnce(new Error('The session history could not be read. Please try again in a moment.'))
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('The session history could not be read. Please try again in a moment.', 4000, 'error'))
    expect(returnToComposer).not.toHaveBeenCalled()
  })

  it('a cut the server accepts returns the text without asking', async () => {
    vi.mocked(api.truncateSession).mockResolvedValueOnce({ ok: true, session })
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    await waitFor(() => expect(returnToComposer).toHaveBeenCalledExactlyOnceWith('s1', 'Plan the release'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
