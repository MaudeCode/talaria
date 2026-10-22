import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { ApiError } from '../../contracts/common'
import { keys } from '../../api/queryKeys'

let settingsState: Record<string, unknown> = {}
vi.mock('../../api/endpoints', () => ({
  restartAgent: vi.fn(), shutdownServer: vi.fn(), passkeyRegisterOptions: vi.fn(), passkeyRegister: vi.fn(), passkeyDelete: vi.fn(),
  fetchSettings: vi.fn(() => Promise.resolve(settingsState)),
  fetchSystemHealth: vi.fn(() => Promise.resolve({ status: 'ok' })),
  fetchAgentHealth: vi.fn(() => Promise.resolve({ alive: true })),
  fetchUpdatesCheck: vi.fn(() => Promise.resolve({ cached: true, webui: { behind: 0, state: 'up_to_date', can_apply: false, installed_unverified: false, manual_link: false, target_version: null, summary_available: false }, agent: { behind: 0, state: 'up_to_date', can_apply: false, installed_unverified: false, manual_link: false, target_version: null } })),
  checkUpdatesNow: vi.fn(),
  passkeysList: vi.fn(),
  applyUpdates: vi.fn(),
  cancelUpdateNotification: vi.fn(() => Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' })),
  saveSettings: vi.fn(),
  fetchMcpServers: vi.fn(() => Promise.resolve({ servers: [] })),
  fetchMcpTools: vi.fn(() => Promise.resolve({ tools: [] })),
  toggleMcpServer: vi.fn(),
  fetchUpdatesSummary: vi.fn(),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { SystemSection } from './SystemSection'
import { UpdatesCheckSchema, type UpdateTargetSchema } from '../../contracts'
import type { z } from 'zod'

/** A server-decided update target (TAL-559): the raw check fields plus the server's state and apply availability. */
const target = (state: z.infer<typeof UpdateTargetSchema>['state'], fields: Record<string, unknown> = {}) => ({ can_apply: false, installed_unverified: false, manual_link: false, target_version: null, summary_available: false, versions: [], folded_count: 0, ...fields, state })
const current = target('up_to_date', { behind: 0 })
const behind = (n: number) => target('commits_behind', { behind: n, can_apply: true, summary_available: true })

function renderSystem() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SystemSection /></BootstrapContext.Provider></QueryClientProvider>)
  return qc
}

describe('automatic update summaries (TAL-1008)', () => {
  beforeEach(() => { vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ cached: true, webui: current, agent: current }); vi.mocked(api.saveSettings).mockReset() })
  it('defaults on and saves the owner choice', async () => {
    settingsState = { check_for_updates: true }
    renderSystem()
    const control = await screen.findByRole('switch', { name: 'Summarize updates with AI automatically' })
    expect(control).toBeChecked()
    await userEvent.click(control)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ summarize_updates_automatically: false }))
  })
  it('is disabled when update checks are off', async () => {
    settingsState = { check_for_updates: false }
    renderSystem()
    const control = await screen.findByRole('switch', { name: 'Summarize updates with AI automatically' })
    await waitFor(() => expect(control).toHaveAttribute('aria-disabled', 'true'))
    await userEvent.click(control)
    expect(api.saveSettings).not.toHaveBeenCalled()
  })
})

