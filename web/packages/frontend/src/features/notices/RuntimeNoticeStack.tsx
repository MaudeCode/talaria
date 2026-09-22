import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { LiveTurn } from '../../stream/reducer'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'

type Kind = 'thread_error' | 'offline' | 'agent_unavailable' | 'provider_failure' | 'reconnect'
interface Notice { kind: Kind; tone: 'error' | 'warning' | 'info'; title: string; detail?: string | undefined; action?: { label: string; run: () => void } | undefined }
const PRIORITY: Kind[] = ['thread_error', 'offline', 'agent_unavailable', 'provider_failure', 'reconnect']

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
 * One prioritized stack for connection and runtime state (legacy HWEB-11):
 * thread error, offline, agent unavailable, provider failure, reconnect. The
 * first entry renders expanded; the rest compact. Announced through a polite
 * region and an assertive region so re-renders never re-announce.
 */
export function RuntimeNoticeStack({ live, onRetry }: { live: LiveTurn | null; onRetry?: (() => void) | undefined }) {
  const online = useOnline()
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, refetchInterval: 30_000, staleTime: 25_000, retry: false, enabled: online })
  const notices: Notice[] = []
  if (!online) notices.push({ kind: 'offline', tone: 'warning', title: m.notice_offline_title(), detail: m.notice_offline_detail() })
  if (agent.data?.alive === false) notices.push({ kind: 'agent_unavailable', tone: 'warning', title: m.notice_agent_title(), detail: agent.data.details?.reason ?? agent.data.error })
  if (live?.status === 'reconnecting') notices.push({ kind: 'reconnect', tone: 'info', title: m.notice_reconnect_title() })
  if (live?.warning) notices.push({ kind: 'provider_failure', tone: 'warning', title: live.warning })
  if (live?.status === 'error' && live.error) notices.push({ kind: 'thread_error', tone: 'error', title: m.live_error(), detail: live.error.message, action: onRetry ? { label: m.retry(), run: onRetry } : undefined })
  const visible = notices.filter((n) => !dismissed.has(`${n.kind}:${n.title}`)).sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind)).slice(0, 4)
  const first = visible[0]
  return (
    <>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{first?.tone === 'error' ? `${first.title} ${first.detail ?? ''}` : ''}</div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{first && first.tone !== 'error' ? first.title : ''}</div>
      {visible.length > 0 && (
        <div className="chat-runtime-notice mx-auto mt-2 flex w-full max-w-[var(--msg-max)] flex-col gap-1 px-5 max-[768px]:px-3" role="region" aria-label={m.runtime_notice_region()} id="chatRuntimeNotice">
          {visible.map((n, i) => (
            <div key={`${n.kind}:${n.title}`} className={cn('flex items-start gap-3 rounded-lg border px-3 py-2 text-sm', n.tone === 'error' && 'border-error/50', n.tone === 'warning' && 'border-warning/60', n.tone === 'info' && 'border-border', i > 0 && 'py-1 text-xs')} data-kind={n.kind}>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-text">{n.title}</div>
                {i === 0 && n.detail && <div className="mt-0.5 break-words text-xs text-muted">{n.detail}</div>}
              </div>
              {n.action && <Button onClick={n.action.run}>{n.action.label}</Button>}
              <button type="button" className="text-xs text-muted hover:text-text" onClick={() => setDismissed((d) => new Set([...d, `${n.kind}:${n.title}`]))}>{m.notice_dismiss()}</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
