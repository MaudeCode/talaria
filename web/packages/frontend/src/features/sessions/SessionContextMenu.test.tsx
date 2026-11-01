import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionRow } from '../../contracts'

vi.mock(import('@tanstack/react-router'), async (importOriginal) => ({ ...(await importOriginal()), useNavigate: () => vi.fn() }))
import { SessionContextMenu } from './SessionContextMenu'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'

const writable: SessionRow = { session_id: 'mine', title: 'Mine', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 0 }

async function menuItems(row: SessionRow): Promise<string[]> {
  render(<QueryClientProvider client={new QueryClient()}><SessionContextMenu row={row} active={false} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }))
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent ?? '')
}

describe('SessionContextMenu', () => {
  it('offers only the actions the server allows for a delegated subagent child (TAL-312)', async () => {
    const items = await menuItems({ ...writable, session_id: 'child', source_tag: 'subagent', read_only: true, can_branch: false, can_pin: false, can_archive: false, can_delete: false, can_duplicate: false })
    for (const refused of ['Rename', 'Pin', 'Move', 'Duplicate', 'Archive', 'Delete']) expect(items.some((t) => t.startsWith(refused)), refused).toBe(false)
    expect(items.some((t) => t.startsWith('Export'))).toBe(true)
  })

  it('keeps pin, archive and duplicate for a read-only import the server still lets Web organize', async () => {
    const items = await menuItems({ ...writable, session_id: 'import', read_only: true, can_branch: false })
    for (const offered of ['Pin', 'Duplicate', 'Archive']) expect(items.some((t) => t.startsWith(offered)), offered).toBe(true)
    for (const refused of ['Rename', 'Move', 'Delete']) expect(items.some((t) => t.startsWith(refused)), refused).toBe(false)
  })

  it('hides Share and Refresh snapshot where the server refuses sharing, keeping copy and revoke (TAL-732)', async () => {
    const items = await menuItems({ ...writable, session_id: 'claude', source_kind: 'claude_code', can_share: false, share_url: '/share/old' })
    for (const refused of ['Share publicly', 'Refresh snapshot']) expect(items, refused).not.toContain(refused)
    for (const offered of ['Copy share link', 'Revoke public link']) expect(items, offered).toContain(offered)
  })

  it('offers Share where the server allows sharing (TAL-732)', async () => {
    expect(await menuItems(writable)).toContain('Share publicly')
  })

  it('offers Refresh snapshot on a shared row the server allows sharing (TAL-732)', async () => {
    expect(await menuItems({ ...writable, session_id: 'shared', share_url: '/share/old' })).toContain('Refresh snapshot')
  })

  it('starts with Open in new tab, which opens the conversation without an opener (TAL-699)', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect((await menuItems({ ...writable, session_id: 'a b' }))[0]).toBe('Open in new tab')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open in new tab' }))
    expect(open).toHaveBeenCalledWith(new URL('session/a%20b', document.baseURI).href, '_blank', 'noopener')
  })
})


it('removes confirmed deletion from every cached list and session resource', async () => {
  let answer!: (value: Awaited<ReturnType<typeof api.deleteSession>>) => void
  vi.spyOn(api, 'deleteSession').mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const key of [keys.sessions.list({}), keys.sessions.list({ include_archived: true }), keys.sessions.search('Mine', {})]) {
    qc.setQueryData(key, { sessions: [writable, { ...writable, session_id: 'keeper' }] })
  }
  qc.setQueryData(keys.sessions.detail('mine'), { session: writable })
  qc.setQueryData(keys.sessions.usage('mine'), { usage: {} })
  render(<QueryClientProvider client={qc}><SessionContextMenu row={writable} active={false} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Conversation actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete conversation' }))
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('mine'))
  expect(qc.getQueryData<{ sessions: SessionRow[] }>(keys.sessions.list({}))?.sessions).toHaveLength(2)
  act(() => { answer({ ok: true, state_db_cleanup_failed: false }) })
  await waitFor(() => expect(qc.getQueryData<{ sessions: SessionRow[] }>(keys.sessions.list({}))?.sessions.map((r) => r.session_id)).toEqual(['keeper']))
  expect(qc.getQueryData(keys.sessions.search('Mine', {}))).toEqual({ sessions: [{ ...writable, session_id: 'keeper' }] })
  expect(qc.getQueryData(keys.sessions.detail('mine'))).toBeUndefined()
  expect(qc.getQueryData(keys.sessions.usage('mine'))).toBeUndefined()
})
