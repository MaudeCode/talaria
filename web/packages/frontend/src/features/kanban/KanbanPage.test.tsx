import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { teardownAll } from '../../stream/connection'

vi.mock('../../shell/AppShell', () => ({ HubPage: ({ title, actions, toolbar, children }: { title: string; actions: ReactNode; toolbar: ReactNode; children: ReactNode }) => <main><h1>{title}</h1>{actions}{toolbar}{children}</main> }))
vi.mock('../../api/sse', () => ({ SSE_CLOSED: 2, openKanbanEventStream: vi.fn(() => ({ close: vi.fn(), readyState: () => 1 })) }))
vi.mock('../../api/endpoints', () => ({ fetchKanbanBoards: vi.fn(), fetchKanbanBoard: vi.fn(), fetchKanbanStats: vi.fn(), fetchKanbanTask: vi.fn(), fetchKanbanTaskLog: vi.fn(), kanbanTaskAction: vi.fn(), linkKanbanTasks: vi.fn(), unlinkKanbanTasks: vi.fn(), bulkKanbanStatus: vi.fn(), switchKanbanBoard: vi.fn(), updateKanbanConfig: vi.fn() }))
import * as api from '../../api/endpoints'
import { openKanbanEventStream } from '../../api/sse'
import { KanbanPage } from './KanbanPage'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const task = (id = 'A', status = 'todo') => ({ id, title: `Task ${id}`, status, priority: 0, claim_live: false, has_completion_evidence: false, current_run_started_at: null, available_actions: { block: true, unblock: false, complete: true, archive: true, move_to: ['ready', 'done'] }, requires_running_exit_confirmation: status === 'running' })
const snapshot = (tasks = [task(), task('B')], lanes = false) => ({ columns: [{ name: 'todo', label: 'To do', tasks }], bulk_move_targets: ['done'], create_statuses: ['todo'], lane_by_profile: lanes, latest_event_id: 7, read_only: false, ...(lanes ? { lanes: [{ assignee: 'scout', count: tasks.length, columns: [{ name: 'todo', label: 'To do', tasks }] }] } : {}) })
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { qc, ...render(<QueryClientProvider client={qc}><KanbanPage /></QueryClientProvider>) }
}
async function choose(label: string, value: string) {
  await userEvent.click(screen.getByRole('combobox', { name: label }))
  await userEvent.click(await screen.findByRole('option', { name: value }))
}
async function openTask(id = 'A') {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^Task ${id}\\b`) }))
  return within(screen.getByRole('dialog'))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(openKanbanEventStream).mockReturnValue({ close: vi.fn(), readyState: () => 1 })
  vi.mocked(api.fetchKanbanBoards).mockResolvedValue({ current: 'default', boards: [{ slug: 'default', name: 'Default', removable: false }, { slug: 'other', name: 'Other', removable: true }], read_only: false })
  vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot())
  vi.mocked(api.fetchKanbanStats).mockResolvedValue({ total: 2, by_status: { todo: 2 }, status_counts: [{ status: 'todo', count: 2 }] })
  vi.mocked(api.fetchKanbanTaskLog).mockResolvedValue({ log: [] })
  vi.mocked(api.fetchKanbanTask).mockResolvedValue({ task: task(), links: { parents: [], children: [] }, link_tasks: [], last_card_action: null })
})

describe('Kanban pending presentation', () => {
  it('shows a held status intent on the card and dialog without changing server columns or actions', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.kanbanTaskAction>>>()
    vi.mocked(api.kanbanTaskAction).mockReturnValue(write.promise)
    const { qc } = renderPage()
    const dialog = await openTask()
    await choose('Column', 'done')
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('done')
    expect(dialog.getByRole('status')).toHaveTextContent(/Pending.*Done/i)
    expect(dialog.getByRole('button', { name: 'Complete' })).toBeDisabled()
    expect(qc.getQueryData(['kanban', 'board', 'default', { include_archived: false, assignee: '', tenant: '', only_mine: false, search: '' }])).toMatchObject(snapshot())
    await userEvent.click(dialog.getByRole('button', { name: 'Complete' }))
    expect(api.kanbanTaskAction).toHaveBeenCalledTimes(1)
    await act(async () => { write.resolve({ task: task('A', 'done'), read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('todo')
    await choose('Column', 'done')
    await waitFor(() => expect(api.kanbanTaskAction).toHaveBeenCalledTimes(2))
  })

  it.each(['cycle refused', 'permission denied', 'stale task'])('shows held dependency intent and reconciles %s without discarding a newer draft', async (reason) => {
    const write = deferred<Awaited<ReturnType<typeof api.linkKanbanTasks>>>()
    vi.mocked(api.linkKanbanTasks).mockReturnValue(write.promise)
    renderPage()
    const dialog = await openTask()
    const input = dialog.getByRole('textbox', { name: 'Parent task ID' })
    await userEvent.type(input, 'P1')
    await userEvent.click(dialog.getByRole('button', { name: 'Add dependency' }))
    expect(dialog.getByRole('status')).toHaveTextContent(/P1/)
    await userEvent.clear(input)
    await userEvent.type(input, 'P2')
    await act(async () => { write.reject(new Error(reason)); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
    expect(input).toHaveValue('P2')
    expect(dialog.getByRole('button', { name: 'Add dependency' })).toBeEnabled()
  })

  it('shows each bulk intent and reconciles independently refused items', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.bulkKanbanStatus>>>()
    vi.mocked(api.bulkKanbanStatus).mockReturnValue(write.promise)
    renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Task A' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Task B' }))
    await choose('Status', 'done')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getAllByRole('status').filter((el) => el.textContent?.includes('Done'))).toHaveLength(2)
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot([task('A', 'done'), task('B')]))
    await act(async () => { write.resolve({ results: [{ id: 'A', ok: true }, { id: 'B', ok: false, error: 'permission denied' }], read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(screen.queryAllByRole('status').filter((el) => el.textContent?.includes('Pending'))).toHaveLength(0))
    const dialog = await openTask('B')
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('todo')
  })

  it('selects the destination immediately, never showing previous-board cards as writable', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.switchKanbanBoard>>>()
    const read = deferred<Awaited<ReturnType<typeof api.fetchKanbanBoard>>>()
    vi.mocked(api.switchKanbanBoard).mockReturnValue(write.promise)
    vi.mocked(api.fetchKanbanBoard).mockImplementation((slug) => slug === 'other' ? read.promise : Promise.resolve(snapshot()))
    renderPage()
    await screen.findByRole('button', { name: /^Task A\b/ })
    await choose('Board', 'Other')
    expect(screen.getByRole('combobox', { name: 'Board' })).toHaveTextContent('Other')
    expect(screen.queryByRole('button', { name: /^Task A\b/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
    await act(async () => { read.resolve(snapshot([task('C')])); await Promise.resolve() })
    await screen.findByRole('button', { name: /^Task C\b/ })
    expect(screen.getByRole('checkbox', { name: 'Select Task C' })).toBeDisabled()
    vi.mocked(api.fetchKanbanBoards).mockResolvedValue({ current: 'other', boards: [{ slug: 'default', removable: false }, { slug: 'other', name: 'Other', removable: true }] })
    await act(async () => { write.resolve({ current: 'other', read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Task C' })).toBeEnabled())
  })

  it('reflects a held lane preference without deriving server lanes, then renders returned lanes', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.updateKanbanConfig>>>()
    vi.mocked(api.updateKanbanConfig).mockReturnValue(write.promise)
    renderPage()
    const toggle = await screen.findByRole('switch', { name: /Lanes by profile/ })
    await userEvent.click(toggle)
    expect(toggle).toBeChecked()
    expect(screen.queryByRole('region', { name: 'scout' })).not.toBeInTheDocument()
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot(undefined, true))
    await act(async () => { write.resolve({}); await Promise.resolve() })
    await screen.findByRole('region', { name: 'scout' })
    expect(toggle).toBeChecked()
  })

  it('does not submit or show intent when leaving Running is cancelled', async () => {
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot([task('A', 'running')]))
    renderPage()
    const dialog = await openTask()
    await userEvent.click(dialog.getByRole('button', { name: 'Complete' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(api.kanbanTaskAction).not.toHaveBeenCalled()
    expect(dialog.queryByRole('status')).not.toBeInTheDocument()
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('running')
  })

  it('keeps uncertain writes locked until a read-only retry reconciles them', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.kanbanTaskAction>>>()
    vi.mocked(api.kanbanTaskAction).mockReturnValue(write.promise)
    renderPage()
    const dialog = await openTask()
    await choose('Column', 'done')
    vi.mocked(api.fetchKanbanBoard).mockRejectedValue(new Error('offline'))
    await act(async () => { write.reject(new Error('connection lost')); await Promise.resolve() })
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible())
    expect(dialog.getByRole('button', { name: 'Complete' })).toBeDisabled()
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot([task('A', 'done')]))
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
    expect(api.kanbanTaskAction).toHaveBeenCalledTimes(1)
  })

  it('fences an old-profile completion from a replacement board and intent', async () => {
    const old = deferred<Awaited<ReturnType<typeof api.kanbanTaskAction>>>()
    const next = deferred<Awaited<ReturnType<typeof api.kanbanTaskAction>>>()
    vi.mocked(api.kanbanTaskAction).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const { qc, rerender } = renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Task B' }))
    await openTask()
    await choose('Column', 'done')
    act(() => { teardownAll(); qc.clear() })
    // The profile owner rerenders the shell after replacing its connection context and cache.
    rerender(<QueryClientProvider client={qc}><KanbanPage /></QueryClientProvider>)
    await screen.findByRole('dialog')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Column' })).toBeEnabled())
    await choose('Column', 'ready')
    await act(async () => { old.resolve({ task: task('A', 'done'), read_only: false }); await Promise.resolve() })
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByRole('status')).toHaveTextContent('Pending: Ready')
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('ready')
    await act(async () => { next.resolve({ task: task('A', 'ready'), read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
  })

  it('keeps a newer status intent over stale board/detail refreshes and preserves the live cursor', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.kanbanTaskAction>>>()
    vi.mocked(api.kanbanTaskAction).mockReturnValue(write.promise)
    const { qc } = renderPage()
    const dialog = await openTask()
    await choose('Column', 'done')
    await act(async () => { await qc.invalidateQueries({ queryKey: ['kanban'] }) })
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('done')
    expect(dialog.getByRole('status')).toHaveTextContent(/Pending.*Done/i)
    expect(openKanbanEventStream).toHaveBeenCalledWith('default', 7, expect.any(Function))
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot([task('A', 'done')]))
    await act(async () => { write.resolve({ task: task('A', 'done'), read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
    expect(dialog.getByRole('combobox', { name: 'Column' })).toHaveTextContent('done')
  })

  it('shows an unlink immediately and keeps the server link until a covering read completes', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.unlinkKanbanTasks>>>()
    vi.mocked(api.unlinkKanbanTasks).mockReturnValue(write.promise)
    vi.mocked(api.fetchKanbanTask).mockResolvedValue({ task: task(), links: { parents: ['P1'], children: [] }, link_tasks: [{ id: 'P1', title: 'Parent', status: 'done' }], last_card_action: null })
    renderPage()
    const dialog = await openTask()
    await userEvent.click(await dialog.findByRole('button', { name: 'Remove dependency Parent (P1)' }))
    expect(dialog.getByRole('status')).toHaveTextContent(/Remove dependency.*P1/)
    expect(dialog.getByRole('listitem')).toHaveTextContent('Parent')
    expect(dialog.getByRole('button', { name: 'Remove dependency Parent (P1)' })).toBeDisabled()
    vi.mocked(api.fetchKanbanTask).mockResolvedValue({ task: task(), links: { parents: [], children: [] }, link_tasks: [], last_card_action: null })
    await act(async () => { write.resolve({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('listitem')).not.toBeInTheDocument())
    expect(dialog.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps source-board bulk completion away from destination selection', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.bulkKanbanStatus>>>()
    vi.mocked(api.bulkKanbanStatus).mockReturnValue(write.promise)
    vi.mocked(api.switchKanbanBoard).mockResolvedValue({ current: 'other', read_only: false })
    renderPage()
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Task A' }))
    await choose('Status', 'done')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(api.bulkKanbanStatus).toHaveBeenCalledWith('default', ['A'], 'done')
    vi.mocked(api.fetchKanbanBoards).mockResolvedValue({ current: 'other', boards: [{ slug: 'other', name: 'Other', removable: true }] })
    await choose('Board', 'Other')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Task A' })).toBeEnabled())
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Task B' }))
    await act(async () => { write.resolve({ results: [{ id: 'A', ok: false, error: 'stale' }], read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Task B' })).toBeChecked())
    expect(screen.getByRole('checkbox', { name: 'Select Task A' })).not.toBeChecked()
  })

  it('preserves a newly typed identical dependency draft when the older request succeeds', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.linkKanbanTasks>>>()
    vi.mocked(api.linkKanbanTasks).mockReturnValue(write.promise)
    renderPage()
    const dialog = await openTask()
    const input = dialog.getByRole('textbox', { name: 'Parent task ID' })
    await userEvent.type(input, 'P1')
    await userEvent.click(dialog.getByRole('button', { name: 'Add dependency' }))
    await userEvent.clear(input)
    await userEvent.type(input, 'P1')
    await act(async () => { write.resolve({ ok: true }); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
    expect(input).toHaveValue('P1')
  })

  it('preserves selection edits made while a bulk request is unresolved', async () => {
    const write = deferred<Awaited<ReturnType<typeof api.bulkKanbanStatus>>>()
    vi.mocked(api.bulkKanbanStatus).mockReturnValue(write.promise)
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot([task(), task('B'), task('C')]))
    renderPage()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Task A' }))
    await choose('Status', 'done')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Task C' }))
    await act(async () => { write.resolve({ results: [{ id: 'A', ok: false, error: 'stale' }], read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select Task C' })).toBeChecked())
    expect(screen.getByRole('checkbox', { name: 'Select Task A' })).not.toBeChecked()
  })

  it('does not reopen Running confirmation when a covering read removes the pending-only status', async () => {
    const running = task('A', 'running')
    running.available_actions.move_to = ['ready']
    vi.mocked(api.fetchKanbanBoard).mockResolvedValue(snapshot([running]))
    const write = deferred<Awaited<ReturnType<typeof api.kanbanTaskAction>>>()
    vi.mocked(api.kanbanTaskAction).mockReturnValue(write.promise)
    renderPage()
    const dialog = await openTask()
    await userEvent.click(dialog.getByRole('button', { name: 'Complete' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(dialog.getByRole('status')).toHaveTextContent('Pending: Done')
    await act(async () => { write.resolve({ task: task('A', 'done'), read_only: false }); await Promise.resolve() })
    await waitFor(() => expect(dialog.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(api.kanbanTaskAction).toHaveBeenCalledTimes(1)
  })

})
