import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SessionsListSchema, type SessionRow } from '../../contracts'

vi.mock('../../api/endpoints', () => ({ fetchSessions: vi.fn(), searchSessions: vi.fn(), fetchProjects: vi.fn(), archiveSession: vi.fn(), createProject: vi.fn(), importSession: vi.fn() }))
vi.mock('../../api/sse', () => ({ openSessionListStream: () => ({ close: () => undefined, readyState: () => 1 }) }))
vi.mock('./useNewChat', () => ({ useNewChat: () => vi.fn() }))
vi.mock('./SessionContextMenu', () => ({ SessionContextMenu: () => null }))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({}),
  useNavigate: () => navigate,
  Link: ({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-sid'?: string }) => <a className={className} data-sid={rest['data-sid']}>{children}</a>,
}))
import * as api from '../../api/endpoints'
import { groupSessionRows, SessionListPanel } from './SessionListPanel'

const now = Date.now() / 1000
const row = (session_id: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  session_id, title, last_message_at: now, sort_ts: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, ...extra,
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
    await waitFor(() => { expect(api.searchSessions).toHaveBeenLastCalledWith('zebra', { project_id: 'p1', sidebar_source: 'webui', include_archived: false }) })
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

  it('keeps the upgrade hint for an older hermes-agent and shows nothing for healthy storage', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha], agent_storage: { state: 'outdated', reason: null } } as never)
    const { unmount } = panel()
    expect(await screen.findByText('Upgrade hermes-agent to list Agent sessions')).toBeInTheDocument()
    unmount()
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [alpha], agent_storage: { state: 'ok', reason: null } } as never)
    panel()
    await screen.findByText('Alpha zebra')
    expect(screen.queryByText(/Agent session storage|Upgrade hermes-agent/)).toBeNull()
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
    const at = Date.now()
    const day = 86_400
    const recent = { ...rows.find((r) => r.session_id === 'tal306-newest')!, sort_ts: at / 1000 - 60, last_message_at: at / 1000 - 30 * day, updated_at: at / 1000 - 30 * day }
    expect(groupSessionRows([recent], at).map((g) => g.id)).toEqual(['today'])
  })
})
