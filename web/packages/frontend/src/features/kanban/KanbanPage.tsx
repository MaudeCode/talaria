import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus, RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { z } from 'zod'
import type { KanbanTaskSchema } from '../../contracts'
import { HubPage } from '../../shell/AppShell'
import { PanelHeadButton } from '../../shell/Sidebar'
import { Button, IconButton } from '../../ui/Button'
import { Switch, FieldRow, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { Dialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

type KanbanTask = z.infer<typeof KanbanTaskSchema>

export function KanbanPage() {
  const qc = useQueryClient()
  const [includeArchived, setIncludeArchived] = useState(false)
  const [openTask, setOpenTask] = useState<KanbanTask | null>(null)
  const [creating, setCreating] = useState(false)
  const boards = useQuery({ queryKey: keys.kanban.boards, queryFn: api.fetchKanbanBoards, staleTime: 30_000 })
  const board = useQuery({ queryKey: [...keys.kanban.board(boards.data?.current), includeArchived], queryFn: () => api.fetchKanbanBoard({ include_archived: includeArchived ? '1' : undefined }), staleTime: 10_000, enabled: boards.isSuccess })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['kanban'] })
  const switchBoard = useMutation({ mutationFn: (slug: string) => api.switchKanbanBoard(slug), onSuccess: () => { void invalidate() } })
  const columns = useMemo(() => board.data?.columns ?? [], [board.data])
  const readOnly = !!board.data?.read_only
  const columnNames = useMemo(() => columns.map((c) => c.name), [columns])

  return (
    <HubPage
      title={m.tab_kanban()}
      actions={
        <>
          <IconButton label={m.refresh()} onClick={() => { void invalidate() }}><RefreshCw size={16} aria-hidden="true" /></IconButton>
          {!readOnly && <PanelHeadButton label={m.kanban_new_task()} className="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>}
        </>
      }
      toolbar={
        <>
          {boards.data && boards.data.boards.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted">
              {m.kanban_board_label()}
              <Select value={boards.data.current ?? ''} onValueChange={(v) => switchBoard.mutate(v)} aria-label={m.kanban_board_label()}>
                {boards.data.boards.map((b) => <option key={b.slug} value={b.slug}>{b.name ?? b.slug}{b.total !== undefined ? ` (${b.total})` : ''}</option>)}
              </Select>
            </label>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted"><Switch checked={includeArchived} onCheckedChange={(checked) => setIncludeArchived(checked)} /> {m.kanban_include_archived()}</label>
          {readOnly && <span className="text-xs text-warning">{m.kanban_read_only()}</span>}
        </>
      }
    >
      {(boards.isPending || board.isPending) && <LoadingState />}
      {boards.isError && <ErrorState error={boards.error} onRetry={() => { void boards.refetch() }} />}
      {board.isError && <ErrorState error={board.error} onRetry={() => { void board.refetch() }} />}
      {boards.isSuccess && boards.data.boards.length === 0 && <EmptyState>{m.kanban_no_boards()}</EmptyState>}
      {board.isSuccess && (
        <div className="kanban-board grid gap-3 md:grid-cols-2 xl:grid-cols-3" id="kanbanList">
          {columns.map((col) => (
            <section key={col.name} className="kanban-column flex min-h-40 flex-col rounded-lg border border-border bg-surface" aria-label={col.name}>
              <header className="flex items-center justify-between border-b border-border-subtle px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted">
                <span>{col.name}</span><span>{col.tasks.length}</span>
              </header>
              <div className="flex flex-col gap-2 p-2">
                {col.tasks.length === 0 && <div className="px-1 py-2 text-xs text-muted">{m.kanban_no_tasks()}</div>}
                {col.tasks.map((task) => (
                  <button key={String(task.id)} type="button" onClick={() => setOpenTask(task)} className={cn('kanban-card rounded-md border border-border-subtle bg-bg p-2.5 text-left text-sm text-text hover:border-accent-bg-strong')} data-task-id={String(task.id)}>
                    <div className="font-medium">{task.title ?? String(task.id)}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted">
                      {task.assignee && <span>{task.assignee}</span>}
                      {task.priority !== undefined && task.priority !== null && <span>P{String(task.priority)}</span>}
                      {task.session_id && <span className="text-accent-text">●</span>}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {openTask && <TaskDialog task={openTask} columns={columnNames} readOnly={readOnly} onClose={() => setOpenTask(null)} onChanged={() => { void invalidate() }} />}
      {creating && <CreateTaskDialog columns={columnNames} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void invalidate() }} />}
    </HubPage>
  )
}

function TaskDialog({ task, columns, readOnly, onClose, onChanged }: { task: KanbanTask; columns: string[]; readOnly: boolean; onClose: () => void; onChanged: () => void }) {
  const [comment, setComment] = useState('')
  const log = useQuery({ queryKey: ['kanban', 'task-log', String(task.id)], queryFn: () => api.fetchKanbanTaskLog(task.id), staleTime: 10_000 })
  const act = useMutation({
    mutationFn: ({ action, body }: { action: Parameters<typeof api.kanbanTaskAction>[1]; body: Record<string, unknown> }) => api.kanbanTaskAction(task.id, action, body),
    onSuccess: (res) => { if (res.error) showToast(res.error, 4000, 'error'); else { showToast(m.saved()); onChanged(); void log.refetch() } },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'),
  })
  const entries: unknown[] = log.data?.log ?? log.data?.entries ?? []
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }} title={task.title ?? String(task.id)} description={task.description ?? undefined} className="w-[min(92vw,640px)]">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{m.kanban_column_label()}:</span>
          <Select value={task.status ?? ''} disabled={readOnly} onValueChange={(v) => act.mutate({ action: 'patch', body: { status: v } })} aria-label={m.kanban_column_label()}>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          {task.assignee && <span>{task.assignee}</span>}
          {task.session_id && <Link to="/session/$sessionId" params={{ sessionId: task.session_id }} className="text-accent-text underline">{m.kanban_open_session()}</Link>}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act.mutate({ action: 'dispatch', body: {} })}>{m.kanban_dispatch()}</Button>
            <Button onClick={() => act.mutate({ action: 'patch', body: { archived: true } })}>{m.kanban_archive()}</Button>
          </div>
        )}
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
    onSuccess: (res) => { if (res.error) setError(res.error); else onCreated() },
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
