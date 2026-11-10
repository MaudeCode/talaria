/**
 * The alert rule every notification channel applies, ported from the relay's `alertForTransition`
 * (relay/convex/lib/aggregate.ts). `contracts/fixtures/notification-alerts.json` pins both copies.
 */
import type { WebAudioCompletion, WebPushPreferences } from '@maudecode/talaria-web-contracts'
import { redactString } from '../../redact.js'
import { markdownPlainText } from '../../text/markdown.js'
import { bodyExcerpt, finalAnswerOf, isConversationalAssistant } from '../merge.js'

export type AlertKind = 'approval' | 'input' | 'completion' | 'failure' | 'decision'

export type AlertPreferences = WebPushPreferences

/** What an alert of each kind says when nothing more specific applies. */
export const ALERT_BODY: Record<AlertKind, string> = { approval: 'Approval needed', input: 'Input needed', completion: 'Completed', failure: 'Failed', decision: 'Decision review ready' }

export type CompletionNotification = NonNullable<WebAudioCompletion['notification']>
const COMPLETION_BODY_MAX = 140

/**
 * TAL-2157: a finished reply's notification, for its Web Push and the open tab's browser notification alike: the chat's
 * title, then the start of the turn's final answer as redacted plain text. A turn that ended without an answer says so.
 */
export function completionNotification(sessionId: string, session: { title?: unknown; messages?: unknown } | null, redact: boolean): CompletionNotification {
  const title = typeof session?.title === 'string' && session.title.trim() ? redactString(session.title, redact).slice(0, 120) : 'Untitled'
  const last = Array.isArray(session?.messages) ? session.messages.findLast(isConversationalAssistant) : undefined
  const text = markdownPlainText(redactString(last ? finalAnswerOf(last) : '', redact))
  const body = text.length > COMPLETION_BODY_MAX ? `${bodyExcerpt(text, COMPLETION_BODY_MAX - 1)}…` : text
  return { title, body: body || ALERT_BODY.completion, url: `/session/${encodeURIComponent(sessionId)}`, tag: sessionId }
}

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true }

const KIND_BY_PHASE: Record<string, { kind: AlertKind; pref: keyof AlertPreferences } | undefined> = {
  waiting_for_approval: { kind: 'approval', pref: 'notify_on_approval' },
  waiting_for_input: { kind: 'input', pref: 'notify_on_input' },
  completed: { kind: 'completion', pref: 'notify_on_completion' },
  failed: { kind: 'failure', pref: 'notify_on_failure' },
}

/**
 * No alert on a first publication or an ineligible state (a Talaria tab is open). TAL-1966: a decision review the row
 * did not hold before alerts once under the input preference, whatever the phase did; otherwise an unchanged phase
 * never alerts.
 */
export function alertForTransition(previous: string | null, next: { phase: string; alertEligible: boolean; decisionReviewId?: string | undefined }, preferences: AlertPreferences, previousDecisionReviewId?: string | null): AlertKind | null {
  if (!previous || !next.alertEligible) return null
  if (next.decisionReviewId && next.decisionReviewId !== previousDecisionReviewId && preferences.notify_on_input) return 'decision'
  if (previous === next.phase) return null
  const entry = KIND_BY_PHASE[next.phase]
  return entry && preferences[entry.pref] ? entry.kind : null
}

/**
 * TAL-1970: each agent notice the row did not carry before alerts once, in order, whatever the phase, the presence mute
 * or the run preferences did: the server muted an `info` notice before it reached the row, and the agent asked for it.
 */
export function agentNotifyAlerts<T extends { id: string }>(previousIds: readonly string[] | null | undefined, next: readonly T[] | undefined): T[] {
  return (next ?? []).filter((notice) => !previousIds?.includes(notice.id))
}
