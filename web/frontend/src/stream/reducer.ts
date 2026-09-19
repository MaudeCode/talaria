/**
 * Chat stream reducer (HWEB-100). Pure projection of the `/api/chat/stream`
 * event union into one live turn per session. The connection layer owns the
 * EventSource; this module owns ordering, idempotency, and every lifecycle
 * exit. Invariants from docs/rfcs/webui-run-state-consistency-contract.md:
 *
 * 1. A turn has exactly one owner stream id; events from another stream id
 *    for the same session are ignored.
 * 2. Terminal events (`done`, `apperror`, `error`, `cancel`) finalize the
 *    turn once; later content events are dropped, `stream_end` only closes.
 * 3. Replayed events carry `id:` cursors (`stream:seq`); a cursor at or
 *    below the last applied seq is a duplicate and is dropped.
 * 4. Teardown (session switch, profile change, unmount) releases the local
 *    transport but never cancels the backend run.
 */
import type { ChatEvent } from '../contracts/sse'
import type { ApprovalPending, ClarifyPending, Session } from '../contracts'

export type TurnStatus = 'starting' | 'connecting' | 'streaming' | 'reconnecting' | 'done' | 'error' | 'cancelled'

export interface LiveToolCall {
  id: string
  name: string
  args: unknown
  preview: string | null
  done: boolean
  isError: boolean
  duration: number | null
  costUsd: number | null
  result: unknown
  startedAt: number
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string; titles: string[] }
  | { kind: 'tool'; toolId: string }

export interface LiveTurn {
  sessionId: string
  streamId: string
  turnId: string | null
  userMessageId: string | null
  userText: string
  startedAt: number
  status: TurnStatus
  segments: Segment[]
  tools: Record<string, LiveToolCall>
  toolOrder: string[]
  reasoningText: string
  reasoningTitles: string[]
  lastEventId: string
  lastSeq: number
  usage: unknown
  tps: number | null
  contextStatus: { state?: string | undefined; message?: string | undefined } | null
  warning: string | null
  error: { type: string; message: string; hint?: string | undefined; continuationSessionId?: string | undefined } | null
  cancelledMessage: string | null
  approval: ApprovalPending | null
  clarify: ClarifyPending | null
  steerConsumed: { id: string; text: string }[]
  pendingSteerLeftover: string | null
  compression: { state: 'compressing' | 'compressed'; newSessionId: string | null } | null
  title: string | null
  doneSession: Session | null
  doneAt: number | null
  streamEnded: boolean
  goal: unknown
  replayed: boolean
}

export type StreamAction =
  | { type: 'start'; sessionId: string; streamId: string; turnId: string | null; userMessageId: string | null; userText: string; now: number }
  | { type: 'attach'; sessionId: string; streamId: string; now: number; replay: boolean }
  | { type: 'connection'; sessionId: string; streamId: string; status: 'open' | 'error' | 'reconnecting' }
  | { type: 'event'; sessionId: string; streamId: string; event: ChatEvent; lastEventId: string; now: number }
  | { type: 'settle'; sessionId: string; streamId: string; session: Session | null }
  | { type: 'teardown'; sessionId: string }
  | { type: 'clear_approval'; sessionId: string }
  | { type: 'clear_clarify'; sessionId: string }

export interface StreamState {
  turns: Record<string, LiveTurn>
}

export const initialStreamState: StreamState = { turns: {} }

const TERMINAL: ReadonlySet<TurnStatus> = new Set(['done', 'error', 'cancelled'])

export function isTerminal(status: TurnStatus): boolean {
  return TERMINAL.has(status)
}

function newTurn(sessionId: string, streamId: string, now: number): LiveTurn {
  return {
    sessionId, streamId, turnId: null, userMessageId: null, userText: '', startedAt: now, status: 'starting',
    segments: [], tools: {}, toolOrder: [], reasoningText: '', reasoningTitles: [], lastEventId: '', lastSeq: 0,
    usage: null, tps: null, contextStatus: null, warning: null, error: null, cancelledMessage: null, approval: null, clarify: null,
    steerConsumed: [], pendingSteerLeftover: null, compression: null, title: null, doneSession: null, doneAt: null, streamEnded: false, goal: null, replayed: false,
  }
}

