import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Archive, FolderPlus, Plus, RefreshCw, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { openKanbanEventStream, SSE_CLOSED } from '../../api/sse'
import type { z } from 'zod'
import type { KanbanTaskSchema } from '../../contracts'
import { HubPage } from '../../shell/AppShell'
import { PanelHeadButton } from '../../shell/Sidebar'
import { Button, IconButton } from '../../ui/Button'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

type KanbanTask = z.infer<typeof KanbanTaskSchema>
interface KanbanColumn { name: string; tasks: KanbanTask[] }

/** Labels for the Agent's statuses; an unknown status shows as sent. */
const STATUS_LABELS: Record<string, () => string> = { triage: m.kanban_status_triage, todo: m.kanban_status_todo, ready: m.kanban_status_ready, running: m.kanban_status_running, blocked: m.kanban_status_blocked, done: m.kanban_status_done, archived: m.kanban_status_archived }
const statusLabel = (status: string) => STATUS_LABELS[status]?.() ?? status

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => { const t = window.setTimeout(() => setDebounced(value), ms); return () => window.clearTimeout(t) }, [value, ms])
  return debounced
}

/** Refetches every Kanban query when the server's event stream reports a write from any client; a burst refreshes once.
 * `latestEventId` must be the shown board's own cursor, never placeholder data from the previous board. */
function useKanbanLiveRefresh(board: string | undefined, latestEventId: number | undefined) {
  const qc = useQueryClient()
  const ready = latestEventId !== undefined
  const since = useEffectEvent(() => latestEventId ?? 0)
  useEffect(() => {
    if (!ready) return
    let timer: number | undefined
    const refresh = () => { void qc.invalidateQueries({ queryKey: ['kanban'] }) }
    // The stream follows the active board, so a board switch reopens it at that board's cursor.
    const handle = openKanbanEventStream(since(), () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, 250)
    })
    // EventSource gives up on an error response; polling then keeps the board current while the page is visible.
    const poll = window.setInterval(() => { if (handle.readyState() === SSE_CLOSED && document.visibilityState === 'visible') refresh() }, 30_000)
    return () => { window.clearTimeout(timer); window.clearInterval(poll); handle.close() }
  }, [board, ready, qc])
}

