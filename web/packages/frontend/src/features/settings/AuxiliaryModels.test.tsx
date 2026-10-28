import delegationFixtures from '../../../../../../contracts/fixtures/delegation-settings.json'
import { teardownAll } from '../../stream/connection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const TASKS = ['vision', 'web_extract', 'compression', 'approval', 'mcp', 'title_generation', 'skills_hub', 'curator', 'kanban_decomposer', 'profile_describer', 'triage_specifier', 'delegation']
const label = (task: string): string => (task === 'title_generation' ? 'Title generation' : task === 'mcp' ? 'MCP' : task.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()))
const auto = (task: string) => ({ task, label: label(task), description: `${task} description`, provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '' })
function auxState(overrides: Record<string, object> = {}) {
  return { main: { provider: 'anthropic', model: 'claude-sonnet-4-6' }, tasks: TASKS.map((t) => ({ ...auto(t), ...overrides[t] })) }
}
const pinnedBeta = { provider: 'custom:beta', model: 'llama3', is_auto: false, value_label: 'Llama3', provider_label: 'beta', selected_option_id: '@custom:beta:llama3', in_catalog: true }
const CATALOG = {
  groups: [
    { provider: 'Anthropic', provider_id: 'anthropic', models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }, { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' }] },
    { provider: 'alpha', provider_id: 'custom:alpha', models: [{ id: '@custom:alpha:llama3', label: 'Llama3' }] },
    { provider: 'beta', provider_id: 'custom:beta', models: [{ id: '@custom:beta:llama3', label: 'Llama3' }] },
  ],
}

const toast = vi.hoisted(() => vi.fn())
vi.mock('../toast/toast', () => ({ showToast: toast }))
vi.mock('../../api/endpoints', () => ({
  fetchAuxiliaryModels: vi.fn(),
  setAuxiliaryModel: vi.fn(),
  setDelegation: vi.fn(),
  fetchModels: vi.fn(),
}))
const catalogRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock(import('../../app/queries'), async (original) => {
  const queries = await original()
  return { ...queries, useModelsQuery: () => { catalogRenders.count++; return queries.useModelsQuery() } }
})
import * as api from '../../api/endpoints'
import { AuxiliaryModelsSetting } from './AuxiliaryModels'
import { ApiError } from '../../contracts/common'

function renderSetting() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><AuxiliaryModelsSetting /></QueryClientProvider>)
  return qc
}

async function openList() {
  await userEvent.click(screen.getByRole('button', { name: 'Manage' }))
  return within(await screen.findByRole('list', { name: 'Auxiliary Models' }))
}

beforeEach(() => {
  vi.mocked(api.fetchAuxiliaryModels).mockReset().mockResolvedValue(auxState({ vision: { provider: 'openrouter', model: 'legacy/gone-model', is_auto: false, value_label: 'legacy/gone-model', provider_label: 'OpenRouter', selected_option_id: null, in_catalog: false } }))
  vi.mocked(api.fetchModels).mockReset().mockResolvedValue(CATALOG)
  vi.mocked(api.setAuxiliaryModel).mockReset()
})

