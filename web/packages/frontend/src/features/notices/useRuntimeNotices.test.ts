import cronRefusal from '../../../../../../contracts/fixtures/native-cron-refusal.json'
import { createElement, Fragment, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/endpoints', () => ({ fetchAgentHealth: vi.fn() }))
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { markServerStopped, retryDelay, STOPPED_AFTER, useRuntimeNotices, useServerProbe } from './useRuntimeNotices'
import { initialStreamState, streamReducer, type LiveTurn } from '../../stream/reducer'
import { parseChatEvent } from '../../contracts/sse'

describe('retryDelay', () => {
  it('waits 1 s after the first failure and doubles to a 30 s cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })
})

describe('markServerStopped', () => {
  it('keeps the server stopped when a probe sent before the stop answers afterwards', async () => {
    let answer!: (health: Awaited<ReturnType<typeof api.fetchAgentHealth>>) => void
    vi.mocked(api.fetchAgentHealth).mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useServerProbe(), { wrapper })
    await waitFor(() => expect(result.current.probe.isFetching).toBe(true))

    await act(async () => { markServerStopped(qc); await Promise.resolve() })
    await act(async () => { answer({ alive: true, chat: { available: true, condition: null } }); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(result.current.failures).toBe(STOPPED_AFTER)
  })
})

describe('useRuntimeNotices agent_unavailable', () => {
  const notices = async (health: object) => {
    vi.mocked(api.fetchAgentHealth).mockResolvedValue(health as Awaited<ReturnType<typeof api.fetchAgentHealth>>)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useRuntimeNotices({ live: null, compressingSince: null }), { wrapper })
    await waitFor(() => expect(qc.getQueryState([...keys.health.agent, 'probe'])?.status).toBe('success'))
    return result.current.notices
  }

  it('ignores a stopped gateway while chat is available', async () => {
    const shown = await notices({ alive: false, details: { state: 'down', reason: 'gateway_not_running' }, chat: { available: true, condition: null } })
    expect(shown.map((n) => n.id)).not.toContain('runtime:agent_unavailable')
  })

  it('shows the chat condition when the sidecar cannot run chat', async () => {
    const shown = await notices({ alive: true, details: { state: 'alive' }, chat: { available: false, condition: 'agent_runtime_stale' } })
    const notice = shown.find((n) => n.id === 'runtime:agent_unavailable')
    expect(notice).toBeDefined()
    render(createElement(Fragment, null, notice!.content))
    expect(screen.getByText(m.notice_agent_runtime_stale())).toBeTruthy()
  })

  it.each([
    ['recovery_incomplete', 'Agent update recovery is incomplete'],
    ['update_active', 'Agent update is in progress'],
    ['unknown', 'Agent runtime is unavailable; check the Agent update outcome'],
    ['source_changed', 'Agent source changed; check the update outcome before restarting Talaria Web'],
    [undefined, 'Agent runtime is unavailable; check the Agent update outcome'],
  ])('renders the server reason %s truthfully for health and replayed errors', async (reason, title) => {
    const shown = await notices({ alive: true, chat: { available: false, condition: 'agent_runtime_stale', agent_runtime_reason: reason } })
    const notice = shown.find((n) => n.id === 'runtime:agent_unavailable')!
    const rendered = render(createElement(Fragment, null, notice.content))
    expect(rendered.container.textContent).toBe(title)
    expect(rendered.container.textContent).not.toContain('Agent updated')
    rendered.unmount()
  })

  it('renders a replayed runtime error with the same reason as health', () => {
    vi.mocked(api.fetchAgentHealth).mockResolvedValue({ alive: true, chat: { available: true, condition: null } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    let state = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'r', turnId: null, userMessageId: null, userText: 'hi', now: 1 })
    state = streamReducer(state, { type: 'event', sessionId: 's', streamId: 'r', event: parseChatEvent('apperror', JSON.stringify({ type: 'agent_runtime_stale', condition: 'agent_runtime_stale', agent_runtime_reason: 'recovery_incomplete', agent_update_state: 'incomplete', retryable: true, restart_scheduled: false, message: 'Agent updated successfully' }))!, lastEventId: 'r:1', now: 2 })
    const { result } = renderHook(() => useRuntimeNotices({ live: state.turns.s!, compressingSince: null }), { wrapper })
    const shown = render(createElement(Fragment, null, result.current.notices.find((n) => n.id === 'runtime:thread_error')!.content))
    expect(shown.container.textContent).toBe('Agent update recovery is incomplete')
    expect(state.turns.s!.error).toMatchObject({ agent_runtime_reason: 'recovery_incomplete', retryable: true, restart_scheduled: false })
  })

  it.each([false, true, undefined])('honors retryable=%s on replayed terminal errors', (retryable) => {
    vi.mocked(api.fetchAgentHealth).mockResolvedValue({ alive: true, chat: { available: true, condition: null } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    let state = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'r', turnId: null, userMessageId: null, userText: 'hi', now: 1 })
    const event = parseChatEvent('apperror', JSON.stringify({ ...cronRefusal.event.data, retryable }))!
    state = streamReducer(state, { type: 'event', sessionId: 's', streamId: 'r', event, lastEventId: 'r:1', now: 2 })
    const onRetry = vi.fn()
    const { result } = renderHook(() => useRuntimeNotices({ live: state.turns.s!, onRetry, compressingSince: null }), { wrapper })
    const notice = result.current.notices.find((n) => n.id === 'runtime:thread_error')!
    const shown = render(createElement(Fragment, null, notice.content))
    expect(shown.container.textContent).toContain(cronRefusal.event.data.message)
    expect(Boolean(notice.action)).toBe(retryable !== false)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('keeps the gateway warning for an older server that sends no chat readiness', async () => {
    const shown = await notices({ alive: false, details: { state: 'down', reason: 'gateway_not_running' } })
    const notice = shown.find((n) => n.id === 'runtime:agent_unavailable')
    expect(notice).toBeDefined()
    render(createElement(Fragment, null, notice!.content))
    expect(screen.getByTitle('Hermes Agent is unavailable · gateway_not_running')).toBeTruthy()
  })
})

describe('useRuntimeNotices agent notices (TAL-803)', () => {
  it('shows each of the session\'s Agent notices in its level\'s tone', () => {
    vi.mocked(api.fetchAgentHealth).mockResolvedValue({ alive: true, chat: { available: true, condition: null } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const agentNotices = [
      { key: 'startup-warning.1', level: 'warn' as const, text: 'Memory is off', expires_at: null },
      { key: 'credits.band', level: 'info' as const, text: 'Usage at 90%', expires_at: 1_005 },
    ]
    const { result } = renderHook(() => useRuntimeNotices({ live: null, compressingSince: null, agentNotices }), { wrapper })
    expect(result.current.notices.map((n) => [n.id, n.tone])).toEqual([['runtime:agent_notice:startup-warning.1', 'warning'], ['runtime:agent_notice:credits.band', 'info']])
    render(createElement(Fragment, null, result.current.notices[0]!.content))
    expect(screen.getByText('Memory is off')).toBeTruthy()
  })
})

describe('useRuntimeNotices standing goal (TAL-808)', () => {
  const base = { text: 'Ship the release notes', turns_used: 3, max_turns: 20, reason: null, parked_until: null }
  const goalRow = (goal: Parameters<typeof useRuntimeNotices>[0]['goal']) => {
    vi.mocked(api.fetchAgentHealth).mockResolvedValue({ alive: true, chat: { available: true, condition: null } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useRuntimeNotices({ live: null, compressingSince: null, goal }), { wrapper })
    const row = result.current.notices.find((n) => n.id === 'runtime:goal')
    if (!row) return null
    const { container, unmount } = render(createElement(Fragment, null, row.content))
    const text = container.textContent
    unmount()
    return { text, dismissible: row.onDismiss !== undefined }
  }

  it('shows the goal, its turns, and why it is paused or parked; none when no goal runs', () => {
    expect(goalRow({ ...base, status: 'active' })).toEqual({ text: 'Goal · Ship the release notes3/20 turns', dismissible: false })
    expect(goalRow({ ...base, status: 'paused', reason: 'turn budget exhausted' })?.text).toBe('Goal paused · turn budget exhausted · Ship the release notes3/20 turns')
    expect(goalRow({ ...base, status: 'parked', reason: 'pid 4242' })?.text).toBe('Goal parked · pid 4242 · Ship the release notes3/20 turns')
    const until = 1_770_000_600
    const time = new Date(until * 1000).toLocaleTimeString(undefined, { timeStyle: 'short' })
    expect(goalRow({ ...base, status: 'parked', reason: 'CI running', parked_until: until })?.text).toBe(`Goal parked · CI running · Ship the release notes3/20 · until ${time}`)
    expect(goalRow(null)).toBeNull()
  })
})

describe('useRuntimeNotices compression (TAL-1006)', () => {
  const NOW = 1_800_000_000_000
  const liveTurn = (events: [string, unknown][]): LiveTurn => {
    let state = streamReducer(initialStreamState, { type: 'start', sessionId: 's', streamId: 'r', turnId: null, userMessageId: null, userText: 'hi', now: NOW - 300_000 })
    for (const [name, data] of events) state = streamReducer(state, { type: 'event', sessionId: 's', streamId: 'r', event: parseChatEvent(name, JSON.stringify(data))!, lastEventId: '', now: NOW })
    return state.turns.s!
  }
  const row = (args: Partial<Parameters<typeof useRuntimeNotices>[0]>) => {
    vi.mocked(api.fetchAgentHealth).mockResolvedValue({ alive: true, chat: { available: true, condition: null } })
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
    const { result } = renderHook(() => useRuntimeNotices({ live: null, compressingSince: null, ...args }), { wrapper })
    const notice = result.current.notices.find((n) => n.id === 'runtime:compressing')
    if (!notice) return null
    const { container, unmount } = render(createElement(Fragment, null, notice.content))
    const text = container.textContent
    unmount()
    return text
  }

  it('shows the live turn\'s open span and the manual job with the time since the server\'s start, and clears with the span', () => {
    const since = NOW / 1000 - 65
    expect(row({ live: liveTurn([['compressing', { session_id: 's', started_at: since }]]) })).toBe('Compressing context1m')
    expect(row({ live: liveTurn([['compressing', { session_id: 's', started_at: since }], ['compressed', { session_id: 's' }]]) })).toBeNull()
    expect(row({ live: liveTurn([['compressing', { session_id: 's', started_at: since }], ['done', {}]]) })).toBeNull()
    expect(row({ compressingSince: NOW - 12_000 })).toBe('Compressing context12s')
  })
})
