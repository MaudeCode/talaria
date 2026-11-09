import { pendingRequest } from '../../lib/pendingRequest'
import { setSidePanelOpen } from '../../shell/useShellState'

/**
 * TAL-1968: a request to show one workspace file of a session on its side panel's Files page, the Web counterpart of the
 * App's companion page. The request waits until that session's Files page takes it, so a panel that mounts or opens
 * after the request still shows the file.
 */
export interface OpenFileRequest { sessionId: string; path: string }
const channel = pendingRequest<OpenFileRequest>()

export function requestOpenFile(request: OpenFileRequest): void {
  setSidePanelOpen(true)
  channel.request(request)
}

export const peekOpenFileRequest = channel.peek
export const takeOpenFileRequest = channel.take
export const onOpenFileRequest = channel.on
