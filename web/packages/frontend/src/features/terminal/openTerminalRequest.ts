import { pendingRequest } from '../../lib/pendingRequest'

/**
 * TAL-1974: a `terminal_open` card's request to open a session's terminal pane and focus it. The chat opens the pane; the
 * pane takes the request once its terminal is attached, so a pane that mounts after the request still takes focus.
 */
const channel = pendingRequest<{ sessionId: string }>()

export const requestOpenTerminal = (sessionId: string): void => { channel.request({ sessionId }) }
export const peekOpenTerminalRequest = channel.peek
export const takeOpenTerminalRequest = channel.take
export const onOpenTerminalRequest = channel.on
