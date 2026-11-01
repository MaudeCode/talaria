/**
 * Owns every chat EventSource. One live connection per session; the reducer
 * owns the projected state. Side effects that cross module boundaries (Query
 * cache, toasts) are applied here from typed events only.
 */
import { useSyncExternalStore } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import * as api from '../api/endpoints'
import { openChatStream, SSE_CLOSED, type SseHandle } from '../api/sse'
import { keys } from '../api/queryKeys'
import { invalidateSessionQueries } from '../api/sessionQueries'
import type { ChatEvent } from '../contracts/sse'
import type { ChatStartRequest, ChatStartResponse, Session, Attachment } from '../contracts'
import { forgetOwnSteer, resetComposerReturns, returnStoppedSteer } from '../features/composer/composerReturn'
import { resetStagedFiles } from '../features/composer/useDraft'
import { RELAY_CLOSE_EVENTS } from '../contracts/sse'
import { clearTurnIntents, dispatch, getStreamState, getTurnIntent, setTurnIntent } from './store'
import { isTerminal } from './reducer'
import { showErrorToast } from '../features/toast/errorToast'
import { m } from '../paraglide/messages.js'
import type { PendingFile } from '../features/composer/Attachments'
import { endFirstSend, getFirstSend } from '../features/chat/firstSend'
import { isApiError } from '../contracts/common'

interface Replay { afterSeq: number; afterEventId: string }

interface Live {
  sessionId: string
  streamId: string
  handle: SseHandle
  reconnectTimer: number | null
  reconnectAttempts: number
  owner: object
}

let context = {}
const contextListeners = new Set<() => void>()
const subscribeStreamContext = (listener: () => void): (() => void) => { contextListeners.add(listener); return () => { contextListeners.delete(listener) } }
/** Changes whenever auth, profile or server context is discarded. */
export const getStreamContext = (): object => context
/** The stream context for render: re-renders on change, where a render-time `getStreamContext()` read would go stale under the React Compiler. */
export const useStreamContext = (): object => useSyncExternalStore(subscribeStreamContext, getStreamContext, getStreamContext)
const starts = new Map<string, { owner: object; promise: Promise<ChatStartResponse> }>()
const stops = new Map<string, { owner: object; promise: Promise<boolean> }>()

const live = new Map<string, Live>()
const owners = new Map<string, object>()
const attaching = new Map<string, { streamId: string; promise: Promise<void> }>()
// Inactive turns are one display/cursor unit, evicted oldest first within the boot snapshot's size budget.
const retained = new Map<string, number>()
const MAX_RETAINED_TURNS = 20
const MAX_RETAINED_SIZE = 2_000_000
let queryClient: QueryClient | null = null
const hooks: { onCompressed?: (sessionId: string, newSessionId: string) => void } = {}

export function configureStream(opts: { queryClient: QueryClient; onCompressed?: (sessionId: string, newSessionId: string) => void }): void {
  if (queryClient && queryClient !== opts.queryClient) teardownAll()
  queryClient = opts.queryClient
  if (opts.onCompressed) hooks.onCompressed = opts.onCompressed
}

function invalidateSession(sessionId: string, mode: 'all' | 'settled' | 'started' = 'all'): void {
  if (!queryClient) return
  if (mode === 'started') {
    void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] })
    void queryClient.invalidateQueries({ queryKey: keys.sessions.status(sessionId) })
    return
  }
  void invalidateSessionQueries(queryClient, sessionId, { detail: mode !== 'settled' })
}

