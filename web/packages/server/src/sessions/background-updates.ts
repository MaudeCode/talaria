/**
 * TAL-371: automatic background wakeups (async delegation results, background process and watch notices) are shown as
 * "background updates", not as messages the user sent. The server decides which rows are updates and what they say;
 * clients only render `_background_update`. TAL-460: each update carries one completion line per result, and the
 * Agent's reply to it is marked (`_background_reply`) and, when it is only a silence marker, silent (`_background_silent`).
 */
import type { Session } from './session.js'
import { isDict, messageText } from './merge.js'
import { str } from '../util.js'

type Dict = Record<string, unknown>
export type BackgroundUpdateKind = 'delegation' | 'process' | 'mixed' | 'other'
/** One finished background item: an agent (by its goal), a command, or another notice (by its summary). */
export interface BackgroundLine { kind: 'agent' | 'command' | 'other'; status: 'completed' | 'failed' | 'notice'; label: string; exit_code?: number | null }
export interface BackgroundUpdate { kind: BackgroundUpdateKind; attention: boolean; count: number; summary: string; lines: BackgroundLine[] }
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
  const type = str(evt.type ?? 'completion')
  if (type === 'async_delegation') {
    const results = Array.isArray(evt.results) ? evt.results.filter(isDict) : []
    const goals = Array.isArray(evt.goals) ? evt.goals : []
    if (!results.length) return [{ kind: 'agent', status: eventUpdate(evt).attention ? 'failed' : 'completed', label: label(evt.goal) || backgroundUpdateSummary(prompt) }]
    return results.map((r, i) => ({ kind: 'agent', status: DELEGATION_DONE.has(str(r.status)) ? 'completed' : 'failed', label: label(goals[i] ?? r.goal ?? evt.goal) }))
  }
  if (type === 'completion') {
    const exit = evt.exit_code === undefined || evt.exit_code === null ? null : Number(evt.exit_code)
    return [{ kind: 'command', status: exit !== null && exit !== 0 ? 'failed' : 'completed', label: label(evt.command), exit_code: exit }]
  }
  return [{ kind: 'other', status: 'notice', label: backgroundUpdateSummary(prompt) }]
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
    lines: entries.flatMap((e) => eventLines(e.event, e.prompt)),
  }
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

function recordedUpdate(recorded: Dict, turnId: unknown): BackgroundUpdate | null {
  const raw = recorded[str(turnId)]
  if (!isDict(raw)) return null
  const kind = str(raw.kind) as BackgroundUpdateKind
  if (!['delegation', 'process', 'mixed', 'other'].includes(kind)) return null
  const update = summaryUpdate(kind, raw.attention === true, str(raw.summary))
  // ponytail: line entries are trusted as the server wrote them; validate per field if records ever come from elsewhere.
  return { ...update, count: Math.max(1, Number(raw.count) || 1), lines: Array.isArray(raw.lines) && raw.lines.length ? (raw.lines.filter(isDict) as unknown as BackgroundLine[]) : update.lines }
}

function agentUpdate(m: Dict): BackgroundUpdate | null {
  const kind = AGENT_UPDATE_KINDS[str(m.display_kind)]
  if (!kind) return null
  const meta = isDict(m.display_metadata) ? m.display_metadata : {}
  return summaryUpdate(kind, Number(meta.failed_count) > 0, backgroundUpdateSummary(messageText(m.content)))
}

/**
 * Stamps `_background_update` on user rows that are automatic wakeups: Web's own (`_source: process_wakeup`, with the
 * update recorded at delivery, else a generic one for older rows) and the Agent's (`display_kind` from state.db). A
 * person typing the same text stays an ordinary user message. The rest of a wakeup's turn is the Agent's reply to it
 * (`_background_reply`); a reply that ends on a silence marker is `_background_silent` throughout. Needs `_turn_id` on
 * every row (`withTurnIds`). Returns copies; stored rows are untouched.
 */
export function withBackgroundUpdates<T>(messages: T[], session: Session): T[] {
  const recorded = isDict(session.extra[RECORD_KEY]) ? (session.extra[RECORD_KEY] as Dict) : {}
  const backgroundTurns = new Set<string>()
  const stamped = messages.map((m) => {
    if (!isDict(m) || m.role !== 'user') return m
    const update: BackgroundUpdate | null = m._source === BACKGROUND_SOURCE
      ? recordedUpdate(recorded, m._turn_id) ?? summaryUpdate('other', false, backgroundUpdateSummary(messageText(m.content)))
      : agentUpdate(m)
    if (!update) return m
    backgroundTurns.add(str(m._turn_id))
    return { ...m, _background_update: update }
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
