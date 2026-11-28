import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import type { LogEntry, Logs } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), fetchLogs: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
import { parseAppSearch, SettingsSearchSchema, stringifyAppSearch } from '../../contracts/url'
import { showToast } from '../toast/toast'
import { m } from '../../paraglide/messages.js'
import { LogsPage } from './LogsPage'

const FILES = [{ id: 'agent', exists: true, total_bytes: 900 }, { id: 'webui', exists: false, total_bytes: null }, { id: 'gateway', exists: true, total_bytes: 10 }, { id: 'errors', exists: true, total_bytes: 5 }]
const ENTRIES: LogEntry[] = [
  { time: '12:01:03', level: 'info', text: 'gateway connected to telegram' },
  { time: '12:03:40', level: 'error', text: 'mcp server "linear" failed to connect: 401' },
  { time: null, level: 'error', text: 'Traceback (most recent call last):' },
  { time: '12:04:19', level: 'warning', text: 'plugin web-exa missing EXA_API_KEY' },
]
const answer = (entries: LogEntry[], extra: Partial<Logs> = {}): Logs => ({
  file: 'agent', tail: 500, lines: entries.map((e) => e.text), hint: '', files: FILES, entries, counts: { error: 2, warning: 1, lines: 4 }, count_tones: { error: 'error', warning: null }, matched: entries.length, ...extra,
})
const fetchLogs = vi.mocked(api.fetchLogs)

/** The route in a pane that scrolls, with the layout jsdom lacks: a 200px viewport over `height` px of lines. */
function renderInPane(path = '/settings/logs') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const layout = { top: 0, height: 1000 }
  function setPane(pane: HTMLDivElement | null) {
    if (!pane) return
    Object.defineProperties(pane, {
      scrollTop: { configurable: true, get: () => layout.top, set: (v: number) => { layout.top = Math.min(v, layout.height - 200) } },
      scrollHeight: { configurable: true, get: () => layout.height },
      clientHeight: { configurable: true, value: 200 },
    })
  }
  const root = createRootRoute()
  const app = createRoute({ getParentRoute: () => root, id: '_app', component: Outlet })
  const section = createRoute({ getParentRoute: () => app, path: '/settings/$section', validateSearch: SettingsSearchSchema, component: () => <div ref={setPane} data-testid="pane" style={{ overflowY: 'auto' }}><LogsPage /></div> })
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([section])]), history, parseSearch: parseAppSearch, stringifySearch: stringifyAppSearch })
  const view = render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return { ...view, history, layout }
}

const openFilters = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: m.logs_filters() }))
  return screen.findByRole('menu')
}

beforeEach(() => { fetchLogs.mockReset() })
afterEach(() => { vi.useRealTimers() })

it('reads the source, severity, query and tail of a bookmarked Logs view (TAL-2766)', async () => {
  fetchLogs.mockResolvedValue(answer(ENTRIES, { file: 'gateway', tail: 1000 }))
  const { history } = renderInPane('/settings/logs?file=gateway&level=error&query=401&tail=1000')

  await waitFor(() => expect(fetchLogs).toHaveBeenCalledWith('gateway', 1000, '401', 'error'))
  const clearQuery = m.logs_clear_filter({ value: '401' })
  const user = userEvent.setup()
  const menu = await openFilters(user)
  expect(within(menu).getByRole('searchbox')).toHaveValue('401')
  for (const name of [m.logs_file_gateway(), m.logs_severity_errors(), m.logs_last_lines({ n: (1000).toLocaleString() })]) {
    expect(within(menu).getByRole('menuitemradio', { name })).toBeChecked()
  }
  await user.keyboard('{Escape}')
  await user.click(await screen.findByRole('button', { name: clearQuery }))
  await waitFor(() => expect(fetchLogs).toHaveBeenLastCalledWith('gateway', 1000, '', 'error'))
  expect(new URLSearchParams(history.location.search).has('query')).toBe(false)

  act(() => history.back())
  expect(await screen.findByRole('button', { name: clearQuery })).toBeVisible()
  act(() => history.forward())
  await waitFor(() => expect(screen.queryByRole('button', { name: clearQuery })).toBeNull())
})

it('uses the default level and tail for unsupported URL values (TAL-2766)', async () => {
  fetchLogs.mockResolvedValue(answer(ENTRIES))
  renderInPane('/settings/logs?level=info&tail=5000')
  await waitFor(() => expect(fetchLogs).toHaveBeenCalledWith('agent', 500, '', undefined))
})

