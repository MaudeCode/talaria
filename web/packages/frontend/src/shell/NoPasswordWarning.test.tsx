import { act, render, screen } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSyncExternalStore, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { keys } from '../api/queryKeys'
import { BootstrapContext, bootstrapStatus, setBootstrapForTests, subscribeBootstrap } from '../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../contracts/adapters/memory'
import type { Bootstrap } from '../contracts/bootstrap'
import { Sidebar } from './Sidebar'
import { closeMobileSidebar, toggleMobileSidebar, toggleSidebarCollapsed } from './useShellState'

vi.mock('../features/sessions/useNewChat', () => ({ useNewChat: () => vi.fn() }))
vi.mock('../features/notifications/UpdateNotificationCenter', () => ({ UpdateNotificationCenterButton: () => null }))
vi.mock('../extensions/registry', () => ({ useExtensionManifests: () => ({ data: { manifests: [] } }) }))
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

async function renderSidebar(layout: Layout, boot: Bootstrap, settings: Record<string, unknown> = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: layout !== 'drawer' && query.includes('min-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  toggleSidebarCollapsed(layout === 'rail')
  if (layout === 'drawer') toggleMobileSidebar()
  setBootstrapForTests(boot)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.settings, { hidden_tabs: [], ...settings })
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><LiveBootstrap><Sidebar panel={null} /></LiveBootstrap><Outlet /></QueryClientProvider> })
  const routeTree = root.addChildren(['/', '/settings/$section'].map((path) => createRoute({ getParentRoute: () => root, path, component: () => null })))
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  render(<RouterProvider router={router} />)
}

const warning = () => screen.queryByRole('link', { name: 'No password' })

beforeEach(() => { window.scrollTo = vi.fn() })
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

it.each([
  { flipped: true, server: 'error', shown: 'warning' },
  { flipped: false, server: 'warning', shown: 'error' },
] as const)('TAL-2158: flipping the Access switch to $flipped shows $shown at once, over the server level $server until bootstrap rereads', async ({ flipped, server, shown }) => {
  await renderSidebar('expanded', bootstrap({ no_password_warning: server }), { auth_disabled_acknowledged: flipped })
  expect(await screen.findByRole('link', { name: 'No password' })).toHaveAttribute('data-tone', shown)
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