function applySideEffects(sessionId: string, event: ChatEvent): void {
  switch (event.event) {
    case 'session_snapshot':
      queryClient?.setQueryData(keys.sessions.detail(sessionId), { session: event.data.session })
      break
    case 'todo_state':
      queryClient?.setQueryData<{ session: Session }>(keys.sessions.detail(sessionId), (old) => old ? { ...old, session: { ...old.session, todo_state: event.data } } : old)
      break
    // TAL-425: a Stop gives a pending steer's text back to the tab that sent it.
    case 'steer_withdrawn':
      if (event.data.reason === 'stopped') returnStoppedSteer(sessionId, event.data.steer_id, event.data.text)
      else if (event.data.steer_id) forgetOwnSteer(event.data.steer_id)
      break
    case 'steer_consumed':
      if (event.data.steer_id) forgetOwnSteer(event.data.steer_id)
      break
    case 'done':
    case 'apperror':
    case 'error':
    case 'cancel': {
      // Every terminal frame carries the settled session; its scenes replace the live turn at once.
      const session = 'session' in event.data ? event.data.session : undefined
      const settled = !!session && typeof session === 'object' && 'session_id' in session && session.session_id === sessionId && 'messages' in session && Array.isArray(session.messages)
      if (queryClient && settled) {
        // A read started before settlement must not replace this authoritative snapshot when it answers later.
        void queryClient.cancelQueries({ queryKey: keys.sessions.detail(sessionId) })
        queryClient.setQueryData(keys.sessions.detail(sessionId), { session: session as Session })
      }
      invalidateSession(sessionId, settled ? 'settled' : 'all')
      break
    }
    // TAL-803: the session's notice list changed; the cached session shows the new one until its next load.
    case 'notices':
      queryClient?.setQueryData<{ session: Session }>(keys.sessions.detail(sessionId), (old) => (old ? { ...old, session: { ...old.session, notices: event.data.notices } } : old))
      break
    // TAL-808: the standing goal changed; the cached session shows the new one until its next load.
    case 'session_goal':
      queryClient?.setQueryData<{ session: Session }>(keys.sessions.detail(sessionId), (old) => (old ? { ...old, session: { ...old.session, goal: event.data.goal } } : old))
      break
    case 'title': {
      const title = event.data.title
      if (title && queryClient) {
        queryClient.setQueryData<{ session: Session }>(keys.sessions.detail(sessionId), (old) => old ? { ...old, session: { ...old.session, title } } : old)
        void invalidateSessionQueries(queryClient, sessionId, { detail: false })
      }
      break
    }
    case 'bg_task_complete':
      // TAL-372: the finished work is a server record; the background card and the chat show it, never a toast.
      if (queryClient) void queryClient.invalidateQueries({ queryKey: keys.background(sessionId) })
      break
    case 'compressed': {
      const next = event.data.new_session_id ?? event.data.continuation_session_id
      if (next && hooks.onCompressed) hooks.onCompressed(sessionId, next)
      invalidateSession(sessionId)
      break
    }
    default:
      break
  }
}

function closeLive(sessionId: string): void {
  const entry = live.get(sessionId)
  if (!entry) return
  if (entry.reconnectTimer) window.clearTimeout(entry.reconnectTimer)
  live.delete(sessionId)
  entry.handle.close()
}

function open(sessionId: string, streamId: string, replay: Replay | null, owner: object): void {
  closeLive(sessionId)
  const entry: Live = { sessionId, streamId, handle: { close: () => undefined, readyState: () => SSE_CLOSED }, reconnectTimer: null, reconnectAttempts: 0, owner }
  live.set(sessionId, entry)
  entry.handle = openChatStream(streamId, replay, {
    onOpen: () => {
      if (live.get(sessionId) !== entry) return
      entry.reconnectAttempts = 0
      dispatch({ type: 'connection', sessionId, streamId, status: 'open' })
    },
    onEvent: (event, lastEventId) => {
      if (live.get(sessionId) !== entry) return
      dispatch({ type: 'event', sessionId, streamId, event, lastEventId, now: Date.now() })
      applySideEffects(sessionId, event)
      if (RELAY_CLOSE_EVENTS.has(event.event)) {
        const turn = getStreamState().turns[sessionId]
        closeLive(sessionId)
        if (event.event === 'stream_end' && turn && !isTerminal(turn.status)) void settleFromServer(sessionId, streamId, entry.owner)
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

/**
 * Where to resume `streamId`: this page's own cursor while its live turn holds that stream, else the session detail's
 * `transcript_seq` for that stream (its transcript holds nothing the journal delivers after it), else null — attach live
 * without replay. A cursor for another stream is never used.
 */
function resumeFrom(sessionId: string, streamId: string, transcriptSeq: Session['transcript_seq']): Replay | null {
  const turn = getStreamState().turns[sessionId]
  if (turn?.streamId === streamId && !isTerminal(turn.status)) return { afterSeq: turn.lastSeq, afterEventId: turn.lastEventId }
  if (transcriptSeq?.stream_id === streamId) return { afterSeq: transcriptSeq.seq, afterEventId: '' }
  return null
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
          open(entry.sessionId, entry.streamId, resumeFrom(entry.sessionId, entry.streamId, null), entry.owner)
          return
        }
        await settleFromServer(entry.sessionId, entry.streamId, entry.owner)
      } catch (error) {
        if (live.get(entry.sessionId) !== entry) return
        if (isApiError(error) && error.kind === 'unauthorized') { closeLive(entry.sessionId); return }
        if (live.get(entry.sessionId) === entry) scheduleReconnect(entry)
      }
    })()
  }, delay)
}

