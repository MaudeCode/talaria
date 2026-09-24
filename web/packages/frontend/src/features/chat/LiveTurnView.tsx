import { useLayoutEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import type { LiveTurn } from '../../stream/reducer'
import { rememberLiveTurnHeight, TurnActivityView } from './TurnActivityView'
import { liveActivity } from './turnActivity'
import type { ActivityMode } from './blocks/Worklog'

/** The in-flight assistant turn: reasoning, tools and prose projected from the reducer, in event order. */
export function LiveTurnView({ turn, name, mode, userVisible }: { turn: LiveTurn; name: string; mode: ActivityMode; userVisible: boolean }) {
  const activity = liveActivity(turn)
  const streaming = activity.status === 'running'
  const rowRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const statusTop = useRef<number | null>(null)
  useLayoutEffect(() => {
    const row = rowRef.current
    if (row) rememberLiveTurnHeight(activity.key, row.getBoundingClientRect().height)
    // In a transcript too short to scroll, the indicator moves down as content lands above it: glide it there.
    const status = statusRef.current
    const scroller = row?.closest('#messages')
    if (!status || !scroller) { statusTop.current = null; return }
    const top = status.getBoundingClientRect().top
    const from = statusTop.current
    statusTop.current = top
    if (from !== null && Math.abs(from - top) > 1 && scroller.scrollHeight <= scroller.clientHeight && !prefersReducedMotion()) {
      status.animate?.([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' })
    }
  })
  return (
    <div ref={rowRef} className="msg-row assistant-turn live-turn" data-role="assistant" data-live="1" data-stream-id={turn.streamId} data-status={turn.status} aria-busy={streaming}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span></div>
      <div className="assistant-turn-blocks">
        <TurnActivityView activity={activity} mode={mode} />
        {streaming && (
          <div ref={statusRef} className="live-run-status flex items-center gap-2 text-muted" role="status" aria-live="polite">
            <LaurelSpinner />
            <span className="live-run-label">{turn.status === 'reconnecting' ? m.live_reconnecting() : m.live_streaming()}</span>
          </div>
        )}
        {streaming && turn.tps !== null && <div className="mt-1 font-mono text-[11px] tabular-nums text-muted opacity-75" title="Tokens per second">{turn.tps.toFixed(1)} tok/s</div>}
        {turn.warning && <div className="mt-1 text-[12px] text-warning" role="status">{turn.warning}</div>}
        {turn.steerConsumed.map((s) => <div key={s.id} className="anchor-steering-message mt-1 text-[12px] text-muted">{m.live_steer_consumed({ text: s.text })}</div>)}
        {turn.compression && <div className="compression-card mt-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-muted" role="status">{turn.compression.state === 'compressing' ? m.live_compressing() : m.live_compressed()}{turn.compression.newSessionId && turn.compression.state === 'compressed' && <> <Link to="/session/$sessionId" params={{ sessionId: turn.compression.newSessionId }} className="text-accent-text underline">{m.live_continuation()}</Link></>}</div>}
        {turn.status === 'cancelled' && turn.cancelledMessage && <div className="status-card mt-2 text-[13px] text-muted">{turn.cancelledMessage}</div>}
        {turn.status === 'error' && turn.error && (
          <div className="status-card mt-2 rounded-md border border-error/40 bg-surface px-3 py-2 text-[13px]" role="alert">
            {turn.error.message && <div className="mt-0.5 break-words text-muted">{turn.error.message}</div>}
            {turn.error.hint && <div className="mt-0.5 text-muted">{turn.error.hint}</div>}
            {turn.error.continuationSessionId && <Link to="/session/$sessionId" params={{ sessionId: turn.error.continuationSessionId }} className="mt-1 inline-block text-accent-text underline">{m.live_continuation()}</Link>}
          </div>
        )}
        {!userVisible && turn.status === 'done' && <span className="sr-only" role="status">{m.done()}</span>}
      </div>
    </div>
  )
}

/** Laurel-wreath activity indicator: ten leaves brighten in turn around the ring (styles in chat.css). */
function LaurelSpinner() {
  return (
    <svg className="live-laurel" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <g key={i} transform={`rotate(${i * 36} 12 12)`}>
          <ellipse className="laurel-leaf" style={{ animationDelay: `${(i - 10) / 10}s` }} cx="12" cy="4" rx="1.3" ry="2.9" transform="rotate(35 12 4)" fill="currentColor" />
        </g>
      ))}
    </svg>
  )
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
