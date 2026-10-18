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
import type { AgentRuntimeMetadata } from '@maudecode/talaria-web-contracts'
import type { ChatEvent } from '../contracts/sse'
import type { ApprovalPending, Attachment, ClarifyPending, Session } from '../contracts'
import type { ConnectorOperationView } from '@maudecode/talaria-web-contracts'
import type { PendingSteer, RunStatus, RateLimitWait, ToolKind, ToolResultView } from '@maudecode/talaria-web-contracts'

export type TurnStatus = 'starting' | 'connecting' | 'streaming' | 'reconnecting' | 'done' | 'error' | 'cancelled'

export interface LiveToolCall {
  id: string
  name: string
  /** Server-derived display class and redacted label; an older server sends neither (`unknown`, no target). */
  kind: ToolKind
  target: string
  args: unknown
  preview: string | null
  done: boolean
  isError: boolean
  duration: number | null
  costUsd: number | null
  /** TAL-315: the server's result sections, from `tool_complete`. */
  resultView: ToolResultView | null
  startedAt: number
}

export type Segment =
  | { kind: 'text'; text: string; interim?: boolean }
  | { kind: 'reasoning'; text: string; titles: string[] }
  | { kind: 'tool'; toolId: string }
  /** A consumed steer, at the place the server will persist it: after the tool that had completed. */
  | { kind: 'steering'; steerId: string; text: string }

/**
 * TAL-425: a steer the Agent has not taken yet, as the server reports it (`steer_pending`, session `pending_steers`),
 * with the actions it allows. `sending`: this tab's steer before its POST returns, the only client-side state.
 */
export interface PendingSteerRow { steerId: string; text: string; state: 'sending' | PendingSteer['state']; actions: PendingSteer['actions'] }
const NO_STEER_ACTIONS: PendingSteer['actions'] = { edit: false, cancel: false, send_now: false }

export interface LiveTurn {
  sessionId: string
  streamId: string
  turnId: string | null
  userMessageId: string | null
  userText: string
  userAttachments: Attachment[]
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
  error: (AgentRuntimeMetadata & { condition?: string | undefined; type: string; message: string; hint?: string | undefined; continuationSessionId?: string | undefined }) | null
  cancelledMessage: string | null
  approval: ApprovalPending | null
  clarify: ClarifyPending | null
  /** TAL-818: the turn's open `manage_connections` card; the card reads the operation from the server from here on. */
  connectCard: ConnectorOperationView | null
  pendingSteers: PendingSteerRow[]
  /** Steers already taken or withdrawn: a replayed frame or a stale session never brings one back. */
  closedSteerIds: string[]
  /** TAL-1006: the open compression span's server start (ms), until `compressed` or the turn's end closes it. */
  compressionStartedAt: number | null
  /** TAL-821: the server's rate-limit wait while the Agent sits one out. */
  rateLimitWait: RateLimitWait | null
  runStatus: RunStatus | null
  title: string | null
  doneSession: Session | null
  terminalState?: string | undefined
  doneAt: number | null
  streamEnded: boolean
  goal: unknown
  replayed: boolean
  /** The turn renders the stream's whole output (started here, or attached with replay), so it stands in for rows the server persisted for it. */
  claimsPersistedRows: boolean
}

export type StreamAction =
  /** `serverStartedAt`: the server's `pending_started_at` (epoch seconds), which starts the turn clock. */
  | { type: 'start'; sessionId: string; streamId: string; turnId: string | null; userMessageId: string | null; userText: string; userAttachments?: Attachment[]; now: number; serverStartedAt?: number | null | undefined }
  /** `serverCompressionStartedAt`: the session's `compression_started_at`, an open span whose frames the attach may resume past. */
  | { type: 'attach'; sessionId: string; streamId: string; now: number; replay: boolean; serverStartedAt?: number | null | undefined; serverCompressionStartedAt?: number | null | undefined; serverRunStatus?: RunStatus | null | undefined }
  | { type: 'connection'; sessionId: string; streamId: string; status: 'open' | 'error' | 'reconnecting' }
  | { type: 'event'; sessionId: string; streamId: string; event: ChatEvent; lastEventId: string; now: number }
  | { type: 'settle'; sessionId: string; streamId: string; session: Session | null }
  | { type: 'teardown'; sessionId: string }
  | { type: 'clear_approval'; sessionId: string }
  | { type: 'clear_clarify'; sessionId: string }
  /** A steer this tab is sending: shown until the server reports it (or it is taken), dropped when refused. */
  | { type: 'steer_sending'; sessionId: string; steerId: string; text: string }
  | { type: 'steer_refused'; sessionId: string; steerId: string }
  /** The session's pending steers when this view attached; events keep them current from then on. */
  | { type: 'pending_steers'; sessionId: string; streamId: string; steers: PendingSteer[] }

