import { useEffect, useRef, type RefObject } from 'react'
import * as api from '../../api/endpoints'
import { readPersistedJson, writePersistedJson, removePersisted } from '../../lib/persisted'
import { LocalDraftSchema } from '../../contracts/persisted'

const key = (sid: string) => `hermes-draft:${sid}`

export function readLocalDraft(sessionId: string): string {
  return readPersistedJson(key(sessionId), LocalDraftSchema)?.text ?? ''
}

interface Unsaved { sessionId: string; text: string }
function flush(unsaved: RefObject<Unsaved | null>): void {
  const d = unsaved.current
  unsaved.current = null
  if (d) writePersistedJson(key(d.sessionId), { text: d.text, updatedAt: Date.now() })
}

/**
 * Mirror the composer text locally after a short typing pause, and to the server draft endpoint, debounced. A storage
 * write serializes the whole draft, so it never runs per keystroke (TAL-278); a session change, unmount or hidden page
 * writes the pending text at once, so a reload or switch right after typing keeps it.
 */
export function useDraftPersistence(sessionId: string | null, text: string) {
  const unsaved = useRef<Unsaved | null>(null)
  useEffect(() => {
    const onPageHide = () => flush(unsaved)
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(unsaved) }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibility)
      flush(unsaved)
    }
  }, [sessionId])
  useEffect(() => {
    if (!sessionId) return
    if (text.trim() === '') { unsaved.current = null; removePersisted(key(sessionId)); return }
    unsaved.current = { sessionId, text }
    const local = window.setTimeout(() => flush(unsaved), 300)
    const server = window.setTimeout(() => { void api.saveDraft({ session_id: sessionId, draft: { text } }).catch(() => undefined) }, 1200)
    return () => { window.clearTimeout(local); window.clearTimeout(server) }
  }, [sessionId, text])
}

export function clearDraft(sessionId: string): void {
  removePersisted(key(sessionId))
  void api.saveDraft({ session_id: sessionId, draft: { text: '' } }).catch(() => undefined)
}
