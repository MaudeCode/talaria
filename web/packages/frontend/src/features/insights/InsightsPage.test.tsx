import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import type { z } from 'zod'
import { ProviderQuotasSchema } from '../../contracts'
import { BarChart } from './BarChart'
import { ProviderQuotaRows } from './ProviderQuotaRows'

const quotas = ProviderQuotasSchema.parse({
  version: 1, computed_at: '2030-01-01T00:00:00Z', scope_id: 'qscope_test', profile_id: 'default', active_provider: 'anthropic', requested_source_id: null, missing_source: false,
  sources: [
    {
      source_id: 'qsrc_paced', provider_id: 'anthropic', provider_label: 'Claude', account_label: 'Claude', plan: 'Max', is_active_provider: true, status: 'available',
      computed_at: '2030-01-01T00:00:00Z', fetched_at: '2030-01-01T00:00:00Z', urgency: { remaining: 'healthy', pace: 'warning' },
      windows: [
        { label: 'Session', used_percent: 25, remaining_percent: 75, reset_at: '2030-01-01T03:00:00Z', detail: null, window_seconds: 18000, urgency: { remaining: 'healthy', pace: 'healthy' },
          pace: { expected_remaining_percent: 60, expected_used_percent: 40, pace_delta_percent: 15, burn_rate: 0.62, minutes_to_reset: 180, projected_minutes_to_empty: 540, elapsed_minutes: 120, valid_until: '2030-01-01T03:00:00Z', status: 'under' },
          forecast: { outcome: 'safe', budget_unit: 'hour', budget_percent: 25, depletion_margin_minutes: 360 } },
        { label: 'Weekly', used_percent: 70, remaining_percent: 30, reset_at: '2030-01-03T12:00:00Z', detail: null, window_seconds: 604800, urgency: { remaining: 'warning', pace: 'warning' },
          pace: { expected_remaining_percent: 36, expected_used_percent: 64, pace_delta_percent: -6, burn_rate: 1.1, minutes_to_reset: 3600, projected_minutes_to_empty: 3270, elapsed_minutes: 6480, valid_until: '2030-01-03T12:00:00Z', status: 'over' },
          forecast: { outcome: 'warning', budget_unit: 'day', budget_percent: 12, depletion_margin_minutes: -330 } },
      ],
    },
    { source_id: 'qsrc_plain', provider_id: 'openai-codex', provider_label: 'OpenAI Codex', status: 'available', windows: [{ label: 'Session', used_percent: 40, remaining_percent: 60, reset_at: null, detail: null, window_seconds: null, pace: null, forecast: null }] },
    { source_id: 'qsrc_credits', provider_id: 'openrouter', provider_label: 'OpenRouter', status: 'available', quota: { limit_remaining: 12.5, usage: 7.5, limit: 20 } },
    { source_id: 'qsrc_down', provider_id: 'nous', provider_label: 'Nous', status: 'stale', unavailable_reason: 'Provider data is temporarily unavailable.', urgency: { remaining: 'stale', pace: 'stale' },
      windows: [{ label: 'Session', used_percent: 10, remaining_percent: 90, reset_at: null, detail: null, window_seconds: null, pace: null, forecast: null, urgency: { remaining: 'healthy', pace: 'healthy' } }] },
    { source_id: 'qsrc_none', provider_id: 'google', provider_label: 'Google', status: 'unsupported', unavailable_reason: 'No verified server-side quota or balance endpoint is available for Google.', windows: [] },
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
    expect(down.querySelector('[data-quota-window="Session"]'), 'a stale source outranks its cached window level').toHaveAttribute('data-level', 'stale')
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
  it('draws a bar per row, names the peak, labels every bar when few and the ends when many, and keeps the table twin', () => {
    const { unmount } = render(<BarChart id="weekday" title="Activity by day" rows={['Mon', 'Tue', 'Wed'].map((label, i) => ({ label, value: [4, 9, 1][i]! }))} format={(n) => String(n)} />)
    expect(screen.getByRole('img', { name: 'Activity by day: peak 9 at Tue' })).toBeInTheDocument()
    expect(screen.getByText('Max 9')).toBeInTheDocument()
    expect(screen.getByTitle('Tue: 9')).toBeInTheDocument()
    const figure = document.querySelector('[data-chart="weekday"]')!
    expect(figure.textContent).toContain('MonTueWed')
    expect(within(figure as HTMLElement).getAllByRole('row')).toHaveLength(3)
    unmount()

    render(<BarChart id="daily" title="Daily" rows={Array.from({ length: 30 }, (_, i) => ({ label: `Oct ${String(i + 1)}`, title: `2030-10-${String(i + 1).padStart(2, '0')}`, value: i }))} format={(n) => String(n)} />)
    const daily = document.querySelector('[data-chart="daily"]')!
    expect(daily.textContent).toContain('Oct 1')
    expect(daily.textContent).toContain('Oct 30')
    expect(daily.textContent).not.toContain('Oct 15Oct 16')
    expect(screen.getByTitle('2030-10-30: 29')).toBeInTheDocument()
  })
})
