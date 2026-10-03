import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const titleTask = { task: 'title_generation', label: 'Title generation', description: 'session titles', provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true }
vi.mock('../../api/endpoints', () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ default_model: 'claude-sonnet-4-6' })),
  saveSettings: vi.fn(),
  fetchModels: vi.fn(() => Promise.resolve({ groups: [] })),
  setDefaultModel: vi.fn(),
  fetchAuxiliaryModels: vi.fn(() => Promise.resolve({ main: {}, tasks: [titleTask] })),
  setAuxiliaryModel: vi.fn(),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import { PreferencesSection } from './PreferencesSection'

describe('PreferencesSection', () => {
  it('opens the server auxiliary task list beside the default model (TAL-388)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><PreferencesSection /></QueryClientProvider>)
    await screen.findByText('Default Model')
    await userEvent.click(screen.getByRole('button', { name: 'Manage' }))
    const list = within(await screen.findByRole('list', { name: 'Auxiliary Models' }))
    expect(list.getByRole('button', { name: /Title generation/ })).toHaveTextContent('Auto · Anthropic · Claude Sonnet 4.6')
  })
})
