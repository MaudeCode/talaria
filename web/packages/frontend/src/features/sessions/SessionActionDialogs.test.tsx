import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow, SessionsList } from '../../contracts'

vi.mock('../../api/endpoints', () => ({
  fetchSessions: vi.fn(), searchSessions: vi.fn(), fetchProjects: vi.fn(), archiveSession: vi.fn(), renameSession: vi.fn(), moveSession: vi.fn(),
  deleteSession: vi.fn(), revokeShare: vi.fn(), fetchWorktreeStatus: vi.fn(), exportSessionUrl: () => '',
}))
vi.mock('./useNewChat', () => ({ useNewChat: () => vi.fn() }))
const toast = vi.hoisted(() => vi.fn())
vi.mock('../toast/toast', () => ({ showToast: toast }))
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { SessionListPanel } from './SessionListPanel'

const now = Date.now() / 1000
const older = now - 30 * 86_400
const row = (session_id: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  session_id, title, last_message_at: now, sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false, ...extra,
})
const fresh = row('fresh', 'Fresh')
const old = row('old', 'Old chat', { sort_ts: older, last_message_at: older })

beforeEach(() => {
  vi.mocked(api.fetchSessions).mockReset().mockResolvedValue({ sessions: [fresh, old] } as never)
  vi.mocked(api.fetchProjects).mockReset().mockResolvedValue({ projects: [{ project_id: 'p1', name: 'Proj' }] } as never)
  vi.mocked(api.renameSession).mockReset().mockResolvedValue({ ok: true } as never)
  vi.mocked(api.moveSession).mockReset().mockResolvedValue({ ok: true } as never)
  vi.mocked(api.deleteSession).mockReset().mockResolvedValue({ ok: true, state_db_cleanup_failed: false } as never)
  vi.mocked(api.revokeShare).mockReset().mockResolvedValue({ ok: true } as never)
  vi.mocked(api.fetchWorktreeStatus).mockReset().mockResolvedValue({ status: { path: '/w', exists: true, removable: true, force_required: false, dirty: false, untracked_count: 0, ahead_behind: { ahead: 0, behind: 0 }, locked_by_stream: false } } as never)
  toast.mockReset()
  window.scrollTo = vi.fn()
})

