import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const titleTask = { task: 'title_generation', label: 'Title generation', description: 'session titles', provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '' }
vi.mock('../../api/endpoints', () => ({
  fetchSettings: vi.fn(() => Promise.resolve({ default_model: 'claude-sonnet-4-6', confirm_external_links: true, trusted_link_hosts: ['docs.example.com'] })),
  saveSettings: vi.fn((patch: Record<string, unknown>) => Promise.resolve(patch)),
  fetchModels: vi.fn(() => Promise.resolve({ groups: [] })),
  setDefaultModel: vi.fn(),
  fetchAuxiliaryModels: vi.fn(() => Promise.resolve({ main: {}, tasks: [titleTask] })),
  setAuxiliaryModel: vi.fn(),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import { PreferencesSection } from './PreferencesSection'
import { saveSettings, fetchAuxiliaryModels, fetchModels, setDefaultModel } from '../../api/endpoints'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'

const renderSection = (canManage = true) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: canManage } }
  return render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}><PreferencesSection /></BootstrapContext.Provider></QueryClientProvider>)
}

describe('PreferencesSection', () => {
  it('opens the server auxiliary task list beside the default model (TAL-388)', async () => {
    renderSection()
    await screen.findByText('Default Model')
    await userEvent.click(screen.getByRole('button', { name: 'Manage' }))
    const list = within(await screen.findByRole('list', { name: 'Auxiliary Models' }))
    expect(list.getByRole('button', { name: /Title generation/ })).toHaveTextContent('Auto · Anthropic · Claude Sonnet 4.6')
  })

  it('edits the external-link confirmation and trusted hosts through settings (TAL-279)', async () => {
    renderSection()
    const confirm = await screen.findByRole('switch', { name: 'Confirm before opening external links' })
    expect(confirm).toBeChecked()
    await userEvent.click(confirm)
    expect(saveSettings).toHaveBeenLastCalledWith({ confirm_external_links: false })
    const hosts = screen.getByLabelText('Trusted link hosts')
    expect(hosts).toHaveValue('docs.example.com')
    await userEvent.type(hosts, '\nAPI.Example.com')
    await userEvent.click(within(hosts.closest('form')!).getByRole('button', { name: 'Save' }))
    expect(saveSettings).toHaveBeenLastCalledWith({ trusted_link_hosts: ['docs.example.com', 'API.Example.com'] })
  })

  it('lets only a server owner change link safety (TAL-279)', async () => {
    renderSection(false)
    expect(await screen.findByRole('switch', { name: 'Confirm before opening external links' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByLabelText('Trusted link hosts')).toBeDisabled()
  })
})

it('renders and saves only the server-provided speed tiers (TAL-788)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' }, { id: 'ultrafast', service_tier: 'ultrafast' },
  ] }, tasks: [] })
  vi.mocked(setDefaultModel).mockResolvedValue({ ok: true, model: 'gpt-6-astra', provider: 'openai-codex' })
  renderSection()
  const speed = await screen.findByRole('combobox', { name: 'Speed' })
  expect(speed).toHaveTextContent('Fast')
  await userEvent.click(speed)
  expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Standard', 'Fast', 'Ultrafast'])
  await userEvent.click(screen.getByRole('option', { name: 'Ultrafast' }))
  expect(setDefaultModel).toHaveBeenCalledWith('gpt-6-astra', 'openai-codex', { service_tier: 'ultrafast' })
})

it('shows a chosen speed and default model at once, sending the shown model with the speed (TAL-1179)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: { model: 'gpt-6-astra', provider: 'openai-codex', service_tier: 'priority', supported_speed_tiers: [
    { id: 'standard', service_tier: 'default' }, { id: 'priority', service_tier: 'priority' },
  ] }, tasks: [] })
  vi.mocked(fetchModels).mockResolvedValue({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-6-astra', label: 'GPT-6 Astra', provider_id: 'openai-codex' }, { id: '@openai-codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider_id: 'openai-codex' }] }] })
  vi.mocked(setDefaultModel).mockReturnValue(new Promise(() => undefined))
  renderSection()
  const model = await screen.findByRole('combobox', { name: 'Default Model' })
  await userEvent.click(model)
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  expect(setDefaultModel).toHaveBeenLastCalledWith('@openai-codex:gpt-5.6-sol', 'openai-codex', undefined)
  expect(model).toHaveTextContent('GPT-5.6 Sol')
  expect(model).not.toHaveAttribute('data-disabled')
  const speed = screen.getByRole('combobox', { name: 'Speed' })
  await userEvent.click(speed)
  await userEvent.click(await screen.findByRole('option', { name: 'Standard' }))
  expect(speed).toHaveTextContent('Standard')
  expect(model).toHaveTextContent('GPT-5.6 Sol')
  expect(setDefaultModel).toHaveBeenCalledTimes(1)
})

it('rereads the auxiliary slots after the default model changes (TAL-1383)', async () => {
  vi.mocked(fetchAuxiliaryModels).mockResolvedValue({ main: {}, tasks: [] })
  vi.mocked(fetchModels).mockResolvedValue({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider_id: 'openai-codex' }] }] })
  vi.mocked(setDefaultModel).mockResolvedValue({ ok: true, model: 'gpt-5.6-sol', provider: 'openai-codex' })
  renderSection()
  await waitFor(() => expect(fetchAuxiliaryModels).toHaveBeenCalled())
  const before = vi.mocked(fetchAuxiliaryModels).mock.calls.length
  await userEvent.click(await screen.findByRole('combobox', { name: 'Default Model' }))
  await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Sol' }))
  await waitFor(() => expect(vi.mocked(fetchAuxiliaryModels).mock.calls.length).toBeGreaterThan(before))
})
