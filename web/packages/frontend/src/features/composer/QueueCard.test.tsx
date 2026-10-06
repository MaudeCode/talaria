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