async function setup(sessions: SessionRow[] = [fresh, old]) {
  vi.mocked(api.fetchSessions).mockResolvedValue({ sessions } as never)
  // Background refreshes in these tests are the explicit snapshots below.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } })
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><SessionListPanel /><Outlet /></QueryClientProvider> })
  const session = createRoute({ getParentRoute: () => root, path: '/session/$sessionId', component: () => null })
  const router = createRouter({ routeTree: root.addChildren([session]), history: createMemoryHistory({ initialEntries: ['/session/fresh'] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  await screen.findByText(sessions.at(-1)!.title)
  /** A background refresh: the server's next list snapshot. */
  const refresh = (rows: SessionRow[]) => act(async () => {
    client.setQueryData<SessionsList>(keys.sessions.list({}), (data) => ({ ...data!, sessions: rows }))
    // Query notifies its observers on the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { client, refresh }
}

const rowLink = (sid: string) => document.querySelector<HTMLElement>(`#sessionList [data-sid="${sid}"]`)!
const groupOf = (sid: string) => rowLink(sid).closest('.session-date-group')!.querySelector('.session-date-header')!.textContent
// An open modal hides the list from role queries.
const trigger = (sid: string) => rowLink(sid).querySelector<HTMLElement>('.session-actions-trigger')!

async function openAction(sid: string, item: string) {
  await userEvent.click(trigger(sid))
  await userEvent.click(await screen.findByRole('menuitem', { name: item }))
}

describe('session action dialogs survive a refresh that regroups their row (TAL-1119)', () => {
  it('keeps Move to project and its chosen project when the row moves from Older to Today', async () => {
    const { refresh } = await setup()
    expect(groupOf('old')).toContain('Older')
    await openAction('old', 'Move to project')
    const dialog = await screen.findByRole('dialog', { name: 'Move to project' })
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Move to project' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Proj' }))
    await refresh([fresh, { ...old, sort_ts: now, last_message_at: now }])
    expect(groupOf('old')).toContain('Today')
    expect(screen.getByRole('dialog', { name: 'Move to project' })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('combobox')).toHaveTextContent('Proj')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.moveSession).toHaveBeenCalledWith('old', 'p1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps Rename and its draft when another device pins the row', async () => {
    const { refresh } = await setup()
    await openAction('old', 'Rename conversation')
    const input = within(await screen.findByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'Draft name')
    await refresh([{ ...old, pinned: true, sidebar_group: 'pinned' }, fresh])
    expect(groupOf('old')).toContain('Pinned')
    const kept = within(screen.getByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox')
    expect(kept).toHaveValue('Draft name')
    expect(kept).toHaveFocus()
    await userEvent.type(kept, '{Enter}')
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('old', 'Draft name'))
  })

  it('keeps Rename and its draft through a refresh that leaves the row in its group', async () => {
    const { refresh } = await setup()
    await openAction('old', 'Rename conversation')
    const input = within(await screen.findByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox')
    await userEvent.type(input, ' edited')
    await refresh([fresh, { ...old, title: 'Old chat (server)' }])
    expect(groupOf('old')).toContain('Older')
    expect(within(screen.getByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox')).toHaveValue('Old chat edited')
  })
})

describe('the shared session action owner (TAL-1119)', () => {
  const regrouped = (extra: Partial<SessionRow> = {}) => [fresh, { ...old, sort_ts: now, last_message_at: now, ...extra }]

  it.each([
    { item: 'Move to project', role: 'dialog', name: 'Move to project', extra: {} },
    { item: 'Rename conversation', role: 'dialog', name: 'Rename conversation', extra: {} },
    { item: 'Delete conversation', role: 'alertdialog', name: 'Delete this conversation?', extra: {} },
    { item: 'Revoke public link', role: 'alertdialog', name: 'Revoke public link', extra: { share_url: '/share/t' } },
    { item: 'Remove worktree', role: 'dialog', name: 'Remove worktree', extra: { worktree_branch: 'wt' } },
  ])('keeps $name open through regrouping, then cancels back to the row’s current actions button', async ({ item, role, name, extra }) => {
    const { refresh } = await setup([fresh, { ...old, ...extra }])
    await openAction('old', item)
    const opened = await screen.findByRole(role, { name })
    await waitFor(() => expect(opened).toContainElement(document.activeElement as HTMLElement))
    const before = trigger('old')
    await refresh(regrouped(extra))
    expect(groupOf('old')).toContain('Today')
    expect(trigger('old')).not.toBe(before)
    const dialog = screen.getByRole(role, { name })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument())
    await waitFor(() => expect(trigger('old')).toHaveFocus())
    for (const write of [api.renameSession, api.moveSession, api.deleteSession, api.revokeShare]) expect(write).not.toHaveBeenCalled()
  })

  it('confirms Delete after regrouping and removes the row', async () => {
    const { refresh } = await setup()
    await openAction('old', 'Delete conversation')
    await refresh(regrouped())
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [fresh] } as never)
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('old'))
    await waitFor(() => expect(rowLink('old')).toBeNull())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('confirms Revoke after a remote pin', async () => {
    const { refresh } = await setup([fresh, { ...old, share_url: '/share/t' }])
    await openAction('old', 'Revoke public link')
    await refresh([{ ...old, share_url: '/share/t', pinned: true, sidebar_group: 'pinned' }, fresh])
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke public link' }))
    await waitFor(() => expect(api.revokeShare).toHaveBeenCalledWith('old'))
  })

  it('shows a refused move and restores the server project', async () => {
    vi.mocked(api.moveSession).mockRejectedValueOnce(new Error('no such project'))
    const { refresh } = await setup()
    await openAction('old', 'Move to project')
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: 'Proj' }))
    await refresh(regrouped())
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('no such project', 4000, 'error'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([
    { why: 'the session is deleted elsewhere', rows: [fresh] },
    { why: 'the server makes the session read-only', rows: [fresh, { ...old, read_only: true }] },
  ])('closes Rename when $why instead of leaving an orphaned dialog', async ({ rows }) => {
    const { refresh } = await setup()
    await openAction('old', 'Rename conversation')
    await screen.findByRole('dialog', { name: 'Rename conversation' })
    await refresh(rows)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // A later reopen starts from the server's title, not the dismissed draft.
    await refresh([fresh, old])
    await openAction('old', 'Rename conversation')
    expect(within(await screen.findByRole('dialog')).getByRole('textbox')).toHaveValue('Old chat')
  })

  it('closes Revoke once the share is revoked elsewhere', async () => {
    const { refresh } = await setup([fresh, { ...old, share_url: '/share/t' }])
    await openAction('old', 'Revoke public link')
    await screen.findByRole('alertdialog')
    await refresh(regrouped({ share_url: null }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(api.revokeShare).not.toHaveBeenCalled()
  })

  it('opens a View all row’s dialog inside View all and keeps it through a refresh', async () => {
    const scheduled = Array.from({ length: 6 }, (_, i) => row(`cron${i}`, `Cron ${i}`, { sidebar_group: 'scheduled' }))
    const { refresh } = await setup([...scheduled, fresh])
    await userEvent.click(screen.getByRole('button', { name: /Scheduled sessions/ }))
    await userEvent.click(screen.getByRole('button', { name: 'View all' }))
    const all = await screen.findByRole('dialog', { name: 'Scheduled sessions' })
    const item = [...all.querySelectorAll<HTMLElement>('[data-sid]')].find((el) => el.dataset.sid === 'cron5')!
    await userEvent.click(within(item).getByRole('button', { name: 'Conversation actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename conversation' }))
    const input = within(await screen.findByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox')
    await userEvent.type(input, '!')
    await refresh([...scheduled.map((r) => ({ ...r, title: `${r.title} (server)` })), fresh])
    expect(within(screen.getByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox')).toHaveValue('Cron 5!')
    await userEvent.type(within(screen.getByRole('dialog', { name: 'Rename conversation' })).getByRole('textbox'), '{Enter}')
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('cron5', 'Cron 5!'))
    expect(screen.getByRole('dialog', { name: 'Scheduled sessions' })).toBeInTheDocument()
  })
})
