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
  fetchPlugins: vi.fn(() => Promise.resolve({ plugins: [{ key: 'calendar', name: 'Calendar', version: '1.0.0', kind: 'standalone', enabled: true, oauth_clients: clients.map((c) => ({ ...c })) }, { key: 'plain', name: 'Plain', enabled: true }], read_only: false })),
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
  vi.mocked(api.fetchPlugins).mockResolvedValueOnce({ plugins: [{ key: 'demo', name: 'Demo', settings }], empty: false, supported_hooks: [], read_only: false })
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
