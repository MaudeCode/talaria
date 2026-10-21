import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { Dialog } from '../../ui/Dialog'
import { prefersReducedMotion } from '../../lib/motion'

/**
 * One floating status chip above the composer (TAL-1078, after the App's StatusChip). A feature adds an entry; the
 * renderer draws, tints and animates it, so new status needs no Composer change.
 */
export interface ComposerNotice {
  id: string
  tone?: 'neutral' | 'info' | 'warning' | 'error' | undefined
  /** The chip's compact label. */
  content: ReactNode
  /** Rich or long content behind the chip: the label becomes a button that opens it in a dialog. */
  detail?: { title: string; content: ReactNode } | undefined
  /** Read out as it changes, so progress behind a closed detail still reaches screen readers. */
  announcement?: string | undefined
  action?: { label: string; run: () => void } | undefined
  onDismiss?: (() => void) | undefined
}

const LEAVE_MS = 220

/**
 * TAL-1300, after the App's StatusChipGroup: two or more chips that fit on one row share one pill (`is-grouped`);
 * otherwise each stacks as its own capsule (`is-stacked`). Measured like the composer footer's fit, outside React.
 */
function useChipFit(row: RefObject<HTMLDivElement | null>, shown: boolean) {
  useLayoutEffect(() => {
    const el = row.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const fit = () => {
      // Unclassed, the chips sit unshrunk in one row, so an overflow means they do not fit.
      el.classList.remove('is-grouped', 'is-stacked')
      const grouped = el.children.length > 1 && el.scrollWidth <= el.clientWidth + 0.5
      el.classList.add(grouped ? 'is-grouped' : 'is-stacked')
    }
    fit()
    const mo = new MutationObserver(fit)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    if (typeof ResizeObserver === 'undefined') return () => mo.disconnect()
    // Deferred a frame: refitting changes the row's height, which the observed parent would report back in-loop.
    let frame = 0
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit) })
    ro.observe(parent)
    return () => { mo.disconnect(); ro.disconnect(); cancelAnimationFrame(frame) }
  }, [row, shown])
}

/**
 * The chips over the composer card: each one fades in and out on its own. Mount one per chat (keyed by session) so a
 * switch closes the old chat's disclosure and shows none of its chips leaving.
 */
export function ComposerNotices({ notices, fallbackFocus }: { notices: ComposerNotice[]; fallbackFocus: RefObject<HTMLElement | null> }) {
  // An entry that leaves stays for its exit fade at its old place.
  const [leaving, setLeaving] = useState<{ notice: ComposerNotice; index: number }[]>([])
  // The entries are rebuilt on every composer render; only a change in which ids are present can start an exit.
  const latest = useRef(notices)
  const lastRender = useRef(notices)
  useEffect(() => { lastRender.current = latest.current; latest.current = notices })
  const idKey = notices.map((n) => n.id).join('\n')
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const current = latest.current
    const ids = new Set(current.map((n) => n.id))
    // The previous render's entries: a leaving one keeps the content it last rendered with (the live chip's final rate).
    const gone = prefersReducedMotion() ? [] : lastRender.current.flatMap((notice, index) => (ids.has(notice.id) ? [] : [{ notice, index }]))
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
  }, [idKey])
  useEffect(() => { const pending = timers.current; return () => { for (const t of pending) clearTimeout(t) } }, [])

  // The open disclosure shows its notice's current detail; it closes when the notice or its detail goes away.
  const [openId, setOpenId] = useState<string | null>(null)
  const open = notices.find((n) => n.id === openId && n.detail)
  // Forgotten at once, so a notice that later returns under the same id does not reopen by itself.
  if (openId !== null && !open) setOpenId(null)
  const trigger = useRef<HTMLElement | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  const rows = notices.map((notice) => ({ notice, out: false }))
  // A notice back before its exit ends shows once, as itself: the exit list catches up in the effect above.
  const present = new Set(notices.map((n) => n.id))
  for (const { notice, index } of leaving) if (!present.has(notice.id)) rows.splice(Math.min(index, rows.length), 0, { notice, out: true })
  useChipFit(rowRef, rows.length > 0)
  return (
    <>
      {rows.length > 0 && (
        <div className="composer-notices" ref={rowRef}>
          {rows.map(({ notice: n, out }) => (
            <div key={n.id} className={cn('composer-notice', out && 'is-leaving')} data-notice={n.id} data-tone={n.tone ?? 'neutral'} inert={out}>
              {n.detail
                ? <button type="button" className="composer-notice-content composer-notice-open" aria-haspopup="dialog" aria-expanded={openId === n.id} onClick={(e) => { trigger.current = e.currentTarget; setOpenId(n.id) }}>{n.content}</button>
                : <div className="composer-notice-content">{n.content}</div>}
              {n.action && <button type="button" className="composer-notice-action" onClick={n.action.run}>{n.action.label}</button>}
              {n.onDismiss && <button type="button" className="composer-notice-action" onClick={n.onDismiss}>{m.notice_dismiss()}</button>}
              {n.announcement !== undefined && <span className="sr-only" role="status">{n.announcement}</span>}
            </div>
          ))}
        </div>
      )}
      {/* Focus returns to the chip that opened it, or to the composer once that chip is gone. */}
      <Dialog
        open={!!open} onOpenChange={(o) => { if (!o) setOpenId(null) }} title={open?.detail?.title ?? ''}
        className="composer-notice-dialog max-h-[85dvh] overflow-y-auto"
        finalFocus={() => (trigger.current?.isConnected ? trigger.current : fallbackFocus.current)}
      >
        {open?.detail?.content}
      </Dialog>
    </>
  )
}