/** `stream:seq` cursors are opaque to clients except for duplicate detection within the same stream. */
export function parseSeq(lastEventId: string, streamId: string): number | null {
  if (!lastEventId) return null
  const idx = lastEventId.lastIndexOf(':')
  if (idx <= 0) return null
  if (lastEventId.slice(0, idx) !== streamId) return null
  const n = Number(lastEventId.slice(idx + 1))
  return Number.isFinite(n) ? n : null
}

function appendText(segments: Segment[], text: string): Segment[] {
  if (!text) return segments
  const last = segments[segments.length - 1]
  if (last?.kind === 'text') return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }]
  return [...segments, { kind: 'text', text }]
}

function appendReasoning(segments: Segment[], text: string, titles: string[] | null): Segment[] {
  const last = segments[segments.length - 1]
  if (last?.kind === 'reasoning') return [...segments.slice(0, -1), { kind: 'reasoning', text: last.text + text, titles: titles ?? last.titles }]
  if (!text && !titles) return segments
  return [...segments, { kind: 'reasoning', text, titles: titles ?? [] }]
}

let toolSeq = 0
function toolIdFor(data: { id?: string | undefined; call_id?: string | undefined; tool_call_id?: string | undefined; name?: string | undefined }, turn: LiveTurn, completing: boolean): string {
  const explicit = data.id ?? data.call_id ?? data.tool_call_id
  if (explicit) return explicit
  if (completing) {
    // Match the oldest still-running call with the same name (legacy upsertLiveToolCall semantics).
    for (const id of turn.toolOrder) {
      const t = turn.tools[id]
      if (t && !t.done && t.name === (data.name ?? '')) return id
    }
  }
  toolSeq += 1
  return `tool-${turn.streamId}-${toolSeq}`
}

