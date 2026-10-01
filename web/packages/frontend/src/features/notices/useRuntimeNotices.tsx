import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts/common'
import type { LiveTurn } from '../../stream/reducer'
import type { ComposerNotice } from '../composer/ComposerTab'

type AgentHealth = Awaited<ReturnType<typeof api.fetchAgentHealth>>

type Kind = 'thread_error' | 'server_unreachable' | 'offline' | 'agent_unavailable' | 'provider_failure' | 'compressing'
interface Notice { kind: Kind; tone: 'error' | 'warning' | 'info'; title: string; detail?: string | undefined; /** A short state shown on the right, keeping the row to one line. */ status?: React.ReactNode; action?: { label: string; run: () => void } | undefined; dismissible: boolean }
const PRIORITY: Kind[] = ['thread_error', 'server_unreachable', 'offline', 'agent_unavailable', 'provider_failure', 'compressing']

/** Wait before the next probe of an unreachable server: 1 s after the first failure, doubling to a 30 s cap. */
export function retryDelay(failures: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1))
}

/**
 * One server probe: the agent health answer, or how many probes in a row got no HTTP answer at all and when the last
 * one failed. Carrying the count in the query data lets `refetchInterval` back off without extra component state.
 */
interface Probe { health: AgentHealth | null; failures: number; failedAt: number }
const PROBE_KEY = [...keys.health.agent, 'probe'] as const

/** "Retrying in 8s", counting down to the next probe; a spinner while a probe is in flight. */
function RetryCountdown({ at, busy }: { at: number; busy: boolean }) {
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
 * Connection and runtime state as composer top-tab entries (legacy HWEB-11, moved into the tab by TAL-429): thread
 * error, unreachable Talaria server, offline, agent unavailable, provider failure, manual compression. A live turn's
 * reconnect is the live row's own label.
 */
export function useRuntimeNotices({ live, onRetry, compressing }: { live: LiveTurn | null; onRetry?: (() => void) | undefined; compressing: boolean }): { notices: ComposerNotice[]; announcement: Announcement | null } {
  const online = useOnline()
  const qc = useQueryClient()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  // The agent health poll doubles as the server probe: a request that never got an HTTP answer means this browser
  // cannot reach the Talaria server. Those probes back off exponentially; an HTTP error keeps the healthy cadence.
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
  const failures = online ? (probe.data?.failures ?? 0) : 0
  const health = probe.data?.health
  const retry = () => { void probe.refetch() }
  const list: Notice[] = []
  if (!online) list.push({ kind: 'offline', tone: 'warning', title: m.notice_offline_title(), detail: m.notice_offline_detail(), dismissible: true })
  if (failures > 0) list.push({ kind: 'server_unreachable', tone: 'warning', title: m.notice_server_title(), status: <RetryCountdown at={(probe.data?.failedAt ?? 0) + retryDelay(failures)} busy={probe.isFetching} />, action: { label: m.retry(), run: retry }, dismissible: false })
  if (failures === 0 && health?.alive === false) list.push({ kind: 'agent_unavailable', tone: 'warning', title: m.notice_agent_title(), detail: health.details?.reason ?? health.error, dismissible: true })
  if (live?.warning) list.push({ kind: 'provider_failure', tone: 'warning', title: live.warning, dismissible: true })
  if (live?.status === 'error' && live.error) list.push({ kind: 'thread_error', tone: 'error', title: m.live_error(), detail: live.error.message, action: onRetry ? { label: m.retry(), run: onRetry } : undefined, dismissible: true })
  if (compressing) list.push({ kind: 'compressing', tone: 'info', title: m.live_compressing(), dismissible: false })
  const visible = list.filter((n) => !dismissed.has(`${n.kind}:${n.title}`)).sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind))
  const first = visible[0]
  const notices: ComposerNotice[] = visible.map((n) => ({
    id: `runtime:${n.kind}`,
    tone: n.tone,
    content: (
      <>
        {n.kind === 'compressing' && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
        {/* One sentence that wraps (two lines at most) rather than a title and detail squeezed into columns. */}
        <span className="min-w-0 line-clamp-2 leading-snug" title={n.detail ? `${n.title} · ${n.detail}` : undefined}><span className="font-medium">{n.title}</span>{n.detail && <span className="opacity-80"> · {n.detail}</span>}</span>
        {n.status && <span className="ms-auto shrink-0 ps-2 opacity-80">{n.status}</span>}
      </>
    ),
    action: n.action,
    onDismiss: n.dismissible ? () => setDismissed((d) => new Set([...d, `${n.kind}:${n.title}`])) : undefined,
  }))
  return { notices, announcement: first ? { assertive: first.tone === 'error', text: first.tone === 'error' ? `${first.title} ${first.detail ?? ''}`.trim() : first.title } : null }
}