describe('SystemSection "Check now"', () => {
  it('keeps the Agent picker on Stable when Web is Experimental', async () => {
    renderSystem()
    expect(await screen.findByRole('combobox', { name: /^web update channel$/i })).toHaveTextContent(/experimental/i)
    expect(screen.getByRole('combobox', { name: /^agent update channel$/i })).toHaveTextContent(/stable/i)
  })

  it('does not label a Web release count as commits', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: target('release_ready', { behind: 1, release_based: true, current_version: 'web-v1.2.3', latest_version: 'web-v1.3.0', can_apply: true, target_version: 'web-v1.3.0' }), agent: current }))
    renderSystem()
    expect(await screen.findByText('Talaria Web update available')).toBeInTheDocument()
    // The node names the version once; the status line does not repeat it (TAL-946).
    expect(screen.getAllByText(/web-v1\.3\.0/)).toHaveLength(1)
    expect(screen.queryByText(/1 commits behind/)).not.toBeInTheDocument()
  })

  it.each([false, true])('renders legacy refresh consent and preserves the selected update, accept=%s', async (accept) => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: behind(1) })
    vi.mocked(api.applyUpdates).mockResolvedValueOnce({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), agent_channel: 'stable', refresh_confirmation: { token: 'c'.repeat(32), services: ['synthetic.dashboard'] }, notification_id: '00000000-0000-4000-8000-000000000001' }).mockResolvedValueOnce({ ok: true, verified_revision: 'b'.repeat(40) })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('synthetic.dashboard')
    expect(dialog).toHaveTextContent('Active dashboard work may be interrupted')
    await userEvent.click(within(dialog).getByRole('button', { name: accept ? 'Refresh and update' : 'Cancel' }))
    if (accept) {
      await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledTimes(2))
      expect(api.applyUpdates).toHaveBeenLastCalledWith('apply', undefined, 'agent', { agent_channel: 'stable', agent_refresh_token: 'c'.repeat(32) })
    } else {
      expect(api.applyUpdates).toHaveBeenCalledTimes(1)
      expect(api.cancelUpdateNotification).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    }
  })

  it('requires confirmation for an unsupported Agent and cancellation never applies it', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: behind(4914) })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_version: '0.21.3', supported_revision: 'a'.repeat(40), agent_channel: 'stable', notification_id: '00000000-0000-4000-8000-000000000001' })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('may cause issues')
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(/SSO|chat/i)
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(api.applyUpdates).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.cancelUpdateNotification).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'))
  })

  it('applies a supported Agent target without a warning or the confirm dialog', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: { ...behind(1), support: 'supported', current_support: 'supported', unsupported: false } })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', undefined, 'agent', { agent_channel: 'stable' }))
    expect(screen.queryByText(/not officially supported/)).not.toBeInTheDocument()
    expect(screen.queryByText('Not tested with this Talaria release.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('warns from the server support field for an unchecked target and an unchecked installed Agent', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: { ...behind(1), support: 'unchecked', current_support: 'unchecked' } })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_version: '0.21.6', supported_revision: 'a'.repeat(40), agent_channel: 'stable' })
    renderSystem()
    const path = within((await screen.findByRole('heading', { name: 'Hermes Agent' })).closest('section')!)
    expect(path.getByText('This Agent version is not officially supported by Talaria and may cause issues.')).toBeInTheDocument()
    expect(path.getByText('Not tested with this Talaria release.')).toBeInTheDocument()
    await userEvent.click(path.getByRole('button', { name: /update agent/i }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('may cause issues')
  })

  it.each([
    ['an older server without support', { unsupported: true }, true],
    ['support over a contradicting unsupported', { support: 'supported' as const, unsupported: true }, false],
  ])('warns from %s', async (_name, fields, warned) => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: { ...behind(1), ...fields } })
    renderSystem()
    expect(await screen.findByRole('button', { name: /update agent/i })).toBeInTheDocument()
    expect(screen.queryByText(/not officially supported/) !== null).toBe(warned)
  })

  it('cancels an unsupported Agent notification when confirmation closes with Escape', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: behind(1) })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_version: '0.21.3', supported_revision: 'a'.repeat(40), agent_channel: 'stable', notification_id: '00000000-0000-4000-8000-000000000001' })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(api.cancelUpdateNotification).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'))
    expect(api.applyUpdates).toHaveBeenCalledTimes(1)
  })

  it('persists the Agent channel independently and acknowledges only the selected revision', async () => {
    settingsState.update_channel = 'stable'
    vi.mocked(api.saveSettings).mockImplementation((patch) => { settingsState = { ...settingsState, ...patch }; return Promise.resolve(settingsState) })
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: behind(4914) })
    vi.mocked(api.applyUpdates).mockResolvedValueOnce({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_version: '0.21.3', supported_revision: 'a'.repeat(40), agent_channel: 'experimental', notification_id: '00000000-0000-4000-8000-000000000001' }).mockResolvedValueOnce({ ok: true })
    renderSystem()
    await userEvent.click(await screen.findByRole('combobox', { name: /^agent update channel$/i }))
    await userEvent.click(await screen.findByRole('option', { name: /^experimental$/i }))
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ agent_update_channel: 'experimental' }))
    expect(screen.getByRole('combobox', { name: /^web update channel$/i })).toHaveTextContent(/stable/i)
    expect(screen.getByText('Hermes Agent is 4914 commits behind')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /update agent/i }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('This Agent version is not officially supported by Talaria and may cause issues.')
    await userEvent.click(screen.getByRole('button', { name: /update anyway/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenLastCalledWith('apply', undefined, 'agent', { agent_channel: 'experimental', confirmed_agent_revision: 'b'.repeat(40) }))
    expect(api.cancelUpdateNotification).not.toHaveBeenCalled()
  })

  beforeEach(() => { settingsState = { bot_name: 'Hermes', check_for_updates: false, auto_apply_updates: false, update_channel: 'experimental' }; vi.mocked(api.checkUpdatesNow).mockReset(); vi.mocked(api.applyUpdates).mockReset(); vi.mocked(api.cancelUpdateNotification).mockClear(); vi.mocked(api.saveSettings).mockReset(); vi.mocked(showToast).mockReset(); vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ cached: true, webui: current, agent: current }) })

  it('does not call unavailable private release metadata up to date', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: target('check_failed', { behind: null, current_sha: null, manual_update: true, error: 'Private release access unavailable', manual_link: true }) }))
    renderSystem()
    expect(await screen.findByText(/update check failed/i)).toBeInTheDocument()
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^update web$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /install updates manually/i })).toHaveAttribute('href', 'https://github.com/MaudeCode/talaria/releases')
  })

  it('keeps the last server status when a poll fails and reports failure only without one', async () => {
    const qc = renderSystem()
    expect(await screen.findByText('Talaria Web is up to date')).toBeInTheDocument()
    vi.mocked(api.fetchUpdatesCheck).mockRejectedValue(new Error('Failed to fetch'))
    await qc.refetchQueries({ queryKey: keys.updates.check })
    expect(qc.getQueryState(keys.updates.check)?.status).toBe('error')
    await expect(screen.findByText(/update check failed/i, {}, { timeout: 300 })).rejects.toThrow()
    expect(screen.getByText('Talaria Web is up to date')).toBeInTheDocument()
    qc.clear()
    renderSystem()
    expect(await screen.findByText('Talaria Web update check failed')).toBeInTheDocument()
  })

  it('does not keep a cached status from another channel when a poll fails', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ channel: 'stable', agent_channel: 'stable', webui: current, agent: current })
    const qc = renderSystem()
    expect(await screen.findByText('Talaria Web is up to date')).toBeInTheDocument()
    vi.mocked(api.fetchUpdatesCheck).mockRejectedValue(new Error('Failed to fetch'))
    await qc.refetchQueries({ queryKey: keys.updates.check })
    expect(await screen.findByText('Talaria Web update check failed')).toBeInTheDocument()
  })

  it.each([current, target('manual', { behind: 1, manual_update: true, manual_link: true }), target('check_failed', { error: 'Web unavailable', manual_link: true })])('keeps Agent updates independent of Web status %j', async (webui) => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui, agent: behind(1) })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', undefined, 'agent', { agent_channel: 'stable' }))
    expect(screen.queryByRole('button', { name: /^update web$/i })).not.toBeInTheDocument()
  })

  it('keeps the Agent action after applying only the Web update', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: behind(1), agent: behind(1) })
    vi.mocked(api.applyUpdates).mockImplementation(() => {
      vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: behind(1) })
      return Promise.resolve({ ok: true })
    })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /^update web$/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'experimental', 'webui', {}))
    await screen.findByText('Talaria Web is up to date')
    await userEvent.click(screen.getByRole('button', { name: /update agent/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenLastCalledWith('apply', undefined, 'agent', { agent_channel: 'stable' }))
  })

  it('keeps the repair action available when source is current but provenance is pending', async () => {
    const source = 'a'.repeat(40)
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({
      webui: target('finish', { behind: 0, metadata_repair: true, current_sha: source, latest_sha: source, can_apply: true }), agent: current,
    }))
    vi.mocked(api.applyUpdates).mockImplementation(() => {
      vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: target('up_to_date', { behind: 0, metadata_repair: false }), agent: current }))
      return Promise.resolve({ message: 'Release metadata repaired' })
    })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /finish update/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'experimental', 'webui', {}))
    await screen.findByText('Talaria Web is up to date')
    expect(screen.queryByRole('button', { name: /finish update/i })).not.toBeInTheDocument()
  })

  it('explains why a dirty checkout cannot update automatically', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: target('local_changes', { behind: 1, dirty: true, manual_update: true, manual_link: true }), agent: current })
    renderSystem()
    expect(await screen.findByText('Local changes block Talaria Web updates')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^update web$/i })).not.toBeInTheDocument()
  })

  it('runs one forced POST check, shows Checking… while pending, and renders the fresh result', async () => {
    let resolve!: (v: unknown) => void
    vi.mocked(api.checkUpdatesNow).mockImplementation(() => new Promise((r) => { resolve = r as typeof resolve }))
    const qc = renderSystem()
    expect(await screen.findByText('Talaria Web is up to date')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /^check web and agent now$/i })
    await userEvent.click(button)
    expect(await screen.findByRole('button', { name: /checking/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /checking/i }))
    expect(api.checkUpdatesNow).toHaveBeenCalledTimes(1)
    expect(api.checkUpdatesNow).toHaveBeenCalledWith('experimental', 'stable')
    expect(api.fetchUpdatesCheck).toHaveBeenCalledTimes(1)
    const fresh = { cached: false, webui: behind(3), agent: behind(1) }
    resolve(fresh)
    expect(await screen.findByRole('button', { name: /^check web and agent now$/i })).toBeEnabled()
    expect(qc.getQueryData(keys.updates.check)).toEqual(fresh)
    expect(screen.getByText('Talaria Web is 3 commits behind')).toBeInTheDocument()
    expect(screen.getByText('Hermes Agent is 1 commit behind')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^update web$/i })).toBeInTheDocument()
  })

  it('waits for in-flight settings saves, then checks with the channel that actually persisted', async () => {
    // Saves stay pending until released; each release persists its patch the way the server would.
    const saves: (() => void)[] = []
    vi.mocked(api.saveSettings).mockImplementation((patch) => new Promise((r) => { saves.push(() => { settingsState = { ...settingsState, ...patch }; r(settingsState) }) }))
    vi.mocked(api.checkUpdatesNow).mockResolvedValue({ cached: false })
    renderSystem()
    await screen.findByText('Talaria Web is up to date')
    const trigger = screen.getByRole('combobox', { name: /^web update channel$/i })
    expect(trigger).toHaveTextContent(/experimental/i)
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: /stable/i }))
    expect(trigger).toHaveTextContent(/stable/i)
    await userEvent.click(screen.getByRole('switch', { name: /ignore agent updates/i }))
    expect(trigger).toHaveTextContent(/stable/i)
    await userEvent.click(screen.getByRole('button', { name: /^check web (and agent )?now$/i }))
    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled()
    await new Promise((r) => setTimeout(r, 120))
    expect(api.checkUpdatesNow).not.toHaveBeenCalled()
    expect(saves).toHaveLength(2)
    saves[0]!()
    saves[1]!()
    await waitFor(() => expect(api.checkUpdatesNow).toHaveBeenCalledWith('stable', 'stable'))
    expect(api.checkUpdatesNow).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: /^check web (and agent )?now$/i })).toBeEnabled()
    expect(trigger).toHaveTextContent(/stable/i)
  })

  it('selects Experimental and uses it for the existing check and Web update actions', async () => {
    settingsState.update_channel = 'stable'
    vi.mocked(api.saveSettings).mockImplementation((patch) => {
      settingsState = { ...settingsState, ...patch }
      return Promise.resolve(settingsState)
    })
    vi.mocked(api.checkUpdatesNow).mockResolvedValue({ cached: false, webui: target('commits_behind', { behind: 1, branch: 'origin/main', can_apply: true }) })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true, restart_scheduled: true })
    renderSystem()
    await screen.findByText('Talaria Web is up to date')
    await userEvent.click(screen.getByRole('combobox', { name: /^web update channel$/i }))
    const experimental = await screen.findByRole('option', { name: /experimental/i })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('option', { name: /^stable$/i })).toBeInTheDocument()
    await userEvent.click(experimental)
    await userEvent.click(screen.getByRole('button', { name: /^check web and agent now$/i }))
    await waitFor(() => expect(api.checkUpdatesNow).toHaveBeenCalledWith('experimental', 'stable'))
    await userEvent.click(await screen.findByRole('button', { name: /^update web$/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'experimental', 'webui', {}))
  })

  it('persists the opt-in automatic Web update switch', async () => {
    settingsState.check_for_updates = true
    vi.mocked(api.saveSettings).mockResolvedValue({ ...settingsState, auto_apply_updates: true })
    renderSystem()
    const toggle = await screen.findByRole('switch', { name: /automatically apply web updates/i })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ auto_apply_updates: true }))
  })

  it('offers the normal apply action for a direct global npm Stable update', async () => {
    settingsState.update_channel = 'stable'
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: target('commits_behind', { behind: 1, no_git: true, install_kind: 'npm', manual_update: false, can_apply: true }), agent: current })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true, restart_scheduled: true })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /^update web$/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'stable', 'webui', {}))
  })

  it('keeps Experimental up to date when newer repository commits do not affect Web', async () => {
    settingsState.update_channel = 'experimental'
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: target('up_to_date', {
      channel: 'experimental', branch: 'origin/main', behind: 0, metadata_repair: false,
      current_sha: 'a'.repeat(40), latest_sha: 'b'.repeat(40),
    }) }))
    renderSystem()
    expect(await screen.findByText('Talaria Web is up to date')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^update web$/i })).not.toBeInTheDocument()
  })

  it('restores the control and toasts the error when the forced check fails', async () => {
    vi.mocked(api.checkUpdatesNow).mockRejectedValue(new Error('git fetch failed'))
    const qc = renderSystem()
    await screen.findByText('Talaria Web is up to date')
    const before = qc.getQueryData(keys.updates.check)
    await userEvent.click(screen.getByRole('button', { name: /^check web and agent now$/i }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('git fetch failed', 4000, 'error'))
    expect(screen.getByRole('button', { name: /^check web and agent now$/i })).toBeEnabled()
    expect(qc.getQueryData(keys.updates.check)).toEqual(before)
  })
})

