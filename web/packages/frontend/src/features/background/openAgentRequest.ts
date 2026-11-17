import { pendingRequest } from '../../lib/pendingRequest'
import { setSidePanelOpen } from '../../shell/useShellState'

/**
 * TAL-2333: a request to show one delegation unit of a session on its side panel's Agents page, from a subagent a
 * delegation row lists. Like `requestOpenFile`, it waits until that session's Agents page takes it.
 */
export interface OpenAgentRequest { sessionId: string; taskId: string }
const channel = pendingRequest<OpenAgentRequest>()

export function requestOpenAgent(request: OpenAgentRequest): void {
  setSidePanelOpen(true)
  channel.request(request)
}

export const peekOpenAgentRequest = channel.peek
export const takeOpenAgentRequest = channel.take
export const onOpenAgentRequest = channel.on
