/**
 * Per-request state and response helpers (the Python `Handler` attributes plus
 * `api/helpers.j/t`). Every response goes through `send()`, which applies the
 * security headers, CSP report-only policy, sliding-session renewal, queued
 * cookies, and the structured access log.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { gzipSync } from 'node:zlib'
import type { ServerConfig } from '../config.js'
import { truthy } from '../config.js'
import { parseCookieHeader } from '../auth/cookies.js'
import type { AuthStore, SessionInfo } from '../auth/store.js'
import type { SettingsStore } from '../settings.js'
import type { AssetCache, SpaShell } from '../spa.js'
import type { StartupGate } from '../startup.js'
import type { SessionService } from '../sessions/service.js'
import type { SessionStore } from '../sessions/store.js'
import type { SessionEventBus } from '../sessions/events.js'
import type { ProjectStore } from '../projects.js'
import type { WorkspaceRegistry } from '../workspace/workspaces.js'
import type { BootstrapFeatures, ReleaseInfo } from '@maudecode/talaria-web-contracts'
import { buildCspEnforcedPolicy, buildCspReportOnlyPolicy, cspExtras, CSP_REPORT_TO, type CspExtras } from './csp.js'
import type { CsrfFailure } from './origin.js'

export interface AppDeps {
  config: ServerConfig
  settings: SettingsStore
  auth: AuthStore
  startup: StartupGate
  spa: SpaShell
  /** Files under `static/` outside `dist/` (brand icons, extension SDK). */
  staticFiles: AssetCache
  release: ReleaseInfo
  version: string
  /** Seconds since the epoch when the server started. */
  startedAt: number
  log: (line: string) => void
  /** Accept-loop counters for `/health`. */
  stats: { requestsTotal: number; lastRequestAt: number }
  /** Later checkpoints replace these seams with the real domains. */
  features: () => BootstrapFeatures
  /** Process-global active profile (profile domain, checkpoint 7). */
  activeProfile: () => string
  isRootProfile: (name: string) => boolean
  onboardingCompleted: () => boolean
  /** Counts for `/health`: sessions and live runs (checkpoints 5/6). */
  health: () => { sessions: number; activeStreams: number; activeRuns: number; runs: Record<string, unknown>[]; lastRunFinishedAt: number | null }
  // ── session domain (checkpoint 5) ──
  sessions: SessionService
  sessionStore: SessionStore
  events: SessionEventBus
  projects: ProjectStore
  workspaces: WorkspaceRegistry
  /** Python `_is_isolated_profile_mode` / `_profiles_match` (profile domain, checkpoint 7). */
  isolatedProfileMode: () => boolean
  profilesMatch: (row: string | null | undefined, active: string | null | undefined) => boolean
  /** Agent config `worktree:` default for a profile. */
  worktreeDefault: (profile: string | null) => boolean
  /** Worktree creation goes through the Agent (sidecar method, checkpoint 5b). */
  worktrees: { create: (workspace: string) => Promise<{ path: string; branch: string; repo_root: string; created_at: number }> }
  /** `vscode:` block from config.yaml: command lookup and Docker path translation. */
  vscode: () => VsCodeConfig
}

export interface VsCodeConfig {
  configuredCommand: string
  command: () => string | null
  translate: (path: string) => string
}

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export function validProfileName(name: string): boolean {
  return name === 'default' || PROFILE_ID_RE.test(name)
}

export type HeaderMap = Record<string, string | string[]>

export interface SendOptions {
  status?: number
  headers?: HeaderMap
  body?: Buffer | string
  /** Emit the security-header set (Python `_security_headers`). */
  security?: boolean
  /** Gzip bodies over 1 KiB when the client accepts it. */
  gzip?: boolean
}

export class RequestContext {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly deps: AppDeps
  readonly method: string
  /** Raw request path, not normalised (Python `urlparse` semantics, so `/assets/../x` stays a traversal probe). */
  readonly path: string
  readonly search: string
  private queryParams: URLSearchParams | null = null
  readonly startedAtMs = Date.now()
  readonly peer: string
  pendingCookies: string[] = []
  authRefreshCookie: string | null = null
  requestProfile: string | null = null
  csrfFailure: CsrfFailure = null
  /** Headers a `RawResponse` asks the oRPC layer to add. */
  extraResponseHeaders: Record<string, string> = {}
  /** Set by a procedure whose ETag matched `If-None-Match`; the root interceptor turns the response into a bodiless 304. */
  notModified = false
  trusted: { reconciled?: SessionInfo | null; info?: SessionInfo | null; cookieValue?: string | null; rejected?: boolean } = {}
  readonly cspExtras: CspExtras
  private cookieMap: Map<string, string> | null = null
  private finished = false

