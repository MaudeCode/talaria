import { useLayoutEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { ArrowUp, Pencil, X } from 'lucide-react'
import type { LiveTurn, PendingSteerRow } from '../../stream/reducer'
import { sendSteerNow, withdrawSteer } from '../../api/endpoints'
import { showToast } from '../toast/toast'
import { returnToComposer } from '../composer/composerReturn'
import { rememberLiveTurnHeight, SteerMessage, TurnActivityView } from './TurnActivityView'
import { liveActivity } from './turnActivity'
import type { ActivityMode } from './blocks/Worklog'

/** The in-flight assistant turn: reasoning, tools and prose projected from the reducer, in event order. */
export function LiveTurnView({ turn, name, mode, userVisible }: { turn: LiveTurn; name: string; mode: ActivityMode; userVisible: boolean }) {
  const activity = liveActivity(turn)
  const streaming = activity.status === 'running'
  const rowRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (rowRef.current) rememberLiveTurnHeight(activity.key, rowRef.current.getBoundingClientRect().height)
  })
  return (
    <div ref={rowRef} className="msg-row assistant-turn live-turn" data-role="assistant" data-live="1" data-stream-id={turn.streamId} data-status={turn.status} aria-busy={streaming}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span></div>
      <div className="assistant-turn-blocks">
        <TurnActivityView activity={activity} mode={mode} />
        {turn.pendingSteers.map((steer) => <PendingSteerMessage key={steer.steerId} sessionId={turn.sessionId} steer={steer} />)}
        {turn.warning && <div className="mt-1 text-[12px] text-warning" role="status">{turn.warning}</div>}
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

/**
 * TAL-425: a pending steer as the server reports it, with the actions it allows (T3 Code's queued-message row). Edit
 * takes it back into the composer, Cancel drops it, Send now delivers it at once. The buttons keep the composer's focus.
 */
function PendingSteerMessage({ sessionId, steer }: { sessionId: string; steer: PendingSteerRow }) {
  const keepFocus = (e: PointerEvent) => { e.preventDefault() }
  const withdraw = async (reason: 'edit' | 'cancel') => {
    const r = await withdrawSteer({ session_id: sessionId, steer_id: steer.steerId, reason }).catch(() => ({ withdrawn: false, text: undefined }))
    if (!r.withdrawn) { showToast(m.steer_already_taken(), 2500); return }
    if (reason === 'edit' && r.text !== undefined) returnToComposer(sessionId, r.text)
  }
  const sendNow = async () => {
    const r = await sendSteerNow({ session_id: sessionId, steer_id: steer.steerId }).catch(() => ({ redirected: false }))
    if (!r.redirected) showToast(m.steer_stays_pending(), 2500)
  }
  const button = (label: string, icon: ReactNode, onClick: () => Promise<void>) => (
    <button type="button" className="steer-action" aria-label={label} title={label} onPointerDown={keepFocus} onClick={() => { void onClick() }}>{icon}</button>
  )
  const { edit, cancel, send_now: sendNowAllowed } = steer.actions
  const actions = edit || cancel || sendNowAllowed ? (
    <span className="steer-actions">
      {sendNowAllowed && button(m.steer_send_now(), <ArrowUp size={13} aria-hidden="true" />, sendNow)}
      {edit && button(m.steer_edit(), <Pencil size={13} aria-hidden="true" />, () => withdraw('edit'))}
      {cancel && button(m.steer_cancel(), <X size={13} aria-hidden="true" />, () => withdraw('cancel'))}
    </span>
  ) : null
  return <SteerMessage text={steer.text} state={steer.state} actions={actions} />
}

/** The live turn's status, docked as a centered pill above the composer so it never takes transcript space. */
/** `background`: the server says a background result started this turn (`active_turn_origin`, TAL-460). */
export function LiveStatusPill({ turn, background = false }: { turn: LiveTurn; background?: boolean }) {
  return (
    <div className="live-run-status flex items-center gap-2 text-muted" role="status" aria-live="polite">
      <LaurelSpinner />
      <span className="live-run-label">{turn.status === 'reconnecting' ? m.live_reconnecting() : background ? m.live_background() : m.live_streaming()}</span>
      {turn.tps != null && <span className="font-mono text-[11px] tabular-nums opacity-75" title="Tokens per second">{turn.tps.toFixed(1)} tok/s</span>}
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
