import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { PluginsSection } from './PluginsSection'
import { deferred } from '../../test/fixtures'

const state = vi.hoisted(() => ({ context: {} }))
vi.mock('../../stream/connection', () => ({ getStreamContext: () => state.context }))
vi.mock('../../api/endpoints', () => ({ fetchPlugins: vi.fn(), fetchPluginCatalog: vi.fn(), installPlugin: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const entry = { name: 'probe', title: 'Probe', description: 'Synthetic plugin', repo: 'https://example.invalid/probe', sha: 'a'.repeat(40), tier: 'verified', category: 'tools', requirements: ['Environment: SYNTHETIC_KEY'], installed_key: null, installed_sha: null, can_install: true, refusal: null }
beforeEach(() => {
  vi.resetAllMocks()
  state.context = {}
  vi.mocked(api.fetchPlugins).mockResolvedValue({ plugins: [], read_only: false })
  vi.mocked(api.fetchPluginCatalog).mockResolvedValue({ supported: true, read_only: false, entries: [entry], total: 1, next_offset: null })
})
async function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><PluginsSection /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
  return screen.findByRole('button', { name: 'Install disabled' })
}

it('previews once, confirms the exact token and reconciles the installed identity', async () => {
  const held = deferred<Awaited<ReturnType<typeof api.installPlugin>>>()
  vi.mocked(api.installPlugin).mockReturnValueOnce(held.promise).mockResolvedValueOnce({ name: 'probe', key: 'actual-name', status: 'installed', enabled: false })
  const install = await setup()
  fireEvent.click(install)
  fireEvent.click(install)
  await waitFor(() => expect(api.installPlugin).toHaveBeenCalledTimes(1))
  held.resolve({ name: 'probe', status: 'needs_consent', findings: 'No dependencies or host capabilities are granted', consent_token: 'bound-preview' })
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('No dependencies or host capabilities are granted')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Install disabled' }))
  await waitFor(() => expect(api.installPlugin).toHaveBeenCalledWith('probe', 'bound-preview'))
  await waitFor(() => expect(api.fetchPluginCatalog).toHaveBeenCalledTimes(2))
})

it('ignores a preview returned after profile replacement', async () => {
  const held = deferred<Awaited<ReturnType<typeof api.installPlugin>>>()
  vi.mocked(api.installPlugin).mockReturnValue(held.promise)
  fireEvent.click(await setup())
  await waitFor(() => expect(api.installPlugin).toHaveBeenCalledTimes(1))
  state.context = {}
  held.resolve({ name: 'probe', status: 'needs_consent', findings: 'Old profile', consent_token: 'old-profile-token' })
  await waitFor(() => expect(api.installPlugin).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it('reads the installed identity after lost acknowledgment without replaying the install', async () => {
  vi.mocked(api.installPlugin).mockRejectedValue(new Error('Install outcome unknown'))
  fireEvent.click(await setup())
  await waitFor(() => expect(api.fetchPluginCatalog).toHaveBeenCalledTimes(2))
  expect(api.installPlugin).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})
