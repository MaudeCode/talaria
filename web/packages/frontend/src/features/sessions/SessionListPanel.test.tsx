import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SessionsListSchema, type SessionRow } from '../../contracts'
import { ApiError } from '../../contracts/common'

vi.mock('../../api/endpoints', () => ({ fetchSettings: () => Promise.resolve({ sound_enabled: false }), fetchSessions: vi.fn(), searchSessions: vi.fn(), fetchProjects: vi.fn(), archiveSession: vi.fn(), createProject: vi.fn(), importSession: vi.fn() }))
const sessionEvents = vi.hoisted(() => ({ emit: vi.fn<(event: { event: string; data: { session_id?: string; reason?: string } }) => void>() }))
vi.mock('../../api/sse', () => ({ SSE_OPEN: 1, openSessionListStream: ({ onEvent }: { onEvent: typeof sessionEvents.emit }) => { sessionEvents.emit.mockImplementation(onEvent); return { close: () => undefined, readyState: () => 1 } } }))
vi.mock('./useNewChat', () => ({ useNewChat: () => vi.fn() }))
const rowRender = vi.hoisted(() => vi.fn())
vi.mock('./SessionContextMenu', () => ({ SessionActions: ({ children }: { children: ReactNode }) => children, SessionContextMenu: ({ row }: { row: SessionRow }) => { rowRender(row.session_id); return null }, SessionMenuItems: () => null }))
const navigate = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())
vi.mock('../toast/toast', () => ({ showToast: toast }))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({}),
  useNavigate: () => navigate,
  Link: ({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-sid'?: string }) => <a className={className} data-sid={rest['data-sid']}>{children}</a>,
}))
import * as api from '../../api/endpoints'
import { groupSessionRows, SessionListItem, SessionListPanel } from './SessionListPanel'
import { useSessionListStream } from './useSessionListStream'

const now = Date.now() / 1000
const row = (session_id: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  session_id, title, last_message_at: now, sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, source_kind: 'webui', is_messaging_session: false, ...extra,
})
const alpha = row('alpha', 'Alpha zebra', { project_id: 'p1' })
const delta = row('delta', 'Delta', { project_id: 'p1' })
const other = row('other', 'Other zebra')
const cli = row('cli', 'Cli zebra', { project_id: 'p1', is_cli_session: true, source_kind: 'cli' })
const shown = () => [...document.querySelectorAll('[data-sid]')].map((el) => el.getAttribute('data-sid'))

beforeEach(() => {
  vi.mocked(api.fetchSessions).mockReset().mockResolvedValue({ sessions: [alpha, delta, other, cli] } as never)
  vi.mocked(api.fetchProjects).mockReset().mockResolvedValue({ projects: [{ project_id: 'p1', name: 'Proj' }] } as never)
  vi.mocked(api.searchSessions).mockReset()
})

describe('SessionListPanel search (TAL-308)', () => {
  it('sends the selected project and source, then shows exactly the server result in its order', async () => {
    let answer: (value: unknown) => void = () => undefined
    vi.mocked(api.searchSessions).mockReturnValue(new Promise((resolve) => { answer = resolve }) as never)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Proj' }))
    await userEvent.type(screen.getByRole('searchbox'), 'zebra')
    await waitFor(() => { expect(api.searchSessions).toHaveBeenLastCalledWith('zebra', { project_id: 'p1', sidebar_source: 'webui', include_archived: false }, 5, expect.any(AbortSignal)) })
    // While the request is in flight, the local title filter answers.
    expect(shown()).toEqual(['alpha'])
    answer({ sessions: [{ ...delta, match_type: 'content', match_preview: 'a zebra here' }, { ...alpha, match_type: 'title' }], sidebar_filtered: true, all_profiles: false, active_profile: 'default' })
    await waitFor(() => { expect(shown()).toEqual(['delta', 'alpha']) })
    expect(screen.getByText('a zebra here')).toBeInTheDocument()
  })

  it('shows a server match for words in another order (TAL-453)', async () => {
    vi.mocked(api.searchSessions).mockResolvedValue({ sessions: [{ ...alpha, match_type: 'title' }], sidebar_filtered: true, all_profiles: false, active_profile: 'default' } as never)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByRole('button', { name: 'Proj' })
    await userEvent.type(screen.getByRole('searchbox'), 'zebra alpha')
    await waitFor(() => { expect(shown()).toEqual(['alpha']) })
  })
})