export interface StreamState {
  turns: Record<string, LiveTurn>
}

export const initialStreamState: StreamState = { turns: {} }

const TERMINAL: ReadonlySet<TurnStatus> = new Set(['done', 'error', 'cancelled'])
/** A settled turn waits on nothing: its approval, clarification, connect card and compression go with it. */
const NO_PROMPTS = { approval: null, clarify: null, connectCard: null, compressionStartedAt: null, runStatus: null } as const

/** The settled session a terminal frame carries, which replaces the live view with the server's scenes. */
function sessionOf(data: unknown): Session | null {
  const session = data && typeof data === 'object' ? (data as { session?: unknown }).session : null
  return session && typeof session === 'object' ? (session as Session) : null
}

export function isTerminal(status: TurnStatus): boolean {
  return TERMINAL.has(status)
}

/** The server's run start in ms, clamped to this device's clock so a server clock ahead of it never holds the timer at
 *  0:00; `fallback` until the server reports a usable one. */
export function runStart(serverStartedAt: number | null | undefined, fallback: number, now: number): number {
  return serverStartedAt != null && serverStartedAt > 0 ? Math.min(serverStartedAt * 1000, now) : fallback
}

function newTurn(sessionId: string, streamId: string, now: number, serverStartedAt?: number | null): LiveTurn {
  return {
    sessionId, streamId, turnId: null, userMessageId: null, userText: '', userAttachments: [], startedAt: runStart(serverStartedAt, now, now), status: 'starting',
    segments: [], tools: {}, toolOrder: [], reasoningText: '', reasoningTitles: [], lastEventId: '', lastSeq: 0,
    usage: null, tps: null, contextStatus: null, warning: null, error: null, cancelledMessage: null, approval: null, clarify: null, connectCard: null,
    pendingSteers: [], closedSteerIds: [], compressionStartedAt: null, rateLimitWait: null, runStatus: null, title: null, doneSession: null, doneAt: null, streamEnded: false, goal: null, replayed: false, claimsPersistedRows: true,
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
  if (last?.kind === 'text' && !last.interim) return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }]
  return [...segments, { kind: 'text', text }]
}

