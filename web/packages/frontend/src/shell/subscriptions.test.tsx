import { act, render, screen } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { keys } from '../api/queryKeys'
import { Rail } from './Rail'
import { Titlebar } from './Titlebar'
import { Tabbar } from './Tabbar'
import { MobileNav } from './MobileNav'

const { rendered } = vi.hoisted(() => ({ rendered: vi.fn() }))
vi.mock('../i18n/useLocale', () => ({ useLocale: () => { rendered(); return 'en' } }))
vi.mock('../app/bootstrap', () => ({ useBootstrap: () => { rendered(); return { bot_name: 'Fixture', features: {} } } }))
vi.mock('../features/sessions/useNewChat', () => ({ useNewChat: () => vi.fn() }))
vi.mock('./ProfileMenu', () => ({ ProfileMenu: () => null }))
vi.mock('../features/notifications/UpdateNotificationCenter', () => ({ UpdateNotificationCenterButton: () => null }))
vi.mock('../extensions/registry', () => ({ useExtensionManifests: () => ({ data: { manifests: [{ id: 'fixture', enabled: true, name: 'Fixture', panel: {}, nav: {} }] } }) }))
vi.mock('../app/queries', async (original) => ({ ...await original<object>(), useDashboardStatusQuery: () => ({ data: {} }) }))
vi.mock('./useShellState', async (original) => ({ ...await original<object>(), useIsDesktop: () => true }))

beforeEach(() => { vi.clearAllMocks(); window.scrollTo = vi.fn() })

async function setup(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.settings, { hidden_tabs: [] })
  const root = createRootRoute({ component: () => <QueryClientProvider client={client}><Component /><Outlet /></QueryClientProvider> })
  const paths = ['/', '/session/$sessionId', '/settings', '/ext/$extensionId'] as const
  const routeTree = root.addChildren(paths.map((path) => createRoute({ getParentRoute: () => root, path, component: () => <p>Route content</p> })))
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/session/first'] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

it.each([{ name: 'Rail', Component: Rail }, { name: 'Titlebar', Component: Titlebar }, { name: 'Tabbar', Component: Tabbar }, { name: 'MobileNav', Component: MobileNav }])('$name does not render for session or search changes but updates its active panel', async ({ Component }) => {
  const router = await setup(Component)
  const before = rendered.mock.calls.length
  await act(async () => { await router.navigate({ to: '/session/$sessionId', params: { sessionId: 'second' } }) })
  expect(rendered).toHaveBeenCalledTimes(before)
  await act(async () => { await router.navigate({ to: '/session/$sessionId', params: { sessionId: 'second' }, search: { fixture: 'changed' } as never }) })
  expect(rendered).toHaveBeenCalledTimes(before)
  await act(async () => { await router.navigate({ to: '/settings' }) })
  expect(rendered.mock.calls.length).toBeGreaterThan(before)
})

it('keeps the titlebar session control scoped to session routes', async () => {
  const router = await setup(Titlebar)
  expect(document.querySelector('#btnTitlebarSidePanel')).toBeInTheDocument()
  await act(async () => { await router.navigate({ to: '/' }) })
  expect(document.querySelector('#btnTitlebarSidePanel')).not.toBeInTheDocument()
})

it('keeps extension navigation highlighted for the selected extension', async () => {
  const router = await setup(Rail)
  await act(async () => { await router.navigate({ to: '/ext/$extensionId', params: { extensionId: 'fixture' } }) })
  expect(screen.getByRole('link', { name: 'Fixture' })).toHaveAttribute('aria-current', 'page')
})
