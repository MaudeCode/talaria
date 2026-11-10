import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { PluginsSection } from './PluginsSection'
import { deferred } from '../../test/fixtures'

const state = vi.hoisted(() => ({ context: {} }))
vi.mock('../../stream/connection', () => ({ getStreamContext: () => state.context, useStreamContext: () => state.context }))
vi.mock('../../api/endpoints', () => ({ fetchPlugins: vi.fn(), fetchPluginCatalog: vi.fn(), installPlugin: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const entry = { name: 'probe', title: 'Probe', description: 'Synthetic plugin', repo: 'https://example.invalid/probe', sha: 'a'.repeat(40), tier: 'verified', category: 'tools', requirements: ['Environment: SYNTHETIC_KEY'], installed_key: null, installed_sha: null, can_install: true, refusal: null, can_update: false }
beforeEach(() => {
  vi.resetAllMocks()
  state.context = {}
  vi.mocked(api.fetchPlugins).mockResolvedValue({ plugins: [], total: 0, empty: true, read_only: false })
  vi.mocked(api.fetchPluginCatalog).mockResolvedValue({ supported: true, read_only: false, entries: [entry], total: 1, next_offset: null })
})
async function setup(installAvailable = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><PluginsSection /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Add plugin' }))
  return installAvailable ? screen.findByRole('button', { name: 'Install disabled' }) : screen.findByRole('dialog', { name: 'Add plugin' })
}

it('distinguishes an empty installed list from the available catalog', async () => {
  await setup()
  expect(screen.getByText('No installed plugins')).toBeVisible()
  expect(screen.getByText('Probe')).toBeVisible()
})

it('distinguishes empty catalog results from an empty installed list', async () => {
  vi.mocked(api.fetchPluginCatalog).mockResolvedValue({ supported: true, read_only: false, entries: [], total: 0, next_offset: null })
  await setup(false)
  expect(await screen.findByText('No matching plugins')).toBeVisible()
  expect(screen.getByText('No installed plugins')).toBeVisible()
})

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

it('opens the catalog in a dialog and returns focus to Add plugin on Escape', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><PluginsSection /></QueryClientProvider>)
  const add = await screen.findByRole('button', { name: 'Add plugin' })
  expect(screen.queryByText('Probe')).not.toBeInTheDocument()
  await userEvent.click(add)
  const dialog = await screen.findByRole('dialog', { name: 'Add plugin' })
  expect(await within(dialog).findByText('Probe')).toBeVisible()
  expect(within(dialog).queryByRole('button', { name: 'Search' })).not.toBeInTheDocument()
  await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await waitFor(() => expect(add).toHaveFocus())
})

it('queries as the user types and shows the first page again when cleared', async () => {
  vi.mocked(api.fetchPluginCatalog).mockImplementation((query) => Promise.resolve(query === 'syn'
    ? { supported: true, read_only: false, entries: [{ ...entry, name: 'synth', title: 'Synth' }], total: 1, next_offset: null }
    : { supported: true, read_only: false, entries: [entry], total: 1, next_offset: null }))
  await setup()
  const search = screen.getByRole('searchbox', { name: 'Search plugins' })
  fireEvent.change(search, { target: { value: 'syn' } })
  expect(await screen.findByText('Synth')).toBeVisible()
  expect(api.fetchPluginCatalog).toHaveBeenLastCalledWith('syn', 0)
  fireEvent.change(search, { target: { value: '' } })
  expect(await screen.findByText('Probe')).toBeVisible()
  expect(screen.queryByText('Synth')).not.toBeInTheDocument()
})

it('ends each row in one action or the word Installed, and opens details from the row', async () => {
  vi.mocked(api.fetchPluginCatalog).mockResolvedValue({ supported: true, read_only: false, total: 2, next_offset: null, entries: [entry, { ...entry, name: 'held', title: 'Held', installed_key: 'held', installed_sha: 'b'.repeat(40), can_install: false }] })
  await setup()
  const dialog = screen.getByRole('dialog', { name: 'Add plugin' })
  expect(within(dialog).queryByRole('button', { name: 'Details' })).not.toBeInTheDocument()
  const held = within(dialog).getByRole('button', { name: /Held/ })
  expect(held).toHaveAttribute('aria-expanded', 'false')
  expect(within(dialog).getAllByRole('button', { name: 'Install disabled' })).toHaveLength(1)
  expect(within(dialog).getByText('Installed')).toBeVisible()
  expect(within(dialog).queryByText('verified · tools')).not.toBeInTheDocument()
  fireEvent.click(held)
  expect(held).toHaveAttribute('aria-expanded', 'true')
  expect(within(dialog).getByText('verified · tools')).toBeVisible()
  expect(within(dialog).getByText('b'.repeat(40))).toBeVisible()
})
