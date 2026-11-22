import { pendingRequest } from '../../lib/pendingRequest'

/**
 * TAL-2380: a live computer row's request to open its session's screen viewer. Like `requestOpenTerminal`, it waits
 * until that session's chat takes it.
 */
export interface OpenScreenRequest { sessionId: string }
const channel = pendingRequest<OpenScreenRequest>()

export const requestOpenScreen = (request: OpenScreenRequest): void => { channel.request(request) }
export const takeOpenScreenRequest = channel.take
export const onOpenScreenRequest = channel.on
