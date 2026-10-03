/**
 * TAL-373: the right panel's Agents page. It lists the session's delegated agents as the server records them (TAL-372):
 * the server scopes, orders and labels them; a split batch's units are separate entries. It refreshes only while shown.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { ErrorState, LoadingState } from '../../ui/States'
import { relativeTime } from '../sessions/SessionListPanel'
import { m } from '../../paraglide/messages.js'
import { agentsSummary, StatusIcon, statusLabel } from './BackgroundWork'

const LIVE_REFRESH_MS = 10_000

/** Whether the session has agents running or needing attention (the panel's first default page); undefined until known. */
export function useHasActiveAgents(sessionId: string): boolean | undefined {
  const query = useQuery({ queryKey: keys.backgroundAgents(sessionId), queryFn: () => api.fetchBackgroundTasks(sessionId, 'delegation') })
  if (query.isPending) return undefined
  return (query.data?.tasks ?? []).some((t) => t.status === 'running' || t.status === 'attention')
}

export function AgentsPage({ sessionId, active }: { sessionId: string; active: boolean }) {
  const query = useQuery({
    queryKey: keys.backgroundAgents(sessionId),
    queryFn: () => api.fetchBackgroundTasks(sessionId, 'delegation'),
    refetchInterval: (q) => (active && q.state.data?.tasks.some((t) => t.active) ? LIVE_REFRESH_MS : false),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />
  const { tasks, agent_available: available } = query.data
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!available && <div className="border-b border-border-subtle px-3 py-2 text-xs text-muted" role="status">{m.panel_agents_unavailable()}</div>}
      {tasks.length === 0 ? (
        <div className="p-3 text-xs text-muted" role="status">{m.panel_agents_empty()}</div>
      ) : (
        <ul className="flex flex-col" aria-label={m.panel_agents()}>
          {tasks.map((t) => (
            <li key={t.task_id} className="agents-entry flex flex-col gap-0.5 border-b border-border-subtle px-3 py-2" data-task-id={t.task_id} data-status={t.status}>
              <div className="flex min-w-0 items-center gap-1.5">
                <StatusIcon status={t.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-text" title={t.title}>{t.title}</span>
                <span className="shrink-0 text-[11px] text-muted">{statusLabel(t.status)}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2 pl-5 text-[11px] text-muted">
                {t.agents && <span>{agentsSummary(t.agents)}</span>}
                <span>{m.panel_agents_updated({ time: relativeTime(t.updated_at) })}</span>
                {t.child_session_id && <Link to="/session/$sessionId" params={{ sessionId: t.child_session_id }} className="ml-auto text-accent-text underline">{m.panel_agents_transcript()}</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
