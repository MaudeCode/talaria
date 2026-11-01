import delegationFixtures from '../../../../../../contracts/fixtures/delegation-settings.json'
import { teardownAll } from '../../stream/connection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const TASKS = ['vision', 'web_extract', 'compression', 'approval', 'mcp', 'title_generation', 'skills_hub', 'curator', 'kanban_decomposer', 'profile_describer', 'triage_specifier', 'delegation']
const label = (task: string): string => (task === 'title_generation' ? 'Title generation' : task === 'mcp' ? 'MCP' : task.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()))
const EFFORTS = ['low', 'medium', 'high', 'none']
const inherited = (task: string) => ({ saved: null as string | null, effective: '', inherited: true, default_source: task === 'delegation' ? 'parent' as const : 'provider' as const, options: EFFORTS, unavailable: null as 'slot' | 'model' | 'agent' | null })
const auto = (task: string) => ({ task, label: label(task), description: `${task} description`, provider: 'auto', model: '', is_auto: true, value_label: 'Claude Sonnet 4.6', provider_label: 'Anthropic', selected_option_id: null, in_catalog: true, inherit_from: null, reasoning_effort: '', reasoning: inherited(task) })
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
import { AuxiliaryModelsSection } from './AuxiliaryModels'
import { ApiError } from '../../contracts/common'

function renderSetting() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><AuxiliaryModelsSection /></QueryClientProvider>)
  return qc
}

async function openList() {
  return within(await screen.findByRole('list', { name: 'Auxiliary Models' }))
}

/** Expands one task's inline editor and scopes queries to its list row. */
async function openTask(name: RegExp) {
  const row = (await openList()).getByRole('button', { name })
  await userEvent.click(row)
  expect(row).toHaveAttribute('aria-expanded', 'true')
  return within(row.closest('li')!)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.mocked(api.fetchAuxiliaryModels).mockReset().mockResolvedValue(auxState({ vision: { provider: 'openrouter', model: 'legacy/gone-model', is_auto: false, value_label: 'legacy/gone-model', provider_label: 'OpenRouter', selected_option_id: null, in_catalog: false } }))
  vi.mocked(api.fetchModels).mockReset().mockResolvedValue(CATALOG)
  vi.mocked(api.setAuxiliaryModel).mockReset()
})