describe('SystemSection update paths', () => {
  beforeEach(() => { settingsState = { bot_name: 'Hermes', check_for_updates: true, update_channel: 'stable', agent_update_channel: 'stable' }; vi.mocked(api.applyUpdates).mockReset(); vi.mocked(api.fetchUpdatesSummary).mockReset() })
  const path = (name: string) => screen.getByRole('region', { name })

  it('names the Stable Agent release instead of a Git commit distance', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: current, agent: target('release_ready', { behind: 4914, release_based: true, current_version: 'v2026.9.21', latest_version: 'v2026.10.1', can_apply: true, target_version: 'v2026.10.1' }) }))
    renderSystem()
    await screen.findByRole('button', { name: /update agent/i })
    expect(screen.queryByText(/commits? behind/i)).not.toBeInTheDocument()
    expect(screen.getByText('Hermes Agent update available')).toBeInTheDocument()
    expect(screen.getByText('v2026.10.1')).toBeInTheDocument()
  })

  it('says when the installed Stable release cannot be verified', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: current, agent: target('release_ready', { behind: 12, release_based: true, current_version: 'abcdef012345', latest_version: 'v2026.10.1', can_apply: true, installed_unverified: true, target_version: 'v2026.10.1' }) }))
    renderSystem()
    const agent = await screen.findByRole('region', { name: 'Hermes Agent' })
    expect(await within(agent).findByText('Hermes Agent update available')).toBeInTheDocument()
    expect(within(agent).getByText('The installed release could not be verified.')).toBeInTheDocument()
  })

  it('keeps each status, link, and action inside its own path', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: target('check_failed', { behind: null, manual_update: true, error: 'GitHub answered 404', manual_link: true }), agent: behind(3) }))
    renderSystem()
    const agentButton = await screen.findByRole('button', { name: /update agent/i })
    expect(path('Hermes Agent')).toContainElement(agentButton)
    expect(within(path('Hermes Agent')).getByText('Hermes Agent is 3 commits behind')).toBeInTheDocument()
    expect(within(path('Talaria Web')).getByText('Talaria Web update check failed')).toBeInTheDocument()
    expect(within(path('Talaria Web')).getByRole('link', { name: /install updates manually/i })).toBeInTheDocument()
    expect(within(path('Talaria Web')).getByRole('switch', { name: /automatically apply web updates/i })).toBeInTheDocument()
    expect(within(path('Hermes Agent')).queryByText(/Talaria Web/)).not.toBeInTheDocument()
    expect(within(path('Talaria Web')).queryByText(/Hermes Agent/)).not.toBeInTheDocument()
  })

  it.each([{ n: 0, status: 'Hermes Agent is up to date' }, { n: 2, status: 'Hermes Agent is 2 commits behind' }])('does not block a dirty Agent checkout, which updates through a stash (behind $n)', async ({ n, status }) => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: current, agent: n ? target('commits_behind', { behind: n, dirty: true, can_apply: true }) : target('up_to_date', { behind: 0, dirty: true }) }))
    renderSystem()
    const agent = await screen.findByRole('region', { name: 'Hermes Agent' })
    expect(within(agent).queryByText(/local changes/i)).not.toBeInTheDocument()
    expect(within(agent).getByText(status)).toBeInTheDocument()
  })

  it('shows a manual install that is ahead of its channel without calling it up to date', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: target('manual', { behind: 0, manual_update: true, install_kind: 'npm', message: 'This npm installation is ahead of the selected Stable release.' }), agent: current }))
    renderSystem()
    const web = await screen.findByRole('region', { name: 'Talaria Web' })
    expect(await within(web).findByText('Talaria Web is updated manually')).toBeInTheDocument()
    expect(within(web).getByText('This npm installation is ahead of the selected Stable release.')).toBeInTheDocument()
    expect(within(path('Hermes Agent')).getByText('Hermes Agent is up to date')).toBeInTheDocument()
  })

  it('reports disabled checks for both components', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ disabled: true, webui: target('off'), agent: target('off') })
    renderSystem()
    expect(await screen.findByText('Talaria Web is not being checked for updates')).toBeInTheDocument()
    expect(screen.getByText('Hermes Agent is not being checked for updates')).toBeInTheDocument()
  })

  it('reports ignored Agent checks only in the Agent path', async () => {
    settingsState.ignore_agent_updates = true
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: target('off', { name: 'agent', behind: 0, ignored: true }) })
    renderSystem()
    expect(await within(await screen.findByRole('region', { name: 'Hermes Agent' })).findByText('Hermes Agent is not being checked for updates')).toBeInTheDocument()
    expect(within(path('Talaria Web')).getByText('Talaria Web is up to date')).toBeInTheDocument()
  })

  it('shows the server status for the Agent once the ignore switch saves', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: behind(1) })
    vi.mocked(api.saveSettings).mockImplementation((patch) => {
      settingsState = { ...settingsState, ...patch }
      vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: target('off', { name: 'agent', behind: 0, ignored: true }) })
      return Promise.resolve(settingsState)
    })
    renderSystem()
    const agent = await screen.findByRole('region', { name: 'Hermes Agent' })
    expect(await within(agent).findByRole('button', { name: /update agent/i })).toBeInTheDocument()
    await userEvent.click(within(agent).getByRole('switch', { name: 'Ignore Agent updates' }))
    expect(await within(agent).findByText('Hermes Agent is not being checked for updates')).toBeInTheDocument()
    expect(within(agent).queryByRole('button', { name: /update agent/i })).not.toBeInTheDocument()
  })

  it('names only Web on the manual check while Agent updates are ignored', async () => {
    settingsState.ignore_agent_updates = true
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: target('off', { name: 'agent', behind: 0, ignored: true }) })
    renderSystem()
    expect(await screen.findByRole('button', { name: 'Check Web now' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check web and agent now/i })).not.toBeInTheDocument()
  })

  it('shows each path as checking, not unavailable, while the first update check is pending', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockImplementation(() => new Promise(() => undefined))
    renderSystem()
    expect(await screen.findByText('Checking Talaria Web for updates…')).toBeInTheDocument()
    expect(screen.getByText('Checking Hermes Agent for updates…')).toBeInTheDocument()
    expect(screen.queryByText(/update status is unavailable/i)).not.toBeInTheDocument()
  })

  it('summarizes an update with AI in a dialog, fetched only after the click and sending only the target', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: current, agent: target('release_ready', { behind: 3, can_apply: true, summary_available: true, current_version: 'v2026.9.24', target_version: 'v0.21.7' }) })
    vi.mocked(api.fetchUpdatesSummary).mockResolvedValue({ ok: true, target: 'agent', current_version: 'v2026.9.24', target_version: 'v0.21.7', summary: '', generated_by: 'llm', source: 'release_notes', cached: false, summary_sections: [{ title: "What you'll notice", items: ['Chats load faster.'] }, { title: 'Worth knowing', items: ['Two releases are combined here.'] }] })
    renderSystem()
    const path = await screen.findByRole('region', { name: 'Hermes Agent' })
    expect(within(screen.getByRole('region', { name: 'Talaria Web' })).queryByRole('button', { name: 'Summarize with AI' })).not.toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 50))
    expect(api.fetchUpdatesSummary).not.toHaveBeenCalled()
    await userEvent.click(within(path).getByRole('button', { name: 'Summarize with AI' }))
    const dialog = await screen.findByRole('dialog', { name: "What's new in Hermes Agent" })
    expect(await within(dialog).findByText("What you'll notice")).toBeInTheDocument()
    expect(within(dialog).getByText('v2026.9.24 → v0.21.7')).toBeInTheDocument()
    expect(within(dialog).getByText('Chats load faster.')).toBeInTheDocument()
    expect(within(dialog).getByText('Two releases are combined here.')).toBeInTheDocument()
    expect(api.fetchUpdatesSummary).toHaveBeenCalledTimes(1)
    expect(api.fetchUpdatesSummary).toHaveBeenCalledWith('agent')
  })

  it('offers Retry after a failed summary and shows no button when the server offers none', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: behind(2), agent: target('commits_behind', { behind: 3, can_apply: true }) })
    vi.mocked(api.fetchUpdatesSummary).mockRejectedValueOnce(new Error('model unavailable')).mockResolvedValueOnce({ ok: true, target: 'webui', current_version: null, target_version: null, summary: '', generated_by: 'fallback', source: 'commits', cached: false, summary_sections: [{ title: "What you'll notice", items: ['Talaria Web has 2 update(s) available.'] }] })
    renderSystem()
    const web = await screen.findByRole('region', { name: 'Talaria Web' })
    expect(within(screen.getByRole('region', { name: 'Hermes Agent' })).queryByRole('button', { name: 'Summarize with AI' })).not.toBeInTheDocument()
    await userEvent.click(within(web).getByRole('button', { name: 'Summarize with AI' }))
    const dialog = await screen.findByRole('dialog', { name: "What's new in Talaria Web" })
    expect(await within(dialog).findByText("Couldn't summarize what's new.")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
    expect(await within(dialog).findByText('Talaria Web has 2 update(s) available.')).toBeInTheDocument()
    expect(api.fetchUpdatesSummary).toHaveBeenCalledTimes(2)
    expect(api.fetchUpdatesSummary).toHaveBeenLastCalledWith('webui')
  })

  it("no longer offers the Summarize What's New setting", async () => {
    renderSystem()
    expect(await screen.findByRole('button', { name: /check web and agent now/i })).toBeInTheDocument()
    expect(screen.queryByText("Summarize What's New with AI")).not.toBeInTheDocument()
  })

  it('opens a setting explanation from its help button', async () => {
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: 'About Automatically apply Web updates' }))
    expect(await screen.findByText(/Hermes Agent is never updated automatically/)).toBeVisible()
  })
})

