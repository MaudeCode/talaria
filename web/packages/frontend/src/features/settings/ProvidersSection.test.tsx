import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderQuotasSchema } from '../../contracts'

/** The server's real `/api/provider/cost-history` response (pinned by the server test). */
const costHistory = (JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/__fixtures__/live/provider_cost_history.json'), 'utf8')) as { body: unknown }).body
/** The server's real `/api/provider/quotas` response (pinned by the TAL-409 server test): Anthropic's weekly pace window. */
const quotas = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/fixtures/provider-quotas.json'), 'utf8')) as { sources: { windows: { pace: unknown; forecast: unknown }[] }[] }
const noPace = structuredClone(quotas)
Object.assign(noPace.sources[0]!.windows[1]!, { pace: null, forecast: null })
const quotaResponse = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../api/endpoints', () => ({
  fetchOpenRouterCostHistory: vi.fn(() => Promise.resolve(costHistory)), saveSettings: vi.fn(), fetchSettings: vi.fn(() => Promise.resolve({})), setDefaultModel: vi.fn(),
  fetchProviders: vi.fn(() => Promise.resolve({ active_provider: 'openrouter', providers: [{ id: 'openrouter', display_name: 'OpenRouter', has_key: true }, { id: 'zai', display_name: 'Z.AI', has_key: true }, { id: 'anthropic', display_name: 'Anthropic', has_key: true }] })),
  fetchProviderQuotas: vi.fn(() => Promise.resolve(quotaResponse.current ?? { version: 1, computed_at: '2026-09-28T08:00:00Z', scope_id: 's', profile_id: 'default', active_provider: 'openrouter', requested_source_id: null, missing_source: false, sources: [] })),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { ProvidersSection } from './ProvidersSection'

const renderSection = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><ProvidersSection /></QueryClientProvider>)
}
const DEFAULTS = { warning_remaining_percent: 25, critical_remaining_percent: 10, pace_tolerance_percent: 3, pace_warning_burn_rate_percent: 125, pace_critical_burn_rate_percent: 175, pace_minimum_elapsed_hours: 12 }
const quotasWith = (sources: Record<string, unknown>[]) => ProviderQuotasSchema.parse({ version: 1, computed_at: '2026-09-28T08:00:00Z', scope_id: 's', profile_id: 'default', active_provider: 'openrouter', requested_source_id: null, missing_source: false, sources })

