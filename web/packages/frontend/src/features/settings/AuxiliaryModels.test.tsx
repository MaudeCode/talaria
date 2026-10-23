import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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
