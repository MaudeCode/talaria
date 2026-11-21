import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import type { z } from 'zod'
import type { Insights, InsightsRange } from '@maudecode/talaria-web-contracts'
import { ProviderQuotasSchema } from '../../contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { BarChart } from './BarChart'
import { InsightsPage } from './InsightsPage'
import { ProviderQuotaRows } from './ProviderQuotaRows'

/** The page's URL search, which `navigate` replaces as the router would. */
const router = vi.hoisted(() => {
  let search: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  return {
    get: () => search,
    set: (next: Record<string, unknown>) => { search = next; listeners.forEach((l) => { l() }) },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
  }
})
vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore } = await import('react')
  return { useSearch: () => useSyncExternalStore(router.subscribe, router.get), useNavigate: () => (opts: { search: Record<string, unknown> }) => { router.set(opts.search); return Promise.resolve() } }
})
beforeEach(() => { router.set({ tab: 'usage', days: 30 }) })
vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), fetchInsights: vi.fn(), fetchProviderQuotas: vi.fn(() => new Promise<never>(() => undefined)) }))

const quotas = ProviderQuotasSchema.parse({
  version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_test', profile_id: 'default', active_provider: 'anthropic', requested_source_id: null, missing_source: false,
  sources: [
    {
      source_id: 'qsrc_paced', provider_id: 'anthropic', provider_label: 'Claude', account_label: 'Claude', plan: 'Max', is_active_provider: true, status: 'available',
      computed_at: '2030-01-01T00:00:00Z', fetched_at: '2030-01-01T00:00:00Z', urgency: { remaining: 'healthy', pace: 'warning' },
      windows: [
        { label: 'Session', used_percent: 25, remaining_percent: 75, reset_at: '2030-01-01T03:00:00Z', detail: null, window_seconds: 18000, urgency: { remaining: 'healthy', pace: 'healthy' }, display_level: 'healthy',
          pace: { expected_remaining_percent: 60, expected_used_percent: 40, pace_delta_percent: 15, burn_rate: 0.62, minutes_to_reset: 180, projected_minutes_to_empty: 540, elapsed_minutes: 120, valid_until: '2030-01-01T03:00:00Z', status: 'under' },
          forecast: { outcome: 'safe', budget_unit: 'hour', budget_percent: 25, depletion_margin_minutes: 360 } },
        { label: 'Weekly', used_percent: 70, remaining_percent: 30, reset_at: '2030-01-03T12:00:00Z', detail: null, window_seconds: 604800, urgency: { remaining: 'warning', pace: 'warning' }, display_level: 'warning',
          pace: { expected_remaining_percent: 36, expected_used_percent: 64, pace_delta_percent: -6, burn_rate: 1.1, minutes_to_reset: 3600, projected_minutes_to_empty: 3270, elapsed_minutes: 6480, valid_until: '2030-01-03T12:00:00Z', status: 'over' },
          forecast: { outcome: 'warning', budget_unit: 'day', budget_percent: 12, depletion_margin_minutes: -330 } },
      ],
    },
    { source_id: 'qsrc_plain', provider_id: 'openai-codex', provider_label: 'OpenAI Codex', status: 'available', windows: [{ label: 'Session', used_percent: 40, remaining_percent: 60, reset_at: null, detail: null, window_seconds: null, pace: null, forecast: null }] },
    { source_id: 'qsrc_credits', provider_id: 'openrouter', provider_label: 'OpenRouter', status: 'available', quota: { limit_remaining: 12.5, usage: 7.5, limit: 20, currency: 'USD', is_capped: true, percent_used: 37.5, percent_remaining: 62.5, over_limit: false } },
    { source_id: 'qsrc_down', provider_id: 'nous', provider_label: 'Nous', status: 'stale', status_message: 'Provider data is temporarily unavailable.', urgency: { remaining: 'stale', pace: 'stale' },
      windows: [{ label: 'Session', used_percent: 10, remaining_percent: 90, reset_at: null, detail: null, window_seconds: null, pace: null, forecast: null, urgency: { remaining: 'healthy', pace: 'healthy' }, display_level: 'stale' }] },
    { source_id: 'qsrc_none', provider_id: 'google', provider_label: 'Google', status: 'unsupported', status_message: 'No verified server-side quota or balance endpoint is available for Google.', windows: [] },
  ],
})

function asQuery(data: z.infer<typeof ProviderQuotasSchema>): UseQueryResult<z.infer<typeof ProviderQuotasSchema>> {
  return { data, isPending: false, isError: false, isFetching: false, error: null } as unknown as UseQueryResult<z.infer<typeof ProviderQuotasSchema>>
}

