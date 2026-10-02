/**
 * TAL-371: automatic background wakeups (async delegation results, background process and watch notices) are shown as
 * "background updates", not as messages the user sent. The server decides which rows are updates and what they say;
 * clients only render `_background_update`.
 */
import type { Session } from './session.js'
import { isDict, messageText } from './merge.js'
import { str } from '../util.js'

type Dict = Record<string, unknown>
export type BackgroundUpdateKind = 'delegation' | 'process' | 'mixed' | 'other'
export interface BackgroundUpdate { kind: BackgroundUpdateKind; attention: boolean; count: number; summary: string }

const RECORD_KEY = 'background_updates'
const RECORD_LIMIT = 200
const SUMMARY_LIMIT = 200
const DELEGATION_DONE = new Set(['completed', 'success'])
/** The Agent's own state.db tags for notifications it wrote into the transcript itself. */
const AGENT_UPDATE_KINDS: Record<string, BackgroundUpdateKind> = { async_delegation_complete: 'delegation', internal_notification: 'other' }

/** The notification's first line without its `[ … ]` wrapper, like the `bg_task_complete` summary. */
export function backgroundUpdateSummary(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^\[/, '').replace(/\]$/, '').trim() ?? ''
  return first.length <= SUMMARY_LIMIT ? first : `${first.slice(0, SUMMARY_LIMIT)}…`
}

/** Kind and attention of one completion event: failures and watch notices need attention without expanding. */
export function eventUpdate(evt: Dict): { kind: BackgroundUpdateKind; attention: boolean } {
  const type = str(evt.type ?? 'completion')
  if (type === 'async_delegation') {
    const results = Array.isArray(evt.results) ? evt.results.filter(isDict) : []
    const failed = Boolean(evt.task_failure_notice) || Boolean(evt.error) || results.some((r) => !DELEGATION_DONE.has(str(r.status)))
    return { kind: 'delegation', attention: failed }
  }
  if (type === 'completion') return { kind: 'process', attention: evt.exit_code !== undefined && evt.exit_code !== null && Number(evt.exit_code) !== 0 }
  // Watch matches and watch overflow / disablement notices.
  return { kind: 'process', attention: true }
}

/** One update for a batched wakeup of these events, summarised by its first notification. */
export function batchUpdate(entries: { event: Dict; prompt: string }[]): BackgroundUpdate {
  const parts = entries.map((e) => eventUpdate(e.event))
  const kinds = new Set(parts.map((p) => p.kind))
  return {
    kind: kinds.size === 1 ? parts[0]!.kind : 'mixed',
    attention: parts.some((p) => p.attention),
    count: entries.length,
    summary: backgroundUpdateSummary(entries[0]?.prompt ?? ''),
  }
}

/** Remember a started wakeup's update by its turn id; the transcript row only carries `_source` and `_turn_id`. */
export function recordBackgroundUpdate(session: Session, turnId: string, update: BackgroundUpdate): void {
  if (!turnId) return
  const existing = isDict(session.extra[RECORD_KEY]) ? (session.extra[RECORD_KEY] as Dict) : {}
  // Oldest first in insertion order; keep the newest RECORD_LIMIT so the session file stays bounded.
  const entries = Object.entries({ ...existing, [turnId]: update })
  session.extra[RECORD_KEY] = Object.fromEntries(entries.slice(-RECORD_LIMIT))
}

function recordedUpdate(recorded: Dict, turnId: unknown): BackgroundUpdate | null {
  const raw = recorded[str(turnId)]
  if (!isDict(raw)) return null
  const kind = str(raw.kind) as BackgroundUpdateKind
  if (!['delegation', 'process', 'mixed', 'other'].includes(kind)) return null
  return { kind, attention: raw.attention === true, count: Math.max(1, Number(raw.count) || 1), summary: str(raw.summary) }
}

function agentUpdate(m: Dict): BackgroundUpdate | null {
  const kind = AGENT_UPDATE_KINDS[str(m.display_kind)]
  if (!kind) return null
  const meta = isDict(m.display_metadata) ? m.display_metadata : {}
  return { kind, attention: Number(meta.failed_count) > 0, count: 1, summary: backgroundUpdateSummary(messageText(m.content)) }
}

/**
 * Stamps `_background_update` on user rows that are automatic wakeups: Web's own (`_source: process_wakeup`, with the
 * update recorded at delivery, else a generic one for older rows) and the Agent's (`display_kind` from state.db). A
 * person typing the same text stays an ordinary user message. Returns copies; stored rows are untouched.
 */
export function withBackgroundUpdates<T>(messages: T[], session: Session): T[] {
  const recorded = isDict(session.extra[RECORD_KEY]) ? (session.extra[RECORD_KEY] as Dict) : {}
  return messages.map((m) => {
    if (!isDict(m) || m.role !== 'user') return m
    const update: BackgroundUpdate | null = m._source === 'process_wakeup'
      ? recordedUpdate(recorded, m._turn_id) ?? { kind: 'other', attention: false, count: 1, summary: backgroundUpdateSummary(messageText(m.content)) }
      : agentUpdate(m)
    return update ? { ...m, _background_update: update } : m
  })
}
