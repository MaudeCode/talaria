import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, render as renderView, screen, waitFor } from '@testing-library/react'
import { queryWrapper } from '../../test/fixtures'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/endpoints', () => ({ respondApproval: vi.fn(() => Promise.resolve({ ok: true })), fetchApprovalPending: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { ApprovalCard } from './ApprovalCard'
import { showToast } from '../toast/toast'
import { ApiError } from '../../contracts/common'

const render = (ui: ReactElement) => renderView(ui, { wrapper: queryWrapper() })

describe('ApprovalCard', () => {
  it('offers only owner-approved choices and never offers native YOLO', () => {
    render(<ApprovalCard sessionId="native" pending={{ approval_id: 'native-control', command: 'echo fixture', allowed_choices: ['once', 'deny'], can_enable_yolo: false }} onResolved={() => undefined} />)
    expect(screen.getByRole('button', { name: /allow once/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /deny/i })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument()
  })
  it('renders the command with alertdialog semantics and answers "allow once"', async () => {
    const onResolved = vi.fn()
    render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a1', command: 'rm -rf build', pending_count: 2 }} onResolved={onResolved} />)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleName()
    expect(screen.getByText('rm -rf build')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /allow once/i }))
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))
    expect(api.respondApproval).toHaveBeenCalledWith(expect.objectContaining({ session_id: 's1', choice: 'once', approval_id: 'a1' }))
  })

  it('answers "allow once" on Enter when focus is outside a text field, and denies on Deny', async () => {
    const onResolved = vi.fn()
    const first = render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a2', command: 'ls' }} onResolved={onResolved} />)
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(api.respondApproval).toHaveBeenCalledWith(expect.objectContaining({ choice: 'once', approval_id: 'a2' })))
    first.unmount()
    render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a4', command: 'ls' }} onResolved={onResolved} />)
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => expect(api.respondApproval).toHaveBeenCalledWith(expect.objectContaining({ choice: 'deny', approval_id: 'a4' })))
  })

  it('leaves as soon as it is answered and comes back when the answer is refused (TAL-1384)', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.respondApproval).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject }) as never)
    render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a5', command: 'rm -rf build' }} onResolved={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await act(async () => { refuse(new ApiError({ kind: 'http', status: 400, path: '/api/approval/respond', message: 'Approval expired' })); await Promise.resolve() })
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(showToast).toHaveBeenLastCalledWith('Approval expired', 4000, 'error')
    expect(api.fetchApprovalPending).not.toHaveBeenCalled()
  })

  it('brings the card back when the relay to the run is unavailable and the approval still waits (TAL-1384)', async () => {
    const onResolved = vi.fn()
    vi.mocked(api.respondApproval).mockClear().mockRejectedValueOnce(new ApiError({ kind: 'http', status: 409, code: 'gateway_run_unavailable', path: '/api/approval/respond', message: 'The run is not reachable from Web' }))
    vi.mocked(api.fetchApprovalPending).mockResolvedValueOnce({ pending: { approval_id: 'a7', command: 'deploy', run_id: 'r1' }, pending_count: 1 })
    render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a7', command: 'deploy', run_id: 'r1' }} onResolved={onResolved} />)
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(showToast).toHaveBeenLastCalledWith('The run is not reachable from Web', 4000, 'error')
    expect(onResolved).not.toHaveBeenCalled()
    expect(api.respondApproval).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['still waits', { approval_id: 'a6', command: 'rm -rf build' }, true],
    ['has moved on', null, false],
  ] as const)('asks the server whether the approval still waits after an unknown outcome: it %s (TAL-1384)', async (_, head, back) => {
    const onResolved = vi.fn(() => { view.rerender(<></>) })
    vi.mocked(api.respondApproval).mockClear().mockRejectedValueOnce(new ApiError({ kind: 'network', path: '/api/approval/respond', message: 'Network down' }))
    vi.mocked(api.fetchApprovalPending).mockResolvedValueOnce({ pending: head, pending_count: head ? 1 : 0 })
    // ChatView drops the card when the stream's approval clears.
    const view = render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a6', command: 'rm -rf build' }} onResolved={onResolved} />)
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => { expect(api.fetchApprovalPending).toHaveBeenCalledWith('s1') })
    if (back) {
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
      expect(showToast).toHaveBeenLastCalledWith('Network down', 4000, 'error')
    } else {
      await waitFor(() => { expect(onResolved).toHaveBeenCalled() })
      expect(screen.queryByRole('alertdialog')).toBeNull()
    }
    expect(api.respondApproval).toHaveBeenCalledTimes(1)
  })

  it('does not treat Enter inside a text field as an approval', async () => {
    render(<><input aria-label="other" /><ApprovalCard sessionId="s1" pending={{ approval_id: 'a3', command: 'ls' }} onResolved={() => undefined} /></>)
    vi.mocked(api.respondApproval).mockClear()
    await userEvent.click(screen.getByLabelText('other'))
    await userEvent.keyboard('{Enter}')
    expect(api.respondApproval).not.toHaveBeenCalled()
  })

  it('stops answering Enter once dismissed', async () => {
    render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a4', command: 'rm -rf build' }} onResolved={() => undefined} />)
    vi.mocked(api.respondApproval).mockClear()
    await userEvent.click(screen.getByRole('button', { name: /dismiss approval/i }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(api.respondApproval).not.toHaveBeenCalled()
  })
})
