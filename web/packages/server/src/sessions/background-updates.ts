/**
 * TAL-371: automatic background wakeups (async delegation results, background process and watch notices) are shown as
 * "background updates", not as messages the user sent. The server decides which rows are updates and what they say;
 * clients only render `_background_update`. TAL-460: each update carries one completion line per result, and the
 * Agent's reply to it is marked (`_background_reply`) and, when it is only a silence marker, silent (`_background_silent`).
 */
import type { BackgroundReviewState, BackgroundLine } from '@maudecode/talaria-web-contracts'
import { turnTerminalState } from './anchor.js'
import type { Session } from './session.js'
import { isDict, messageText } from './merge.js'
import { str } from '../util.js'
import { backgroundEventKind } from './background-events.js'

type Dict = Record<string, unknown>
export type BackgroundUpdateKind = 'delegation' | 'process' | 'mixed' | 'other'
export interface BackgroundUpdate { kind: BackgroundUpdateKind; attention: boolean; count: number; summary: string; lines: BackgroundLine[]; display_kind?: 'hidden'; review_state?: BackgroundReviewState }
export type TurnOrigin = 'user' | 'background'

const RECORD_KEY = 'background_updates'
const RECORD_LIMIT = 200
const SUMMARY_LIMIT = 200
const LABEL_LIMIT = 120
/** Hermes `LIVE_GATEWAY_SILENT_MARKERS`: a whole reply that is exactly one of these means "nothing to say". */
const SILENT_MARKERS = new Set(['[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY'])
const SILENT_MAX_LENGTH = 64
const BACKGROUND_SOURCE = 'process_wakeup'
/** The one instruction a background turn gets on top of the usual ones (TAL-460). */
export const BACKGROUND_TURN_PROMPT = 'This turn was started by a background result, not by the user. If it needs nothing from the user, reply exactly [SILENT]. Otherwise tell the user what matters.'
const DELEGATION_DONE = new Set(['completed', 'success'])
/** The Agent's own state.db tags for notifications it wrote into the transcript itself. */
const AGENT_UPDATE_KINDS: Record<string, BackgroundUpdateKind> = { async_delegation_complete: 'delegation', internal_notification: 'other' }

/** The notification's first line without its `[ … ]` wrapper, like the `bg_task_complete` summary. */
export function backgroundUpdateSummary(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^\[/, '').replace(/\]$/, '').trim() ?? ''
  return first.length <= SUMMARY_LIMIT ? first : `${first.slice(0, SUMMARY_LIMIT)}…`
}

export function turnOrigin(source: string | null | undefined): TurnOrigin {
  return source === BACKGROUND_SOURCE ? 'background' : 'user'
}

/** Hermes `_canonical_silence_candidates`: the reply as written and without edge punctuation (brackets stay), upper-cased. */
function silenceCandidates(text: string): string[] {
  const canonical = (t: string): string => t.trim().toUpperCase().split(/\s+/).join(' ')
  const stripped = text.replace(/^(?:(?![[\]])\p{P})+/u, '').replace(/(?:(?![[\]])\p{P})+$/u, '').trim()
  return [canonical(text), canonical(stripped)]
}

/** Hermes `is_intentional_silence_response`: the whole reply is exactly a silence marker. */
export function isSilentReply(text: string): boolean {
  const t = text.trim()
  return Boolean(t) && t.length <= SILENT_MAX_LENGTH && silenceCandidates(t).some((c) => SILENT_MARKERS.has(c))
}

/** Hermes's streaming counterpart: text so far that could still become a silence marker is held back. */
export function mayBecomeSilentReply(text: string): boolean {
  const t = text.trim()
  return Boolean(t) && t.length <= SILENT_MAX_LENGTH && silenceCandidates(t).some((c) => Boolean(c) && [...SILENT_MARKERS].some((m) => m.startsWith(c)))
}

