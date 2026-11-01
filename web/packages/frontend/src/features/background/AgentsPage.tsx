/**
 * TAL-373: the right panel's Agents page. It lists the session's delegated agents as the server records them (TAL-372):
 * the server scopes, orders and labels them; a split batch's units are separate entries. It fetches only while shown.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { DelegationStatus } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { ErrorState, LoadingState } from '../../ui/States'
import { relativeTime } from '../sessions/SessionListPanel'
import { m } from '../../paraglide/messages.js'
import { BackgroundTaskAction, agentsSummary, StatusIcon, statusLabel } from './BackgroundWork'

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

/** TAL-1579: the server's delegation summary in words; the server decides whether it shows. */
export function delegationSummary(status: DelegationStatus): string {
  if (status.availability === 'unsupported') return m.panel_agents_delivery_unsupported()
  if (status.availability === 'unknown' || status.running_count === null || status.awaiting_delivery_count === null) return m.panel_agents_delivery_unknown()
  const parts = []
  if (status.running_count) parts.push(m.panel_agents_delivery_running({ n: status.running_count }))
  // A dispatch the live registry holds before its ledger row is running, though not yet counted.
  else if (status.memory_live) parts.push(m.bg_status_running())
  if (status.awaiting_delivery_count) parts.push(m.panel_agents_delivery_waiting({ n: status.awaiting_delivery_count }))
  return parts.length ? parts.join(' · ') : m.panel_agents_delivery_none()
}

export function AgentsPage({ sessionId, active }: { sessionId: string; active: boolean }) {
  const query = useQuery({
    queryKey: keys.backgroundAgents(sessionId),
    queryFn: () => fetchAgents(sessionId),
    enabled: active,
    refetchInterval: (q) => (active && (q.state.data?.tasks.some((t) => t.active) || q.state.data?.delegation_status?.refresh) ? LIVE_REFRESH_MS : false),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />
  const { tasks, agent_available: available, delegation_status: delivery } = query.data
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!available && <div className="border-b border-border-subtle px-3 py-2 text-xs text-muted" role="status">{m.panel_agents_unavailable()}</div>}
      {delivery?.visible && <div className="agents-delivery border-b border-border-subtle px-3 py-2 text-xs text-muted" role="status" data-availability={delivery.availability}>{delegationSummary(delivery)}</div>}
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
                <BackgroundTaskAction sessionId={sessionId} task={t} />
              </div>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
