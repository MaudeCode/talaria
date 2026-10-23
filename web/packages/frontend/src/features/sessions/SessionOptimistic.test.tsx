import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SessionRow } from '../../contracts'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({
  fetchSessions: vi.fn(), searchSessions: vi.fn(), fetchProjects: vi.fn(), archiveSession: vi.fn(), createProject: vi.fn(), importSession: vi.fn(),
  renameSession: vi.fn(), pinSession: vi.fn(), deleteSession: vi.fn(), moveSession: vi.fn(), revokeShare: vi.fn(), removeWorktree: vi.fn(), fetchWorktreeStatus: vi.fn(),
  renameProject: vi.fn(), deleteProject: vi.fn(), duplicateSession: vi.fn(), regenerateTitle: vi.fn(), createShare: vi.fn(), exportSessionUrl: vi.fn(() => ''),
}))
vi.mock('../../api/sse', () => ({ SSE_OPEN: 1, openSessionListStream: () => ({ close: () => undefined, readyState: () => 1 }) }))
vi.mock('./useNewChat', () => ({ useNewChat: () => vi.fn() }))
const router = vi.hoisted(() => ({ navigate: vi.fn(), active: undefined as string | undefined }))
const toast = vi.hoisted(() => vi.fn())
vi.mock('../toast/toast', () => ({ showToast: toast }))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => (router.active ? { sessionId: router.active } : {}),
  useNavigate: () => router.navigate,
  Link: ({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-sid'?: string }) => <div className={className} data-sid={rest['data-sid']}>{children}</div>,
}))
import * as api from '../../api/endpoints'
import { SessionListPanel } from './SessionListPanel'