describe('ProviderQuotaRows', () => {
  const renderRows = (mode: 'used' | 'remaining') => render(<QueryClientProvider client={new QueryClient()}><ProviderQuotaRows quotas={asQuery(quotas)} mode={mode} onRefresh={vi.fn()} /></QueryClientProvider>)

  it('renders every window with its headline percent, meter, forecast and Pace / Burn / Budget cells, and the plain states without them', () => {
    renderRows('used')
    const paced = document.querySelector('[data-quota-source="qsrc_paced"]')!
    expect(within(paced as HTMLElement).getAllByRole('meter')).toHaveLength(2)
    const session = paced.querySelector('[data-quota-window="Session"]')!
    expect(session).toHaveAttribute('data-level', 'healthy')
    expect(within(session as HTMLElement).getByRole('meter', { name: 'Session: 25% Used' })).toHaveAttribute('aria-valuenow', '25')
    expect(session.querySelector('[data-metric="pace"]')).toHaveTextContent('Pace15% under')
    expect(session.querySelector('[data-metric="burn"]')).toHaveTextContent('Burn0.62×')
    expect(session.querySelector('[data-metric="budget"]')).toHaveTextContent('Budget25%/hr')
    expect(session.querySelector('[data-forecast="safe"]')).toHaveTextContent('Lasts through reset')
    const weekly = paced.querySelector('[data-quota-window="Weekly"]')!
    expect(weekly).toHaveAttribute('data-level', 'warning')
    expect(weekly.querySelector('[data-metric="pace"]')).toHaveTextContent('6% over')
    expect(weekly.querySelector('[data-metric="budget"]')).toHaveTextContent('12%/day')
    expect(weekly.querySelector('[data-forecast="warning"]')).toHaveTextContent('Empty 5h early')
    expect(paced).toHaveTextContent('Max')
    expect(paced).toHaveTextContent('Active provider')
    expect(paced).toHaveTextContent('As of')

    const plain = document.querySelector('[data-quota-source="qsrc_plain"]')!
    expect(within(plain as HTMLElement).getByRole('meter', { name: 'Session: 40% Used' })).toBeInTheDocument()
    expect(plain.querySelectorAll('[data-metric]')).toHaveLength(0)
    expect(plain.textContent).not.toMatch(/pace|Burn|Budget|reset/)

    expect(document.querySelector('[data-quota-source="qsrc_credits"]')).toHaveTextContent('12.5 credits remaining')
    const down = document.querySelector('[data-quota-source="qsrc_down"]')!
    expect(down).toHaveAttribute('data-quota-status', 'stale')
    expect(down).toHaveTextContent('Provider data is temporarily unavailable.')
    expect(down.querySelector('[data-quota-window="Session"]'), 'the window shows the server level, not its urgency').toHaveAttribute('data-level', 'stale')
    const unavailable = document.querySelector('[data-section="insights-quotas-unavailable"]')!
    expect(unavailable).toHaveTextContent('Google')
    expect(unavailable.querySelector('[data-quota-source="qsrc_none"]')).toHaveTextContent('No verified server-side quota')
    expect(screen.getByRole('button', { name: 'Refresh quotas' })).toBeEnabled()
  })

  it('shows the remaining percent, fill and marker in Remaining mode', () => {
    renderRows('remaining')
    const session = document.querySelector('[data-quota-source="qsrc_paced"] [data-quota-window="Session"]')!
    const meter = within(session as HTMLElement).getByRole('meter', { name: 'Session: 75% Remaining' })
    expect(meter).toHaveAttribute('aria-valuenow', '75')
    expect(meter.firstElementChild).toHaveStyle({ width: '75%' })
    expect(meter.lastElementChild).toHaveStyle({ left: '60%' })
  })
})