describe('ProvidersSection', () => {
  afterEach(() => { quotaResponse.current = null; vi.useRealTimers() })

  it("renders the server-selected pace window's remaining, reset, pace, burn, budget and forecast (TAL-410)", async () => {
    quotaResponse.current = quotas
    renderSection()
    const pace = await screen.findByTestId('provider-quota-pace', {}, { timeout: 2000 })
    expect(pace.closest('[data-provider]')).toHaveAttribute('data-provider', 'anthropic')
    expect(within(pace).getByText('Weekly')).toBeInTheDocument()
    expect(within(pace).getByText('68% remaining')).toBeInTheDocument()
    expect(within(pace).getByText(`Resets ${new Date('2026-10-03T08:00:00Z').toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}`)).toBeInTheDocument()
    expect(within(pace).getByText('3.4% over pace')).toBeInTheDocument()
    expect(within(pace).getByText('Burn 1.12×')).toBeInTheDocument()
    expect(within(pace).getByText('13.6% / day budget')).toBeInTheDocument()
    expect(within(pace).getByText('Empty 18h early')).toBeInTheDocument()
  })

  it('shows the unavailable copy and no pace numbers when the pace window has no pace (TAL-410)', async () => {
    quotaResponse.current = noPace
    renderSection()
    const pace = await screen.findByTestId('provider-quota-pace', {}, { timeout: 2000 })
    expect(within(pace).getByText('Pace unavailable')).toBeInTheDocument()
    expect(within(pace).getByText('Forecast unavailable')).toBeInTheDocument()
    expect(pace).not.toHaveTextContent(/over pace|under pace|On pace|Burn|budget|early|Lasts/)
    expect(pace).not.toHaveTextContent(/1\.12|13\.6|3\.4/)
  })

  it('refetches quotas while open so a reset replaces the expired pace with the server answer (TAL-410)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    quotaResponse.current = quotas
    renderSection()
    const pace = await screen.findByTestId('provider-quota-pace', {}, { timeout: 2000 })
    expect(within(pace).getByText('3.4% over pace')).toBeInTheDocument()
    // The window resets while the page stays open; the server's next answer has no pace for it.
    quotaResponse.current = noPace
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await within(pace).findByText('Pace unavailable', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(pace).not.toHaveTextContent('3.4% over pace')
  })

  it('shows the OpenRouter spend chart, pace, and budget standing inside the keyed OpenRouter row only (TAL-412)', async () => {
    renderSection()
    const openrouter = (await screen.findByText('OpenRouter')).closest<HTMLElement>('[data-provider="openrouter"]')!
    expect(await within(openrouter).findByText('Monthly pace: $33.90', { exact: false }, { timeout: 2000 })).toBeInTheDocument()
    expect(within(openrouter).getByText('80% of $42.37 budget (monthly pace)')).toBeInTheDocument()
    expect(within(openrouter).getAllByRole('listitem').filter((li) => li.hasAttribute('title'))).toHaveLength(7)
    expect(document.querySelectorAll('[data-provider-cost]')).toHaveLength(1)
  })

  it('colours each quota source by the server urgency of both bases, and leaves an old server neutral (TAL-411)', async () => {
    quotaResponse.current = quotasWith([
      { source_id: 'q1', provider_id: 'zai', status: 'available', urgency: { remaining: 'warning', pace: 'critical' } },
      { source_id: 'q2', provider_id: 'openrouter', status: 'available' },
    ])
    renderSection()
    const zai = (await screen.findByText('Z.AI')).closest<HTMLElement>('[data-provider="zai"]')!
    expect(await within(zai).findByText('Remaining: Warning', {}, { timeout: 2000 })).toHaveClass('text-warning')
    expect(within(zai).getByText('Pace: Critical')).toHaveClass('text-error')
    const openrouter = zai.parentElement!.querySelector<HTMLElement>('[data-provider="openrouter"]')!
    expect(openrouter.querySelector('[data-quota-urgency]')).toBeNull()
  })

  it("shows the pace window's urgency and words pace by the server's status (TAL-411)", async () => {
    // A server with a 4% tolerance calls the fixture's 3.4-point deficit on pace.
    const onPace = structuredClone(quotas) as { sources: { windows: { pace: Record<string, unknown> | null }[] }[] }
    Object.assign(onPace.sources[0]!.windows[1]!.pace!, { status: 'on' })
    quotaResponse.current = onPace
    renderSection()
    const pace = await screen.findByTestId('provider-quota-pace', {}, { timeout: 2000 })
    expect(within(pace).getByText('Remaining: Healthy')).toHaveAttribute('data-level', 'healthy')
    expect(within(pace).getByText('Pace: Warning')).toHaveClass('text-warning')
    expect(within(pace).getByText('On pace')).toBeInTheDocument()
    expect(within(pace).queryByText(/over pace/)).not.toBeInTheDocument()
  })

  it('shows the profile thresholds from settings and saves an edit, then refetches quotas (TAL-411)', async () => {
    vi.mocked(api.fetchSettings).mockResolvedValue({ provider_quota_thresholds: DEFAULTS })
    vi.mocked(api.saveSettings).mockResolvedValue({ provider_quota_thresholds: { ...DEFAULTS, warning_remaining_percent: 30 } })
    renderSection()
    const warning = await screen.findByRole('spinbutton', { name: 'Warning at % remaining' })
    await waitFor(() => expect(warning).toHaveValue(25))
    expect(screen.getByRole('spinbutton', { name: 'Projection after hours' })).toHaveValue(12)
    const before = vi.mocked(api.fetchProviderQuotas).mock.calls.length
    await userEvent.clear(warning)
    await userEvent.type(warning, '30')
    await userEvent.click(screen.getByRole('button', { name: 'Save thresholds' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ provider_quota_thresholds: { ...DEFAULTS, warning_remaining_percent: 30 } }))
    await waitFor(() => expect(vi.mocked(api.fetchProviderQuotas).mock.calls.length).toBeGreaterThan(before))
  })
})