describe('sidebar search work (TAL-1390)', () => {
  it('debounces a burst into one request and aborts it when the next term settles', async () => {
    vi.mocked(api.searchSessions).mockReturnValue(new Promise(() => undefined))
    const panel = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    vi.useFakeTimers()
    try {
      for (const value of ['h', 'he', 'hel', 'hell', 'hello']) {
        fireEvent.change(screen.getByRole('searchbox'), { target: { value } })
        await act(() => vi.advanceTimersByTimeAsync(20))
      }
      expect(api.searchSessions).not.toHaveBeenCalled()
      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(api.searchSessions).toHaveBeenCalledTimes(1)
      expect(vi.mocked(api.searchSessions).mock.calls[0]?.[0]).toBe('hello')
      const signal = vi.mocked(api.searchSessions).mock.calls[0]![3]!
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hello again' } })
      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(signal.aborted).toBe(true)
      expect(api.searchSessions).toHaveBeenCalledTimes(2)
      const nextSignal = vi.mocked(api.searchSessions).mock.calls[1]![3]!
      panel.unmount()
      expect(nextSignal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('keeps server content matches visible while the next term is loading', async () => {
    vi.mocked(api.searchSessions).mockImplementation((q) => q === 'zebra'
      ? Promise.resolve({ sessions: [{ ...delta, match_preview: 'server content preview', match_type: 'content' }], sidebar_filtered: true, all_profiles: false, active_profile: 'default' })
      : new Promise(() => undefined))
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebra' } })
    await waitFor(() => expect(shown()).toEqual(['delta']))
    rowRender.mockClear()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebras' } })
    await waitFor(() => expect(api.searchSessions).toHaveBeenLastCalledWith('zebras', expect.any(Object), 5, expect.any(AbortSignal)))
    expect(shown()).toEqual(['delta'])
    expect(rowRender).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    await waitFor(() => expect(shown()).toEqual(['alpha', 'delta', 'other']))
    expect(screen.queryByText('server content preview')).toBeNull()
  })

  it.each(['', 'x'])('does not resurrect old matches after pausing on %j', async (shortTerm) => {
    let answer!: (value: Awaited<ReturnType<typeof api.searchSessions>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof api.searchSessions>>>((resolve) => { answer = resolve })
    vi.mocked(api.searchSessions).mockImplementation((q) => q === 'zebra'
      ? Promise.resolve({ sessions: [delta], sidebar_filtered: true, all_profiles: false, active_profile: 'default' })
      : q === 'alpha' ? pending : new Promise(() => undefined))
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebra' } })
    await waitFor(() => expect(shown()).toEqual(['delta']))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: shortTerm } })
    await waitFor(() => expect(shown()).toEqual(shortTerm ? [] : ['alpha', 'delta', 'other']))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alpha' } })
    await waitFor(() => expect(api.searchSessions).toHaveBeenLastCalledWith('alpha', expect.any(Object), 5, expect.any(AbortSignal)))
    expect(shown()).toEqual(['alpha'])
    answer({ sessions: [other], sidebar_filtered: true, all_profiles: false, active_profile: 'default' })
    await waitFor(() => expect(shown()).toEqual(['other']))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alphas' } })
    await waitFor(() => expect(api.searchSessions).toHaveBeenLastCalledWith('alphas', expect.any(Object), 5, expect.any(AbortSignal)))
    expect(shown()).toEqual(['other'])
  })

  it('drops retained matches when the project or source scope changes', async () => {
    vi.mocked(api.searchSessions).mockResolvedValueOnce({ sessions: [other], sidebar_filtered: true, all_profiles: false, active_profile: 'default' })
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebra' } })
    await waitFor(() => expect(shown()).toEqual(['other']))
    vi.mocked(api.searchSessions).mockReturnValue(new Promise(() => undefined))
    await userEvent.click(screen.getByRole('button', { name: 'Proj' }))
    expect(shown()).toEqual(['alpha'])
    await userEvent.click(screen.getByRole('button', { name: /CLI/ }))
    expect(shown()).toEqual(['cli'])
  })

  it('does not render unchanged visible rows while typing', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    await screen.findByRole('button', { name: 'Proj' })
    rowRender.mockClear()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } })
    expect(shown()).toEqual(['alpha', 'delta', 'other'])
    expect(rowRender).not.toHaveBeenCalled()
  })
})

