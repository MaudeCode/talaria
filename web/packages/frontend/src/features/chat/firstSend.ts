import { useSyncExternalStore } from 'react'

/**
 * A new chat's first send, pending before its session and turn exist (TAL-274, TAL-429). The index route and the
 * session route mount separate views, so this lives outside both and outlasts the remount.
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
