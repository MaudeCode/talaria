/**
 * TAL-373: the right panel's Agents page. It lists the session's delegated agents as the server records them (TAL-372):
 * the server scopes, orders and labels them; a split batch's units are separate entries. It fetches only while shown.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { BackgroundTask } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { ErrorState, LoadingState } from '../../ui/States'
import { relativeTime } from '../sessions/SessionListPanel'
import { m } from '../../paraglide/messages.js'
import { useEffect, useState } from 'react'
import { onOpenAgentRequest, takeOpenAgentRequest } from './openAgentRequest'
import { cn } from '../../ui/cn'
import { SteerForm, TaskActionButtons, TaskHeading, agentsSummary, delegationSummary, statusLabel, useTaskActions } from './BackgroundWork'
import { RowContextMenu } from '../../ui/Menu'

const LIVE_REFRESH_MS = 10_000

/** The session's delegations. ponytail: old-server fallback — a server before TAL-373 ignores `kind` and returns every
 * kind; keep only delegations until every supported server narrows the list itself. */
const fetchAgents = async (sessionId: string) => {
  const response = await api.fetchBackgroundTasks(sessionId, 'delegation')
  return { ...response, tasks: response.tasks.filter((t) => t.kind === 'delegation') }
}
/** Whether the session has agents running or needing attention (the panel's first default page); undefined until this
 * mount has its own answer, so a snapshot cached from an earlier visit never picks the page. Asks only while the panel
 * is open, so a chat opened with the panel closed sends no request (TAL-1388). */
export function useHasActiveAgents(sessionId: string, open: boolean): boolean | undefined {
  // Always stale: a snapshot still fresh under the app's stale time is from an earlier visit, not this one, so mounting
  // open or opening later both ask again. The Agents page keeps the list current; this probe never refetches on focus.
  const query = useQuery({ queryKey: keys.backgroundAgents(sessionId), queryFn: () => fetchAgents(sessionId), enabled: open, staleTime: 0, refetchOnWindowFocus: false })
  if (!query.isFetchedAfterMount && !query.isError) return undefined
  // ponytail: old-server fallback — a server before TAL-373 sends no `agents_working`; it then opens on the last page.
  return query.data?.agents_working ?? false
}

export function AgentsPage({ sessionId, active }: { sessionId: string; active: boolean }) {
  const query = useQuery({
    queryKey: keys.backgroundAgents(sessionId),
    queryFn: () => fetchAgents(sessionId),
    enabled: active,
    refetchInterval: (q) => (active && (q.state.data?.tasks.some((t) => t.active) || q.state.data?.delegation_status?.refresh) ? LIVE_REFRESH_MS : false),
  })
  // TAL-2333: the unit a delegation row's subagent opened, scrolled into view and marked once the list shows it.
  const [focused, setFocused] = useState<string | null>(null)
  const loaded = query.isSuccess
  useEffect(() => {
    if (!active || !loaded) return
    const take = () => { const request = takeOpenAgentRequest(sessionId); if (request) setFocused(request.taskId) }
    take()
    return onOpenAgentRequest(take)
  }, [active, loaded, sessionId])
  useEffect(() => { if (focused) document.querySelector(`.agents-entry[data-task-id="${CSS.escape(focused)}"]`)?.scrollIntoView?.({ block: 'nearest' }) }, [focused])
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />
  const { tasks, agent_available: available, delegation_status: delivery, owner_work: owner } = query.data
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {(!available || owner === 'unavailable') && <div className="border-b border-border-subtle px-3 py-2 text-xs text-muted" role="status">{m.panel_agents_unavailable()}</div>}
      {owner === 'unsupported' && <div className="border-b border-border-subtle px-3 py-2 text-xs text-muted" role="status">{m.panel_agents_owner_unsupported()}</div>}
      {delivery?.visible && <div className="agents-delivery border-b border-border-subtle px-3 py-2 text-xs text-muted" role="status" data-availability={delivery.availability}>{delegationSummary(delivery)}</div>}
      {tasks.length === 0 ? (
        <div className="p-3 text-xs text-muted" role="status">{m.panel_agents_empty()}</div>
      ) : (
        <ul className="flex flex-col" aria-label={m.panel_agents()}>
          {tasks.map((t) => (
            <AgentEntry key={t.task_id} sessionId={sessionId} task={t} focused={focused === t.task_id} />
          ))}
        </ul>
      )}
    </div>
  )
}

function AgentEntry({ sessionId, task: t, focused }: { sessionId: string; task: BackgroundTask; focused: boolean }) {
  const [steering, setSteering] = useState(false)
  const { actions, error } = useTaskActions(sessionId, t, { onSteer: steering ? undefined : () => setSteering(true) })
  return (
    <RowContextMenu label={t.title} actions={actions} trigger={<li className={cn('agents-entry flex flex-col gap-0.5 border-b border-border-subtle px-3 py-2', focused && 'bg-hover')} data-task-id={t.task_id} data-status={t.status} aria-current={focused || undefined}>
      <TaskHeading task={t} title={<span className="text-[13px] text-text">{t.title}</span>}>
        <span className="text-[11px] text-muted">{statusLabel(t.status)}</span>
        <TaskActionButtons actions={actions} error={error} />
      </TaskHeading>
      {steering && t.can_steer && <SteerForm sessionId={sessionId} task={t} onClose={() => setSteering(false)} />}
      <div className="flex min-w-0 items-center gap-2 pl-5 text-[11px] text-muted">
        {t.agents && <span>{agentsSummary(t.agents)}</span>}
        <span>{m.panel_agents_updated({ time: relativeTime(t.updated_at) })}</span>
      </div>
      {/* TAL-494: each subagent's own read-only transcript, by its goal when the unit ran several. */}
      {t.child_sessions.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5 pl-5 text-[11px]">
          {t.child_sessions.map((c) => (
            <Link key={c.session_id} to="/session/$sessionId" params={{ sessionId: c.session_id }} className="min-w-0 truncate text-accent-text underline" title={c.goal}>
              {t.child_sessions.length > 1 ? m.panel_agents_transcript_for({ goal: c.goal }) : m.panel_agents_transcript()}
            </Link>
          ))}
        </div>
      )}
    </li>} />
  )
}
