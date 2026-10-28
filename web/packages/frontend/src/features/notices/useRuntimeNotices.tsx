import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { chatConditionText } from './chatCondition'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts/common'
import type { SessionGoal, SessionNotice } from '@maudecode/talaria-web-contracts'
import type { LiveTurn } from '../../stream/reducer'
import type { ComposerNotice } from '../composer/ComposerNotices'
import { RunElapsed } from '../chat/LiveTurnView'

type AgentHealth = Awaited<ReturnType<typeof api.fetchAgentHealth>>

type Kind = 'thread_error' | 'server_unreachable' | 'offline' | 'agent_unavailable' | 'provider_failure' | 'agent_notice' | 'compressing' | 'goal'
interface Notice { id?: string; kind: Kind; tone: 'error' | 'warning' | 'info'; title: string; detail?: string | undefined; /** A short state shown on the right, keeping the row to one line. */ status?: React.ReactNode; action?: { label: string; run: () => void } | undefined; dismissible: boolean; oneLine?: boolean }
const PRIORITY: Kind[] = ['thread_error', 'server_unreachable', 'offline', 'agent_unavailable', 'provider_failure', 'agent_notice', 'compressing', 'goal']
const NOTICE_TONE: Record<SessionNotice['level'], Notice['tone']> = { error: 'error', warn: 'warning', info: 'info', success: 'info' }

/** TAL-808: the standing goal's row: its state, why it is paused or what it waits on, its text, and the turns used. */
function goalNotice(goal: SessionGoal): Notice {
  const title = goal.status === 'paused' ? m.goal_chip_paused() : goal.status === 'parked' ? m.goal_chip_parked() : m.goal_chip_active()
  const turns = { turns: goal.turns_used, max_turns: goal.max_turns }
  const status = goal.parked_until === null ? m.goal_chip_turns(turns) : m.goal_chip_turns_until({ ...turns, time: new Date(goal.parked_until * 1000).toLocaleTimeString(undefined, { timeStyle: 'short' }) })
  // One line on a phone: the goal text truncates and its tooltip carries it whole.
  return { kind: 'goal', tone: 'info', title, detail: [goal.reason, goal.text].filter(Boolean).join(' · '), status, dismissible: false, oneLine: true }
}

/** Wait before the next probe of an unreachable server: 1 s after the first failure, doubling to a 30 s cap. */
export function retryDelay(failures: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1))
}

/**
 * One server probe: the agent health answer, or how many probes in a row got no HTTP answer at all and when the last
 * one failed. Carrying the count in the query data lets `refetchInterval` back off without extra component state.
 */
interface Probe { health: AgentHealth | null; failures: number; failedAt: number }
const NO_AGENT_NOTICES: SessionNotice[] = []
const PROBE_KEY = [...keys.health.agent, 'probe'] as const
/** Probes in a row without an HTTP answer (about 3 s after the first) before Web says the server stopped. */
export const STOPPED_AFTER = 3

/** "Retrying in 8s", counting down to the next probe; a spinner while a probe is in flight. */
export function RetryCountdown({ at, busy }: { at: number; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (busy) return
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(tick)
  }, [at, busy])
  if (busy) return <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{m.notice_server_detail()}</span>
  return <span className="tabular-nums">{m.notice_server_retry_in({ seconds: String(Math.max(1, Math.ceil((at - now) / 1000))) })}</span>
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

/** The first notice, for the screen-reader regions: errors are assertive, everything else polite. */
export interface Announcement { assertive: boolean; text: string }

/**
 * The agent health poll doubles as the server probe: a request that never got an HTTP answer means this browser cannot
 * reach the Talaria server. Those probes back off exponentially; an HTTP error keeps the healthy cadence. `failures`
 * counts unanswered probes in a row, and is 0 while the browser is offline (that is its own notice).
 */
export function useServerProbe() {
  const online = useOnline()
  const qc = useQueryClient()
  const probe = useQuery({
    queryKey: PROBE_KEY,
    queryFn: async (): Promise<Probe> => {
      try {
        return { health: await api.fetchAgentHealth(), failures: 0, failedAt: 0 }
      } catch (e) {
        if (!isApiError(e) || (e.kind !== 'network' && e.kind !== 'timeout')) throw e
        const last = qc.getQueryData<Probe>(PROBE_KEY)
        return { health: last?.health ?? null, failures: (last?.failures ?? 0) + 1, failedAt: Date.now() }
      }
    },
    refetchInterval: (q) => (q.state.data && q.state.data.failures > 0 ? retryDelay(q.state.data.failures) : 10_000),
    staleTime: 2_000,
    retry: false,
    enabled: online,
  })
  const { refetch } = probe
  const retry = useCallback(() => { void refetch() }, [refetch])
  return { online, probe, failures: online ? (probe.data?.failures ?? 0) : 0, retry }
}

/**
 * Treat the server as stopped now (Stop server, or another tab said so); probes back off from there and the next answer
 * clears it. A probe sent before the stop is cancelled first, so its late answer cannot clear the stop.
 */
