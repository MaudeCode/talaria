import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { newResource, useResourceEffects, useResourceMutation, withCreated, withEffect, withEffects, type ResourceEffect } from '../sessions/useResourceMutation'
import { getStreamContext } from '../../stream/connection'
import { isDefiniteRefusal } from '../../contracts/common'

// Same owner for single-card and bulk writes; profile/server identity comes from the connection context.
const cardResource = (board: string | undefined, id: string) => JSON.stringify(['kanban', board, id])
// Extend the existing board key: only snapshots touched by this write gate its reconciliation.
const kanbanReads = (board: string | undefined, ids: string[] = []) => {
  const key = keys.kanban.board(board)
  return [[...key, 'view'], [...key, 'stats'], ...ids.flatMap((id) => [[...key, 'task', id], [...key, 'task-log', id]])]
}
const boardSelection = 'kanban:selection'
const lanePreference = 'kanban:lanes'
const linkResource = (board: string | undefined, parent: string, child: string) => JSON.stringify(['kanban-link', board, parent, child])
const boardResource = (slug: string) => `kanban-board:${slug}`
// Pending creates per board, as `newResource` ids; their cards are shown but cannot be opened until the server names them.
const createKind = (board: string | undefined) => `kanban-task-${board ?? ''}`

type KanbanTask = z.infer<typeof KanbanTaskSchema>
interface KanbanColumn { name: string; label: string; tasks: KanbanTask[] }

/** Cards a pending status write moves leave their column and lead the target column until the server orders them. */
function withCardEffects(columns: KanbanColumn[], board: string | undefined, effects: Record<string, ResourceEffect>): KanbanColumn[] {
  const moved: KanbanTask[] = withCreated([], createKind(board), effects)
  const kept = columns.map((col) => ({ ...col, tasks: col.tasks.filter((task) => {
    const status = effects[cardResource(board, String(task.id))]?.fields?.status
    if (typeof status !== 'string' || status === col.name) return true
    moved.push({ ...task, status })
    return false
  }) }))
  return moved.length ? kept.map((col) => ({ ...col, tasks: [...moved.filter((task) => task.status === col.name), ...col.tasks] })) : columns
}

