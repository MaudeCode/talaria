import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { readPersistedJson, removePersisted, writePersistedJson } from '../../lib/persisted'
import { QueuedTurnsSchema, type QueuedTurnSchema } from '../../contracts/persisted'

/** A message waiting for the live turn to settle. */
export type QueuedTurn = z.infer<typeof QueuedTurnSchema>

const key = (sid: string) => `hermes-queue:${sid}`
const read = (sid: string | null) => (sid ? readPersistedJson(key(sid), QueuedTurnsSchema) ?? [] : [])

/**
 * The session's queued messages, kept on this device so a reload keeps them (TAL-562). Other tabs on the same session
 * follow each change, so a message one tab sends never stays queued in another.
 */
export function useQueuedTurns(sessionId: string | null) {
  const [queued, setQueued] = useState<QueuedTurn[]>(() => read(sessionId))
  useEffect(() => {
    if (!sessionId) return
    if (queued.length) writePersistedJson(key(sessionId), queued)
    else removePersisted(key(sessionId))
  }, [sessionId, queued])
  useEffect(() => {
    if (!sessionId) return
    const onStorage = (e: StorageEvent) => { if (e.key === key(sessionId)) setQueued(read(sessionId)) }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage) }
  }, [sessionId])
  return [queued, setQueued] as const
}
