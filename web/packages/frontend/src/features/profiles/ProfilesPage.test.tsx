import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams, useSearch } from '@tanstack/react-router'
import { SettingsSearchSchema } from '../../contracts/url'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchProfiles: vi.fn(() => Promise.resolve({
    profiles: [
      { name: 'default', is_default: true, display_name: '', description: '', has_avatar: false, canonical_session: null },
      { name: 'scout', is_default: false, display_name: 'Research lead', description: 'Finds sources.', has_avatar: true, canonical_session: { session_id: 'scout-root', tip_session_id: 'scout-tip' },
        path: '/home/u/.hermes/profiles/scout', model: 'gpt-6-astra', provider: 'openai-codex', enabled_skills: 3, total_skills: 7, gateway_mode: 'parked' as const, has_env: true, pending_writes: 2 },
    ],
    active: 'default',
    single_profile_mode: false,
  })),
  deleteProfile: vi.fn(), createProfile: vi.fn(), updateProfile: vi.fn(),
  fetchSettings: vi.fn(() => Promise.resolve({ bot_name: 'Maude' })), saveSettings: vi.fn((patch: Record<string, unknown>) => Promise.resolve({ bot_name: 'Maude', ...patch })),
  fetchModels: vi.fn(() => Promise.resolve({ groups: [{ provider: 'OpenAI Codex', provider_id: 'openai-codex', models: [{ id: '@openai-codex:gpt-6-astra', label: 'GPT-6 Astra', provider_id: 'openai-codex' }] }] })),
  fetchBootstrap: vi.fn(async () => (await import('../../contracts/adapters/memory')).DEFAULT_BOOTSTRAP),
  switchProfile: vi.fn(() => Promise.resolve({ profiles: [{ name: 'scout', canonical_session: { session_id: 'scout-root', tip_session_id: 'scout-live' } }], active: 'scout', is_default: false, default_model: null, default_model_provider: null, default_workspace: null })),
}))
vi.mock(import('../toast/errorToast'), () => ({ showErrorToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { showErrorToast } from '../toast/errorToast'
import { ProfilesPage } from './ProfilesPage'

/** The page at Settings > Profiles, `?name=` included, under a router that also holds the pages its links open. */
async function renderPage(bootstrap = DEFAULT_BOOTSTRAP, path = '/settings/profiles') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute({ component: () => <BootstrapContext.Provider value={bootstrap}><QueryClientProvider client={qc}><Outlet /></QueryClientProvider></BootstrapContext.Provider> })
  const section = createRoute({ getParentRoute: () => root, path: '/settings/$section', validateSearch: SettingsSearchSchema, component: function Section() {
    const { section: id } = useParams({ strict: false }) as { section: string }
    const { name } = useSearch({ strict: false }) as { name?: string }
    return id === 'profiles' ? <ProfilesPage name={name} /> : <p>Section {id}</p>
  } })
  const skills = createRoute({ getParentRoute: () => root, path: '/skills', component: () => <p>Skills page</p> })
  const memory = createRoute({ getParentRoute: () => root, path: '/memory', component: () => <p>Memory page</p> })
  const chat = createRoute({ getParentRoute: () => root, path: '/session/$sessionId', component: () => <p>Chat page</p> })
  const router = createRouter({ routeTree: root.addChildren([section, skills, memory, chat]), history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}
const rowMenuItems = async (row: HTMLElement) => {
  await userEvent.click(within(row).getByRole('button', { name: 'Profile actions' }))
  return within(await screen.findByRole('menu', { name: 'Profile actions' })).getAllByRole('menuitem')
}

describe('ProfilesPage', () => {
  it('keeps the profiles-vs-workspaces explanation behind the title help button', async () => {
    await renderPage()
    expect(await screen.findByText('default')).toBeVisible()
    expect(screen.queryByText(/Use profiles for how the agent works/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'About Profiles' }))
    expect(await screen.findByText(/Use profiles for how the agent works/)).toBeVisible()
    expect(screen.getByText(/Project or product folders on disk/)).toBeVisible()
  })

  it('TAL-1791: marks only the active profile', async () => {
    await renderPage()
    const active = (await screen.findByText('default')).closest('li')!
    expect(within(active).getByText('Active')).toBeVisible()
    expect(within(screen.getByText('scout').closest('li')!).queryByText('Active')).not.toBeInTheDocument()
  })

  it('TAL-805: labels each profile by the server gateway mode', async () => {
    const modes = ['own', 'served', 'parked', 'standalone', 'stopped'] as const
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: modes.map((mode) => ({ name: mode, gateway_mode: mode, gateway_running: mode === 'own' || mode === 'served' })), active: 'own', single_profile_mode: false })
    await renderPage()
    const label = async (name: string): Promise<HTMLElement> => (await screen.findByText(name, { selector: 'span.truncate' })).closest('li')!
    expect(within(await label('own')).getByText('Gateway running')).toBeVisible()
    expect(within(await label('served')).getByText('Gateway served by host')).toBeVisible()
    expect(within(await label('parked')).getByText('Gateway parked')).toBeVisible()
    expect(within(await label('standalone')).getByText('Standalone gateway stopped')).toBeVisible()
    expect(within(await label('stopped')).getByText('Gateway stopped')).toBeVisible()
  })

  it('TAL-805: falls back to gateway_running from a server without gateway_mode', async () => {
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: [{ name: 'up', gateway_running: true }, { name: 'down', gateway_running: false }, { name: 'unknown' }], active: 'up', single_profile_mode: false })
    await renderPage()
    const row = async (name: string): Promise<HTMLElement> => (await screen.findByText(name, { selector: 'span.truncate' })).closest('li')!
    expect(within(await row('up')).getByText('Gateway running')).toBeVisible()
    expect(within(await row('down')).getByText('Gateway stopped')).toBeVisible()
    expect(within(await row('unknown')).queryByText(/Gateway/)).not.toBeInTheDocument()
  })

  it('TAL-213: shows each bot identity and opens the canonical Bot Chat only where one exists', async () => {
    const assign = vi.fn()
    const reload = vi.fn()
    vi.stubGlobal('location', { href: window.location.href, origin: window.location.origin, assign, reload })
    try {
      const router = await renderPage()
      const scout = (await screen.findByText('Research lead')).closest('li')!
      expect(within(scout).getByText('scout')).toBeVisible()
      expect(within(scout).getByText('Finds sources.')).toBeVisible()
      // The active default profile has no Bot Chat and nothing to use or delete, so its menu only edits it (TAL-2093), and it still opens.
      const plain = screen.getByText('default').closest('li')!
      expect(within(plain).getByRole('link', { name: 'default' })).toHaveAttribute('href', '/settings/profiles?name=default')
      expect((await rowMenuItems(plain)).map((item) => item.textContent)).toEqual(['Edit'])
      await userEvent.keyboard('{Escape}')
      await userEvent.click((await rowMenuItems(scout)).find((item) => item.textContent === 'Open Bot Chat')!)
      expect(api.switchProfile).toHaveBeenCalledWith('scout')
      // The chat opens from the row the switch resolved, not the cached listing, through the router (TAL-2099).
      await vi.waitFor(() => { expect(router.state.location.pathname).toBe('/session/scout-live') })
      expect(await screen.findByText('Chat page')).toBeVisible()
      expect(assign).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('TAL-2084: offers Import agent setup in the header actions to an owner only', async () => {
    await renderPage()
    await screen.findByText('scout')
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Import agent setup' })).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Import agent setup' })).toHaveLength(1)
  })

  it('TAL-2084: hides Import agent setup from a non-owner', async () => {
    await renderPage({ ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: false } })
    await screen.findByText('scout')
    expect(screen.queryByRole('button', { name: 'Import agent setup' })).toBeNull()
  })
})

