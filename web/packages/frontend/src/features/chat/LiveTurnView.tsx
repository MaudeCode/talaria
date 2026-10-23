import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import { formatDurationUnits, resetTime } from '../../i18n/units'
import { ArrowUp, Pencil, X } from 'lucide-react'
import type { LiveTurn, PendingSteerRow } from '../../stream/reducer'
import { useLiveTurn } from '../../stream/store'
import { fetchSession, sendSteerNow, withdrawSteer } from '../../api/endpoints'
import { dispatch } from '../../stream/store'
import { usePromptAnswer } from './usePromptAnswer'
import type { RateLimitWait, SteerWithdrawRequest } from '@maudecode/talaria-web-contracts'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { returnToComposer } from '../composer/composerReturn'
import { rememberLiveTurnHeight, SteerMessage, TurnActivityView } from './TurnActivityView'
import { liveActivity } from './turnActivity'
import type { ActivityMode } from './blocks/Worklog'

/** The in-flight assistant turn: reasoning, tools and prose projected from the reducer, in event order. */
/** `omitToolIds`: tools the running scene this turn continues already shows (TAL-374). */
export function LiveTurnView({ turn, name, mode, userVisible, omitToolIds }: { turn: LiveTurn; name: string; mode: ActivityMode; userVisible: boolean; omitToolIds?: ReadonlySet<string> | undefined }) {
  const { segments, tools, status, terminalState, turnId, streamId } = turn
  const activity = useMemo(() => liveActivity({ segments, tools, status, terminalState, turnId, streamId }, omitToolIds), [segments, tools, status, terminalState, turnId, streamId, omitToolIds])
  const streaming = activity.status === 'running'
  const rowRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (rowRef.current) rememberLiveTurnHeight(activity.key, rowRef.current.getBoundingClientRect().height)
  }, [activity.key, turn.segments.length, turn.status])
  return (
    <div ref={rowRef} className="msg-row assistant-turn live-turn" data-role="assistant" data-live="1" data-stream-id={turn.streamId} data-status={turn.status} aria-busy={streaming}>
      <div className="msg-role assistant"><span className="msg-role-name">{name}</span></div>
      <div className="assistant-turn-blocks">
        <TurnActivityView activity={activity} mode={mode} />
        {turn.pendingSteers.map((steer) => <PendingSteerMessage key={steer.steerId} sessionId={turn.sessionId} steer={steer} />)}
        {turn.warning && <div className="mt-1 text-[12px] text-warning" role="status">{turn.warning}</div>}
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
  // Send now is executed by the server: its button is busy, and Edit and Cancel wait rather than race it.
  const [busy, setBusy] = useState(false)
  const keepFocus = (e: PointerEvent) => { e.preventDefault() }
  const run = async (request: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await request() } catch (e) { showErrorToast(e) } finally { setBusy(false) }
  }
  // Edit and Cancel take the row away at once; a refusal brings it back. Edit's text returns only from a confirmed withdrawal:
  // a steer that left during an unknown outcome may have been delivered, and returning it would invite sending it twice.
  const resource = `steer:${sessionId}:${steer.steerId}`
  const { answer: withdrawNow, answered } = usePromptAnswer({
    resource: () => resource, queryKey: ['steer', sessionId],
    send: (reason: SteerWithdrawRequest['reason']) => withdrawSteer({ session_id: sessionId, steer_id: steer.steerId, reason }),
    waiting: async () => (await fetchSession(sessionId, { messages: false })).session.pending_steers?.some((p) => p.steer_id === steer.steerId) ?? false,
    onAnswered: (r, reason) => {
      dispatch({ type: 'steer_closed', sessionId, steerId: steer.steerId })
      // Already taken: the steer is being delivered, so the row stays gone and says why.
      if (r && !r.withdrawn) { showToast(m.steer_already_taken(), 2500); return }
      if (reason === 'edit' && r) returnToComposer(sessionId, r.text ?? steer.text)
    },
  })
  const withdraw = (reason: SteerWithdrawRequest['reason']) => { if (!busy) withdrawNow(reason); return Promise.resolve() }
  const sendNow = () => run(async () => {
    const reply = await sendSteerNow({ session_id: sessionId, steer_id: steer.steerId })
    // Older servers only send redirected; remove this fallback with that field.
    switch (Object.hasOwn(reply, 'outcome') ? reply.outcome : (reply.redirected ? 'delivered' : 'not_running')) {
      case 'delivered': break
      case 'next_step': showToast(m.steer_next_step(), 2500); break
      case 'not_running': showToast(m.steer_stays_pending(), 2500); break
      case 'taken': showToast(m.steer_no_longer_changeable(), 2500); break
      case 'failed':
      default: showToast(m.steer_send_now_failed(), 2500); break
    }
  })
  const button = (label: string, icon: ReactNode, onClick: () => Promise<void>, waits = false) => (
    <button type="button" className="steer-action" aria-label={label} title={label} disabled={busy} aria-busy={waits && busy || undefined} onPointerDown={keepFocus} onClick={() => { void onClick() }}>{icon}</button>
  )
  const { edit, cancel, send_now: sendNowAllowed } = steer.actions
  const actions = edit || cancel || sendNowAllowed ? (
    <span className="steer-actions">
      {sendNowAllowed && button(m.steer_send_now(), <ArrowUp size={14} aria-hidden="true" />, sendNow, true)}
      {edit && button(m.steer_edit(), <Pencil size={14} aria-hidden="true" />, () => withdraw('edit'))}
      {cancel && button(m.steer_cancel(), <X size={14} aria-hidden="true" />, () => withdraw('cancel'))}
    </span>
  ) : null
  if (answered(resource)) return null
  return <SteerMessage text={steer.text} state={steer.state} actions={actions} />
}

