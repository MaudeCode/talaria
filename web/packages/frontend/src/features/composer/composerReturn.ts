/**
 * TAL-425: text that comes back to a session's composer: a steer taken back for editing, or one a Stop withdrew. Only
 * the tab that sent a steer gets a stopped one back; other tabs just drop its bubble.
 */
type Listener = (text: string) => void

const listeners = new Map<string, Set<Listener>>()
const ownSteers = new Set<string>()

export function onReturnToComposer(sessionId: string, listener: Listener): () => void {
  const set = listeners.get(sessionId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(sessionId, set)
  return () => { set.delete(listener) }
}

export function returnToComposer(sessionId: string, text: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener(text)
}

/** This tab sent the steer, so a Stop that withdraws it gives the text back here. */
export function rememberOwnSteer(steerId: string): void {
  ownSteers.add(steerId)
}

/** A Stop withdrew a steer: back to this tab's composer once, and only when this tab sent it. */
export function returnStoppedSteer(sessionId: string, steerId: string | null, text: string): void {
  if (steerId && ownSteers.delete(steerId)) returnToComposer(sessionId, text)
}
