import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { BackgroundTask } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', () => ({
  fetchBackgroundTasks: vi.fn(),
  listDir: vi.fn(),
  fetchGitInfo: vi.fn(),
  readFile: vi.fn(),
  saveFile: vi.fn(),
  rawFileUrl: (sid: string, path: string) => `api/file/raw?session_id=${sid}&path=${path}`,
  folderDownloadUrl: (sid: string, path: string) => `api/folder?session_id=${sid}&path=${path}`,
  fetchCheckpoints: vi.fn(),
  fetchCheckpointDiff: vi.fn(),
  restoreCheckpoint: vi.fn(),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params, className }: { children: ReactNode; params: { sessionId: string }; className?: string }) => <a href={`/session/${params.sessionId}`} className={className}>{children}</a>,
}))
import * as api from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { ChatSidePanel } from './ChatSidePanel'

const agent = (overrides: Partial<BackgroundTask>): BackgroundTask => ({
  task_id: 'd', kind: 'delegation', status: 'running', title: 'Fix CI', started_at: 1, updated_at: Date.now() / 1000, completed_at: null,
  result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true, ...overrides,
})
const tasks = (list: BackgroundTask[], agent_available = true) => ({ session_id: 's1', agent_available, tasks: list, agents_working: list.some((t) => t.status === 'running' || t.status === 'attention') })

let qc: QueryClient
function Panel({ workspace = '/repo', sessionId = 's1' }: { workspace?: string | null; sessionId?: string }) {
  return <QueryClientProvider client={qc}><ChatSidePanel key={sessionId} sessionId={sessionId} workspace={workspace} open onToggle={() => undefined} onClose={() => undefined} /></QueryClientProvider>
}

beforeEach(() => {
  document.body.innerHTML = '<div id="rightpanelSlot"></div>'
  localStorage.clear()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(api.fetchBackgroundTasks).mockReset().mockResolvedValue(tasks([]))
  vi.mocked(api.listDir).mockReset().mockResolvedValue({ entries: [{ name: 'src', is_dir: true }, { name: 'README.md', size: 10 }] })
  vi.mocked(api.fetchGitInfo).mockReset().mockResolvedValue({ git: null })
})

