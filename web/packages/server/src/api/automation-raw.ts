/** Kanban event stream, terminal output stream, extension static files, and the extension sidecar proxy (raw handlers). */
import type { RequestContext } from '../http/context.js'
import { HttpError } from './router.js'
import { activeProfileName } from '../auth/gate.js'
import { claimOrReject, SSE_HEARTBEAT_INTERVAL_MS } from './sse-routes.js'
import { DashboardPlugins, type PluginFile } from '../tools/dashboard-plugins.js'
import { isServerOwned } from '../spa.js'
import { ExtensionError, EXTENSION_PANEL_SANDBOX_CSP, EXTENSION_ROUTE_PREFIX, normalizeProxyPath, validId } from '../tools/extensions.js'
import { kanbanFailure } from '../tools/kanban.js'
import { HttpFailure } from '../sessions/service.js'
import { terminalGate } from './automation-router.js'
import { checkSameOriginBrowserRequest, csrfRejectionError } from '../http/origin.js'
import { str } from '../util.js'
import { readCapped } from '../http/capped.js'
import { stripPublicInternalFields } from '../redact.js'
import { BACKLOG_MAX as TERMINAL_BACKLOG_MAX, type TerminalItem } from '../tools/terminal.js'

const KANBAN_POLL_MS = 1_000
const KANBAN_HEARTBEAT_MS = 15_000
const PROXY_MAX_RESPONSE = 512 * 1024
const PROXY_MAX_REDIRECTS = 10
const PROXY_RE = /^\/api\/extensions\/([^/]+)\/sidecar(?:\/(.*))?$/
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return }
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = (): void => { clearTimeout(t); resolve() }
  signal.addEventListener('abort', onAbort, { once: true })
})

/** Python `_handle_events_sse_stream`: `hello`, then `events` batches with `id: <cursor>`, 1 s poll, 15 s keepalive. */
export async function handleKanbanEventsStream(ctx: RequestContext): Promise<void> {
  const board = str(ctx.query.get('board')).trim() || null
  const sinceRaw = ctx.query.get('since') ?? ctx.header('last-event-id') ?? null
  let cursor = sinceRaw === null ? 0 : Number.parseInt(sinceRaw, 10)
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0
  const home = ctx.deps.profileHome(activeProfileName(ctx))
  // Python `_resolve_board` normalised the slug before the `hello` frame carried it.
  let helloBoard = board
  if (board) {
    try { helloBoard = (await ctx.deps.kanban.sidecar().call('kanban.normalize_board', { profile_home: home, board })).board } catch (error) {
      try { kanbanFailure(error) } catch (mapped) { if (mapped instanceof HttpFailure) { ctx.json({ error: mapped.message }, { status: mapped.status }); return } }
      throw error
    }
  }
  const sse = claimOrReject(ctx, true)
  if (!sse) return
  const abort = new AbortController()
  ctx.res.on('close', () => { abort.abort() })
  try {
    sse.start()
    sse.event('hello', { cursor, board: helloBoard })
    let lastWrite = Date.now()
    while (await sse.ready() && !abort.signal.aborted) {
      let events: unknown[] = []
      try {
        const page = await ctx.deps.kanban.events(home, board, cursor, 200)
        events = Array.isArray(page.events) ? page.events : []
        if (events.length) cursor = Number(page.cursor) || cursor
      } catch { events = [] }
      if (sse.isClosed) return
      if (events.length) { sse.event('events', { events: events.map((e) => projectRunnerEventPayload(e)), cursor }, String(cursor)); lastWrite = Date.now() }
      else if (Date.now() - lastWrite >= KANBAN_HEARTBEAT_MS) { sse.comment('keepalive'); lastWrite = Date.now() }
      await sleep(KANBAN_POLL_MS, abort.signal)
    }
  } finally {
    sse.end()
  }
}

