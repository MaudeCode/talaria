import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentNotifyAlerts, alertBody, alertForTransition, completionNotification, serverNoticeAllowed, type AlertKind, type AlertPreferences } from './alerts.js'

// The relay applies the same vectors (relay/tests/notificationAlerts.test.ts), so the rule cannot drift.
interface Vector { name: string; previous: string | null; next: string; alertEligible: boolean; previousApprovalHeadId?: string; approvalHeadId?: string; previousInputHeadId?: string; inputHeadId?: string; previousDecisionReviewId?: string | null; decisionReviewId?: string; preferences: AlertPreferences; expected: AlertKind | null }
interface NoticeVector { name: string; previousAgentNotifyIds: string[]; agentNotices: { id: string }[]; expected: string[] }
interface ServerNoticeVector { name: string; owner: boolean; preferences: Partial<AlertPreferences>; expected: boolean }
const { vectors, agentNotify, serverNotice } = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/fixtures/notification-alerts.json'), 'utf8')) as { vectors: Vector[]; agentNotify: NoticeVector[]; serverNotice: ServerNoticeVector[] }

it.each(vectors)('shared alert rule: $name', (vector) => {
  expect(alertForTransition(vector.previous, {
    phase: vector.next, alertEligible: vector.alertEligible, approvalHeadId: vector.approvalHeadId, inputHeadId: vector.inputHeadId, decisionReviewId: vector.decisionReviewId,
  }, vector.preferences, vector.previousDecisionReviewId, vector.previousApprovalHeadId, vector.previousInputHeadId)).toBe(vector.expected)
})

// TAL-1970: the server stamps a row only with an unmuted notice, so neither presence nor preferences enter the rule.
it.each(agentNotify)('shared agent notice rule: $name', (vector) => {
  expect(agentNotifyAlerts(vector.previousAgentNotifyIds, vector.agentNotices).map((notice) => notice.id)).toEqual(vector.expected)
})

// TAL-2665: an update-available notice reaches only a server owner's subscription that opted in.
it.each(serverNotice)('shared server notice rule: $name', (vector) => {
  expect(serverNoticeAllowed(vector.preferences, vector.owner)).toBe(vector.expected)
})

// TAL-2157: one composer for the completion's Web Push and the open tab's browser notification.
it('composes a completion notification from the final answer: plain text, redacted, at most 140 characters', () => {
  const answer = `## Done\n\n**Deployed** the [release](https://example.com/r) with token ghp_abcdefghij0123456789. ${'More detail. '.repeat(20)}`
  const messages = [{ role: 'user', content: 'ship it', _turn_id: 'release' }, { role: 'assistant', content: answer, _turn_id: 'release' }]
  const shown = completionNotification('s 1', { title: 'Release', messages }, true, 'release')
  expect(shown.title).toBe('Release')
  expect(shown.url).toBe('/session/s%201')
  expect(shown.body.startsWith('Done Deployed the release with token ghp_ab...6789. More detail.')).toBe(true)
  expect(shown.body.length).toBeLessThanOrEqual(140)
  expect(shown.body.endsWith('…')).toBe(true)
})

it.each([
  { name: 'answerless', reply: [], expected: 'Completed' },
  { name: 'tool-only', reply: [{ role: 'assistant', content: 'Checking', _turn_id: 'finished', tool_calls: [{ id: 't' }] }, { role: 'tool', content: 'Tool output', _turn_id: 'finished' }], expected: 'Completed' },
  { name: 'answered', reply: [{ role: 'assistant', content: '**This answer** with ghp_abcdefghij0123456789', _turn_id: 'finished' }], expected: 'This answer with ghp_ab...6789' },
])('uses only the $name completed run between other answered turns', ({ reply, expected }) => {
  const messages = [
    { role: 'user', content: 'First request', _turn_id: 'older' },
    { role: 'assistant', content: 'The old answer', _turn_id: 'older' },
    { role: 'user', content: 'Finish this one', _turn_id: 'finished' },
    ...reply,
  ]
  expect(completionNotification('s', { messages }, true, 'finished').body).toBe(expected)
  messages.push({ role: 'user', content: 'Another request', _turn_id: 'newer' }, { role: 'assistant', content: 'The new answer', _turn_id: 'newer' })
  expect(completionNotification('s', { messages }, true, 'finished').body).toBe(expected)
})

it.each([
  { name: 'an answer', reply: [{ role: 'assistant', content: '**Native answer**' }], expected: 'Native answer' },
  { name: 'no answer', reply: [], expected: 'Completed' },
])('bounds a legacy turn with $name to the completed prompt', ({ reply, expected }) => {
  const messages = [
    { role: 'user', content: 'First request' },
    { role: 'assistant', content: 'The old answer' },
    { role: 'user', content: 'Finish this one', message_id: 'finished' },
    ...reply,
    { role: 'user', content: 'Another request', message_id: 'newer' },
    { role: 'assistant', content: 'The new answer' },
  ]
  expect(completionNotification('s', { messages }, true, { promptId: 'finished' }).body).toBe(expected)
})

it('uses generic completion text when the completed run is missing', () => {
  const messages = [{ role: 'user', content: 'Another request' }, { role: 'assistant', content: 'An unrelated answer' }]
  expect(completionNotification('s', { title: '', messages }, true, 'missing')).toEqual({ title: 'Untitled', body: 'Completed', url: '/session/s', tag: 's' })
})

// TAL-2336: an approval or input alert names the call it waits on; the row's call is already redacted and capped.
it('names the held call after an approval or input alert body', () => {
  expect(alertBody('approval', { kind: 'shell', target: 'npm publish', done: false })).toBe('Approval needed · Run npm publish')
  expect(alertBody('approval', { kind: 'connector', target: 'Send message', done: false, app: { name: 'Slack' } })).toBe('Approval needed · Slack · Send message')
  expect(alertBody('input', { kind: 'question', target: 'Which branch?', done: false })).toBe('Input needed · Which branch?')
  // No call, a call without a target, or another kind of alert keeps its body.
  expect(alertBody('approval', undefined)).toBe('Approval needed')
  expect(alertBody('input', { kind: 'question', target: '', done: false })).toBe('Input needed')
  expect(alertBody('failure', { kind: 'shell', target: 'npm test', done: true })).toBe('Failed')
})
