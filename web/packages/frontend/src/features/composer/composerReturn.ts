/**
 * TAL-425: text that comes back to a session's composer: a steer taken back for editing, one a Stop withdrew, or a sent
 * message taken back by Edit (TAL-516). Only the tab that sent a steer gets a stopped one back (its ids live in this
 * tab's sessionStorage, so a reload keeps them); other tabs just drop its bubble. Text for a composer that is not
 * mounted waits until it is.
 */
type Listener = (text: string) => void

const OWN_STEERS_KEY = 'talaria-own-steers'
const listeners = new Map<string, Set<Listener>>()
const waiting = new Map<string, string[]>()

function ownSteers(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(OWN_STEERS_KEY) ?? '[]') as string[]) } catch { return new Set() }
}

function saveOwnSteers(ids: Set<string>): void {
  try { sessionStorage.setItem(OWN_STEERS_KEY, JSON.stringify([...ids])) } catch { /* private mode: in-page only */ }
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

export function returnToComposer(sessionId: string, text: string): void {
  const set = listeners.get(sessionId)
  if (set?.size) for (const listener of set) listener(text)
  else waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), text])
}

/** This tab sent the steer, so a Stop that withdraws it gives the text back here. */
export function rememberOwnSteer(steerId: string): void {
  saveOwnSteers(ownSteers().add(steerId))
}

/** The steer is no longer pending (taken, withdrawn or refused): nothing comes back for it any more. */
export function forgetOwnSteer(steerId: string): boolean {
  const ids = ownSteers()
  const had = ids.delete(steerId)
  if (had) saveOwnSteers(ids)
  return had
}

/** A Stop withdrew a steer: back to this tab's composer once, and only when this tab sent it. */
export function returnStoppedSteer(sessionId: string, steerId: string | null, text: string): void {
  if (steerId && forgetOwnSteer(steerId)) returnToComposer(sessionId, text)
}
