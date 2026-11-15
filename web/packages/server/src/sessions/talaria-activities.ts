import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { TalariaActivitySchema, type TalariaActivity } from '@maudecode/talaria-web-contracts'
import type { Session } from './session.js'
import { isDict } from './merge.js'
import { str } from '../util.js'

/**
 * Producer inventory: decisions/proposals use sendTalariaMessage; session tools use peerAgentActivity.
 * Turn admission owns their direct start/steer receipts. GatewaySessions binds native input receipts separately
 * because native chats have no Web Session document. Background completion and Web-update continuations retain
 * their existing source/turn receipts. Groups project their native event identity without sending a model turn.
 * Session clear records display-only lifecycle notices. Agent display_kind notices, native deliveries, Agent goal
 * prompts and user-authored approval-denial instructions retain their original provenance. Unmarked historical
 * prose is never upgraded. New producers supply a kind and safe summary here, without a new client branch.
 */

/** Extends background_updates' admission receipts with provenance for any Talaria producer. */
export function talariaActivity(kind: string, summary: string, target?: TalariaActivity['target']): TalariaActivity {
  return { version: 1, origin: 'talaria', id: randomUUID(), kind, summary: summary.replace(/\s+/g, ' ').trim(), ...(target ? { target } : {}) }
}

export function recordTalariaActivity(session: Session, identity: string, activity: TalariaActivity): void {
  const records = isDict(session.extra.talaria_activities) ? session.extra.talaria_activities : {}
  session.extra.talaria_activities = { ...records, [identity]: activity }
}

/** Tool transport is Talaria; authorship remains the caller's. Names come from the authorized session. */
export function peerAgentActivity(caller: Pick<Session, 'session_id' | 'title'>, message: string): TalariaActivity {
  const name = caller.title.replace(/\s+/g, ' ').trim() || 'Agent'
  return { ...talariaActivity('peer_message', `Message from ${name}`, { kind: 'session', id: caller.session_id, path: `/session/${encodeURIComponent(caller.session_id)}` }), origin: 'peer_agent', sender: { session_id: caller.session_id, name }, details: message }
}

function activityIdentity(row: Record<string, unknown>): string {
  const steer = isDict(row._steer) ? str(row._steer.steer_id) : ''
  if (steer) return `steer:${steer}`
  if (row.role === 'user') return row._source === 'talaria' ? `turn:${str(row._turn_id)}` : ''
  return `message:${str(row.message_id)}`
}

/** A history cut removes receipts with the rows they describe; compaction preserves them. */
export function pruneTalariaActivities(session: Session, messages: unknown[]): void {
  if (!isDict(session.extra.talaria_activities)) return
  Object.assign(session.extra, inheritedTalariaActivities(session, messages))
}

/** Duplicate and partial branch have separate constructors; both inherit only the kept rows' receipts. */
export function inheritedTalariaActivities(session: Session, messages: unknown[]): { talaria_activities: Record<string, unknown> } {
  const retained = new Set(messages.filter(isDict).map(activityIdentity))
  const records = isDict(session.extra.talaria_activities) ? session.extra.talaria_activities : {}
  return { talaria_activities: structuredClone(Object.fromEntries(Object.entries(records).filter(([key]) => retained.has(key)))) }
}

/** Exact admission identities establish provenance; text and embedded JSON never do. */
export function withTalariaActivities<T>(messages: T[], session: Session): T[] {
  const records = isDict(session.extra.talaria_activities) ? session.extra.talaria_activities : {}
  if (!Object.keys(records).length && !messages.some((row) => isDict(row) && (Object.hasOwn(row, '_talaria_activity') || ['process_wakeup', 'update_continuation'].includes(str(row._source))))) return messages
  let changed = false
  const projected = messages.map((raw) => {
    if (!isDict(raw)) return raw
    const identity = activityIdentity(raw)
    let activity = TalariaActivitySchema.safeParse(records[identity]).data
    if (!activity && raw.role === 'user' && raw._turn_id && ['process_wakeup', 'update_continuation'].includes(str(raw._source))) {
      activity = { version: 1, origin: 'talaria', id: str(raw._turn_id), kind: str(raw._source), summary: raw._source === 'update_continuation' ? 'Continued after Web update' : 'Background update received' }
    }
    if (!activity && !Object.hasOwn(raw, '_talaria_activity')) return raw
    let background = raw._background_update
    if (activity && raw._source === 'update_continuation' && isDict(background) && Array.isArray(background.lines) && background.lines.some((line) => isDict(line) && line.label !== activity.summary)) {
      background = { ...background, lines: background.lines.map((line: unknown) => isDict(line) ? { ...line, label: activity.summary } : line) }
    }
    if (activity && raw.message_id !== undefined && isDeepStrictEqual(raw._talaria_activity, activity) && background === raw._background_update) return raw
    changed = true
    const { _talaria_activity: _untrusted, ...row } = raw
    return (activity ? { ...row, message_id: row.message_id ?? activity.id, _talaria_activity: activity, ...(background !== raw._background_update ? { _background_update: background } : {}) } : row) as T
  })
  return changed ? projected : messages
}