/** Python `_handle_terminal_output`: backlog replay after `Last-Event-ID`, integer ids, 5 s heartbeat, close on `terminal_closed`/`terminal_error`. */
export async function handleTerminalOutput(ctx: RequestContext): Promise<void> {
  try {
    await terminalGate(ctx)
  } catch (error) {
    if (error instanceof HttpError) { ctx.json({ error: error.message }, { status: error.status }); return }
    throw error
  }
  const sid = str(ctx.query.get('session_id')).trim()
  if (!sid) { ctx.json({ error: 'session_id required' }, { status: 400 }); return }
  let session
  try { session = ctx.deps.sessionStore.get(sid, { metadataOnly: true }) } catch { ctx.json({ error: 'Session not found' }, { status: 404 }); return }
  if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) { ctx.json({ error: 'remote_terminal_backend_unsupported', message: 'Embedded terminal is only supported for local terminal backends.' }, { status: 400 }); return }
  const term = ctx.deps.terminals.get(sid)
  if (!term) { ctx.json({ error: 'terminal not running' }, { status: 404 }); return }
  const lastId = (ctx.header('last-event-id') ?? '').trim()
  const afterSeq = lastId && /^\d+$/.test(lastId) ? Math.max(0, Number.parseInt(lastId, 10)) : null
  const sse = claimOrReject(ctx, true)
  if (!sse) return
  const queue: TerminalItem[] = []
  let wake: (() => void) | null = null
  // A viewer waiting on a slow socket keeps what a reconnecting one would get: the terminal's own backlog bound.
  const unsubscribe = term.subscribe(afterSeq, (item) => { if (queue.push(item) > TERMINAL_BACKLOG_MAX) queue.shift(); wake?.() })
  const abort = new AbortController()
  ctx.res.on('close', () => { abort.abort(); wake?.() })
  try {
    sse.start()
    let lastWrite = Date.now()
    while (await sse.ready() && !abort.signal.aborted) {
      const item = queue.shift()
      if (item) {
        sse.event(item.event, item.data, String(item.seq))
        lastWrite = Date.now()
        if (item.event === 'terminal_closed' || item.event === 'terminal_error') return
        continue
      }
      if (term.closed) { sse.event('terminal_closed', { exit_code: term.exitCode }); return }
      const remaining = SSE_HEARTBEAT_INTERVAL_MS - (Date.now() - lastWrite)
      if (remaining <= 0) { sse.comment('terminal heartbeat'); lastWrite = Date.now(); continue }
      await new Promise<void>((resolve) => {
        const onAbort = (): void => { clearTimeout(t); finish() }
        const finish = (): void => { abort.signal.removeEventListener('abort', onAbort); resolve() }
        const t = setTimeout(finish, remaining)
        wake = () => { clearTimeout(t); finish() }
        abort.signal.addEventListener('abort', onAbort, { once: true })
      })
      wake = null
    }
  } finally {
    unsubscribe()
    sse.end()
  }
}

/** `/extensions/*`: always 200 or a bare 404 (Python `serve_extension_static`). */
export function handleExtensionStatic(ctx: RequestContext): void {
  // Python `unquote` runs once on the request path.
  let rel: string
  try { rel = decodeURIComponent(ctx.path.slice(EXTENSION_ROUTE_PREFIX.length)) } catch { ctx.json({ error: 'not found' }, { status: 404 }); return }
  const file = ctx.deps.extensions.staticFile(rel)
  if (!file) { ctx.json({ error: 'not found' }, { status: 404 }); return }
  sendPanelFile(ctx, file, file.html)
}

/**
 * Extension- or plugin-controlled bytes from the WebUI's own origin: a sandboxed response gets the sandbox CSP (opaque
 * origin, so its HTML or SVG opened directly runs no privileged same-origin script).
 */
function sendPanelFile(ctx: RequestContext, file: { body: Buffer; contentType: string }, sandbox: boolean): void {
  const headers: Record<string, string | string[]> = { 'Content-Type': file.contentType, 'Cache-Control': 'no-store' }
  if (!sandbox) { ctx.send({ status: 200, headers, body: file.body, security: true }); return }
  // HWEB-100: the page policy stays and a second CSP header adds the sandbox, so a panel opened directly is isolated.
  // Both allow framing by the app itself; the report-only twin (`frame-ancestors 'none'`) is left off, or every
  // in-app panel would report a violation.
  const security = ctx.securityHeaders({ frameable: true })
  const page = security['Content-Security-Policy']
  headers['Content-Security-Policy'] = [...(typeof page === 'string' ? [page] : []), EXTENSION_PANEL_SANDBOX_CSP]
  ctx.send({ status: 200, headers: { ...security, ...headers }, body: file.body, security: false })
}

