import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
let catalog: unknown = PLUGIN_CATALOG

// The server's registry: every entry named, the default one `Home` (TAL-303).
const WORKSPACES = { workspaces: [{ path: '/src/talaria-main', name: 'Talaria' }, { path: '/src/scratch', name: 'scratch' }], last: '/src/talaria-main' }

vi.mock('../../api/endpoints', () => ({ fetchToolsetsCatalog: vi.fn(() => Promise.resolve({ toolsets: [{ name: 'file', description: 'Files', available: true, selected: true, unavailable_reason: null }, { name: 'todo', description: 'Tasks', available: false, selected: false, unavailable_reason: 'disabled' }], selected_toolsets: ['file'], using_defaults: true })), fetchModels: vi.fn(() => Promise.resolve(catalog)), fetchWorkspaces: vi.fn(() => Promise.resolve(WORKSPACES)) }))
import { ModelChip, ToolsetsChip, WorkspaceChip } from './chips'
import { fetchModels } from '../../api/endpoints'

function renderChip(props: { model: string | null; optionId: string | null }, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ModelChip {...props} onChange={onChange} /></QueryClientProvider>)
}

describe('ModelChip', () => {
  it('labels a fallback model group unavailable while keeping the configured model selected', async () => {
    catalog = { ...PLUGIN_CATALOG, default_model: 'gpt-6.1-sol', default_option_id: 'gpt-6.1-sol', groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', availability: { status: 'unavailable', authoritative: false, generation: 'test', unavailable_reason: 'Agent recovery is incomplete.' }, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', bare_id: 'gpt-6.1-sol', provider_id: 'openai-codex' }] }] }
    renderChip({ model: null, optionId: null })
    await userEvent.click(screen.getByRole('button'))
    const group = await screen.findByRole('group', { name: 'OpenAI Codex · Temporarily unavailable' })
    expect(within(group).getByRole('menuitemradio', { name: 'GPT-6.1 Sol' })).toHaveAttribute('aria-checked', 'true')
  })

  it('a plugin provider model keeps the plugin provider when another provider lists the same model', async () => {
    catalog = PLUGIN_CATALOG
    const onChange = vi.fn()
    renderChip({ model: null, optionId: null }, onChange)
    await userEvent.click(screen.getByRole('button'))
    const group = await screen.findByRole('group', { name: 'Fake Subscription' })
    await userEvent.click(within(group).getByRole('menuitemradio', { name: 'Claude Sonnet 4.6' }))
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
      const checked = (await screen.findAllByRole('menuitemradio')).filter((el) => el.getAttribute('aria-checked') === 'true')
      expect(checked, `${String(model)} / ${String(optionId)}`).toHaveLength(1)
      expect(within(screen.getByRole('group', { name: group })).getByRole('menuitemradio', { name: label })).toBe(checked[0])
      unmount()
    }
  })

  it('a stored model the server pairs with no entry ticks nothing and keeps its own name (TAL-301)', async () => {
    catalog = COLON_CATALOG
    renderChip({ model: 'qwen3:32b', optionId: null })
    expect(await screen.findByRole('button', { name: /qwen3:32b/ })).toBeVisible()
    await userEvent.click(screen.getByRole('button'))
    expect((await screen.findAllByRole('menuitemradio')).filter((el) => el.getAttribute('aria-checked') === 'true')).toHaveLength(0)
  })

  it('sends the picked id with its own provider (TAL-301)', async () => {
    catalog = COLON_CATALOG
    const onChange = vi.fn()
    renderChip({ model: 'claude-opus-4.7', optionId: 'claude-opus-4.7' }, onChange)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(within(await screen.findByRole('group', { name: 'Anthropic' })).getByRole('menuitemradio', { name: 'M' }))
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
    const anthropic = await screen.findByRole('group', { name: /^Anthropic/ })
    expect(within(anthropic).getByRole('menuitemradio', { name: /Claude Opus 4\.7/ })).toHaveTextContent(`Limited until ${time}`)
    expect(within(anthropic).getByRole('menuitemradio', { name: 'M' })).not.toHaveTextContent('Limited')
    expect(anthropic).toHaveTextContent('Low quota')
    expect(screen.getByRole('group', { name: /^Gemini/ })).toHaveTextContent(`Limited until ${time}`)
    expect(screen.getByRole('group', { name: /^Google/ })).toHaveTextContent('Quota nearly out')
    // A healthy level shows nothing.
    expect(screen.getByRole('group', { name: 'Ollama' })).not.toHaveTextContent(/quota|Limited/i)
  })
})

describe('ToolsetsChip', () => {
  it('renders server selection and refuses unavailable choices', async () => {
    const onChange = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={qc}><ToolsetsChip value={null} onChange={onChange} /></QueryClientProvider>)
    await userEvent.click(screen.getByRole('button'))
    expect(await screen.findByRole('checkbox', { name: 'file' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /todo/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Use profile defaults' }))
    expect(onChange).toHaveBeenCalledWith(null)
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
  expect(await screen.findByRole('checkbox', { name: 'file' })).toBeEnabled()
})
