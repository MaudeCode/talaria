import { pendingRequest } from '../../lib/pendingRequest'

/**
 * TAL-1974: a `terminal_open` card's request to show its terminal in the session's terminal pane and focus it. The chat
 * opens the pane; the pane takes the request and attaches to that terminal, so a pane that mounts after the request
 * still gets it.
 */
export interface OpenTerminalRequest { sessionId: string; terminalId: string }
const channel = pendingRequest<OpenTerminalRequest>()

export const requestOpenTerminal = (request: OpenTerminalRequest): void => { channel.request(request) }
export const peekOpenTerminalRequest = channel.peek
export const takeOpenTerminalRequest = channel.take
export const onOpenTerminalRequest = channel.on