/**
 * Python dashboard-plugin routes: `/plugins/plugin.css`, `/dashboard-plugins/<name>/index.html` (panel),
 * `/dashboard-plugins/<name>/<rel>` (built assets), and each plugin's tab page. Returns false when `path` is none
 * of them; a disabled or unknown plugin answers 404 on every surface.
 */
export function handleDashboardPlugin(ctx: RequestContext): boolean {
  const plugins = ctx.deps.dashboardPlugins
  const path = ctx.path
  let file: PluginFile | null
  if (path.startsWith('/plugins/')) {
    const css = plugins.sharedAsset(path.slice('/plugins/'.length))
    if (css) sendPanelFile(ctx, css, false)
    else ctx.json({ error: 'not found' }, { status: 404 })
    return true
  }
  if (path.startsWith('/dashboard-plugins/')) {
    const panel = DashboardPlugins.panelName(path)
    const [name = '', ...rest] = path.slice('/dashboard-plugins/'.length).split('/')
    file = panel === null ? plugins.asset(name, rest.join('/')) : plugins.panel(panel)
  } else {
    // Tab paths never claim a server-owned path, so API traffic skips the plugin scan.
    file = isServerOwned(path) ? null : plugins.tabPage(path)
    if (!file) return false
  }
  if (file) sendPanelFile(ctx, file, true)
  else ctx.json({ error: 'not found' }, { status: 404 })
  return true
}

/**
 * Python `_project_runner_event_payload`: runner events relay session snapshots (`session.messages`) or bare
 * message-shaped payloads (`messages`) to the browser; provider sidecars and row-id aliases never leave the server.
 */
export function projectRunnerEventPayload<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) }
  const session = out.session
  if (session && typeof session === 'object' && !Array.isArray(session) && Array.isArray((session as Record<string, unknown>).messages)) {
    out.session = { ...(session as Record<string, unknown>), messages: stripPublicInternalFields((session as Record<string, unknown>).messages, { messageRecords: true }) }
  }
  if (Array.isArray(out.messages)) out.messages = stripPublicInternalFields(out.messages, { messageRecords: true })
  return out as T
}

export function matchSidecarProxy(path: string): [string, string] | null {
  const m = PROXY_RE.exec(path)
  return m ? [m[1] ?? '', m[2] ?? ''] : null
}