describe('chat side panel (TAL-373)', () => {
  it('opens on Agents when agents are running, and a later status change never moves the tab', async () => {
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([agent({ task_id: 'd1' })]))
    render(<Panel />)
    await waitFor(() => { expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true') })
    expect(api.fetchBackgroundTasks).toHaveBeenCalledWith('s1', 'delegation')
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([agent({ task_id: 'd1' }), agent({ task_id: 'd2', status: 'attention' })]))
    await qc.invalidateQueries()
    await waitFor(() => { expect(api.fetchBackgroundTasks).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  })

  it('picks the first page from this visit\'s answer, never from a snapshot cached on an earlier visit', async () => {
    // An earlier visit cached a running agent; it finished while the chat was closed.
    qc.setQueryData(['sessions', 'background', 's1', 'agents'], tasks([agent({ task_id: 'd1' })]))
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([agent({ task_id: 'd1', status: 'completed', active: false, pinned: false })]))
    render(<Panel />)
    await waitFor(() => { expect(api.fetchBackgroundTasks).toHaveBeenCalled() })
    await waitFor(() => { expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true') })
  })

  it('asks again on every visit, even within the app\'s stale time, before picking the first page', async () => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } })
    qc.setQueryData(['sessions', 'background', 's1', 'agents'], tasks([agent({ task_id: 'd1' })]))
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([agent({ task_id: 'd1' })]))
    render(<Panel />)
    await waitFor(() => { expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true') })
    expect(api.fetchBackgroundTasks).toHaveBeenCalledWith('s1', 'delegation')
  })

  it('lists only agents even when an older server ignores the kind filter', async () => {
    localStorage.setItem('talaria-right-panel-page', 'agents')
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([agent({ task_id: 'd1' }), agent({ task_id: 'proc_1', kind: 'process', title: 'make test' }), agent({ task_id: 'bg1', kind: 'background_command', title: 'summarize' })]))
    render(<Panel />)
    const list = within(await screen.findByRole('list', { name: 'Agents' }))
    expect(list.getAllByRole('listitem').map((e) => e.getAttribute('data-task-id'))).toEqual(['d1'])
  })

  it('opens on the last chosen page when no agent is running, and remembers a choice', async () => {
    const { unmount } = render(<Panel />)
    await waitFor(() => { expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true') })
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    unmount()
    render(<Panel sessionId="s2" />)
    await waitFor(() => { expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true') })
  })

  it('lists each agent unit apart with its status, progress and transcript link, and says when there are none or the Agent is unreachable', async () => {
    localStorage.setItem('talaria-right-panel-page', 'agents')
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([
      agent({ task_id: 'call-1-1', title: 'Write docs', status: 'completed', active: false, pinned: false, child_sessions: [{ goal: 'Write docs', session_id: 'child-1' }] }),
      agent({ task_id: 'call-1-2', title: '2 subagents: Tests; Run', agents: { total: 2, completed: 1, failed: 0, running: 1 } }),
      agent({ task_id: 'call-1-3', title: '2 subagents: Lint; Format', child_sessions: [{ goal: 'Lint', session_id: 'child-lint' }, { goal: 'Format', session_id: 'child-format' }] }),
    ]))
    const { unmount } = render(<Panel />)
    const list = within(await screen.findByRole('list', { name: 'Agents' }))
    const entries = list.getAllByRole('listitem')
    expect(entries.map((e) => e.getAttribute('data-task-id'))).toEqual(['call-1-1', 'call-1-2', 'call-1-3'])
    // TAL-494: a unit that ran several subagents links each one by its goal.
    expect(within(entries[2]!).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Transcript: Lint', '/session/child-lint'], ['Transcript: Format', '/session/child-format']])
    expect(within(entries[0]!).getByText('Done')).toBeInTheDocument()
    expect(within(entries[0]!).getByRole('link', { name: 'Open transcript' })).toHaveAttribute('href', '/session/child-1')
    expect(within(entries[1]!).getByText('1 of 2 done')).toBeInTheDocument()
    expect(within(entries[1]!).queryByRole('link')).toBeNull()
    unmount()

    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(tasks([], false))
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<Panel />)
    expect(await screen.findByText('The agent can’t report status right now.')).toBeInTheDocument()
    expect(screen.getByText('No agents have run in this chat.')).toBeInTheDocument()
  })

  it('keeps Agents open in a chat without a workspace, where Files says so', async () => {
    render(<Panel workspace={null} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Files' }))
    expect(within(screen.getByRole('tabpanel')).getByText('This chat has no workspace.')).toBeInTheDocument()
    expect(api.listDir).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(await screen.findByText('No agents have run in this chat.')).toBeInTheDocument()
  })

  it('keeps the Files folder while Agents is shown, and fetches files only while Files is shown', async () => {
    render(<Panel />)
    await userEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
    await waitFor(() => { expect(api.listDir).toHaveBeenLastCalledWith('s1', 'src', false) })
    const calls = vi.mocked(api.listDir).mock.calls.length
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    await qc.invalidateQueries()
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(screen.getByText('src', { selector: 'span.font-mono' })).toBeInTheDocument()
    expect(vi.mocked(api.listDir).mock.calls.slice(calls).every(([, dir]) => dir === 'src')).toBe(true)
  })
})

describe('chat side panel Checkpoints (TAL-571)', () => {
  const checkpoints = { checkpoints: [{ id: 'c1', commit: 'abc', message: 'before edit', date: '', date_display: '', files: 1, path: '/ck/c1' }], workspace: '/repo', checkpoint_dir: '/ck' }
  const restored = (errors: { file: string; error: string }[] = []) => ({ ok: true as const, checkpoint: 'c1', workspace: '/repo', files_restored: errors.length ? [] : ['notes.txt'], files_restored_count: errors.length ? 0 : 1, errors })
  beforeEach(() => {
    vi.mocked(showToast).mockReset()
    vi.mocked(api.fetchCheckpoints).mockReset().mockResolvedValue(checkpoints)
    vi.mocked(api.listDir).mockResolvedValue({ entries: [{ name: 'notes.txt', size: 10 }] })
  })
  const restore = async () => {
    await userEvent.click(screen.getByRole('tab', { name: 'Checkpoints' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore' }))
    await waitFor(() => { expect(api.restoreCheckpoint).toHaveBeenCalledWith('s1', 'c1') })
  }

  it('drops an unsaved Files draft of a file the restore rewrote', async () => {
    vi.mocked(api.readFile).mockReset().mockResolvedValue({ content: 'agent text', binary: false, size: 10 })
    vi.mocked(api.restoreCheckpoint).mockReset().mockResolvedValue(restored())
    render(<Panel />)
    await userEvent.click(await screen.findByRole('treeitem', { name: 'notes.txt' }))
    await userEvent.type(await screen.findByRole('textbox', { name: 'Preview' }), ' plus my edit')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    vi.mocked(api.readFile).mockResolvedValue({ content: 'saved text', binary: false, size: 10 })
    await restore()
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))
    await waitFor(() => { expect(screen.getByRole('textbox', { name: 'Preview' })).toHaveValue('saved text') })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('reports a restore with per-file errors as a failure, never as restored', async () => {
    vi.mocked(api.restoreCheckpoint).mockReset().mockResolvedValue(restored([{ file: 'notes.txt', error: 'Permission denied' }]))
    render(<Panel />)
    await screen.findByRole('tab', { name: 'Checkpoints' })
    await restore()
    await waitFor(() => { expect(showToast).toHaveBeenCalledWith('Restore: notes.txt: Permission denied', 6000, 'error') })
    expect(showToast).not.toHaveBeenCalledWith('Checkpoint restored')
  })
})
