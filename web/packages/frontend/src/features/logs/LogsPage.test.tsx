import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LogEntry, Logs } from '@maudecode/talaria-web-contracts'

vi.mock('../../api/endpoints', async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), fetchLogs: vi.fn() }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
import * as api from '../../api/endpoints'
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
  file: 'agent', tail: 500, lines: entries.map((e) => e.text), hint: '', files: FILES, entries, counts: { error: 2, warning: 1, lines: 4 }, matched: entries.length, ...extra,
})
const fetchLogs = vi.mocked(api.fetchLogs)

/** The page in a pane that scrolls, with the layout jsdom lacks: a 200px viewport over `height` px of lines. */
function renderInPane() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={qc}><div data-testid="pane" style={{ overflowY: 'auto' }}><LogsPage /></div></QueryClientProvider>)
  const pane = screen.getByTestId('pane')
  const layout = { top: 0, height: 1000 }
  Object.defineProperties(pane, {
    scrollTop: { configurable: true, get: () => layout.top, set: (v: number) => { layout.top = Math.min(v, layout.height - 200) } },
    scrollHeight: { configurable: true, get: () => layout.height },
    clientHeight: { configurable: true, value: 200 },
  })
  return { ...view, pane, layout }
}

beforeEach(() => { fetchLogs.mockReset() })
afterEach(() => { vi.useRealTimers() })

it('stops refetching and moving once the reader scrolls up; following keeps the newest line in view (TAL-2139)', async () => {
  vi.useFakeTimers()
  // React Query batches its notifications on a short timer.
  const flush = () => act(() => vi.advanceTimersByTimeAsync(100))
  fetchLogs.mockResolvedValue(answer(ENTRIES))
  const { pane, layout } = renderInPane()
  await flush()
  expect(fetchLogs).toHaveBeenCalledTimes(1)

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
  // Level tokens tell warning and error lines apart without colour.
  expect([...container.querySelectorAll('[data-log-lines] li')].map((li) => li.children[1]?.textContent)).toEqual(['INFO', 'ERROR', 'ERROR', 'WARN'])
  expect(screen.getByRole('status').textContent).toContain('Last 4 lines')

  await userEvent.click(screen.getByRole('radio', { name: m.logs_severity_errors() }))
  expect(fetchLogs).toHaveBeenLastCalledWith('agent', 500, '', 'error')
  await screen.findByText('2 matching lines in the last 4', { exact: false })
  expect(container.querySelectorAll('[data-log-lines] li')).toHaveLength(2)

  await userEvent.click(screen.getByRole('radio', { name: m.logs_severity_all() }))
  await userEvent.type(screen.getByRole('searchbox', { name: m.logs_search() }), 'mcp')
  await screen.findByText('1 matching lines in the last 4', { exact: false })
  expect(fetchLogs).toHaveBeenLastCalledWith('agent', 500, 'mcp', undefined)
  expect([...container.querySelectorAll('[data-log-lines] mark')].map((mark) => mark.textContent)).toEqual(['mcp'])

  // Clearing the search restores the tail.
  await userEvent.clear(screen.getByRole('searchbox', { name: m.logs_search() }))
  await screen.findByText('Last 4 lines', { exact: false })
  expect(container.querySelectorAll('[data-log-lines] li')).toHaveLength(4)
})

it('builds its tabs from the server, shows a missing log as empty, copies the shown lines and loads earlier lines up to 2000 (TAL-2139)', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  fetchLogs.mockImplementation((file, tail) => Promise.resolve(file === 'webui'
    ? answer([], { file, lines: [], hint: 'Log file for webui not found yet.', counts: { error: 0, warning: 0, lines: 0 }, matched: 0 })
    : answer(ENTRIES, { tail })))
  renderInPane()
  const tabs = await screen.findByRole('tablist', { name: m.logs_file_label() })
  // An id the page has no label for shows the id.
  expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Agent', 'Web', 'Gateway', 'errors'])

  await userEvent.click(screen.getByRole('button', { name: m.copy() }))
  expect(writeText).toHaveBeenCalledWith('12:01:03 INFO gateway connected to telegram\n12:03:40 ERROR mcp server "linear" failed to connect: 401\nERROR Traceback (most recent call last):\n12:04:19 WARN plugin web-exa missing EXA_API_KEY')
  expect(showToast).toHaveBeenCalledWith(m.copied())

  for (const tail of [1000, 2000]) {
    await userEvent.click(screen.getByRole('button', { name: m.logs_load_earlier() }))
    expect(fetchLogs).toHaveBeenLastCalledWith('agent', tail, '', undefined)
  }
  await screen.findByText('Last 4 lines', { exact: false })
  expect(screen.queryByRole('button', { name: m.logs_load_earlier() })).toBeNull()

  await userEvent.click(within(tabs).getByRole('tab', { name: 'Web' }))
  expect(await screen.findByText('Log file for webui not found yet.')).toBeTruthy()
  expect(screen.queryByRole('switch', { name: m.logs_follow() })).toBeNull()
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('renders an older server\'s plain lines without figures, search or level control (TAL-2139)', async () => {
  fetchLogs.mockResolvedValue({ file: 'agent', tail: 500, lines: ['plain one', 'plain two'], hint: '' })
  const { container } = renderInPane()
  await screen.findByText('plain two')
  expect(container.querySelector('[data-settings-stats]')).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('radiogroup')).toBeNull()
  expect(screen.queryByRole('tablist')).toBeNull()
})
