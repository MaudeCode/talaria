import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// TAL-288: a plugin provider's group from the server catalog, listing a bare id another provider also lists.
const CATALOG = {
  active_provider: 'anthropic',
  default_model: 'claude-sonnet-4-6',
  groups: [
    { provider: 'Anthropic', provider_id: 'anthropic', models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }] },
    { provider: 'Fake Subscription', provider_id: 'fake-sub', models: [{ id: '@fake-sub:claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }] },
  ],
}

vi.mock('../../api/endpoints', () => ({ fetchModels: vi.fn(() => Promise.resolve(CATALOG)) }))
import { ModelChip } from './chips'

describe('ModelChip', () => {
  it('a plugin provider model keeps the plugin provider when another provider lists the same model', async () => {
    const onChange = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><ModelChip value={null} defaultModel="claude-sonnet-4-6" onChange={onChange} /></QueryClientProvider>)
    await userEvent.click(screen.getByRole('button'))
    const group = await screen.findByRole('group', { name: 'Fake Subscription' })
    await userEvent.click(within(group).getByRole('menuitemradio', { name: 'Claude Sonnet 4.6' }))
    expect(onChange).toHaveBeenCalledWith('@fake-sub:claude-sonnet-4-6', 'fake-sub')
  })
})
