import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'

const renders = vi.hoisted(() => ({ workspace: vi.fn(), provider: vi.fn(), passkey: vi.fn(), skill: vi.fn(), server: vi.fn(), tool: vi.fn() }))
// Count one existing piece of output per real row, without replacing the rows or their controls.
vi.mock('../../paraglide/messages.js', async (original) => {
  const actual = await original<typeof import('../../paraglide/messages.js')>()
  return { ...actual, m: { ...actual.m,
    workspace_move_up: (...args: Parameters<typeof actual.m.workspace_move_up>) => { renders.workspace(); return actual.m.workspace_move_up(...args) },
    providers_configured: (...args: Parameters<typeof actual.m.providers_configured>) => { renders.provider(); return actual.m.providers_configured(...args) },
    delete: (...args: Parameters<typeof actual.m.delete>) => { renders.passkey(); return actual.m.delete(...args) },
    skill_uses: (...args: Parameters<typeof actual.m.skill_uses>) => { renders.skill(args[0].n); return actual.m.skill_uses(...args) },
    mcp_tool_count: (...args: Parameters<typeof actual.m.mcp_tool_count>) => { renders.server(); return actual.m.mcp_tool_count(...args) },
    mcp_status_active: (...args: Parameters<typeof actual.m.mcp_status_active>) => { renders.tool(); return actual.m.mcp_status_active(...args) },
  } }
})
vi.mock('../../api/client', async (original) => ({ ...await original<typeof import('../../api/client')>(), post: vi.fn() }))
vi.mock('../../app/bootstrap', async (original) => ({ ...await original<typeof import('../../app/bootstrap')>(), loadBootstrap: vi.fn() }))
const skills = ['abcdefghij one', 'abcdefghij two', 'zebra'].map((name) => ({ name, description: name, category: 'test' }))
const tools = skills.map((s) => ({ name: s.name, server: 'test', status: 'active' }))
vi.mock('../../api/endpoints', async (original) => ({
  ...await original<typeof import('../../api/endpoints')>(),
  fetchWorkspaces: vi.fn(() => Promise.resolve({ workspaces: [{ path: '/test/one', name: 'One' }, { path: '/test/two', name: 'Two' }], last: null })),
  fetchProviders: vi.fn(() => Promise.resolve({ providers: [{ id: 'one', has_key: true }, { id: 'two', has_key: true }, { id: 'local', has_key: true, is_self_hosted: true, base_url: '' }] })),
  fetchProviderQuotas: vi.fn(() => Promise.resolve({ sources: [] })),
  saveSettings: vi.fn(),
  fetchSkillContent: vi.fn(() => Promise.resolve({ content: 'Skill content', editable: false })),
  fetchSettings: vi.fn(() => Promise.resolve({ password_auth_enabled: true, default_model: '' })),
  fetchSystemHealth: vi.fn(() => Promise.resolve({ status: 'ok' })),
  fetchAgentHealth: vi.fn(() => Promise.resolve({ alive: true })),
  fetchUpdatesCheck: vi.fn(() => Promise.resolve({})),
  passkeysList: vi.fn(() => Promise.resolve({ credentials: [{ id: 'one', label: 'Laptop' }, { id: 'two', label: 'Phone' }] })),
  fetchSkills: vi.fn(() => Promise.resolve({ skills })),
  fetchSkillsUsage: vi.fn(() => Promise.resolve({ usage: Object.fromEntries(skills.map((s, i) => [s.name, { use_count: i + 1 }])) })),
  fetchMcpServers: vi.fn(() => Promise.resolve({ toggle_supported: true, servers: [{ name: 'test', status: 'configured', enabled: true, can_toggle: true, tool_count: 3 }] })),
  fetchMcpTools: vi.fn((q: string) => Promise.resolve({ tools: tools.filter((t) => t.name.includes(q)), total: 3 })),
}))
import * as api from '../../api/endpoints'
import { post } from '../../api/client'
import { ApiError } from '../../contracts/common'
import { WorkspacesPage } from '../workspaces/WorkspacesPage'
import { ProvidersSection } from './ProvidersSection'
import { SystemSection } from './SystemSection'
import { SkillsPage } from '../skills/SkillsPage'
import { McpSection } from './McpSection'

const clients: QueryClient[] = []
function mount(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(qc)
  const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: true, passkey_feature_flag: true } }
  return render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}>{children}</BootstrapContext.Provider></QueryClientProvider>)
}
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { for (const qc of clients.splice(0)) qc.clear(); vi.useRealTimers() })
const reset = (counter: typeof renders.workspace) => { expect(counter).toHaveBeenCalled(); counter.mockClear() }