/** `stream_end` without `done`, or a stream that is gone: converge on the persisted session. */
async function settleFromServer(sessionId: string, streamId: string, owner: object): Promise<void> {
  if (owners.get(sessionId) !== owner) return
  closeLive(sessionId)
  try {
    const { session } = await api.fetchSession(sessionId, { messages: true })
    if (owners.get(sessionId) !== owner) return
    if (session.active_stream_id && session.active_stream_id === streamId) {
      // Server still reports the run as active; try again shortly.
      const st = await api.fetchStreamStatus(streamId).catch(() => null)
      if (owners.get(sessionId) !== owner) return
      if (st?.active) {
        const replay = resumeFrom(sessionId, streamId, session.transcript_seq)
        dispatch({ type: 'attach', sessionId, streamId, now: Date.now(), replay: replay !== null, serverStartedAt: session.pending_started_at, serverCompressionStartedAt: session.compression_started_at, serverRunStatus: session.run_status })
        open(sessionId, streamId, replay, owner)
        return
      }
    }
    if (queryClient) queryClient.setQueryData(keys.sessions.detail(sessionId), { session })
    dispatch({ type: 'settle', sessionId, streamId, session })
    invalidateSession(sessionId)
  } catch (error) {
    if (owners.get(sessionId) !== owner) return
    dispatch({ type: 'settle', sessionId, streamId, session: null })
    if (!(isApiError(error) && error.kind === 'aborted')) invalidateSession(sessionId)
  } finally {
    if (owners.get(sessionId) === owner && live.get(sessionId)?.owner !== owner) owners.delete(sessionId)
  }
}

export interface StartTurnInput { sessionId: string; message: string; request: Omit<ChatStartRequest, 'session_id' | 'message'> & { attachments?: Attachment[] }; files?: PendingFile[]; recover?: boolean; queueId?: string }

/** One admission per session; all callers share the same pending row and request. */
export function startTurn(input: StartTurnInput): Promise<ChatStartResponse> {
  const pending = starts.get(input.sessionId)
  if (pending) return pending.promise
  if (getTurnIntent(input.sessionId).send?.uncertain) return Promise.reject(new Error(m.composer_send_uncertain()))
  const owner = owners.get(input.sessionId) ?? {}
  const scope = context
  const client = queryClient
  const first = getFirstSend()
  owners.set(input.sessionId, owner)
  const send = { queueId: input.queueId, previousStreamId: getStreamState().turns[input.sessionId]?.streamId, text: input.message, attachments: input.request.attachments ?? [], request: input.request, ...(input.files ? { files: input.files } : {}), recover: input.recover ?? !!input.files }
  setTurnIntent(input.sessionId, { ...getTurnIntent(input.sessionId), send })
  const current = () => scope === context && getTurnIntent(input.sessionId).send === send
  let admitted = false
  const promise = (async () => {
    try {
      const res = await api.startChat({ session_id: input.sessionId, message: input.message, ...input.request })
      if (res.ok === false) throw new Error(res.reason ?? m.composer_send_refused())
      admitted = true
      if (!current()) return res
      if (res.owner_attachment && res.session && res.stream_id) {
        client?.setQueryData(keys.sessions.detail(input.sessionId), { session: res.session })
        invalidateSession(input.sessionId, 'started')
        await attachToStream(input.sessionId, res.stream_id, res.session)
        return res
      }
      if (res.stream_id && owners.get(input.sessionId) === owner) {
        const turn = getStreamState().turns[input.sessionId]
        // A session relay may already have delivered this turn's terminal snapshot before the POST returned.
        if (!(turn?.streamId === res.stream_id && isTerminal(turn.status))) adoptTurn(input.sessionId, input.message, res, input.request.attachments)
      }
      // Suppressed/no-stream admissions have no live row to take over the pending slot.
      if (!res.stream_id) {
        const result = res.session ? { session: res.session } : await api.fetchSession(input.sessionId, { messages: true })
        if (current()) {
          // FirstSend must retire while TurnIntent still owns the row; otherwise its fallback revives it after settlement.
          if (first?.sessionId === input.sessionId && getFirstSend() === first) endFirstSend()
          client?.setQueryData(keys.sessions.detail(input.sessionId), result)
          invalidateSession(input.sessionId, 'settled')
        }
      }
      return res
    } catch (error) {
      if (current()) {
        let uncertain = admitted || isApiError(error) && (error.kind !== 'http' || Boolean(error.body && typeof error.body === 'object' && 'outcome_unknown' in error.body && error.body.outcome_unknown === true))
        if (uncertain) {
          try {
            const result = await api.fetchSession(input.sessionId, { messages: true })
            if (!current()) throw error
            client?.setQueryData(keys.sessions.detail(input.sessionId), result)
            // An uncertain POST is never replayed. Reattach to authoritative execution if it exists.
            if (result.session.active_stream_id) {
              if (owners.get(input.sessionId) === owner) await attachToStream(input.sessionId, result.session.active_stream_id, result.session)
              // Observation alone cannot prove that this particular submission was admitted.
            }
            // Keep the intent blocked: an idle snapshot cannot prove a timed-out POST will not admit later.
          } catch { /* Keep the submitted payload until the outcome can be reconciled. */ }
          uncertain = true
        }
        if (!current()) throw error
        const intent = getTurnIntent(input.sessionId)
        if (intent.send && (input.files || input.recover || uncertain)) setTurnIntent(input.sessionId, { ...intent, send: { ...intent.send, error: error instanceof Error ? error.message : String(error), uncertain } })
      }
      throw error
    } finally {
      if (scope === context && starts.get(input.sessionId)?.owner === send) {
        starts.delete(input.sessionId)
        const intent = getTurnIntent(input.sessionId)
        if (!intent.send?.error) setTurnIntent(input.sessionId, { ...intent, send: undefined })
        if (owners.get(input.sessionId) === owner && !live.has(input.sessionId) && !attaching.has(input.sessionId)) owners.delete(input.sessionId)
      }
    }
  })()
  starts.set(input.sessionId, { owner: send, promise })
  return promise
}

