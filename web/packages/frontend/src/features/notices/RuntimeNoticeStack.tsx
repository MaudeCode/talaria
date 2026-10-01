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
interface Notice { kind: Kind; tone: 'error' | 'warning' | 'info'; title: string; detail?: string | undefined; action?: { label: string; run: () => void } | undefined; dismissible: boolean }
const PRIORITY: Kind[] = ['thread_error', 'server_unreachable', 'offline', 'agent_unavailable', 'provider_failure', 'compressing']

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
  // cannot reach the Talaria server. It polls faster while failing so the entry clears soon after the server returns.
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, refetchInterval: (q) => (q.state.status === 'error' ? 3_000 : 10_000), staleTime: 2_000, retry: false, enabled: online })
  const unreachable = online && agent.isError && isApiError(agent.error) && (agent.error.kind === 'network' || agent.error.kind === 'timeout')
  const list: Notice[] = []
  if (!online) list.push({ kind: 'offline', tone: 'warning', title: m.notice_offline_title(), detail: m.notice_offline_detail(), dismissible: true })
  if (unreachable) list.push({ kind: 'server_unreachable', tone: 'warning', title: m.notice_server_title(), detail: m.notice_server_detail(), dismissible: false })
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
        <span className="font-medium">{n.title}</span>
        {n.detail && <span className="min-w-0 truncate opacity-80" title={n.detail}>{n.detail}</span>}
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