export function markServerStopped(qc: QueryClient): void {
  void qc.cancelQueries({ queryKey: PROBE_KEY }).then(() => {
    qc.setQueryData<Probe>(PROBE_KEY, (last) => (last && last.failures >= STOPPED_AFTER ? last : { health: last?.health ?? null, failures: STOPPED_AFTER, failedAt: Date.now() }))
  })
}

/** Probe now if the last probe went unanswered: another tab just reached the server. */
export function recheckServer(qc: QueryClient): void {
  if (qc.getQueryData<Probe>(PROBE_KEY)?.failures) void qc.refetchQueries({ queryKey: PROBE_KEY })
}

/**
 * Connection and runtime state as composer status chips (legacy HWEB-11, chips since TAL-1078): thread
 * error, unreachable Talaria server, offline, agent unavailable, provider failure, the session's Agent notices (TAL-803),
 * compression (TAL-1006: the manual job from `compressingSince`, its start in ms, or the live turn's open span), the
 * standing goal (TAL-808). A live turn's reconnect is the live row's own label.
 */
export function useRuntimeNotices({ live, onRetry, compressingSince, agentNotices = NO_AGENT_NOTICES, goal = null }: { live: LiveTurn | null; onRetry?: (() => void) | undefined; compressingSince: number | null; agentNotices?: SessionNotice[] | undefined; goal?: SessionGoal | null | undefined }): { notices: ComposerNotice[]; announcement: Announcement | null } {
  const { online, probe, failures, retry } = useServerProbe()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const health = probe.data?.health
  const failedAt = probe.data?.failedAt ?? 0
  const probing = probe.isFetching
  const warning = live?.warning
  const error = live?.status === 'error' ? live.error : null
  const compressionSince = compressingSince ?? live?.compressionStartedAt ?? null
  const list: Notice[] = []
  if (!online) list.push({ kind: 'offline', tone: 'warning', title: m.notice_offline_title(), detail: m.notice_offline_detail(), dismissible: true })
  if (failures > 0) list.push({ kind: 'server_unreachable', tone: 'warning', title: m.notice_server_title(), status: <RetryCountdown at={failedAt + retryDelay(failures)} busy={probing} />, action: { label: m.retry(), run: retry }, dismissible: false })
  if (failures === 0 && health?.chat?.available === false) list.push({ kind: 'agent_unavailable', tone: 'warning', title: chatConditionText(health.chat.condition, health.chat.agent_runtime_reason) ?? m.notice_agent_title(), dismissible: true })
  // Old-server fallback (TAL-951): a server without `chat` only reports gateway liveness. Delete once Stable ships `chat`.
  else if (failures === 0 && health && !health.chat && health.alive === false) list.push({ kind: 'agent_unavailable', tone: 'warning', title: m.notice_agent_title(), detail: health.details?.reason ?? health.error, dismissible: true })
  if (warning) list.push({ kind: 'provider_failure', tone: 'warning', title: warning === 'owner_replay_gap' ? m.owner_replay_gap() : warning, dismissible: true })
  if (error) {
    const runtimeTitle = chatConditionText(error.condition ?? error.type, error.agent_runtime_reason)
    list.push({ kind: 'thread_error', tone: 'error', title: runtimeTitle ?? m.live_error(), detail: runtimeTitle ? undefined : error.message, action: onRetry && error.retryable !== false ? { label: m.retry(), run: onRetry } : undefined, dismissible: true })
  }
  for (const n of agentNotices) list.push({ id: `runtime:agent_notice:${n.key}`, kind: 'agent_notice', tone: NOTICE_TONE[n.level], title: n.text, dismissible: true })
  if (compressionSince !== null) list.push({ kind: 'compressing', tone: 'info', title: m.live_compressing(), status: <RunElapsed since={compressionSince} />, dismissible: false, oneLine: true })
  if (goal) list.push(goalNotice(goal))
  const visible = list.filter((n) => !dismissed.has(`${n.kind}:${n.title}`)).sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))
  const first = visible[0]
  const notices: ComposerNotice[] = visible.map((n) => ({
    id: n.id ?? `runtime:${n.kind}`,
    tone: n.tone,
    content: (
      <>
        {n.kind === 'compressing' && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
        {/* One sentence that wraps (two lines at most) rather than a title and detail squeezed into columns. */}
        <span className={`min-w-0 leading-snug ${n.oneLine ? 'truncate' : 'line-clamp-2'}`} title={n.detail ? `${n.title} · ${n.detail}` : undefined}><span className="font-medium">{n.title}</span>{n.detail && <span className="opacity-80"> · {n.detail}</span>}</span>
        {n.status && <span className="ms-auto shrink-0 ps-2 opacity-80">{n.status}</span>}
      </>
    ),
    // A notice that may not fit its chip opens whole in a dialog.
    detail: n.oneLine && !n.detail ? undefined : { title: n.title, content: n.detail ? <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{n.detail}</p> : null },
    action: n.action,
    onDismiss: n.dismissible ? () => setDismissed((d) => new Set([...d, `${n.kind}:${n.title}`])) : undefined,
  }))
  return { notices, announcement: first ? { assertive: first.tone === 'error', text: first.tone === 'error' ? `${first.title} ${first.detail ?? ''}`.trim() : first.title } : null }
}