describe('BarChart', () => {
  it('draws a bar per row, names the server\'s peak and max, labels every bar when few and the ends when many, and keeps the table twin', () => {
    const { unmount } = render(<BarChart id="weekday" title="Activity by day" rows={['Mon', 'Tue', 'Wed'].map((label, i) => ({ label, value: [4, 9, 1][i]! }))} format={(n) => String(n)} maxDisplay="9" peak={{ label: 'Tue', display: '9' }} />)
    expect(screen.getByRole('img', { name: 'Activity by day: peak 9 at Tue' })).toBeInTheDocument()
    expect(screen.getByText('Max 9')).toBeInTheDocument()
    expect(screen.getByTitle('Tue: 9')).toBeInTheDocument()
    const figure = document.querySelector('[data-chart="weekday"]')!
    expect(figure.textContent).toContain('MonTueWed')
    expect(within(figure as HTMLElement).getAllByRole('row')).toHaveLength(3)
    unmount()

    render(<BarChart id="daily" title="Daily" rows={Array.from({ length: 30 }, (_, i) => ({ label: `Oct ${String(i + 1)}`, title: `2030-10-${String(i + 1).padStart(2, '0')}`, value: i }))} format={(n) => String(n)} peak={null} />)
    const daily = document.querySelector('[data-chart="daily"]')!
    expect(daily.textContent).toContain('Oct 1')
    expect(daily.textContent).toContain('Oct 30')
    expect(daily.textContent).not.toContain('Oct 15Oct 16')
    expect(screen.getByTitle('2030-10-30: 29')).toBeInTheDocument()
  })
})

describe('InsightsPage usage amounts', () => {
  const none = { peak_index: null, max: 0 }
  it('shows one cent or more at exactly two decimals, less at up to four, each with its exact value in title', async () => {
    vi.mocked(api.fetchInsights).mockResolvedValue({ range: served(), total_sessions: 3, total_cost: 0.455, daily_tokens: [{ date: '2030-01-01', cost: 0.3705 }, { date: '2030-01-02', cost: 0.0004 }], models: [{ model: 'synthetic-a', cost: 0.3705 }, { model: 'synthetic-b', cost: 0.0004 }], chart_peaks: { daily: { tokens: none, cost: { peak_index: 0, max: 0.3705 }, sessions: none }, by_day: none, by_hour: none } })
    render(<QueryClientProvider client={new QueryClient()}><InsightsPage /></QueryClientProvider>)
    expect(await screen.findByTitle('$0.455')).toHaveTextContent(/^\$0\.46$/)
    const table = screen.getByTestId('insights-models')
    expect(within(table).getByTitle('$0.3705')).toHaveTextContent(/^\$0\.37$/)
    expect(within(table).getByTitle('$0.0004')).toHaveTextContent(/^\$0\.0004$/)
    await userEvent.click(screen.getByRole('combobox', { name: 'Metric' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Estimated cost' }))
    const daily = document.querySelector('[data-chart="daily"]')!
    expect(within(daily as HTMLElement).getByText('Max $0.37')).toBeInTheDocument()
    expect(within(daily as HTMLElement).getByRole('img', { name: 'Daily: peak $0.37 at 2030-01-01' })).toBeInTheDocument()
    expect(within(daily as HTMLElement).getByTitle('2030-01-01: $0.3705')).toBeInTheDocument()
  })
})

const none = { peak_index: null, max: 0 }
/** A range as the server serves it: by default the 30-day preset ending on the server's today. */
const served = (over: Partial<InsightsRange> = {}): InsightsRange => ({
  mode: 'preset', start: 0, end: 0, through_now: true, start_date: '2030-01-01', end_date: '2030-01-30', today: '2030-01-30', timezone: 'Europe/Berlin', bucket: 'day', fallback_reason: null, adjustments: [], ...over,
})
const usage = (sessions: number, over: Partial<InsightsRange> = {}, period = 30): Insights => ({
  period_days: period, total_sessions: sessions, range: served(over), chart_peaks: { daily: { tokens: none, cost: none, sessions: none }, by_day: none, by_hour: none },
})
const sessionsShown = () => within(screen.getByTestId('insights-stats')).getByText('Sessions').nextElementSibling?.textContent
const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><InsightsPage /></QueryClientProvider>)
  return client
}
const choosePeriod = async (name: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: 'Period' }))
  await userEvent.click(await screen.findByRole('option', { name }))
}