describe('SystemSection version list (TAL-946)', () => {
  /** The shared fixture is the server's own view: Web 1.16.0 → 1.19.0 with two releases between, Agent v2026.9.24 → v0.21.7 with v0.21.6 between. */
  const fixture = () => UpdatesCheckSchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/updates-check.json'), 'utf8')))
  beforeEach(() => {
    settingsState = { bot_name: 'Hermes', check_for_updates: true, update_channel: 'stable', agent_update_channel: 'stable' }
    vi.mocked(api.applyUpdates).mockReset()
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(fixture())
  })
  const path = async (name: string) => within(await screen.findByRole('region', { name }))

  it('folds older releases behind one node and installs the chosen Agent version', async () => {
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true })
    renderSystem()
    const agent = await path('Hermes Agent')
    const more = await agent.findByRole('button', { name: '1 more version' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(agent.queryByText('v0.21.6')).not.toBeInTheDocument()
    expect(agent.getByText('v0.21.7')).toBeInTheDocument()
    expect(agent.getByText('Not tested with this Talaria')).toBeInTheDocument()
    expect(agent.queryByText(/not officially supported/)).not.toBeInTheDocument()
    await userEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(agent.getByText('v0.21.6')).toBeInTheDocument()
    expect(agent.getByText('Supported')).toBeInTheDocument()
    await userEvent.click(agent.getByRole('button', { name: 'Install v0.21.6' }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', undefined, 'agent', { agent_channel: 'stable', version: 'v0.21.6' }))
  })

  it('lists every folded Web release oldest first and installs the chosen one', async () => {
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true })
    renderSystem()
    const web = await path('Talaria Web')
    await userEvent.click(await web.findByRole('button', { name: '2 more versions' }))
    const installs = web.getAllByRole('button', { name: /^Install / })
    expect(installs.map((button) => button.getAttribute('aria-label'))).toEqual(['Install web-v1.17.0', 'Install web-v1.18.0'])
    await userEvent.click(installs[1]!)
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'stable', 'webui', { version: '1.18.0' }))
  })

  it('confirms an unchecked intermediate Agent release and re-sends the same version', async () => {
    const data = fixture()
    data.agent!.versions[1] = { ...data.agent!.versions[1]!, support: 'unchecked', support_label: 'Not tested with this Talaria' }
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(data)
    vi.mocked(api.applyUpdates).mockResolvedValueOnce({ ok: false, confirmation_required: true, candidate_revision: '8'.repeat(40), supported_version: '0.21.5', supported_revision: 'a'.repeat(40), agent_channel: 'stable' }).mockResolvedValueOnce({ ok: true })
    renderSystem()
    const agent = await path('Hermes Agent')
    await userEvent.click(await agent.findByRole('button', { name: '1 more version' }))
    await userEvent.click(agent.getByRole('button', { name: 'Install v0.21.6' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('may cause issues')
    await userEvent.click(screen.getByRole('button', { name: /update anyway/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenLastCalledWith('apply', undefined, 'agent', { agent_channel: 'stable', confirmed_agent_revision: '8'.repeat(40), version: 'v0.21.6' }))
  })

  it('puts Update first and Summarize beside it in one row, only on the newest node', async () => {
    renderSystem()
    for (const [name, label] of [['Talaria Web', 'Update Web'], ['Hermes Agent', 'Update Agent']] as const) {
      const region = await path(name)
      const update = await region.findByRole('button', { name: label })
      const row = update.parentElement!
      expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual([label, 'Summarize with AI'])
      expect(getComputedStyle(row).display === 'flex' || row.className.includes('flex')).toBe(true)
      await userEvent.click(region.getByRole('button', { name: /more version/ }))
      expect(region.getAllByRole('button', { name: 'Summarize with AI' })).toHaveLength(1)
    }
  })
})

describe('passkeys (TAL-1179)', () => {
  it('removes a deleted passkey at once and restores it with the error on refusal', async () => {
    let refuse!: (error: unknown) => void
    vi.mocked(api.passkeysList).mockResolvedValue({ credentials: [{ id: 'k1', label: 'Laptop' }, { id: 'k2', label: 'Phone' }] } as never)
    vi.mocked(api.passkeyDelete).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, passkey_feature_flag: true } }
    render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}><SystemSection /></BootstrapContext.Provider></QueryClientProvider>)
    const row = (await screen.findByText('Laptop')).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(api.passkeyDelete).toHaveBeenCalledWith('k1')
    expect(screen.queryByText('Laptop')).toBeNull()
    expect(screen.getByText('Phone')).toBeInTheDocument()
    refuse(new ApiError({ kind: 'http', status: 403, path: '/x', message: 'Last passkey' }))
    expect(await screen.findByText('Laptop')).toBeInTheDocument()
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Last passkey'), expect.any(Number), 'error')
  })
})
