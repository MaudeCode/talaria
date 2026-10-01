import { useEffect, useRef, useState, type ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'

/**
 * One row of the composer's top tab (TAL-429, after T3 Code's ComposerBanner). A feature adds an entry; the tab
 * renders, tints, and animates it, so new status needs no Composer change.
 */
export interface ComposerNotice {
  id: string
  tone?: 'neutral' | 'info' | 'warning' | 'error' | undefined
  content: ReactNode
  action?: { label: string; run: () => void } | undefined
  onDismiss?: (() => void) | undefined
  /** Click target for the whole row (the YOLO warning turns YOLO off). */
  onClick?: (() => void) | undefined
  title?: string | undefined
  role?: 'status' | 'region' | undefined
  label?: string | undefined
}

const LEAVE_MS = 220
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The tab on the card's top edge: entries slide up from behind the card and back down when they end. */
export function ComposerTab({ notices }: { notices: ComposerNotice[] }) {
  // An entry that leaves stays for its exit slide at its old place; the tab leaves with its last entry.
  const [leaving, setLeaving] = useState<{ notice: ComposerNotice; index: number }[]>([])
  const previous = useRef(notices)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const ids = new Set(notices.map((n) => n.id))
    const gone = reducedMotion() ? [] : previous.current.flatMap((notice, index) => (ids.has(notice.id) ? [] : [{ notice, index }]))
    previous.current = notices
    setLeaving((l) => {
      const kept = l.filter((x) => !ids.has(x.notice.id))
      return gone.length || kept.length !== l.length ? [...kept, ...gone] : l
    })
    if (!gone.length) return
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setLeaving((l) => l.filter((x) => !gone.some((g) => g.notice.id === x.notice.id)))
    }, LEAVE_MS)
    timers.current.add(timer)
  }, [notices])
  useEffect(() => { const pending = timers.current; return () => { for (const t of pending) clearTimeout(t) } }, [])

  const rows = notices.map((notice) => ({ notice, out: false }))
  for (const { notice, index } of leaving) rows.splice(Math.min(index, rows.length), 0, { notice, out: true })
  if (rows.length === 0) return null
  return (
    <div className={cn('composer-tab', notices.length === 0 && 'is-leaving')}>
      {rows.map(({ notice: n, out }) => {
        const Row = n.onClick ? 'button' : 'div'
        return (
          <div key={n.id} className={cn('composer-tab-item', out && 'is-leaving')} data-notice={n.id}>
            <div className="composer-tab-row" data-tone={n.tone ?? 'neutral'}>
              <Row {...(n.onClick ? { type: 'button' as const, onClick: n.onClick } : {})} className="composer-tab-content" title={n.title} role={n.role} aria-label={n.label}>{n.content}</Row>
              {n.action && <button type="button" className="composer-tab-action" onClick={n.action.run}>{n.action.label}</button>}
              {n.onDismiss && <button type="button" className="composer-tab-action" onClick={n.onDismiss}>{m.notice_dismiss()}</button>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