/** Retry only a refused admission, using its authoritative prompt/files without cutting history again. */
export function retryPendingTurn(sessionId: string): Promise<ChatStartResponse> | undefined {
  const send = getTurnIntent(sessionId).send
  if (!send?.error || send.uncertain) return
  return startTurn({ sessionId, message: send.text, request: send.request, recover: true })
}

/** Follow a turn the server admitted for this message: from `chat.start`, or a steer it started as a turn (TAL-460). */
export function adoptTurn(sessionId: string, message: string, res: ChatStartResponse, attachments: Attachment[] = []): void {
  // A silent control message is admitted without a turn (`status: suppressed`).
  if (!res.stream_id) { invalidateSession(sessionId); return }
  teardown(sessionId)
  retained.delete(sessionId)
  const owner = {}
  owners.set(sessionId, owner)
  dispatch({ type: 'start', sessionId, streamId: res.stream_id, turnId: res.turn_id ?? null, userMessageId: res.user_message_id === undefined || res.user_message_id === null ? null : String(res.user_message_id), userText: message, userAttachments: attachments, now: Date.now(), serverStartedAt: res.pending_started_at })
  open(sessionId, res.stream_id, null, owner)
  invalidateSession(sessionId, 'started')
}

/** Re-attach to a run the server reports as active (hard refresh, tab restore, sidebar switch). */
export function attachToStream(sessionId: string, streamId: string, run: Pick<Session, 'transcript_seq' | 'pending_steers' | 'pending_started_at' | 'compression_started_at' | 'run_status'> = {}): Promise<void> {
  const existing = live.get(sessionId)
  if (existing?.streamId === streamId && existing.handle.readyState() !== SSE_CLOSED) return Promise.resolve()
  const pending = attaching.get(sessionId)
  if (pending?.streamId === streamId) return pending.promise
  if (getStreamState().turns[sessionId]?.streamId !== streamId) discardSession(sessionId, true)
  else teardown(sessionId)
  retained.delete(sessionId)
  const owner = {}
  owners.set(sessionId, owner)
  const promise = (async () => {
    const st = await api.fetchStreamStatus(streamId)
    if (owners.get(sessionId) !== owner) return
    if (!st.active && !st.replay_available) {
      await settleFromServer(sessionId, streamId, owner)
      return
    }
    const replay = resumeFrom(sessionId, streamId, run.transcript_seq ?? null)
    dispatch({ type: 'attach', sessionId, streamId, now: Date.now(), replay: replay !== null, serverStartedAt: run.pending_started_at, serverCompressionStartedAt: run.compression_started_at, serverRunStatus: run.run_status })
    dispatch({ type: 'pending_steers', sessionId, streamId, steers: run.pending_steers ?? [] })
    open(sessionId, streamId, replay, owner)
  })().finally(() => {
    if (attaching.get(sessionId)?.promise === promise) attaching.delete(sessionId)
    if (owners.get(sessionId) === owner && !live.has(sessionId)) owners.delete(sessionId)
  })
  attaching.set(sessionId, { streamId, promise })
  return promise
}

