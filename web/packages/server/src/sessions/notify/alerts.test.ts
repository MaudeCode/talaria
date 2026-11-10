import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentNotifyAlerts, alertForTransition, completionNotification, type AlertKind, type AlertPreferences } from './alerts.js'

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

// TAL-2157: one composer for the completion's Web Push and the open tab's browser notification.
it('composes a completion notification from the final answer: plain text, redacted, at most 140 characters', () => {
  const answer = `## Done\n\n**Deployed** the [release](https://example.com/r) with token ghp_abcdefghij0123456789. ${'More detail. '.repeat(20)}`
  const messages = [{ role: 'user', content: 'ship it' }, { role: 'assistant', content: answer }]
  const shown = completionNotification('s 1', { title: 'Release', messages }, true)
  expect(shown.title).toBe('Release')
  expect(shown.url).toBe('/session/s%201')
  expect(shown.body.startsWith('Done Deployed the release with token ghp_ab...6789. More detail.')).toBe(true)
  expect(shown.body.length).toBeLessThanOrEqual(140)
  expect(shown.body.endsWith('…')).toBe(true)
  // A turn that ended without an answer says it completed; it never reuses an older turn's answer.
  expect(completionNotification('s', { title: '', messages: [...messages, { role: 'assistant', content: '', tool_calls: [{ id: 't' }] }] }, true)).toEqual({ title: 'Untitled', body: 'Completed', url: '/session/s', tag: 's' })
})
