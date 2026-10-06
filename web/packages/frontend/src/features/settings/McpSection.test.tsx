import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// A stateful stand-in for the server: the PATCH flips config, and the next GET reports the server's new status.
const enabled: Record<string, boolean> = { github: true }
const TOOLS = [{ name: 'create_issue', server: 'github', description: 'Open an issue', status: 'active' }, { name: 'list_pulls', server: 'github', description: 'List pull requests', status: 'active' }]
vi.mock('../../api/endpoints', () => ({
  fetchMcpServers: vi.fn(() => Promise.resolve({ toggle_supported: true, reload_required: true, servers: Object.entries(enabled).map(([name, on]) => ({ name, transport: 'stdio', enabled: on, status: on ? 'active' : 'disabled', health: on ? 'unhealthy' : 'not_checked', tool_count: on ? 2 : null })) })),
  fetchMcpTools: vi.fn((q: string) => Promise.resolve({ tools: TOOLS.filter((t) => !q || t.name.includes(q)), total: TOOLS.length })),
  toggleMcpServer: vi.fn((name: string, on: boolean) => { enabled[name] = on; return Promise.resolve({ ok: true, name, enabled: on }) }),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { McpSection } from './McpSection'

function renderMcp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><McpSection heading="" /></QueryClientProvider>)
}

describe('McpSection', () => {
  it('toggling a server PATCHes it and shows the status the server reports next', async () => {
    renderMcp()
    const toggle = await screen.findByRole('switch', { name: 'github: Enabled' })
    const row = toggle.closest('li')!
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).getByText('Unreachable')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(api.toggleMcpServer).toHaveBeenCalledWith('github', false)
    await waitFor(() => expect(within(row).getByText('Disabled')).toBeInTheDocument())
    expect(within(row).queryByText('Active')).not.toBeInTheDocument()
    expect(within(row).queryByText('Unreachable')).not.toBeInTheDocument()
    expect(within(row).getByRole('switch', { name: 'github: Disabled' })).not.toBeChecked()
  })

  it('search asks the server for matching tools and renders only its answer', async () => {
    renderMcp()
    const list = await screen.findByRole('list', { name: 'MCP Tools' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    await userEvent.type(screen.getByRole('searchbox'), 'pulls')
    await waitFor(() => expect(api.fetchMcpTools).toHaveBeenLastCalledWith('pulls'))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'MCP Tools' })).getAllByRole('listitem')).toHaveLength(1))
    expect(screen.getByText('list_pulls')).toBeInTheDocument()
    await userEvent.clear(screen.getByRole('searchbox'))
    await userEvent.type(screen.getByRole('searchbox'), 'zzz')
    expect(await screen.findByText('No MCP tools match your search.')).toBeInTheDocument()
  })
})
