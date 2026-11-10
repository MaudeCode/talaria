import { expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Every endpoint but the settings read and write stays pending.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(() => new Promise(() => undefined)) : value])), saveSettings: vi.fn(), fetchSettings: vi.fn() }
})
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import { fetchSettings, saveSettings } from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { BootstrapContext } from '../../app/bootstrap'
import { useSetting } from '../../app/queries'
import { ApiError } from '../../contracts/common'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { FIXED_TABS, NAV_ITEMS, SIDEBAR_MORE, SIDEBAR_PRIMARY, orderedNav } from '../../shell/nav'
import { renderRouted } from '../../test/router'
import { deferred } from '../../test/fixtures'
import { showToast } from '../toast/toast'
import { SettingsSection } from './SettingsSection'

/** The destinations `shell/nav.ts` places in the sidebar, in its order, then its two buttons: what the drawing must toggle. */
const ITEMS = [...[...SIDEBAR_PRIMARY, ...SIDEBAR_MORE].flatMap((slot) => NAV_ITEMS.filter((n) => n.id === slot).map((n) => n.label())), 'Feedback', 'Profile switcher']

/** What the real sidebar decides from the same settings: the destinations it shows. */
function RealSidebar() {
  const hidden = useSetting('hidden_tabs')
  return <output aria-label="sidebar destinations">{orderedNav(null, hidden ?? null).visible.map((n) => n.id).join(' ')}</output>
}

async function renderNavigation(settings: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  qc.setQueryData(keys.settings, settings)
  // The server keeps what it accepts, so a reread after a write returns it.
  let stored = { ...settings }
  vi.mocked(fetchSettings).mockImplementation(() => Promise.resolve(stored))
  vi.mocked(saveSettings).mockImplementation((patch) => { stored = { ...stored, ...patch }; return Promise.resolve(stored) })
  await renderRouted(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SettingsSection section="navigation" /><RealSidebar /></BootstrapContext.Provider></QueryClientProvider>)
  return { sidebar: within(await screen.findByRole('region', { name: 'Sidebar' })), outside: within(screen.getByRole('region', { name: 'Chats from outside Talaria' })) }
}
const toggles = (scope: ReturnType<typeof within>): HTMLElement[] => scope.queryAllByRole('button').filter((b: HTMLElement) => b.hasAttribute('aria-pressed'))

it('draws every sidebar item nav.ts places, in order, as a toggle, counted in the header, and no destination switch (TAL-2145)', async () => {
  const { sidebar, outside } = await renderNavigation({ hidden_tabs: ['todos', 'logs'], show_sidebar_feedback: true, show_titlebar_profile: false, show_cli_sessions: true, show_cron_sessions: true })
  expect(toggles(sidebar).map((b) => b.getAttribute('aria-label'))).toEqual(ITEMS.map((name) => `Show ${name}`))
  // Every destination `hidden_tabs` can hide is drawn once, so each key the old switches saved stays editable once.
  expect(NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map((n) => sidebar.getAllByRole('button', { name: `Show ${n.label()}` }).length)).toEqual(NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map(() => 1))
  expect(toggles(sidebar).filter((b) => b.getAttribute('aria-pressed') === 'false').map((b) => b.getAttribute('aria-label'))).toEqual(['Show Todos', 'Show Profile switcher'])
  // A stored entry naming no destination (TAL-2101) is not counted.
  expect(sidebar.getByText('8 of 10 shown')).toBeInTheDocument()
  expect(outside.getByText('2 of 6 shown')).toBeInTheDocument()
  const switches = ['New-chat button per project', 'Show CLI and other external sessions', 'Show Claude Code sessions', 'Show previous messaging sessions', 'Show cron sessions', 'Show webhook sessions', 'Show kanban sessions']
  expect(screen.getAllByRole('switch')).toEqual(switches.map((name) => screen.getByRole('switch', { name })))
})

it('hides a destination at once, saves hidden_tabs and the sidebar follows; a refusal rolls it back with the error (TAL-2145)', async () => {
  const held = deferred<Record<string, unknown>>()
  const { sidebar } = await renderNavigation({ hidden_tabs: [] })
  const destinations = screen.getByRole('status', { name: 'sidebar destinations' })
  expect(destinations).toHaveTextContent('kanban')
  vi.mocked(saveSettings).mockReturnValue(held.promise)
  const kanban = sidebar.getByRole('button', { name: 'Show Kanban' })
  expect(kanban).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(kanban)
  expect(kanban).toHaveAttribute('aria-pressed', 'false')
  expect(sidebar.getByText('7 of 10 shown')).toBeInTheDocument()
  expect(destinations).not.toHaveTextContent('kanban')
  expect(saveSettings).toHaveBeenCalledWith({ hidden_tabs: ['kanban'] })
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  held.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  await waitFor(() => expect(kanban).toHaveAttribute('aria-pressed', 'true'))
  expect(destinations).toHaveTextContent('kanban')
  expect(sidebar.getByText('8 of 10 shown')).toBeInTheDocument()
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 4000, 'error'))
})

it('reaches and toggles every sidebar item from the keyboard, the buttons saving their own keys (TAL-2145)', async () => {
  const { sidebar } = await renderNavigation({ hidden_tabs: ['skills'] })
  sidebar.getByRole('button', { name: `Show ${ITEMS[0]}` }).focus()
  for (const [i, name] of ITEMS.entries()) {
    if (i > 0) await userEvent.tab()
    expect(sidebar.getByRole('button', { name: `Show ${name}` })).toHaveFocus()
  }
  await userEvent.keyboard(' ')
  expect(saveSettings).toHaveBeenLastCalledWith({ show_titlebar_profile: true })
  await userEvent.tab({ shift: true })
  await userEvent.keyboard('{Enter}')
  expect(saveSettings).toHaveBeenLastCalledWith({ show_sidebar_feedback: true })
  sidebar.getByRole('button', { name: 'Show Skills' }).focus()
  await userEvent.keyboard('{Enter}')
  expect(saveSettings).toHaveBeenLastCalledWith({ hidden_tabs: [] })
  expect(sidebar.getByText('10 of 10 shown')).toBeInTheDocument()
})

it('counts the outside chats shown as their switches change (TAL-2145)', async () => {
  const { outside } = await renderNavigation({ show_kanban_sessions: true })
  expect(outside.getByText('1 of 6 shown')).toBeInTheDocument()
  await userEvent.click(outside.getByRole('switch', { name: 'Show webhook sessions' }))
  expect(outside.getByText('2 of 6 shown')).toBeInTheDocument()
  expect(saveSettings).toHaveBeenLastCalledWith({ show_webhook_sessions: true })
})
