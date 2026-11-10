import { expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'

// Every endpoint but the settings read and write stays pending.
vi.mock('../../api/endpoints', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return { ...Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(() => new Promise(() => undefined)) : value])), saveSettings: vi.fn(), fetchSettings: vi.fn() }
})
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import { fetchSessions, fetchSettings, saveSettings, searchSessions } from '../../api/endpoints'
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

/** The six kinds of chats from outside Talaria Settings › Navigation lists, by their keys. */
const OUTSIDE = ['show_cli_sessions', 'show_claude_code_sessions', 'show_cron_sessions', 'show_webhook_sessions', 'show_kanban_sessions', 'show_previous_messaging_sessions']

/** What the real sidebar decides from the same settings: the destinations it shows. */
function RealSidebar() {
  const hidden = useSetting('hidden_tabs')
  return <output aria-label="sidebar destinations">{orderedNav(null, hidden ?? null).visible.map((n) => n.id).join(' ')}</output>
}

/** The open chat list and a sidebar search, read through the queries the sidebar uses. */
function ChatList() {
  const list = useQuery({ queryKey: keys.sessions.list({}), queryFn: () => fetchSessions() })
  const search = useQuery({ queryKey: keys.sessions.search('chat', {}), queryFn: () => searchSessions('chat', { project_id: undefined, sidebar_source: undefined, include_archived: false }) })
  return <>
    <output aria-label="chat list">{list.data?.sessions.map((r) => r.session_id).join(' ')}</output>
    <output aria-label="chat search">{search.data?.sessions.map((r) => r.session_id).join(' ')}</output>
  </>
}

async function renderNavigation(settings: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  qc.setQueryData(keys.settings, settings)
  // The server keeps what it accepts, so a reread after a write returns it.
  let stored = { ...settings }
  vi.mocked(fetchSettings).mockImplementation(() => Promise.resolve(stored))
  vi.mocked(saveSettings).mockImplementation((patch) => { stored = { ...stored, ...patch }; return Promise.resolve(stored) })
  await renderRouted(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><SettingsSection section="navigation" /><RealSidebar /><ChatList /></BootstrapContext.Provider></QueryClientProvider>)
  return { sidebar: within(await screen.findByRole('region', { name: 'Sidebar' })), outside: within(screen.getByRole('region', { name: 'Chats from outside Talaria' })) }
}
/** The server's counts of the sidebar items and outside chats shown, as every settings read and save carries them (TAL-2175). */
const counted = (sidebar: number, outside: number) => ({ sidebar_items_shown: sidebar, sidebar_items_total: 10, outside_chats_shown: outside, outside_chats_total: 6 })
const toggles = (scope: ReturnType<typeof within>): HTMLElement[] => scope.queryAllByRole('button').filter((b: HTMLElement) => b.hasAttribute('aria-pressed'))

it('draws every sidebar item nav.ts places, in order, as a toggle, counted in the header, and no destination switch (TAL-2145)', async () => {
  const { sidebar, outside } = await renderNavigation({ hidden_tabs: ['todos', 'logs'], show_sidebar_feedback: true, show_titlebar_profile: false, show_cli_sessions: true, show_cron_sessions: true, ...counted(8, 2) })
  expect(toggles(sidebar).map((b) => b.getAttribute('aria-label'))).toEqual(ITEMS.map((name) => `Show ${name}`))
  // Every destination `hidden_tabs` can hide is drawn once, so each key the old switches saved stays editable once.
  expect(NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map((n) => sidebar.getAllByRole('button', { name: `Show ${n.label()}` }).length)).toEqual(NAV_ITEMS.filter((n) => !FIXED_TABS.has(n.id)).map(() => 1))
  expect(toggles(sidebar).filter((b) => b.getAttribute('aria-pressed') === 'false').map((b) => b.getAttribute('aria-label'))).toEqual(['Show Todos', 'Show Profile switcher'])
  expect(sidebar.getByText('8 of 10 shown')).toBeInTheDocument()
  expect(outside.getByText('2 of 6 shown')).toBeInTheDocument()
  const switches = ['New-chat button per project', 'Terminal and desktop apps', 'Claude Code', 'Messaging apps', 'Only the latest chat per contact', 'Scheduled tasks', 'Webhooks', 'Kanban']
  expect(screen.getAllByRole('switch')).toEqual(switches.map((name) => screen.getByRole('switch', { name })))
})

it('shows the server\'s counts of the sidebar items and outside chats shown, not the drawing\'s (TAL-2175)', async () => {
  // Every item and outside chat is drawn shown, but each header shows the server's count, never one counted from the drawing.
  const { sidebar, outside } = await renderNavigation({ hidden_tabs: [], show_sidebar_feedback: true, show_titlebar_profile: true, ...Object.fromEntries(OUTSIDE.map((key) => [key, true])), ...counted(9, 5) })
  expect(toggles(sidebar).filter((b) => b.getAttribute('aria-pressed') === 'false')).toEqual([])
  expect(sidebar.getByText('9 of 10 shown')).toBeInTheDocument()
  expect(outside.getByText('5 of 6 shown')).toBeInTheDocument()
})

