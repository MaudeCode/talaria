/** Live turns and device-local send/Stop intent, kept outside the server-state query cache. */
import { useSyncExternalStore } from 'react'
import { initialStreamState, streamReducer, type LiveTurn, type StreamAction, type StreamState } from './reducer'
import type { StartTurnInput } from './connection'
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
  for (const l of listeners) l()
}
export function clearTurnIntents(): void {
  intents = {}
  for (const l of listeners) l()
}
export function useTurnIntent(sessionId: string | null): TurnIntent {
  return useSyncExternalStore(subscribe, () => sessionId ? getTurnIntent(sessionId) : emptyIntent, () => emptyIntent)
}

let state: StreamState = initialStreamState
const listeners = new Set<() => void>()

export function dispatch(action: StreamAction): void {
  const next = streamReducer(state, action)
  if (next === state) return
  state = next
  for (const l of listeners) l()
}

export function getStreamState(): StreamState {
  return state
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLiveTurn(sessionId: string | null): LiveTurn | null {
  const s = useSyncExternalStore(subscribe, getStreamState, getStreamState)
  return sessionId ? s.turns[sessionId] ?? null : null
}

export function useAllLiveTurns(): Record<string, LiveTurn> {
  return useSyncExternalStore(subscribe, getStreamState, getStreamState).turns
}

export function resetStreamStoreForTests(): void {
  state = initialStreamState
  for (const l of listeners) l()
}
