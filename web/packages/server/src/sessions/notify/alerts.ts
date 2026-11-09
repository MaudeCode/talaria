/**
 * The alert rule every notification channel applies, ported from the relay's `alertForTransition`
 * (relay/convex/lib/aggregate.ts). `contracts/fixtures/notification-alerts.json` pins both copies.
 */
import type { WebPushPreferences } from '@maudecode/talaria-web-contracts'

export type AlertKind = 'approval' | 'input' | 'completion' | 'failure' | 'decision'

export type AlertPreferences = WebPushPreferences

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