export function KanbanPage() {
  const qc = useQueryClient()
  const [includeArchived, setIncludeArchived] = useState(false)
  const [assignee, setAssignee] = useState('')
  const [tenant, setTenant] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [searchText, setSearchText] = useState('')
  const search = useDebounced(searchText.trim(), 250)
  const [selected, setSelected] = useState<string[]>([])
  const [bulkStatus, setBulkStatus] = useState('')
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingBoard, setCreatingBoard] = useState(false)
  const [archivingBoard, setArchivingBoard] = useState(false)
  const boards = useQuery({ queryKey: keys.kanban.boards, queryFn: api.fetchKanbanBoards, staleTime: 30_000 })
  const current = boards.data?.current
  const filters = { include_archived: includeArchived, assignee, tenant, only_mine: onlyMine, search }
  // The server filters and searches; the previous board stays on screen while the next answer loads.
  const board = useQuery({ queryKey: [...keys.kanban.board(current), filters], queryFn: () => api.fetchKanbanBoard(filters), staleTime: 10_000, enabled: boards.isSuccess, placeholderData: keepPreviousData })
  const stats = useQuery({ queryKey: ['kanban', 'stats', current ?? ''], queryFn: api.fetchKanbanStats, staleTime: 10_000, enabled: boards.isSuccess })
  useKanbanLiveRefresh(current, board.isPlaceholderData ? undefined : board.data?.latest_event_id)
  const invalidate = () => qc.invalidateQueries({ queryKey: ['kanban'] })
  const toastError = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const switchBoard = useMutation({ mutationFn: (slug: string) => api.switchKanbanBoard(slug), onSuccess: () => { setSelected([]); void invalidate() } })
  const saveView = useMutation({ mutationFn: (lanes: boolean) => api.updateKanbanConfig(lanes), onSuccess: () => { void invalidate() }, onError: (e) => showToast(m.kanban_view_update_failed() + (e instanceof Error ? e.message : String(e)), 4000, 'error') })
  const bulk = useMutation({
    mutationFn: () => api.bulkKanbanStatus(shownSelected, bulkStatus),
    onSuccess: (res) => {
      const failed = res.results.filter((r) => r.ok === false).map((r) => `${String(r.id)}: ${typeof r.error === 'string' ? r.error : ''}`)
      if (failed.length) showToast(failed.join('; '), 6000, 'error')
      else showToast(m.saved())
      setSelected([])
      setBulkStatus('')
      void invalidate()
    },
    onError: toastError,
  })
  const archiveBoard = useMutation({ mutationFn: (slug: string) => api.archiveKanbanBoard(slug), onSuccess: () => { showToast(m.kanban_board_archived()); setSelected([]); void invalidate() }, onError: toastError })
  const columns = useMemo(() => board.data?.columns ?? [], [board.data])
  const serverReadOnly = !!board.data?.read_only
  // Placeholder data is the previous board or filter's answer; writes wait until the shown cards are the current ones.
  const stale = board.isPlaceholderData
  const readOnly = serverReadOnly || stale
  const columnNames = useMemo(() => columns.map((c) => c.name), [columns])
  const currentBoard = boards.data?.boards.find((b) => b.slug === current)
  // The dialog follows the board's current copy of the task, so its actions track every refetch.
  const openTask = useMemo(() => columns.flatMap((c) => c.tasks).find((t) => String(t.id) === openTaskId) ?? null, [columns, openTaskId])
  // Selection is local UI state; a selected card a later filter hides drops out, so bulk acts only on cards on screen.
  const shown = new Set(columns.flatMap((c) => c.tasks.map((t) => String(t.id))))
  const shownSelected = selected.filter((id) => shown.has(id))
  const toggleSelected = (id: string) => setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  // A chosen filter value stays listed even when the server's option list no longer carries it.
  const options = (values: unknown[] | undefined, chosen: string) => [...new Set([...(chosen ? [chosen] : []), ...(values ?? []).map(String)])]
  const renderColumns = (cols: KanbanColumn[]) => <KanbanColumns columns={cols} readOnly={serverReadOnly} stale={stale} selected={selected} onToggle={toggleSelected} onOpen={setOpenTaskId} />

  return (
    <HubPage
      title={m.tab_kanban()}
      actions={
        <>
          <IconButton label={m.refresh()} onClick={() => { void invalidate() }}><RefreshCw size={16} aria-hidden="true" /></IconButton>
          {!serverReadOnly && <PanelHeadButton label={m.kanban_new_task()} className="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}
        </>
      }
      toolbar={
        <>
          {boards.data && boards.data.boards.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted">
              {m.kanban_board_label()}
              <Select value={current ?? ''} onValueChange={(v) => switchBoard.mutate(v)} aria-label={m.kanban_board_label()}>
                {boards.data.boards.map((b) => <option key={b.slug} value={b.slug}>{b.name ?? b.slug}{b.total !== undefined ? ` (${b.total})` : ''}</option>)}
              </Select>
            </label>
          )}
          {boards.isSuccess && !serverReadOnly && (
            <div className="flex items-center">
              <IconButton label={m.kanban_new_board()} onClick={() => setCreatingBoard(true)}><FolderPlus size={16} aria-hidden="true" /></IconButton>
              {currentBoard?.removable && <IconButton label={m.kanban_archive_board_title()} onClick={() => setArchivingBoard(true)}><Archive size={16} aria-hidden="true" /></IconButton>}
            </div>
          )}
          <TextInput type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder={m.kanban_search_tasks()} aria-label={m.kanban_search_tasks()} className="h-8 w-44" />
          <Select value={assignee} onValueChange={setAssignee} disabled={onlyMine} aria-label={m.kanban_assignee()}>
            <option value="">{m.kanban_all_assignees()}</option>
            {options(board.data?.assignees, assignee).map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
          {(tenant || (board.data?.tenants?.length ?? 0) > 0) && (
            <Select value={tenant} onValueChange={setTenant} aria-label={m.kanban_tenant()}>
              <option value="">{m.kanban_all_tenants()}</option>
              {options(board.data?.tenants, tenant).map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted"><Switch checked={onlyMine} onCheckedChange={(checked) => setOnlyMine(checked)} aria-label={m.kanban_only_mine()} /> {m.kanban_only_mine()}</label>
          <label className="flex items-center gap-1.5 text-xs text-muted"><Switch checked={includeArchived} onCheckedChange={(checked) => setIncludeArchived(checked)} aria-label={m.kanban_include_archived()} /> {m.kanban_include_archived()}</label>
          {board.data && <label className="flex items-center gap-1.5 text-xs text-muted"><Switch checked={board.data.lane_by_profile} disabled={saveView.isPending} onCheckedChange={(checked) => saveView.mutate(checked)} aria-label={m.kanban_lanes_by_profile()} /> {m.kanban_lanes_by_profile()}</label>}
          {serverReadOnly && <span className="text-xs text-warning">{m.kanban_read_only()}</span>}
        </>
      }
    >
      {(boards.isPending || board.isPending) && <LoadingState />}
      {boards.isError && <ErrorState error={boards.error} onRetry={() => { void boards.refetch() }} />}
      {board.isError && <ErrorState error={board.error} onRetry={() => { void board.refetch() }} />}
      {boards.isSuccess && boards.data.boards.length === 0 && <EmptyState>{m.kanban_no_boards()}</EmptyState>}
      {stats.data && (
        <div role="group" aria-label={m.kanban_stats()} className="kanban-stats mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span className="font-semibold text-text">{m.kanban_stats_total({ a0: stats.data.total })}</span>
          {stats.data.status_counts.map((c) => <span key={c.status}><strong className="text-text">{c.count}</strong> {statusLabel(c.status)}</span>)}
        </div>
      )}
      {shownSelected.length > 0 && !serverReadOnly && board.data && (
        <div role="group" aria-label={m.kanban_bulk_action()} className="kanban-bulk-bar mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
          <span className="text-muted">{m.kanban_selected_count({ a0: shownSelected.length })}</span>
          <Select value={bulkStatus} onValueChange={setBulkStatus} aria-label={m.kanban_status()} placeholder={m.kanban_status()}>
            {board.data.bulk_move_targets.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Button variant="primary" disabled={!bulkStatus || bulk.isPending || stale} onClick={() => bulk.mutate()}>{m.kanban_apply()}</Button>
          <Button onClick={() => setSelected([])}>{m.kanban_clear_selection()}</Button>
        </div>
      )}
      {board.isSuccess && (board.data.lanes
        ? (
          <div className="flex flex-col gap-4">
            {board.data.lanes.map((lane) => {
              const name = lane.assignee ?? m.kanban_lane_unassigned()
              return (
                <section key={lane.assignee ?? ''} className="kanban-lane flex flex-col gap-2" aria-label={name}>
                  <header className="flex items-center gap-2 text-sm font-semibold text-text"><span>{name}</span><span className="text-xs font-normal text-muted">{lane.count}</span></header>
                  {renderColumns(lane.columns)}
                </section>
              )
            })}
          </div>
        )
        : renderColumns(columns))}
      {openTask && <TaskDialog task={openTask} readOnly={readOnly} onClose={() => setOpenTaskId(null)} onChanged={() => { void invalidate() }} />}
      {creating && <CreateTaskDialog columns={columnNames} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void invalidate() }} />}
      {creatingBoard && <CreateBoardDialog onClose={() => setCreatingBoard(false)} onCreated={() => { setCreatingBoard(false); setSelected([]); void invalidate() }} />}
      <ConfirmDialog open={archivingBoard} onOpenChange={setArchivingBoard} title={m.kanban_archive_board_title()} description={m.kanban_archive_board_body({ a0: currentBoard?.name ?? current ?? '' })} confirmLabel={m.kanban_archive()} cancelLabel={m.cancel()} danger onConfirm={() => { if (current) archiveBoard.mutate(current) }} />
    </HubPage>
  )
}

function KanbanColumns({ columns, readOnly, stale, selected, onToggle, onOpen }: { columns: KanbanColumn[]; readOnly: boolean; stale: boolean; selected: string[]; onToggle: (id: string) => void; onOpen: (id: string) => void }) {
  return (
    <div className="kanban-board grid gap-3 md:grid-cols-2 xl:grid-cols-3" id="kanbanList">
      {columns.map((col) => (
        <section key={col.name} className="kanban-column flex min-h-40 flex-col rounded-lg border border-border bg-surface" aria-label={col.name}>
          <header className="flex items-center justify-between border-b border-border-subtle px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
            <span>{col.name}</span><span>{col.tasks.length}</span>
          </header>
          <div className="flex flex-col gap-2 p-2">
            {col.tasks.length === 0 && <div className="px-1 py-2 text-xs text-muted">{m.kanban_no_tasks()}</div>}
            {col.tasks.map((task) => {
              const id = String(task.id)
              return (
                <div key={id} className="flex items-start gap-2">
                  {!readOnly && <input type="checkbox" className="mt-3 shrink-0" checked={selected.includes(id)} disabled={stale} onChange={() => onToggle(id)} aria-label={m.kanban_select_task({ a0: task.title ?? id })} />}
                  <button type="button" onClick={() => onOpen(id)} className={cn('kanban-card min-w-0 flex-1 rounded-md border border-border-subtle bg-bg p-2.5 text-left text-sm text-text hover:border-accent-bg-strong', selected.includes(id) && 'selected')} data-task-id={id}>
                    <div className="font-medium">{task.title ?? id}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted">
                      {task.assignee && <span>{task.assignee}</span>}
                      {task.priority !== undefined && task.priority !== null && <span>P{String(task.priority)}</span>}
                      {task.session_id && <span className="text-accent-text">●</span>}
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function TaskDialog({ task, readOnly, onClose, onChanged }: { task: KanbanTask; readOnly: boolean; onClose: () => void; onChanged: () => void }) {
  const [comment, setComment] = useState('')
  const [pendingRunningExit, setPendingRunningExit] = useState<(() => void) | null>(null)
  const [parentId, setParentId] = useState('')
  const log = useQuery({ queryKey: ['kanban', 'task-log', String(task.id)], queryFn: () => api.fetchKanbanTaskLog(task.id), staleTime: 10_000 })
  const detail = useQuery({ queryKey: ['kanban', 'task', String(task.id)], queryFn: () => api.fetchKanbanTask(task.id), staleTime: 10_000 })
  const link = useMutation({
    mutationFn: ({ parent, child, remove }: { parent: string; child: string; remove: boolean }) => (remove ? api.unlinkKanbanTasks(parent, child) : api.linkKanbanTasks(parent, child)),
    onSuccess: (_r, v) => { if (!v.remove) setParentId(''); onChanged() },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'),
  })
  const links = detail.data?.links
  const act = useMutation({
    mutationFn: ({ action, body }: { action: Parameters<typeof api.kanbanTaskAction>[1]; body: Record<string, unknown> }) => api.kanbanTaskAction(task.id, action, body),
    onSuccess: () => { showToast(m.saved()); onChanged(); void log.refetch() },
    // A refusal (the task changed since this board was read) refetches, so the dialog shows its current actions.
    onError: (e) => { showToast(e instanceof Error ? e.message : String(e), 4000, 'error'); onChanged() },
  })
  const entries: unknown[] = log.data?.log ?? log.data?.entries ?? []
  // The server owns which actions a card offers and whether leaving Running needs confirmation (TAL-557).
  const actions = task.available_actions
  // A confirmed write says so; the server refuses to take a task out of Running without it.
  const request = (fn: (confirm: { confirm_running_exit: boolean }) => void) => { if (task.requires_running_exit_confirmation) setPendingRunningExit(() => () => fn({ confirm_running_exit: true })); else fn({ confirm_running_exit: false }) }
  const setStatus = (status: string) => request((confirm) => act.mutate({ action: 'patch', body: { status, ...confirm } }))
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={task.title ?? String(task.id)} description={task.description ?? undefined} className="w-[min(92vw,640px)]">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{m.kanban_column_label()}:</span>
          <Select value={task.status ?? ''} disabled={readOnly || actions.move_to.length === 0} onValueChange={setStatus} aria-label={m.kanban_column_label()}>
            {[task.status ?? '', ...actions.move_to].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          {task.assignee && <span>{task.assignee}</span>}
          {task.session_id && <Link to="/session/$sessionId" params={{ sessionId: task.session_id }} className="text-accent-text underline">{m.kanban_open_session()}</Link>}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act.mutate({ action: 'dispatch', body: {} })}>{m.kanban_dispatch()}</Button>
            {actions.block && <Button onClick={() => request((confirm) => act.mutate({ action: 'block', body: confirm }))}>{m.kanban_block()}</Button>}
            {actions.unblock && <Button onClick={() => request(() => act.mutate({ action: 'unblock', body: {} }))}>{m.kanban_unblock()}</Button>}
            {actions.complete && <Button onClick={() => setStatus('done')}>{m.kanban_complete()}</Button>}
            {actions.archive && <Button onClick={() => setStatus('archived')}>{m.kanban_archive()}</Button>}
          </div>
        )}
        <div role="group" aria-label={m.kanban_links()}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{m.kanban_links()}</div>
          {links && (
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              {([[m.kanban_parents(), links.parents, (id: string) => ({ parent: id, child: String(task.id) })], [m.kanban_children(), links.children, (id: string) => ({ parent: String(task.id), child: id })]] as const).map(([label, ids, pair]) => (
                <div key={label}>
                  <div className="text-muted">{label}</div>
                  {ids.length === 0 && <div className="text-muted">—</div>}
                  <ul>
                    {ids.map((id) => (
                      <li key={id} className="flex items-center gap-1">
                        <span className="font-mono">{id}</span>
                        {!readOnly && <IconButton label={m.kanban_remove_dependency_named({ a0: id })} className="h-6 w-6" onClick={() => link.mutate({ ...pair(id), remove: true })}><X size={12} aria-hidden="true" /></IconButton>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {!readOnly && (
            <form onSubmit={(e) => { e.preventDefault(); if (parentId.trim()) link.mutate({ parent: parentId.trim(), child: String(task.id), remove: false }) }} className="mt-2 flex gap-2">
              <TextInput value={parentId} onChange={(e) => setParentId(e.target.value)} placeholder={m.kanban_parents_placeholder()} aria-label={m.kanban_parents_placeholder()} />
              <Button type="submit" disabled={link.isPending}>{m.kanban_add_dependency()}</Button>
            </form>
          )}
        </div>
        <ConfirmDialog open={pendingRunningExit !== null} onOpenChange={(o) => { if (!o) setPendingRunningExit(null) }} title={m.kanban_leave_running_title()} description={m.kanban_leave_running_body()} confirmLabel={m.kanban_continue()} cancelLabel={m.cancel()} danger onConfirm={() => pendingRunningExit?.()} />
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{m.kanban_comments()}</div>
          {!readOnly && (
            <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) { act.mutate({ action: 'comments', body: { body: comment.trim(), text: comment.trim() } }); setComment('') } }} className="flex gap-2">
              <TextInput value={comment} onChange={(e) => setComment(e.target.value)} placeholder={m.kanban_add_comment()} aria-label={m.kanban_add_comment()} />
              <Button type="submit">{m.add()}</Button>
            </form>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{m.kanban_log()}</div>
          {log.isPending && <LoadingState />}
          {log.isSuccess && entries.length === 0 && <div className="text-xs text-muted">—</div>}
          <ul className="max-h-60 overflow-y-auto text-xs">
            {entries.map((e, i) => {
              const row = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {}
              const when = row.ts ?? row.created_at
              const text = [row.message, row.text, row.body, row.event].find((v) => typeof v === 'string')
              return <li key={i} className="border-b border-border-subtle py-1"><span className="text-muted">{formatDate(typeof when === 'number' || typeof when === 'string' ? when : null)}</span> {typeof text === 'string' ? text : JSON.stringify(e)}</li>
            })}
          </ul>
        </div>
      </div>
    </Dialog>
  )
}

function CreateTaskDialog({ columns, onClose, onCreated }: { columns: string[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState(columns[0] ?? '')
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => api.createKanbanTask({ title: title.trim(), description: description.trim() || undefined, status: status || undefined }),
    onSuccess: () => { onCreated() },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.kanban_new_task()}>
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate() }} className="flex flex-col gap-1">
        <FieldRow label={m.kanban_task_title()} htmlFor="kanbanTitle"><TextInput id="kanbanTitle" required value={title} onChange={(e) => setTitle(e.target.value)} /></FieldRow>
        <FieldRow label={m.kanban_description_placeholder()} htmlFor="kanbanDesc"><textarea id="kanbanDesc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-text" /></FieldRow>
        <FieldRow label={m.kanban_column_label()} htmlFor="kanbanStatus"><Select id="kanbanStatus" value={status} onValueChange={(v) => setStatus(v)} className="w-full">{columns.map((c) => <option key={c} value={c}>{c}</option>)}</Select></FieldRow>
        {error && <div role="alert" className="text-sm text-error">{error}</div>}
        <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button variant="primary" type="submit" disabled={create.isPending}>{m.create()}</Button></div>
      </form>
    </Dialog>
  )
}

function CreateBoardDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The server derives the slug from the name and switches to the new board.
  const create = useMutation({ mutationFn: () => api.createKanbanBoard(name.trim()), onSuccess: () => { onCreated() }, onError: (e) => setError(e instanceof Error ? e.message : String(e)) })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.kanban_new_board()}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate() }} className="flex flex-col gap-1">
        <FieldRow label={m.kanban_board_name()} htmlFor="kanbanBoardName"><TextInput id="kanbanBoardName" required value={name} onChange={(e) => setName(e.target.value)} /></FieldRow>
        {error && <div role="alert" className="text-sm text-error">{error}</div>}
        <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button variant="primary" type="submit" disabled={create.isPending}>{m.create()}</Button></div>
      </form>
    </Dialog>
  )
}
