/**
 * TAL-2380: a profile's Bot Screen through the sidecar's proxy for its owner's `display.*`. The service decides the
 * `screen` view clients show, bridges each open viewer's WebSocket to the owner's RFB socket, and takes or hands back
 * control for it. The display ticket (inside the sidecar's `rfb_url`) and the viewer id stay on the server.
 */
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { SCREEN_CLOSE, ScreenViewIdSchema, type ScreenView } from '@maudecode/talaria-web-contracts'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import type { SidecarLike } from '../sidecar/client.js'
import { activeProfileName } from '../auth/gate.js'
import type { RequestContext } from '../http/context.js'
import { acceptUpgrade, pendingUpgrade } from '../http/websocket.js'

type DisplayStatus = NonNullable<SidecarResult<'display.status'>['status']>

/** How long one owner read answers the profile's `screen`, and how long a read may take before it counts as unavailable. */
const STATUS_TTL_S = 5
const STATUS_TIMEOUT_MS = 3_000
/** Each viewer holds a sidecar call slot and an owner connection for as long as it is open. */
export const MAX_SCREEN_VIEWERS = 4
/** RFB the browser has not read yet; past it the owner's socket pauses until the browser catches up. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
export const UNAVAILABLE_SCREEN: ScreenView = { available: false, state: 'unsupported', control: 'agent', install_command: null }

interface Viewer { profileHome: string; viewId: string | null; viewerHash: string | null; abort: AbortController }

export interface ScreenDeps { sidecar: () => SidecarLike | null; now: () => number; log: (line: string) => void }

export class ScreenService {
  private readonly reads = new Map<string, { at: number; status: Promise<DisplayStatus | null> }>()
  private readonly viewers = new Map<string, Viewer>()
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })

  constructor(private readonly deps: ScreenDeps) {}

  /** The profile's screen as clients show it. Any failure to read the owner is an unavailable screen. */
  async view(profileHome: string): Promise<ScreenView> {
    let read = this.reads.get(profileHome)
    if (!read || this.deps.now() - read.at >= STATUS_TTL_S) {
      read = { at: this.deps.now(), status: this.status(profileHome) }
      this.reads.set(profileHome, read)
    }
    const status = await read.status
    if (!status?.supported) return UNAVAILABLE_SCREEN
    const { lease } = status
    const mine = [...this.viewers.values()].some((viewer) => viewer.profileHome === profileHome && viewer.viewerHash !== null && viewer.viewerHash === lease.viewer_hash)
    return {
      available: true,
      state: !status.installed ? 'not_installed' : status.running ? 'running' : 'stopped',
      control: lease.holder === 'agent' ? 'agent' : mine ? 'you' : 'other',
      install_command: status.installed ? null : status.install_command,
    }
  }

  private async status(profileHome: string): Promise<DisplayStatus | null> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return null
    try {
      const read = await sidecar.call('display.status', { profile_home: profileHome }, { timeoutMs: STATUS_TIMEOUT_MS })
      return read.state === 'ready' ? read.status : null
    } catch {
      // An older sidecar (-32601), a stopped one or a slow owner: no screen to offer.
      return null
    }
  }

  /** Take over or hand back through the open viewer `viewId` of `profileHome`; the screen as it then stands. */
  async lease(profileHome: string, viewId: string, action: 'acquire' | 'release'): Promise<ScreenView | 'not_open' | 'not_ready'> {
    const viewer = this.viewers.get(viewId)
    if (!viewer || viewer.profileHome !== profileHome) return 'not_open'
    const sidecar = this.deps.sidecar()
    if (!sidecar || viewer.viewId === null) return 'not_ready'
    try {
      await sidecar.call(action === 'acquire' ? 'display.lease.acquire' : 'display.lease.release', { view_id: viewer.viewId })
    } finally {
      this.reads.delete(profileHome)
    }
    return this.view(profileHome)
  }

  /** `GET /api/screen/ws?view_id=`: one viewer of the active profile's screen. */
  async handle(ctx: RequestContext): Promise<void> {
    const upgrade = await pendingUpgrade(ctx)
    if (!upgrade) return
    const viewId = ScreenViewIdSchema.safeParse(ctx.query.get('view_id'))
    if (!viewId.success || this.viewers.has(viewId.data)) {
      await ctx.json({ error: 'A new view_id is required' }, { status: 400 })
      return
    }
    const sidecar = this.deps.sidecar()
    if (!sidecar || this.viewers.size >= MAX_SCREEN_VIEWERS) {
      await ctx.json({ error: sidecar ? 'Too many screen viewers are open' : 'The screen is unavailable on this server' }, { status: 503 })
      return
    }
    const viewer: Viewer = { profileHome: ctx.deps.profileHome(activeProfileName(ctx)), viewId: null, viewerHash: null, abort: new AbortController() }
    // Registered once the socket opens: a handshake the WebSocket server refuses never holds a viewer slot.
    acceptUpgrade(ctx, upgrade, this.sockets, (ws) => {
      if (this.viewers.has(viewId.data) || this.viewers.size >= MAX_SCREEN_VIEWERS) { ws.close(SCREEN_CLOSE.unavailable); return }
      this.viewers.set(viewId.data, viewer)
      this.bridge(ws, viewId.data, viewer, sidecar)
    })
  }

  /** Close every viewer at shutdown; each close hands control back. */
  close(): void {
    for (const ws of this.sockets.clients) ws.close(1001)
  }

  private bridge(ws: WebSocket, id: string, viewer: Viewer, sidecar: SidecarLike): void {
    let upstream: WebSocket | null = null
    let done = false
    const early: Buffer[] = []
    const finish = (code: number, reason = '') => {
      if (done) return
      done = true
      this.viewers.delete(id)
      this.reads.delete(viewer.profileHome)
      upstream?.close(1000)
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason)
      // Closing the viewer hands control back (a no-op unless it holds it), then ends its owner connection.
      const release = viewer.viewId === null ? Promise.resolve() : sidecar.call('display.lease.release', { view_id: viewer.viewId }).then(() => undefined)
      void release.catch((error: unknown) => { this.deps.log(`[webui] screen hand-back failed: ${(error as Error).message}`) }).finally(() => { viewer.abort.abort() })
    }
    const connect = (url: string) => {
      const rfb = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      upstream = rfb
      rfb.on('open', () => { for (const chunk of early.splice(0)) rfb.send(chunk) })
      rfb.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary || ws.readyState !== ws.OPEN) return
        ws.send(data, () => { if (ws.bufferedAmount < MAX_BUFFERED_BYTES) rfb.resume() })
        if (ws.bufferedAmount >= MAX_BUFFERED_BYTES) rfb.pause()
      })
      // The owner's own codes pass through: another viewer took control, or the screen stopped. Anything else ends the view.
      rfb.on('close', (code: number) => { finish(code === SCREEN_CLOSE.controlTaken || code === SCREEN_CLOSE.desktopGone ? code : SCREEN_CLOSE.unavailable) })
      rfb.on('error', () => { finish(SCREEN_CLOSE.unavailable) })
    }
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (done) return
      if (!isBinary) { finish(1003, 'RFB is binary'); return }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(chunk)
      else if (early.reduce((n, b) => n + b.length, 0) + chunk.length > MAX_BUFFERED_BYTES) finish(1009)
      else early.push(chunk)
    })
    ws.on('close', () => { finish(1000) })
    ws.on('error', () => { finish(1011) })
    sidecar.call('display.view', { profile_home: viewer.profileHome }, {
      signal: viewer.abort.signal,
      timeoutMs: 0,
      onStream: (frame) => {
        const data = frame.data as { rfb_url?: unknown; view_id?: unknown; viewer_hash?: unknown }
        if (done || frame.event !== 'ready' || typeof data.rfb_url !== 'string' || typeof data.view_id !== 'string') return
        viewer.viewId = data.view_id
        viewer.viewerHash = typeof data.viewer_hash === 'string' ? data.viewer_hash : null
        connect(data.rfb_url)
      },
    }).then(() => { finish(SCREEN_CLOSE.desktopGone) }, (error: unknown) => {
      if (!done) this.deps.log(`[webui] screen viewer ended: ${(error as Error).message}`)
      finish(SCREEN_CLOSE.unavailable)
    })
  }
}
