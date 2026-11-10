import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchProfiles: vi.fn(() => Promise.resolve({
    profiles: [
      { name: 'default', is_default: true, display_name: '', description: '', has_avatar: false, canonical_session: null },
      { name: 'scout', is_default: false, display_name: 'Research lead', description: 'Finds sources.', has_avatar: true, canonical_session: { session_id: 'scout-root', tip_session_id: 'scout-tip' } },
    ],
    active: 'default',
    single_profile_mode: false,
  })),
  deleteProfile: vi.fn(), createProfile: vi.fn(),
  fetchModels: vi.fn(() => Promise.resolve({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-6-astra', label: 'GPT-6 Astra', provider_id: 'openai-codex' }] }] })),
  switchProfile: vi.fn(() => Promise.resolve({ profiles: [{ name: 'scout', canonical_session: { session_id: 'scout-root', tip_session_id: 'scout-live' } }], active: 'scout', is_default: false, default_model: null, default_model_provider: null, default_workspace: null })),
}))
vi.mock(import('../toast/errorToast'), () => ({ showErrorToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { showErrorToast } from '../toast/errorToast'
import { ProfilesPage } from './ProfilesPage'

function renderPage(bootstrap = DEFAULT_BOOTSTRAP) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<BootstrapContext.Provider value={bootstrap}><QueryClientProvider client={qc}><ProfilesPage /></QueryClientProvider></BootstrapContext.Provider>)
}

describe('ProfilesPage', () => {
  it('keeps the profiles-vs-workspaces explanation behind the title help button', async () => {
    renderPage()
    expect(await screen.findByText('default')).toBeVisible()
    expect(screen.queryByText(/Use profiles for how the agent works/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Profiles' }))
    expect(await screen.findByText(/Use profiles for how the agent works/)).toBeVisible()
    expect(screen.getByText(/Project or product folders on disk/)).toBeVisible()
  })

  it('TAL-1791: marks only the active profile', async () => {
    renderPage()
    const active = (await screen.findByText('default')).closest('li')!
    expect(within(active).getByText('ACTIVE')).toBeVisible()
    expect(within(screen.getByText('scout').closest('li')!).queryByText('ACTIVE')).not.toBeInTheDocument()
  })

  it('TAL-805: labels each profile by the server gateway mode', async () => {
    const modes = ['own', 'served', 'parked', 'standalone', 'stopped'] as const
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: modes.map((mode) => ({ name: mode, gateway_mode: mode, gateway_running: mode === 'own' || mode === 'served' })), active: 'own', single_profile_mode: false })
    renderPage()
    const label = async (name: string): Promise<HTMLElement> => (await screen.findByText(name, { selector: 'span.truncate' })).closest('li')!
    expect(within(await label('own')).getByText('Gateway running')).toBeVisible()
    expect(within(await label('served')).getByText('Gateway served by host')).toBeVisible()
    expect(within(await label('parked')).getByText('Gateway parked')).toBeVisible()
    expect(within(await label('standalone')).getByText('Standalone gateway stopped')).toBeVisible()
    expect(within(await label('stopped')).getByText('Gateway stopped')).toBeVisible()
  })

  it('TAL-805: falls back to gateway_running from a server without gateway_mode', async () => {
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: [{ name: 'up', gateway_running: true }, { name: 'down', gateway_running: false }, { name: 'unknown' }], active: 'up', single_profile_mode: false })
    renderPage()
    const row = async (name: string): Promise<HTMLElement> => (await screen.findByText(name, { selector: 'span.truncate' })).closest('li')!
    expect(within(await row('up')).getByText('Gateway running')).toBeVisible()
    expect(within(await row('down')).getByText('Gateway stopped')).toBeVisible()
    expect(within(await row('unknown')).queryByText(/Gateway/)).not.toBeInTheDocument()
  })

  it('TAL-213: shows each bot identity and opens the canonical Bot Chat only where one exists', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, assign })
    try {
      renderPage()
      const scout = (await screen.findByText('Research lead')).closest('li')!
      expect(within(scout).getByText('scout')).toBeVisible()
      expect(within(scout).getByText('Finds sources.')).toBeVisible()
      const plain = screen.getByText('default').closest('li')!
      expect(within(plain).queryByRole('button', { name: 'Open Bot Chat' })).not.toBeInTheDocument()
      await userEvent.click(within(scout).getByRole('button', { name: 'Open Bot Chat' }))
      expect(api.switchProfile).toHaveBeenCalledWith('scout')
      // The chat opens from the row the switch resolved, not the cached listing.
      await vi.waitFor(() => { expect(assign).toHaveBeenCalledWith(expect.stringMatching(/\/session\/scout-live$/)) })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('TAL-2084: offers Import agent setup in the header actions to an owner only', async () => {
    renderPage()
    await screen.findByText('scout')
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Import agent setup' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Import agent setup' })).toHaveLength(1)
  })

  it('TAL-2084: hides Import agent setup from a non-owner', async () => {
    renderPage({ ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: false } })
    await screen.findByText('scout')
    expect(screen.queryByRole('button', { name: 'Import agent setup' })).toBeNull()
  })
})

