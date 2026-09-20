/**
 * Owns every chat EventSource. One live connection per session; the reducer
 * owns the projected state. Side effects that cross module boundaries (Query
 * cache, todo store, toasts) are applied here from typed events only.
 */
import type { QueryClient } from '@tanstack/react-query'
import * as api from '../api/endpoints'
import { openChatStream, SSE_CLOSED, type SseHandle } from '../api/sse'
import { keys } from '../api/queryKeys'
import type { ChatEvent } from '../contracts/sse'
import type { ChatStartRequest, Session } from '../contracts'
import { RELAY_CLOSE_EVENTS } from '../contracts/sse'
import { dispatch, getStreamState } from './store'
import { isTerminal } from './reducer'
import { setTodoState } from '../features/todos/todoStore'
import { showToast } from '../features/toast/toast'
import { isApiError } from '../contracts/common'

interface Live {
  sessionId: string
  streamId: string
  handle: SseHandle
  reconnectTimer: number | null
  reconnectAttempts: number
  lastSeq: number
  lastEventId: string
  settling: boolean
}

const live = new Map<string, Live>()
let queryClient: QueryClient | null = null
const hooks: { onCompressed?: (sessionId: string, newSessionId: string) => void } = {}

export function configureStream(opts: { queryClient: QueryClient; onCompressed?: (sessionId: string, newSessionId: string) => void }): void {
  queryClient = opts.queryClient
  if (opts.onCompressed) hooks.onCompressed = opts.onCompressed
}

function invalidateSession(sessionId: string): void {
  if (!queryClient) return
  void queryClient.invalidateQueries({ queryKey: keys.sessions.detail(sessionId) })
  void queryClient.invalidateQueries({ queryKey: keys.sessions.all })
}

function applySideEffects(sessionId: string, event: ChatEvent): void {
  switch (event.event) {
    case 'todo_state':
      setTodoState(sessionId, event.data)
      break
    case 'done': {
      const session = event.data.session
      if (queryClient && session && typeof session === 'object' && 'session_id' in session) {
        queryClient.setQueryData(keys.sessions.detail(sessionId), { session: session as Session })
      }
      invalidateSession(sessionId)
      break
    }
    case 'title':
      if (event.data.title && queryClient) void queryClient.invalidateQueries({ queryKey: keys.sessions.all })
      break
    case 'bg_task_complete':
      showToast(event.data.title ? `${event.data.title}: ${event.data.status ?? 'done'}` : (event.data.summary ?? 'Background task complete'))
      if (event.data.task_id) void api.ackBackgroundTask(sessionId, event.data.task_id).catch(() => undefined)
      break
    case 'compressed': {
      const next = event.data.new_session_id ?? event.data.continuation_session_id
      if (next && hooks.onCompressed) hooks.onCompressed(sessionId, next)
      invalidateSession(sessionId)
      break
    }
    case 'apperror':
    case 'error':
    case 'cancel':
      invalidateSession(sessionId)
      break
    default:
      break
  }
}

function closeLive(sessionId: string): void {
  const entry = live.get(sessionId)
  if (!entry) return
  if (entry.reconnectTimer) window.clearTimeout(entry.reconnectTimer)
  entry.handle.close()
  live.delete(sessionId)
}

function open(sessionId: string, streamId: string, replay: { afterSeq: number; afterEventId: string } | null): void {
  closeLive(sessionId)
  const entry: Live = { sessionId, streamId, handle: { close: () => undefined, readyState: () => SSE_CLOSED }, reconnectTimer: null, reconnectAttempts: 0, lastSeq: replay?.afterSeq ?? 0, lastEventId: replay?.afterEventId ?? '', settling: false }
  live.set(sessionId, entry)
  entry.handle = openChatStream(streamId, replay, {
    onOpen: () => {
      entry.reconnectAttempts = 0
      dispatch({ type: 'connection', sessionId, streamId, status: 'open' })
    },
    onEvent: (event, lastEventId) => {
      if (live.get(sessionId) !== entry) return
      if (lastEventId) {
        entry.lastEventId = lastEventId
        const idx = lastEventId.lastIndexOf(':')
        const seq = idx > 0 ? Number(lastEventId.slice(idx + 1)) : NaN
        if (Number.isFinite(seq) && lastEventId.slice(0, idx) === streamId) entry.lastSeq = Math.max(entry.lastSeq, seq)
      }
      dispatch({ type: 'event', sessionId, streamId, event, lastEventId, now: Date.now() })
      applySideEffects(sessionId, event)
      if (RELAY_CLOSE_EVENTS.has(event.event)) {
        const turn = getStreamState().turns[sessionId]
        closeLive(sessionId)
        if (event.event === 'stream_end' && turn && !isTerminal(turn.status)) void settleFromServer(sessionId, streamId)
      }
    },
    onError: (readyState) => {
      if (live.get(sessionId) !== entry) return
      const turn = getStreamState().turns[sessionId]
      if (!turn || isTerminal(turn.status)) { closeLive(sessionId); return }
      dispatch({ type: 'connection', sessionId, streamId, status: 'error' })
      if (readyState === SSE_CLOSED) scheduleReconnect(entry)
    },
  })
}