describe('SessionListPanel Agent storage notice (TAL-785)', () => {
  const panel = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)

  it('says damaged storage instead of an empty Agent history, with the server reason behind the help tip', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha], agent_storage: { state: 'corrupt', reason: 'state.db is damaged: database disk image is malformed.' } } as never)
    panel()
    expect(await screen.findByText('Agent session storage is damaged')).toBeInTheDocument()
    expect(screen.queryByText(/upgrade hermes-agent/i)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Agent session storage is damaged/ }))
    expect(await screen.findByText('state.db is damaged: database disk image is malformed.')).toBeInTheDocument()
  })

  it('keeps the upgrade hint for an older hermes-agent, says unreadable storage, and shows nothing for healthy storage', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha], agent_storage: { state: 'outdated', reason: null } } as never)
    const { unmount } = panel()
    expect(await screen.findByText('Upgrade hermes-agent to list Agent sessions')).toBeInTheDocument()
    unmount()
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha], agent_storage: { state: 'unavailable', reason: 'state.db could not be read: database is locked.' } } as never)
    const unavailable = panel()
    expect(await screen.findByText('Agent sessions could not be read')).toBeInTheDocument()
    unavailable.unmount()
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha], agent_storage: { state: 'ok', reason: null } } as never)
    panel()
    await screen.findByText('Alpha zebra')
    expect(screen.queryByText(/Agent session storage|Agent sessions could not|Upgrade hermes-agent/)).toBeNull()
  })
})

describe('SessionListPanel import (TAL-607)', () => {
  it('posts the chosen JSON export and opens the created session', async () => {
    vi.mocked(api.importSession).mockResolvedValue({ ok: true, session: { ...alpha, session_id: 'imported' } } as never)
    const { container } = render(<QueryClientProvider client={new QueryClient()}><SessionListPanel /></QueryClientProvider>)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    await userEvent.upload(input, new File([JSON.stringify({ title: 'Saved', messages: [{ role: 'user', content: 'hi' }] })], 'saved.json', { type: 'application/json' }))
    await waitFor(() => { expect(navigate).toHaveBeenCalledWith({ to: '/session/$sessionId', params: { sessionId: 'imported' } }) })
    expect(api.importSession).toHaveBeenCalledWith({ title: 'Saved', messages: [{ role: 'user', content: 'hi' }] })
  })
})