  constructor(req: IncomingMessage, res: ServerResponse, deps: AppDeps) {
    this.req = req
    this.res = res
    this.deps = deps
    this.method = (req.method ?? 'GET').toUpperCase()
    const raw = req.url ?? '/'
    const hash = raw.indexOf('#')
    const target = hash >= 0 ? raw.slice(0, hash) : raw
    const q = target.indexOf('?')
    this.path = q >= 0 ? target.slice(0, q) : target
    this.search = q >= 0 ? target.slice(q) : ''
    this.peer = req.socket.remoteAddress ?? ''
    this.cspExtras = cspExtras(deps.config.env, (line) => { deps.log(`[webui] WARNING: ${line}`) })
  }

  get query(): URLSearchParams {
    this.queryParams ??= new URLSearchParams(this.search)
    return this.queryParams
  }

  header(name: string): string | undefined {
    const value = this.req.headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }

  headerAll(name: string): string[] {
    const value = this.req.headers[name.toLowerCase()]
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }

  get cookies(): Map<string, string> {
    this.cookieMap ??= parseCookieHeader(this.header('cookie'))
    return this.cookieMap
  }

  /** The raw auth cookie value, if present. */
  authCookie(): string | null {
    return this.cookies.get(this.deps.auth.cookieName()) ?? null
  }

  acceptsGzip(): boolean {
    return (this.header('accept-encoding') ?? '').includes('gzip')
  }

  /** Python `_is_secure_context`: env override, direct TLS, opt-in forwarded proto. */
  isSecureContext(): boolean {
    const env = (this.deps.config.env.HERMES_WEBUI_SECURE ?? '').trim().toLowerCase()
    if (['1', 'true', 'yes'].includes(env)) return true
    if (['0', 'false', 'no'].includes(env)) return false
    if ((this.req.socket as TLSSocket).encrypted) return true
    if (truthy(this.deps.config.env.HERMES_WEBUI_TRUST_FORWARDED_PROTO) && this.header('x-forwarded-proto') === 'https') return true
    return false
  }

  queueCookie(header: string): void {
    if (header) this.pendingCookies.push(header)
  }

  /** Sliding renewal on a successful response (Python `refresh_session_for_response`). */
  private refreshSessionForResponse(status: number): void {
    const cookieValue = this.authRefreshCookie
    this.authRefreshCookie = null
    if (!cookieValue || status < 200 || status >= 400) return
    const auth = this.deps.auth
    if (!auth.resolveSessionSliding()) return
    const ttl = auth.resolveSessionTtl()
    if (auth.extendSession(cookieValue, ttl)) this.queueCookie(this.authCookieHeader(cookieValue, ttl))
  }

  authCookieHeader(cookieValue: string, ttl?: number): string {
    const auth = this.deps.auth
    const parts = [`${auth.cookieName()}=${cookieValue}`, 'HttpOnly', `Max-Age=${ttl ?? auth.resolveSessionTtl()}`, 'Path=/', 'SameSite=Lax']
    if (this.isSecureContext()) parts.push('Secure')
    return parts.join('; ')
  }

  securityHeaders(): HeaderMap {
    return {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': buildCspEnforcedPolicy(this.cspExtras),
      'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), clipboard-write=(self)',
    }
  }

  send(opts: SendOptions): void {
    if (this.finished) return
    this.finished = true
    const status = opts.status ?? 200
    this.refreshSessionForResponse(status)
    const headers: HeaderMap = {}
    if (opts.security ?? true) Object.assign(headers, this.securityHeaders())
    Object.assign(headers, opts.headers ?? {})
    let body = opts.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8')
    if (opts.gzip && body.length > 1024 && this.acceptsGzip()) {
      body = gzipSync(body, { level: 4 })
      headers['Content-Encoding'] = 'gzip'
    }
    headers['Content-Length'] = String(body.length)
    headers['Content-Security-Policy-Report-Only'] = buildCspReportOnlyPolicy(this.cspExtras)
    headers['Report-To'] = CSP_REPORT_TO
    const cookies = [...(Array.isArray(headers['Set-Cookie']) ? headers['Set-Cookie'] : headers['Set-Cookie'] ? [headers['Set-Cookie']] : []), ...this.pendingCookies]
    this.pendingCookies = []
    if (cookies.length) headers['Set-Cookie'] = cookies
    this.res.writeHead(status, headers)
    this.res.end(this.method === 'HEAD' ? undefined : body)
    this.logRequest(status)
  }

