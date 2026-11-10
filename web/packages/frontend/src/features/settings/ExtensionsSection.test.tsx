import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionRegistryEntry } from '@maudecode/talaria-web-contracts'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import * as api from '../../api/endpoints'
import { deferred } from '../../test/fixtures'
import { ExtensionsSection } from './ExtensionsSection'

vi.mock('../../api/endpoints', () => ({ fetchExtensionRegistry: vi.fn(), extensionAction: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const manifests = vi.hoisted(() => vi.fn())
vi.mock('../../extensions/registry', () => ({ fetchExtensionManifestList: manifests }))

const entry = (id: string, name: string, extra: Partial<ExtensionRegistryEntry> = {}): ExtensionRegistryEntry => ({ id, name, description: `${name} does one thing.`, version: '0.1.0', installed: false, capabilities: [], permissions: [], homepage: null, download_url: `https://hermes-webui.github.io/x/${id}.zip`, sha256: 'a'.repeat(64), ...extra })
const PINS = entry('pins', 'Message Pins', { description: 'Pin individual messages in a conversation. Adds a pin button to each message.', permissions: ['webui_api', 'dom'], capabilities: ['manifest-bundle'], homepage: 'https://example.com/pins' })
const FAV = entry('fav', 'Model Favorites')
const installed = (extra: object = {}) => ({ id: 'deck', name: 'Flightdeck', version: '0.2.0', description: 'Live agent instruments', source: 'gallery', enabled: true, can_toggle: true, panel: null, nav: null, capabilities: ['session'], permissions: { webui_api: true, dom: false }, settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [], ...extra })

beforeEach(() => {
  vi.resetAllMocks()
  manifests.mockResolvedValue({ protocol_version: 1, total: 1, enabled_count: 1, manifests: [installed()] })
  vi.mocked(api.fetchExtensionRegistry).mockResolvedValue({ total: 2, entries: [PINS, FAV] })
})

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><ExtensionsSection /></BootstrapContext.Provider></QueryClientProvider>)
}
const galleryRow = async (name: string) => (await screen.findByText(name)).closest('li')!

it('marks only the clicked install busy, keeps the other installs usable, and reads Installed after the reread', async () => {
  const pins = deferred<never>()
  vi.mocked(api.extensionAction).mockImplementation((_action, body) => (body.id === 'pins' ? pins.promise : new Promise(() => undefined)) as never)
  renderSection()
  const pinsInstall = within(await galleryRow('Message Pins')).getByRole('button', { name: 'Install' })
  const favInstall = within(await galleryRow('Model Favorites')).getByRole('button', { name: 'Install' })
  await userEvent.click(pinsInstall)
  expect(api.extensionAction).toHaveBeenCalledWith('install', { id: 'pins', download_url: PINS.download_url, sha256: PINS.sha256 })
  expect(favInstall).toBeEnabled()
  expect(favInstall).not.toHaveAttribute('aria-busy')
  expect(pinsInstall).toHaveAttribute('aria-busy', 'true')
  expect(pinsInstall).toBeDisabled()
  await userEvent.click(favInstall)
  expect(api.extensionAction).toHaveBeenCalledWith('install', expect.objectContaining({ id: 'fav' }))
  // The server now lists it as installed; the row reads that instead of offering Install again.
  vi.mocked(api.fetchExtensionRegistry).mockResolvedValue({ total: 2, entries: [{ ...PINS, installed: true }, FAV] })
  pins.resolve(undefined as never)
  await waitFor(() => expect(within(screen.getByText('Message Pins').closest('li')!).getByText('Installed')).toBeInTheDocument())
  expect(within(screen.getByText('Message Pins').closest('li')!).queryByRole('button', { name: 'Install' })).toBeNull()
})

it('opens a gallery row to its whole description, what it can access, its capabilities and homepage before it is installed', async () => {
  renderSection()
  const pins = await galleryRow('Message Pins')
  await userEvent.click(within(pins).getByRole('button', { name: 'Show details' }))
  expect(within(pins).getByText(PINS.description, { selector: 'p' })).toBeInTheDocument()
  expect(within(pins).getByText('Can use the Talaria API and change the page')).toBeInTheDocument()
  expect(within(pins).getByText('manifest-bundle')).toBeInTheDocument()
  expect(within(pins).getByRole('link', { name: 'Homepage' })).toHaveAttribute('href', 'https://example.com/pins')
  const fav = await galleryRow('Model Favorites')
  await userEvent.click(within(fav).getByRole('button', { name: 'Show details' }))
  expect(within(fav).getByText('Permissions are shown after install')).toBeInTheDocument()
})

it('shows the server counts and sends the filter to both lists', async () => {
  renderSection()
  const stats = await screen.findByLabelText('Extension counts')
  expect(within(stats).getByText('Installed').nextSibling).toHaveTextContent('1')
  expect(within(stats).getByText('In gallery').nextSibling).toHaveTextContent('2')
  manifests.mockResolvedValue({ protocol_version: 1, total: 1, enabled_count: 1, manifests: [] })
  vi.mocked(api.fetchExtensionRegistry).mockResolvedValue({ total: 2, entries: [] })
  await userEvent.type(screen.getByRole('searchbox', { name: 'Filter extensions' }), 'zzz')
  await waitFor(() => expect(manifests).toHaveBeenLastCalledWith('zzz', expect.anything()))
  expect(api.fetchExtensionRegistry).toHaveBeenLastCalledWith('zzz')
  await waitFor(() => expect(screen.getAllByText('No extensions match.')).toHaveLength(2))
})

it('closed, an installed row is its name and one line, a warning taking the description; open, it shows id, capabilities and permissions', async () => {
  manifests.mockResolvedValue({ protocol_version: 1, total: 1, enabled_count: 1, manifests: [installed({ warnings: ['panel_not_html'] })] })
  renderSection()
  const deck = (await screen.findByRole('switch', { name: /^Flightdeck/ })).closest('li')!
  expect(within(deck).getByText('panel_not_html')).toBeInTheDocument()
  expect(within(deck).queryByText('Live agent instruments')).toBeNull()
  expect(within(deck).queryByText('session')).toBeNull()
  await userEvent.click(within(deck).getByRole('button', { name: 'Show details' }))
  expect(within(deck).getByText('Live agent instruments')).toBeInTheDocument()
  expect(within(deck).getByText('gallery · deck')).toBeInTheDocument()
  expect(within(deck).getByText('session')).toBeInTheDocument()
  // Only granted permissions are named, in the words gallery rows use.
  expect(within(deck).getByText('Can use the Talaria API')).toBeInTheDocument()
})