describe('session list date groups (TAL-306)', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { session_list: { sessions: unknown[] } }
  const rows = SessionsListSchema.shape.sessions.parse(fixture.session_list.sessions)

  it('allocates one group array for 5,000 rows instead of replacing it for every row (TAL-1211)', () => {
    const at = new Date(2026, 9, 22, 12).getTime()
    const many = Array.from({ length: 5_000 }, (_, i) => row(`large-${String(i)}`, 'Large list', { sort_ts: at / 1000 }))
    const allocations = new Set<SessionRow[]>()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the original Map receiver below.
    const set = Map.prototype.set
    const builder = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key, value) {
      if (key === 'today' && Array.isArray(value) && value[0] === many[0]) allocations.add(value)
      return set.call(this, key, value)
    })
    let groups: ReturnType<typeof groupSessionRows>
    try { groups = groupSessionRows(many, at) } finally { builder.mockRestore() }
    expect(groups).toEqual([{ id: 'today', rows: many }])
    expect(allocations.size).toBe(1)
  })

  it('groups 1,000 interleaved rows at local day boundaries in server order (TAL-1390)', () => {
    const today = new Date(2026, 9, 22)
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    const week = new Date(today); week.setDate(today.getDate() - 7)
    const buckets = ['pinned', 'today', 'yesterday', 'week', 'older'] as const
    const timestamps = [0, today.getTime(), yesterday.getTime(), week.getTime(), week.getTime() - 1]
    const many = Array.from({ length: 1_000 }, (_, i) => row(`group-${String(i)}`, 'Grouped', { pinned: i % 5 === 0, sidebar_group: i % 5 === 0 ? 'pinned' : 'recent', sort_ts: timestamps[i % 5]! / 1000 }))
    const groups = groupSessionRows(many, today.getTime() + 3_600_000)
    expect(groups.map((g) => g.id)).toEqual(buckets)
    groups.forEach((g, index) => expect(g.rows).toEqual(many.filter((_, i) => i % 5 === index)))
  })

  it('keeps the server order inside every group', () => {
    const at = (rows.find((r) => r.session_id === 'tal306-created-only')!.sort_ts + 60) * 1000
    const groups = groupSessionRows(rows, at)
    expect(groups.flatMap((g) => g.rows)).toHaveLength(rows.length)
    for (const group of groups) {
      const ids = new Set(group.rows.map((r) => r.session_id))
      expect(group.rows.map((r) => r.session_id), group.id).toEqual(rows.filter((r) => ids.has(r.session_id)).map((r) => r.session_id))
    }
    expect(groups.find((g) => g.id === 'today')?.rows.map((r) => r.session_id)).toContain('tal306-created-only')
  })

  it('buckets by the server sort_ts, not a client-picked timestamp', () => {
    const at = new Date(2026, 9, 22, 12).getTime()
    const day = 86_400
    const recent = { ...rows.find((r) => r.session_id === 'tal306-newest')!, sort_ts: at / 1000 - 60, last_message_at: at / 1000 - 30 * day, updated_at: at / 1000 - 30 * day }
    expect(groupSessionRows([recent], at).map((g) => g.id)).toEqual(['today'])
  })
})