/** Explicit user stop: show intent immediately, then wait for authoritative worker release. */
export function cancelTurn(sessionId: string): Promise<boolean> {
  const pending = stops.get(sessionId)
  if (pending) return pending.promise
  const turn = getStreamState().turns[sessionId]
  const streamId = getTurnIntent(sessionId).stop?.streamId ?? (turn && !isTerminal(turn.status) ? turn.streamId : null)
  if (!streamId) return Promise.resolve(false)
  const scope = context
  const owner = owners.get(sessionId)
  const stop = { streamId, failed: false }
  setTurnIntent(sessionId, { ...getTurnIntent(sessionId), stop })
  const current = () => scope === context && getTurnIntent(sessionId).stop === stop
  const promise = (async () => {
    try {
      const response = await api.cancelChat(streamId)
      if (!response.ok) throw new Error(response.error ?? m.composer_stop_failed())
      if (!current() || (getStreamState().turns[sessionId] && getStreamState().turns[sessionId]?.streamId !== streamId)) return false
      // A terminal event or cancel acknowledgement is not worker-release proof.
      for (let attempt = 0; attempt < 360; attempt++) {
        if (!current()) return false
        const status = await api.fetchStreamStatus(streamId)
        if (!current() || (getStreamState().turns[sessionId] && getStreamState().turns[sessionId]?.streamId !== streamId)) return false
        if (!status.active && status.blocking_stream_id === null) {
          await settleFromServer(sessionId, streamId, owner ?? {})
          if (current()) { setTurnIntent(sessionId, { ...getTurnIntent(sessionId), stop: undefined }); invalidateSession(sessionId) }
          return true
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500))
      }
      throw new Error(m.composer_stop_failed())
    } catch (error) {
      if (current()) {
        setTurnIntent(sessionId, { ...getTurnIntent(sessionId), stop: { streamId, failed: true } })
        showErrorToast(error)
      }
      return false
    } finally {
      if (scope === context && stops.get(sessionId)?.owner === stop) {
        stops.delete(sessionId)
        if (getStreamState().turns[sessionId] && getStreamState().turns[sessionId]?.streamId !== streamId && getTurnIntent(sessionId).stop?.streamId === streamId) setTurnIntent(sessionId, { ...getTurnIntent(sessionId), stop: undefined })
      }
    }
  })()
  stops.set(sessionId, { owner: stop, promise })
  return promise
}

function suspend(sessionId: string): void {
  owners.delete(sessionId)
  attaching.delete(sessionId)
  closeLive(sessionId)
}

/** Passive navigation closes transport and invalidates pending work while retaining display and cursor together. */
export function teardown(sessionId: string): void {
  suspend(sessionId)
  retained.delete(sessionId)
  const turn = getStreamState().turns[sessionId]
  if (turn && !isTerminal(turn.status)) retained.set(sessionId, JSON.stringify(turn).length)
  else dispatch({ type: 'teardown', sessionId })
  let size = [...retained.values()].reduce((sum, n) => sum + n, 0)
  for (const [sid, bytes] of retained) {
    if (retained.size <= MAX_RETAINED_TURNS && size <= MAX_RETAINED_SIZE) break
    retained.delete(sid)
    dispatch({ type: 'teardown', sessionId: sid })
    size -= bytes
  }
}

/** Destructive lifecycle exit: deleted session, new context, or authoritative run replacement. */
export function discardSession(sessionId: string, preserveIntent = false): void {
  if (!preserveIntent) { starts.delete(sessionId); stops.delete(sessionId); setTurnIntent(sessionId, {}) }
  suspend(sessionId)
  retained.delete(sessionId)
  dispatch({ type: 'teardown', sessionId })
}

export function teardownAll(): void {
  context = {}
  for (const listener of contextListeners) listener()
  starts.clear()
  stops.clear()
  clearTurnIntents()
  endFirstSend()
  resetComposerReturns()
  resetStagedFiles()
  for (const sid of new Set([...owners.keys(), ...live.keys(), ...Object.keys(getStreamState().turns)])) discardSession(sid)
}

/** Apply a fresh detail only to the run that existed when its request began. */
export function reconcileSession(sessionId: string, session: Session, expectedStreamId: string | undefined): void {
  const turn = getStreamState().turns[sessionId]
  if (turn && !isTerminal(turn.status) && turn.streamId === expectedStreamId && session.active_stream_id !== turn.streamId) discardSession(sessionId, true)
}

export function hasLiveConnection(sessionId: string): boolean {
  const entry = live.get(sessionId)
  return !!entry && entry.handle.readyState() !== SSE_CLOSED
}

export function resetConnectionsForTests(): void {
  teardownAll()
  queryClient = null
  delete hooks.onCompressed
}
