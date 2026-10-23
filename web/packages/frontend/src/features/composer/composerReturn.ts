/**
 * TAL-425: text that comes back to a session's composer: a steer taken back for editing, one a Stop withdrew, or a sent
 * message taken back by Edit (TAL-516). Only the tab that sent a steer gets a stopped one back (its ids live in this
 * tab's sessionStorage, so a reload keeps them); other tabs just drop its bubble. Returned turns for a composer that is not
 * mounted wait until it is; selection quotes never wait.
 */
export const MAX_QUOTE_LENGTH = 16_000

type ReturnKind = 'return' | 'quote'
type Listener = (text: string, kind?: ReturnKind) => void

const OWN_STEERS_KEY = 'talaria-own-steers'
const listeners = new Map<string, Set<Listener>>()
const waiting = new Map<string, string[]>()

// This tab's steer ids live in memory; sessionStorage only carries them across a reload, so a storage failure (private
// mode, quota) never loses one (TAL-743).
const ownSteers: Set<string> = (() => {
  try { return new Set(JSON.parse(sessionStorage.getItem(OWN_STEERS_KEY) ?? '[]') as string[]) } catch { return new Set<string>() }
})()

function saveOwnSteers(): void {
  try { sessionStorage.setItem(OWN_STEERS_KEY, JSON.stringify([...ownSteers])) } catch { /* private mode: in-page only */ }
}

export function onReturnToComposer(sessionId: string, listener: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(sessionId, set)
  const held = waiting.get(sessionId)
  waiting.delete(sessionId)
  for (const text of held ?? []) listener(text)
  return () => { set.delete(listener) }
}

/** Selection quotes are bounded local actions for a mounted composer, never deferred across navigation. */
export function returnToComposer(sessionId: string, text: string, kind: ReturnKind = 'return'): void {
  if (kind === 'quote') {
    if (!text.trim() || text.length > MAX_QUOTE_LENGTH) return
    text = `${text.replace(/\r\n?/g, '\n').split('\n').map((line) => `> ${line}`).join('\n')}\n\n`
  }
  const set = listeners.get(sessionId)
  if (set?.size) for (const listener of set) listener(text, kind)
  else if (kind !== 'quote') waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), text])
}

/** This tab sent the steer, so a Stop that withdraws it gives the text back here. */
export function rememberOwnSteer(steerId: string): void {
  ownSteers.add(steerId)
  saveOwnSteers()
}

/** The steer is no longer pending (taken, withdrawn or refused): nothing comes back for it any more. */
export function forgetOwnSteer(steerId: string): boolean {
  const had = ownSteers.delete(steerId)
  if (had) saveOwnSteers()
  return had
}

/** A Stop withdrew a steer: back to this tab's composer once, and only when this tab sent it. */
export function returnStoppedSteer(sessionId: string, steerId: string | null, text: string): void {
  if (steerId && forgetOwnSteer(steerId)) returnToComposer(sessionId, text)
}

/** Auth/profile changes cannot hand another identity a buffered draft or a stopped steer. */
export function resetComposerReturns(): void {
  waiting.clear()
  ownSteers.clear()
  saveOwnSteers()
}
