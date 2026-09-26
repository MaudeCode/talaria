/**
 * Per-request state and response helpers (the Python `Handler` attributes plus
 * `api/helpers.j/t`). Every response goes through `send()`, which applies the
 * security headers, CSP report-only policy, sliding-session renewal, queued
 * cookies, and the structured access log.
 */
import type { AsyncLocalStorage } from 'node:async_hooks'
import type { DnsLookup, PinnedFetch } from './pinned.js'
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
import type { GitRunner } from '../workspace/git.js'
import type { RollbackStore } from '../workspace/rollback.js'
import type { UploadInbox } from '../workspace/upload.js'
import type { MediaPolicyDeps } from '../workspace/media.js'
import type { WorktreeLocks } from '../workspace/worktrees.js'
import type { Session } from '../sessions/session.js'
import type { SidecarLike } from '../sidecar/client.js'
import type { TurnRunner } from '../sessions/turn.js'
import type { SessionChannels, StreamRegistry } from '../sessions/streams.js'
import type { PendingPrompts } from '../sessions/pending.js'
import type { RunJournal } from '../sessions/journal.js'
import type { BackgroundTasks } from '../api/chat-router.js'
import type { StreamSlots } from '../api/sse-routes.js'
import type { BootstrapFeatures, ReleaseInfo } from '@maudecode/talaria-web-contracts'
import { buildCspEnforcedPolicy, buildCspReportOnlyPolicy, cspExtras, CSP_REPORT_TO, type CspExtras } from './csp.js'
import type { CsrfFailure } from './origin.js'
import type { AgentConfig } from '../config/agent-config.js'
import type { ProviderCatalog } from '../providers/catalog.js'
import type { ProfileService } from '../profiles/profiles.js'
import type { Onboarding } from '../onboarding.js'
import type { SkillsService } from '../tools/skills.js'
import type { McpService } from '../tools/mcp.js'
import type { WindowLimiter } from '../api/tools-router.js'
import type { CronService } from '../tools/crons.js'
import type { KanbanService } from '../tools/kanban.js'
import type { ExtensionService } from '../tools/extensions.js'
import type { TerminalRegistry } from '../tools/terminal.js'
import type { OidcService } from '../auth/oidc.js'
import type { RelayService } from '../sessions/relay.js'
import type { CliSessionSource } from '../sessions/cli-sessions.js'
import type { CompletionDrain } from '../sessions/completions.js'
import type { HygieneTicker } from '../tools/hygiene.js'
import type { McpHealthProber } from '../tools/mcp-health.js'
import type { GatewayWatcherRegistry } from '../sessions/gateway-watcher.js'
import type { PasskeyStore } from '../auth/passkeys.js'
import type { UpdateService } from '../tools/updates.js'
import type { UpdateNotificationStore } from '../tools/update-notifications.js'

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
  /** The request's profile when called inside `requestScope.run`, else the process default. */
  activeProfile: () => string
  /** Binds `activeProfile()` to the request context for the whole handler (cookie, bound session, and later retags). */
  requestScope: AsyncLocalStorage<{ requestProfile: string | null }>
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
  // ── files, git, media (checkpoint 5b) ──
  git: GitRunner
  rollback: RollbackStore
  uploads: UploadInbox
  mediaPolicy: MediaPolicyDeps
  /** The active workspace for `/api/media` allow-listing when local IO is supported, else null. */
  mediaActiveWorkspace: () => string | null
  worktreeLocks: WorktreeLocks
  /** Commit-message generation (sidecar `aux.complete`); rejects with `GitWorkspaceError` when no model is available. */
  commitMessage: (session: Session, systemPrompt: string, userPrompt: string) => Promise<string>
  // ── chat runtime (checkpoint 6) ──
  sidecar: () => SidecarLike | null
  turns: TurnRunner
  registry: StreamRegistry
  channels: SessionChannels
  pending: PendingPrompts
  journal: RunJournal
  background: BackgroundTasks
  streamSlots: StreamSlots
  // ── settings, profiles, providers, onboarding (checkpoint 7a) ──
  /** Home directory for a logical profile name (root aliases and invalid names clamp to the base home). */
  profileHome: (name: string) => string
  agentConfig: AgentConfig
  catalog: ProviderCatalog
  profiles: ProfileService
  onboarding: Onboarding
  /** Running Agent version from the sidecar handshake, else the pinned version. */
  agentVersion: () => string
  /** Passkey credentials are dropped when password auth is cleared. */
  clearPasskeys: () => void
  // ── tools (checkpoint 7b) ──
  skills: SkillsService
  mcp: McpService
  nowSeconds: () => number
  /** `/api/system/health` `webui_runtime` block (process counters). */
  runtimeDiagnostics: () => Record<string, unknown>
  /** `/api/shutdown`: SIGINT the process shortly after the response is flushed. */
  requestShutdown: () => void
  /** Self-update: exit with the supervisor's restart code once active chat work drains (ticket §13). */
  requestRestart: () => void
  updates: UpdateService
  updateNotifications: UpdateNotificationStore
  cspLimiter: WindowLimiter
  clientEventLimiter: WindowLimiter
  ttsLimiter: WindowLimiter
  fetch: typeof fetch
  /** Vetted outbound (`http/pinned.ts`): DNS answers are checked and the connection is pinned to them. */
  dnsLookup: DnsLookup
  pinnedFetch: PinnedFetch
  // ── workers (checkpoint 7h) ──
  completions: CompletionDrain
  hygiene: HygieneTicker
  mcpHealth: McpHealthProber
  // ── state.db projection and gateway watcher (checkpoint 7f) ──
  cliSessions: CliSessionSource
  gatewayWatchers: GatewayWatcherRegistry
  // ── Talaria Relay (checkpoint 7e) ──
  relay: RelayService
  // ── OIDC and passkeys (checkpoint 7d) ──
  oidc: OidcService
  passkeys: PasskeyStore
  /** Python `_native_oidc_start_rate_limited`: 10 starts per client IP per 60 s. */
  nativeOidcLimiter: WindowLimiter
  // ── crons, kanban, extensions, terminal (checkpoint 7c) ──
  crons: CronService
  kanban: KanbanService
  extensions: ExtensionService
  terminals: TerminalRegistry
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

