/**
 * The request pipeline (Python `server.py` `Handler.do_*`): profile cookie,
 * sandboxed-origin rejection, the auth gate, the startup gate, SPA/static,
 * then the oRPC router; JSON 404 for anything else and JSON 500 on faults.
 */
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ORPCError, type Router } from '@orpc/server'
import type { AnyContractRouter } from '@orpc/contract'
import { OpenAPIHandler } from '@orpc/openapi/node'
import { sessionsRouter } from './api/sessions-router.js'
import { gitRouter } from './api/git-router.js'
import { handleWorkspacePreview, RAW_GET_ROUTES, RAW_POST_ROUTES, runRaw } from './api/raw-routes.js'
import { PREVIEW_PREFIX } from './workspace/preview.js'
import { chatRouter } from './api/chat-router.js'
import { settingsRouter } from './api/settings-router.js'
import { toolsRouter } from './api/tools-router.js'
import { automationRouter } from './api/automation-router.js'
import { handleDashboardPlugin, handleExtensionSidecarProxy, handleExtensionStatic, handleKanbanEventsStream, handleTerminalOutput, matchSidecarProxy } from './api/automation-raw.js'
import { handleApprovalStream, handleChatStream, handleClarifyStream, handleGatewayStream, handleSessionEvents, handleSessionJournalStream, handleSessionStream, sessionEventsPathSessionId } from './api/sse-routes.js'
import { BodyError, RequestContext, acceptsEncoding, loggedUrl, type AppDeps, type HeaderMap } from './http/context.js'
import { activeProfileName, checkAuth, checkCsrf, clearProfileCookieHeader, csrfError, getProfileCookie, isCsrfExemptPath, isPublicPath } from './auth/gate.js'
import { guardQuerySessionId } from './api/session-visibility.js'
import { checkSameOriginBrowserRequest } from './http/origin.js'
import { coreRouter, HttpError, errorResponseBody, errorResponseHeaders, shellLanguage, startupUnavailable, type ApiContext } from './api/router.js'
import { isSpaPath } from './spa.js'
import { buildCspReportOnlyPolicy, CSP_REPORT_TO } from './http/csp.js'
import { STARTUP_IMMEDIATE_PATHS } from './startup.js'
import { escapedProfileMessage } from './profiles/profiles.js'

const SHELL_ERROR_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes is restarting</title>
</head>
<body style="margin:0;padding:2rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111827;color:#e5e7eb;">
  <main style="max-width:40rem;margin:10vh auto;line-height:1.5;">
    <h1 style="font-size:1.5rem;margin:0 0 0.75rem;">Hermes is restarting…</h1>
    <p style="margin:0;color:#cbd5e1;">The WebUI shell could not load cleanly. Refresh in a moment if this page does not update automatically.</p>
  </main>