/** Labels for the Agent's statuses; an unknown status shows the server's label, else the status as sent. */
const STATUS_LABELS: Record<string, () => string> = { triage: m.kanban_status_triage, todo: m.kanban_status_todo, scheduled: m.kanban_status_scheduled, ready: m.kanban_status_ready, running: m.kanban_status_running, blocked: m.kanban_status_blocked, review: m.kanban_status_review, done: m.kanban_status_done, archived: m.kanban_status_archived }
const statusLabel = (status: string, label?: string) => STATUS_LABELS[status]?.() ?? label ?? status

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
    // The stream is pinned to the shown board, so a board switch reopens it at that board's cursor.
    const handle = openKanbanEventStream(board, since(), () => {
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
  const [selection, setSelection] = useState<{ context: object; board: string | undefined; ids: string[] }>({ context: getStreamContext(), board: undefined, ids: [] })
  const [bulkStatus, setBulkStatus] = useState('')
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingBoard, setCreatingBoard] = useState(false)
  const [archivingBoard, setArchivingBoard] = useState(false)
  const boards = useQuery({ queryKey: keys.kanban.boards, queryFn: api.fetchKanbanBoards, staleTime: 30_000 })
  const effects = useResourceEffects<string | boolean>()
  const requestedBoard = effects[boardSelection]
  const requestedView = effects[lanePreference]
  // Flat columns are already on the page, so turning lanes off shows at once. Lanes group cards by the server's
  // assignee lanes, which only its reread brings, so turning them on keeps the switch busy until then.
  const lanesOff = requestedView?.value === false
  const lanesStarting = requestedView?.value === true
  const boardList = useMemo(() => withEffects(boards.data?.boards ?? [], (b) => boardResource(b.slug), effects), [boards.data, effects])
  // Archiving the current board returns the server to its board that cannot be removed; the reread confirms which.
  const confirmedBoard = boards.data?.current && effects[boardResource(boards.data.current)]?.remove ? boardList.find((b) => !b.removable)?.slug : boards.data?.current
  const current = typeof requestedBoard?.value === 'string' ? requestedBoard.value : confirmedBoard
  const selected = selection.context === getStreamContext() && selection.board === current ? selection.ids : []
  const setSelected = (ids: string[]) => setSelection({ context: getStreamContext(), board: current, ids })
  const filters = { include_archived: includeArchived, assignee, tenant, only_mine: onlyMine, search }
  // Filter placeholders stay within one board. A destination board uses only its own cached answer.
  const board = useQuery({ queryKey: [...keys.kanban.board(current), 'view', filters], queryFn: () => api.fetchKanbanBoard(current, filters), staleTime: 10_000, enabled: boards.isSuccess, placeholderData: (previous, query) => query?.queryKey[2] === current ? previous : undefined })
  const stats = useQuery({ queryKey: [...keys.kanban.board(current), 'stats'], queryFn: () => api.fetchKanbanStats(current), staleTime: 10_000, enabled: boards.isSuccess })
  useKanbanLiveRefresh(current, board.isPlaceholderData ? undefined : board.data?.latest_event_id)
  const invalidate = (refetchType: 'active' | 'none' = 'active') => qc.invalidateQueries({ queryKey: ['kanban'], refetchType })
  const toastError = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const switchBoard = useResourceMutation({ resource: () => boardSelection, queryKey: keys.kanban.boards, effect: (slug: string) => ({ value: slug }), mutationFn: api.switchKanbanBoard, onError: toastError })
  const saveView = useResourceMutation({ resource: () => lanePreference, queryKey: keys.kanban.board(current), readKeys: () => kanbanReads(current), effect: (lanes: boolean) => ({ value: lanes }), mutationFn: api.updateKanbanConfig, onSuccess: () => { void invalidate('none') }, onError: (e) => { void invalidate('none'); showToast(m.kanban_view_update_failed() + (e instanceof Error ? e.message : String(e)), 4000, 'error') } })
  const bulk = useResourceMutation({
    resource: ({ ids, board }: { ids: string[]; status: string; board: string | undefined }) => ids.map((id) => cardResource(board, id)),
    queryKey: keys.kanban.board(current),
    readKeys: ({ board, ids }) => kanbanReads(board, ids),
    effect: ({ status }) => ({ fields: { status } }),
    mutationFn: ({ ids, status, board }) => api.bulkKanbanStatus(board, ids, status),
    onSuccess: (res, { board, ids }) => {
      const failed = res.results.filter((r) => r.ok === false).map((r) => `${String(r.id)}: ${typeof r.error === 'string' ? r.error : ''}`)
      if (failed.length) showToast(failed.join('; '), 6000, 'error')
      else showToast(m.saved())
      // Remove confirmed successes without replacing newer selections or restoring a cleared selection.
      const succeeded = new Set(res.results.filter((r) => r.ok === true).map((r) => String(r.id)))
      setSelection((selection) => selection.context === getStreamContext() && selection.board === board ? { ...selection, ids: selection.ids.filter((id) => !ids.includes(id) || !succeeded.has(id)) } : selection)
    },
    onError: toastError,
  })
  const archiveBoard = useResourceMutation({ resource: boardResource, queryKey: ['kanban'], effect: () => ({ remove: true }), mutationFn: (slug: string) => api.archiveKanbanBoard(slug), onSuccess: () => showToast(m.kanban_board_archived()), onError: toastError })
  const createTask = useResourceMutation({
    resource: ({ resource }: { resource: string; board: string | undefined; title: string; description: string; status: string }) => resource,
    queryKey: keys.kanban.board(current), readKeys: ({ board }) => kanbanReads(board), exclusive: true,
    effect: ({ resource, title, status }) => ({ fields: { id: resource, title, status, priority: 0, claim_live: false, has_completion_evidence: false, current_run_started_at: null, requires_running_exit_confirmation: false, available_actions: { block: false, unblock: false, complete: false, archive: false, move_to: [] } } }),
    mutationFn: ({ board, title, description, status }) => api.createKanbanTask(board, { title, description: description || undefined, status: status || undefined }),
    onError: toastError,
  })
  const columns = useMemo(() => withCardEffects(board.data?.columns ?? [], current, effects), [board.data, current, effects])
  const serverReadOnly = !!board.data?.read_only
  // Filter placeholders cannot authorize writes; every write names its board, so a pending switch can.
  const stale = board.isPlaceholderData || !board.data
  const readOnly = serverReadOnly || stale
  const currentBoard = boardList.find((b) => b.slug === current)
  // The dialog follows the board's current copy of the task, so its actions track every refetch; a pending move
  // shows in it even when the target column is off screen.
  const openTask = useMemo(() => {
    const found = (board.data?.columns ?? []).flatMap((c) => c.tasks).find((t) => String(t.id) === openTaskId)
    return found ? withEffect(found, effects[cardResource(current, String(found.id))]) : null
  }, [board.data, openTaskId, current, effects])
  // Selection is local UI state; a selected card a later filter hides drops out, so bulk acts only on cards on screen.
  const shown = new Set(columns.flatMap((c) => c.tasks.map((t) => String(t.id))))
  const shownSelected = selected.filter((id) => shown.has(id))
  const toggleSelected = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  // A chosen filter value stays listed even when the server's option list no longer carries it.
  const options = (values: unknown[] | undefined, chosen: string) => [...new Set([...(chosen ? [chosen] : []), ...(values ?? []).map(String)])]
  const renderColumns = (cols: KanbanColumn[]) => <KanbanColumns columns={withCardEffects(cols, current, effects)} readOnly={serverReadOnly} stale={stale} selected={selected} onToggle={toggleSelected} onOpen={setOpenTaskId} />

  return (
    <HubPage
      title={m.tab_kanban()}
      actions={
        <>
          <IconButton label={m.refresh()} onClick={() => { void invalidate() }}><RefreshCw size={16} aria-hidden="true" /></IconButton>
          {!serverReadOnly && <PanelHeadButton label={m.kanban_new_task()} className="primary" disabled={readOnly} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}
        </>
      }
      toolbar={
        <>
          {boardList.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted">
              {m.kanban_board_label()}
              <Select value={current ?? ''} onValueChange={(v) => { setSelection({ context: getStreamContext(), board: v, ids: [] }); setOpenTaskId(null); setCreating(false); setArchivingBoard(false); switchBoard.mutate(v) }} aria-label={m.kanban_board_label()}>
                {boardList.map((b) => <option key={b.slug} value={b.slug}>{b.name ?? b.slug}{b.total !== undefined ? ` (${b.total})` : ''}</option>)}
              </Select>
            </label>
          )}
          {boards.isSuccess && !serverReadOnly && (
            <div className="flex items-center">
              <IconButton label={m.kanban_new_board()} disabled={readOnly} onClick={() => setCreatingBoard(true)}><FolderPlus size={16} aria-hidden="true" /></IconButton>
              {currentBoard?.removable && <IconButton label={m.kanban_archive_board_title()} disabled={readOnly} onClick={() => setArchivingBoard(true)}><Archive size={16} aria-hidden="true" /></IconButton>}
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
          {board.data && <label className="flex items-center gap-1.5 text-xs text-muted"><Switch checked={!lanesOff && board.data.lane_by_profile} disabled={lanesStarting} aria-busy={lanesStarting || undefined} onCheckedChange={(checked) => saveView.mutate(checked)} aria-label={m.kanban_lanes_by_profile()} /> {m.kanban_lanes_by_profile()}</label>}
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
          <Button variant="primary" disabled={!bulkStatus || stale} onClick={() => bulk.mutate({ ids: shownSelected, status: bulkStatus, board: current })}>{m.kanban_apply()}</Button>
          <Button onClick={() => setSelected([])}>{m.kanban_clear_selection()}</Button>
        </div>
      )}
      {board.isSuccess && (board.data.lanes && !lanesOff
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
        : renderColumns(board.data.columns))}
      {openTask && <TaskDialog key={JSON.stringify([current, openTaskId])} board={current} task={openTask} readOnly={readOnly} onClose={() => setOpenTaskId(null)} onChanged={() => { void invalidate() }} />}
      {creating && <CreateTaskDialog columns={board.data?.create_statuses ?? []} onClose={() => setCreating(false)} onSubmit={(task) => { setCreating(false); createTask.mutate({ ...task, board: current, resource: newResource(createKind(current)) }) }} />}
      {creatingBoard && <CreateBoardDialog onClose={() => setCreatingBoard(false)} onCreated={() => { setCreatingBoard(false); setSelected([]); void invalidate() }} />}
      <ConfirmDialog open={archivingBoard} onOpenChange={setArchivingBoard} title={m.kanban_archive_board_title()} description={m.kanban_archive_board_body({ a0: currentBoard?.name ?? current ?? '' })} confirmLabel={m.kanban_archive()} cancelLabel={m.cancel()} danger onConfirm={() => { if (current) { setSelected([]); setOpenTaskId(null); archiveBoard.mutate(current) } }} />
    </HubPage>
  )
}

