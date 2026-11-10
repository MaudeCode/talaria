import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// TAL-288: a plugin provider's group from the server catalog, listing a bare id another provider also lists.
const PLUGIN_CATALOG = {
  active_provider: 'anthropic',
  default_model: 'claude-sonnet-4-6',
  default_provider_id: 'anthropic',
  default_bare_id: 'claude-sonnet-4-6',
  default_option_id: 'claude-sonnet-4-6',
  groups: [
    { provider: 'Anthropic', provider_id: 'anthropic', models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider_id: 'anthropic', bare_id: 'claude-sonnet-4-6' }] },
    { provider: 'Fake Subscription', provider_id: 'fake-sub', models: [{ id: '@fake-sub:claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider_id: 'fake-sub', bare_id: 'claude-sonnet-4-6' }] },
  ],
}
// TAL-301: colon-bearing ids and one bare id under two providers, stamped as `/api/models` serves them.
const COLON_CATALOG = {
  active_provider: 'anthropic',
  default_model: '@custom:localhost:8080:m',
  default_provider_id: 'custom:localhost:8080',
  default_bare_id: 'm',
  default_option_id: '@custom:localhost:8080:m',
  groups: [
    { provider: 'Anthropic', provider_id: 'anthropic', models: [{ id: 'claude-opus-4.7', label: 'Claude Opus 4.7', provider_id: 'anthropic', bare_id: 'claude-opus-4.7' }, { id: '@custom:localhost:8080:m', label: 'M', provider_id: 'custom:localhost:8080', bare_id: 'm' }] },
    { provider: 'Gemini', provider_id: 'gemini', models: [{ id: '@gemini:gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider_id: 'gemini', bare_id: 'gemini-2.5-flash' }] },
    { provider: 'Google', provider_id: 'google', models: [{ id: '@google:gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider_id: 'google', bare_id: 'gemini-2.5-flash' }] },
    { provider: 'Ollama', provider_id: 'ollama', models: [{ id: '@ollama:llama3:8b', label: 'Llama3 (8B)', provider_id: 'ollama', bare_id: 'llama3:8b' }] },
  ],
}
// TAL-1858: a starred model under each of two providers, and a provider with no known icon whose ids look like another's;
// each group carries the icon the server resolved from its provider id.
const FAVORITES_CATALOG = {
  active_provider: 'anthropic',
  default_model: 'claude-opus-4.7', default_provider_id: 'anthropic', default_bare_id: 'claude-opus-4.7', default_option_id: 'claude-opus-4.7',
  groups: [
    { provider: 'Anthropic', provider_id: 'anthropic', icon: { asset: 'Anthropic', initials: 'A', color: true }, models: [
      { id: 'claude-opus-4.7', label: 'Claude Opus 4.7', provider_id: 'anthropic', bare_id: 'claude-opus-4.7', favorite: false },
      { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', provider_id: 'anthropic', bare_id: 'claude-haiku-4.5', favorite: true },
    ] },
    { provider: 'OpenRouter', provider_id: 'openrouter', icon: { asset: 'OpenRouter', initials: 'O', color: false }, models: [{ id: '@openrouter:qwen/qwen3', label: 'Qwen3', provider_id: 'openrouter', bare_id: 'qwen/qwen3', favorite: true }] },
    { provider: 'Acme Cloud', provider_id: 'acme-cloud', icon: { asset: null, initials: 'AC', color: false }, models: [{ id: '@anthropic:claude-opus-4.7', label: 'Acme Opus', provider_id: 'acme-cloud', bare_id: '@anthropic:claude-opus-4.7', favorite: false }] },
  ],
  // Starred OpenRouter first, so the starred order differs from the catalog's.
  favorites: [{ provider_id: 'openrouter', model: 'qwen/qwen3' }, { provider_id: 'anthropic', model: 'claude-haiku-4.5' }],
  favorite_option_ids: ['@openrouter:qwen/qwen3', 'claude-haiku-4.5'],
}
let catalog: unknown = PLUGIN_CATALOG

// The server's registry: every entry named, the default one `Home` (TAL-303).
const WORKSPACES = { workspaces: [{ path: '/src/talaria-main', name: 'Talaria' }, { path: '/src/scratch', name: 'scratch' }], last: '/src/talaria-main' }

// TAL-2096: the sidecar's catalog in its server order, with `file` the profile default, for the choice it is read with.
const TOOLSETS = [
  { name: 'file', description: 'Read and write files', available: true, unavailable_reason: null },
  { name: 'todo', description: 'Task lists', available: false, unavailable_reason: 'disabled' },
  { name: 'web', description: 'Search the web', available: true, unavailable_reason: null },
  { name: 'browser', description: 'Drive a browser', available: false, unavailable_reason: 'unavailable' },
  { name: 'terminal', description: 'Run commands', available: true, unavailable_reason: null },
] as const
function toolsetsCatalog(choice: string[] | null) {
  const selected = choice ?? ['file']
  return { toolsets: TOOLSETS.map((row) => ({ ...row, selected: selected.includes(row.name) })), selected_toolsets: selected, using_defaults: choice === null }
}

let modes: unknown = { modes: [{ mode: 'normal', available: true, reason: null }, { mode: 'ignore_config', available: true, reason: null }, { mode: 'safe', available: true, reason: null }] }
vi.mock('../../api/endpoints', () => ({ fetchExecutionModes: vi.fn(() => Promise.resolve(modes)), fetchToolsetsCatalog: vi.fn((choice: string[] | null) => Promise.resolve(toolsetsCatalog(choice))), fetchModels: vi.fn(() => Promise.resolve(catalog)), fetchWorkspaces: vi.fn(() => Promise.resolve(WORKSPACES)), setModelFavorite: vi.fn() }))
vi.mock('../toast/errorToast', () => ({ showErrorToast: vi.fn() }))
import { ExecutionModeChip, ModelChip, ToolsetsChip, WorkspaceChip } from './chips'
import { Dialog } from '../../ui/Dialog'
import { fetchModels, fetchToolsetsCatalog, setModelFavorite } from '../../api/endpoints'
import { showErrorToast } from '../toast/errorToast'
import { ApiError } from '../../contracts/common'

// jsdom lays nothing out; the picker's scroller gets a height so the virtualized list renders its rows.
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-model-picker-list') ? 100_000 : 0 } }) })
afterAll(() => { if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight) })

function renderChip(props: { model: string | null; optionId: string | null }, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ModelChip {...props} onChange={onChange} /></QueryClientProvider>)
}
const picker = () => screen.findByRole('dialog', { name: 'Conversation model' })
const optionNames = () => screen.getAllByRole('option').map((el) => el.getAttribute('aria-label'))
const rail = () => screen.getByRole('toolbar', { name: 'Providers' })

describe('ModelChip', () => {
  it('keeps its rows through the exit transition (TAL-1784)', async () => {
    catalog = COLON_CATALOG
    renderChip({ model: 'claude-opus-4.7', optionId: 'claude-opus-4.7' })
    await userEvent.click(screen.getByRole('button', { name: /Conversation model/ }))
    await screen.findByRole('option', { name: 'Claude Opus 4.7' })
    // A running exit transition: Base UI keeps the popup mounted until this finishes.
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [{ finished: new Promise(() => undefined), pending: true }] })
    try {
      await userEvent.keyboard('{Escape}')
      const closing = await screen.findByRole('dialog', { hidden: true })
      await waitFor(() => { expect(closing).toHaveAttribute('data-ending-style') })
      expect(closing).toHaveTextContent('Claude Opus 4.7')
    } finally {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
    }
  })

  it.each([
    ['the model that answered after a fallback', 'fallback-model', 'fallback-model', 'Conversation model Claude Opus 4.7, answered by fallback-model after a fallback'],
    ['the configured model, with its full name in the tooltip, when it answered', null, 'Claude Opus 4.7', 'Conversation model: Claude Opus 4.7'],
  ])('names %s (TAL-978)', async (_case, servedModel, label, title) => {
    catalog = COLON_CATALOG
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><ModelChip model="claude-opus-4.7" optionId="claude-opus-4.7" servedModel={servedModel} onChange={vi.fn()} /></QueryClientProvider>)
    await waitFor(() => { expect(screen.getByRole('button')).toHaveAttribute('title', title); expect(screen.getByRole('button')).toHaveTextContent(label) })
    // The picker keeps the configured model ticked: it is what the next turn asks for.
    await userEvent.click(screen.getByRole('button'))
    expect(await screen.findByRole('option', { name: 'Claude Opus 4.7' })).toHaveAttribute('aria-selected', 'true')
    cleanup()
  })

  it('renders server-owned allowance labels and sections, including an unknown saved model', async () => {
    catalog = { groups: [{ provider: 'Nous', provider_id: 'nous', plan_usage: null,
      sections: [{ kind: 'recommended', model_ids: ['included'] }, { kind: 'other', model_ids: ['saved', 'free', 'large'] }],
      models: [
        { id: 'saved', label: 'Saved model', allowance: { state: 'unknown', usage_level: null, resets_at_ms: null } },
        { id: 'included', label: 'Included model', allowance: { state: 'included', usage_level: 'low', resets_at_ms: null } },
        { id: 'free', label: 'Free model', allowance: { state: 'free', usage_level: 'free', resets_at_ms: null } },
        { id: 'large', label: 'Large model', allowance: { state: 'blocked', usage_level: 'top_tier', resets_at_ms: null } },
      ],
    }] }
    renderChip({ model: 'saved', optionId: 'saved' })
    await userEvent.click(screen.getByRole('button'))
    const list = await screen.findByRole('listbox')
    // Section labels sit before their rows, in the server's order.
    expect(list.textContent).toMatch(/^Recommended.*Included model.*Other.*Saved model.*Free model.*Large model/)
    expect(optionNames()).toEqual(['Included model · Included', 'Saved model · Allowance unknown', 'Free model · Free', 'Large model · Large · Allowance exhausted'])
    expect(screen.getByRole('option', { name: 'Saved model · Allowance unknown' })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('lists Favorites then each provider on the rail; a provider tab filters the list and search spans them all (TAL-1858)', async () => {
    catalog = FAVORITES_CATALOG
    renderChip({ model: 'claude-opus-4.7', optionId: 'claude-opus-4.7' })
    await userEvent.click(screen.getByRole('button'))
    await picker()
    expect(within(rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Favorites', 'Anthropic', 'OpenRouter', 'Acme Cloud'])
    // Favorites exist, so the picker opens on them in the server's starred order, each row naming its provider.
    expect(within(rail()).getByRole('button', { name: 'Favorites' })).toHaveAttribute('aria-pressed', 'true')
    expect(optionNames()).toEqual(['Qwen3 · OpenRouter', 'Claude Haiku 4.5 · Anthropic'])

    await userEvent.click(within(rail()).getByRole('button', { name: 'Anthropic' }))
    expect(within(rail()).getByRole('button', { name: 'Anthropic' })).toHaveAttribute('aria-pressed', 'true')
    expect(optionNames()).toEqual(['Claude Opus 4.7', 'Claude Haiku 4.5'])
    expect(screen.getByRole('option', { name: 'Claude Opus 4.7' })).toHaveAttribute('aria-selected', 'true')

    await userEvent.type(screen.getByRole('combobox', { name: 'Search models…' }), 'qwen')
    expect(screen.queryByRole('toolbar', { name: 'Providers' })).toBeNull()
    // No catalog id is exactly the query, so a custom id is offered last.
    expect(optionNames()).toEqual(['Qwen3 · OpenRouter', 'Custom model ID: qwen'])
    await userEvent.clear(screen.getByRole('combobox'))
    expect(rail()).toBeVisible()
    expect(optionNames()).toEqual(['Claude Opus 4.7', 'Claude Haiku 4.5'])
  })

  it('stars at once in the row and Favorites without changing the selection; a refused write rolls back with its error (TAL-1858)', async () => {
    catalog = FAVORITES_CATALOG
    const onChange = vi.fn()
    let refuse!: (error: unknown) => void
    vi.mocked(setModelFavorite).mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject }))
    renderChip({ model: 'claude-opus-4.7', optionId: 'claude-opus-4.7' }, onChange)
    await userEvent.click(screen.getByRole('button'))
    await picker()
    await userEvent.click(within(rail()).getByRole('button', { name: 'Anthropic' }))
    const opus = screen.getByRole('option', { name: 'Claude Opus 4.7' })
    await userEvent.click(within(opus).getByRole('button', { name: 'Add to favorites' }))
    expect(setModelFavorite).toHaveBeenCalledWith({ provider_id: 'anthropic', model: 'claude-opus-4.7', favorite: true })
    // Shown before the server answers, and the picker stays open on the same selection.
    expect(within(opus).getByRole('button', { name: 'Remove from favorites' })).toHaveAttribute('data-model-favorite', 'true')
    expect(onChange).not.toHaveBeenCalled()
    expect(opus).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(within(rail()).getByRole('button', { name: 'Favorites' }))
    // A new star goes last, where the server puts it.
    expect(optionNames()).toEqual(['Qwen3 · OpenRouter', 'Claude Haiku 4.5 · Anthropic', 'Claude Opus 4.7 · Anthropic'])

    const refused = new ApiError({ kind: 'http', status: 400, path: '/api/models/favorite', message: 'At most 200 favorites' })
    await act(async () => { refuse(refused); await Promise.resolve() })
    await waitFor(() => { expect(optionNames()).toEqual(['Qwen3 · OpenRouter', 'Claude Haiku 4.5 · Anthropic']) })
    expect(showErrorToast).toHaveBeenCalledWith(refused)
    expect(onChange).not.toHaveBeenCalled()

    // Right-click offers the same star; an unstar the server confirms leaves Favorites and stays gone after the reread.
    vi.mocked(setModelFavorite).mockImplementationOnce(() => {
      catalog = { ...FAVORITES_CATALOG, favorite_option_ids: ['claude-haiku-4.5'], groups: FAVORITES_CATALOG.groups.map((g) => ({ ...g, models: g.models.map((e) => e.id === '@openrouter:qwen/qwen3' ? { ...e, favorite: false } : e) })) }
      return Promise.resolve({ ok: true as const, favorites: [{ provider_id: 'anthropic', model: 'claude-haiku-4.5' }] })
    })
    const reads = vi.mocked(fetchModels).mock.results.length
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByRole('option', { name: 'Qwen3 · OpenRouter' }) })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from favorites' }))
    expect(setModelFavorite).toHaveBeenLastCalledWith({ provider_id: 'openrouter', model: 'qwen/qwen3', favorite: false })
    expect(optionNames()).toEqual(['Claude Haiku 4.5 · Anthropic'])
    await waitFor(() => { expect(vi.mocked(fetchModels).mock.results.length).toBeGreaterThan(reads) })
    expect(optionNames()).toEqual(['Claude Haiku 4.5 · Anthropic'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('arrow keys, Enter and Escape work from search; rail items and stars are named (TAL-1858)', async () => {
    catalog = FAVORITES_CATALOG
    const onChange = vi.fn()
    renderChip({ model: 'claude-opus-4.7', optionId: 'claude-opus-4.7' }, onChange)
    const trigger = screen.getByRole('button')
    // A keyboard opening focuses search (TAL-1625).
    act(() => trigger.focus())
    await userEvent.keyboard('{Enter}')
    const search = await screen.findByRole('combobox', { name: 'Search models…' })
    await waitFor(() => expect(search).toHaveFocus())
    for (const button of within(rail()).getAllByRole('button')) expect(button).toHaveAccessibleName()
    for (const option of screen.getAllByRole('option')) expect(within(option).getByRole('button')).toHaveAccessibleName(/favorites/)
    await userEvent.keyboard('{ArrowDown}')
    const highlighted = () => screen.getAllByRole('option').find((el) => el.hasAttribute('data-highlighted'))?.getAttribute('aria-label')
    expect(highlighted()).toBe('Qwen3 · OpenRouter')
    await userEvent.keyboard('{ArrowDown}')
    expect(highlighted()).toBe('Claude Haiku 4.5 · Anthropic')
    expect(search).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('claude-haiku-4.5', 'anthropic')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(trigger)
    await screen.findByRole('combobox', { name: 'Search models…' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('draws the server\'s provider icon: an asset in its colours or the text colour, else the initials (TAL-1858)', async () => {
    catalog = FAVORITES_CATALOG
    renderChip({ model: '@anthropic:claude-opus-4.7', optionId: '@anthropic:claude-opus-4.7' })
    // The selected entry's id names Anthropic, but its provider is Acme Cloud, which has no icon.
    await waitFor(() => { expect(screen.getByRole('button')).toHaveTextContent('Acme Opus') })
    expect(screen.getByRole('button').querySelector('[data-provider-icon]')).toHaveAttribute('data-provider-icon', 'initials')
    expect(screen.getByRole('button')).toHaveTextContent(/^ACAcme Opus$/)
    await userEvent.click(screen.getByRole('button'))
    await picker()
    const railIcon = (name: string) => within(rail()).getByRole('button', { name }).querySelector('[data-provider-icon]')
    expect(railIcon('Anthropic')).toHaveAttribute('data-provider-icon', 'Anthropic')
    expect(railIcon('Anthropic')?.tagName).toBe('IMG')
    expect(railIcon('OpenRouter')).toHaveAttribute('data-provider-icon', 'OpenRouter')
    // A single-colour icon takes the text colour through a mask.
    expect((railIcon('OpenRouter') as HTMLElement).style.maskImage).toContain('static/brand/providers/OpenRouter.svg')
    expect(within(rail()).getByRole('button', { name: 'Acme Cloud' }).querySelector('[data-provider-icon]')).toHaveAttribute('data-provider-icon', 'initials')
  })

  // TAL-1625: a touch opening keeps the software keyboard down so the list stays visible; the footer chip and the
  // overflow panel's row share the policy.
  it.each([['footer chip', false], ['overflow row', true]])('a touch opening of the %s leaves search unfocused and the list in reach (TAL-1625)', async (_, row) => {
    catalog = COLON_CATALOG
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><ModelChip model={null} optionId={null} row={row} onChange={vi.fn()} /></QueryClientProvider>)
    const user = userEvent.setup()
    await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button') })
    const dialog = await picker()
    const search = screen.getByRole('combobox', { name: 'Search models…' })
    await screen.findAllByRole('option')
    expect(search).not.toHaveFocus()
    expect(dialog).toHaveFocus()
    expect(screen.getByRole('option', { name: 'Claude Opus 4.7' })).toBeVisible()
  })

  it('a touch opening with a hardware keyboard sends a printable key to search; touching search keeps focus through the refresh (TAL-1625)', async () => {
    catalog = COLON_CATALOG
    renderChip({ model: null, optionId: null })
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('M'))
    // The opening refresh is held so it resolves after the touch on search.
    let release!: () => void
    const refreshed = { ...COLON_CATALOG, groups: [...COLON_CATALOG.groups, { provider: 'Mistral', provider_id: 'mistral', models: [{ id: '@mistral:large', label: 'Mistral Large', provider_id: 'mistral', bare_id: 'large' }] }] }
    vi.mocked(fetchModels).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(refreshed) }))
    await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button') })
    const dialog = await picker()
    const search = screen.getByRole('combobox', { name: 'Search models…' })
    expect(dialog).toHaveFocus()
    await user.keyboard('o')
    expect(search).toHaveFocus()
    expect(search).toHaveValue('o')
    await user.clear(search)
    act(() => dialog.focus())
    await user.pointer({ keys: '[TouchA]', target: search })
    expect(search).toHaveFocus()
    await act(async () => { release(); await Promise.resolve() })
    expect(await within(rail()).findByRole('button', { name: 'Mistral' })).toBeVisible()
    expect(search).toHaveFocus()
    await user.click(within(rail()).getByRole('button', { name: 'Mistral' }))
    expect(await screen.findByRole('option', { name: 'Mistral Large' })).toBeVisible()
  })

  it('Escape after a touch opening closes only the picker inside a dialog and returns focus to the chip (TAL-1625)', async () => {
    catalog = COLON_CATALOG
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><Dialog open onOpenChange={vi.fn()} title="Settings"><ModelChip model={null} optionId={null} onChange={vi.fn()} /></Dialog></QueryClientProvider>)
    const user = userEvent.setup()
    const trigger = within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: /Conversation model/ })
    await user.pointer({ keys: '[TouchA]', target: trigger })
    await screen.findAllByRole('option')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Conversation model' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('pins search above the scrolling rows and keeps the selection through a refresh (TAL-1131)', async () => {
    catalog = COLON_CATALOG
    renderChip({ model: '@ollama:llama3:8b', optionId: '@ollama:llama3:8b' })
    const trigger = screen.getByRole('button')
    await userEvent.click(trigger)
    const search = await screen.findByRole('combobox', { name: 'Search models…' })
    // No favorites: the picker opens on the selected model's provider.
    expect(within(rail()).getByRole('button', { name: 'Ollama' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('listbox')).not.toContainElement(search)
    expect(search).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    catalog = { ...COLON_CATALOG, groups: [...COLON_CATALOG.groups, { provider: 'Mistral', provider_id: 'mistral', models: [{ id: '@mistral:large', label: 'Mistral Large', provider_id: 'mistral', bare_id: 'large' }] }] }
    await userEvent.click(trigger)
    await userEvent.click(await within(rail()).findByRole('button', { name: 'Mistral' }))
    expect(screen.getByRole('option', { name: 'Mistral Large' })).toHaveAttribute('aria-selected', 'false')
    await userEvent.click(within(rail()).getByRole('button', { name: 'Ollama' }))
    expect(screen.getByRole('option', { name: 'Llama3 (8B)' })).toHaveAttribute('aria-selected', 'true')
  })

  it('labels a fallback model group unavailable while keeping the configured model selected', async () => {
    catalog = { ...PLUGIN_CATALOG, default_model: 'gpt-6.1-sol', default_option_id: 'gpt-6.1-sol', groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', availability: { status: 'unavailable', authoritative: false, generation: 'test', unavailable_reason: 'Agent recovery is incomplete.' }, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', bare_id: 'gpt-6.1-sol', provider_id: 'openai-codex' }] }] }
    renderChip({ model: null, optionId: null })
    await userEvent.click(screen.getByRole('button'))
    await picker()
    expect(within(rail()).getByRole('button', { name: 'OpenAI Codex · Temporarily unavailable' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('[data-model-picker-group="openai-codex"]')).toHaveTextContent('OpenAI Codex · Temporarily unavailable')
    expect(screen.getByRole('option', { name: 'GPT-6.1 Sol' })).toHaveAttribute('aria-selected', 'true')
  })

  it('a plugin provider model keeps the plugin provider when another provider lists the same model', async () => {
    catalog = PLUGIN_CATALOG
    const onChange = vi.fn()
    renderChip({ model: null, optionId: null }, onChange)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(within(rail()).getByRole('button', { name: 'Fake Subscription' }))
    await userEvent.click(screen.getByRole('option', { name: 'Claude Sonnet 4.6' }))
    expect(onChange).toHaveBeenCalledWith('@fake-sub:claude-sonnet-4-6', 'fake-sub')
  })

  it('ticks exactly the entry the server says the stored model selects, colon-bearing ids included (TAL-301)', async () => {
    catalog = COLON_CATALOG
    const cases: [string | null, string | null, string, string][] = [
      ['llama3:8b', '@ollama:llama3:8b', 'Ollama', 'Llama3 (8B)'],
      ['m', '@custom:localhost:8080:m', 'Anthropic', 'M'],
      ['gemini-2.5-flash', '@gemini:gemini-2.5-flash', 'Gemini', 'Gemini 2.5 Flash'],
      ['gemini-2.5-flash', '@google:gemini-2.5-flash', 'Google', 'Gemini 2.5 Flash'],
      // No stored model: the catalog default.
      [null, null, 'Anthropic', 'M'],
    ]
    for (const [model, optionId, group, label] of cases) {
      const { unmount } = renderChip({ model, optionId })
      await userEvent.click(screen.getByRole('button'))
      await picker()
      // The picker opens on the selected entry's provider, where exactly that row is ticked.
      expect(within(rail()).getByRole('button', { name: group })).toHaveAttribute('aria-pressed', 'true')
      const checked = screen.getAllByRole('option').filter((el) => el.getAttribute('aria-selected') === 'true')
      expect(checked, `${String(model)} / ${String(optionId)}`).toHaveLength(1)
      expect(checked[0]).toHaveAccessibleName(label)
      unmount()
    }
  })

  it('lists, ticks and finds every model of a long provider list (TAL-1864)', async () => {
    const models = Array.from({ length: 40 }, (_, i) => ({ id: `vendor/model-${String(i + 1)}`, label: `Model ${String(i + 1)}`, provider_id: 'openrouter', bare_id: `vendor/model-${String(i + 1)}` }))
    catalog = { ...PLUGIN_CATALOG, default_model: 'vendor/model-30', default_option_id: 'vendor/model-30', groups: [{ provider: 'OpenRouter', provider_id: 'openrouter', models }] }
    renderChip({ model: 'vendor/model-30', optionId: 'vendor/model-30' })
    await userEvent.click(screen.getByRole('button'))
    // The list is virtualized: the deep selection is rendered and ticked on open, and search reaches both ends.
    expect(await screen.findByRole('option', { name: 'Model 30' })).toHaveAttribute('aria-selected', 'true')
    const search = screen.getByRole('combobox')
    await userEvent.type(search, 'model 1')
    expect(optionNames()).toEqual([1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((n) => `Model ${String(n)} · OpenRouter`).concat('Custom model ID: model 1'))
    await userEvent.clear(search)
    await userEvent.type(search, 'model 40')
    expect(optionNames()).toEqual(['Model 40 · OpenRouter', 'Custom model ID: model 40'])
  })

  it('a stored model the server pairs with no entry ticks nothing and keeps its own name (TAL-301)', async () => {
    catalog = COLON_CATALOG
    renderChip({ model: 'qwen3:32b', optionId: null })
    expect(await screen.findByRole('button', { name: /qwen3:32b/ })).toBeVisible()
    await userEvent.click(screen.getByRole('button'))
    expect((await screen.findAllByRole('option')).filter((el) => el.getAttribute('aria-selected') === 'true')).toHaveLength(0)
  })

  it('offers a custom id when search matches no catalog id, and sends it without a provider', async () => {
    catalog = COLON_CATALOG
    const onChange = vi.fn()
    renderChip({ model: null, optionId: null }, onChange)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.type(await screen.findByRole('combobox'), 'vendor/new-model')
    expect(optionNames()).toEqual(['Custom model ID: vendor/new-model'])
    await userEvent.click(screen.getByRole('option', { name: 'Custom model ID: vendor/new-model' }))
    expect(onChange).toHaveBeenCalledWith('vendor/new-model', null)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('sends the picked id with its own provider (TAL-301)', async () => {
    catalog = COLON_CATALOG
    const onChange = vi.fn()
    renderChip({ model: 'claude-opus-4.7', optionId: 'claude-opus-4.7' }, onChange)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(await screen.findByRole('option', { name: 'M' }))
    expect(onChange).toHaveBeenCalledWith('@custom:localhost:8080:m', 'custom:localhost:8080')
  })

  it('shows the server\'s account limit, per-model cooldown and quota level with local reset times (TAL-807)', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60_000)
    const time = resetsAt.toLocaleString('en', resetsAt.toDateString() === new Date().toDateString() ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    const iso = resetsAt.toISOString()
    catalog = { ...COLON_CATALOG, groups: [
      { ...COLON_CATALOG.groups[0]!, limit: { scope: 'models', models: { 'claude-opus-4.7': iso } }, quota_level: 'warning', models: [{ ...COLON_CATALOG.groups[0]!.models[0]!, limit: { scope: 'model', resets_at: iso } }, COLON_CATALOG.groups[0]!.models[1]!] },
      { ...COLON_CATALOG.groups[1]!, limit: { scope: 'account', resets_at: iso } },
      { ...COLON_CATALOG.groups[2]!, quota_level: 'critical' },
      { ...COLON_CATALOG.groups[3]!, quota_level: 'healthy' },
    ] }
    renderChip({ model: null, optionId: null })
    await waitFor(() => { expect(screen.getByRole('button')).toHaveTextContent('M') })
    const reads = vi.mocked(fetchModels).mock.calls.length
    await userEvent.click(screen.getByRole('button'))
    // Opening the picker reads the catalog again, so the limits shown are the server's current ones.
    await waitFor(() => { expect(vi.mocked(fetchModels).mock.calls.length).toBe(reads + 1) })
    const header = (id: string) => document.querySelector(`[data-model-picker-group="${id}"]`)
    await waitFor(() => { expect(header('anthropic')).toHaveTextContent('Low quota') })
    expect(screen.getByRole('option', { name: `Claude Opus 4.7 · Limited until ${time}` })).toHaveTextContent(`Limited until ${time}`)
    expect(screen.getByRole('option', { name: 'M' })).not.toHaveTextContent('Limited')
    await userEvent.click(within(rail()).getByRole('button', { name: 'Gemini' }))
    expect(header('gemini')).toHaveTextContent(`Limited until ${time}`)
    await userEvent.click(within(rail()).getByRole('button', { name: 'Google' }))
    expect(header('google')).toHaveTextContent('Quota nearly out')
    // A healthy level shows nothing.
    await userEvent.click(within(rail()).getByRole('button', { name: 'Ollama' }))
    expect(header('ollama')).not.toHaveTextContent(/quota|Limited/i)
    // Search mixes providers and has no header, so each row carries its group's limit beside the provider.
    await userEvent.type(screen.getByRole('combobox'), 'gemini 2.5')
    const gemini = screen.getByRole('option', { name: `Gemini 2.5 Flash · Gemini · Limited until ${time}` })
    expect(gemini.querySelector('[data-model-limit="account"]')).toHaveTextContent(`Limited until ${time}`)
    expect(screen.getByRole('option', { name: 'Gemini 2.5 Flash · Google · Quota nearly out' })).toHaveTextContent('Quota nearly out')
  })
})

describe('ToolsetsChip (TAL-2096)', () => {
  const renderToolsets = (value: string[] | null, onChange = vi.fn()) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(<QueryClientProvider client={qc}><ToolsetsChip value={value} onChange={onChange} /></QueryClientProvider>)
    return { onChange, rerender: (next: string[] | null) => view.rerender(<QueryClientProvider client={qc}><ToolsetsChip value={next} onChange={onChange} /></QueryClientProvider>) }
  }
  const row = (name: RegExp | string) => screen.findByRole('menuitemcheckbox', { name })
  // A later catalog read never answers, so what the rows show then is the choice itself, not the server's reply.
  const holdLaterReads = () => { vi.mocked(fetchToolsetsCatalog).mockReturnValue(new Promise(() => undefined)) }
  afterEach(() => { vi.mocked(fetchToolsetsCatalog).mockImplementation((choice) => Promise.resolve(toolsetsCatalog(choice))) })

  it('applies a toggle at once, keeps the menu open and names the choice on the chip', async () => {
    const { onChange, rerender } = renderToolsets(null)
    await userEvent.click(screen.getByRole('button', { name: 'Session toolsets: Profile defaults' }))
    expect(await row('Use profile defaults')).toHaveAttribute('aria-checked', 'true')
    expect(await row(/^file/)).toHaveAttribute('aria-checked', 'true')
    expect(document.querySelector('input[type=checkbox], form')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    holdLaterReads()
    await userEvent.click(await row(/^web/))
    expect(onChange).toHaveBeenCalledWith(['file', 'web'])
    rerender(['file', 'web'])
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(await row(/^web/)).toHaveAttribute('aria-checked', 'true')
    expect(await row('Use profile defaults')).toHaveAttribute('aria-checked', 'false')
    const chip = screen.getByRole('button', { name: 'Session toolsets: 2 toolsets' })
    expect(chip).toHaveAttribute('title', 'Session toolsets: file, web')
    rerender(['web'])
    expect(screen.getByRole('button', { name: 'Session toolsets: web' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Global')
  })

  it('shows the previous selection again when its owner restores it after a refused save', async () => {
    const { onChange, rerender } = renderToolsets(['file', 'web'])
    await userEvent.click(screen.getByRole('button'))
    const web = await row(/^web/)
    holdLaterReads()
    await userEvent.click(web)
    expect(onChange).toHaveBeenCalledWith(['file'])
    rerender(['file'])
    expect(await row(/^web/)).toHaveAttribute('aria-checked', 'false')
    // The session write is refused: the owner restores the confirmed value with its error.
    rerender(['file', 'web'])
    expect(await row(/^web/)).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Session toolsets: 2 toolsets' })).toBeInTheDocument()
  })

  it('keeps the last selected toolset and sends null for the profile defaults', async () => {
    const { onChange } = renderToolsets(['web'])
    await userEvent.click(screen.getByRole('button'))
    expect(await row(/^web/)).toHaveAttribute('aria-disabled', 'true')
    expect(await row(/^file/)).not.toHaveAttribute('aria-disabled', 'true')
    expect(await row('Use profile defaults')).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(await row('Use profile defaults'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('lists available toolsets first and the rest under Not available, each group in server order', async () => {
    renderToolsets(null)
    await userEvent.click(screen.getByRole('button'))
    await row(/^file/)
    expect(screen.getAllByRole('menuitemcheckbox').map((item) => item.textContent)).toEqual([
      'Use profile defaults', 'fileRead and write files', 'webSearch the web', 'terminalRun commands',
      'todoTask listsDisabled by operator', 'browserDrive a browserUnavailable',
    ])
    const unavailable = within(screen.getByRole('group', { name: 'Not available' })).getAllByRole('menuitemcheckbox')
    expect(unavailable.map((item) => item.getAttribute('aria-disabled'))).toEqual(['true', 'true'])
  })

  it('filters by name and description from its search field, which hands ArrowDown and Escape to the menu', async () => {
    renderToolsets(null)
    await userEvent.click(screen.getByRole('button'))
    await row(/^file/)
    const search = screen.getByRole('searchbox', { name: 'Search toolsets' })
    await userEvent.type(search, 'COMMANDS')
    expect(screen.getAllByRole('menuitemcheckbox').map((item) => item.textContent)).toEqual(['Use profile defaults', 'terminalRun commands'])
    await userEvent.clear(search)
    await userEvent.type(search, 'tod')
    expect(within(screen.getByRole('group', { name: 'Not available' })).getByRole('menuitemcheckbox')).toHaveTextContent(/^todo/)
    await userEvent.type(search, 'x')
    expect(screen.getByText('No toolsets found')).toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.keyboard('{ArrowDown}')
    expect(await row('Use profile defaults')).toHaveFocus()
    await userEvent.click(search)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('menu')).not.toBeInTheDocument() })
  })
})

describe('WorkspaceChip (TAL-303)', () => {
  const chip = async (props: { value: string; name?: string | null }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><WorkspaceChip {...props} onChange={vi.fn()} /></QueryClientProvider>)
    // The chip enables once the registry has loaded.
    await waitFor(() => { expect(screen.getByRole('button')).toBeEnabled() })
    return screen.getByRole('button')
  }

  it('shows the session\'s server-resolved name, never one taken from the path', async () => {
    expect(await chip({ value: '/src/elsewhere/repo', name: 'Repo' })).toHaveTextContent('Repo')
    cleanup()
    // An older server sends no name: the chip shows nothing rather than the folder.
    expect(await chip({ value: '/src/elsewhere/repo', name: null })).toHaveTextContent('—')
  })

  it('shows the chosen registry entry\'s name before a session exists', async () => {
    expect(await chip({ value: '/src/talaria-main' })).toHaveTextContent('Talaria')
    cleanup()
    expect(await chip({ value: '/src/unlisted' })).toHaveTextContent('—')
  })
})

it('does not offer saves when the toolset catalog fails', async () => {
  const api = await import('../../api/endpoints')
  vi.mocked(api.fetchToolsetsCatalog).mockRejectedValueOnce(new Error('offline'))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ToolsetsChip value={null} onChange={vi.fn()} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load toolsets.')
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('menuitemcheckbox', { name: /^file/ })).toBeInTheDocument()
})

describe('ExecutionModeChip (TAL-1040)', () => {
  const renderMode = (props: Parameters<typeof ExecutionModeChip>[0]) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><ExecutionModeChip {...props} /></QueryClientProvider>)
  }

  it('picks a mode the server offers for the fresh chat', async () => {
    const onChange = vi.fn()
    renderMode({ value: 'normal', onChange })
    await userEvent.click(screen.getByRole('button', { name: 'Agent mode: Normal' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Safe mode' }))
    expect(onChange).toHaveBeenCalledWith('safe')
  })

  it('names the menu in its first label and marks only the chosen mode with a check (TAL-2095)', async () => {
    renderMode({ value: 'normal', onChange: vi.fn() })
    await userEvent.click(screen.getByRole('button'))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('group', { name: 'Agent mode' }).firstElementChild).toHaveTextContent('Agent mode')
    const chosen = await within(menu).findByRole('menuitemradio', { name: 'Normal' })
    expect(chosen).toHaveAttribute('aria-checked', 'true')
    expect(chosen.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(within(menu).getByRole('menuitemradio', { name: 'Safe mode' }).querySelector('svg')).toBeNull()
  })

  it('shows the server reason and refuses a mode the owner cannot start', async () => {
    modes = { modes: [{ mode: 'normal', available: true, reason: null }, { mode: 'ignore_config', available: false, reason: 'agent_unsupported' }, { mode: 'safe', available: false, reason: 'agent_unsupported' }] }
    const onChange = vi.fn()
    renderMode({ value: 'normal', onChange })
    await userEvent.click(screen.getByRole('button'))
    const safe = await screen.findByRole('menuitemradio', { name: /Safe mode/ })
    expect(safe).toHaveAttribute('aria-disabled', 'true')
    expect(safe).toHaveTextContent('Not supported by this Agent')
    await userEvent.click(safe)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows the frozen mode of a started chat without a picker', () => {
    renderMode({ value: 'ignore_config' })
    expect(screen.getByLabelText('Agent mode: Ignore profile config')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