describe('InsightsPage custom range (TAL-1117)', () => {
  it('opens Custom on the range on screen, sends typed dates, and keeps them across a preset', async () => {
    vi.mocked(api.fetchInsights).mockImplementation(({ days, start, end }) => Promise.resolve(start === undefined && end === undefined ? usage(days) : usage(5, { mode: 'custom', start_date: start ?? '', end_date: end ?? '' })))
    renderPage()
    await screen.findByTestId('insights-stats')
    expect(screen.queryByLabelText('Start date')).toBeNull()

    await choosePeriod('Custom')
    expect(api.fetchInsights).toHaveBeenLastCalledWith({ days: 30, start: '2030-01-01', end: '2030-01-30' })
    const start = screen.getByLabelText('Start date')
    expect(start).toHaveAttribute('type', 'date')
    expect(screen.getByText('Start date').tagName).toBe('LABEL')
    expect(screen.getByText('End date').tagName).toBe('LABEL')
    await userEvent.clear(start)
    await userEvent.type(start, '2029-12-15')
    expect(api.fetchInsights).toHaveBeenLastCalledWith({ days: 30, start: '2029-12-15', end: '2030-01-30' })
    expect(await screen.findByText('Dec 15, 2029 – Jan 30, 2030 · Europe/Berlin')).toHaveAttribute('role', 'status')

    await choosePeriod('7 days')
    expect(api.fetchInsights).toHaveBeenLastCalledWith({ days: 7, start: undefined, end: undefined })
    await waitFor(() => { expect(screen.queryByLabelText('Start date')).toBeNull() })
    await choosePeriod('Custom')
    expect(api.fetchInsights).toHaveBeenLastCalledWith({ days: 7, start: '2029-12-15', end: '2030-01-30' })
    expect(screen.getByLabelText('Start date')).toHaveValue('2029-12-15')
  })

  it('says why the server fell back, and when it shortened the range or bucketed it by month', async () => {
    router.set({ tab: 'usage', days: 30, start: '', end: '2030-01-10' })
    vi.mocked(api.fetchInsights).mockResolvedValue(usage(0, { fallback_reason: 'invalid_start' }))
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><InsightsPage /></QueryClientProvider>)
    expect(await screen.findByText('Unreadable start date; showing 30 days')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Custom')
    unmount()

    router.set({ tab: 'usage', days: 30, start: '2010-01-01', end: '2030-01-10' })
    const monthly = { ...usage(2, { mode: 'custom', start_date: '2025-01-10', end_date: '2030-01-10', bucket: 'month', adjustments: ['capped'] }, 1827), daily_tokens: [{ date: '2025-01-10', sessions: 1 }, { date: '2025-02-01', sessions: 1 }] }
    vi.mocked(api.fetchInsights).mockResolvedValue(monthly)
    renderPage()
    expect(await screen.findByText('Shortened to the last five years')).toBeInTheDocument()
    const chart = document.querySelector('[data-chart="daily"]')!
    expect(chart).toHaveTextContent('Monthly')
    expect(chart).toHaveTextContent('Jan 2025')
  })

  it('shows the newest range when an older response arrives last', async () => {
    router.set({ tab: 'usage', days: 30, start: '2030-01-01', end: '2030-01-10' })
    const pending = new Map<string | undefined, (body: Insights) => void>()
    vi.mocked(api.fetchInsights).mockImplementation(({ end }) => new Promise((resolve) => { pending.set(end, resolve) }))
    const client = renderPage()
    const end = screen.getByLabelText('End date')
    await userEvent.clear(end)
    await userEvent.type(end, '2030-01-20')
    await waitFor(() => { expect(pending.has('2030-01-20')).toBe(true) })
    pending.get('2030-01-20')!(usage(20, { mode: 'custom', end_date: '2030-01-20' }))
    expect(await screen.findByText('Jan 1, 2030 – Jan 20, 2030 · Europe/Berlin')).toBeInTheDocument()
    pending.get('2030-01-10')!(usage(10, { mode: 'custom', end_date: '2030-01-10' }))
    await waitFor(() => { expect(client.getQueryState(keys.insights({ days: 30, start: '2030-01-01', end: '2030-01-10' }))?.status).toBe('success') })
    expect(sessionsShown()).toBe('20')
    expect(screen.queryByText('Jan 1, 2030 – Jan 10, 2030 · Europe/Berlin')).toBeNull()
  })

  it('caps the date fields at the server\'s day, which moves on at its midnight without losing a draft', async () => {
    router.set({ tab: 'usage', days: 30, start: '2030-01-01', end: '2030-01-30' })
    let today = '2030-01-30'
    vi.mocked(api.fetchInsights).mockImplementation(({ start, end }) => Promise.resolve(usage(1, { mode: 'custom', start_date: start ?? '', end_date: end ?? '', today })))
    const client = renderPage()
    const start = screen.getByLabelText('Start date')
    await waitFor(() => { expect(start).toHaveAttribute('max', '2030-01-30') })
    await userEvent.clear(start)
    await userEvent.type(start, '2030-01-05')
    today = '2030-01-31'
    await client.invalidateQueries({ queryKey: ['insights'] })
    await waitFor(() => { expect(start).toHaveAttribute('max', '2030-01-31') })
    expect(screen.getByLabelText('End date')).toHaveAttribute('max', '2030-01-31')
    expect(start).toHaveValue('2030-01-05')
  })
})