describe('Scheduled and Webhook disclosures (TAL-1639)', () => {
  const cron = Array.from({ length: 6 }, (_, i) => row(`cron-${String(i)}`, `Cron run ${String(i)}`, { source_kind: 'cron', sidebar_group: 'scheduled', sort_ts: now - i }))
  const hook = row('hook', 'Hook run', { source_kind: 'webhook', sidebar_group: 'webhook' })
  // The server's group decides: a cron-sourced row it files under Recents stays there.
  const recentCron = row('recent-cron', 'Recent cron', { source_kind: 'cron', sidebar_group: 'recent' })
  const listed = (sessions: SessionRow[], counts = { scheduled_session_count: 6, scheduled_sessions_truncated: true, webhook_session_count: 1, webhook_sessions_truncated: false }) =>
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions, ...counts } as never)
  const panel = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
  // A collapsed group keeps its rows mounted but hidden.
  const visible = (scope = '') => [...document.querySelectorAll<HTMLElement>(`${scope} [data-sid]`)].filter((el) => el.closest<HTMLElement>('.session-date-body')?.style.display !== 'none').map((el) => el.dataset.sid)

  it('files server-grouped rows under collapsed disclosures with the server counts, outside the date groups', async () => {
    listed([{ ...alpha, sidebar_group: 'recent' }, recentCron, ...cron, hook])
    panel()
    const scheduled = await screen.findByRole('button', { name: /Scheduled sessions/ })
    const webhook = screen.getByRole('button', { name: /Webhook sessions/ })
    expect(scheduled).toHaveAttribute('aria-expanded', 'false')
    expect(webhook).toHaveAttribute('aria-expanded', 'false')
    expect(scheduled).toHaveTextContent('6+')
    expect(webhook).toHaveTextContent('1')
    expect(visible()).toEqual(['alpha', 'recent-cron'])
    expect(visible('.session-date-group:not(.session-disclosure)')).toEqual(['alpha', 'recent-cron'])

    await userEvent.click(scheduled)
    expect(scheduled).toHaveAttribute('aria-expanded', 'true')
    expect(visible()).toEqual(['alpha', 'recent-cron', 'cron-0', 'cron-1', 'cron-2', 'cron-3', 'cron-4'])
    await userEvent.click(screen.getByRole('button', { name: 'View all' }))
    const dialog = await screen.findByRole('dialog', { name: 'Scheduled sessions' })
    expect([...dialog.querySelectorAll('[data-sid]')].map((el) => el.getAttribute('data-sid'))).toEqual(cron.map((r) => r.session_id))
  })

  it('searches the View all list through the server and keeps only its rows of that group', async () => {
    listed([alpha, ...cron, hook])
    vi.mocked(api.searchSessions).mockResolvedValue({ sessions: [{ ...cron[4]!, match_type: 'content', match_preview: 'nightly zebra' }, { ...alpha, sidebar_group: 'recent', match_type: 'title' }], sidebar_filtered: true, all_profiles: false, active_profile: 'default' } as never)
    panel()
    await userEvent.click(await screen.findByRole('button', { name: /Scheduled sessions/ }))
    await userEvent.click(screen.getByRole('button', { name: 'View all' }))
    const dialog = await screen.findByRole('dialog', { name: 'Scheduled sessions' })
    await userEvent.type(within(dialog).getByRole('searchbox'), 'zebra')
    await waitFor(() => { expect([...dialog.querySelectorAll('[data-sid]')].map((el) => el.getAttribute('data-sid'))).toEqual(['cron-4']) })
    expect(api.searchSessions).toHaveBeenLastCalledWith('zebra', { project_id: undefined, sidebar_source: undefined, include_archived: false }, 5, expect.any(AbortSignal))
    expect(within(dialog).getByText('nightly zebra')).toBeInTheDocument()
  })

  it('says a failed View all search failed and retries it', async () => {
    listed([alpha, ...cron, hook])
    vi.mocked(api.searchSessions).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ sessions: [cron[2]!], sidebar_filtered: true, all_profiles: false, active_profile: 'default' })
    panel()
    await userEvent.click(await screen.findByRole('button', { name: /Scheduled sessions/ }))
    await userEvent.click(screen.getByRole('button', { name: 'View all' }))
    const dialog = await screen.findByRole('dialog', { name: 'Scheduled sessions' })
    await userEvent.type(within(dialog).getByRole('searchbox'), 'digest')
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect([...dialog.querySelectorAll('[data-sid]')].map((el) => el.getAttribute('data-sid'))).toEqual(['cron-2']) })
  })

  it('shows no disclosure the server lists no rows for', async () => {
    listed([alpha, other], { scheduled_session_count: 0, scheduled_sessions_truncated: false, webhook_session_count: 0, webhook_sessions_truncated: false })
    panel()
    await screen.findByText('Alpha zebra')
    expect(screen.queryByRole('button', { name: /Scheduled sessions|Webhook sessions/ })).toBeNull()
  })
})

describe('session row renders (TAL-1211)', () => {
  it('renders only the changed row after a refetch changes one title', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha, delta, other] } as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    // The authenticated layout owns the feed; the panel only renders its shared query cache.
    renderHook(useSessionListStream, { wrapper })
    render(<SessionListPanel />, { wrapper })
    await screen.findByText('Alpha zebra')
    await screen.findByRole('button', { name: 'Proj' })
    rowRender.mockClear()
    // A fresh wire response has fresh objects; Query's structural sharing preserves unchanged rows.
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [{ ...alpha, title: 'Alpha renamed' }, { ...delta }, { ...other }] } as never)
    act(() => sessionEvents.emit({ event: 'sessions_changed', data: { session_id: 'alpha', reason: 'title' } }))
    await screen.findByText('Alpha renamed')
    expect(rowRender.mock.calls.map(([id]) => id)).toEqual(['alpha'])

    rowRender.mockClear()
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [{ project_id: 'p1', name: 'Renamed project', color: '#50c878' }] } as never)
    await act(() => qc.refetchQueries({ queryKey: ['projects'] }))
    await screen.findByRole('button', { name: 'Renamed project' })
    // Rows outside the renamed project keep their subtree; the compiled rows in it may skip the unchanged menu.
    expect(rowRender.mock.calls.map(([id]) => id)).not.toContain('other')
    expect(document.querySelector('[data-sid="alpha"] .session-project-dot')).toHaveAttribute('title', 'Renamed project')
    expect(document.querySelector('[data-sid="alpha"] .session-project-dot')).toHaveStyle({ background: '#50c878' })
  })
})

