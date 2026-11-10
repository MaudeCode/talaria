import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// A stand-in for the server (TAL-1276): one plugin with two declared OAuth clients; signing out flips the next GET.
const clients = [
  { id: 'google', state: 'logged_out', authorize_host: 'accounts.example.test', token_host: 'oauth2.example.test', can_sign_out: false },
  { id: 'drive', state: 'revoked', authorize_host: 'accounts.example.test', token_host: 'accounts.example.test', can_sign_out: true },
]
const authorize = 'https://accounts.example.test/authorize?client_id=synthetic&state=synthetic-state'
vi.mock('../../api/endpoints', () => ({
  fetchPlugins: vi.fn(() => Promise.resolve({ plugins: [{ key: 'calendar', name: 'Calendar', version: '1.0.0', kind: 'standalone', enabled: true, oauth_clients: clients.map((c) => ({ ...c })) }, { key: 'plain', name: 'Plain', enabled: true }], total: 2, read_only: false })),
  onboardingOauthStart: vi.fn((provider: string) => Promise.resolve({ ok: true, status: 'pending', flow_id: 'flow-1', provider, verification_url: authorize, url: authorize, redirect_uri: 'http://127.0.0.1:43123/callback', authorize_host: 'accounts.example.test', token_host: 'oauth2.example.test', expires_in: 180, interval: 2 })),
  onboardingOauthPoll: vi.fn(() => Promise.resolve({ ok: true, status: 'pending', flow_id: 'flow-1' })),
  onboardingOauthCancel: vi.fn(() => Promise.resolve({ ok: true, status: 'cancelled', flow_id: 'flow-1' })),
  pluginOauthRedirect: vi.fn(() => Promise.resolve({ ok: true, status: 'pending', flow_id: 'flow-1' })),
  pluginOauthLogout: vi.fn((_key: string, id: string) => { Object.assign(clients.find((c) => c.id === id)!, { state: 'logged_out', can_sign_out: false }); return Promise.resolve({ ok: true, removed: true }) }),
  savePluginSettings: vi.fn(),
}))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { PluginsSection } from './PluginsSection'
import { showToast } from '../toast/toast'

function renderPlugins() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><PluginsSection /></QueryClientProvider>)
}

const clientRow = async (id: string) => (await screen.findByText(id)).closest('li')!

it.each([
  ['applied', 'Saved'],
  ['restart_required', 'Settings saved. Restart the affected MCP server to apply them.'],
  ['unknown', 'Settings saved. Live MCP application is unconfirmed. Check MCP status before retrying.'],
] as const)('renders the server runtime application result %s after saving', async (runtime_application, message) => {
  const settings = [{ key: 'endpoint', type: 'string' as const, label: 'Endpoint', description: '', required: false, value: 'one' }]
  vi.mocked(api.fetchPlugins).mockResolvedValueOnce({ plugins: [{ key: 'demo', name: 'Demo', settings }], total: 1, empty: false, supported_hooks: [], read_only: false })
  vi.mocked(api.savePluginSettings).mockResolvedValueOnce({ ok: true, key: 'demo', written: ['endpoint'], settings, runtime_application })
  renderPlugins()
  await userEvent.click(await screen.findByRole('button', { name: 'Settings' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Endpoint' }), 'two')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(showToast).toHaveBeenLastCalledWith(message, runtime_application === 'applied' ? 3000 : 10000))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Endpoint' })).not.toBeInTheDocument())
})

