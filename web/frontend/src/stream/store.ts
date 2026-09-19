/** Reducer-backed external store for live chat turns (never routed through TanStack Query). */
import { useSyncExternalStore } from 'react'
import { initialStreamState, streamReducer, type LiveTurn, type StreamAction, type StreamState } from './reducer'

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
