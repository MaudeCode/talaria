import { useSyncExternalStore } from 'react'

/**
 * Send motion shared across the chat views (TAL-429). A new chat's first send leaves the hero at once, before its
 * session exists; the index route and the session route mount separate views, so the pending text and the dock
 * animation live here and outlast the remount.
 */
export interface FirstSend { text: string; sessionId: string | null; failed: boolean }

let firstSend: FirstSend | null = null
const listeners = new Set<() => void>()
const setFirstSend = (next: FirstSend | null) => { firstSend = next; for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const getFirstSend = (): FirstSend | null => firstSend
export const useFirstSend = (): FirstSend | null => useSyncExternalStore(subscribe, getFirstSend, getFirstSend)
export const beginFirstSend = (text: string) => setFirstSend({ text, sessionId: null, failed: false })
/** The session just created for the pending send; set before navigating so the session view claims it on mount. */
export const bindFirstSend = (sessionId: string) => { if (firstSend && !firstSend.failed) setFirstSend({ ...firstSend, sessionId }) }
export const endFirstSend = () => setFirstSend(null)
/** A failed first send hands its text back to whichever composer is mounted for it. */
export const failFirstSend = () => { if (firstSend) setFirstSend({ ...firstSend, failed: true }) }
/** The unsaved chat's view only exists before navigation, so it owns any pending send; a session view owns its own. */
export const ownsFirstSend = (fs: FirstSend | null, sessionId: string | null): boolean => !!fs && (sessionId === null || fs.sessionId === sessionId)

export const DOCK_MS = 340
const DOCK_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
let dock: { fromTop: number; start: number } | null = null

/** Hero → docked: remember where the composer was; `playDock` moves it from there, in this view or the next one. */
export function beginDock(fromTop: number): void {
  dock = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? null : { fromTop, start: performance.now() }
}

/** FLIP the docked composer from the recorded hero position, resuming at the elapsed time when a remount interrupted it. */
export function playDock(el: HTMLElement): void {
  if (!dock || typeof el.animate !== 'function') return
  const elapsed = performance.now() - dock.start
  if (elapsed >= DOCK_MS) { dock = null; return }
  const dy = dock.fromTop - el.getBoundingClientRect().top
  if (Math.abs(dy) < 1) return
  const animation = el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: DOCK_MS, easing: DOCK_EASE })
  animation.currentTime = elapsed
}

/** Every submit (send, steer, queue) brings the transcript to its end, wherever the reader had scrolled. */
const scrollRequests = new EventTarget()
export const requestScrollToEnd = () => { scrollRequests.dispatchEvent(new Event('end')) }
export function onScrollToEndRequest(fn: () => void): () => void {
  scrollRequests.addEventListener('end', fn)
  return () => scrollRequests.removeEventListener('end', fn)
}

/** The composer's height changed (a tab row sliding in, the box growing): a pinned transcript follows in the same frame. */
export const requestFollow = () => { scrollRequests.dispatchEvent(new Event('follow')) }
export function onFollowRequest(fn: () => void): () => void {
  scrollRequests.addEventListener('follow', fn)
  return () => scrollRequests.removeEventListener('follow', fn)
}