describe('PluginsSection OAuth clients', () => {
  it('shows each client\'s state, and only a stored grant offers Sign out', async () => {
    renderPlugins()
    const google = await clientRow('google')
    expect(within(google).getByText('Signed out')).toBeInTheDocument()
    expect(within(google).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    const drive = await clientRow('drive')
    expect(within(drive).getByText('Revoked')).toBeInTheDocument()
    await userEvent.click(within(drive).getByRole('button', { name: 'Sign out' }))
    expect(api.pluginOauthLogout).toHaveBeenCalledWith('calendar', 'drive')
    await waitFor(() => expect(within(drive).getByText('Signed out')).toBeInTheDocument())
    expect(within(drive).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('a sign-in names the server\'s two hosts, links the authorize page, and sends the pasted address', async () => {
    renderPlugins()
    const google = await clientRow('google')
    await userEvent.click(within(google).getByRole('button', { name: 'Sign in with google' }))
    expect(api.onboardingOauthStart).toHaveBeenCalledWith('plugin:calendar:google')
    expect(await within(google).findByText('You approve at accounts.example.test; the sign-in code goes to oauth2.example.test.')).toBeInTheDocument()
    expect(within(google).getByRole('link', { name: authorize })).toHaveAttribute('href', authorize)
    const paste = within(google).getByRole('textbox', { name: 'If the page after approval does not load, paste its address here.' })
    const answer = 'http://127.0.0.1:43123/callback?code=synthetic-code&state=synthetic-state'
    await userEvent.type(paste, `  ${answer} `)
    await userEvent.click(within(google).getByRole('button', { name: 'Continue' }))
    expect(api.pluginOauthRedirect).toHaveBeenCalledWith('flow-1', answer)
    await waitFor(() => expect(paste).toHaveValue(''))
  })
})

it('closes plugin settings on Save and shows the saved value at once (TAL-1179)', async () => {
  const settings = [{ key: 'endpoint', type: 'string' as const, label: 'Endpoint', description: '', required: false, value: 'one' }]
  vi.mocked(api.fetchPlugins).mockResolvedValue({ plugins: [{ key: 'demo', name: 'Demo', settings }], total: 1, empty: false, supported_hooks: [], read_only: false })
  vi.mocked(api.savePluginSettings).mockReturnValueOnce(new Promise(() => undefined))
  renderPlugins()
  await userEvent.click(await screen.findByRole('button', { name: 'Settings' }))
  await userEvent.clear(screen.getByRole('textbox', { name: 'Endpoint' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Endpoint' }), 'two')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.queryByRole('textbox', { name: 'Endpoint' })).toBeNull()
  expect(api.savePluginSettings).toHaveBeenCalledWith('demo', { endpoint: 'two' }, {})
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(screen.getByRole('textbox', { name: 'Endpoint' })).toHaveValue('two')
})

it("renders the server's filter answer and keeps each description to one titled line (TAL-2082, TAL-2129)", async () => {
  const calendar = { key: 'calendar', name: 'Calendar', kind: 'standalone', description: 'Reads your events', enabled: true }
  const mailer = { key: 'mailer', name: 'Mailer', description: 'Sends CALENDAR invites by email', enabled: true }
  const notes = { key: 'notes', name: 'Notes', enabled: true }
  // The server's answers per `q`; each is a new response with the install's `total`.
  const answers: Record<string, typeof notes[]> = { '': [calendar, mailer, notes], calendar: [calendar, mailer], EMAIL: [mailer], EMAILzzz: [] }
  vi.mocked(api.fetchPlugins).mockImplementation((q = '') => Promise.resolve({ read_only: false, total: 3, empty: false, plugins: structuredClone(answers[q] ?? []) }))
  renderPlugins()
  const shown = () => [...document.querySelectorAll('[data-plugin]')].map((row) => row.getAttribute('data-plugin'))
  const description = await screen.findByText('Reads your events')
  expect(description).toHaveClass('truncate')
  expect(description).toHaveAttribute('title', 'Reads your events')
  const filter = screen.getByRole('searchbox', { name: 'Filter plugins' })
  await userEvent.type(filter, ' calendar ')
  await waitFor(() => expect(shown()).toEqual(['calendar', 'mailer']))
  expect(api.fetchPlugins).toHaveBeenLastCalledWith('calendar')
  await userEvent.clear(filter)
  await userEvent.type(filter, 'EMAIL')
  await waitFor(() => expect(shown()).toEqual(['mailer']))
  await userEvent.type(filter, 'zzz')
  await waitFor(() => expect(shown()).toEqual([]))
  // `total` tells "nothing matches" from "nothing installed".
  expect(screen.getByText('No plugins match')).toBeInTheDocument()
  expect(screen.queryByText('No plugins found.')).not.toBeInTheDocument()
  await userEvent.clear(filter)
  await waitFor(() => expect(shown()).toEqual(['calendar', 'mailer', 'notes']))
  vi.mocked(api.fetchPlugins).mockReset()
})

it('an install with no plugins shows the empty state without a filter (TAL-2129)', async () => {
  vi.mocked(api.fetchPlugins).mockResolvedValueOnce({ read_only: false, total: 0, empty: true, plugins: [] })
  renderPlugins()
  expect(await screen.findByText('No plugins found.')).toBeInTheDocument()
  expect(screen.queryByRole('searchbox', { name: 'Filter plugins' })).not.toBeInTheDocument()
})

it('TAL-2132: shows the server figures and groups; a group opens and closes, and the filter opens the groups with a match', async () => {
  const rows = {
    meshy: { key: 'meshy', name: 'meshy', version: '1.2.0', kind: 'standalone', activation: 'enabled', enabled: true, description: 'Text to 3D', update: { available: true }, source: 'installed' as const, category: '' },
    notes: { key: 'team-notes', name: 'team-notes', enabled: false, activation: 'disabled', description: 'Shared notes', source: 'installed' as const, category: '' },
    slack: { key: 'platforms/slack', name: 'slack', enabled: true, activation: 'enabled', description: 'Slack adapter', source: 'bundled' as const, category: 'platforms' },
    image: { key: 'image_gen/fal', name: 'fal', enabled: true, kind: 'exclusive', activation: 'exclusive', is_active_provider: true, description: 'flux-2-pro', source: 'bundled' as const, category: 'image_gen' },
    video: { key: 'video_gen/fal', name: 'fal', enabled: true, description: 'Veo', source: 'bundled' as const, category: 'video_gen' },
  }
  const group = (id: 'installed' | 'platforms' | 'image_gen' | 'video_gen', plugin_keys: string[], enabled_count: number, total_count: number) => ({ id, plugin_keys, enabled_count, total_count, enabled_percent: 100 * enabled_count / total_count })
  const summary = { installed: 2, bundled: 3, enabled: 4, total: 5, updates: 1, updates_tone: 'warning' as const }
  // The server's answers per `q`: with a filter only `plugins` and `plugin_keys` narrow.
  vi.mocked(api.fetchPlugins).mockImplementation((q = '') => Promise.resolve(q === 'fal'
    ? { read_only: false, total: 5, summary, plugins: [rows.image, rows.video], groups: [group('installed', [], 1, 2), group('platforms', [], 1, 1), group('image_gen', ['image_gen/fal'], 1, 1), group('video_gen', ['video_gen/fal'], 1, 1)] }
    : { read_only: false, total: 5, summary, plugins: Object.values(rows), groups: [group('installed', ['meshy', 'team-notes'], 1, 2), group('platforms', ['platforms/slack'], 1, 1), group('image_gen', ['image_gen/fal'], 1, 1), group('video_gen', ['video_gen/fal'], 1, 1)] }))
  renderPlugins()
  const shown = () => [...document.querySelectorAll('[data-plugin]')].map((row) => row.getAttribute('data-plugin'))
  await screen.findByText('meshy')
  const figures = document.querySelector('[data-settings-stats]')
  expect([...figures?.querySelectorAll('[data-stat]') ?? []].map((stat) => stat.textContent)).toEqual(['Installed2', 'Built in3', 'Turned on4of 5', 'Updates1'])
  expect(figures?.querySelector('[data-stat="updates"] [data-figure-tone]')).toHaveAttribute('data-figure-tone', 'warning')
  const installed = screen.getByRole('region', { name: 'Installed' })
  expect(within(installed).getByText('Update available')).toBeInTheDocument()
  expect((await screen.findByText('team-notes')).closest('li')).toHaveTextContent('Off')
  expect(document.body).not.toHaveTextContent(/Enabled|exclusive|standalone/)
  // Closed on load: only the profile's own plugins are rows.
  expect(shown()).toEqual(['meshy', 'team-notes'])
  const image = screen.getByRole('button', { name: /Image generation/ })
  expect(image).toHaveAttribute('aria-expanded', 'false')
  expect(image).toHaveTextContent('1 on')
  expect(within(image).getByRole('meter')).toHaveAttribute('aria-valuenow', '100')
  await userEvent.click(image)
  expect(image).toHaveAttribute('aria-expanded', 'true')
  expect(shown()).toEqual(['meshy', 'team-notes', 'image_gen/fal'])
  expect(screen.getByText('fal').closest('li')).toHaveTextContent('In use')
  await userEvent.click(image)
  expect(shown()).toEqual(['meshy', 'team-notes'])
  // A filter opens every group with a match and hides the rest; clearing it restores the closed groups.
  const filter = screen.getByRole('searchbox', { name: 'Filter plugins' })
  await userEvent.type(filter, 'fal')
  await waitFor(() => expect(shown()).toEqual(['image_gen/fal', 'video_gen/fal']))
  expect(screen.queryByRole('button', { name: /Messaging platforms/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Installed' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Video generation/ })).toHaveAttribute('aria-expanded', 'true')
  await userEvent.clear(filter)
  await waitFor(() => expect(shown()).toEqual(['meshy', 'team-notes']))
  expect(screen.getByRole('button', { name: /Messaging platforms/ })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('button', { name: /Image generation/ })).toHaveAttribute('aria-expanded', 'false')
  vi.mocked(api.fetchPlugins).mockReset()
})
