import { useEffect, useRef, useSyncExternalStore, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { PendingFile } from './Attachments'
import * as api from '../../api/endpoints'
import { isApiError } from '../../contracts/common'
import { readPersistedJson, writePersistedJson, removePersisted } from '../../lib/persisted'
import { DraftRevisionSchema, LocalDraftSchema } from '../../contracts/persisted'

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
 * A revision ahead of this clock is kept across reloads (behind it, the clock carries the order); a stored one beyond the
 * server's five-minute limit is corrupt and dropped.
 */
const REVISION_KEY = 'hermes-draft-revision'
let revision = ((stored) => (stored <= (Date.now() + 300_000) * 1000 ? stored : 0))(readPersistedJson(REVISION_KEY, DraftRevisionSchema) ?? 0)
function observe(version: unknown): void {
  const n = Number(version)
  if (!Number.isSafeInteger(n) || n <= revision) return
  revision = n
  if (n > Date.now() * 1000) writePersistedJson(REVISION_KEY, n)
}
function stamp(): number {
  observe(Math.max(Date.now() * 1000, revision + 1))
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
    // A 409 means another tab or device saved this or a later revision first: the next edit outranks it, but this copy
    // must not, or the next load would publish it over the one the server kept.
    (e: unknown) => {
      if (!isApiError(e) || e.status !== 409) return
      observe((e.body as { draft_version?: unknown } | null)?.draft_version)
      const local = readPersistedJson(key(sessionId), LocalDraftSchema)
      if (local?.revision === version) writePersistedJson(key(sessionId), { ...local, revision: 0 })
    },
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
export function useDraftPersistence(sessionId: string | null, text: string, syncServer = true) {
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
      if (prev.text?.trim() && syncServer) publish(sessionId, '')
      else removePersisted(key(sessionId))
      return
    }
    unsaved.current = { sessionId, text }
    const local = window.setTimeout(() => flush(unsaved), 300)
    const server = syncServer ? window.setTimeout(() => { publish(sessionId, text) }, 1200) : null
    return () => { window.clearTimeout(local); if (server !== null) window.clearTimeout(server) }
  }, [sessionId, text, syncServer])
}

export function clearDraft(sessionId: string, syncServer = true): void {
  if (syncServer) publish(sessionId, '')
  else removePersisted(key(sessionId))
}

/**
 * Each composer identity's staged files, kept for this page so leaving a chat and coming back restores the exact Files,
 * their upload state and retry actions (TAL-1074). Browser File objects cannot be stored, so a reload ends them. A tray
 * leaves the map once it empties (send, removal), its session is deleted, or auth or profile context is discarded.
 * `attempts` holds each chip's upload in flight: a receipt whose attempt is gone (chip removed, sent, tray discarded)
 * is rolled back by its uploader instead of applied.
 */
interface Tray { sessionId: string | null; files: PendingFile[]; attempts: Map<string, object> }
const trays = new Map<string, Tray>()
const trayListeners = new Set<() => void>()
const NO_FILES: PendingFile[] = []
const subscribeTrays = (changed: () => void) => { trayListeners.add(changed); return () => { trayListeners.delete(changed) } }
function writeTray(id: string, tray: Tray): void {
  // Attempts follow their chips: a key no longer staged fences its late receipt.
  for (const k of tray.attempts.keys()) if (!tray.files.some((f) => f.key === k)) tray.attempts.delete(k)
  if (tray.files.length) trays.set(id, tray)
  else trays.delete(id)
  for (const changed of trayListeners) changed()
}

/** The staged files of one composer identity; an update made after the composer moved on still lands on that identity. */
export function useStagedFiles(id: string, sessionId: string | null) {
  const files = useSyncExternalStore(subscribeTrays, () => trays.get(id)?.files ?? NO_FILES, () => NO_FILES)
  const setFiles = (update: SetStateAction<PendingFile[]>) => {
    const tray = trays.get(id)
    const current = tray?.files ?? NO_FILES
    const next = typeof update === 'function' ? update(current) : update
    if (next !== current) writeTray(id, { sessionId: tray?.sessionId ?? sessionId, files: next, attempts: tray?.attempts ?? new Map<string, object>() })
  }
  return [files, setFiles] as const
}

/** Starts a chip's upload attempt on its identity's tray. */
export function beginUpload(id: string, fileKey: string): object {
  const attempt = {}
  trays.get(id)?.attempts.set(fileKey, attempt)
  return attempt
}

/** Applies a finished upload to whichever tray holds its attempt now; false when its chip is gone and the result is stale. */
export function finishUpload(fileKey: string, attempt: object, patch: Partial<PendingFile>): boolean {
  for (const [id, tray] of trays) {
    if (tray.attempts.get(fileKey) !== attempt) continue
    tray.attempts.delete(fileKey)
    writeTray(id, { ...tray, files: tray.files.map((f) => f.key === fileKey ? { ...f, ...patch } : f) })
    return true
  }
  return false
}

/**
 * A tray staged before its identity was known (the transcript was loading) joins the identity that arrived. A file staged
 * on both keeps the arrived identity's chip; the other copy's receipt is returned for rollback, and its late one is fenced.
 */
export function moveStagedFiles(from: string, to: string): string[] {
  const source = trays.get(from)
  if (!source || from === to) return []
  trays.delete(from)
  const target = trays.get(to)
  const duplicate = (f: PendingFile) => !!target?.files.some((t) => t.key === f.key)
  const files = [...(target?.files ?? []), ...source.files.filter((f) => !duplicate(f))]
  const joined = [...source.attempts].filter(([k]) => !target?.files.some((t) => t.key === k))
  writeTray(to, { sessionId: target?.sessionId ?? source.sessionId, files, attempts: new Map([...(target?.attempts ?? []), ...joined]) })
  return source.files.flatMap((f) => duplicate(f) && f.upload?.rollback_token ? [f.upload.rollback_token] : [])
}

/** Drops one identity's tray without rolling anything back: its composer is gone for good, or the session no longer exists. */
export function dropStagedFiles(id: string): void {
  if (trays.has(id)) writeTray(id, { sessionId: null, files: NO_FILES, attempts: new Map<string, object>() })
}

/** A deleted session's staged files go with it. */
export function discardStagedFiles(sessionId: string): void {
  for (const [id, tray] of trays) if (tray.sessionId === sessionId) dropStagedFiles(id)
}

/** Auth or profile changes cannot hand another identity staged files. */
export function resetStagedFiles(): void {
  trays.clear()
  for (const changed of trayListeners) changed()
}