describe('input render isolation (TAL-1405)', () => {
  it('typing ten rename characters renders no workspace rows', async () => {
    mount(<WorkspacesPage />)
    const row = (await screen.findByText('One')).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    reset(renders.workspace)
    await userEvent.type(input, 'abcdefghij')
    expect(input).toHaveValue('Oneabcdefghij')
    expect(renders.workspace).not.toHaveBeenCalled()
  })

  it.each(['key', 'self-hosted'] as const)('typing ten %s characters renders no provider rows', async (kind) => {
    mount(<ProvidersSection />)
    await screen.findByText('one')
    const row = document.querySelector(`[data-provider="${kind === 'key' ? 'one' : 'local'}"]`)!
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: kind === 'key' ? 'Set key' : 'Set up' }))
    const input = kind === 'key' ? screen.getByLabelText('one API key') : screen.getByLabelText('Base URL')
    reset(renders.provider)
    await userEvent.type(input, 'abcdefghij')
    expect(input).toHaveValue('abcdefghij')
    expect(renders.provider).not.toHaveBeenCalled()
  })

  it('typing ten characters in each password renders no passkey rows', async () => {
    mount(<SystemSection />)
    await screen.findByText('Laptop')
    reset(renders.passkey)
    for (const label of ['Enter current password…', 'Access Password']) {
      const input = screen.getByLabelText(label)
      await userEvent.type(input, 'abcdefghij')
      expect(input).toHaveValue('abcdefghij')
    }
    expect(renders.passkey).not.toHaveBeenCalled()
  })

  it('submits the isolated key draft and discards it when the form is reopened', async () => {
    vi.mocked(post).mockResolvedValue({ ok: true })
    mount(<ProvidersSection />)
    await screen.findByText('one')
    const row = document.querySelector<HTMLElement>('[data-provider="one"]')!
    await userEvent.click(within(row).getByRole('button', { name: 'Set key' }))
    await userEvent.type(screen.getByLabelText('one API key'), ' synthetic-key ')
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('api/providers', { provider: 'one', api_key: 'synthetic-key' }, expect.anything(), { retries: 0 }))
    await waitFor(() => expect(screen.queryByLabelText('one API key')).toBeNull())
    await userEvent.click(within(row).getByRole('button', { name: 'Set key' }))
    expect(screen.getByLabelText('one API key')).toHaveValue('')
  })

  it('keeps both password drafts on refusal and submits them on retry', async () => {
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new ApiError({ kind: 'http', status: 403, path: '/api/settings', message: 'Wrong current password' })).mockResolvedValue({ ok: true })
    mount(<SystemSection />)
    const current = await screen.findByLabelText('Enter current password…')
    const next = screen.getByLabelText('Access Password')
    await userEvent.type(current, ' current-password ')
    await userEvent.type(next, ' next-password ')
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set password' })).toBeEnabled())
    expect(current).toHaveValue(' current-password ')
    expect(next).toHaveValue(' next-password ')
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ _set_password: 'next-password', _current_password: ' current-password ' }))
    await waitFor(() => expect(next).toHaveValue(''))
    expect(current).toHaveValue('')
  })

  it('preserves the skill search when returning from a detail', async () => {
    mount(<SkillsPage />)
    await screen.findByText('3 uses')
    await userEvent.type(screen.getByRole('searchbox'), 'abcdefghij')
    await userEvent.click(screen.getByRole('button', { name: /abcdefghij one/ }))
    await screen.findByDisplayValue('Skill content')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('searchbox')).toHaveValue('abcdefghij')
    expect(screen.queryByRole('switch', { name: 'zebra' })).toBeNull()
  })

  it('skill filtering renders only rows entering the visible list', async () => {
    mount(<SkillsPage />)
    await screen.findByText('3 uses')
    const input = screen.getByRole('searchbox')
    reset(renders.skill)
    await userEvent.type(input, 'abcdefghij')
    expect(screen.queryByRole('switch', { name: 'zebra' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'abcdefghij one' })).toBeInTheDocument()
    expect(renders.skill).not.toHaveBeenCalled()
    await userEvent.clear(input)
    expect(screen.getByRole('switch', { name: 'zebra' })).toBeInTheDocument()
    expect(renders.skill.mock.calls.map(([count]) => count)).toEqual([3])
  })

  it('debounced tool filtering renders no retained tool or server rows', async () => {
    mount(<McpSection heading="" />)
    await screen.findByText('zebra')
    reset(renders.server)
    reset(renders.tool)
    vi.mocked(api.fetchMcpTools).mockClear()
    vi.useFakeTimers()
    const input = screen.getByRole('searchbox')
    for (let i = 1; i <= 10; i++) fireEvent.change(input, { target: { value: 'abcdefghij'.slice(0, i) } })
    expect(api.fetchMcpTools).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(api.fetchMcpTools).toHaveBeenCalledExactlyOnceWith('abcdefghij')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.queryByText('zebra')).toBeNull()
    expect(screen.getByText('abcdefghij one')).toBeInTheDocument()
    expect(renders.server).not.toHaveBeenCalled()
    expect(renders.tool).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(251) })
    expect(screen.getByText('zebra')).toBeInTheDocument()
    expect(renders.server).not.toHaveBeenCalled()
    expect(renders.tool).toHaveBeenCalledTimes(1)
  })
})
