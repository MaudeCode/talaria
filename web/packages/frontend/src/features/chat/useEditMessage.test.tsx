import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), truncateSession: vi.fn() }))
vi.mock(import('../composer/composerReturn'), async (importOriginal) => ({ ...(await importOriginal()), returnToComposer: vi.fn() }))
import * as api from '../../api/endpoints'
import { returnToComposer } from '../composer/composerReturn'
import { useEditMessage } from './useEditMessage'
import type { VisibleMessage } from './useTranscript'

const row: VisibleMessage = { index: 0, key: 'u1', message: { role: 'user', content: 'Plan the release' } }
const refresh = vi.fn(() => Promise.resolve())
const session = { session_id: 's1', title: 'Edit' } as never

/** ChatView's Edit wiring: the row's pencil and the confirmation the hook mounts. */
function Chat() {
  const { onEdit, dialog } = useEditMessage('s1', refresh)
  return <><button type="button" onClick={() => { void onEdit(row, 'Plan the release') }}>Edit message</button>{dialog}</>
}

describe('Edit asks before a cut the server refuses (TAL-929)', () => {
  beforeEach(() => {
    vi.mocked(api.truncateSession).mockReset()
    vi.mocked(returnToComposer).mockReset()
    refresh.mockClear()
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

  it('a cut the server accepts returns the text without asking', async () => {
    vi.mocked(api.truncateSession).mockResolvedValueOnce({ ok: true, session })
    render(<Chat />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    await waitFor(() => expect(returnToComposer).toHaveBeenCalledExactlyOnceWith('s1', 'Plan the release'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
