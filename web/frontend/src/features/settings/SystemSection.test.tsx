import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

function renderSystem() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SystemSection /></BootstrapContext.Provider></QueryClientProvider>)
  return qc
}

describe('SystemSection "Check now"', () => {
  beforeEach(() => { settingsState = { bot_name: 'Hermes', check_for_updates: false, update_channel: 'experimental' }; vi.mocked(api.checkUpdatesNow).mockReset(); vi.mocked(showToast).mockReset() })

  it('runs one forced POST check, shows Checking… while pending, and renders the fresh result', async () => {
    let resolve!: (v: unknown) => void
    vi.mocked(api.checkUpdatesNow).mockImplementation(() => new Promise((r) => { resolve = r as typeof resolve }))
    const qc = renderSystem()
    expect(await screen.findByText(/up to date/i)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /check now/i })
    await userEvent.click(button)
    expect(await screen.findByRole('button', { name: /checking/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /checking/i }))
    expect(api.checkUpdatesNow).toHaveBeenCalledTimes(1)
    expect(api.checkUpdatesNow).toHaveBeenCalledWith('experimental')
    expect(api.fetchUpdatesCheck).toHaveBeenCalledTimes(1)
    const fresh = { cached: false, webui: { behind: 3 }, agent: { behind: 1 } }
    resolve(fresh)
    expect(await screen.findByRole('button', { name: /check now/i })).toBeEnabled()
    expect(qc.getQueryData(keys.updates.check)).toEqual(fresh)
    expect(screen.getByText(/webui/i, { selector: '.text-accent-text' })).toBeInTheDocument()
    expect(screen.getByText(/agent/i, { selector: '.text-accent-text' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /update now/i })).toBeInTheDocument()
  })

  it('waits for in-flight settings saves, then checks with the channel that actually persisted', async () => {
    // Saves stay pending until released; each release persists its patch the way the server would.
    const saves: (() => void)[] = []
    vi.mocked(api.saveSettings).mockImplementation((patch) => new Promise((r) => { saves.push(() => { settingsState = { ...settingsState, ...patch }; r(settingsState) }) }))
    vi.mocked(api.checkUpdatesNow).mockResolvedValue({ cached: false })
    renderSystem()
    await screen.findByText(/up to date/i)
    const trigger = screen.getByRole('combobox', { name: /update channel/i })
    expect(trigger).toHaveTextContent(/experimental/i)
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: /stable/i }))
    expect(trigger).toHaveTextContent(/stable/i)
    await userEvent.click(screen.getByRole('switch', { name: /ignore agent updates/i }))
    expect(trigger).toHaveTextContent(/stable/i)
    await userEvent.click(screen.getByRole('button', { name: /check now/i }))
    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled()
    await new Promise((r) => setTimeout(r, 120))
    expect(api.checkUpdatesNow).not.toHaveBeenCalled()
    expect(saves).toHaveLength(2)
    saves[0]!()
    saves[1]!()
    await waitFor(() => expect(api.checkUpdatesNow).toHaveBeenCalledWith('stable'))
    expect(api.checkUpdatesNow).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: /check now/i })).toBeEnabled()
    expect(trigger).toHaveTextContent(/stable/i)
  })

  it('restores the control and toasts the error when the forced check fails', async () => {
    vi.mocked(api.checkUpdatesNow).mockRejectedValue(new Error('git fetch failed'))
    const qc = renderSystem()
    await screen.findByText(/up to date/i)
    const before = qc.getQueryData(keys.updates.check)
    await userEvent.click(screen.getByRole('button', { name: /check now/i }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('git fetch failed', 4000, 'error'))
    expect(screen.getByRole('button', { name: /check now/i })).toBeEnabled()
    expect(qc.getQueryData(keys.updates.check)).toEqual(before)
  })
})
