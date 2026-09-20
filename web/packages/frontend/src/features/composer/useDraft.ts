import { useEffect, useRef } from 'react'
import * as api from '../../api/endpoints'
import { readPersistedJson, writePersistedJson, removePersisted } from '../../lib/persisted'
import { LocalDraftSchema } from '../../contracts/persisted'

const key = (sid: string) => `hermes-draft:${sid}`

export function readLocalDraft(sessionId: string): string {
  return readPersistedJson(key(sessionId), LocalDraftSchema)?.text ?? ''
}

/** Mirror the composer text locally at once and to the server draft endpoint, debounced. */
export function useDraftPersistence(sessionId: string | null, text: string) {
  const timer = useRef<number | null>(null)
  useEffect(() => {
    if (!sessionId) return
    if (text.trim() === '') { removePersisted(key(sessionId)); return }
    writePersistedJson(key(sessionId), { text, updatedAt: Date.now() })
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { void api.saveDraft({ session_id: sessionId, draft: { text } }).catch(() => undefined) }, 1200)
    return () => { if (timer.current) window.clearTimeout(timer.current) }
  }, [sessionId, text])
}

export function clearDraft(sessionId: string): void {
  removePersisted(key(sessionId))
  void api.saveDraft({ session_id: sessionId, draft: { text: '' } }).catch(() => undefined)
}