const now = Date.now() / 1000
const row = (session_id: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  session_id, title, last_message_at: now, sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, ...extra,
})
const alpha = row('alpha', 'Alpha', { project_id: 'p1', share_url: '/share/abc', worktree_branch: 'wt/alpha' })
const beta = row('beta', 'Beta')
const held = () => new Promise<never>(() => undefined)
const refusal = (message: string) => new ApiError({ kind: 'http', status: 409, path: '/x', message })
const shown = () => [...document.querySelectorAll('[data-sid]')].map((el) => el.getAttribute('data-sid'))
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-sid="${id}"]`)!

async function panel() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
  await screen.findByText('Alpha')
}
async function menu(id: string, item: string | RegExp) {
  await userEvent.click(within(rowOf(id)).getByRole('button', { name: 'Conversation actions' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: item }))
}

beforeEach(() => {
  router.active = undefined
  router.navigate.mockReset()
  toast.mockReset()
  vi.mocked(api.fetchSessions).mockReset().mockResolvedValue({ sessions: [alpha, beta] } as never)
  vi.mocked(api.fetchProjects).mockReset().mockResolvedValue({ projects: [{ project_id: 'p1', name: 'Proj', color: '#7cb9ff' }, { project_id: 'p2', name: 'Other' }] } as never)
  vi.mocked(api.fetchWorktreeStatus).mockResolvedValue({ status: { path: '/wt', exists: true, removable: true, force_required: false, dirty: false, untracked_count: 0, ahead_behind: { ahead: 0, behind: 0 }, locked_by_stream: false } } as never)
})

describe('session writes show their result while the server is held (TAL-1179)', () => {
  it('renames at once and closes the dialog on submit', async () => {
    vi.mocked(api.renameSession).mockReturnValue(held())
    await panel()
    await menu('alpha', 'Rename conversation')
    const input = screen.getByRole('textbox', { name: 'Rename conversation' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Renamed{Enter}')
    expect(api.renameSession).toHaveBeenCalledWith('alpha', 'Renamed')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(rowOf('alpha')).getByText('Renamed')).toBeInTheDocument()
    expect(screen.queryByText(/Pending/)).toBeNull()
  })

  it('rolls a refused rename back to the confirmed title and shows the error', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.renameSession).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    await panel()
    await menu('alpha', 'Rename conversation')
    const input = screen.getByRole('textbox', { name: 'Rename conversation' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Renamed{Enter}')
    expect(within(rowOf('alpha')).getByText('Renamed')).toBeInTheDocument()
    refuse(refusal('Title refused'))
    await waitFor(() => expect(within(rowOf('alpha')).getByText('Alpha')).toBeInTheDocument())
    expect(toast).toHaveBeenCalledWith('Title refused', 4000, 'error')
    expect(within(rowOf('beta')).getByText('Beta')).toBeInTheDocument()
  })

  it('moves a pinned row into the Pinned group at once', async () => {
    vi.mocked(api.pinSession).mockReturnValue(held())
    await panel()
    await menu('beta', 'Pin conversation')
    expect(api.pinSession).toHaveBeenCalledWith('beta', true)
    const pinned = screen.getByText('Pinned').closest('.session-date-group')!
    expect(within(pinned as HTMLElement).getByText('Beta')).toBeInTheDocument()
  })

  it('a second toggle replaces the first and runs after it (last write wins)', async () => {
    let first!: (value: unknown) => void
    vi.mocked(api.pinSession).mockReturnValueOnce(new Promise((resolve) => { first = resolve }) as never).mockReturnValueOnce(held())
    await panel()
    await menu('beta', 'Pin conversation')
    await menu('beta', 'Unpin conversation')
    expect(screen.queryByText('Pinned')).toBeNull()
    expect(api.pinSession).toHaveBeenCalledTimes(1)
    first({ ok: true })
    await waitFor(() => expect(api.pinSession).toHaveBeenLastCalledWith('beta', false))
    expect(screen.queryByText('Pinned')).toBeNull()
  })

  it('deletes at once after confirmation, leaving the open chat; Cancel changes nothing', async () => {
    vi.mocked(api.deleteSession).mockReturnValue(held())
    router.active = 'alpha'
    await panel()
    await menu('alpha', 'Delete conversation')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(shown()).toEqual(['alpha', 'beta'])
    expect(api.deleteSession).not.toHaveBeenCalled()
    await menu('alpha', 'Delete conversation')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(shown()).toEqual(['beta'])
    expect(router.navigate).toHaveBeenCalledWith({ to: '/', search: { action: 'new-chat' } })
  })

  it('brings a refused delete back with the error', async () => {
    vi.mocked(api.deleteSession).mockRejectedValue(refusal('Session is running'))
    await panel()
    await menu('alpha', 'Delete conversation')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Session is running', 4000, 'error'))
    expect(shown()).toEqual(['alpha', 'beta'])
  })

  it('keeps an unknown-outcome delete hidden until a fresh read decides', async () => {
    let read!: (value: unknown) => void
    vi.mocked(api.deleteSession).mockRejectedValue(new ApiError({ kind: 'network', path: '/x', message: 'connection lost' }))
    await panel()
    vi.mocked(api.fetchSessions).mockReturnValue(new Promise((resolve) => { read = resolve }) as never)
    await menu('alpha', 'Delete conversation')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(shown()).toEqual(['beta'])
    read({ sessions: [alpha, beta] })
    await waitFor(() => expect(shown()).toEqual(['alpha', 'beta']))
    expect(api.deleteSession).toHaveBeenCalledTimes(1)
  })

  it('moves a session to another project at once and closes the dialog', async () => {
    vi.mocked(api.moveSession).mockReturnValue(held())
    await panel()
    await menu('beta', 'Move to project')
    await userEvent.click(screen.getByRole('combobox', { name: 'Move to project' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Other' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.moveSession).toHaveBeenCalledWith('beta', 'p2')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rowOf('beta').querySelector('.session-project-dot')?.getAttribute('title')).toBe('Other')
  })

  it('revokes a public link at once', async () => {
    vi.mocked(api.revokeShare).mockReturnValue(held())
    await panel()
    await menu('alpha', 'Revoke public link')
    await userEvent.click(screen.getByRole('button', { name: 'Revoke public link' }))
    expect(api.revokeShare).toHaveBeenCalledWith('alpha')
    await userEvent.click(within(rowOf('alpha')).getByRole('button', { name: 'Conversation actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Revoke public link' })).toBeNull()
  })

  it('clears the worktree badge at once and closes the dialog', async () => {
    vi.mocked(api.removeWorktree).mockReturnValue(held())
    await panel()
    expect(within(rowOf('alpha')).getByRole('img', { name: 'Worktree: wt/alpha' })).toBeInTheDocument()
    await menu('alpha', 'Remove worktree')
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(api.removeWorktree).toHaveBeenCalledWith('alpha', false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(rowOf('alpha')).queryByRole('img', { name: 'Worktree: wt/alpha' })).toBeNull()
  })
})

describe('project writes show their result while the server is held (TAL-1179)', () => {
  async function projectMenu(item: string | RegExp, role: 'menuitem' | 'menuitemradio' = 'menuitem') {
    await userEvent.click(screen.getByRole('button', { name: 'Proj' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Project actions' }))
    await userEvent.click(await screen.findByRole(role, { name: item }))
  }

  it('renames a project chip at once', async () => {
    vi.mocked(api.renameProject).mockReturnValue(held())
    await panel()
    await projectMenu('Rename')
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'Renamed project{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Renamed project' })).toBeInTheDocument()
  })

  it('recolors a project chip at once', async () => {
    vi.mocked(api.renameProject).mockReturnValue(held())
    await panel()
    await projectMenu('Gold', 'menuitemradio')
    expect(api.renameProject).toHaveBeenCalledWith('p1', 'Proj', '#f5c542')
    expect(screen.getByRole('button', { name: 'Proj' }).querySelector<HTMLElement>('.color-dot')?.style.background).toBe('rgb(245, 197, 66)')
  })

  it('removes a deleted project chip at once and restores it on refusal', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.deleteProject).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    await panel()
    await projectMenu('Delete')
    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(screen.queryByRole('button', { name: 'Proj' })).toBeNull()
    refuse(refusal('Project in use'))
    await screen.findByRole('button', { name: 'Proj' })
    expect(toast).toHaveBeenCalledWith('Project in use', 4000, 'error')
  })
})
