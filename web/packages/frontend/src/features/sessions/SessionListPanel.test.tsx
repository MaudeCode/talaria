import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SessionRow } from '../../contracts'

vi.mock('../../api/endpoints', () => ({ fetchSessions: vi.fn(), searchSessions: vi.fn(), fetchProjects: vi.fn(), archiveSession: vi.fn(), createProject: vi.fn() }))
vi.mock('../../api/sse', () => ({ openSessionListStream: () => ({ close: () => undefined, readyState: () => 1 }) }))
vi.mock('./useNewChat', () => ({ useNewChat: () => vi.fn() }))
vi.mock('./SessionContextMenu', () => ({ SessionContextMenu: () => null }))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({}),
  Link: ({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-sid'?: string }) => <a className={className} data-sid={rest['data-sid']}>{children}</a>,
}))
import * as api from '../../api/endpoints'
import { SessionListPanel } from './SessionListPanel'

const now = Date.now() / 1000
const row = (session_id: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  session_id, title, last_message_at: now, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_duplicate: true, source_kind: 'webui', is_messaging_session: false, ...extra,
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
})