function scheduleReconnect(entry: Live): void {
  if (entry.reconnectTimer) return
  const delay = Math.min(15_000, 500 * 2 ** Math.min(entry.reconnectAttempts, 5))
  entry.reconnectAttempts += 1
  entry.reconnectTimer = window.setTimeout(() => {
    entry.reconnectTimer = null
    if (live.get(entry.sessionId) !== entry) return
    void (async () => {
      try {
        const st = await api.fetchStreamStatus(entry.streamId)
        if (live.get(entry.sessionId) !== entry) return
        if (st.active || st.replay_available) {
          dispatch({ type: 'attach', sessionId: entry.sessionId, streamId: entry.streamId, now: Date.now(), replay: true })
          open(entry.sessionId, entry.streamId, { afterSeq: entry.lastSeq, afterEventId: entry.lastEventId })
          return
        }
        await settleFromServer(entry.sessionId, entry.streamId)
      } catch (error) {
        if (isApiError(error) && error.kind === 'unauthorized') { closeLive(entry.sessionId); return }
        if (live.get(entry.sessionId) === entry) scheduleReconnect(entry)
      }
    })()
  }, delay)
}

/** `stream_end` without `done`, or a stream that is gone: converge on the persisted session. */
async function settleFromServer(sessionId: string, streamId: string): Promise<void> {
  try {
    const { session } = await api.fetchSession(sessionId, { messages: true })
    if (session.active_stream_id && session.active_stream_id === streamId) {
      // Server still reports the run as active; try again shortly.
      const st = await api.fetchStreamStatus(streamId).catch(() => null)
      if (st?.active) {
        dispatch({ type: 'attach', sessionId, streamId, now: Date.now(), replay: true })
        open(sessionId, streamId, { afterSeq: 0, afterEventId: '' })
        return
      }
    }
    if (queryClient) queryClient.setQueryData(keys.sessions.detail(sessionId), { session })
    dispatch({ type: 'settle', sessionId, streamId, session })
    invalidateSession(sessionId)
  } catch (error) {
    dispatch({ type: 'settle', sessionId, streamId, session: null })
    if (!(isApiError(error) && error.kind === 'aborted')) invalidateSession(sessionId)
  } finally {
    closeLive(sessionId)
  }
}

export interface StartTurnInput { sessionId: string; message: string; request: Omit<ChatStartRequest, 'session_id' | 'message'> }

/** Send a turn: POST /api/chat/start, adopt the server turn identity, open the stream. */
export async function startTurn(input: StartTurnInput) {
  const res = await api.startChat({ session_id: input.sessionId, message: input.message, ...input.request })
  dispatch({ type: 'start', sessionId: input.sessionId, streamId: res.stream_id, turnId: res.turn_id ?? null, userMessageId: res.user_message_id === undefined || res.user_message_id === null ? null : String(res.user_message_id), userText: input.message, now: Date.now() })
  open(input.sessionId, res.stream_id, null)
  invalidateSession(input.sessionId)
  return res
}

/** Re-attach to a run the server reports as active (hard refresh, tab restore, sidebar switch). */
export async function attachToStream(sessionId: string, streamId: string): Promise<void> {
  const existing = live.get(sessionId)
  if (existing?.streamId === streamId && existing.handle.readyState() !== SSE_CLOSED) return
  const st = await api.fetchStreamStatus(streamId)
  if (!st.active && !st.replay_available) {
    dispatch({ type: 'settle', sessionId, streamId, session: null })
    return
  }
  dispatch({ type: 'attach', sessionId, streamId, now: Date.now(), replay: true })
  open(sessionId, streamId, { afterSeq: existing?.lastSeq ?? 0, afterEventId: existing?.lastEventId ?? '' })
}

/** Explicit user stop: backend cancel; the terminal `cancel` event settles the turn. */
export async function cancelTurn(sessionId: string): Promise<boolean> {
  const turn = getStreamState().turns[sessionId]
  if (!turn || isTerminal(turn.status)) return false
  try {
    const res = await api.cancelChat(turn.streamId)
    if (res.cancelled === false) {
      dispatch({ type: 'settle', sessionId, streamId: turn.streamId, session: null })
      closeLive(sessionId)
      showToast('Stream is no longer active', 2000)
    }
    return true
  } catch {
    return false
  }
}

/** Passive lifecycle exit (session switch, unmount, profile change): release the transport only. */
export function teardown(sessionId: string): void {
  closeLive(sessionId)
  dispatch({ type: 'teardown', sessionId })
}

export function teardownAll(): void {
  for (const sid of [...live.keys()]) teardown(sid)
}

export function hasLiveConnection(sessionId: string): boolean {
  const entry = live.get(sessionId)
  return !!entry && entry.handle.readyState() !== SSE_CLOSED
}

export function resetConnectionsForTests(): void {
  for (const sid of [...live.keys()]) closeLive(sid)
  queryClient = null
}
