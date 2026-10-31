import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRow } from '../../contracts'

vi.mock('../../api/endpoints', () => ({ fetchSessions: vi.fn(), searchSessions: vi.fn(), fetchProjects: vi.fn(), archiveSession: vi.fn() }))
vi.mock('./useNewChat', () => ({ useNewChat: () => vi.fn() }))
import * as api from '../../api/endpoints'
import { openMobileSidebar, useShellState } from '../../shell/useShellState'
import { SessionListPanel } from './SessionListPanel'

const now = Date.now() / 1000
const row = (session_id: string, title: string): SessionRow => ({
  session_id, title, last_message_at: now, sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false,
})

beforeEach(() => {
  vi.mocked(api.fetchSessions).mockReset().mockResolvedValue({ sessions: [row('alpha', 'Alpha'), row('beta', 'Beta')] } as never)
  vi.mocked(api.fetchProjects).mockReset().mockResolvedValue({ projects: [] } as never)
  vi.mocked(api.archiveSession).mockReset().mockResolvedValue({ ok: true } as never)
  window.scrollTo = vi.fn()
})

async function setup(path = '/session/alpha') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const opened = vi.fn()
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><SessionListPanel /><Outlet /></QueryClientProvider> })
  const session = createRoute({ getParentRoute: () => root, path: '/session/$sessionId', component: function Session() { const params: { sessionId?: string } = useParams({ strict: false }); opened(params.sessionId); return null } })
  const router = createRouter({ routeTree: root.addChildren([session]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  await screen.findByText('Beta')
  return { router, opened }
}

describe('sidebar conversation rows (TAL-1120)', () => {
  it('exposes each row as a named link inside a list item, marking the open conversation', async () => {
    await setup()
    const list = document.getElementById('sessionList')!
    expect(list).toHaveAttribute('role', 'list')
    const alpha = screen.getByRole('link', { name: /^Alpha/ })
    const beta = screen.getByRole('link', { name: /^Beta/ })
    expect(alpha).toHaveAttribute('href', '/session/alpha')
    expect(beta).toHaveAttribute('href', '/session/beta')
    expect(alpha).toHaveAttribute('aria-current', 'page')
    expect(beta).not.toHaveAttribute('aria-current')
    // The link names the conversation, not the row's action buttons.
    expect(alpha).toHaveAccessibleName(expect.not.stringMatching(/Archive|Conversation actions/))
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[1]).toContainElement(beta)
  })

  it('opens a conversation once on Enter and closes the mobile sidebar', async () => {
    const { router, opened } = await setup()
    const { result } = renderHook(() => useShellState())
    act(() => openMobileSidebar())
    expect(result.current.mobileOpen).toBe(true)
    opened.mockClear()
    const beta = screen.getByRole('link', { name: /^Beta/ })
    beta.focus()
    expect(beta).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/session/beta'))
    expect(opened.mock.calls).toEqual([['beta']])
    expect(result.current.mobileOpen).toBe(false)
    expect(screen.getByRole('link', { name: /^Beta/ })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the row actions independent of the link', async () => {
    const { router } = await setup()
    const items = within(document.getElementById('sessionList')!).getAllByRole('listitem')
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith('beta', true))
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Conversation actions' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/session/alpha')
  })
})
