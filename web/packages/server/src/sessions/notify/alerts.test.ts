import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentNotifyAlerts, alertForTransition, type AlertKind, type AlertPreferences } from './alerts.js'

// The relay applies the same vectors (relay/tests/notificationAlerts.test.ts), so the rule cannot drift.
interface Vector { name: string; previous: string | null; next: string; alertEligible: boolean; previousDecisionReviewId?: string | null; decisionReviewId?: string; preferences: AlertPreferences; expected: AlertKind | null }
interface NoticeVector { name: string; previousAgentNotifyIds: string[]; agentNotices: { id: string }[]; expected: string[] }
const { vectors, agentNotify } = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/fixtures/notification-alerts.json'), 'utf8')) as { vectors: Vector[]; agentNotify: NoticeVector[] }

it.each(vectors)('shared alert rule: $name', (vector) => {
  expect(alertForTransition(vector.previous, { phase: vector.next, alertEligible: vector.alertEligible, decisionReviewId: vector.decisionReviewId }, vector.preferences, vector.previousDecisionReviewId)).toBe(vector.expected)
})

// TAL-1970: the server stamps a row only with an unmuted notice, so neither presence nor preferences enter the rule.
it.each(agentNotify)('shared agent notice rule: $name', (vector) => {
  expect(agentNotifyAlerts(vector.previousAgentNotifyIds, vector.agentNotices).map((notice) => notice.id)).toEqual(vector.expected)
})
