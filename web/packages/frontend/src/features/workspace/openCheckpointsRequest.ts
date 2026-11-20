import { pendingRequest } from '../../lib/pendingRequest'
import { setSidePanelOpen } from '../../shell/useShellState'

/**
 * TAL-2069: a request to show a session's side panel on its Checkpoints page, from the files an Undo left changed. Like
 * `requestOpenFile`, it waits until that session's Checkpoints page takes it.
 */
export interface OpenCheckpointsRequest { sessionId: string }
const channel = pendingRequest<OpenCheckpointsRequest>()

export function requestOpenCheckpoints(request: OpenCheckpointsRequest): void {
  setSidePanelOpen(true)
  channel.request(request)
}

export const peekOpenCheckpointsRequest = channel.peek
export const takeOpenCheckpointsRequest = channel.take
export const onOpenCheckpointsRequest = channel.on