/**
 * The live turn's status, docked as a centered pill above the composer so it never takes transcript space.
 * `background`: the server says a background result started this turn (`active_turn_origin`, TAL-460).
 * TAL-821: while the Agent sits out a rate limit, the server's provider and reset time replace "Working"; the composer's
 * Stop stays the way out.
 */
export function LiveStatusPill({ sessionId, background = false }: { sessionId: string | null; background?: boolean }) {
  const turn = useLiveTurn(sessionId)
  const locale = useLocale()
  if (!turn) return null
  const reconnecting = turn.status === 'reconnecting'
  const status = reconnecting ? null : turn.runStatus
  // Old servers omit run_status; retain their rate-limit presentation until that contract is retired.
  const wait = status?.phase === 'rate_limit_wait' ? status.wait : !status && !reconnecting ? turn.rateLimitWait : null
  let label = reconnecting ? m.live_reconnecting() : wait ? rateLimitLabel(wait, locale) : background ? m.live_background() : m.live_working()
  if (status?.phase === 'compressing') label = m.live_compressing()
  if (status?.phase === 'prompt_reading') {
    label = status.progress_percent === null ? m.live_prompt_reading() : m.live_prompt_reading_percent({ percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(status.progress_percent / 100) })
  }
  return (
    <div className="live-run-status flex items-center gap-2 text-muted" role="status" aria-live="polite">
      <LaurelSpinner />
      <span className="live-run-label">{label}</span>
      {!reconnecting && !background && !wait && (!status || status.phase === 'working') && <>{' '}<RunElapsed since={turn.startedAt} /></>}
      {turn.tps != null && <span className="font-mono text-[11px] tabular-nums opacity-75" title="Tokens per second">{turn.tps.toFixed(1)} tok/s</span>}
    </div>
  )
}

function rateLimitLabel(wait: RateLimitWait, locale: string): string {
  const time = resetTime(locale, wait.until * 1000)
  const provider = wait.provider_label
  if (wait.until_kind === 'reset') return provider ? m.live_rate_limited_by({ provider, time }) : m.live_rate_limited({ time })
  return provider ? m.live_rate_limited_by_retry({ provider, time }) : m.live_rate_limited_retry({ time })
}

/** Time since the run started in T3 Code's units (TAL-922): `42s`, then `5m`, then `1h 30m`. Redrawn each second and
 *  hidden from the live region so it is not announced every tick. */
export function RunElapsed({ since }: { since: number }) {
  const locale = useLocale()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const minutes = Math.floor(seconds / 60)
  const text =
    seconds < 60
      ? formatDurationUnits(locale, [seconds, 'second'])
      : minutes < 60
        ? formatDurationUnits(locale, [minutes, 'minute'])
        : formatDurationUnits(locale, [Math.floor(minutes / 60), 'hour'], [minutes % 60, 'minute'])
  return <span className="live-run-elapsed" aria-hidden="true">{text}</span>
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