function appendReasoning(segments: Segment[], text: string, titles: string[] | null): Segment[] {
  const last = segments[segments.length - 1]
  if (last?.kind === 'reasoning') return [...segments.slice(0, -1), { kind: 'reasoning', text: last.text + text, titles: titles ?? last.titles }]
  if (!text && !titles) return segments
  return [...segments, { kind: 'reasoning', text, titles: titles ?? [] }]
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
      const sealed: Segment = { kind: 'text', text, interim: true }
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
      const id = event.data.id
      const existing = t.tools[id]
      const call: LiveToolCall = existing ?? { id, name: event.data.name ?? 'tool', kind: event.data.kind ?? 'unknown', target: event.data.target ?? '', args: event.data.args ?? {}, preview: event.data.preview ?? null, done: false, isError: false, duration: null, costUsd: null, resultView: null, startedAt: event.data.timestamp ?? now }
      const tools = { ...t.tools, [id]: existing ? { ...existing, kind: event.data.kind ?? existing.kind, target: event.data.target ?? existing.target, args: event.data.args ?? existing.args, preview: event.data.preview ?? existing.preview } : call }
      const toolOrder = existing ? t.toolOrder : [...t.toolOrder, id]
      const segments = existing ? t.segments : [...t.segments, { kind: 'tool' as const, toolId: id }]
      return { ...t, tools, toolOrder, segments }
    }
    case 'tool_complete': {
      if (terminal) return stamped
      if (event.data.name === 'clarify') return stamped
      const t = live()
      const id = event.data.id
      const existing = t.tools[id] ?? { id, name: event.data.name ?? 'tool', kind: 'unknown', target: '', args: event.data.args ?? {}, preview: null, done: false, isError: false, duration: null, costUsd: null, resultView: null, startedAt: now }
      const call: LiveToolCall = { ...existing, kind: event.data.kind ?? existing.kind, target: event.data.target ?? existing.target, done: true, isError: !!event.data.is_error, preview: event.data.preview ?? existing.preview, duration: event.data.duration ?? null, costUsd: event.data.cost_usd ?? null, resultView: event.data.result_view ?? existing.resultView, args: event.data.args ?? existing.args }
      const known = id in t.tools
      return { ...t, tools: { ...t.tools, [id]: call }, toolOrder: known ? t.toolOrder : [...t.toolOrder, id], segments: known ? t.segments : [...t.segments, { kind: 'tool', toolId: id }] }
    }
    case 'approval': {
      if (terminal) return stamped
      return { ...live(), approval: event.data }
    }
    case 'approval_cleared':
      return stamped.approval ? { ...stamped, approval: null } : stamped
    case 'clarify': {
      if (terminal) return stamped
      return { ...live(), clarify: event.data as ClarifyPending }
    }
    case 'connect_card': {
      if (terminal) return stamped
      return { ...live(), connectCard: event.data }
    }
    case 'steer_consumed': {
      const id = event.data.steer_id ?? `${now}`
      if (stamped.segments.some((s) => s.kind === 'steering' && s.steerId === id)) return stamped
      const after = event.data.after_tool_call_id
      let at = after ? stamped.segments.findIndex((s) => s.kind === 'tool' && s.toolId === after) + 1 : 0
      // Steers the Agent took at the same point keep the server's consumption order.
      while (stamped.segments[at]?.kind === 'steering') at += 1
      const segment: Segment = { kind: 'steering', steerId: id, text: event.data.text ?? '' }
      return closeSteer({ ...stamped, segments: [...stamped.segments.slice(0, at), segment, ...stamped.segments.slice(at)] }, id)
    }
    case 'steer_pending':
      return upsertSteer(stamped, { steerId: event.data.steer_id, text: event.data.text, state: event.data.state, actions: event.data.actions })
    case 'steer_withdrawn':
      return event.data.steer_id ? closeSteer(stamped, event.data.steer_id) : stamped
    case 'compressing':
      // A heartbeat repeats the open span's start, so the first frame's stands; a frame without one is timed from its arrival.
      return terminal ? stamped : { ...stamped, compressionStartedAt: stamped.compressionStartedAt ?? runStart(event.data.started_at, now, now) }
    case 'compressed':
      return { ...stamped, compressionStartedAt: null }
    case 'run_status':
      return terminal ? stamped : { ...stamped, runStatus: event.data.status }
    case 'rate_limit_wait':
      return { ...stamped, rateLimitWait: event.data.wait }
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
      // ponytail: old-journal fallback — a `done` recorded before terminal_state shipped completed its turn.
      return { ...stamped, status: 'done', terminalState: event.data.terminal_state ?? 'completed', doneAt: now, usage: event.data.usage ?? stamped.usage, doneSession: session && typeof session === 'object' ? (session as Session) : null, ...NO_PROMPTS }
    }
    case 'apperror':
    case 'error': {
      if (terminal) return stamped
      const type = event.data.type ?? 'error'
      const terminalState = event.data.terminal_state ?? 'error'
      const cancelled = terminalState === 'cancelled' || terminalState === 'interrupted'
      return {
        ...stamped,
        status: cancelled ? 'cancelled' : 'error',
        terminalState,
        doneAt: now,
        error: cancelled ? null : { condition: event.data.condition, agent_runtime_reason: event.data.agent_runtime_reason, agent_update_state: event.data.agent_update_state, retryable: event.data.retryable, restart_scheduled: event.data.restart_scheduled, type, message: event.data.message ?? '', hint: event.data.hint, continuationSessionId: event.data.continuation_session_id ?? event.data.new_session_id },
        cancelledMessage: cancelled ? (event.data.message ?? '') : null,
        doneSession: sessionOf(event.data),
        ...NO_PROMPTS,
        streamEnded: true,
      }
    }
    case 'cancel': {
      if (terminal) return { ...stamped, streamEnded: true }
      return { ...stamped, status: 'cancelled', terminalState: event.data.terminal_state, doneAt: now, cancelledMessage: '', doneSession: sessionOf(event.data), ...NO_PROMPTS, streamEnded: true }
    }
    case 'session_snapshot':
      if (terminal) return stamped
      return { ...newTurn(turn.sessionId, turn.streamId, now), status: 'streaming', lastSeq: stamped.lastSeq, lastEventId: stamped.lastEventId, claimsPersistedRows: event.data.replay_gap !== true, warning: event.data.replay_gap ? 'owner_replay_gap' : null }
    case 'stream_end':
      return { ...stamped, streamEnded: true }
    case 'todo_state':
    case 'notices':
    case 'session_goal':
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
      const turn = { ...newTurn(action.sessionId, action.streamId, action.now, action.serverStartedAt), turnId: action.turnId, userMessageId: action.userMessageId, userText: action.userText, userAttachments: action.userAttachments ?? [], status: 'connecting' as const }
      return { turns: { ...state.turns, [action.sessionId]: turn } }
    }
    case 'attach': {
      const existing = state.turns[action.sessionId]
      const span = (known: number | null): number | null => known ?? (action.serverCompressionStartedAt ? runStart(action.serverCompressionStartedAt, action.now, action.now) : null)
      if (existing?.streamId === action.streamId && existing && !isTerminal(existing.status)) {
        // The retained cursor replays missed status frames; a cached session must not replace consumed frames.
        const runStatus = (action.replay && existing.lastSeq > 0) || action.serverRunStatus === undefined ? existing.runStatus : action.serverRunStatus
        return { turns: { ...state.turns, [action.sessionId]: { ...existing, status: 'reconnecting', replayed: action.replay, startedAt: runStart(action.serverStartedAt, existing.startedAt, action.now), compressionStartedAt: span(existing.compressionStartedAt), runStatus } } }
      }
      return { turns: { ...state.turns, [action.sessionId]: { ...newTurn(action.sessionId, action.streamId, action.now, action.serverStartedAt), status: 'connecting', replayed: action.replay, claimsPersistedRows: action.replay, compressionStartedAt: span(null), runStatus: action.serverRunStatus ?? null } } }
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
      if (!isTerminal(turn.status)) return { turns: { ...state.turns, [action.sessionId]: { ...turn, status: 'done', doneAt: turn.doneAt ?? Date.now(), doneSession: action.session ?? turn.doneSession, streamEnded: true, ...NO_PROMPTS } } }
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
    case 'steer_sending': {
      const turn = state.turns[action.sessionId]
      if (!turn || turn.closedSteerIds.includes(action.steerId) || turn.pendingSteers.some((p) => p.steerId === action.steerId)) return state
      return { turns: { ...state.turns, [action.sessionId]: { ...turn, pendingSteers: [...turn.pendingSteers, { steerId: action.steerId, text: action.text, state: 'sending', actions: NO_STEER_ACTIONS }] } } }
    }
    case 'steer_refused': {
      const turn = state.turns[action.sessionId]
      if (!turn) return state
      return { turns: { ...state.turns, [action.sessionId]: { ...turn, pendingSteers: turn.pendingSteers.filter((p) => p.steerId !== action.steerId) } } }
    }
    case 'pending_steers': {
      const turn = state.turns[action.sessionId]
      if (turn?.streamId !== action.streamId) return state
      const known = new Set([...turn.closedSteerIds, ...turn.pendingSteers.map((p) => p.steerId)])
      const added = action.steers.filter((p) => !known.has(p.steer_id)).map((p): PendingSteerRow => ({ steerId: p.steer_id, text: p.text, state: p.state, actions: p.actions }))
      return added.length ? { turns: { ...state.turns, [action.sessionId]: { ...turn, pendingSteers: [...turn.pendingSteers, ...added] } } } : state
    }
  }
}

/** A server report of a pending steer: it goes last (the server's order), unless it was already taken or withdrawn. */
function upsertSteer(turn: LiveTurn, row: PendingSteerRow): LiveTurn {
  if (turn.closedSteerIds.includes(row.steerId)) return turn
  return { ...turn, pendingSteers: [...turn.pendingSteers.filter((p) => p.steerId !== row.steerId), row] }
}

function closeSteer(turn: LiveTurn, steerId: string): LiveTurn {
  return { ...turn, pendingSteers: turn.pendingSteers.filter((p) => p.steerId !== steerId), closedSteerIds: [...turn.closedSteerIds, steerId] }
}

/** Visible assistant prose for the live turn: text segments with tool-call XML removed. */
export function liveText(turn: LiveTurn): string {
  return turn.segments.filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text').map((s) => s.text).join('')
}
