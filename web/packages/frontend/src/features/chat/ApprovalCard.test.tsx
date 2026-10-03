import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/endpoints', () => ({ respondApproval: vi.fn(() => Promise.resolve({ ok: true })) }))
import * as api from '../../api/endpoints'
import { ApprovalCard } from './ApprovalCard'

describe('ApprovalCard', () => {
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
    render(<ApprovalCard sessionId="s1" pending={{ approval_id: 'a2', command: 'ls' }} onResolved={onResolved} />)
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(api.respondApproval).toHaveBeenCalledWith(expect.objectContaining({ choice: 'once', approval_id: 'a2' })))
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    await waitFor(() => expect(api.respondApproval).toHaveBeenCalledWith(expect.objectContaining({ choice: 'deny', approval_id: 'a2' })))
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
