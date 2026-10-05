import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderCostHistorySchema } from '../../contracts'

vi.mock('../../api/endpoints', () => ({ fetchOpenRouterCostHistory: vi.fn(), saveSettings: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { OpenRouterCost } from './OpenRouterCost'

/** The server's real response for six seeded days plus today, with a $42.37 budget (pinned by the server test). */
const fixture = ProviderCostHistorySchema.parse((JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/__fixtures__/live/provider_cost_history.json'), 'utf8')) as { body: unknown }).body)
const noBudget = { ...fixture, monthly_budget: null, budget_percent: null, budget_level: null }
const empty = { ...noBudget, snapshots: [{ date: '2026-09-28', used: 2.52, delta: null, bar_percent: 0 }], monthly_pace: null, has_enough_data: false }

function renderCost() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><OpenRouterCost /></QueryClientProvider>)
}

describe('OpenRouter cost card', () => {
  beforeEach(() => { vi.mocked(api.fetchOpenRouterCostHistory).mockReset(); vi.mocked(api.saveSettings).mockReset() })

  it('renders bars, pace, and budget standing from the server fields', async () => {
    vi.mocked(api.fetchOpenRouterCostHistory).mockResolvedValue(fixture)
    renderCost()
    const bars = await screen.findAllByRole('listitem')
    expect(bars).toHaveLength(7)
    expect(bars.map((b) => b.querySelector<HTMLElement>('[style]')!.style.height)).toEqual(['0%', '0%', '0%', '100%', '25%', '2%', '100%'])
    expect(bars[5]).toHaveAttribute('title', '2026-09-27 · $0.0200')
    expect(bars[0]).toHaveAttribute('title', '2026-09-22 · no baseline')
    expect(screen.getByText('7-day spend')).toBeInTheDocument()
    expect(screen.getByTestId('provider-cost-pace')).toHaveTextContent('Monthly pace: $33.90(80%)')
    expect(screen.getByText('80% of $42.37 budget (monthly pace)')).toHaveClass('text-warning')
    expect(document.querySelector('[data-budget-level="warn"] [style]')).toHaveStyle({ width: '80%' })
    expect(screen.getByRole('spinbutton', { name: 'Monthly budget' })).toHaveValue(42.37)
  })

  it('shows the empty state alongside the budget controls before two snapshots exist', async () => {
    vi.mocked(api.fetchOpenRouterCostHistory).mockResolvedValue(empty)
    renderCost()
    expect(await screen.findByText(/Not enough data yet/)).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.queryByTestId('provider-cost-pace')).not.toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Monthly budget' })).toHaveValue(null)
    expect(screen.getByRole('button', { name: 'Set' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('setting and clearing the budget save provider_cost_budget and show the refetched standing', async () => {
    vi.mocked(api.fetchOpenRouterCostHistory).mockResolvedValue(noBudget)
    vi.mocked(api.saveSettings).mockResolvedValue({})
    renderCost()
    const input = await screen.findByRole('spinbutton', { name: 'Monthly budget' })
    expect(screen.queryByText(/budget \(monthly pace\)/)).not.toBeInTheDocument()
    await userEvent.type(input, '42.37')
    vi.mocked(api.fetchOpenRouterCostHistory).mockResolvedValue(fixture)
    await userEvent.click(screen.getByRole('button', { name: 'Set' }))
    expect(api.saveSettings).toHaveBeenCalledWith({ provider_cost_budget: 42.37 })
    expect(await screen.findByText('80% of $42.37 budget (monthly pace)')).toBeInTheDocument()

    vi.mocked(api.fetchOpenRouterCostHistory).mockResolvedValue(noBudget)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(api.saveSettings).toHaveBeenLastCalledWith({ provider_cost_budget: null })
    await waitFor(() => expect(screen.queryByText(/budget \(monthly pace\)/)).not.toBeInTheDocument())
    expect(within(screen.getByTestId('provider-cost-pace')).queryByText(/%/)).not.toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Monthly budget' })).toHaveValue(null)
  })

  it('renders nothing for an unsupported provider answer', async () => {
    vi.mocked(api.fetchOpenRouterCostHistory).mockResolvedValue({ ok: false, provider: 'zai', supported: false, status: 'unsupported', message: 'n/a' })
    renderCost()
    await waitFor(() => expect(api.fetchOpenRouterCostHistory).toHaveBeenCalled())
    expect(document.querySelector('[data-provider-cost]')).toBeNull()
  })
})
