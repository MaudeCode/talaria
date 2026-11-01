/**
 * The alert rule every notification channel applies, ported from the relay's `alertForTransition`
 * (relay/convex/lib/aggregate.ts). `contracts/fixtures/notification-alerts.json` pins both copies.
 */
import type { WebPushPreferences } from '@maudecode/talaria-web-contracts'

export type AlertKind = 'approval' | 'input' | 'completion' | 'failure'

export type AlertPreferences = WebPushPreferences

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true }

const KIND_BY_PHASE: Record<string, { kind: AlertKind; pref: keyof AlertPreferences } | undefined> = {
  waiting_for_approval: { kind: 'approval', pref: 'notify_on_approval' },
  waiting_for_input: { kind: 'input', pref: 'notify_on_input' },
  completed: { kind: 'completion', pref: 'notify_on_completion' },
  failed: { kind: 'failure', pref: 'notify_on_failure' },
}

/** No alert on a first publication, an unchanged phase, or an ineligible state (a Talaria tab is open). */
export function alertForTransition(previous: string | null, next: { phase: string; alertEligible: boolean }, preferences: AlertPreferences): AlertKind | null {
  if (!previous || previous === next.phase || !next.alertEligible) return null
  const entry = KIND_BY_PHASE[next.phase]
  return entry && preferences[entry.pref] ? entry.kind : null
}