describe('profile detail (TAL-2085)', () => {
  it('opens from the profile name and shows every field the server sent, with Back to the list', async () => {
    const router = await renderPage()
    const row = (await screen.findByText('Research lead')).closest('li')!
    expect(within(row).queryByRole('button', { name: 'Use' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Delete this profile' })).toBeNull()
    await userEvent.click(within(row).getByRole('link', { name: /Research lead/ }))
    await vi.waitFor(() => { expect(router.state.location.search).toEqual({ name: 'scout' }) })
    const detail = document.querySelector<HTMLElement>('[data-profile-detail="scout"]')!
    expect(within(detail).getByText('Finds sources.')).toBeVisible()
    const value = (group: string, label: string) => within(within(detail).getByRole('region', { name: group })).getByText(label).nextElementSibling?.textContent
    expect(value('Model', 'Default model')).toBe('gpt-6-astra')
    expect(value('Model', 'Provider')).toBe('openai-codex')
    expect(value('Agent', 'Gateway')).toBe('Gateway parked')
    expect(value('Agent', 'Skills')).toBe('3 of 7')
    expect(value('Agent', 'API keys')).toBe('Configured')
    expect(value('Agent', 'Pending writes')).toBe('2')
    expect(value('Location', 'Path')).toBe('/home/u/.hermes/profiles/scout')
    // Not the active profile: no Models link; its actions sit beside the name.
    expect(within(detail).queryByRole('button', { name: 'Models settings' })).toBeNull()
    for (const name of ['Open Bot Chat', 'Use', 'Delete this profile']) expect(within(detail).getByRole('button', { name })).toBeVisible()
    // Reviews open against the active profile, so an inactive profile's count has no review link.
    expect(within(detail).queryByRole('button', { name: 'Review on Skills' })).toBeNull()
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }))
    await vi.waitFor(() => { expect(router.state.location.search).toEqual({}) })
    expect(await screen.findByRole('list')).toBeVisible()
  })

  it('renders a direct load of the active default profile with only the fields it has', async () => {
    const router = await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=default')
    const detail = (await screen.findByText('Active')).closest<HTMLElement>('[data-profile-detail="default"]')!
    expect(within(detail).getByText('Default')).toBeVisible()
    expect(within(detail).queryByRole('region', { name: 'Agent' })).toBeNull()
    expect(within(detail).queryByRole('region', { name: 'Location' })).toBeNull()
    expect(within(detail).queryByRole('button', { name: 'Delete this profile' })).toBeNull()
    expect(within(detail).queryByRole('button', { name: 'Use' })).toBeNull()
    await userEvent.click(within(detail).getByRole('button', { name: 'Models settings' }))
    await vi.waitFor(() => { expect(router.state.location.pathname).toBe('/settings/models') })
  })

  it('offers the active profile its pending-write reviews on Skills and on Memory', async () => {
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: [{ name: 'default', is_default: true, pending_writes: 1 }], active: 'default', single_profile_mode: false })
    const router = await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=default')
    expect(await screen.findByRole('button', { name: 'Review on Skills' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Review on Memory' }))
    await vi.waitFor(() => { expect(router.state.location.pathname).toBe('/memory') })
  })

  it('shows an error with a way back for an unknown profile name', async () => {
    const router = await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=ghost')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('No profile named "ghost".')
    await userEvent.click(within(alert).getByRole('button', { name: 'Back to Profiles' }))

    await vi.waitFor(() => { expect(router.state.location.search).toEqual({}) })
    expect(await screen.findByText('scout')).toBeVisible()
  })
})

describe('profile writes show their result at once (TAL-1179)', () => {
  it('removes a deleted profile at once after confirmation', async () => {
    vi.mocked(api.deleteProfile).mockReturnValue(new Promise(() => undefined))
    await renderPage()
    const scout = (await screen.findByText('scout')).closest('li')!
    await userEvent.click((await rowMenuItems(scout)).find((item) => item.textContent === 'Delete this profile')!)
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(api.deleteProfile).toHaveBeenCalledWith('scout')
    expect(screen.queryByText('scout')).toBeNull()
  })

  it('TAL-2085: deletes from the detail page and returns to the list at once', async () => {
    vi.mocked(api.deleteProfile).mockReturnValue(new Promise(() => undefined))
    const router = await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=scout')
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this profile' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(api.deleteProfile).toHaveBeenCalledWith('scout')
    await vi.waitFor(() => { expect(router.state.location.search).toEqual({}) })
    expect(await screen.findByText('default')).toBeVisible()
    expect(screen.queryByText('scout')).toBeNull()
  })

  it('closes New profile on Create and shows the profile at once', async () => {
    vi.mocked(api.createProfile).mockReturnValue(new Promise(() => undefined))
    await renderPage()
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
    await renderPage()
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
    await renderPage()
    await screen.findByText('scout')
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'writer{Enter}')
    await vi.waitFor(() => { expect(showErrorToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Selected model 'x' is not available" })) })
    expect(screen.queryByText('writer')).toBeNull()
  })
})

describe('profile edits show their result at once (TAL-2093)', () => {
  const scoutDetail = async () => {
    await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=scout')
    return (await screen.findByText('Finds sources.')).closest<HTMLElement>('[data-profile-detail="scout"]')!
  }
  const editDialog = async (detail: HTMLElement) => {
    await userEvent.click(within(detail).getByRole('button', { name: 'Edit' }))
    return screen.findByRole('dialog', { name: 'Edit scout' })
  }

  it('shows the saved name and description at once and keeps them after the reread', async () => {
    let finish: () => void = () => undefined
    vi.mocked(api.updateProfile).mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({ ok: true, profile: { name: 'scout' } }) }))
    const detail = await scoutDetail()
    const dialog = await editDialog(detail)
    const name = within(dialog).getByRole('textbox', { name: 'Display name' })
    expect(name).toHaveValue('Research lead')
    await userEvent.clear(name)
    await userEvent.type(name, ' Field agent ')
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Description' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Description' }), 'Reads the news.{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.updateProfile).toHaveBeenLastCalledWith({ name: 'scout', display_name: 'Field agent', description: 'Reads the news.' })
    expect(within(detail).getByText('Field agent')).toBeVisible()
    expect(within(detail).getByText('Reads the news.')).toBeVisible()
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: [{ name: 'default', is_default: true }, { name: 'scout', display_name: 'Field agent', description: 'Reads the news.' }], active: 'default', single_profile_mode: false })
    finish()
    await vi.waitFor(() => { expect(api.fetchProfiles).toHaveBeenCalledTimes(2) })
    expect(within(detail).getByText('Field agent')).toBeVisible()
    expect(within(detail).getByText('Reads the news.')).toBeVisible()
  })

  it('restores the previous values and shows the server error when the save is refused', async () => {
    vi.mocked(api.updateProfile).mockRejectedValueOnce(new Error('display_name must be at most 80 characters'))
    const detail = await scoutDetail()
    const dialog = await editDialog(detail)
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Description' }), ' More.{Enter}')
    await vi.waitFor(() => { expect(showErrorToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'display_name must be at most 80 characters' })) })
    expect(await within(detail).findByText('Finds sources.')).toBeVisible()
    expect(within(detail).queryByText('Finds sources. More.')).toBeNull()
  })

  it('locks the name behind a Bot Mode title and still saves the description', async () => {
    vi.mocked(api.updateProfile).mockReturnValueOnce(new Promise(() => undefined))
    vi.mocked(api.fetchProfiles).mockResolvedValueOnce({ profiles: [{ name: 'scout', display_name: 'Research lead', display_name_overridden: true, description: 'Finds sources.' }], active: 'default', single_profile_mode: false })
    const detail = await scoutDetail()
    const dialog = await editDialog(detail)
    expect(within(dialog).getByRole('textbox', { name: 'Display name' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'About Display name' }))
    expect(await screen.findByText("Bot Mode's roster title is shown instead of this name.")).toBeVisible()
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Description' }), ' Daily.{Enter}')
    expect(api.updateProfile).toHaveBeenLastCalledWith({ name: 'scout', description: 'Finds sources. Daily.' })
  })

  it('offers no Edit to a non-owner', async () => {
    await renderPage({ ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: false } }, '/settings/profiles?name=scout')
    expect(await screen.findByText('Finds sources.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('names the assistant on the default profile only', async () => {
    await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=default')
    const field = await screen.findByRole('textbox', { name: 'Assistant name' })
    await vi.waitFor(() => { expect(field).toHaveValue('Maude') })
    await userEvent.clear(field)
    await userEvent.type(field, 'Ada{Enter}')
    await vi.waitFor(() => { expect(api.saveSettings).toHaveBeenCalledWith({ bot_name: 'Ada' }) })
    cleanup()
    await renderPage(DEFAULT_BOOTSTRAP, '/settings/profiles?name=scout')
    expect(await screen.findByText('Finds sources.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Assistant name' })).toBeNull()
  })
})
