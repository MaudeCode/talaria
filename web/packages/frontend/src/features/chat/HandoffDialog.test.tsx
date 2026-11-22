import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHandoff } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', () => ({ nativeHandoff: vi.fn() }))
vi.mock('../toast/errorToast', () => ({ showErrorToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { showErrorToast } from '../toast/errorToast'
import { HandoffDialog } from './HandoffDialog'

/** The views the server ships (contracts/fixtures/native-handoff.json). */
const views = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/native-handoff.json'), 'utf8')) as Record<string, SessionHandoff>
const sid = views.read!.session_id

const open = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <HandoffDialog sessionId={sid} onClose={vi.fn()} />
</QueryClientProvider>)

describe('HandoffDialog (TAL-2641)', () => {
  beforeEach(() => { vi.mocked(api.nativeHandoff).mockReset(); vi.mocked(showErrorToast).mockReset() })

  it('shows the configured destination and sends nothing until the user hands off', async () => {
    vi.mocked(api.nativeHandoff).mockResolvedValue(views.read!)
    open()
    expect(await screen.findByRole('combobox', { name: 'Destination' })).toHaveTextContent('Phone (telegram)')
    expect(api.nativeHandoff).toHaveBeenCalledTimes(1)
    expect(api.nativeHandoff).toHaveBeenCalledWith({ session_id: sid, action: 'read' })
  })

  it('shows the request as queued at once and converges on the server view', async () => {
    let answer!: (view: SessionHandoff) => void
    vi.mocked(api.nativeHandoff).mockResolvedValueOnce(views.read!).mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Hand off' }))
    expect(screen.getByRole('status')).toHaveTextContent('Queued for the gateway')
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeDisabled()
    expect(api.nativeHandoff).toHaveBeenLastCalledWith({ session_id: sid, action: 'request', platform: 'telegram' })
    answer(views.queued!)
    expect(await screen.findByRole('button', { name: 'Cancel handoff' })).toBeEnabled()
  })

  it('rolls a refused request back to the confirmed view with the server reason', async () => {
    vi.mocked(api.nativeHandoff).mockResolvedValueOnce(views.read!).mockResolvedValueOnce(views.refused!)
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Hand off' }))
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('A turn did not finish when Hermes restarted') })
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeEnabled()
  })

  it('offers no request while a failed write is reconciled, and never resends it', async () => {
    let reread!: (view: SessionHandoff) => void
    vi.mocked(api.nativeHandoff).mockResolvedValueOnce(views.read!).mockRejectedValueOnce(new Error('network'))
      .mockReturnValueOnce(new Promise((resolve) => { reread = resolve }))
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Hand off' }))
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('did not confirm the request') })
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeDisabled()
    reread(views.not_pending!)
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Handing off to telegram') })
    expect(showErrorToast).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.nativeHandoff).mock.calls.map(([input]) => input.action)).toEqual(['read', 'request', 'read'])
  })

  it('neither polls nor offers another write while a request is in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let answer!: (view: SessionHandoff) => void
      vi.mocked(api.nativeHandoff).mockResolvedValueOnce(views.read!).mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
        .mockResolvedValue(views.read!)
      open()
      await userEvent.click(await screen.findByRole('button', { name: 'Hand off' }))
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(vi.mocked(api.nativeHandoff).mock.calls.map(([input]) => input.action)).toEqual(['read', 'request'])
      expect(screen.getByRole('button', { name: 'Hand off' })).toBeDisabled()
      answer(views.queued!)
      expect(await screen.findByRole('button', { name: 'Cancel handoff' })).toBeEnabled()
      // Once the write settles, the queued handoff is followed again.
      await act(() => vi.advanceTimersByTimeAsync(2000))
      expect(vi.mocked(api.nativeHandoff).mock.calls.map(([input]) => input.action)).toEqual(['read', 'request', 'read'])
    } finally { vi.useRealTimers() }
  })

  it('keeps reading a state the owner could not read until it answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(api.nativeHandoff).mockResolvedValueOnce(views.unknown!).mockResolvedValueOnce(views.failed!)
      open()
      expect(await screen.findByText('The gateway did not confirm the request. Reading its state again.')).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(2000))
      expect(await screen.findByText(/not active in this gateway/)).toBeInTheDocument()
      expect(vi.mocked(api.nativeHandoff).mock.calls.map(([input]) => input.action)).toEqual(['read', 'read'])
    } finally { vi.useRealTimers() }
  })

  it.each([['unsupported', 'This Agent version cannot hand off chats.'], ['no_destination', 'No messaging platform has a home channel.']])('says why a %s chat cannot be handed off', async (name, text) => {
    vi.mocked(api.nativeHandoff).mockResolvedValue(views[name]!)
    open()
    expect(await screen.findByText((content) => content.startsWith(text))).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Hand off' })).toBeDisabled()
  })
})