/** WHATWG-resolved pathname (dot segments collapsed) without a trailing slash; `/` stays `/`. */
export function normalizeRequestPath(raw: string): string {
  let path: string
  try { path = new URL(raw.startsWith('/') ? raw : `/${raw}`, 'http://placeholder').pathname } catch { path = '/' }
  path = path.replace(/\/{2,}/g, '/')
  return path.length > 1 ? path.replace(/\/+$/, '') : path
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
    // One canonical path for the auth gate, CSRF, and routing: dot segments resolved and the trailing slash dropped, so
    // `/api/share/create/` can never reach a handler under a different gate decision than `/api/share/create`.
    this.path = normalizeRequestPath(q >= 0 ? target.slice(0, q) : target)
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
    return acceptsEncoding(this.header('accept-encoding'), 'gzip')
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

  /** Stream a body with backpressure (large file spans); headers and cookies are applied like `send`, the stream owns its source. */
  sendStream(opts: { status?: number; headers?: HeaderMap; security?: boolean }, body: NodeJS.ReadableStream & { destroy?: (error?: Error) => void }): void {
    if (this.finished) return
    this.finished = true
    const status = opts.status ?? 200
    this.refreshSessionForResponse(status)
    const headers: HeaderMap = {}
    if (opts.security ?? true) Object.assign(headers, this.securityHeaders())
    Object.assign(headers, opts.headers ?? {})
    headers['Content-Security-Policy-Report-Only'] = buildCspReportOnlyPolicy(this.cspExtras)
    headers['Report-To'] = CSP_REPORT_TO
    const cookies = [...(Array.isArray(headers['Set-Cookie']) ? headers['Set-Cookie'] : headers['Set-Cookie'] ? [headers['Set-Cookie']] : []), ...this.pendingCookies]
    this.pendingCookies = []
    if (cookies.length) headers['Set-Cookie'] = cookies
    this.res.writeHead(status, headers)
    if (this.method === 'HEAD') { body.destroy?.(); this.res.end(); this.logRequest(status); return }
    this.res.on('close', () => { body.destroy?.() })
    body.on('error', () => { this.res.destroy() })
    body.pipe(this.res)
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
  /** The request body as bytes, bounded by `maxBytes`. */
  async readRawBody(maxBytes: number): Promise<Buffer> {
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
    return Buffer.concat(chunks)
  }

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

/**
 * RFC 9110 `Accept-Encoding` negotiation for one coding: a listed coding with `q=0` (or `*;q=0` with the coding
 * unlisted) is unacceptable; a plain listing or a positive quality accepts it.
 */
export function acceptsEncoding(header: string | undefined, coding: string): boolean {
  if (!header) return false
  let wildcard: number | null = null
  for (const part of header.split(',')) {
    const [rawName = '', ...params] = part.trim().split(';')
    const name = rawName.trim().toLowerCase()
    if (!name) continue
    let q = 1
    for (const param of params) {
      const [key = '', value = ''] = param.split('=')
      if (key.trim().toLowerCase() === 'q') { const parsed = Number.parseFloat(value.trim()); q = Number.isFinite(parsed) ? parsed : 0 }
    }
    if (name === coding) return q > 0
    if (name === '*') wildcard = q
  }
  return wildcard !== null && wildcard > 0
}
