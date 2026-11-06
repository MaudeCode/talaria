import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api/endpoints'
import { PluginsSection } from './PluginsSection'
import { deferred } from '../../test/fixtures'
import { showToast } from '../toast/toast'

vi.mock('../../api/endpoints', () => ({ fetchPlugins: vi.fn(), updatePlugin: vi.fn(), updateAllPlugins: vi.fn(), setPluginAutoUpdate: vi.fn(), fetchPluginCatalog: vi.fn() }))
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

it('TAL-1829: says why an update turned a plugin off, on that row only', async () => {
  vi.mocked(api.fetchPlugins).mockResolvedValue({ plugins: [{ key: 'probe', name: 'Probe', enabled: false, disabled_reason: { kind: 'update', reason: 'its dependencies could not be prepared' } }, { key: 'legacy', name: 'Legacy', enabled: false }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><PluginsSection /></QueryClientProvider>)
  const row = (await screen.findByText('Probe')).closest('li')!
  expect(row).toHaveTextContent('Turned off by the last update: its dependencies could not be prepared; retried on the next update')
  expect(screen.getByText('Legacy').closest('li')).not.toHaveTextContent('Turned off by the last update')
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

describe('TAL-1914', () => {
  const plugins = (auto_update?: { auto_apply: boolean; check_hours: number; inactive_reason: 'no_gateway' | 'checks_off' | null }, read_only = false) => ({ read_only, plugins: [{ key: 'probe', name: 'Probe' }], ...(auto_update ? { auto_update } : {}) })
  const show = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><PluginsSection /></QueryClientProvider>)
  }
  const on = { auto_apply: true, check_hours: 24, inactive_reason: null }
  const off = { auto_apply: false, check_hours: 24, inactive_reason: null }

  it('an Agent without the field, or a read-only session, shows neither control', async () => {
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins())
    show()
    await screen.findByText('Probe')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update all' })).not.toBeInTheDocument()
    cleanup()
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins(on, true))
    show()
    await screen.findByText('Probe')
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update all' })).not.toBeInTheDocument()
  })

  it('the switch moves before the server answers and converges on the server value', async () => {
    const held = deferred<Awaited<ReturnType<typeof api.setPluginAutoUpdate>>>()
    vi.mocked(api.setPluginAutoUpdate).mockReturnValue(held.promise)
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins(off))
    show()
    const toggle = await screen.findByRole('switch', { name: 'Auto-update' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(screen.getByText('Every 24 h')).toBeVisible()
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins(on))
    held.resolve(on)
    await waitFor(() => expect(api.fetchPlugins).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toggle).toBeChecked())
    expect(api.setPluginAutoUpdate).toHaveBeenCalledWith(true)
  })

  it('a managed config rolls the switch back and shows the Agent refusal', async () => {
    const held = deferred<Awaited<ReturnType<typeof api.setPluginAutoUpdate>>>()
    vi.mocked(api.setPluginAutoUpdate).mockReturnValue(held.promise)
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins(off))
    show()
    const toggle = await screen.findByRole('switch', { name: 'Auto-update' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    held.reject(new Error('Set plugins.auto_apply in your package manager.'))
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(showToast).toHaveBeenCalledWith('Set plugins.auto_apply in your package manager.', 5000, 'error')
  })

  it.each([['no_gateway', 'Gateway not running'], ['checks_off', 'Checks off']] as const)('%s says why the switch has no effect', async (inactive_reason, text) => {
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins({ ...on, inactive_reason }))
    show()
    expect(await screen.findByText(text)).toBeVisible()
    expect(screen.queryByText('Every 24 h')).not.toBeInTheDocument()
  })

  it('Update all is busy on its own control, then lists every row and rereads the plugins', async () => {
    const held = deferred<Awaited<ReturnType<typeof api.updateAllPlugins>>>()
    vi.mocked(api.updateAllPlugins).mockReturnValue(held.promise)
    vi.mocked(api.fetchPlugins).mockResolvedValue({ ...plugins(off), plugins: [{ key: 'probe', name: 'Probe', update: { available: true } }] })
    show()
    const all = await screen.findByRole('button', { name: 'Update all' })
    fireEvent.click(all)
    fireEvent.click(all)
    await waitFor(() => expect(all).toHaveAttribute('aria-busy', 'true'))
    expect(api.updateAllPlugins).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Auto-update' })).toBeEnabled()
    held.resolve({ current: 1, results: [{ name: 'moved', status: 'updated', detail: '' }, { name: 'gone', status: 'failed', detail: 'git failed' }, { name: 'wider', status: 'needs_review', detail: 'adds tools: x' }, { name: 'held', status: 'skipped', detail: 'held with --ref' }] })
    const rows = within(await screen.findByRole('list', { name: 'Update all results' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['movedUpdated', 'goneFailedgit failed', 'widerNeeds reviewadds tools: x', 'heldSkippedheld with --ref'])
    await waitFor(() => expect(api.fetchPlugins).toHaveBeenCalledTimes(2))
    expect(all).toBeEnabled()
  })

  it('Update all with nothing to move says so', async () => {
    vi.mocked(api.updateAllPlugins).mockResolvedValue({ current: 2, results: [] })
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins(off))
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Update all' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('No plugin updates to apply'))
    expect(screen.queryByRole('list', { name: 'Update all results' })).not.toBeInTheDocument()
  })

  it('a row menu offers the same actions as the row, and a row without actions has none', async () => {
    const entry = { title: 'Behind', description: '', repo: 'https://example.invalid/p', sha: 'b'.repeat(40), tier: 'verified', category: 'tools', requirements: [], installed_sha: 'a'.repeat(40), can_install: false, refusal: null }
    vi.mocked(api.fetchPlugins).mockResolvedValue({ plugins: [{ key: 'probe', name: 'Probe', update: { available: true } }, { key: 'plain', name: 'Plain' }] })
    vi.mocked(api.fetchPluginCatalog).mockResolvedValue({ supported: true, total: 1, next_offset: null, entries: [{ ...entry, name: 'behind', installed_key: 'catalog-key', can_update: true }] })
    vi.mocked(api.updatePlugin).mockResolvedValue({ key: 'catalog-key', status: 'updated' })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
    const plain = (await screen.findByText('Plain')).closest('li')!
    expect(plain).not.toHaveAttribute('data-context-menu')
    const row = (await screen.findByText('Behind')).closest('li')!
    expect(within(row).getByRole('button', { name: 'Details' })).toBeVisible()
    fireEvent.contextMenu(row)
    const menu = await screen.findByRole('menu', { name: 'Plugin actions' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Details', 'Update'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Update' }))
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('catalog-key', false, undefined))
  })

  it('a behind catalog row updates through consent and leaves other rows alone', async () => {
    const entry = { title: 'Catalog', description: '', repo: 'https://example.invalid/p', sha: 'b'.repeat(40), tier: 'verified', category: 'tools', requirements: [], installed_sha: 'a'.repeat(40), can_install: false, refusal: null }
    vi.mocked(api.fetchPlugins).mockResolvedValue(plugins())
    vi.mocked(api.fetchPluginCatalog).mockResolvedValue({ supported: true, total: 2, next_offset: null, entries: [{ ...entry, name: 'behind', installed_key: 'probe', can_update: true }, { ...entry, name: 'at-pin', title: 'At pin', installed_key: 'other', can_update: false }] })
    vi.mocked(api.updatePlugin).mockResolvedValueOnce({ key: 'probe', status: 'needs_consent', verdict: 'widened', findings: 'adds tools: new_tool', consent_token: 'synthetic-consent' }).mockResolvedValueOnce({ key: 'probe', status: 'updated' })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Catalog' }))
    const row = (await screen.findByText('At pin')).closest('li')!
    expect(within(row).queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/adds tools: new_tool/)).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(api.updatePlugin).toHaveBeenLastCalledWith('probe', true, 'synthetic-consent'))
    await waitFor(() => expect(api.fetchPluginCatalog).toHaveBeenCalledTimes(2))
  })
})