it('keeps the last read visible when Follow fails and clears the error after Retry (TAL-2764)', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-27T12:00:00Z') })
  fetchLogs.mockResolvedValueOnce(answer(ENTRIES))
    .mockRejectedValueOnce(new Error('Log read unavailable'))
    .mockResolvedValue(answer([{ time: '12:05:00', level: 'info', text: 'log read recovered' }]))
  const { container } = renderInPane()
  const updated = () => container.querySelector('[data-stat="updated"] dd')?.textContent

  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText(ENTRIES[0]!.text)).toBeVisible()
  const lastRead = updated()
  expect(lastRead).toBeTruthy()

  await act(() => vi.advanceTimersByTimeAsync(15_000))
  const alert = screen.getByRole('alert')
  expect(within(screen.getByRole('list', { name: m.logs_file_agent() })).getAllByRole('listitem')).toHaveLength(ENTRIES.length)
  expect(screen.getByText(ENTRIES[0]!.text)).toBeVisible()
  expect(updated()).toBe(lastRead)

  fireEvent.click(within(alert).getByRole('button', { name: m.retry() }))
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText('log read recovered')).toBeVisible()
  expect(updated()).toBeTruthy()
  expect(updated()).not.toBe(lastRead)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('stops refetching and moving once the reader scrolls up; following keeps the newest line in view (TAL-2139)', async () => {
  vi.useFakeTimers()
  // React Query batches its notifications on a short timer.
  const flush = () => act(() => vi.advanceTimersByTimeAsync(100))
  fetchLogs.mockResolvedValue(answer(ENTRIES))
  const { layout } = renderInPane()
  await flush()
  expect(fetchLogs).toHaveBeenCalledTimes(1)
  const pane = screen.getByTestId('pane')

  // Scrolling up to read: the next intervals neither refetch nor move the view.
  pane.scrollTop = 300
  fireEvent.scroll(pane)
  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(fetchLogs).toHaveBeenCalledTimes(1)
  expect(pane.scrollTop).toBe(300)
  const follow = screen.getByRole('switch', { name: m.logs_follow() })
  expect(follow.getAttribute('aria-checked')).toBe('false')

  // Turning Follow on goes to the end; each interval then brings new lines and stays there.
  fireEvent.click(follow)
  await flush()
  expect(pane.scrollTop).toBe(800)
  fetchLogs.mockResolvedValue(answer([...ENTRIES, { time: '12:05:00', level: 'info', text: 'turn finished' }]))
  layout.height = 1100
  await act(() => vi.advanceTimersByTimeAsync(15_000))
  await flush()
  expect(screen.getByText('turn finished')).toBeTruthy()
  expect(pane.scrollTop).toBe(900)
})

it('sends the level and search to the server and shows its matches, count and figures (TAL-2139)', async () => {
  fetchLogs.mockImplementation((_file, _tail, q, level) => Promise.resolve(
    level === 'error' ? answer(ENTRIES.filter((e) => e.level === 'error'))
      : q ? answer([{ ...ENTRIES[1]!, matches: [[0, 3]] }])
        : answer(ENTRIES),
  ))
  const { container } = renderInPane()
  await screen.findByText('gateway connected to telegram')
  const stats = container.querySelector('[data-settings-stats]')!
  expect([...stats.querySelectorAll('[data-stat]')].map((s) => [s.getAttribute('data-stat'), s.querySelector('dd')?.textContent])).toEqual([['errors', '2'], ['warnings', '1'], ['lines', '4'], ['updated', expect.any(String)]])
  // The server's tones colour the figures: here it marked errors and not warnings.
  expect([...stats.querySelectorAll('[data-stat] dd .text-error, [data-stat] dd .text-warning')].map((el) => el.closest('[data-stat]')?.getAttribute('data-stat'))).toEqual(['errors'])
  // Level tokens tell warning and error lines apart without colour.
  expect([...container.querySelectorAll('[data-log-lines] li')].map((li) => li.children[1]?.textContent)).toEqual(['INFO', 'ERROR', 'ERROR', 'WARN'])
  expect(screen.getByRole('status').textContent).toContain('Last 4 lines')

  const user = userEvent.setup()
  const menu = await openFilters(user)
  await user.click(within(menu).getByRole('menuitemradio', { name: m.logs_severity_errors() }))
  await screen.findByText('2 matching lines in the last 4', { exact: false })
  expect(fetchLogs).toHaveBeenLastCalledWith('agent', 500, '', 'error')
  expect(container.querySelectorAll('[data-log-lines] li')).toHaveLength(2)

  await user.click(screen.getByRole('button', { name: m.logs_clear_filter({ value: m.logs_severity_errors() }) }))
  const searchMenu = await openFilters(user)
  const search = within(searchMenu).getByRole('searchbox', { name: m.logs_search() })
  await user.type(search, 'mcp')
  expect(search).toHaveValue('mcp')
  await screen.findByText('1 matching lines in the last 4', { exact: false })
  expect(fetchLogs).toHaveBeenLastCalledWith('agent', 500, 'mcp', undefined)
  expect([...container.querySelectorAll('[data-log-lines] mark')].map((mark) => mark.textContent)).toEqual(['mcp'])

  // Clearing the search restores the tail.
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: m.logs_clear_filter({ value: 'mcp' }) }))
  await screen.findByText('Last 4 lines', { exact: false })
  expect(container.querySelectorAll('[data-log-lines] li')).toHaveLength(4)
})

it('lists sources from the server, shows a missing log as empty and copies the shown lines (TAL-2139)', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  fetchLogs.mockImplementation((file, tail) => Promise.resolve(file === 'webui'
    ? answer([], { file, lines: [], hint: 'Log file for webui not found yet.', counts: { error: 0, warning: 0, lines: 0 }, matched: 0 })
    : answer(ENTRIES, { tail })))
  renderInPane()
  await screen.findByText(ENTRIES[0]!.text)

  await userEvent.click(screen.getByRole('button', { name: m.copy() }))
  expect(writeText).toHaveBeenCalledWith('12:01:03 INFO gateway connected to telegram\n12:03:40 ERROR mcp server "linear" failed to connect: 401\nERROR Traceback (most recent call last):\n12:04:19 WARN plugin web-exa missing EXA_API_KEY')
  expect(showToast).toHaveBeenCalledWith(m.copied())

  const user = userEvent.setup()
  const menu = await openFilters(user)
  const sources = within(menu).getByRole('group', { name: m.logs_file_label() })
  // An id the page has no label for shows the id.
  expect(within(sources).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['Agent', 'Web', 'Gateway', 'errors'])
  await user.click(within(sources).getByRole('menuitemradio', { name: 'Web' }))
  expect(await screen.findByText('Log file for webui not found yet.')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('switch', { name: m.logs_follow() })).toBeNull()
  Reflect.deleteProperty(navigator, 'clipboard')
})
