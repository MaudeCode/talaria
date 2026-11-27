/**
 * The alert rule every notification channel applies, ported from the relay's `alertForTransition`
 * (relay/convex/lib/aggregate.ts). `contracts/fixtures/notification-alerts.json` pins both copies.
 */
import type { ActivityTool, WebAudioCompletion, WebPushPreferences } from '@maudecode/talaria-web-contracts'
import { redactString } from '../../redact.js'
import { markdownPlainText } from '../../text/markdown.js'
import { messageTurnId } from '../anchor.js'
import { bodyExcerpt, finalAnswerOf, isConversationalAssistant, isDict } from '../merge.js'

export type AlertKind = 'approval' | 'input' | 'completion' | 'failure' | 'decision'

export type AlertPreferences = WebPushPreferences

/** What an alert of each kind says when nothing more specific applies. */
export const ALERT_BODY: Record<AlertKind, string> = { approval: 'Approval needed', input: 'Input needed', completion: 'Completed', failure: 'Failed', decision: 'Decision review ready' }

/**
 * TAL-2336: an approval or input alert names the call it waits on after its kind's body: "Approval needed · Run npm
 * publish", an app's call as "<app> · <action>". The call's fields are already redacted and capped; a call with no target
 * leaves the body as it is.
 */
export function alertBody(kind: AlertKind, tool: ActivityTool | undefined): string {
  const target = (kind === 'approval' || kind === 'input') && tool ? tool.target : ''
  if (!target) return ALERT_BODY[kind]
  const label = tool!.app ? `${tool!.app.name} · ${target}` : tool!.kind === 'shell' ? `Run ${target}` : target
  return `${ALERT_BODY[kind]} · ${label}`
}

export type CompletionNotification = NonNullable<WebAudioCompletion['notification']>
export interface OwnerCompletionRun { identity: string; promptId: string }
type CompletedTurn = string | Pick<OwnerCompletionRun, 'promptId'> | null
const COMPLETION_BODY_MAX = 140

function completedReply(messages: readonly unknown[], turn: CompletedTurn): Record<string, unknown> | undefined {
  if (!turn) return undefined
  if (typeof turn === 'string') {
    return messages.findLast((row): row is Record<string, unknown> => isConversationalAssistant(row) && row._turn_id === turn)
  }
  // Native transcripts can lack Web stream IDs. The admission's prompt anchors the same turn boundaries used by chat.
  const start = messages.findIndex((row) => isDict(row) && row.role === 'user' && row.message_id === turn.promptId)
  const prompt = messages[start]
  if (!isDict(prompt)) return undefined
  const id = messageTurnId(prompt, start, 'legacy:start')
  let reply: Record<string, unknown> | undefined
  for (let i = start + 1; i < messages.length; i++) {
    const row = messages[i]
    if (!isDict(row)) continue
    if (messageTurnId(row, i, id) !== id) break
    if (isConversationalAssistant(row)) reply = row
  }
  return reply
}

/**
 * TAL-2157: a finished reply's notification, for its Web Push and the open tab's browser notification alike: the chat's
 * title, then the start of the turn's final answer as redacted plain text. A turn that ended without an answer says so.
 */
export function completionNotification(sessionId: string, session: { title?: unknown; messages?: unknown } | null, redact: boolean, turn: CompletedTurn): CompletionNotification {
  const title = typeof session?.title === 'string' && session.title.trim() ? redactString(session.title, redact).slice(0, 120) : 'Untitled'
  const last = Array.isArray(session?.messages) ? completedReply(session.messages, turn) : undefined
  const text = markdownPlainText(redactString(last ? finalAnswerOf(last) : '', redact))
  const body = text.length > COMPLETION_BODY_MAX ? `${bodyExcerpt(text, COMPLETION_BODY_MAX - 1)}…` : text
  return { title, body: body || ALERT_BODY.completion, url: `/session/${encodeURIComponent(sessionId)}`, tag: sessionId }
}

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true, notify_on_update_available: false }

const KIND_BY_PHASE: Record<string, { kind: AlertKind; pref: keyof AlertPreferences } | undefined> = {
  waiting_for_approval: { kind: 'approval', pref: 'notify_on_approval' },
  waiting_for_input: { kind: 'input', pref: 'notify_on_input' },
  completed: { kind: 'completion', pref: 'notify_on_completion' },
  failed: { kind: 'failure', pref: 'notify_on_failure' },
}

/**
 * No alert on a first publication or an ineligible state (a Talaria tab is open). TAL-1966: a decision review the row
 * did not hold before alerts once under the input preference, whatever the phase did. When both states name an
 * approval head, its identity decides whether to alert. Otherwise the phase decides.
 */
export function alertForTransition(
  previous: string | null,
  next: { phase: string; alertEligible: boolean; approvalHeadId?: string | undefined; decisionReviewId?: string | undefined },
  preferences: AlertPreferences,
  previousDecisionReviewId?: string | null,
  previousApprovalHeadId?: string,
): AlertKind | null {
  if (!previous || !next.alertEligible) return null
  if (next.decisionReviewId && next.decisionReviewId !== previousDecisionReviewId && preferences.notify_on_input) return 'decision'
  const transitioned = next.phase === 'waiting_for_approval' && next.approvalHeadId !== undefined && previousApprovalHeadId !== undefined
    ? next.approvalHeadId !== previousApprovalHeadId
    : previous !== next.phase
  if (!transitioned) return null
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

/**
 * TAL-2665: a server notice (an update is available) alerts only a server owner's subscription that opted in. The relay
 * applies the same rule to devices (`serverNoticeAllowed` in relay/convex/lib/aggregate.ts).
 */
export function serverNoticeAllowed(preferences: Partial<AlertPreferences>, owner: boolean): boolean {
  return owner && preferences.notify_on_update_available === true
}
