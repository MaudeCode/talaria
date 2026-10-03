import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { BackgroundTask } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', () => ({
  fetchBackgroundTasks: vi.fn(),
  fetchBackgroundResult: vi.fn(),
  dismissBackgroundTask: vi.fn(),
}))
import * as api from '../../api/endpoints'
import { BackgroundWorkCard, useBackgroundTasks } from './BackgroundWork'
import { ToolCard, type ToolCardData } from '../chat/blocks/ToolCard'

const task = (overrides: Partial<BackgroundTask>): BackgroundTask => ({
  task_id: 't', kind: 'background_command', status: 'running', title: 'summarize repo', started_at: 1, updated_at: 2, completed_at: null,
  result_available: false, child_session_id: null, exit_code: null, agents: null, pinned: true, dismissible: false, ...overrides,
})

function Card({ sessionId }: { sessionId: string }) {
  const tasks = useBackgroundTasks(sessionId).data?.tasks ?? []
  return <BackgroundWorkCard sessionId={sessionId} tasks={tasks} />
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><Card sessionId="sess-1" /></QueryClientProvider>)
}

beforeEach(() => {
  vi.mocked(api.fetchBackgroundTasks).mockReset()
  vi.mocked(api.fetchBackgroundResult).mockReset()
  vi.mocked(api.dismissBackgroundTask).mockReset()
})

describe('Background work card (TAL-372)', () => {
  it('lists only the work the server pins, with each status and the subagent counts', async () => {
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 'sess-1', agent_available: true, tasks: [
      task({ task_id: 'd1', kind: 'delegation', status: 'attention', title: 'Fix CI' }),
      task({ task_id: 'd2', kind: 'delegation', status: 'running', title: '2 subagents: Docs; Tests', agents: { total: 2, completed: 1, failed: 0, running: 1 } }),
      task({ task_id: 'p1', kind: 'process', status: 'unknown', title: 'make test' }),
      task({ task_id: 'old', kind: 'delegation', status: 'completed', title: 'Done long ago', pinned: false }),
    ] })
    renderCard()
    const card = within(await screen.findByRole('region', { name: 'Background work' }))
    expect(card.getByText('Fix CI').closest('li')).toHaveAttribute('data-status', 'attention')
    expect(card.getByText('Needs attention')).toBeInTheDocument()
    expect(card.getByText('1 of 2 done')).toBeInTheDocument()
    expect(card.getByText('Status unknown')).toBeInTheDocument()
    expect(card.queryByText('Done long ago')).not.toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('shows a finished /background result from the server, and Dismiss asks the server', async () => {
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 'sess-1', agent_available: true, tasks: [task({ task_id: 'bg1', status: 'failed', result_available: true, dismissible: true })] })
    vi.mocked(api.fetchBackgroundResult).mockResolvedValue({ task_id: 'bg1', text: '(background task failed)' })
    vi.mocked(api.dismissBackgroundTask).mockResolvedValue({ ok: true, task: task({ task_id: 'bg1', status: 'failed', pinned: false }) })
    renderCard()
    const card = within(await screen.findByRole('region', { name: 'Background work' }))
    expect(card.getByText('Failed')).toBeInTheDocument()
    await userEvent.click(card.getByRole('button', { name: 'Show result' }))
    expect(await card.findByText('(background task failed)')).toBeInTheDocument()
    expect(api.fetchBackgroundResult).toHaveBeenCalledWith('sess-1', 'bg1')
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue({ session_id: 'sess-1', agent_available: true, tasks: [task({ task_id: 'bg1', status: 'failed', pinned: false })] })
    await userEvent.click(card.getByRole('button', { name: 'Dismiss' }))
    expect(api.dismissBackgroundTask).toHaveBeenCalledWith('sess-1', 'bg1')
    await waitFor(() => { expect(screen.queryByRole('region', { name: 'Background work' })).not.toBeInTheDocument() })
  })
})

describe('Delegation row (TAL-372)', () => {
  const call: ToolCardData = { id: 'c1', name: 'delegate_task', kind: 'delegate', target: '', args: {}, preview: null, done: true, isError: false, duration: null, costUsd: null, result: null }
  it('shows the server\'s counts for the work it started, in place', () => {
    const { rerender } = render(<ToolCard call={{ ...call, background: { task_ids: ['a-1', 'a-2'], status: 'running', agents: { total: 3, completed: 0, failed: 0, running: 3 } } }} />)
    expect(screen.getByText('0 of 3 done')).toHaveAttribute('data-background-status', 'running')
    rerender(<ToolCard call={{ ...call, background: { task_ids: ['a-1', 'a-2'], status: 'completed', agents: { total: 3, completed: 2, failed: 1, running: 0 } } }} />)
    expect(screen.getByText('2 of 3 done · 1 failed')).toBeInTheDocument()
    rerender(<ToolCard call={{ ...call, background: { task_ids: ['a-1'], status: 'unknown', agents: { total: 1, completed: 0, failed: 0, running: 1 } } }} />)
    expect(screen.getByText('Status unknown · 0 of 1 done')).toBeInTheDocument()
  })
})
