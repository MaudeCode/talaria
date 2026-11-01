import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import type { BackgroundTask, DelegationStatus } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', () => ({ fetchBackgroundTasks: vi.fn(), stopBackgroundTask: vi.fn(), dismissBackgroundTask: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
import * as api from '../../api/endpoints'
import { AgentsPage } from './AgentsPage'

/** The shared states the server ships (contracts/fixtures/delegation-status.json). */
const states = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/delegation-status.json'), 'utf8')) as Record<string, DelegationStatus>
const done: BackgroundTask = {
  task_id: 'd1', kind: 'delegation', status: 'completed', title: 'Fix CI', started_at: 1, updated_at: Date.now() / 1000, completed_at: 2,
  result_available: true, child_sessions: [], exit_code: null, agents: null, pinned: false, dismissible: false, active: false,
}
const response = (delegation_status?: DelegationStatus, sessionId = 's1') => ({ session_id: sessionId, agent_available: true, tasks: [done], ...(delegation_status ? { delegation_status } : {}) })

let qc: QueryClient
const renderPage = (sessionId = 's1') => render(<QueryClientProvider client={qc}><AgentsPage sessionId={sessionId} active /></QueryClientProvider>)
const summary = () => document.querySelector('.agents-delivery')

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(api.fetchBackgroundTasks).mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('Agents page delegation summary (TAL-1579)', () => {
  it.each([
    ['available_zero', 'Nothing running or awaiting delivery'],
    ['running', '2 running'],
    ['awaiting_delivery', '1 awaiting delivery'],
    ['running_and_awaiting', '1 running · 3 awaiting delivery'],
    ['unknown', 'Delivery status unavailable'],
    ['unsupported', 'This chat’s owner doesn’t report delivery status'],
  ])('words the %s summary the server sends', async (state, text) => {
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(response(states[state]))
    renderPage()
    expect(await screen.findByText(text)).toHaveAttribute('role', 'status')
    expect(summary()).toHaveAttribute('data-availability', states[state]!.availability)
  })

  it('shows a dispatch the live registry holds before the ledger counts it as running', async () => {
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(response({ ...states.available_zero!, memory_live: true, refresh: true }))
    renderPage()
    expect(await screen.findByText('Running', { selector: '.agents-delivery' })).toBeInTheDocument()
  })

  it('shows nothing when the server hides the summary or is older than it', async () => {
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(response(states.hidden))
    const { unmount } = renderPage()
    expect(await screen.findByText('Fix CI')).toBeInTheDocument()
    expect(summary()).toBeNull()
    unmount()
    qc.clear()
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValue(response())
    renderPage()
    expect(await screen.findByText('Fix CI')).toBeInTheDocument()
    expect(summary()).toBeNull()
  })

  it('keeps refreshing while the server asks, even with no task still active', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(api.fetchBackgroundTasks).mockResolvedValueOnce(response(states.awaiting_delivery)).mockResolvedValue(response(states.available_zero))
    renderPage()
    expect(await screen.findByText('1 awaiting delivery')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(await screen.findByText('Nothing running or awaiting delivery')).toBeInTheDocument()
    const calls = vi.mocked(api.fetchBackgroundTasks).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(vi.mocked(api.fetchBackgroundTasks).mock.calls.length).toBe(calls)
  })

  it('never lets a late answer for the previous chat replace the current one', async () => {
    let answerFirst!: (value: ReturnType<typeof response>) => void
    vi.mocked(api.fetchBackgroundTasks).mockImplementation((sid) => sid === 's1'
      ? new Promise((resolve) => { answerFirst = resolve })
      : Promise.resolve(response(states.unknown, 's2')))
    const { rerender } = renderPage('s1')
    rerender(<QueryClientProvider client={qc}><AgentsPage sessionId="s2" active /></QueryClientProvider>)
    expect(await screen.findByText('Delivery status unavailable')).toBeInTheDocument()
    await act(async () => { answerFirst(response(states.awaiting_delivery, 's1')); await Promise.resolve() })
    expect(screen.getByText('Delivery status unavailable')).toBeInTheDocument()
    expect(screen.queryByText('1 awaiting delivery')).not.toBeInTheDocument()
  })
})