function KanbanColumns({ columns, readOnly, stale, selected, onToggle, onOpen }: { columns: KanbanColumn[]; readOnly: boolean; stale: boolean; selected: string[]; onToggle: (id: string) => void; onOpen: (id: string) => void }) {
  return (
    <div className="kanban-board grid gap-3 md:grid-cols-2 xl:grid-cols-3" id="kanbanList">
      {columns.map((col) => (
        <section key={col.name} className="kanban-column flex min-h-40 flex-col rounded-lg border border-border bg-surface" aria-label={statusLabel(col.name, col.label)}>
          <header className="flex items-center justify-between border-b border-border-subtle px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
            <span>{statusLabel(col.name, col.label)}</span><span>{col.tasks.length}</span>
          </header>
          <div className="flex flex-col gap-2 p-2">
            {col.tasks.length === 0 && <div className="px-1 py-2 text-xs text-muted">{m.kanban_no_tasks()}</div>}
            {col.tasks.map((task) => {
              const id = String(task.id)
              const provisional = id.includes(':new:')
              return (
                <div key={id} className="flex items-start gap-2">
                  {!readOnly && <input type="checkbox" className="mt-3 shrink-0" checked={selected.includes(id)} disabled={stale || provisional} onChange={() => onToggle(id)} aria-label={m.kanban_select_task({ a0: task.title ?? id })} />}
                  <div className="min-w-0 flex-1">
                    <button type="button" disabled={provisional} onClick={() => onOpen(id)} className={cn('kanban-card w-full min-w-0 flex-1 rounded-md border border-border-subtle bg-bg p-2.5 text-left text-sm text-text hover:border-accent-bg-strong', selected.includes(id) && 'selected')} data-task-id={id}>
                      <div className="font-medium">{task.title ?? id}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted">
                        {task.assignee && <span>{task.assignee}</span>}
                        {task.priority !== undefined && task.priority !== null && <span>P{String(task.priority)}</span>}
                        {task.session_id && <span className="text-accent-text">●</span>}
                      </div>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function TaskDialog({ board, task, readOnly, onClose, onChanged }: { board: string | undefined; task: KanbanTask; readOnly: boolean; onClose: () => void; onChanged: () => void }) {
  const [comment, setComment] = useState('')
  const [pendingRunningExit, setPendingRunningExit] = useState<(() => void) | null>(null)
  const [parentId, setParentId] = useState('')
  const effects = useResourceEffects()
  const busy = readOnly
  const taskId = String(task.id)
  const log = useQuery({ queryKey: [...keys.kanban.board(board), 'task-log', String(task.id)], queryFn: () => api.fetchKanbanTaskLog(board, task.id), staleTime: 10_000 })
  const detail = useQuery({ queryKey: [...keys.kanban.board(board), 'task', String(task.id)], queryFn: () => api.fetchKanbanTask(board, task.id), staleTime: 10_000 })
  const link = useResourceMutation({
    resource: ({ parent, child }: { parent: string; child: string; remove: boolean }) => linkResource(board, parent, child),
    queryKey: keys.kanban.board(board),
    readKeys: ({ parent, child }) => kanbanReads(board, [parent, child]),
    effect: ({ remove }) => remove ? { remove: true } : { value: true },
    mutationFn: ({ parent, child, remove }) => remove ? api.unlinkKanbanTasks(board, parent, child) : api.linkKanbanTasks(board, parent, child),
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'),
  })
  // Pending link writes show at once: removed ids drop out, added ids join the server's list.
  const shownLinks = (ids: string[], pair: (id: string) => { parent: string; child: string }) => {
    const pending = Object.entries(effects).flatMap(([key, effect]) => {
      if (effect.remove || !key.startsWith('["kanban-link"')) return []
      const [, , parent, child] = JSON.parse(key) as [string, unknown, string, string]
      const id = parent === taskId ? child : parent
      const link = pair(id)
      return linkResource(board, link.parent, link.child) === key && !ids.includes(id) ? [id] : []
    })
    return [...ids.filter((id) => { const link = pair(id); return !effects[linkResource(board, link.parent, link.child)]?.remove }), ...pending]
  }
  const links = detail.data?.links
  // A linked task the server could not name (since deleted) falls back to its id.
  const linked = new Map((detail.data?.link_tasks ?? []).map((t) => [t.id, t]))
  const act = useResourceMutation({
    resource: () => cardResource(board, taskId),
    queryKey: keys.kanban.board(board),
    readKeys: () => kanbanReads(board, [taskId]),
    // Unblock lands in Ready, which the server may re-gate on parents.
    effect: ({ action, body }: { action: 'patch' | 'block' | 'unblock'; body: Record<string, unknown> }) => ({ fields: { status: action === 'block' ? 'blocked' : action === 'unblock' ? 'ready' : body.status } }),
    mutationFn: ({ action, body }) => api.kanbanTaskAction(board, task.id, action, body),
    onSuccess: () => { showToast(m.saved()) },
    // A refusal (the task changed since this board was read) refetches, so the dialog shows its current actions.
    onError: (e) => { showToast(e instanceof Error ? e.message : String(e), 4000, 'error') },
  })
  // Dispatch starts a worker on the server: only its button is busy.
  const dispatchTask = useMutation({ mutationFn: () => api.kanbanTaskAction(board, task.id, 'dispatch', {}), onSuccess: () => { showToast(m.saved()); onChanged() }, onError: (e) => { showToast(e instanceof Error ? e.message : String(e), 4000, 'error'); onChanged() } })
  // A sent comment joins the log at once; a refused one stays there with Retry instead of losing its text.
  const [unsent, setUnsent] = useState<string[]>([])
  const commentWrite = useResourceMutation({
    resource: ({ resource }: { resource: string; text: string }) => resource,
    queryKey: keys.kanban.board(board), readKeys: () => kanbanReads(board, [taskId]), exclusive: true,
    effect: ({ text }) => ({ fields: { text } }),
    mutationFn: ({ text }) => api.kanbanTaskAction(board, task.id, 'comments', { body: text, text }),
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'),
  })
  const sendComment = (text: string) => commentWrite.mutate({ text, resource: newResource(`kanban-comment-${board ?? ''}-${taskId}`) }, { onError: (e) => { if (isDefiniteRefusal(e)) setUnsent((rows) => [...rows, text]) } })
  const sending = withCreated<{ text: string }>([], `kanban-comment-${board ?? ''}-${taskId}`, effects)
  const entries: unknown[] = log.data?.log ?? log.data?.entries ?? []
  // The server owns which actions a card offers and whether leaving Running needs confirmation (TAL-557).
  const actions = task.available_actions
  // A confirmed write says so; the server refuses to take a task out of Running without it.
  const request = (fn: (confirm: { confirm_running_exit: boolean }) => void) => { if (busy) return; if (task.requires_running_exit_confirmation) setPendingRunningExit(() => () => fn({ confirm_running_exit: true })); else fn({ confirm_running_exit: false }) }
  const setStatus = (status: string) => request((confirm) => act.mutate({ action: 'patch', body: { status, ...confirm } }))
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={task.title ?? String(task.id)} description={task.description ?? undefined} className="w-[min(92vw,640px)]">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{m.kanban_column_label()}:</span>
          <Select value={task.status ?? ''} disabled={busy || actions.move_to.length === 0} onValueChange={setStatus} aria-label={m.kanban_column_label()}>
            {[...new Set([task.status ?? '', ...actions.move_to])].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          {task.assignee && <span>{task.assignee}</span>}
          {task.session_id && <Link to="/session/$sessionId" params={{ sessionId: task.session_id }} className="text-accent-text underline">{m.kanban_open_session()}</Link>}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || dispatchTask.isPending} aria-busy={dispatchTask.isPending || undefined} onClick={() => dispatchTask.mutate()}>{m.kanban_dispatch()}</Button>
            {actions.block && <Button disabled={busy} onClick={() => request((confirm) => act.mutate({ action: 'block', body: confirm }))}>{m.kanban_block()}</Button>}
            {actions.unblock && <Button disabled={busy} onClick={() => request(() => act.mutate({ action: 'unblock', body: {} }))}>{m.kanban_unblock()}</Button>}
            {actions.complete && <Button disabled={busy} onClick={() => setStatus('done')}>{m.kanban_complete()}</Button>}
            {actions.archive && <Button disabled={busy} onClick={() => setStatus('archived')}>{m.kanban_archive()}</Button>}
          </div>
        )}
        <div role="group" aria-label={m.kanban_links()}>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{m.kanban_links()}</div>
          {links && (
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              {([[m.kanban_parents(), (id: string) => ({ parent: id, child: taskId }), links.parents], [m.kanban_children(), (id: string) => ({ parent: taskId, child: id }), links.children]] as const).map(([label, pair, ids]) => [label, pair, shownLinks(ids, pair)] as const).map(([label, pair, ids]) => (
                <div key={label}>
                  <div className="text-muted">{label}</div>
                  {ids.length === 0 && <div className="text-muted">—</div>}
                  <ul>
                    {ids.map((id) => {
                      const named = linked.get(id)
                      return (
                        <li key={id} className="flex items-center gap-1">
                          {named ? <span className="min-w-0 truncate" title={id}>{named.title} <span className="text-muted">· {statusLabel(named.status)}</span></span> : <span className="font-mono">{id}</span>}
                          {!readOnly && <IconButton label={m.kanban_remove_dependency_named({ a0: named ? `${named.title} (${id})` : id })} className="h-6 w-6" onClick={() => link.mutate({ ...pair(id), remove: true })}><X size={12} aria-hidden="true" /></IconButton>}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {!readOnly && (
            <form onSubmit={(e) => { e.preventDefault(); if (parentId.trim()) { link.mutate({ parent: parentId.trim(), child: taskId, remove: false }); setParentId('') } }} className="mt-2 flex gap-2">
              <TextInput value={parentId} onChange={(e) => setParentId(e.target.value)} placeholder={m.kanban_parents_placeholder()} aria-label={m.kanban_parents_placeholder()} />
              <Button type="submit" disabled={!parentId.trim()}>{m.kanban_add_dependency()}</Button>
            </form>
          )}
        </div>
        <ConfirmDialog open={pendingRunningExit !== null} onOpenChange={(o) => { if (!o) setPendingRunningExit(null) }} title={m.kanban_leave_running_title()} description={m.kanban_leave_running_body()} confirmLabel={m.kanban_continue()} cancelLabel={m.cancel()} danger onConfirm={() => pendingRunningExit?.()} />
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{m.kanban_comments()}</div>
          {!readOnly && (
            <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) { sendComment(comment.trim()); setComment('') } }} className="flex gap-2">
              <TextInput value={comment} onChange={(e) => setComment(e.target.value)} placeholder={m.kanban_add_comment()} aria-label={m.kanban_add_comment()} />
              <Button type="submit">{m.add()}</Button>
            </form>
          )}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{m.kanban_log()}</div>
          {log.isPending && <LoadingState />}
          {log.isSuccess && entries.length === 0 && sending.length === 0 && unsent.length === 0 && <div className="text-xs text-muted">—</div>}
          <ul className="max-h-60 overflow-y-auto text-xs">
            {entries.map((e, i) => {
              const row = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {}
              const when = row.ts ?? row.created_at
              const text = [row.message, row.text, row.body, row.event].find((v) => typeof v === 'string')
              return <li key={i} className="border-b border-border-subtle py-1"><span className="text-muted">{formatDate(typeof when === 'number' || typeof when === 'string' ? when : null)}</span> {typeof text === 'string' ? text : JSON.stringify(e)}</li>
            })}
            {sending.map((row, i) => <li key={`sending-${i}`} className="border-b border-border-subtle py-1">{row.text}</li>)}
            {unsent.map((text, i) => (
              <li key={`unsent-${i}`} className="flex items-center gap-2 border-b border-border-subtle py-1">
                <span className="min-w-0 flex-1">{text}</span>
                <button type="button" className="linklike shrink-0" onClick={() => { setUnsent((rows) => rows.filter((_, j) => j !== i)); sendComment(text) }}>{m.retry()}</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  )
}

/** Closes on Create: the card shows at once while the server creates it. */
function CreateTaskDialog({ columns, onClose, onSubmit }: { columns: string[]; onClose: () => void; onSubmit: (task: { title: string; description: string; status: string }) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState(columns[0] ?? '')
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={m.kanban_new_task()}>
      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit({ title: title.trim(), description: description.trim(), status }) }} className="flex flex-col gap-1">
        <FieldRow label={m.kanban_task_title()} htmlFor="kanbanTitle"><TextInput id="kanbanTitle" required value={title} onChange={(e) => setTitle(e.target.value)} /></FieldRow>
        <FieldRow label={m.kanban_description_placeholder()} htmlFor="kanbanDesc"><textarea id="kanbanDesc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-text" /></FieldRow>
        <FieldRow label={m.kanban_column_label()} htmlFor="kanbanStatus"><Select id="kanbanStatus" value={status} onValueChange={(v) => setStatus(v)} className="w-full">{columns.map((c) => <option key={c} value={c}>{c}</option>)}</Select></FieldRow>
        <div className="mt-3 flex justify-end gap-2"><Button onClick={onClose}>{m.cancel()}</Button><Button variant="primary" type="submit">{m.create()}</Button></div>
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
