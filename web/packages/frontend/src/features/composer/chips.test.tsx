import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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

// The server's registry: every entry named, the default one `Home` (TAL-303).
const WORKSPACES = { workspaces: [{ path: '/src/talaria-main', name: 'Talaria' }, { path: '/src/scratch', name: 'scratch' }], last: '/src/talaria-main' }

vi.mock('../../api/endpoints', () => ({ fetchModels: vi.fn(() => Promise.resolve(CATALOG)), fetchWorkspaces: vi.fn(() => Promise.resolve(WORKSPACES)) }))
import { ModelChip, ToolsetsChip, WorkspaceChip } from './chips'

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
