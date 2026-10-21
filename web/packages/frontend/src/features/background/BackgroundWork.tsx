/**
 * TAL-372: the session's background work, as the server records it. The composer's chip opens what the server pins:
 * running work, and a finished `/background` result until someone dismisses it. Every client reads the same records.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, CircleHelp, Clock, LoaderCircle, X } from 'lucide-react'
import type { BackgroundLink, BackgroundTask, BackgroundReviewState } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Markdown } from '../chat/render/Markdown'
import { m } from '../../paraglide/messages.js'

/** Running work changes on the Agent's side; a quiet refresh keeps the card current between server notices. */
const LIVE_REFRESH_MS = 15_000

export function useBackgroundTasks(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: keys.background(sessionId ?? ''),
    queryFn: () => api.fetchBackgroundTasks(sessionId ?? ''),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => (query.state.data?.tasks.some((t) => t.active) ? LIVE_REFRESH_MS : false),
  })
}

export function statusLabel(status: BackgroundTask['status']): string {
  switch (status) {
    case 'running': return m.bg_status_running()
    case 'attention': return m.bg_status_attention()
    case 'completed': return m.bg_status_completed()
    case 'failed': return m.bg_status_failed()
    case 'cancelled': return m.bg_status_cancelled()
    case 'unknown': return m.bg_status_unknown()
  }
}

function kindLabel(kind: BackgroundTask['kind']): string {
  return kind === 'delegation' ? m.bg_kind_delegation() : kind === 'process' ? m.bg_kind_process() : m.bg_kind_background_command()
}

/** "2 of 3 done · 1 failed": a delegation's subagents, in place on its row and in the card. */
export function agentsSummary(agents: BackgroundLink['agents']): string {
  const parts = [m.bg_agents_progress({ done: agents.completed, total: agents.total })]
  if (agents.failed) parts.push(m.bg_agents_failed({ n: agents.failed }))
  return parts.join(' · ')
}

export function StatusIcon({ status }: { status: BackgroundTask['status'] | BackgroundReviewState }) {
  if (status === 'waiting') return <Clock size={13} className="shrink-0 text-muted" aria-hidden="true" />
  if (status === 'reviewing') return <LoaderCircle size={13} className="shrink-0 animate-spin motion-reduce:animate-none text-muted" aria-hidden="true" />
  if (status === 'running') return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
  if (status === 'completed' || status === 'reviewed') return <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
  if (status === 'unknown') return <CircleHelp size={13} className="shrink-0 text-muted" aria-hidden="true" />
  if (status === 'cancelled') return <X size={13} className="shrink-0 text-muted" aria-hidden="true" />
  return <AlertTriangle size={13} className="shrink-0 text-warning" aria-hidden="true" />
}

/** One action slot for a background row in the composer and Agents page. */
export function BackgroundTaskAction({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const qc = useQueryClient()
  const stopping = Boolean(task.can_stop)
  const action = useMutation({
    mutationFn: async () => {
      if (stopping) await api.stopBackgroundTask(sessionId, task.task_id)
      else await api.dismissBackgroundTask(sessionId, task.task_id)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.background(sessionId) }),
  })
  if (!stopping && !task.dismissible) return null
  return <>
    <button type="button" className="composer-notice-action" disabled={action.isPending} onClick={() => action.mutate()}>{stopping ? m.bg_stop() : m.notice_dismiss()}</button>
    {action.isError && <span role="alert" className="text-warning">{action.error.message}</span>}
  </>
}

function TaskRow({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const [open, setOpen] = useState(false)
  const result = useQuery({ queryKey: keys.backgroundResult(sessionId, task.task_id), queryFn: () => api.fetchBackgroundResult(sessionId, task.task_id), enabled: open && task.result_available })
  return (
    <li className="bg-work-task flex min-w-0 flex-col gap-1" data-task-id={task.task_id} data-status={task.status}>
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon status={task.status} />
        <span className="min-w-0 flex-1 truncate" title={task.title}><span className="text-muted">{kindLabel(task.kind)}</span> {task.title}</span>
        <span className="shrink-0 text-[11px] text-muted">{task.agents && task.agents.total > 1 ? agentsSummary(task.agents) : statusLabel(task.status)}</span>
        {task.result_available && <button type="button" className="composer-notice-action" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? m.bg_hide_result() : m.bg_show_result()}</button>}
        <BackgroundTaskAction sessionId={sessionId} task={task} />
      </div>
      {open && (
        <div className="bg-work-result max-h-72 overflow-auto rounded-md bg-surface-subtle px-2 py-1 text-[13px]">
          {result.data ? <Markdown text={result.data.text} /> : result.isError ? <span className="text-muted">{m.bg_result_unavailable()}</span> : <span className="text-muted">{m.loading()}</span>}
        </div>
      )}
    </li>
  )
}

/** The list behind the composer's background chip: the work the server pins for this session; nothing when there is none. */
export function BackgroundWorkCard({ sessionId, tasks }: { sessionId: string; tasks: BackgroundTask[] }) {
  const pinned = tasks.filter((t) => t.pinned)
  if (!pinned.length) return null
  return (
    <span className="bg-work-card flex min-w-0 flex-1 flex-col gap-1" role="region" aria-label={m.bg_card_title()} aria-live="polite">
      <ul className="flex min-w-0 flex-col gap-1">{pinned.map((t) => <TaskRow key={t.task_id} sessionId={sessionId} task={t} />)}</ul>
    </span>
  )
}
