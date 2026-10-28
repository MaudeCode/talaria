import { useSyncExternalStore, type SetStateAction } from 'react'
import type { z } from 'zod'
import { readPersisted, readPersistedJson, removePersisted, writePersistedJson } from '../../lib/persisted'
import { QueuedTurnsSchema, type QueuedTurnSchema } from '../../contracts/persisted'
import type { Session } from '../../contracts'

/** A message waiting for the live turn to settle. */
export type QueuedTurn = z.infer<typeof QueuedTurnSchema>

const key = (sid: string) => `hermes-queue:${sid}`
const read = (sid: string | null) => (sid ? readPersistedJson(key(sid), QueuedTurnsSchema) ?? [] : [])
const listeners = new Map<string, Set<() => void>>()

/** Keep native local state on the server's complete owner identity; wait for identity before loading it. */
export function composerStateId(session: Pick<Session, 'session_id' | 'composer_state_key' | 'owner_attachment'> | null): string | null {
  return session?.composer_state_key ?? (session && !session.owner_attachment ? session.session_id : null)
}

/**
 * The session's queued messages, kept on this device so a reload keeps them (TAL-562). Other tabs on the same session
 * follow each change, so a message one tab sends never stays queued in another.
 */
export function useQueuedTurns(sessionId: string | null) {
  const subscribe = (changed: () => void) => {
    if (!sessionId) return () => undefined
    const subscribed = listeners.get(sessionId) ?? new Set<() => void>()
    subscribed.add(changed)
    listeners.set(sessionId, subscribed)
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === key(sessionId)) changed() }
    window.addEventListener('storage', onStorage)
    return () => {
      subscribed.delete(changed)
      if (subscribed.size === 0) listeners.delete(sessionId)
      window.removeEventListener('storage', onStorage)
    }
  }
  const raw = useSyncExternalStore(subscribe, () => sessionId ? readPersisted(key(sessionId)) : null, () => null)
  const queued = raw === null ? [] : read(sessionId)
  // Persistence belongs to the mutation, so a captured acknowledgement still commits after this view unmounts.
  const setQueued = (update: SetStateAction<QueuedTurn[]>) => {
    if (!sessionId) return
    const current = read(sessionId)
    const next = typeof update === 'function' ? update(current) : update
    if (next.length) writePersistedJson(key(sessionId), next)
    else removePersisted(key(sessionId))
    for (const listener of listeners.get(sessionId) ?? []) listener()
  }
  return [queued, setQueued] as const
}
