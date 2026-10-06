import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import * as api from '../../api/endpoints'
import { isApiError } from '../../contracts/common'
import { readPersistedJson, writePersistedJson, removePersisted } from '../../lib/persisted'
import { LocalDraftSchema } from '../../contracts/persisted'

const key = (sid: string) => `hermes-draft:${sid}`

/** The draft the composer last loaded, from this browser or the server, until it is edited: only an edit is published. */
let loaded: { sessionId: string; text: string } | null = null

export function readLocalDraft(sessionId: string): string {
  const text = readLocal(sessionId)?.text ?? ''
  loaded = { sessionId, text }
  return text
}

/**
 * The server orders draft writes by `draft_version`: this browser's wall time in microseconds, kept above every
 * revision seen so far, so a slow request never overwrites later text and a load can tell which copy is newer (TAL-564).
 * Local copies are stamped the same way, so an edit outranks a server copy from a device whose clock runs ahead.
 */
let revision = 0
function observe(version: unknown): void {
  const n = Number(version)
  if (Number.isSafeInteger(n) && n > revision) revision = n
}
function stamp(): number {
  revision = Math.max(Date.now() * 1000, revision + 1)
  return revision
}
function writeLocal(sessionId: string, text: string, revision = stamp()): void {
  writePersistedJson(key(sessionId), { text, updatedAt: Date.now(), revision })
}
/** This browser's copy of a draft and its revision, which also carries the revision counter across a reload. */
function readLocal(sessionId: string) {
  const local = readPersistedJson(key(sessionId), LocalDraftSchema)
  if (!local) return null
  const revision = local.revision ?? local.updatedAt * 1000
  observe(revision)
  return { text: local.text, revision }
}
/**
 * Save to the server, stamping the local copy with the same revision: a copy the server truncated never outranks it.
 * A clear keeps an empty local copy until the server acknowledges it, so a failed clear is retried by the next load
 * instead of bringing sent text back.
 */
function publish(sessionId: string, text: string): void {
  const version = stamp()
  writeLocal(sessionId, text, version)
  void api.saveDraft({ session_id: sessionId, draft: { text }, draft_version: String(version) }).then(
    (saved) => {
      observe(saved.draft_version)
      if (text === '' && readPersistedJson(key(sessionId), LocalDraftSchema)?.revision === version) removePersisted(key(sessionId))
    },
    // A 409 means another tab or device saved a later revision; this text stays local and the next edit outranks it.
    (e: unknown) => { if (isApiError(e) && e.status === 409) observe((e.body as { draft_version?: unknown } | null)?.draft_version) },
  )
}

/**
 * On session load, the server's draft replaces this browser's copy when it is newer, or when this browser has none
 * (another device, cleared site data). Once the box is edited (typed, sent, handed in) a late answer is dropped.
 */
export function useServerDraft(sessionId: string | null, setText: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    if (!sessionId) return
    const local = readLocal(sessionId)
    let current = true
    void api.fetchDraft(sessionId).then(({ draft, draft_version }) => {
      observe(draft_version)
      if (!current) return
      if (local && (draft_version === null || Number(draft_version) <= local.revision)) {
        // This browser's copy is newer, e.g. an edit left before its server save ran: publish it unless edited since.
        // An unversioned server draft gives no order, so this browser's copy only stays local.
        if (draft_version !== null && draft.text !== local.text && loaded?.sessionId === sessionId && loaded.text === local.text) publish(sessionId, local.text)
        return
      }
      setText((text) => {
        if (loaded?.sessionId !== sessionId || loaded.text !== text) return text
        loaded = { sessionId, text: draft.text }
        // Cached with its exact revision, so an offline load shows it rather than this browser's older copy.
        if (draft_version !== null && draft.text) writeLocal(sessionId, draft.text, Number(draft_version))
        else removePersisted(key(sessionId))
        return draft.text
      })
    }, () => undefined)
    return () => { current = false }
  }, [sessionId, setText])
}

interface Unsaved { sessionId: string; text: string }
function flush(unsaved: RefObject<Unsaved | null>): void {
  const d = unsaved.current
  unsaved.current = null
  if (d) writeLocal(d.sessionId, d.text)
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
  // The text this hook last saw, or null when it is not known to belong to that session.
  const last = useRef<{ sessionId: string | null; text: string | null }>({ sessionId, text })
  useEffect(() => {
    const prev = last.current
    // A session switch renders once with the previous session's text before the composer loads this session's draft.
    const switched = prev.sessionId !== null && prev.sessionId !== sessionId
    last.current = { sessionId, text: switched ? null : text }
    if (!sessionId || switched) return
    if (loaded?.sessionId === sessionId && loaded.text === text) return
    loaded = null
    if (text.trim() === '') {
      unsaved.current = null
      // Emptied by a send, queue, steer, command or by hand: the server copy goes too, or a later load restores it.
      if (prev.text?.trim()) publish(sessionId, '')
      else removePersisted(key(sessionId))
      return
    }
    unsaved.current = { sessionId, text }
    const local = window.setTimeout(() => flush(unsaved), 300)
    const server = window.setTimeout(() => { publish(sessionId, text) }, 1200)
    return () => { window.clearTimeout(local); window.clearTimeout(server) }
  }, [sessionId, text])
}

export function clearDraft(sessionId: string): void {
  publish(sessionId, '')
}
