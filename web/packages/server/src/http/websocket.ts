/**
 * WebSocket routes (live dictation, the screen viewer): an upgrade runs the normal request pipeline (auth, profile) and
 * only a WebSocket route takes its socket over, after the same-origin check a browser handshake gets in place of CSRF.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket, WebSocketServer } from 'ws'
import type { RequestContext } from './context.js'
import { checkSameOriginBrowserRequest, csrfRejectionError } from './origin.js'

export interface PendingUpgrade { socket: Duplex; head: Buffer }
const upgrades = new WeakMap<IncomingMessage, PendingUpgrade>()

/** Record an upgrade's socket and buffered bytes before the request runs through the normal pipeline. */
export function rememberUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgrades.set(req, { socket, head })
}

/** The request's WebSocket upgrade once it passed the origin check; null after answering 426 or 403. */
export async function pendingUpgrade(ctx: RequestContext): Promise<PendingUpgrade | null> {
  const upgrade = upgrades.get(ctx.req)
  if (!upgrade || (ctx.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
    await ctx.json({ error: 'WebSocket upgrade required' }, { status: 426, headers: { Upgrade: 'websocket' } })
    return null
  }
  // A browser cannot send the CSRF header on a handshake, so the origin check alone guards it (non-browser clients pass).
  const failure = checkSameOriginBrowserRequest({ origin: ctx.header('origin'), referer: ctx.header('referer'), host: ctx.header('host'), secFetchSite: ctx.header('sec-fetch-site'), forwardedHost: ctx.header('x-forwarded-host'), realHost: ctx.header('x-real-host') }, ctx.deps.config.env)
  if (failure) {
    await ctx.json({ error: csrfRejectionError(failure) }, { status: 403 })
    return null
  }
  return upgrade
}

/** Hand the upgrade's socket to `server` as an open WebSocket. */
export function acceptUpgrade(ctx: RequestContext, upgrade: PendingUpgrade, server: WebSocketServer, onOpen: (ws: WebSocket) => void): void {
  ctx.res.detachSocket(upgrade.socket as Parameters<typeof ctx.res.detachSocket>[0])
  ctx.markFinished(101)
  server.handleUpgrade(ctx.req, upgrade.socket, upgrade.head, onOpen)
}