function label(text: unknown): string {
  const first = str(text).split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return first.length <= LABEL_LIMIT ? first : `${first.slice(0, LABEL_LIMIT)}…`
}

/** The completion lines of one event: one per agent of a delegation batch, one for a command, else one notice. */
export function eventLines(evt: Dict, prompt: string): BackgroundLine[] {
  const kind = backgroundEventKind(evt)
  if (kind === 'delegation') {
    const results = Array.isArray(evt.results) ? evt.results.filter(isDict) : []
    const goals = Array.isArray(evt.goals) ? evt.goals : []
    return (results.length ? results : [evt]).map((r, i) => {
      // Preserve the goal while keeping an unknown worker outcome distinct from success.
      if (r.status === 'unknown') return { kind: 'agent', status: 'notice', label: label(goals[i] ?? r.goal ?? evt.goal) || label(r.error ?? evt.error) || 'Outcome unknown' }
      return { kind: 'agent', status: (results.length ? DELEGATION_DONE.has(str(r.status)) : !eventUpdate(evt).attention) ? 'completed' : 'failed', label: label(goals[i] ?? r.goal ?? evt.goal) || (results.length ? '' : backgroundUpdateSummary(prompt)) }
    })
  }
  if (kind === 'completion') {
    const exit = evt.exit_code === undefined || evt.exit_code === null ? null : Number(evt.exit_code)
    return [{ kind: 'command', status: exit !== null && exit !== 0 ? 'failed' : 'completed', label: label(evt.command), exit_code: exit }]
  }
  return [{ kind: 'other', status: 'notice', label: backgroundUpdateSummary(prompt) }]
}

/** Kind and attention of one completion event: failures and watch notices need attention without expanding. */
export function eventUpdate(evt: Dict): { kind: BackgroundUpdateKind; attention: boolean } {
  const kind = backgroundEventKind(evt)
  if (kind === 'delegation') {
    const results = Array.isArray(evt.results) ? evt.results.filter(isDict) : []
    const failed = evt.status === 'unknown' || Boolean(evt.task_failure_notice) || Boolean(evt.error) || results.some((r) => !DELEGATION_DONE.has(str(r.status)))
    return { kind: 'delegation', attention: failed }
  }
  if (kind === 'completion') return { kind: 'process', attention: evt.exit_code !== undefined && evt.exit_code !== null && Number(evt.exit_code) !== 0 }
  if (kind === 'progress') return { kind: 'process', attention: false }
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
    lines: entries.flatMap((e) => eventLines(e.event, e.prompt)),
    ...(entries.length && entries.every((e) => backgroundEventKind(e.event) === 'progress') ? { display_kind: 'hidden' as const } : {}),
  }
}

/** Persist the display kind on the prompt itself before the bounded per-turn metadata ages out. Also used for live reads. */
export function withBackgroundDisplayKinds<T>(messages: T[], session: Session): T[] {
  const recorded = session.extra[RECORD_KEY]
  if (!isDict(recorded)) return messages
  return messages.map((m) => {
    if (!isDict(m) || m.role !== 'user') return m
    const meta = isDict(m.display_metadata) ? m.display_metadata : {}
    const key = m._source === BACKGROUND_SOURCE ? str(m._turn_id) : AGENT_UPDATE_KINDS[str(m.display_kind)] ? `delegation:${str(meta.delegation_id)}` : ''
    const update = recorded[key]
    return isDict(update) ? { ...m, _background_update: update, ...(update.display_kind === 'hidden' ? { display_kind: 'hidden' } : {}) } : m
  })
}

/** An update without event metadata (older records, the Agent's own rows): one line from its summary. */
function summaryUpdate(kind: BackgroundUpdateKind, attention: boolean, summary: string): BackgroundUpdate {
  return { kind, attention, count: 1, summary, lines: [{ kind: 'other', status: attention ? 'failed' : 'completed', label: summary }] }
}