describe('Auxiliary models settings', () => {
  it('keeps custom-model typing out of catalog renders and saves the typed id', async () => {
    renderSetting()
    const editor = await openTask(/Title generation/)
    await editor.findByRole('region', { name: 'Anthropic' })
    const before = catalogRenders.count
    await userEvent.type(editor.getByRole('textbox', { name: /Custom model ID/ }), 'custom-model')
    expect(catalogRenders.count).toBe(before)
    await userEvent.click(editor.getByRole('button', { name: 'Save' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', { model: 'custom-model', provider: null })
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
    const dialog = await openTask(/Title generation/)
    await dialog.findByRole('region', { name: 'Anthropic' })
    await userEvent.type(dialog.getByRole('searchbox'), 'llama')
    expect(dialog.queryByRole('region', { name: 'Anthropic' })).not.toBeInTheDocument()
    await userEvent.click(within(dialog.getByRole('region', { name: 'beta' })).getByRole('button', { name: 'Llama3' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', { model: '@custom:beta:llama3', provider: 'custom:beta' })
    const after = within(await screen.findByRole('list', { name: 'Auxiliary Models' }))
    expect(after.getByRole('button', { name: /Title generation/ })).toHaveTextContent('beta · Llama3')
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(auxState({ title_generation: pinnedBeta }))
    answer({ ok: true, auxiliary: auxState({ title_generation: pinnedBeta }) })
    await waitFor(() => expect(api.fetchAuxiliaryModels).toHaveBeenCalledTimes(2))
    expect(after.getByRole('button', { name: /Title generation/ })).toHaveTextContent('beta · Llama3')
  })

  // TAL-1625: opening a slot's picker never pulls focus into its search, by touch or keyboard; the list stays in view.
  it('opens a slot picker by touch or keyboard without focusing its search', async () => {
    renderSetting()
    const user = userEvent.setup()
    const row = (await openList()).getByRole('button', { name: /Title generation/ })
    await user.pointer({ keys: '[TouchA]', target: row })
    const touched = within(row.closest('li')!)
    await touched.findByRole('region', { name: 'Anthropic' })
    expect(touched.getByRole('searchbox')).not.toHaveFocus()
    const vision = (await openList()).getByRole('button', { name: /Vision/ })
    act(() => vision.focus())
    await user.keyboard('{Enter}')
    const typed = within(vision.closest('li')!)
    await typed.findByRole('region', { name: 'Anthropic' })
    expect(typed.getByRole('searchbox')).not.toHaveFocus()
    expect(vision).toHaveFocus()
  })

  it('ticks only the server-selected entry when two providers list the same bare model', async () => {
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(auxState({ title_generation: pinnedBeta }))
    renderSetting()
    const dialog = await openTask(/Title generation/)
    const beta = within(await dialog.findByRole('region', { name: 'beta' })).getByRole('button', { name: 'Llama3' })
    const alpha = within(dialog.getByRole('region', { name: 'alpha' })).getByRole('button', { name: 'Llama3' })
    expect(beta).toHaveAttribute('aria-pressed', 'true')
    expect(alpha).toHaveAttribute('aria-pressed', 'false')
    expect(dialog.getByRole('button', { name: /^Auto/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    new Error('provider-qualified auxiliary model must match the selected provider'),
    new ApiError({ kind: 'http', status: 409, path: 'api/model/set', message: 'config.yaml is package-managed. Update the declarative configuration instead.', body: { condition: 'config_write_refused' } }),
  ])('returns the slot to its prior value and shows the refusal: %s', async (error) => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise((_, reject) => { refuse = reject }))
    renderSetting()
    const dialog = await openTask(/Title generation/)
    await userEvent.type(dialog.getByRole('textbox', { name: /Custom model ID/ }), '@openai:')
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', { model: '@openai:', provider: null })
    const list = await screen.findByRole('list', { name: 'Auxiliary Models' })
    expect(within(list).getByRole('button', { name: /Title generation/ })).toHaveTextContent('@openai:')
    refuse(error)
    await waitFor(() => expect(within(list).getByRole('button', { name: /Title generation/ })).toHaveTextContent('Auto · Anthropic · Claude Sonnet 4.6'))
    expect(toast).toHaveBeenCalledWith(error.message, 4000, 'error')
  })

  it('resets every task only after confirmation', async () => {
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(auxState({ compression: { reasoning: { ...inherited('compression'), saved: 'high', inherited: false } } }))
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise(() => undefined))
    renderSetting()
    await openList()
    await userEvent.click(screen.getByRole('button', { name: 'Reset all to auto' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.setAuxiliaryModel).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Reset all to auto' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset all to auto' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('__reset__', { model: '' })
    // Every slot reads Auto with its default effort at once, including the off-catalog pin and the saved effort.
    const list = await screen.findByRole('list', { name: 'Auxiliary Models' })
    expect(list).not.toHaveTextContent('Not in catalog')
    expect(within(list).getByRole('button', { name: /Compression/ })).not.toHaveTextContent('high')
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

describe('Auxiliary models page loading and reasoning (TAL-1285)', () => {
  it('keeps task values, navigation, Auto and the custom id usable while the catalog is held, and reads it once for every task', async () => {
    const catalog = deferred<typeof CATALOG>()
    vi.mocked(api.fetchModels).mockReturnValue(catalog.promise)
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise(() => undefined))
    renderSetting()
    const list = await openList()
    expect(list.getByRole('button', { name: /Vision/ })).toHaveTextContent('OpenRouter · legacy/gone-model')
    let editor = await openTask(/Title generation/)
    expect(editor.getByRole('status')).toHaveTextContent('Loading')
    expect(editor.getByRole('textbox', { name: /Custom model ID/ })).toBeEnabled()
    // Switching tasks while the catalog is pending neither blocks nor starts another discovery.
    editor = await openTask(/Compression/)
    expect(list.getByRole('button', { name: /Title generation/ })).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(editor.getByRole('button', { name: /^Auto/ }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('compression', { model: '', provider: 'auto' })
    catalog.resolve(CATALOG)
    expect(await editor.findByRole('region', { name: 'Anthropic' })).toBeInTheDocument()
    await openTask(/Title generation/)
    await openTask(/Vision/)
    expect(api.fetchModels).toHaveBeenCalledTimes(1)
  })

  it('separates a failed first catalog load (retry), an empty catalog, and a failed refresh that keeps the cached catalog', async () => {
    vi.mocked(api.fetchModels).mockRejectedValueOnce(new Error('catalog unreachable'))
    const qc = renderSetting()
    const editor = await openTask(/Title generation/)
    expect(await editor.findByRole('alert')).toHaveTextContent('catalog unreachable')
    expect(editor.queryByRole('status')).not.toBeInTheDocument()
    // The task list keeps every saved value while the catalog is unavailable.
    expect((await openList()).getByRole('button', { name: /Vision/ })).toHaveTextContent('legacy/gone-model')
    vi.mocked(api.fetchModels).mockResolvedValueOnce({ groups: [] })
    await userEvent.click(editor.getByRole('button', { name: 'Retry' }))
    expect(await editor.findByText('No models found')).toBeInTheDocument()
    vi.mocked(api.fetchModels).mockResolvedValueOnce(CATALOG)
    await act(async () => { await qc.refetchQueries({ queryKey: ['models'], exact: true }) })
    expect(await editor.findByRole('region', { name: 'Anthropic' })).toBeInTheDocument()
    vi.mocked(api.fetchModels).mockRejectedValueOnce(new Error('refresh failed'))
    await act(async () => { await qc.refetchQueries({ queryKey: ['models'], exact: true }).catch(() => undefined) })
    expect(await editor.findByRole('alert')).toHaveTextContent('refresh failed')
    expect(editor.getByRole('region', { name: 'Anthropic' })).toBeInTheDocument()
  })

  it('offers only the server options, tells the default from an override, and saves an effort without the route', async () => {
    let answer!: (value: Awaited<ReturnType<typeof api.setAuxiliaryModel>>) => void
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise((resolve) => { answer = resolve }))
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(auxState({
      compression: { provider: 'anthropic', model: 'claude-opus-4-7', is_auto: false, value_label: 'Claude Opus 4.7', selected_option_id: 'claude-opus-4-7', reasoning: { ...inherited('compression'), saved: 'medium', inherited: false } },
      title_generation: { reasoning: { ...inherited('title_generation'), options: ['low', 'high', 'none'] } },
      mcp: { reasoning: { ...inherited('mcp'), options: [], unavailable: 'slot' } },
    }))
    renderSetting()
    const list = await openList()
    expect(list.getByRole('button', { name: /Compression/ })).toHaveTextContent('Anthropic · Claude Opus 4.7 · medium')
    expect(list.getByRole('button', { name: /Title generation/ })).not.toHaveTextContent('medium')
    expect((await openTask(/Compression/)).getByRole('button', { name: 'Reasoning effort: medium' })).toBeInTheDocument()
    expect((await openTask(/MCP/)).queryByRole('button', { name: /Reasoning effort/ })).not.toBeInTheDocument()
    const editor = await openTask(/Title generation/)
    await userEvent.click(editor.getByRole('button', { name: 'Reasoning effort: Default' }))
    expect((await screen.findAllByRole('menuitemradio')).map((item) => item.textContent)).toEqual(['Default', 'low', 'high', 'none'])
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'high' }))
    expect(api.setAuxiliaryModel).toHaveBeenCalledWith('title_generation', { reasoning_effort: 'high' })
    expect(vi.mocked(api.setAuxiliaryModel).mock.calls[0]![1].model).toBeUndefined()
    // The pick shows at once in the row and the control, before the server answers.
    expect(list.getByRole('button', { name: /Title generation/ })).toHaveTextContent('Auto · Anthropic · Claude Sonnet 4.6 · high')
    expect(editor.getByRole('button', { name: 'Reasoning effort: high' })).toBeInTheDocument()
    const confirmed = auxState({ title_generation: { reasoning: { ...inherited('title_generation'), options: ['low', 'high', 'none'], saved: 'high', inherited: false } } })
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue(confirmed)
    answer({ ok: true, auxiliary: confirmed })
    await waitFor(() => expect(api.fetchAuxiliaryModels).toHaveBeenCalledTimes(2))
    expect(list.getByRole('button', { name: /Title generation/ })).toHaveTextContent('· high')
  })

  it('names the parent default on the delegation slot', async () => {
    vi.mocked(api.fetchAuxiliaryModels).mockResolvedValue({ ...auxState(), delegation: delegationFixtures.default })
    renderSetting()
    const editor = await openTask(/Delegation/)
    expect(editor.getByRole('button', { name: 'Reasoning effort: Inherit' })).toBeInTheDocument()
  })

  it('rolls an effort back to the saved value and shows the refusal', async () => {
    const refusal = new ApiError({ kind: 'http', status: 400, path: 'api/model/set', message: "Reasoning effort 'high' is not supported for Title generation. Valid: low, none", body: {} })
    vi.mocked(api.setAuxiliaryModel).mockRejectedValue(refusal)
    renderSetting()
    const editor = await openTask(/Title generation/)
    await userEvent.click(editor.getByRole('button', { name: 'Reasoning effort: Default' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'high' }))
    await waitFor(() => expect(editor.getByRole('button', { name: 'Reasoning effort: Default' })).toBeInTheDocument())
    expect((await openList()).getByRole('button', { name: /Title generation/ })).not.toHaveTextContent('high')
    expect(toast).toHaveBeenCalledWith(refusal.message, 4000, 'error')
  })

  it('fences a late model write after a profile switch', async () => {
    let answer!: (value: Awaited<ReturnType<typeof api.setAuxiliaryModel>>) => void
    vi.mocked(api.setAuxiliaryModel).mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const qc = renderSetting()
    const editor = await openTask(/Title generation/)
    await userEvent.click(within(await editor.findByRole('region', { name: 'beta' })).getByRole('button', { name: 'Llama3' }))
    teardownAll()
    const other = auxState({ title_generation: { provider: 'anthropic', model: 'claude-opus-4-7', is_auto: false, value_label: 'Claude Opus 4.7', selected_option_id: 'claude-opus-4-7' } })
    qc.setQueryData(['models', 'auxiliary'], other)
    await act(async () => { answer({ ok: true, auxiliary: auxState({ title_generation: pinnedBeta }) }); await Promise.resolve() })
    await waitFor(() => expect(qc.getQueryData(['models', 'auxiliary'])).toEqual(other))
  })
})
