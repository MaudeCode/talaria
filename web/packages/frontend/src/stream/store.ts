/** Live turns and device-local send/Stop intent, kept outside the server-state query cache. */
import { useMemo, useSyncExternalStore } from 'react'
import { initialStreamState, streamReducer, type LiveTurn, type StreamAction, type StreamState } from './reducer'
import type { StartTurnInput } from './connection'
import type { ChatEventName } from '../contracts/sse'
import type { Attachment } from '../contracts'
import type { PendingFile } from '../features/composer/Attachments'

/** Device-local intent only; admission, transcript order and worker release still come from the server. */
export interface TurnIntent {
  send?: { text: string; attachments: Attachment[]; request: StartTurnInput['request']; previousStreamId: string | undefined; queueId: string | undefined; files?: PendingFile[]; recover?: boolean; error?: string; uncertain?: boolean } | undefined
  stop?: { streamId: string; failed: boolean } | undefined
}
const emptyIntent: TurnIntent = {}
let intents: Record<string, TurnIntent> = {}
export const getTurnIntent = (sessionId: string): TurnIntent => intents[sessionId] ?? emptyIntent
export function setTurnIntent(sessionId: string, next: TurnIntent): void {
  intents = { ...intents, [sessionId]: next }
  if (!next.send && !next.stop) intents = Object.fromEntries(Object.entries(intents).filter(([sid]) => sid !== sessionId))
  notifyNow()
}
export function clearTurnIntents(): void {
  intents = {}
  notifyNow()
}
export function useTurnIntent(sessionId: string | null): TurnIntent {
  return useSyncExternalStore(subscribe, () => sessionId ? getTurnIntent(sessionId) : emptyIntent, () => emptyIntent)
}

let state: StreamState = initialStreamState
let publishedState: StreamState = state
const listeners = new Set<() => void>()
let frame: number | null = null
let publication: ReturnType<typeof setTimeout> | null = null
/** Frames that settle or end a turn; everything else a stream sends waits for the next animation frame. */
const SETTLING_EVENTS: ReadonlySet<ChatEventName> = new Set(['done', 'error', 'apperror', 'cancel', 'compressed', 'stream_end'])

/** Notifies every subscriber now and drops a notification already waiting for the next frame. */
function notifyNow(): void {
  if (frame !== null) cancelAnimationFrame(frame)
  if (publication !== null) clearTimeout(publication)
  frame = null
  publication = null
  publishedState = state
  for (const l of listeners) l()
}

/**
 * Applies the action at once, so synchronous readers of `getStreamState` stay current, but streaming frames commit
 * to React at most once per animation frame: several tokens can arrive within one frame. Publication yields out of
 * the rendering callback so synchronous React work does not lengthen that frame's layout and paint task.
 * Settling frames and every non-stream action notify immediately, cancelling either pending stage.
 */
export function dispatch(action: StreamAction): void {
  const next = streamReducer(state, action)
  if (next === state) return
  state = next
  if (action.type !== 'event' || SETTLING_EVENTS.has(action.event.event)) notifyNow()
  else frame ??= requestAnimationFrame(() => {
    publication = setTimeout(() => { frame = null; publication = null; notifyNow() }, 0)
  })
}

export function getStreamState(): StreamState {
  return state
}

/** Sidebar echoes can follow a terminal frame; reuse the reducer's bounded, context-owned arrival timestamp. */
export function hasRecentTerminalSession(sessionId: string): boolean {
  const turn = state.turns[sessionId]
  return !!turn?.doneSession && turn.doneSession.session_id === sessionId && Array.isArray(turn.doneSession.messages) && turn.doneAt !== null && Date.now() - turn.doneAt < 5_000
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Each subscriber owns this cache; the published store stays untouched. */
function createTurnSnapshot(sessionId: string | null, equal: (previous: LiveTurn | null, next: LiveTurn | null) => boolean) {
  let previous: LiveTurn | null = null
  return () => {
    const next = sessionId ? publishedState.turns[sessionId] ?? null : null
    if (!equal(previous, next)) previous = next
    return previous
  }
}

/** React reads the last publication; a subscriber can retain its snapshot while irrelevant fields change. */
export function useLiveTurn(sessionId: string | null, equal: (previous: LiveTurn | null, next: LiveTurn | null) => boolean = Object.is): LiveTurn | null {
  const turn = useMemo(() => createTurnSnapshot(sessionId, equal), [sessionId, equal])
  return useSyncExternalStore(subscribe, turn, turn)
}

export function resetStreamStoreForTests(): void {
  state = initialStreamState
  notifyNow()
}