/** Remember a started wakeup's update by its turn id; the transcript row only carries `_source` and `_turn_id`. */
export function recordBackgroundUpdate(session: Session, turnId: string, update: BackgroundUpdate): void {
  if (!turnId) return
  const existing = isDict(session.extra[RECORD_KEY]) ? (session.extra[RECORD_KEY] as Dict) : {}
  // Oldest first in insertion order; keep the newest RECORD_LIMIT so the session file stays bounded.
  const entries = Object.entries({ ...existing, [turnId]: update })
  session.extra[RECORD_KEY] = Object.fromEntries(entries.slice(-RECORD_LIMIT))
}

/** Admission writes these receipts in the same session save as its pending turn, before a worker starts. */
export function completionAccepted(session: Session, key: string): boolean {
  const receipts = session.extra.completion_acceptances
  return Boolean(key && isDict(receipts) && typeof receipts[key] === 'string' && receipts[key])
}

function recordedUpdate(recorded: Dict, turnId: unknown): BackgroundUpdate | null {
  const raw = recorded[str(turnId)]
  if (!isDict(raw)) return null
  const kind = str(raw.kind) as BackgroundUpdateKind
  if (!['delegation', 'process', 'mixed', 'other'].includes(kind)) return null
  const update = summaryUpdate(kind, raw.attention === true, str(raw.summary))
  // ponytail: line entries are trusted as the server wrote them; validate per field if records ever come from elsewhere.
  return { ...update, count: Math.max(1, Number(raw.count) || 1), lines: Array.isArray(raw.lines) && raw.lines.length ? (raw.lines.filter(isDict) as unknown as BackgroundLine[]) : update.lines }
}

function agentUpdate(m: Dict, recorded: Dict): BackgroundUpdate | null {
  const kind = AGENT_UPDATE_KINDS[str(m.display_kind)]
  if (!kind) return null
  const meta = isDict(m.display_metadata) ? m.display_metadata : {}
  const authoritative = recordedUpdate(recorded, `delegation:${str(meta.delegation_id)}`) ?? recordedUpdate({ row: m._background_update }, 'row')
  if (authoritative) return authoritative
  const update = summaryUpdate(kind, Number(meta.failed_count) > 0, backgroundUpdateSummary(messageText(m.content)))
  // Agent completed_count also counts recovered unknown outcomes. Only an event proves success.
  if (kind === 'delegation' && !update.attention) update.lines = update.lines.map((line) => ({ ...line, status: 'notice' }))
  return update
}

/**
 * Stamps `_background_update` on user rows that are automatic wakeups: Web's own (`_source: process_wakeup`, with the
 * update recorded at delivery, else a generic one for older rows) and the Agent's (`display_kind` from state.db). A
 * person typing the same text stays an ordinary user message. The rest of a wakeup's turn is the Agent's reply to it
 * (`_background_reply`); a reply that ends on a silence marker is `_background_silent` throughout. Needs `_turn_id` on
 * every row (`withTurnIds`). Returns copies; stored rows are untouched.
 */
export interface BackgroundReviewContext { activeTurnId?: string | null; pendingDelegations?: Set<string> }

/** Persist terminal evidence on the admitted prompt, alongside its actual final reply. */
export function recordBackgroundReview(session: Session, turnId: string): void {
  const prompt = session.messages.find((m) => m.role === 'user' && m._source === BACKGROUND_SOURCE && m._turn_id === turnId)
  if (prompt) prompt._background_review_terminal = turnTerminalState(session.messages, turnId)
}

