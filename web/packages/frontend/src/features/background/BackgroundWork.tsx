/**
 * TAL-372: the session's background work, as the server records it. The composer's chip opens what the server pins:
 * running work, and a finished `/background` result until someone dismisses it. Every client reads the same records.
 */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, CircleHelp, Clock, LoaderCircle, X } from 'lucide-react'
import type { BackgroundLink, BackgroundTask, BackgroundReviewState } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Markdown } from '../chat/render/Markdown'
import { m } from '../../paraglide/messages.js'
import { showErrorToast } from '../toast/errorToast'
import { isDefiniteRefusal } from '../../contracts/common'
import { newResource, useResourceEffects, useResourceMutation, withCreated, withEffects } from '../sessions/useResourceMutation'

/** Running work changes on the Agent's side; a quiet refresh keeps the card current between server notices. */
const LIVE_REFRESH_MS = 15_000

const backgroundResource = (sessionId: string, taskId: string) => `background:${sessionId}:${taskId}`
const launchKind = (sessionId: string) => `background-launch-${sessionId}`

/**
 * `/background` shows its task at once as running work with the submitted prompt; the server's task replaces it on the
 * reread, and a refusal removes it. A lost answer is never relaunched: the reread decides. `notStarted` runs when the
 * server refused, or when the reread after a lost answer shows no new task.
 */
export function useStartBackground() {
  const qc = useQueryClient()
  const { mutate } = useResourceMutation({
    resource: ({ resource }: { resource: string; sessionId: string; prompt: string }) => resource,
    queryKey: ['sessions', 'background'], readKeys: ({ sessionId }) => [{ queryKey: keys.background(sessionId), exact: true }], exclusive: true,
    effect: ({ resource, prompt }) => ({ fields: { task_id: resource, kind: 'background_command', status: 'running', title: prompt, started_at: null, updated_at: 0, completed_at: null, result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true } satisfies BackgroundTask }),
    mutationFn: ({ sessionId, prompt }) => api.startBackground(sessionId, prompt),
    onError: (e) => showErrorToast(e),
  })
  return (sessionId: string, prompt: string, notStarted: () => void) => {
    const key = keys.background(sessionId)
    type Tasks = Awaited<ReturnType<typeof api.fetchBackgroundTasks>>
    const known = new Set(qc.getQueryData<Tasks>(key)?.tasks.map((task) => task.task_id))
    const sent = Date.now()
    mutate({ resource: newResource(launchKind(sessionId)), sessionId, prompt }, {
      onError: (error) => {
        if (isDefiniteRefusal(error)) { notStarted(); return }
        const read = qc.getQueryState<Tasks>(key)
        if (read?.data && read.dataUpdatedAt >= sent && !read.data.tasks.some((task) => !known.has(task.task_id))) notStarted()
      },
    })
  }
}

/** The session's background work as the user sees it: a dismissed result leaves at once. */
export function useBackgroundTasks(sessionId: string | null | undefined) {
  const effects = useResourceEffects()
  return useQuery({
    queryKey: keys.background(sessionId ?? ''),
    queryFn: () => api.fetchBackgroundTasks(sessionId ?? ''),
    select: (data) => ({ ...data, tasks: withCreated(withEffects(data.tasks, (task) => backgroundResource(sessionId ?? '', task.task_id), effects), launchKind(sessionId ?? ''), effects) }),
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

/**
 * TAL-1336: a steering message for an owner subagent the server marks `can_steer`, on its own line under the row. The
 * owner decides whether a running child takes it, so Send stays busy until it answers; a refusal keeps the text.
 */
export function SteerForm({ sessionId, task, onClose }: { sessionId: string; task: BackgroundTask; onClose: () => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const steer = useMutation({
    mutationFn: (message: string) => api.steerBackgroundTask(sessionId, task.task_id, message),
    onSuccess: (result) => { if (result.outcome === 'queued') onClose(); void qc.invalidateQueries({ queryKey: keys.background(sessionId) }) },
  })
  const refused = steer.data && steer.data.outcome !== 'queued'
  return (
    <form className="flex min-w-0 flex-wrap items-center gap-1.5 pl-5" onSubmit={(e) => { e.preventDefault(); if (text.trim()) steer.mutate(text) }}>
      <input className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface px-2 py-1 text-[13px]" aria-label={m.bg_steer_label()} value={text} autoFocus
        onChange={(e) => { setText(e.target.value); steer.reset() }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }} />
      <button type="submit" className="composer-notice-action" disabled={steer.isPending || !text.trim()}>{m.bg_steer_send()}</button>
      {(refused || steer.isError) && <span role="alert" className="basis-full text-warning">{steer.isError ? steer.error.message : m.bg_steer_rejected()}</span>}
    </form>
  )
}

/** One background row's heading: its title, then status and actions as one group that wraps under a long title. */
export function TaskHeading({ task, title, titleBasis = 'basis-24', children }: { task: BackgroundTask; title: ReactNode; titleBasis?: 'basis-24' | 'basis-36'; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <StatusIcon status={task.status} />
      <span className={`min-w-0 flex-1 ${titleBasis} truncate`} title={task.title}>{title}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">{children}</span>
    </div>
  )
}

/** One action slot for a background row in the composer and Agents page. */
export function BackgroundTaskAction({ sessionId, task, onSteer }: { sessionId: string; task: BackgroundTask; onSteer?: (() => void) | undefined }) {
  const qc = useQueryClient()
  const stopping = Boolean(task.can_stop)
  const stop = useMutation({
    mutationFn: () => api.stopBackgroundTask(sessionId, task.task_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.background(sessionId) }),
  })
  // Dismiss removes a result from view; Stop waits for the Agent's completion.
  const dismiss = useResourceMutation({ resource: () => backgroundResource(sessionId, task.task_id), queryKey: keys.background(sessionId), effect: () => ({ remove: true }), mutationFn: () => api.dismissBackgroundTask(sessionId, task.task_id), onError: (e) => showErrorToast(e) })
  const action = stopping ? stop : dismiss
  if (!stopping && !task.dismissible) return null
  return <>
    <button type="button" className="composer-notice-action" disabled={action.isPending} onClick={() => action.mutate()}>{stopping ? m.bg_stop() : m.notice_dismiss()}</button>
    {action.isError && <span role="alert" className="text-warning">{action.error.message}</span>}
    {task.can_steer && onSteer && <button type="button" className="composer-notice-action" onClick={onSteer}>{m.bg_steer()}</button>}
  </>
}

function TaskRow({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const [open, setOpen] = useState(false)
  const [steering, setSteering] = useState(false)
  const result = useQuery({ queryKey: keys.backgroundResult(sessionId, task.task_id), queryFn: () => api.fetchBackgroundResult(sessionId, task.task_id), enabled: open && task.result_available })
  return (
    <li className="bg-work-task flex min-w-0 flex-col gap-1" data-task-id={task.task_id} data-status={task.status}>
      <TaskHeading task={task} titleBasis="basis-36" title={<><span className="text-muted">{kindLabel(task.kind)}</span> {task.title}</>}>
        <span className="text-[11px] text-muted">{task.agents && task.agents.total > 1 ? agentsSummary(task.agents) : statusLabel(task.status)}</span>
        {task.result_available && <button type="button" className="composer-notice-action" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? m.bg_hide_result() : m.bg_show_result()}</button>}
        <BackgroundTaskAction sessionId={sessionId} task={task} onSteer={steering ? undefined : () => setSteering(true)} />
      </TaskHeading>
      {steering && task.can_steer && <SteerForm sessionId={sessionId} task={task} onClose={() => setSteering(false)} />}
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
