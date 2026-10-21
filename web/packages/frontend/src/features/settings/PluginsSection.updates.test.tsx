import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { PluginsSection } from './PluginsSection'
import { deferred } from '../../test/fixtures'

vi.mock('../../api/endpoints', () => ({ fetchPlugins: vi.fn(), updatePlugin: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))

beforeEach(() => vi.resetAllMocks())
function setup(readOnly = false) {
  vi.mocked(api.fetchPlugins).mockResolvedValue({ read_only: readOnly, plugins: [{ key: 'probe', name: 'Probe', update: { available: true } }, { key: 'legacy', name: 'Legacy' }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><PluginsSection /></QueryClientProvider>)
}

it('asks for scan consent, suppresses duplicate requests, and refreshes after a confirmed update', async () => {
  const held = deferred<Awaited<ReturnType<typeof api.updatePlugin>>>()
  vi.mocked(api.updatePlugin).mockReturnValueOnce(held.promise).mockResolvedValueOnce({ key: 'probe', status: 'updated' })
  setup()
  const update = await screen.findByRole('button', { name: 'Update' })
  fireEvent.click(update)
  fireEvent.click(update)
  await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledTimes(1))
  held.resolve({ key: 'probe', status: 'needs_consent', verdict: 'caution', findings: 'Agent scan: review the network call', consent_token: 'synthetic-consent' })
  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByText(/Agent scan: review the network call/)).toBeVisible()
  expect(api.updatePlugin).toHaveBeenCalledWith('probe', false, undefined)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
  await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('probe', true, 'synthetic-consent'))
  await waitFor(() => expect(api.fetchPlugins).toHaveBeenCalledTimes(2))
})

it('shows a dangerous scan without an override action', async () => {
  vi.mocked(api.updatePlugin).mockResolvedValue({ key: 'probe', status: 'blocked', verdict: 'dangerous', findings: 'Agent scan: credential exfiltration' })
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Agent scan: credential exfiltration')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(api.updatePlugin).toHaveBeenCalledTimes(1)
})

it('keeps updates unavailable to read-only viewers and older Agent rows', async () => {
  setup(true)
  await screen.findByText('Probe')
  expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
})


it('re-prompts with the replacement token when the Agent reports changed scan findings', async () => {
  vi.mocked(api.updatePlugin)
    .mockResolvedValueOnce({ key: 'probe', status: 'needs_consent', verdict: 'caution', findings: 'First scan', consent_token: 'first-consent' })
    .mockResolvedValueOnce({ key: 'probe', status: 'needs_consent', verdict: 'caution', findings: 'Changed scan', consent_token: 'new-consent' })
    .mockResolvedValueOnce({ key: 'probe', status: 'updated' })
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Update' }))
  await screen.findByText('Changed scan')
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Update' }))
  await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('probe', true, 'new-consent'))
})
