import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/** The server's real `/api/provider/cost-history` response (pinned by the server test). */
const costHistory = (JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/__fixtures__/live/provider_cost_history.json'), 'utf8')) as { body: unknown }).body
vi.mock('../../api/endpoints', () => ({
  fetchOpenRouterCostHistory: vi.fn(() => Promise.resolve(costHistory)), saveSettings: vi.fn(), fetchSettings: vi.fn(() => Promise.resolve({})), setDefaultModel: vi.fn(),
  fetchProviders: vi.fn(() => Promise.resolve({ active_provider: 'openrouter', providers: [{ id: 'openrouter', display_name: 'OpenRouter', has_key: true }, { id: 'zai', display_name: 'Z.AI', has_key: true }] })),
  fetchProviderQuotas: vi.fn(() => Promise.resolve({ version: 1, computed_at: '2026-09-28T08:00:00Z', scope_id: 's', profile_id: 'default', active_provider: 'openrouter', requested_source_id: null, missing_source: false, sources: [] })),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import { ProvidersSection } from './ProvidersSection'

describe('ProvidersSection', () => {
  it('shows the OpenRouter spend chart, pace, and budget standing inside the keyed OpenRouter row only (TAL-412)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={qc}><ProvidersSection /></QueryClientProvider>)
    const openrouter = (await screen.findByText('OpenRouter')).closest<HTMLElement>('[data-provider="openrouter"]')!
    expect(await within(openrouter).findByText('Monthly pace: $33.90', { exact: false }, { timeout: 2000 })).toBeInTheDocument()
    expect(within(openrouter).getByText('80% of $42.37 budget (monthly pace)')).toBeInTheDocument()
    expect(within(openrouter).getAllByRole('listitem').filter((li) => li.hasAttribute('title'))).toHaveLength(7)
    expect(document.querySelectorAll('[data-provider-cost]')).toHaveLength(1)
  })
})
