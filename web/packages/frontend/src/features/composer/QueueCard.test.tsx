import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueuedTurnsSchema } from '../../contracts/persisted'

vi.mock('../../api/endpoints', () => ({ rollbackUpload: vi.fn(() => Promise.resolve({})) }))
import * as api from '../../api/endpoints'
import { QueueCard } from './QueueCard'
import type { QueuedTurn } from './queue'
import { IME_ENTERS } from '../../test/fixtures'

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
  it('keeps Retry busy while the server runs it, so a second click never sends twice (TAL-1384)', async () => {
    let finish!: () => void
    const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<QueueCard sessionId="native" queued={[]} onChange={() => undefined} admissions={[{
      admission_id: 'lost', sequence: 1, status: 'unknown', outcome: null, authority_epoch: 2,
      execution_generation: 4, text: 'Inspect this result before retrying', actions: ['retry', 'discard'],
    }]} onAdmissionAction={action} />)
    const retry = screen.getByRole('button', { name: 'Retry' })
    await userEvent.click(retry)
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()
    await userEvent.click(retry)
    expect(action).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => { expect(retry).toBeEnabled() })
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
    // Its right-click menu gates the same way (TAL-1155).
    fireEvent.contextMenu(row('Sending'))
    for (const item of await screen.findAllByRole('menuitem')) expect(item).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel queued message' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers exactly the row\'s buttons on right-click, and nothing on a read-only row (TAL-1155)', async () => {
    const action = vi.fn().mockResolvedValue(undefined)
    const base = { sequence: 1, outcome: null, authority_epoch: 2, execution_generation: null }
    const { rerender } = render(<QueueCard sessionId="native" queued={[]} onChange={() => undefined} onAdmissionAction={action} admissions={[
      { ...base, admission_id: 'listed', status: 'queued', text: 'Listed', actions: ['cancel', 'edit', 'steer'] },
      { ...base, admission_id: 'lost', status: 'unknown', execution_generation: 4, text: 'Lost', actions: ['retry', 'discard'] },
    ]} />)
    fireEvent.contextMenu(row('Listed'))
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Edit queued message', 'Steer current response', 'Cancel queued message'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Steer current response' }))
    expect(action).toHaveBeenLastCalledWith({ session_id: 'native', action: 'steer_queued', admission_id: 'listed' })
    await waitFor(() => { expect(screen.queryByRole('menu')).not.toBeInTheDocument() })
    fireEvent.contextMenu(row('Lost'))
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Retry', 'Discard'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Discard' }))
    expect(action).toHaveBeenLastCalledWith({ session_id: 'native', action: 'discard', admission_id: 'lost', execution_generation: 4 })
    await waitFor(() => { expect(screen.queryByRole('menu')).not.toBeInTheDocument() })

    rerender(<QueueCard sessionId="" queued={[turn('1', 'Read only')]} onChange={() => undefined} readOnly />)
    expect(fireEvent.contextMenu(row('Read only'))).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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

  it.each(IME_ENTERS)('keeps a queued edit open on an Enter committing a composition (%s), and a plain Enter then commits it (TAL-1860)', async (_, ime) => {
    render(<Harness initial={[turn('1', 'First')]} />)
    await userEvent.click(within(row('First')).getByRole('button', { name: 'Edit queued message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit queued message' })
    await userEvent.clear(editor)
    await userEvent.type(editor, '編集')
    fireEvent.keyDown(editor, { key: 'Enter', ...ime })
    expect(screen.getByRole('textbox', { name: 'Edit queued message' })).toHaveFocus()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(screen.queryByRole('textbox', { name: 'Edit queued message' })).not.toBeInTheDocument()
    expect(row('編集')).toBeDefined()
  })

  it('restores any queue the composer can build, however long', () => {
    const many = Array.from({ length: 150 }, (_, i) => turn(String(i), i === 0 ? 'x'.repeat(250_000) : `Message ${String(i)}`))
    expect(QueuedTurnsSchema.safeParse(JSON.parse(JSON.stringify(many))).success).toBe(true)
  })
})