function parentReview(session: Session, rows: Dict[], turnId: string, pending: boolean, context: BackgroundReviewContext): BackgroundReviewState {
  const receipt = rows.find((m) => m.role === 'user' && m._source === BACKGROUND_SOURCE)?._background_review_terminal
  const last = rows.findLast((m) => m.role === 'assistant')
  const terminal = str(receipt) || str(last?._terminal_state) || (last?._error === true ? 'error' : '')
  if (terminal) {
    if (terminal === 'completed') return receipt === 'completed' && turnTerminalState(rows, turnId) === 'completed' ? 'reviewed' : 'unknown'
    if (['cancelled', 'interrupted', 'no_response'].includes(terminal)) return pending ? 'waiting' : 'unknown'
    return 'failed'
  }
  if (turnId && context.activeTurnId === turnId && session.active_stream_id === turnId && session.pending_user_source === BACKGROUND_SOURCE) return 'reviewing'
  return pending ? 'waiting' : 'unknown'
}

/** Admission receipts name the precise parent turn, even before the drain's follow-up metadata save. */
function admittedReviewTurn(session: Session, delegationId: string): string {
  if (!delegationId || !isDict(session.extra.completion_acceptances)) return ''
  const turns = new Set<string>()
  for (const [key, turn] of Object.entries(session.extra.completion_acceptances)) {
    try {
      const identity: unknown = JSON.parse(key)
      if (Array.isArray(identity) && identity.length === 2 && identity[1] === delegationId && typeof turn === 'string' && turn) turns.add(turn)
    } catch { /* An older or unrelated receipt cannot establish admission. */ }
  }
  return turns.size === 1 ? [...turns][0]! : ''
}

export function withBackgroundUpdates<T>(messages: T[], session: Session, context: BackgroundReviewContext = {}): T[] {
  const recorded = isDict(session.extra[RECORD_KEY]) ? (session.extra[RECORD_KEY] as Dict) : {}
  const backgroundTurns = new Set<string>()
  const turns = new Map<string, Dict[]>()
  for (const m of session.messages) {
    const turn = str(m._turn_id)
    const rows = turns.get(turn) ?? []
    rows.push(m)
    turns.set(turn, rows)
  }
  const stamped = withBackgroundDisplayKinds(messages, session).map((m) => {
    if (!isDict(m) || m.role !== 'user') return m
    const update: BackgroundUpdate | null = m._source === BACKGROUND_SOURCE
      ? recordedUpdate(recorded, m._turn_id) ?? recordedUpdate({ row: m._background_update }, 'row') ?? summaryUpdate('other', false, backgroundUpdateSummary(messageText(m.content)))
      : agentUpdate(m, recorded)
    if (!update) return m
    backgroundTurns.add(str(m._turn_id))
    const delegationId = str(isDict(m.display_metadata) ? m.display_metadata.delegation_id : '')
    // An Agent notification can precede Web admission. Only the exact accepted result joins that parent's turn.
    const reviewTurn = m._source === BACKGROUND_SOURCE ? str(m._turn_id) : admittedReviewTurn(session, delegationId)
    const review = parentReview(session, turns.get(reviewTurn) ?? [], reviewTurn, Boolean(delegationId && context.pendingDelegations?.has(delegationId)), context)
    return { ...m, _background_update: { ...update, review_state: review, lines: update.lines.map((line) => ({ ...line, review_state: line.status === 'failed' ? 'failed' : line.status === 'notice' ? 'unknown' : review })) } }
  })
  // A turn is silent when its last assistant text is exactly a silence marker; a running turn has no final text yet.
  const silent = new Set<string>()
  const lastText = new Map<string, string>()
  for (const m of stamped) if (isDict(m) && m.role === 'assistant' && backgroundTurns.has(str(m._turn_id)) && messageText(m.content).trim()) lastText.set(str(m._turn_id), messageText(m.content))
  for (const [turn, text] of lastText) if (isSilentReply(text)) silent.add(turn)
  return stamped.map((m) => {
    if (!isDict(m) || m.role === 'user' || !backgroundTurns.has(str(m._turn_id))) return m
    return { ...m, _background_reply: true, ...(silent.has(str(m._turn_id)) ? { _background_silent: true } : {}) }
  })
}