describe('session row archive toggle (TAL-1633)', () => {
  const item = (r: SessionRow, onArchive = vi.fn()) => render(<SessionListItem row={r} active={false} proj={undefined} preview={undefined} timeLabel="now" onArchive={onArchive} />)

  it.each([
    ['a Claude Code import', row('cc', 'Imported', { can_archive: false, read_only: true, source_kind: 'claude_code' })],
    ['an archived subagent child', row('sub', 'Child', { can_archive: false, archived: true })],
  ])('hides the archive and restore toggle on %s the server refuses to archive', (_label, refused) => {
    item(refused)
    expect(screen.queryByRole('button', { name: /Archive|Restore/ })).toBeNull()
    expect(document.querySelector('.session-archive-toggle')).toBeNull()
  })

  it('keeps the toggle on an archivable row and archives it', async () => {
    const onArchive = vi.fn()
    item(alpha, onArchive)
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(onArchive).toHaveBeenCalledWith('alpha', true)
  })
})

describe('optimistic session and project writes (TAL-1179)', () => {
  it('drops an archived row at once, before the write answers', async () => {
    let answer!: (value: unknown) => void
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha, other] } as never)
    vi.mocked(api.archiveSession).mockReturnValue(new Promise((resolve) => { answer = resolve }) as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    await userEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]!)
    await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith('alpha', true))
    expect(shown()).toEqual(['other'])
    expect(screen.queryByText(/Pending/)).toBeNull()
    // The overlay never enters the cached server snapshot.
    expect(qc.getQueryData<{ sessions: SessionRow[] }>(['sessions', 'list', {}])?.sessions[0]?.archived).not.toBe(true)
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [other] } as never)
    answer({ ok: true })
    await waitFor(() => expect(vi.mocked(api.fetchSessions).mock.calls.length).toBeGreaterThan(1))
    expect(shown()).toEqual(['other'])
  })

  it('restores only the refused row and shows the error', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha, other] } as never)
    vi.mocked(api.archiveSession).mockImplementation((id) => id === 'alpha' ? new Promise((_, reject) => { refuse = reject }) as never : new Promise(() => undefined) as never)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    const [first, second] = screen.getAllByRole('button', { name: 'Archive' })
    await userEvent.click(first!)
    await userEvent.click(second!)
    expect(shown()).toEqual([])
    refuse(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'Session is busy' }))
    await waitFor(() => expect(shown()).toEqual(['alpha']))
    expect(toast).toHaveBeenCalledWith('Session is busy', 4000, 'error')
  })

  it('shows a new project chip at once and adopts the server project', async () => {
    let answer!: (value: unknown) => void
    vi.spyOn(window, 'prompt').mockReturnValueOnce('New project')
    vi.mocked(api.createProject).mockReturnValue(new Promise((resolve) => { answer = resolve }) as never)
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    await userEvent.click(screen.getByRole('button', { name: 'New project' }))
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith('New project'))
    expect(screen.getByText('New project', { selector: '.project-chip span' })).toBeInTheDocument()
    expect(screen.queryByText(/Pending/)).toBeNull()
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [{ project_id: 'new-server-id', name: 'Canonical project' }] } as never)
    answer({ project: { project_id: 'new-server-id', name: 'Canonical project' } })
    await screen.findByRole('button', { name: 'Canonical project' })
    expect(screen.queryByText('New project', { selector: '.project-chip span' })).toBeNull()
  })

  it('removes the provisional project chip when creation is refused', async () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce('Taken')
    vi.mocked(api.createProject).mockRejectedValue(new ApiError({ kind: 'http', status: 400, path: '/x', message: 'Name taken' }))
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionListPanel /></QueryClientProvider>)
    await screen.findByText('Alpha zebra')
    await userEvent.click(screen.getByRole('button', { name: 'New project' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Name taken', 4000, 'error'))
    expect(screen.queryByText('Taken')).toBeNull()
  })
})
