import { setSidePanelOpen } from '../../shell/useShellState'

/**
 * TAL-1968: a request to show one workspace file of a session on its side panel's Files page, the Web counterpart of the
 * App's companion page. The request waits until that session's Files page takes it, so a panel that mounts or opens
 * after the request still shows the file.
 */
export interface OpenFileRequest { sessionId: string; path: string }
const requests = new EventTarget()
let pending: OpenFileRequest | null = null

export function requestOpenFile(request: OpenFileRequest): void {
  pending = request
  setSidePanelOpen(true)
  requests.dispatchEvent(new Event('open'))
}

/** The waiting request for `sessionId`, without taking it. */
export const peekOpenFileRequest = (sessionId: string): OpenFileRequest | null => (pending?.sessionId === sessionId ? pending : null)

/** Takes the waiting request for `sessionId`, once. */
export function takeOpenFileRequest(sessionId: string): OpenFileRequest | null {
  const request = peekOpenFileRequest(sessionId)
  if (request) pending = null
  return request
}

export function onOpenFileRequest(fn: () => void): () => void {
  requests.addEventListener('open', fn)
  return () => requests.removeEventListener('open', fn)
}