describe('Auxiliary models settings', () => {
  it('keeps custom-model typing out of catalog renders and saves the typed id', async () => {
    renderSetting()
    await userEvent.click((await openList()).getByRole('button', { name: /Title generation/ }))
    await screen.findByRole('region', { name: 'Anthropic' })
    const before = catalogRenders.count
    await userEvent.type(screen.getByRole('textbox', { name: /Custom model ID/ }), 'custom-model')
    expect(catalogRenders.count).toBe(before)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', 'custom-model', null)
  })

  it('lists every server task in server order with Auto, pinned, and off-catalog values', async () => {
    renderSetting()
    const list = await openList()
    const rows = list.getAllByRole('button')
    expect(rows.map((r) => r.firstElementChild?.firstElementChild?.textContent)).toEqual(TASKS.map(label))
    expect(rows[0]).toHaveTextContent('Vision')
    expect(rows[0]).toHaveTextContent('OpenRouter · legacy/gone-model')
    expect(rows[0]).toHaveTextContent('Not in catalog')
    expect(rows[5]).toHaveTextContent('Title generation')
    expect(rows[5]).toHaveTextContent('Auto · Anthropic · Claude Sonnet 4.6')
    expect(rows[5]).not.toHaveTextContent('Not in catalog')
  })

  it('searches the catalog, shows the pick in the list at once, and adopts the server state', async () => {
    let answer!: (value: Awaited<ReturnType<typeof api.setAuxiliaryModel>>) => void
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise((resolve) => { answer = resolve }))
    renderSetting()
    const list = await openList()
    await userEvent.click(list.getByRole('button', { name: /Title generation/ }))
    const dialog = screen.getByRole('dialog')
    await within(dialog).findByRole('region', { name: 'Anthropic' })
    await userEvent.type(within(dialog).getByRole('searchbox'), 'llama')
    expect(within(dialog).queryByRole('region', { name: 'Anthropic' })).not.toBeInTheDocument()
    await userEvent.click(within(within(dialog).getByRole('region', { name: 'beta' })).getByRole('button', { name: 'Llama3' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', '@custom:beta:llama3', 'custom:beta')
    const after = within(await screen.findByRole('list', { name: 'Auxiliary Models' }))
    expect(after.getByRole('button', { name: /Title generation/ })).toHaveTextContent('beta · Llama3')
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(auxState({ title_generation: pinnedBeta }))
    answer({ ok: true, auxiliary: auxState({ title_generation: pinnedBeta }) })
    await waitFor(() => expect(api.fetchAuxiliaryModels).toHaveBeenCalledTimes(2))
    expect(after.getByRole('button', { name: /Title generation/ })).toHaveTextContent('beta · Llama3')
  })

  it('ticks only the server-selected entry when two providers list the same bare model', async () => {
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(auxState({ title_generation: pinnedBeta }))
    renderSetting()
    await userEvent.click((await openList()).getByRole('button', { name: /Title generation/ }))
    const dialog = screen.getByRole('dialog')
    const beta = within(await within(dialog).findByRole('region', { name: 'beta' })).getByRole('button', { name: 'Llama3' })
    const alpha = within(within(dialog).getByRole('region', { name: 'alpha' })).getByRole('button', { name: 'Llama3' })
    expect(beta).toHaveAttribute('aria-pressed', 'true')
    expect(alpha).toHaveAttribute('aria-pressed', 'false')
    expect(within(dialog).getByRole('button', { name: /^Auto/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    new Error('provider-qualified auxiliary model must match the selected provider'),
    new ApiError({ kind: 'http', status: 409, path: 'api/model/set', message: 'config.yaml is package-managed. Update the declarative configuration instead.', body: { condition: 'config_write_refused' } }),
  ])('returns the slot to its prior value and shows the refusal: %s', async (error) => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise((_, reject) => { refuse = reject }))
    renderSetting()
    await userEvent.click((await openList()).getByRole('button', { name: /Title generation/ }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Custom model ID/ }), '@openai:')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', '@openai:', null)
    const list = await screen.findByRole('list', { name: 'Auxiliary Models' })
    expect(within(list).getByRole('button', { name: /Title generation/ })).toHaveTextContent('@openai:')
    refuse(error)
    await waitFor(() => expect(within(list).getByRole('button', { name: /Title generation/ })).toHaveTextContent('Auto · Anthropic · Claude Sonnet 4.6'))
    expect(toast).toHaveBeenCalledWith(error.message, 4000, 'error')
  })

  it('resets every task only after confirmation', async () => {
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise(() => undefined))
    renderSetting()
    await openList()
    await userEvent.click(screen.getByRole('button', { name: 'Reset all to auto' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.setAuxiliaryModel).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Reset all to auto' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset all to auto' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('__reset__', '', undefined)
    // Every slot reads Auto at once, including the off-catalog pin.
    expect((await screen.findByRole('list', { name: 'Auxiliary Models' }))).not.toHaveTextContent('Not in catalog')
  })
})

it('keeps a saved unavailable mode visible, restores optimistically, and rolls back a managed refusal', async () => {
  const state = { ...auxState(), delegation: delegationFixtures.missing }
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(state)
  let refuse!: (error: unknown) => void
  vi.mocked(api.setDelegation).mockReturnValue(new Promise((_, reject) => { refuse = reject }))
  renderSetting()
  await userEvent.click((await openList()).getByRole('button', { name: /Delegation/ }))
  expect(screen.getByRole('status')).toHaveTextContent('Install or enable')
  expect(screen.queryByRole('button', { name: 'Fixed model' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Restore Default' }))
  await waitFor(() => expect(api.setDelegation).toHaveBeenCalledWith({ action: 'backend', backend: 'default' }))
  expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveTextContent('Default')
  refuse(new ApiError({ kind: 'http', status: 409, path: 'api/model/auxiliary/delegation', message: 'config.yaml is package-managed.', body: {} }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveTextContent('missing_backend'))
})

it('shows route renames immediately and fences a late response after a profile switch', async () => {
  const initial = { ...auxState(), delegation: delegationFixtures.default }
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(initial)
  let answer!: (state: Awaited<ReturnType<typeof api.setDelegation>>) => void
  vi.mocked(api.setDelegation).mockReturnValue(new Promise((resolve) => { answer = resolve }))
  const qc = renderSetting()
  await userEvent.click((await openList()).getByRole('button', { name: /Delegation/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Model routes' }))
  await userEvent.click(screen.getByRole('button', { name: 'Edit Research' }))
  await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('button', { name: 'Edit Renamed' })).toBeInTheDocument()
  expect(api.setDelegation).toHaveBeenCalledWith(expect.objectContaining({ action: 'routes', block: expect.objectContaining({ options: [expect.objectContaining({ name: 'Renamed', original_name: 'Research', api_key_set: true, service_tier: 'normal', fallback_providers: [] })], default: 'Renamed' }) }))
  teardownAll()
  qc.setQueryData(['models', 'auxiliary'], { ...auxState(), delegation: delegationFixtures.older })
  await act(async () => { answer(initial); await Promise.resolve() })
  await waitFor(() => expect(qc.getQueryData(['models', 'auxiliary'])).toMatchObject({ delegation: { supported: false } }))
})

it('requires explicit profile lending consent before saving a profile route', async () => {
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue({ ...auxState(), delegation: delegationFixtures.default })
  renderSetting()
  await userEvent.click((await openList()).getByRole('button', { name: /Delegation/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Profile routes' }))
  await userEvent.click(screen.getByRole('button', { name: 'Add route' }))
  expect(screen.getByText(/This profile lends its credentials/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('combobox', { name: 'Profile' }))
  await userEvent.click(await screen.findByRole('option', { name: 'research' }))
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox'))
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
})

it('reconciles an unknown outcome before allowing another delegation save', async () => {
  const initial = { ...auxState(), delegation: delegationFixtures.missing }
  let reconcile!: (value: typeof initial) => void
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValueOnce(initial).mockReturnValue(new Promise((resolve) => { reconcile = resolve }))
  vi.mocked(api.setDelegation).mockRejectedValue(new ApiError({ kind: 'http', status: 503, path: 'api/model/auxiliary/delegation', message: 'Response lost', body: {} }))
  renderSetting()
  await userEvent.click((await openList()).getByRole('button', { name: /Delegation/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Restore Default' }))
  await waitFor(() => expect(api.fetchAuxiliaryModels).toHaveBeenCalledTimes(2))
  await userEvent.click(screen.getByRole('button', { name: 'Restore Default' }))
  expect(api.setDelegation).toHaveBeenCalledTimes(1)
  await act(async () => { reconcile(initial); await Promise.resolve() })
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveTextContent('missing_backend'))
})

it('renders server-denied delegation management read-only while retaining the local fixed-model picker', async () => {
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue({ ...auxState(), delegation: delegationFixtures.readonly })
  renderSetting()
  const list = await openList()
  expect(screen.getByRole('button', { name: 'Reset all to auto' })).toBeDisabled()
  await userEvent.click(list.getByRole('button', { name: /Delegation/ }))
  expect(screen.getByRole('combobox', { name: 'Mode' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Profile routes' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Model routes' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Restore Default' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Fixed model' })).toBeEnabled()
})

it.each(['model_map', 'profile_routes'] as const)('preserves No default when creating a named route with %s', async (backend) => {
  const delegation = { ...delegationFixtures.default, model_map: { options: [], default: null } }
  vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue({ ...auxState(), delegation })
  vi.mocked(api.setDelegation).mockReturnValue(new Promise(() => undefined))
  renderSetting()
  await userEvent.click((await openList()).getByRole('button', { name: /Delegation/ }))
  await userEvent.click(screen.getByRole('button', { name: backend === 'model_map' ? 'Model routes' : 'Profile routes' }))
  await userEvent.click(screen.getByRole('button', { name: 'Add route' }))
  if (backend === 'model_map') {
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'New route')
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Research tasks')
    await userEvent.type(screen.getByRole('textbox', { name: 'Model' }), 'synthetic')
    await userEvent.type(screen.getByRole('textbox', { name: 'Provider' }), 'openai')
  } else {
    await userEvent.click(screen.getByRole('combobox', { name: 'Profile' }))
    await userEvent.click(await screen.findByRole('option', { name: 'research' }))
    await userEvent.click(screen.getByRole('checkbox'))
  }
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.setDelegation).toHaveBeenCalledWith(expect.objectContaining({ action: 'routes', backend, block: expect.objectContaining({ default: null, [backend === 'model_map' ? 'options' : 'profiles']: [expect.objectContaining({ name: backend === 'model_map' ? 'New route' : 'research' })] }) }))
})
