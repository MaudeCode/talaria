import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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

vi.mock('../../api/endpoints', () => ({ fetchModels: vi.fn(() => Promise.resolve(catalog)) }))
import { ModelChip, ToolsetsChip } from './chips'

function renderChip(props: { model: string | null; optionId: string | null }, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ModelChip {...props} onChange={onChange} /></QueryClientProvider>)
}

describe('ModelChip', () => {
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
})

describe('ToolsetsChip', () => {
  it('keeps the toolsets explanation behind a help button', async () => {
    render(<ToolsetsChip value={null} onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('button'))
    await screen.findByRole('textbox', { name: 'Session toolsets' })
    expect(screen.queryByText(/Comma-separated toolset names/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Session toolsets' }))
    expect(await screen.findByText(/Comma-separated toolset names/)).toBeVisible()
  })
})
