import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionRow } from '../../contracts'

vi.mock(import('@tanstack/react-router'), async (importOriginal) => ({ ...(await importOriginal()), useNavigate: () => vi.fn() }))
import { SessionContextMenu } from './SessionContextMenu'

const writable: SessionRow = { session_id: 'mine', title: 'Mine', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0 }

async function menuItems(row: SessionRow): Promise<string[]> {
  render(<QueryClientProvider client={new QueryClient()}><SessionContextMenu row={row} active={false} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }))
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '')
}

describe('SessionContextMenu', () => {
  it('offers only the actions the server allows for a delegated subagent child (TAL-312)', async () => {
    const items = await menuItems({ ...writable, session_id: 'child', source_tag: 'subagent', read_only: true, can_branch: false, can_pin: false, can_archive: false, can_duplicate: false })
    for (const refused of ['Rename', 'Pin', 'Move', 'Duplicate', 'Archive', 'Delete']) expect(items.some((t) => t.startsWith(refused)), refused).toBe(false)
    expect(items.some((t) => t.startsWith('Export'))).toBe(true)
  })

  it('keeps pin, archive and duplicate for a read-only import the server still lets Web organize', async () => {
    const items = await menuItems({ ...writable, session_id: 'import', read_only: true, can_branch: false })
    for (const offered of ['Pin', 'Duplicate', 'Archive']) expect(items.some((t) => t.startsWith(offered)), offered).toBe(true)
    for (const refused of ['Rename', 'Move', 'Delete']) expect(items.some((t) => t.startsWith(refused)), refused).toBe(false)
  })
})
