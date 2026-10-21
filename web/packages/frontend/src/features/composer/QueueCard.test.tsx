import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueuedTurnsSchema } from '../../contracts/persisted'

vi.mock('../../api/endpoints', () => ({ rollbackUpload: vi.fn(() => Promise.resolve({})) }))
import * as api from '../../api/endpoints'
import { QueueCard } from './QueueCard'
import type { QueuedTurn } from './queue'

const turn = (id: string, text: string, attachments: QueuedTurn['attachments'] = []): QueuedTurn => ({ id, text, attachments, request: { profile: 'default' } })

function Harness({ initial }: { initial: QueuedTurn[] }) {
  const [queued, setQueued] = useState(initial)
  return <QueueCard sessionId="s1" queued={queued} onChange={setQueued} />
}

const row = (text: string) => screen.getAllByRole('listitem').find((li) => li.textContent.includes(text))!

describe('QueueCard (TAL-562)', () => {
  it('shows native Edit and Steer only when the server lists them', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    const admission = { admission_id: 'editable', sequence: 1, status: 'queued' as const, outcome: null, authority_epoch: 2, execution_generation: null, text: 'Before edit' }
    render(<QueueCard sessionId="native" queued={[]} onChange={() => undefined} admissions={[
      { ...admission, actions: ['cancel', 'edit', 'steer'] },
      { ...admission, admission_id: 'legacy', text: 'Cancel only', actions: ['cancel'] },
    ]} onAdmissionAction={action} />)
    expect(within(row('Cancel only')).queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument()
    expect(within(row('Cancel only')).queryByRole('button', { name: 'Steer current response' })).not.toBeInTheDocument()
    await userEvent.click(within(row('Before edit')).getByRole('button', { name: 'Steer current response' }))
    expect(action).toHaveBeenCalledWith({ session_id: 'native', action: 'steer_queued', admission_id: 'editable' })
    await userEvent.click(within(row('Before edit')).getByRole('button', { name: 'Edit queued message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit queued message' })
    action.mockRejectedValueOnce(new Error('Lost response'))
    await userEvent.clear(editor)
    await userEvent.type(editor, 'After edit{Enter}')
    expect(action).toHaveBeenLastCalledWith({ session_id: 'native', action: 'replace_queued', admission_id: 'editable', text: 'After edit', submission_id: expect.any(String) })
    const request = action.mock.calls.at(-1)![0]
    await userEvent.click(editor)
    await userEvent.keyboard('{Enter}')
    expect(action.mock.calls.at(-1)![0]).toEqual(request)
    // The displayed row stays authoritative until the server snapshot changes.
    expect(screen.getByText('Before edit')).toBeInTheDocument()
  })

  it('renders native unknown admissions with only the server recovery actions', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    render(<QueueCard sessionId="native" queued={[]} onChange={() => undefined} admissions={[{
      admission_id: 'lost', sequence: 1, status: 'unknown', outcome: null, authority_epoch: 2,
      execution_generation: 4, text: 'Inspect this result before retrying', actions: ['retry', 'discard'],
    }]} onAdmissionAction={action} />)
    expect(screen.getByText('Outcome unknown')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(action).toHaveBeenCalledWith({ session_id: 'native', action: 'retry', admission_id: 'lost', execution_generation: 4 })
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(action).toHaveBeenCalledWith({ session_id: 'native', action: 'discard', admission_id: 'lost', execution_generation: 4 })
  })
  it('does not let an in-flight admission remove or roll back its queued receipt', async () => {
    vi.mocked(api.rollbackUpload).mockClear()
    const onChange = vi.fn()
    render(<QueueCard sessionId="s1" queued={[turn('1', 'Sending'), turn('2', 'Waiting')]} onChange={onChange} pendingId="1" />)
    for (const button of within(row('Sending')).getAllByRole('button')) expect(button).toBeDisabled()
    await userEvent.click(within(row('Sending')).getByRole('button', { name: 'Cancel queued message' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(api.rollbackUpload).not.toHaveBeenCalled()
    expect(within(row('Waiting')).getByRole('button', { name: 'Cancel queued message' })).toBeEnabled()
  })

  it('discards a removed message\'s uploaded files on the server', async () => {
    const file = { filename: 'a.png', path: '/u/a.png', size: 1, mime: 'image/png', rollback_token: 'tok-a' }
    render(<Harness initial={[turn('1', 'With a file', [file]), turn('2', 'Plain')]} />)
    await userEvent.click(within(row('With a file')).getByRole('button', { name: 'Cancel queued message' }))
    expect(api.rollbackUpload).toHaveBeenCalledWith('s1', ['tok-a'])
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Plain'])
  })

  it('saves an open edit when another row\'s Edit is clicked', async () => {
    render(<Harness initial={[turn('1', 'First'), turn('2', 'Second')]} />)
    await userEvent.click(within(row('First')).getByRole('button', { name: 'Edit queued message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit queued message' })
    await userEvent.clear(editor)
    await userEvent.type(editor, 'First, edited')
    await userEvent.click(within(row('Second')).getByRole('button', { name: 'Edit queued message' }))
    expect(row('First, edited')).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Edit queued message' })).toHaveValue('Second')
  })

  it('restores any queue the composer can build, however long', () => {
    const many = Array.from({ length: 150 }, (_, i) => turn(String(i), i === 0 ? 'x'.repeat(250_000) : `Message ${String(i)}`))
    expect(QueuedTurnsSchema.safeParse(JSON.parse(JSON.stringify(many))).success).toBe(true)
  })
})