function reduceTurn(turn: LiveTurn, action: Extract<StreamAction, { type: 'event' }>): LiveTurn {
  const { event, lastEventId, now } = action
  // Invariant 3: duplicate or stale replay cursor.
  const seq = parseSeq(lastEventId, turn.streamId)
  if (seq !== null) {
    if (seq <= turn.lastSeq) return turn
  }
  const stamped: LiveTurn = seq !== null ? { ...turn, lastSeq: seq, lastEventId } : lastEventId ? { ...turn, lastEventId } : turn
  const terminal = isTerminal(turn.status)
  const live = (): LiveTurn => (stamped.status === 'starting' || stamped.status === 'connecting' || stamped.status === 'reconnecting' ? { ...stamped, status: 'streaming' } : stamped)

  switch (event.event) {
    case 'token': {
      if (terminal) return stamped
      const t = live()
      const text = event.data.text ?? ''
      if (event.data.already_streamed) return t
      return { ...t, segments: appendText(t.segments, text) }
    }
    case 'interim_assistant': {
      if (terminal) return stamped
      const t = live()
      const text = (event.data.text ?? '').trim()
      if (!text || event.data.already_streamed || event.data.reasoning_echo) return t
      // Interim prose becomes its own sealed text segment before the next tool.
      const sealed: Segment = { kind: 'text', text }
      return { ...t, segments: [...t.segments, sealed] }
    }
    case 'reasoning': {
      if (terminal) return stamped
      const t = live()
      const text = event.data.text ?? ''
      const titles = Array.isArray(event.data.titles) ? event.data.titles.filter((x) => x.trim()).slice(0, 8) : null
      return { ...t, reasoningText: t.reasoningText + text, reasoningTitles: titles ?? t.reasoningTitles, segments: appendReasoning(t.segments, text, titles) }
    }
    case 'tool': {
      if (terminal) return stamped
      if (event.data.name === 'clarify') return stamped
      const t = live()
      const id = toolIdFor(event.data, t, false)
      const existing = t.tools[id]
      const call: LiveToolCall = existing ?? { id, name: event.data.name ?? 'tool', args: event.data.args ?? {}, preview: event.data.preview ?? null, done: false, isError: false, duration: null, costUsd: null, result: null, startedAt: event.data.timestamp ?? now }
      const tools = { ...t.tools, [id]: existing ? { ...existing, args: event.data.args ?? existing.args, preview: event.data.preview ?? existing.preview } : call }
      const toolOrder = existing ? t.toolOrder : [...t.toolOrder, id]
      const segments = existing ? t.segments : [...t.segments, { kind: 'tool' as const, toolId: id }]
      return { ...t, tools, toolOrder, segments }
    }
    case 'tool_complete': {
      if (terminal) return stamped
      if (event.data.name === 'clarify') return stamped
      const t = live()
      const id = toolIdFor(event.data, t, true)
      const existing = t.tools[id] ?? { id, name: event.data.name ?? 'tool', args: event.data.args ?? {}, preview: null, done: false, isError: false, duration: null, costUsd: null, result: null, startedAt: now }
      const call: LiveToolCall = { ...existing, done: true, isError: !!event.data.is_error, preview: event.data.preview ?? existing.preview, duration: event.data.duration ?? null, costUsd: event.data.cost_usd ?? null, result: event.data.result ?? event.data.output ?? existing.result, args: event.data.args ?? existing.args }
      const known = id in t.tools
      return { ...t, tools: { ...t.tools, [id]: call }, toolOrder: known ? t.toolOrder : [...t.toolOrder, id], segments: known ? t.segments : [...t.segments, { kind: 'tool', toolId: id }] }
    }
    case 'approval': {
      if (terminal) return stamped
      return { ...live(), approval: event.data }
    }
    case 'clarify': {
      if (terminal) return stamped
      return { ...live(), clarify: event.data as ClarifyPending }
    }
    case 'steer_consumed': {
      const id = event.data.steer_id ?? `${now}`
      if (stamped.steerConsumed.some((s) => s.id === id)) return stamped
      return { ...stamped, steerConsumed: [...stamped.steerConsumed, { id, text: event.data.text ?? '' }], pendingSteerLeftover: null }
    }
    case 'pending_steer_leftover':
      return { ...stamped, pendingSteerLeftover: event.data.text ?? null }
    case 'compressing':
      return { ...stamped, compression: { state: 'compressing', newSessionId: event.data.new_session_id ?? event.data.continuation_session_id ?? null } }
    case 'compressed':
      return { ...stamped, compression: { state: 'compressed', newSessionId: event.data.new_session_id ?? event.data.continuation_session_id ?? null } }
    case 'title':
    case 'title_status':
      return event.data.title ? { ...stamped, title: event.data.title } : stamped
    case 'warning':
      return { ...stamped, warning: event.data.message ?? event.data.type ?? 'warning' }
    case 'metering':
      return { ...stamped, usage: event.data.usage ?? stamped.usage, tps: event.data.tps_available === false ? stamped.tps : (event.data.tps ?? stamped.tps) }
    case 'context_status':
      return { ...stamped, contextStatus: { state: event.data.state, message: event.data.message } }
    case 'goal':
    case 'goal_continue':
      return { ...stamped, goal: event.data }
    case 'server_turn_started':
      return { ...stamped, turnId: event.data.turn_id ?? stamped.turnId, userMessageId: event.data.user_message_id === undefined ? stamped.userMessageId : String(event.data.user_message_id) }
    case 'done': {
      if (terminal) return stamped
      const session = event.data.session
      return { ...stamped, status: 'done', doneAt: now, usage: event.data.usage ?? stamped.usage, doneSession: session && typeof session === 'object' ? (session as Session) : null, approval: null, clarify: null }
    }
    case 'apperror':
    case 'error': {
      if (terminal) return stamped
      const type = event.data.type ?? 'error'
      const cancelled = type === 'cancelled' || type === 'interrupted'
      return {
        ...stamped,
        status: cancelled ? 'cancelled' : 'error',
        doneAt: now,
        error: cancelled ? null : { type, message: event.data.message ?? '', hint: event.data.hint, continuationSessionId: event.data.continuation_session_id ?? event.data.new_session_id },
        cancelledMessage: cancelled ? (event.data.message ?? '') : null,
        approval: null,
        clarify: null,
        streamEnded: true,
      }
    }
    case 'cancel': {
      if (terminal) return { ...stamped, streamEnded: true }
      return { ...stamped, status: 'cancelled', doneAt: now, cancelledMessage: '', approval: null, clarify: null, streamEnded: true }
    }
    case 'stream_end':
      return { ...stamped, streamEnded: true }
    case 'todo_state':
    case 'bg_task_complete':
    case 'state_saved':
    case 'hello':
    case 'initial':
    case 'events':
    case 'gateway_status':
    case 'sessions_changed':
      return stamped
  }
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'start': {
      const turn = { ...newTurn(action.sessionId, action.streamId, action.now), turnId: action.turnId, userMessageId: action.userMessageId, userText: action.userText, status: 'connecting' as const }
      return { turns: { ...state.turns, [action.sessionId]: turn } }
    }
    case 'attach': {
      const existing = state.turns[action.sessionId]
      if (existing?.streamId === action.streamId && existing && !isTerminal(existing.status)) {
        return { turns: { ...state.turns, [action.sessionId]: { ...existing, status: 'reconnecting', replayed: action.replay } } }
      }
      return { turns: { ...state.turns, [action.sessionId]: { ...newTurn(action.sessionId, action.streamId, action.now), status: 'connecting', replayed: action.replay } } }
    }
    case 'connection': {
      const turn = state.turns[action.sessionId]
      if (turn?.streamId !== action.streamId || !turn || isTerminal(turn.status)) return state
      const status: TurnStatus = action.status === 'open' ? (turn.status === 'connecting' || turn.status === 'reconnecting' ? 'streaming' : turn.status) : 'reconnecting'
      if (status === turn.status) return state
      return { turns: { ...state.turns, [action.sessionId]: { ...turn, status } } }
    }
    case 'event': {
      const turn = state.turns[action.sessionId]
      // Invariant 1: only the owning stream may mutate the turn.
      if (turn?.streamId !== action.streamId || !turn) return state
      const next = reduceTurn(turn, action)
      if (next === turn) return state
      return { turns: { ...state.turns, [action.sessionId]: next } }
    }
    case 'settle': {
      const turn = state.turns[action.sessionId]
      if (turn?.streamId !== action.streamId || !turn) return state
      if (!isTerminal(turn.status)) return { turns: { ...state.turns, [action.sessionId]: { ...turn, status: 'done', doneAt: turn.doneAt ?? Date.now(), doneSession: action.session ?? turn.doneSession, streamEnded: true, approval: null, clarify: null } } }
      return { turns: { ...state.turns, [action.sessionId]: { ...turn, doneSession: action.session ?? turn.doneSession, streamEnded: true } } }
    }
    case 'teardown': {
      if (!(action.sessionId in state.turns)) return state
      return { turns: Object.fromEntries(Object.entries(state.turns).filter(([k]) => k !== action.sessionId)) }
    }
    case 'clear_approval': {
      const turn = state.turns[action.sessionId]
      if (!turn?.approval) return state
      return { turns: { ...state.turns, [action.sessionId]: { ...turn, approval: null } } }
    }
    case 'clear_clarify': {
      const turn = state.turns[action.sessionId]
      if (!turn?.clarify) return state
      return { turns: { ...state.turns, [action.sessionId]: { ...turn, clarify: null } } }
    }
  }
}

/** Visible assistant prose for the live turn: text segments with tool-call XML removed. */
export function liveText(turn: LiveTurn): string {
  return turn.segments.filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text').map((s) => s.text).join('')
}
