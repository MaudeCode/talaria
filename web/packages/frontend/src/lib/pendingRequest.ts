/**
 * A request for one session's view, such as a transcript card asking the side panel or the terminal pane to show
 * something. It waits until that session's view takes it, so a view that mounts or opens after the request still gets it.
 */
export function pendingRequest<T extends { sessionId: string }>() {
  const events = new EventTarget()
  let pending: T | null = null
  /** The waiting request for `sessionId`, without taking it. */
  const peek = (sessionId: string): T | null => (pending?.sessionId === sessionId ? pending : null)
  return {
    request: (value: T): void => {
      pending = value
      events.dispatchEvent(new Event('open'))
    },
    peek,
    /** Takes the waiting request for `sessionId`, once. */
    take: (sessionId: string): T | null => {
      const request = peek(sessionId)
      if (request) pending = null
      return request
    },
    on: (fn: () => void): (() => void) => {
      events.addEventListener('open', fn)
      return () => events.removeEventListener('open', fn)
    },
  }
}