</body>
</html>`

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export interface App {
  deps: AppDeps
  handler: RequestHandler
}

function sendBytes(ctx: RequestContext, body: Buffer, contentType: string, opts: { cacheControl: string; headers?: HeaderMap; gz?: Buffer | null; etag?: string }): void {
  if (opts.etag && ctx.header('if-none-match') === opts.etag) {
    ctx.send({ status: 304, headers: { ETag: opts.etag, 'Cache-Control': opts.cacheControl } })
    return
  }
  const headers: HeaderMap = { 'Content-Type': contentType, 'Cache-Control': opts.cacheControl, Vary: 'Accept-Encoding', ...opts.headers }
  if (opts.etag) headers.ETag = opts.etag
  let payload = body
  if (opts.gz && ctx.acceptsGzip()) {
    headers['Content-Encoding'] = 'gzip'
    payload = opts.gz
  }
  ctx.send({ status: 200, headers, body: payload })
}

function notFound(ctx: RequestContext): void {
  // Python `handle_kanban_*`: an unknown Kanban path names itself and points at a stale cached bundle.
  if (ctx.path.startsWith('/api/kanban/') || ctx.path === '/api/kanban') {
    ctx.json({ error: `unknown Kanban endpoint: ${ctx.method} ${ctx.path}. If this appeared after a WebUI update, your browser may be running a stale cached bundle; use Hard refresh now, then reopen Kanban.` }, { status: 404 })
    return
  }
  ctx.json({ error: 'not found' }, { status: 404 })
}

/** Serve the shell, hashed assets, service worker, and manifest; false when the path is not a frontend route. */
function handleSpa(ctx: RequestContext): boolean {
  const { spa, version } = ctx.deps
  const path = ctx.path
  if (path === '/sw.js') {
    const sw = spa.serviceWorker(version)
    if (sw) sendBytes(ctx, sw, 'application/javascript; charset=utf-8', { cacheControl: 'no-store', headers: { 'Service-Worker-Allowed': '/' } })
    else notFound(ctx)
    return true
  }
  const distFile = (rel: string, cacheControl?: string) => {
    const asset = spa.asset(rel)
    if (!asset) {
      notFound(ctx)
      return true
    }
    const cc = cacheControl ?? (rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    sendBytes(ctx, asset.body, asset.contentType, { cacheControl: cc, gz: asset.gz, etag: asset.etag })
    return true
  }
  if (['/manifest.json', '/manifest.webmanifest', '/session/manifest.json', '/session/manifest.webmanifest'].includes(path)) return distFile('manifest.webmanifest', 'no-cache')
  if (path.startsWith('/assets/')) return distFile(path.slice(1))
  if (path.startsWith('/static/dist/')) return distFile(path.slice('/static/dist/'.length))
  // Legacy alias: `/session/static/<rel>` is `/static/<rel>` (deep-linked shells before the relative base href).
  const staticRel = path.startsWith('/static/') ? path.slice('/static/'.length) : path.startsWith('/session/static/') ? path.slice('/session/static/'.length) : null
  if (staticRel !== null) {
    const asset = ctx.deps.staticFiles.get(staticRel)
    if (!asset) {
      notFound(ctx)
      return true
    }
    // A `?v=<version>` fingerprint makes the URL immutable; `unknown` and a digest-less `-dirty` are not fingerprints.
    const token = ctx.query.get('v') ?? ''
    const fingerprinted = token !== '' && token !== 'unknown' && !token.endsWith('-dirty')
    sendBytes(ctx, asset.body, asset.contentType, { cacheControl: fingerprinted ? 'public, max-age=31536000, immutable' : 'public, max-age=300', gz: asset.gz, etag: asset.etag })
    return true
  }
  if (isSpaPath(path)) {
    if (!spa.available()) {
      ctx.deps.log('[webui] WARNING: Failed to serve WebUI shell route: static/dist/index.html is missing')
      ctx.text(SHELL_ERROR_HTML, { status: 503, contentType: 'text/html; charset=utf-8' })
      return true
    }
    const extra: HeaderMap = { 'X-Frame-Options': 'DENY' }
    if (path === '/share' || path.startsWith('/share/')) extra['X-Robots-Tag'] = 'noindex, nofollow'
    try {
      const html = Buffer.from(spa.renderShell(path, { lang: shellLanguage(ctx) || 'en', version }), 'utf8')
      sendBytes(ctx, html, 'text/html; charset=utf-8', { cacheControl: 'no-store', headers: extra })
    } catch (error) {
      ctx.deps.log(`[webui] WARNING: Failed to serve WebUI shell route: ${String(error)}`)
      ctx.text(SHELL_ERROR_HTML, { status: 503, contentType: 'text/html; charset=utf-8' })
    }
    return true
  }
  return false
}

function serveFavicon(ctx: RequestContext): void {
  try {
    const data = readFileSync(resolve(ctx.deps.config.staticRoot, 'brand', 'favicon.ico'))
    ctx.send({ status: 200, headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' }, body: data })
  } catch {
    notFound(ctx)
  }
}

function preflight(ctx: RequestContext): void {
  const origin = (ctx.header('origin') ?? '').trim()
  const headers: HeaderMap = {}
  const allowed = origin && checkSameOriginBrowserRequest(
    { origin, referer: ctx.header('referer'), host: ctx.header('host'), secFetchSite: ctx.header('sec-fetch-site'), forwardedHost: ctx.header('x-forwarded-host'), realHost: ctx.header('x-real-host') },
    ctx.deps.config.env,
  ) === null
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
  }
  ctx.send({ status: 200, headers, security: false })
}

/** Every implemented procedure, keyed like the contract. */
const appRouter = { ...coreRouter, ...sessionsRouter, ...gitRouter, ...chatRouter, ...settingsRouter, ...toolsRouter, ...automationRouter }

const SSE_GET_ROUTES: Record<string, (ctx: RequestContext) => Promise<void>> = {
  '/api/chat/stream': handleChatStream,
  '/api/session/stream': handleSessionStream,
  '/api/sessions/events': handleSessionEvents,
  '/api/sessions/gateway/stream': handleGatewayStream,
  '/api/kanban/events/stream': handleKanbanEventsStream,
  '/api/terminal/output': handleTerminalOutput,
  '/api/approval/stream': handleApprovalStream,
  '/api/clarify/stream': handleClarifyStream,
}

export interface CreateAppOptions {
  /** The implemented contract router; defaults to the core router. */
  router?: Router<AnyContractRouter, ApiContext>
}

const ORPC_MAX_BODY_BYTES = 20 * 1024 * 1024
/** Python `_read_json_request_body(max_bytes=4096)`: routes with their own smaller cap answer 400, as that reader did. */
const ROUTE_BODY_CAPS: Record<string, number> = { '/api/escape/authorize': 4096 }

function bodyCap(path: string): { bytes: number; status: number } {
  const bytes = ROUTE_BODY_CAPS[path]
  return bytes === undefined ? { bytes: ORPC_MAX_BODY_BYTES, status: 413 } : { bytes, status: 400 }
}
const GZIP_MIN_BYTES = 1024

/**
 * Cap the bytes oRPC may buffer from a request body: a chunked body carries no `Content-Length`, so the declared-size
 * check cannot bound it. Counting in `emit` keeps the stream in whatever mode oRPC's reader puts it; once over the
 * limit the reader sees a `BodyError` (answered with its status by the root interceptor) and the rest of the body is dropped.
 */
function boundRequestBody(req: IncomingMessage, cap: { bytes: number; status: number }): () => void {
  if (req.method === 'GET' || req.method === 'HEAD') return () => undefined
  const originalEmit = req.emit.bind(req)
  let total = 0
  let tripped = false
  req.emit = ((event: string, ...args: unknown[]): boolean => {
    if (event === 'data' && !tripped) {
      total += (args[0] as Buffer).length
      if (total > cap.bytes) {
        tripped = true
        return originalEmit('error', new BodyError(`Request body too large (${String(total)} bytes, max ${String(cap.bytes)})`, cap.status))
      }
    }
    if (tripped && (event === 'data' || event === 'end')) return false
    return originalEmit(event, ...args)
  }) as typeof req.emit
  return () => { req.emit = originalEmit }
}

/** Buffer a JSON response written by oRPC and gzip it when the client accepts gzip and the body exceeds 1 KiB. */
function gzipJsonResponse(req: { headers: IncomingHttpHeaders }, res: ServerResponse): void {
  const accept = req.headers['accept-encoding']
  if (!acceptsEncoding(Array.isArray(accept) ? accept.join(',') : accept, 'gzip')) return
  const writeHead = res.writeHead.bind(res)
  const end = res.end.bind(res)
  let pending: [number, OutgoingHttpHeaders | undefined] | null = null
  let armed = true
  const flush = (): void => { if (pending) { writeHead(pending[0], pending[1]); pending = null } }
  res.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => {
    if (!armed) return writeHead(status, headers)
    pending = [status, headers]
    return res
  }) as typeof res.writeHead
  const originalWrite = res.write.bind(res)
  res.write = ((chunk: unknown, ...rest: unknown[]) => { armed = false; flush(); return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest) }) as typeof res.write
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (armed && pending && typeof chunk === 'string') {
      const headers = pending[1] ?? {}
      const ct = headers['content-type']
      const type = typeof ct === 'string' ? ct : ''
      const body = Buffer.from(chunk, 'utf8')
      if (type.startsWith('application/json') && body.length > GZIP_MIN_BYTES && !headers['content-encoding']) {
        const gz = gzipSync(body, { level: 4 })
        pending = [pending[0], { ...headers, 'content-encoding': 'gzip', 'content-length': String(gz.length), vary: 'Accept-Encoding' }]
        armed = false
        flush()
        return end(gz)
      }
    }
    armed = false
    flush()
    return (end as (...a: unknown[]) => ServerResponse)(chunk, ...rest)
  }) as typeof res.end
}

export function createApp(deps: AppDeps, opts: CreateAppOptions = {}): App {
  const orpc = new OpenAPIHandler(opts.router ?? appRouter, {
    customErrorResponseBodyEncoder: (error: ORPCError<string, unknown>) => errorResponseBody(error),
    // Python `j()` gzipped any JSON body over 1 KiB for clients that accept it; oRPC serialises below the standard
    // handler, so the node response is wrapped here.
    adapterInterceptors: [
      async (options) => {
        const unbind = boundRequestBody(options.request as IncomingMessage, bodyCap(options.context.ctx.path))
        gzipJsonResponse(options.request, options.response as ServerResponse)
        try {
          return await options.next()
        } finally {
          unbind()
        }
      },
    ],
    // Root level: oRPC converts thrown errors into responses below `interceptors`, so only here do error responses get the shared headers.
    rootInterceptors: [
      async (options) => {
        // Python handlers read `?board=` / `?dry_run=` on POST/PATCH/DELETE as well as the JSON body (the iOS app sends
        // kanban arguments only as query items); oRPC's compact decode reads the body alone for non-GET, so the query
        // is merged in as the fallback for keys the body does not carry.
        const request = options.request
        const readBody = request.body
        // A body the byte cap tripped surfaces as the Python 413, not oRPC's generic 500.
        request.body = async () => {
          try {
            return await readBody()
          } catch (error) {
            if (error instanceof BodyError) throw new HttpError(error.status, error.message)
            throw error
          }
        }
        if (request.method !== 'GET' && request.url.searchParams.size > 0) {
          const query = Object.fromEntries(request.url.searchParams)
          const original = request.body
          request.body = async () => {
            const data = await original()
            if (data === undefined) return query
            if (data && typeof data === 'object' && !Array.isArray(data)) return { ...query, ...(data as Record<string, unknown>) }
            return data
          }
        }
        const result = await options.next()
        if (!result.matched) return result
        const { ctx } = options.context
        const headers = result.response.headers
        Object.assign(headers, lowerKeys(ctx.securityHeaders()))
        headers['cache-control'] = 'no-store'
        headers['content-security-policy-report-only'] = buildCspReportOnlyPolicy(ctx.cspExtras)
        headers['report-to'] = CSP_REPORT_TO
        const status = result.response.status
        ctx.beforeOrpcResponse(status)
        Object.assign(headers, lowerKeys(ctx.extraResponseHeaders))
        if (ctx.pendingCookies.length) {
          headers['set-cookie'] = [...ctx.pendingCookies]
          ctx.pendingCookies = []
        }
        if (ctx.notModified) return { ...result, response: { ...result.response, status: 304, body: undefined } }
        return result
      },
    ],
    clientInterceptors: [
      async (options) => {
        try {
          return await options.next()
        } catch (error) {
          if (error instanceof ORPCError) {
            const extra = errorResponseHeaders(error as ORPCError<string, unknown>)
            if (Object.keys(extra).length) options.context.ctx.extraResponseHeaders = extra
            throw error
          }
          options.context.ctx.deps.log(`[webui] ERROR ${options.context.ctx.method} ${loggedUrl(options.context.ctx.req.url)}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
          throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Internal server error' })
        }
      },
    ],
  })

  const handler: RequestHandler = (req, res) => {
    const ctx = new RequestContext(req, res, deps)
    return deps.requestScope.run(ctx, () => dispatch(ctx))
  }

  const dispatch = async (ctx: RequestContext): Promise<void> => {
    const { req, res } = ctx
    deps.stats.requestsTotal += 1
    deps.stats.lastRequestAt = Date.now() / 1000
    let releaseWrite: (() => void) | null = null
    try {
      if (ctx.method === 'OPTIONS') {
        preflight(ctx)
        return
      }
      // A cookie naming a profile whose home now resolves outside the profiles root is dropped, like an invalid name.
      const profile = await getProfileCookie(ctx)
      if (profile && deps.profiles.escapes(profile)) ctx.queueCookie(clearProfileCookieHeader(ctx))
      else if (profile) ctx.requestProfile = profile
      const path = ctx.path
      if (path.startsWith('/api/') && (ctx.header('origin') ?? '').trim().toLowerCase() === 'null') {
        ctx.rawJson(403, { error: 'Sandboxed documents cannot call the API directly' })
        return
      }
      const isCspReport = path === '/api/csp-report' && ctx.method === 'POST'
      if (!isCspReport && !(await checkAuth(ctx))) return
      // Python `_startup_exempt`: the public surface (login, auth status, OIDC, passkeys, share reads) answers during recovery.
      if (!deps.startup.ready && path.startsWith('/api/') && !STARTUP_IMMEDIATE_PATHS.has(path) && !isPublicPath(path) && !(await deps.startup.wait())) {
        startupUnavailable(ctx)
        return
      }
      // Python ran `_check_csrf` before `_guard_request_session_visibility`: a cross-origin unsafe request answers 403
      // even when it names a foreign session id.
      const unsafe = ctx.method !== 'GET' && ctx.method !== 'HEAD'
      if (unsafe && path.startsWith('/api/') && !isCspReport && !isCsrfExemptPath(path) && !(await checkCsrf(ctx))) {
        ctx.json({ error: csrfError(ctx.csrfFailure) }, { status: 403 })
        return
      }
      if (path.startsWith('/api/') && !guardQuerySessionId(ctx)) return
      // A bound or process-wide profile whose home resolves outside the profiles root is refused rather than served from
      // the root home `profileHome` clamps it to; listing profiles and switching away stay open.
      if (path.startsWith('/api/') && !isPublicPath(path) && path !== '/api/profile/switch' && path !== '/api/profiles' && deps.profiles.escapes(activeProfileName(ctx))) {
        ctx.json({ error: escapedProfileMessage(activeProfileName(ctx)) }, { status: 400 })
        return
      }
      // A profile-scoped write racing that profile's deletion RPC could resurrect a partially populated home
      // (`config.set` recreates the parent): every unsafe request under a profile holds a write lease for its
      // lifetime — deletion waits for leases to drain, and a request arriving during deletion is refused (409).
      // The delete route is the lifecycle owner (mark + drain), so it must not lease the profile it is deleting.
      if (unsafe && path.startsWith('/api/') && path !== '/api/profile/delete' && path !== '/api/profile/switch') {
        const lease = deps.profiles.beginWrite(activeProfileName(ctx))
        if (lease === 'deleting') {
          ctx.json({ error: `Profile '${activeProfileName(ctx)}' is being deleted.` }, { status: 409 })
          return
        }
        if (lease === 'missing') {
          ctx.json({ error: `Profile '${activeProfileName(ctx)}' does not exist.` }, { status: 404 })
          return
        }
        if (lease === 'unreadable') {
          ctx.json({ error: 'Profile deletion records are unreadable; retry in a moment.' }, { status: 503 })
          return
        }
        releaseWrite = lease
      }
      // The synchronous local-I/O and workspace gates read the profile's last-known config and fail closed while it
      // is unresolved; settle it here (a cache hit is one stat) so an edited config.yaml costs one RPC, not a request.
      if (path.startsWith('/api/')) await deps.agentConfig.read(deps.profileHome(deps.activeProfile())).catch(() => undefined)
      if (ctx.method === 'GET' || ctx.method === 'HEAD') {
        if (handleSpa(ctx)) return
        if (path.startsWith('/extensions/')) {
          handleExtensionStatic(ctx)
          return
        }
        if (path.startsWith(PREVIEW_PREFIX)) {
          await runRaw(ctx, handleWorkspacePreview)
          return
        }
        if (path === '/favicon.ico') {
          serveFavicon(ctx)
          return
        }
        if (handleDashboardPlugin(ctx)) return
        const raw = RAW_GET_ROUTES[path]
        if (raw) {
          await runRaw(ctx, raw)
          return
        }
        const sse = SSE_GET_ROUTES[path]
        if (sse) {
          await sse(ctx)
          return
        }
        const journalSessionId = sessionEventsPathSessionId(path)
        if (journalSessionId !== null) {
          await handleSessionJournalStream(ctx, journalSessionId)
          return
        }
        if (RAW_POST_ROUTES[path]) {
          ctx.json({ error: `POST required for ${path}` }, { status: 405 })
          return
        }
      } else if (ctx.method === 'POST') {
        const raw = RAW_POST_ROUTES[path]
        if (raw) {
          await runRaw(ctx, raw)
          return
        }
      }
      // The extension sidecar proxy dispatches only after the CSRF check above has run for unsafe methods (Python
      // ran `_check_csrf` before `_handle_extension_sidecar_proxy`).
      const sidecarProxy = matchSidecarProxy(path)
      if (sidecarProxy) {
        await handleExtensionSidecarProxy(ctx, sidecarProxy[0], sidecarProxy[1])
        return
      }
      // Python `read_body` refused any declared body over 20 MiB before reading it (`handle_post` → 413).
      const declared = Number(ctx.header('content-length') ?? '0')
      const cap = bodyCap(path)
      if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && Number.isFinite(declared) && declared > cap.bytes) {
        ctx.json({ error: `Request body too large (${String(declared)} bytes, max ${String(cap.bytes)})` }, { status: cap.status })
        return
      }
      const { matched } = await orpc.handle(req, res, { context: { ctx } })
      if (matched) {
        ctx.markFinished(res.statusCode)
        return
      }
      notFound(ctx)
    } catch (error) {
      if (ctx.isFinished) return
      deps.log(`[webui] ERROR ${ctx.method} ${loggedUrl(req.url)}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      try {
        ctx.json({ error: 'Internal server error' }, { status: 500 })
      } catch {
        /* client gone */
      }
    } finally {
      releaseWrite?.()
    }
  }
  return { deps, handler }
}

function lowerKeys(headers: HeaderMap): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}