/** Python `_handle_extension_sidecar_proxy`: same-origin browser provenance on every method, header stripping, 10 s, 512 KiB. */
export async function handleExtensionSidecarProxy(ctx: RequestContext, extensionId: string, proxyPath: string): Promise<void> {
  const env = ctx.deps.config.env
  const provenance = checkSameOriginBrowserRequest({ origin: ctx.header('origin'), referer: ctx.header('referer'), secFetchSite: ctx.header('sec-fetch-site'), host: ctx.header('host'), forwardedHost: ctx.header('x-forwarded-host'), realHost: ctx.header('x-real-host') }, env, { requireProvenance: true })
  if (provenance !== null) { ctx.json({ error: csrfRejectionError(provenance) }, { status: 403 }); return }
  // Python matched the id raw (`[^/]+`) and validated it as-is: a percent-malformed id is invalid, and an encoded
  // spelling of a valid id is not accepted either. The sub-path keeps its raw shape (`//`, trailing `/` are invalid).
  const rawTarget = (ctx.req.url ?? '').split('?')[0] ?? ''
  const rawMatch = /^\/api\/extensions\/([^/]+)\/sidecar\/(.*)$/.exec(rawTarget)
  const rawId = rawMatch?.[1] ?? extensionId
  const rawProxyPath = rawMatch?.[2] ?? proxyPath
  if (!validId(rawId)) { ctx.json({ error: 'Invalid extension id' }, { status: 400 }); return }
  if (rawProxyPath !== proxyPath && normalizeProxyPath(rawProxyPath) === null) { ctx.json({ error: 'Invalid sidecar proxy path' }, { status: 400 }); return }
  let body: Buffer | null = null
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
    try { body = await ctx.readRawBody(20 * 1024 * 1024) } catch (error) { ctx.json({ error: str((error as Error).message) }, { status: /too large/i.test(str((error as Error).message)) ? 413 : 400 }); return }
  }
  let target: { origin: string; upstream_url: string }
  try {
    target = await ctx.deps.extensions.proxyTarget(rawId, rawProxyPath, ctx.search.replace(/^\?/, ''))
  } catch (error) {
    if (error instanceof ExtensionError) { ctx.json({ error: error.message }, { status: error.status }); return }
    throw error
  }
  const headers: Record<string, string> = {}
  // Python `_connection_bound_header_names`: every token the request's `Connection:` names is hop-by-hop too.
  const requestBound = connectionBoundNames(ctx.req.headers.connection)
  for (const [name, value] of Object.entries(ctx.req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || requestBound.has(lower) || ['authorization', 'cookie', 'content-length', 'host', 'origin', 'referer'].includes(lower) || lower.startsWith('x-csrf') || lower.startsWith('x-hermes-')) continue
    if (typeof value === 'string') headers[name] = value
  }
  try {
    // Python `_extension_sidecar_proxy_same_origin_opener`: redirects are followed here, never handed to the browser,
    // and every hop must stay on the declared origin (urllib's default hop limit).
    const allowedOrigin = new URL(target.origin).origin
    let url = target.upstream_url
    let method = ctx.method
    let requestBody: Buffer | null = body
    let res: Response
    for (let hop = 0; ; hop += 1) {
      res = await ctx.deps.fetch(url, { method, headers, ...(requestBody ? { body: requestBody } : {}), redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      if (res.status < 300 || res.status >= 400 || !res.headers.has('location')) break
      let resolved: URL | null = null
      try { resolved = new URL(res.headers.get('location') ?? '', url) } catch { resolved = null }
      // Python's opener raised on a cross-origin hop or the hop limit, which surfaced as the generic reach failure.
      if (resolved?.origin !== allowedOrigin || hop >= PROXY_MAX_REDIRECTS) { ctx.json({ error: 'Failed to reach extension sidecar' }, { status: 502 }); return }
      await res.body?.cancel()
      url = resolved.href
      if ((res.status === 301 || res.status === 302 || res.status === 303) && method !== 'GET' && method !== 'HEAD') { method = 'GET'; requestBody = null; delete headers['content-type']; delete headers['Content-Type'] }
    }
    const raw = await readCapped(res, PROXY_MAX_RESPONSE)
    if (raw === null) { ctx.json({ error: 'Extension sidecar response too large' }, { status: 502 }); return }
    const out: Record<string, string> = {}
    let contentType = false
    const responseBound = connectionBoundNames(res.headers.get('connection'))
    res.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower) || responseBound.has(lower) || lower === 'content-length' || lower === 'set-cookie' || lower === 'content-encoding' || lower.startsWith('x-hermes-')) return
      if (lower === 'content-type') contentType = true
      out[name] = value
    })
    if (!contentType) out['Content-Type'] = 'application/octet-stream'
    out['Cache-Control'] = 'no-store'
    ctx.send({ status: res.status, headers: out, body: raw, security: true, gzip: false })
  } catch (error) {
    ctx.deps.log(`[webui] extension sidecar proxy failed: ${str((error as Error).message)}`)
    ctx.json({ error: 'Failed to reach extension sidecar' }, { status: 502 })
  }
}

/** Python `_connection_bound_header_names`: the header names listed in `Connection:` (plus `proxy-connection`). */
function connectionBoundNames(value: string | string[] | null | undefined): Set<string> {
  const names = new Set<string>(['proxy-connection'])
  for (const raw of Array.isArray(value) ? value : value ? [value] : []) for (const token of raw.split(',')) { const t = token.trim().toLowerCase(); if (t) names.add(t) }
  return names
}
