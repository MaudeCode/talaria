import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { keys } from '../../api/queryKeys'

let settingsState: Record<string, unknown> = {}
vi.mock('../../api/endpoints', () => ({
  restartAgent: vi.fn(), shutdownServer: vi.fn(), passkeyRegisterOptions: vi.fn(), passkeyRegister: vi.fn(), passkeyDelete: vi.fn(),
  fetchSettings: vi.fn(() => Promise.resolve(settingsState)),
  fetchSystemHealth: vi.fn(() => Promise.resolve({ status: 'ok' })),
  fetchAgentHealth: vi.fn(() => Promise.resolve({ alive: true })),
  fetchUpdatesCheck: vi.fn(() => Promise.resolve({ cached: true, webui: { behind: 0 }, agent: { behind: 0 } })),
  checkUpdatesNow: vi.fn(),
  passkeysList: vi.fn(),
  applyUpdates: vi.fn(),
  saveSettings: vi.fn(),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { SystemSection } from './SystemSection'
import { UpdatesCheckSchema } from '../../contracts'

function renderSystem() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SystemSection /></BootstrapContext.Provider></QueryClientProvider>)
  return qc
}

describe('SystemSection "Check now"', () => {
  it('keeps the Agent picker on Stable when Web is Experimental', async () => {
    renderSystem()
    expect(await screen.findByRole('combobox', { name: /^web update channel$/i })).toHaveTextContent(/experimental/i)
    expect(screen.getByRole('combobox', { name: /^agent update channel$/i })).toHaveTextContent(/stable/i)
  })

  it('does not label a Web release count as commits', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: 1, release_based: true, current_version: 'web-v1.2.3', latest_version: 'web-v1.3.0' }, agent: { behind: 0 } }))
    renderSystem()
    expect(await screen.findByText('Talaria Web web-v1.3.0 is available')).toBeInTheDocument()
    expect(screen.queryByText(/1 commits behind/)).not.toBeInTheDocument()
  })

  it('requires confirmation for an unsupported Agent and cancellation never applies it', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 0 }, agent: { behind: 4914 } })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_version: '0.21.3', supported_revision: 'a'.repeat(40), agent_channel: 'stable' })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('may cause issues')
    expect(screen.getByRole('alertdialog')).not.toHaveTextContent(/SSO|chat/i)
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(api.applyUpdates).toHaveBeenCalledTimes(1)
  })

  it('persists the Agent channel independently and acknowledges only the selected revision', async () => {
    settingsState.update_channel = 'stable'
    vi.mocked(api.saveSettings).mockImplementation((patch) => { settingsState = { ...settingsState, ...patch }; return Promise.resolve(settingsState) })
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 0 }, agent: { behind: 4914 } })
    vi.mocked(api.applyUpdates).mockResolvedValueOnce({ ok: false, confirmation_required: true, candidate_revision: 'b'.repeat(40), supported_version: '0.21.3', supported_revision: 'a'.repeat(40), agent_channel: 'experimental' }).mockResolvedValueOnce({ ok: true })
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
  })

  beforeEach(() => { settingsState = { bot_name: 'Hermes', check_for_updates: false, auto_apply_updates: false, update_channel: 'experimental' }; vi.mocked(api.checkUpdatesNow).mockReset(); vi.mocked(api.applyUpdates).mockReset(); vi.mocked(api.saveSettings).mockReset(); vi.mocked(showToast).mockReset(); vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ cached: true, webui: { behind: 0 }, agent: { behind: 0 } }) })

  it('does not call unavailable private release metadata up to date', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: null, current_sha: null, manual_update: true, error: 'Private release access unavailable' } }))
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

  it.each([{ behind: 0 }, { behind: 1, manual_update: true }, { error: 'Web unavailable' }])('keeps Agent updates independent of Web status %j', async (webui) => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui, agent: { behind: 1 } })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /update agent/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', undefined, 'agent', { agent_channel: 'stable' }))
    expect(screen.queryByRole('button', { name: /^update web$/i })).not.toBeInTheDocument()
  })

  it('keeps the Agent action after applying only the Web update', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 1 }, agent: { behind: 1 } })
    vi.mocked(api.applyUpdates).mockImplementation(() => {
      vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 0 }, agent: { behind: 1 } })
      return Promise.resolve({ ok: true })
    })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /^update web$/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'experimental', 'webui'))
    await screen.findByText('Talaria Web is up to date')
    await userEvent.click(screen.getByRole('button', { name: /update agent/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenLastCalledWith('apply', undefined, 'agent', { agent_channel: 'stable' }))
  })

  it('keeps the repair action available when source is current but provenance is pending', async () => {
    const source = 'a'.repeat(40)
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({
      webui: { behind: 0, metadata_repair: true, current_sha: source, latest_sha: source }, agent: { behind: 0 },
    }))
    vi.mocked(api.applyUpdates).mockImplementation(() => {
      vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: 0, metadata_repair: false }, agent: { behind: 0 } }))
      return Promise.resolve({ message: 'Release metadata repaired' })
    })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /finish update/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'experimental', 'webui'))
    await screen.findByText('Talaria Web is up to date')
    expect(screen.queryByRole('button', { name: /finish update/i })).not.toBeInTheDocument()
  })

  it('explains why a dirty checkout cannot update automatically', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 1, dirty: true, manual_update: true }, agent: { behind: 0 } })
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
    const fresh = { cached: false, webui: { behind: 3 }, agent: { behind: 1 } }
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
    vi.mocked(api.checkUpdatesNow).mockResolvedValue({ cached: false, webui: { behind: 1, branch: 'origin/main' } })
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
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'experimental', 'webui'))
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
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 1, no_git: true, install_kind: 'npm', manual_update: false }, agent: { behind: 0 } })
    vi.mocked(api.applyUpdates).mockResolvedValue({ ok: true, restart_scheduled: true })
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: /^update web$/i }))
    await waitFor(() => expect(api.applyUpdates).toHaveBeenCalledWith('apply', 'stable', 'webui'))
  })

  it('keeps Experimental up to date when newer repository commits do not affect Web', async () => {
    settingsState.update_channel = 'experimental'
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: {
      channel: 'experimental', branch: 'origin/main', behind: 0, metadata_repair: false,
      current_sha: 'a'.repeat(40), latest_sha: 'b'.repeat(40),
    } }))
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
  beforeEach(() => { settingsState = { bot_name: 'Hermes', check_for_updates: true, update_channel: 'stable', agent_update_channel: 'stable' }; vi.mocked(api.applyUpdates).mockReset() })
  const path = (name: string) => screen.getByRole('region', { name })

  it('names the Stable Agent release instead of a Git commit distance', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: 0 }, agent: { behind: 4914, release_based: true, current_version: 'v2026.9.21', latest_version: 'v2026.10.1' } }))
    renderSystem()
    await screen.findByRole('button', { name: /update agent/i })
    expect(screen.queryByText(/commits? behind/i)).not.toBeInTheDocument()
    expect(screen.getByText('Hermes Agent v2026.10.1 is available')).toBeInTheDocument()
  })

  it('says when the installed Stable release cannot be verified', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: 0 }, agent: { behind: 12, release_based: true, current_version: 'abcdef012345', latest_version: 'v2026.10.1' } }))
    renderSystem()
    const agent = await screen.findByRole('region', { name: 'Hermes Agent' })
    expect(await within(agent).findByText('Hermes Agent v2026.10.1 is available')).toBeInTheDocument()
    expect(within(agent).getByText('The installed release could not be verified.')).toBeInTheDocument()
  })

  it('keeps each status, link, and action inside its own path', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: null, manual_update: true, error: 'GitHub answered 404' }, agent: { behind: 3 } }))
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

  it.each([{ behind: 0, status: 'Hermes Agent is up to date' }, { behind: 2, status: 'Hermes Agent is 2 commits behind' }])('does not block a dirty Agent checkout, which updates through a stash (behind $behind)', async ({ behind, status }) => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: 0 }, agent: { behind, dirty: true } }))
    renderSystem()
    const agent = await screen.findByRole('region', { name: 'Hermes Agent' })
    expect(within(agent).queryByText(/local changes/i)).not.toBeInTheDocument()
    expect(within(agent).getByText(status)).toBeInTheDocument()
  })

  it('shows a manual install that is ahead of its channel without calling it up to date', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue(UpdatesCheckSchema.parse({ webui: { behind: 0, manual_update: true, install_kind: 'npm', message: 'This npm installation is ahead of the selected Stable release.' }, agent: { behind: 0 } }))
    renderSystem()
    const web = await screen.findByRole('region', { name: 'Talaria Web' })
    expect(await within(web).findByText('Talaria Web is updated manually')).toBeInTheDocument()
    expect(within(web).getByText('This npm installation is ahead of the selected Stable release.')).toBeInTheDocument()
    expect(within(path('Hermes Agent')).getByText('Hermes Agent is up to date')).toBeInTheDocument()
  })

  it('reports disabled checks for both components', async () => {
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ disabled: true })
    renderSystem()
    expect(await screen.findByText('Talaria Web is not being checked for updates')).toBeInTheDocument()
    expect(screen.getByText('Hermes Agent is not being checked for updates')).toBeInTheDocument()
  })

  it('reports ignored Agent checks only in the Agent path', async () => {
    settingsState.ignore_agent_updates = true
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 0 }, agent: null })
    renderSystem()
    expect(await within(await screen.findByRole('region', { name: 'Hermes Agent' })).findByText('Hermes Agent is not being checked for updates')).toBeInTheDocument()
    expect(within(path('Talaria Web')).getByText('Talaria Web is up to date')).toBeInTheDocument()
  })

  it('names only Web on the manual check while Agent updates are ignored', async () => {
    settingsState.ignore_agent_updates = true
    vi.mocked(api.fetchUpdatesCheck).mockResolvedValue({ webui: { behind: 0 }, agent: null })
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

  it('opens a setting explanation from its help button', async () => {
    renderSystem()
    await userEvent.click(await screen.findByRole('button', { name: 'About Automatically apply Web updates' }))
    expect(await screen.findByText(/Hermes Agent is never updated automatically/)).toBeVisible()
  })
})