describe('profile writes show their result at once (TAL-1179)', () => {
  it('removes a deleted profile at once after confirmation', async () => {
    vi.mocked(api.deleteProfile).mockReturnValue(new Promise(() => undefined))
    renderPage()
    const scout = (await screen.findByText('scout')).closest('li')!
    await userEvent.click(within(scout).getByRole('button', { name: 'Delete this profile' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(api.deleteProfile).toHaveBeenCalledWith('scout')
    expect(screen.queryByText('scout')).toBeNull()
  })

  it('closes New profile on Create and shows the profile at once', async () => {
    vi.mocked(api.createProfile).mockReturnValue(new Promise(() => undefined))
    renderPage()
    await screen.findByText('scout')
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'writer{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('writer')).toBeInTheDocument()
    expect(api.createProfile).toHaveBeenLastCalledWith({ name: 'writer', clone_config: false })
  })

  it('TAL-2084: creates with a catalog model and its provider, an API key and a base URL', async () => {
    vi.mocked(api.createProfile).mockReturnValue(new Promise(() => undefined))
    const log = vi.spyOn(console, 'log')
    renderPage()
    await screen.findByText('scout')
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'writer')
    await userEvent.click(screen.getByRole('combobox', { name: 'Default model' }))
    await userEvent.click(await screen.findByRole('option', { name: 'GPT-6 Astra' }))
    const key = screen.getByLabelText('API key')
    expect(key).toHaveAttribute('type', 'password')
    await userEvent.type(key, 'sk-test-secret')
    await userEvent.type(screen.getByRole('textbox', { name: 'Base URL' }), 'http://localhost:11434{Enter}')
    expect(api.createProfile).toHaveBeenLastCalledWith({ name: 'writer', clone_config: false, default_model: '@openai-codex:gpt-6-astra', model_provider: 'openai-codex', api_key: 'sk-test-secret', base_url: 'http://localhost:11434' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.innerHTML).not.toContain('sk-test-secret')
    expect(log.mock.calls.flat().join(' ')).not.toContain('sk-test-secret')
    log.mockRestore()
    // A reopened dialog starts with an empty key.
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    expect(screen.getByLabelText('API key')).toHaveValue('')
  })

  it('TAL-2084: removes a refused new profile and shows the server error', async () => {
    vi.mocked(api.createProfile).mockRejectedValue(new Error("Selected model 'x' is not available"))
    renderPage()
    await screen.findByText('scout')
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'writer{Enter}')
    await vi.waitFor(() => { expect(showErrorToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Selected model 'x' is not available" })) })
    expect(screen.queryByText('writer')).toBeNull()
  })
})