it('counts a hidden sidebar item at once, then keeps the server\'s count once it confirms the write (TAL-2175)', async () => {
  const held = deferred<Record<string, unknown>>()
  const { sidebar } = await renderNavigation({ hidden_tabs: [], ...counted(8, 2) })
  vi.mocked(saveSettings).mockReturnValue(held.promise)
  await userEvent.click(sidebar.getByRole('button', { name: 'Show Kanban' }))
  expect(sidebar.getByText('7 of 10 shown')).toBeInTheDocument()
  // Another tab hid Skills meanwhile; the server's count of both follows the confirmation.
  const stored = { hidden_tabs: ['kanban', 'skills'], ...counted(6, 2) }
  vi.mocked(fetchSettings).mockResolvedValue(stored)
  held.resolve(stored)
  expect(await sidebar.findByText('6 of 10 shown')).toBeInTheDocument()
  expect(sidebar.getByRole('button', { name: 'Show Skills' })).toHaveAttribute('aria-pressed', 'false')
})

it('hides a destination at once, saves hidden_tabs and the sidebar follows; a refusal rolls it back with the error (TAL-2145)', async () => {
  const held = deferred<Record<string, unknown>>()
  const { sidebar } = await renderNavigation({ hidden_tabs: [], ...counted(8, 2) })
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
})

it('counts an outside chat switch at once, keeps the server\'s count once it confirms, and returns to it on a refusal (TAL-2145, TAL-2175)', async () => {
  const { outside } = await renderNavigation({ show_kanban_sessions: true, ...counted(8, 1) })
  expect(outside.getByText('1 of 6 shown')).toBeInTheDocument()
  const confirmed = deferred<Record<string, unknown>>()
  vi.mocked(saveSettings).mockReturnValue(confirmed.promise)
  await userEvent.click(outside.getByRole('switch', { name: 'Webhooks' }))
  expect(outside.getByText('2 of 6 shown')).toBeInTheDocument()
  expect(saveSettings).toHaveBeenLastCalledWith({ show_webhook_sessions: true })
  const stored = { show_kanban_sessions: true, show_webhook_sessions: true, ...counted(8, 2) }
  vi.mocked(fetchSettings).mockResolvedValue(stored)
  confirmed.resolve(stored)
  await waitFor(() => expect(outside.getByRole('switch', { name: 'Webhooks' })).toBeChecked())
  expect(outside.getByText('2 of 6 shown')).toBeInTheDocument()
  const refused = deferred<Record<string, unknown>>()
  vi.mocked(saveSettings).mockReturnValue(refused.promise)
  await userEvent.click(outside.getByRole('switch', { name: 'Scheduled tasks' }))
  expect(outside.getByText('3 of 6 shown')).toBeInTheDocument()
  const message = 'config.yaml is package-managed. Update the declarative configuration instead.'
  refused.reject(new ApiError({ kind: 'http', status: 409, path: 'api/settings', message, body: { error: message, condition: 'config_write_refused' } }))
  expect(await outside.findByText('2 of 6 shown')).toBeInTheDocument()
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, 4000, 'error'))
})

it('shows "Only the latest chat per contact" as the inverse of show_previous_messaging_sessions, disabled while Messaging apps is off (TAL-2159)', async () => {
  const { outside } = await renderNavigation({ show_messaging_sessions: false, show_previous_messaging_sessions: false, ...counted(8, 0) })
  const latest = outside.getByRole('switch', { name: 'Only the latest chat per contact' })
  expect(latest).toBeChecked()
  expect(latest).toHaveAttribute('aria-disabled', 'true')
  expect(outside.getByText('0 of 6 shown')).toBeInTheDocument()
  await userEvent.click(outside.getByRole('switch', { name: 'Messaging apps' }))
  expect(saveSettings).toHaveBeenLastCalledWith({ show_messaging_sessions: true })
  await waitFor(() => expect(latest).not.toHaveAttribute('aria-disabled'))
  await userEvent.click(latest)
  expect(saveSettings).toHaveBeenLastCalledWith({ show_previous_messaging_sessions: true })
  expect(latest).not.toBeChecked()
})

it('re-reads the open chat list and sidebar searches when an outside-chats switch changes, without a reload (TAL-2159)', async () => {
  const reads = () => { const answers = [['web', 'tg'], ['web']]; return () => Promise.resolve({ sessions: (answers.shift() ?? []).map((session_id) => ({ session_id })) } as never) }
  vi.mocked(fetchSessions).mockImplementation(reads())
  vi.mocked(searchSessions).mockImplementation(reads())
  const { outside } = await renderNavigation({ show_messaging_sessions: true })
  const list = screen.getByRole('status', { name: 'chat list' })
  const search = screen.getByRole('status', { name: 'chat search' })
  await waitFor(() => { expect(list).toHaveTextContent('web tg'); expect(search).toHaveTextContent('web tg') })
  await userEvent.click(outside.getByRole('switch', { name: 'Messaging apps' }))
  await waitFor(() => { expect(list).toHaveTextContent(/^web$/); expect(search).toHaveTextContent(/^web$/) })
  expect([vi.mocked(fetchSessions).mock.calls.length, vi.mocked(searchSessions).mock.calls.length]).toEqual([2, 2])
})
