/** Live turns and device-local send/Stop intent, kept outside the server-state query cache. */
import { useSyncExternalStore } from 'react'
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
/** Frames that settle or end a turn; everything else a stream sends waits for the next animation frame. */
const SETTLING_EVENTS: ReadonlySet<ChatEventName> = new Set(['done', 'error', 'apperror', 'cancel', 'compressed', 'stream_end'])

/** Notifies every subscriber now and drops a notification already waiting for the next frame. */
function notifyNow(): void {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
  publishedState = state
  for (const l of listeners) l()
}

/**
 * Applies the action at once, so synchronous readers of `getStreamState` stay current, but streaming frames commit
 * to React at most once per animation frame: several tokens can arrive within one frame. Settling frames and every
 * non-stream action notify immediately.
 */
export function dispatch(action: StreamAction): void {
  const next = streamReducer(state, action)
  if (next === state) return
  state = next
  if (action.type !== 'event' || SETTLING_EVENTS.has(action.event.event)) notifyNow()
  else frame ??= requestAnimationFrame(() => { frame = null; notifyNow() })
}

export function getStreamState(): StreamState {
  return state
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** React reads the last publication; unrelated renders cannot bypass streaming's frame boundary. */
export function useLiveTurn(sessionId: string | null): LiveTurn | null {
  const turn = () => sessionId ? publishedState.turns[sessionId] ?? null : null
  return useSyncExternalStore(subscribe, turn, turn)
}

export function resetStreamStoreForTests(): void {
  state = initialStreamState
  notifyNow()
}
