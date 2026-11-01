import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { McpCostPolicySchema, type McpEventsSchema } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// A stateful stand-in for the server: the PATCH flips config, and the next GET reports the server's new status.
const enabled: Record<string, boolean> = { github: true }
const TOOLS = [{ name: 'create_issue', server: 'github', description: 'Open an issue', status: 'active' }, { name: 'list_pulls', server: 'github', description: 'List pull requests', status: 'active' }]
vi.mock('../../api/endpoints', () => ({
  saveMcpCostPolicy: vi.fn(),
  saveMcpEvents: vi.fn(),
  fetchMcpServers: vi.fn(() => Promise.resolve({ toggle_supported: true, reload_required: true, servers: Object.entries(enabled).map(([name, on]) => ({ name, transport: 'stdio', enabled: on, status: on ? 'active' : 'disabled', can_toggle: true, health: on ? 'unhealthy' : 'not_checked', tool_count: on ? 2 : null })) })),
  fetchMcpTools: vi.fn((q: string) => Promise.resolve({ tools: TOOLS.filter((t) => !q || t.name.includes(q)), total: TOOLS.length })),
  toggleMcpServer: vi.fn((name: string, on: boolean) => { enabled[name] = on; return Promise.resolve({ ok: true, name, enabled: on }) }),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { applyLocale } from '../../i18n/runtime'
import { showToast } from '../toast/toast'
import { McpSection } from './McpSection'

function renderMcp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><McpSection heading="" /></QueryClientProvider>)
}

describe('McpSection', () => {
  afterEach(async () => { await applyLocale('en', { persist: false }) })

  it('renders server status, tool count, tool list and toggle toast in German (TAL-1607)', async () => {
    enabled.github = true
    await applyLocale('de', { persist: false })
    renderMcp()
    const toggle = await screen.findByRole('switch', { name: 'github' })
    const row = toggle.closest('li')!
    expect(within(row).getByText('Aktiv')).toBeInTheDocument()
    expect(within(row).getByText('2 Tools')).toBeInTheDocument()
    expect(await screen.findByRole('list', { name: 'MCP-Tools' })).toBeInTheDocument()
    await userEvent.click(toggle)
    await waitFor(() => expect(within(row).getByText('Deaktiviert')).toBeInTheDocument())
    expect(showToast).toHaveBeenLastCalledWith('MCP-Server «github» deaktiviert.')
    enabled.github = true
  })

  it('toggling a server PATCHes it and shows the status the server reports next', async () => {
    renderMcp()
    const toggle = await screen.findByRole('switch', { name: 'github' })
    const row = toggle.closest('li')!
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).getByText('Unreachable')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(api.toggleMcpServer).toHaveBeenCalledWith('github', false)
    await waitFor(() => expect(within(row).getByText('Disabled')).toBeInTheDocument())
    expect(within(row).queryByText('Active')).not.toBeInTheDocument()
    expect(within(row).queryByText('Unreachable')).not.toBeInTheDocument()
    expect(within(row).getByRole('switch', { name: 'github' })).not.toBeChecked()
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
  it('shows package provenance and rolls a refused optimistic policy edit back', async () => {
    const policy = McpCostPolicySchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/mcp-cost-policy.json'), 'utf8')))
    const original = vi.mocked(api.fetchMcpServers).getMockImplementation()!
    vi.mocked(api.fetchMcpServers).mockResolvedValue({ servers: [{ name: 'paid', cost_policy: policy }] })
    let reject: (error: Error) => void = () => undefined
    vi.mocked(api.saveMcpCostPolicy).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    try {
      renderMcp()
      await userEvent.click(await screen.findByText('Cost policy'))
      expect(screen.getByText('Native override')).toBeInTheDocument()
      expect(screen.getByText('Portable package')).toBeInTheDocument()
      expect(screen.getByText('credits · Portable package')).toBeInTheDocument()
      const input = screen.getByRole('textbox', { name: 'Per-chat limit' })
      await userEvent.clear(input)
      await userEvent.type(input, '7')
      await userEvent.click(screen.getByRole('button', { name: 'Save policy' }))
      expect(input).toHaveValue('7')
      expect(api.saveMcpCostPolicy).toHaveBeenCalledWith('paid', policy.revision, { spend_limit: 7 })
      reject(new Error('refused'))
      await waitFor(() => expect(input).toHaveValue('0'))
    } finally { vi.mocked(api.fetchMcpServers).mockImplementation(original) }
  })

  it('shows native event states and rolls a refused optimistic opt-in back (TAL-1510)', async () => {
    const cases = Object.fromEntries((JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/mcp-events.json'), 'utf8')) as { cases: { name: string; expected: z.infer<typeof McpEventsSchema> }[] }).cases.map((c) => [c.name, c.expected]))
    const original = vi.mocked(api.fetchMcpServers).getMockImplementation()!
    let pushEvents = cases.opt_out!
    vi.mocked(api.fetchMcpServers).mockImplementation(() => Promise.resolve({ servers: [
      { name: 'pending', events: cases.opt_in_without_public_url },
      { name: 'hooks', events: pushEvents },
      { name: 'legacy', events: cases.older_agent },
    ] }))
    let settle: { resolve: () => void; reject: (error: Error) => void } = { resolve: () => undefined, reject: () => undefined }
    vi.mocked(api.saveMcpEvents).mockImplementation(() => new Promise((done, fail) => { settle = { resolve: () => done({ ok: true, server: { name: 'hooks' } }), reject: fail } }))
    try {
      renderMcp()
      const pendingRow = (await screen.findByText('pending')).closest('li')!
      expect(within(pendingRow).getByText('Needs HTTPS public URL')).toBeInTheDocument()
      const legacyRow = screen.getByText('legacy').closest('li')!
      expect(within(legacyRow).queryByText('Events')).not.toBeInTheDocument()
      const hooksRow = screen.getByText('hooks').closest('li')!
      expect(within(hooksRow).queryByText('Off')).not.toBeInTheDocument()
      await userEvent.click(within(hooksRow).getByText('Events'))
      const toggle = within(hooksRow).getByRole('switch', { name: 'Experimental events for hooks' })
      expect(toggle).not.toBeChecked()
      await userEvent.click(toggle)
      expect(toggle).toBeChecked()
      expect(api.saveMcpEvents).toHaveBeenLastCalledWith('hooks', true)
      settle.reject(new Error('refused'))
      await waitFor(() => expect(toggle).not.toBeChecked())
      expect(showToast).toHaveBeenLastCalledWith("Couldn't change MCP events.", 5000, 'error')

      await userEvent.click(toggle)
      expect(toggle).toBeChecked()
      pushEvents = cases.connected_subscription!
      settle.resolve()
      await waitFor(() => expect(within(hooksRow).getByText('Subscribed')).toBeInTheDocument())
      expect(within(hooksRow).getByText('1 active · 1 paused')).toBeInTheDocument()
      expect(toggle).toBeChecked()
    } finally { vi.mocked(api.fetchMcpServers).mockImplementation(original) }
  })
})
