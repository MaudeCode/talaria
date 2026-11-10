import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api/endpoints'
import { keys } from '../api/queryKeys'
import { useSaveSettings } from '../app/settings'
import { BootstrapContext, bootstrapStatus, setBootstrapForTests, subscribeBootstrap } from '../app/bootstrap'
import { ApiError } from '../contracts'
import { DEFAULT_BOOTSTRAP } from '../contracts/adapters/memory'
import type { Bootstrap } from '../contracts/bootstrap'
import { deferred } from '../test/fixtures'
import { Sidebar } from './Sidebar'
import { closeMobileSidebar, toggleMobileSidebar, toggleSidebarCollapsed } from './useShellState'

vi.mock('../features/sessions/useNewChat', () => ({ useNewChat: () => vi.fn() }))
vi.mock('../features/notifications/UpdateNotificationCenter', () => ({ UpdateNotificationCenterButton: () => null }))
vi.mock('../extensions/registry', () => ({ useExtensionManifests: () => ({ data: { manifests: [] } }) }))
vi.mock('../api/endpoints', async (original) => ({ ...await original<object>(), saveSettings: vi.fn(), fetchSettings: vi.fn() }))
vi.mock('../app/queries', async (original) => ({ ...await original<object>(), useDashboardStatusQuery: () => ({ data: {} }) }))

type Layout = 'expanded' | 'rail' | 'drawer'
const MESSAGE = 'This instance is accessible without authentication.'

function bootstrap(auth: Partial<Bootstrap['auth']>): Bootstrap {
  return { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, auth_enabled: false, logged_in: false, password_auth_enabled: false, no_password_warning: 'error', ...auth } }
}

// The app's provider (client.tsx): a bootstrap reload re-renders the shell without a page load.
function LiveBootstrap({ children }: { children: ReactNode }) {
  const status = useSyncExternalStore(subscribeBootstrap, bootstrapStatus)
  return status?.state === 'ready' ? <BootstrapContext.Provider value={status.data}>{children}</BootstrapContext.Provider> : null
}

// The Access switch's write, as `SettingToggle` sends it.
function AckWriter() {
  const save = useSaveSettings()
  return <button type="button" onClick={() => { save.mutate({ auth_disabled_acknowledged: true }, { onError: () => undefined }) }}>Acknowledge</button>
}

async function renderSidebar(layout: Layout, boot: Bootstrap, settings: Record<string, unknown> = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: layout !== 'drawer' && query.includes('min-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  toggleSidebarCollapsed(layout === 'rail')
  if (layout === 'drawer') toggleMobileSidebar()
  setBootstrapForTests(boot)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.settings, { hidden_tabs: [], ...settings })
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><LiveBootstrap><Sidebar panel={null} /><AckWriter /></LiveBootstrap><Outlet /></QueryClientProvider> })
  const routeTree = root.addChildren(['/', '/settings/$section'].map((path) => createRoute({ getParentRoute: () => root, path, component: () => null })))
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  render(<RouterProvider router={router} />)
}

const warning = () => screen.queryByRole('link', { name: 'No password' })

beforeEach(() => { window.scrollTo = vi.fn(); vi.mocked(api.fetchSettings).mockResolvedValue({ hidden_tabs: [], auth_disabled_acknowledged: true }) })
afterEach(() => { toggleSidebarCollapsed(false); closeMobileSidebar() })

it.each<Layout>(['expanded', 'rail', 'drawer'])('TAL-2158: the %s sidebar warns an owner in the error colour that the server has no password, linking to Access', async (layout) => {
  await renderSidebar(layout, bootstrap({}))
  const link = await screen.findByRole('link', { name: 'No password' })
  expect(link).toHaveAccessibleDescription(MESSAGE)
  expect(link).toHaveAttribute('href', '/settings/access')
  expect(link).toHaveAttribute('data-tone', 'error')
  expect(link).not.toHaveClass('sidebar-icon-row')
  // Reachable by keyboard in every state: nothing around it is inert or hidden.
  expect(link.closest('[inert], [aria-hidden="true"]')).toBeNull()
  link.focus()
  expect(link).toHaveFocus()
})

it.each<Layout>(['expanded', 'rail', 'drawer'])('TAL-2158: once acknowledged, the %s sidebar keeps the warning as a warning-coloured icon with its tooltip', async (layout) => {
  await renderSidebar(layout, bootstrap({ no_password_warning: 'warning' }))
  const link = await screen.findByRole('link', { name: 'No password' })
  expect(link).toHaveAttribute('data-tone', 'warning')
  expect(link).toHaveClass('sidebar-icon-row', 'has-tooltip')
  expect(link).toHaveAttribute('data-tooltip', 'No password')
  expect(link).toHaveAccessibleDescription(MESSAGE)
})

const tone = () => screen.getByRole('link', { name: 'No password' }).getAttribute('data-tone')

it('TAL-2158: confirmed settings that disagree with bootstrap (another tab\'s write) never override the server level', async () => {
  await renderSidebar('expanded', bootstrap({ no_password_warning: 'error' }), { auth_disabled_acknowledged: true })
  await screen.findByRole('link', { name: 'No password' })
  expect(tone()).toBe('error')
})

it('TAL-2158: this tab\'s acknowledgement shows at once, holds through its save, and hands over to the server level once bootstrap rereads', async () => {
  const save = deferred<{ ok: boolean; auth_disabled_acknowledged: boolean }>()
  vi.mocked(api.saveSettings).mockReturnValue(save.promise)
  await renderSidebar('expanded', bootstrap({ no_password_warning: 'error' }), { auth_disabled_acknowledged: false })
  await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
  expect(tone()).toBe('warning')
  await act(async () => { save.resolve({ ok: true, auth_disabled_acknowledged: true }); await save.promise })
  await waitFor(() => expect(api.fetchSettings).toHaveBeenCalled())
  expect(tone()).toBe('warning')
  act(() => { setBootstrapForTests(bootstrap({ no_password_warning: 'warning', auth_disabled_acknowledged: true })) })
  expect(tone()).toBe('warning')
  // From here the server decides, even against this tab's last write.
  act(() => { setBootstrapForTests(bootstrap({ no_password_warning: 'error' })) })
  expect(tone()).toBe('error')
})

it('TAL-2158: a refused acknowledgement rolls back to the server level', async () => {
  vi.mocked(api.saveSettings).mockRejectedValue(new ApiError({ kind: 'http', status: 400, path: '/api/settings', message: 'Refused' }))
  await renderSidebar('expanded', bootstrap({ no_password_warning: 'error' }), { auth_disabled_acknowledged: false })
  await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
  await waitFor(() => expect(tone()).toBe('error'))
})

it('TAL-2158: no warning when the server reports none, whatever the raw auth fields say', async () => {
  await renderSidebar('expanded', bootstrap({ auth_enabled: false, can_manage_server: true, no_password_warning: null }))
  await screen.findByRole('navigation', { name: 'Primary navigation' })
  expect(warning()).toBeNull()
})

it('TAL-2158: setting a password removes the warning when bootstrap is reread, without a reload', async () => {
  await renderSidebar('expanded', bootstrap({}))
  await screen.findByRole('link', { name: 'No password' })
  act(() => { setBootstrapForTests(bootstrap({ auth_enabled: true, password_auth_enabled: true, no_password_warning: null })) })
  expect(warning()).toBeNull()
})