  logRequest(status: number): void {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      remote: this.peer || '-',
      method: this.method,
      path: this.req.url ?? '-',
      status,
      ms: Math.round((Date.now() - this.startedAtMs) * 10) / 10,
    }
    const forwardedFor = (this.header('x-forwarded-for') ?? '').split(',')[0]?.trim()
    if (forwardedFor) record.forwarded_for = forwardedFor
    this.deps.log(`[webui] ${JSON.stringify(record)}`)
  }

  /** Sliding renewal and queued-cookie flush for a response the oRPC adapter writes. */
  beforeOrpcResponse(status: number): void {
    this.refreshSessionForResponse(status)
  }

  /** Called by the pipeline for responses written outside `send()` (oRPC). */
  markFinished(status: number): void {
    if (this.finished) return
    this.finished = true
    this.logRequest(status)
  }

  get isFinished(): boolean {
    return this.finished
  }

  json(payload: unknown, opts: { status?: number; headers?: HeaderMap; security?: boolean; etag?: string; pretty?: boolean } = {}): void {
    const status = opts.status ?? 200
    if (opts.etag && status === 200 && ifNoneMatchMatches(this.header('if-none-match') ?? '', opts.etag)) {
      this.send({ status: 304, headers: { ETag: opts.etag, 'Cache-Control': 'no-store', ...opts.headers }, security: opts.security ?? true })
      return
    }
    const body = opts.pretty === false ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)
    const headers: HeaderMap = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...opts.headers }
    if (opts.etag) headers.ETag = opts.etag
    this.send({ status, headers, body, gzip: true, security: opts.security ?? true })
  }

  /** Bare `{"error":...}` responses the Python auth gate wrote without the security-header set. */
  rawJson(status: number, payload: unknown, headers: HeaderMap = {}): void {
    this.send({ status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), security: false })
  }

  text(body: string | Buffer, opts: { status?: number; contentType?: string; headers?: HeaderMap } = {}): void {
    this.send({ status: opts.status ?? 200, headers: { 'Content-Type': opts.contentType ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...opts.headers }, body })
  }

  redirect(location: string, opts: { status?: number; headers?: HeaderMap; security?: boolean } = {}): void {
    this.send({ status: opts.status ?? 302, headers: { Location: location, ...opts.headers }, security: opts.security ?? true })
  }

  /** Read and JSON-parse the request body as an object (Python `read_body`, 20 MiB cap). */
  async readJsonBody(maxBytes = 20 * 1024 * 1024): Promise<Record<string, unknown>> {
    const rawLength = this.header('content-length')
    const length = rawLength === undefined ? 0 : Number(rawLength)
    if (!Number.isInteger(length) || length < 0) throw new BodyError(`Invalid Content-Length: ${JSON.stringify(rawLength)}`)
    if (length > maxBytes) throw new BodyError(`Request body too large (${length} bytes, max ${maxBytes})`)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of this.req) {
      const buf = chunk as Buffer
      total += buf.length
      if (total > maxBytes) throw new BodyError(`Request body too large (${total} bytes, max ${maxBytes})`)
      chunks.push(buf)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BodyError('Invalid JSON body')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError('JSON body must be an object')
    return parsed as Record<string, unknown>
  }
}

export class BodyError extends Error {}

/** RFC 7232 3.2 weak comparison; `W/` prefixes are ignored on both sides. */
export function ifNoneMatchMatches(headerValue: string, etag: string): boolean {
  if (!headerValue || !etag) return false
  if (headerValue.trim() === '*') return true
  const strip = (v: string) => (v.startsWith('W/') ? v.slice(2) : v)
  const current = strip(etag)
  return headerValue.split(',').map((c) => c.trim()).filter(Boolean).some((c) => strip(c) === current)
}
