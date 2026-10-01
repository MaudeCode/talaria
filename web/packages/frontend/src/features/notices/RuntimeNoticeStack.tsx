import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts/common'
import type { LiveTurn } from '../../stream/reducer'
import type { ComposerNotice } from '../composer/ComposerTab'

type Kind = 'thread_error' | 'server_unreachable' | 'offline' | 'agent_unavailable' | 'provider_failure' | 'compressing'
interface Notice { kind: Kind; tone: 'error' | 'warning' | 'info'; title: string; detail?: string | undefined; /** A short state shown on the right, keeping the row to one line. */ status?: React.ReactNode; action?: { label: string; run: () => void } | undefined; dismissible: boolean }
const PRIORITY: Kind[] = ['thread_error', 'server_unreachable', 'offline', 'agent_unavailable', 'provider_failure', 'compressing']

/** Wait before the next probe of an unreachable server: 1 s after the first failure, doubling to a 30 s cap. */
export function retryDelay(failures: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1))
}

/** "Retrying in 8s", counting down to the next probe; a spinner while a probe is in flight. */
function RetryCountdown({ at, busy }: { at: number | null; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (busy || at === null) return
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(tick)
  }, [at, busy])
  if (busy || at === null) return <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{m.notice_server_detail()}</span>
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

/**
 * Connection and runtime state as composer top-tab entries (legacy HWEB-11, moved into the tab by TAL-429): thread
 * error, unreachable Talaria server, offline, agent unavailable, provider failure, manual compression. A live turn's
 * reconnect is the live row's own label. The first entry is announced through a polite or assertive region.
 */
export function useRuntimeNotices({ live, onRetry, compressing }: { live: LiveTurn | null; onRetry?: (() => void) | undefined; compressing: boolean }): { notices: ComposerNotice[]; announcer: React.ReactNode } {
  const online = useOnline()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  // The agent health poll doubles as the server probe: a request that never got an HTTP answer means this browser
  // cannot reach the Talaria server. While it cannot, probes back off exponentially (retryDelay) instead of polling.
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, refetchInterval: (q) => (q.state.status === 'error' ? false : 10_000), staleTime: 2_000, retry: false, enabled: online })
  const unreachable = online && agent.isError && isApiError(agent.error) && (agent.error.kind === 'network' || agent.error.kind === 'timeout')
  const { refetch, isFetching, errorUpdatedAt } = agent
  const [backoff, setBackoff] = useState({ failures: 0, seenError: 0 })
  // Count consecutive failed probes; a success (or going offline) resets the backoff.
  if (unreachable && backoff.seenError !== errorUpdatedAt) setBackoff({ failures: backoff.failures + 1, seenError: errorUpdatedAt })
  if (!unreachable && backoff.failures !== 0) setBackoff({ failures: 0, seenError: 0 })
  const nextAt = unreachable && backoff.failures > 0 ? errorUpdatedAt + retryDelay(backoff.failures) : null
  useEffect(() => {
    if (nextAt === null || isFetching) return
    const timer = setTimeout(() => { void refetch() }, Math.max(0, nextAt - Date.now()))
    return () => clearTimeout(timer)
  }, [nextAt, isFetching, refetch])
  const list: Notice[] = []
  if (!online) list.push({ kind: 'offline', tone: 'warning', title: m.notice_offline_title(), detail: m.notice_offline_detail(), dismissible: true })
  if (unreachable) list.push({ kind: 'server_unreachable', tone: 'warning', title: m.notice_server_title(), status: <RetryCountdown at={nextAt} busy={isFetching} />, action: { label: m.retry(), run: () => { void refetch() } }, dismissible: false })
  if (!unreachable && agent.data?.alive === false) list.push({ kind: 'agent_unavailable', tone: 'warning', title: m.notice_agent_title(), detail: agent.data.details?.reason ?? agent.data.error, dismissible: true })
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
  const announcer = (
    <>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{first?.tone === 'error' ? `${first.title} ${first.detail ?? ''}` : ''}</div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" aria-label={m.runtime_notice_region()}>{first && first.tone !== 'error' ? first.title : ''}</div>
    </>
  )
  return { notices, announcer }
}
