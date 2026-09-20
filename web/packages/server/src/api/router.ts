/**
 * Implementation of the core route contract. Procedures receive the
 * `RequestContext` and may throw `HttpError` for a byte-compatible
 * `{"error": ...}` body, or `RawResponse` to emit an arbitrary payload/status.
 */
import { implement, ORPCError } from '@orpc/server'
import { coreContract, type AuthStatus, type Bootstrap, type Health } from '@maudecode/talaria-web-contracts'
import type { RequestContext } from '../http/context.js'
import { authStatusPayload, clearAuthCookieHeader, clearProfileCookieHeader, ensureTrustedAuthSession } from '../auth/gate.js'
import { STARTUP_RECOVERY_CONDITION } from '../startup.js'

export interface ApiContext { ctx: RequestContext }

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_CONTENT', 429: 'TOO_MANY_REQUESTS', 500: 'INTERNAL_SERVER_ERROR', 501: 'NOT_IMPLEMENTED', 503: 'SERVICE_UNAVAILABLE',
}

/** `{"error": message, ...extra}` with the given status (Python `bad()`). */
export class HttpError extends ORPCError<string, Record<string, unknown>> {
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(STATUS_CODES[status] ?? 'INTERNAL_SERVER_ERROR', { status, message, data: extra })
  }
}

/** A non-2xx response whose body is the payload itself (no `error` key), e.g. degraded `/health`. */
export class RawResponse extends ORPCError<string, Record<string, unknown>> {
  constructor(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    super(STATUS_CODES[status] ?? 'INTERNAL_SERVER_ERROR', { status, message: 'raw', data: { __raw: true, body, headers } })
  }
}

/** Convert an oRPC error into the Python-shaped error body. */
export function errorResponseBody(error: ORPCError<string, unknown>): Record<string, unknown> {
  const data = error.data
  if (data && typeof data === 'object' && (data as Record<string, unknown>).__raw) return (data as { body: Record<string, unknown> }).body
  const extra = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  if (error.code === 'INTERNAL_SERVER_ERROR' && !error.defined && error.message === 'Internal server error') return { error: 'Internal server error' }
  if (error.code === 'BAD_REQUEST' && Object.keys(extra).length === 0 && error.message.startsWith('Malformed request')) return { error: 'Invalid JSON body' }
  if (error.code === 'BAD_REQUEST' && error.message === 'Input validation failed') {
    const issues = Array.isArray(extra.issues) ? (extra.issues as { path?: (string | number)[]; message?: string }[]) : []
    const first = issues[0]
    const field = first?.path?.map(String).join('.') ?? ''
    return { error: field ? `Invalid ${field}` : 'Invalid request', issues: issues.map((i) => ({ path: i.path ?? [], message: i.message ?? '' })) }
  }
  return { error: error.message, ...extra }
}

export function errorResponseHeaders(error: ORPCError<string, unknown>): Record<string, string> {
  const data = error.data
  if (data && typeof data === 'object' && (data as Record<string, unknown>).__raw) return (data as { headers: Record<string, string> }).headers
  return {}
}

const os = implement(coreContract).$context<ApiContext>()

export async function bootstrapPayload(ctx: RequestContext): Promise<Bootstrap> {
  const { deps } = ctx
  const auth = await authStatusPayload(ctx)
  let csrfToken = ''
  if (await deps.auth.isAuthEnabled()) {
    const cookieVal = ctx.authCookie() ?? ctx.trusted.cookieValue ?? null
    if (cookieVal && deps.auth.verifySession(cookieVal)) csrfToken = deps.auth.csrfTokenForSession(cookieVal) ?? ''
  }
  const authenticated = !auth.auth_enabled || auth.logged_in
  const settings = authenticated ? deps.settings.load() : {}
  let profile: Bootstrap['profile'] = null
  let onboarding: Bootstrap['onboarding'] = null
  let features: Bootstrap['features'] = { dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false }
  if (authenticated) {
    const active = ctx.requestProfile ?? deps.activeProfile()
    profile = { name: active, is_default: deps.isRootProfile(active) }
    onboarding = { completed: deps.onboardingCompleted() }
    features = deps.features()
  }
  return {
    webui_version: deps.version,
    max_upload_bytes: deps.config.maxUploadBytes,
    csrf_token: csrfToken,
    language: authenticated ? shellLanguage(ctx) : '',
    bot_name: authenticated ? (typeof settings.bot_name === 'string' && settings.bot_name ? settings.bot_name : 'Hermes') : 'Hermes',
    auth,
    profile,
    onboarding,
    features,
  }
}

const SHELL_LANG_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/

/** The `language` setting as a BCP 47 tag for the shell `lang` attribute, or ``. */
export function shellLanguage(ctx: RequestContext): string {
  let lang = ''
  try {
    const raw = ctx.deps.settings.load().language
    lang = typeof raw === 'string' ? raw.trim() : ''
  } catch {
    return ''
  }
  return SHELL_LANG_RE.test(lang) ? lang : ''
}

export function healthPayload(ctx: RequestContext, deep: boolean): { status: number; body: Health; headers?: Record<string, string> } {
  const { deps } = ctx
  const h = deps.health()
  const now = deps.auth.now()
  const body: Health = {
    release: deps.release,
    status: 'ok',
    sessions: h.sessions,
    active_streams: h.activeStreams,
    active_runs: h.activeRuns,
    runs: h.runs,
    last_run_finished_at: h.lastRunFinishedAt,
    server_started_at: deps.startedAt,
    uptime_seconds: Math.round((now - deps.startedAt) * 10) / 10,
    accept_loop: { requests_total: deps.stats.requestsTotal, last_request_at: Math.round(deps.stats.lastRequestAt * 1000) / 1000 },
  }
  if (deep) {
    if (!deps.startup.ready) {
      body.status = 'starting'
      body.phase = deps.startup.phase
      return { status: 503, body, headers: { 'Retry-After': '5' } }
    }
    body.checks = { streams_lock: { status: 'ok', active_streams: h.activeStreams, ms: 0 }, startup: { status: 'ok' } }
  }
  return { status: 200, body }
}

export const coreRouter = os.router({
  health: os.health.handler(({ input, context }) => {
    const deep = ['1', 'true', 'yes', 'on'].includes((input.deep ?? '').toLowerCase())
    const result = healthPayload(context.ctx, deep)
    if (result.status !== 200) throw new RawResponse(result.status, result.body, result.headers ?? {})
    return result.body
  }),
  bootstrap: os.bootstrap.handler(({ context }) => bootstrapPayload(context.ctx)),
  auth: {
    status: os.auth.status.handler(({ context }): Promise<AuthStatus> => authStatusPayload(context.ctx)),
    login: os.auth.login.handler(async ({ input, context }) => {
      const { ctx } = context
      const auth = ctx.deps.auth
      if (!(await auth.isAuthEnabled())) return { ok: true as const, message: 'Auth not enabled' }
      const clientIp = ctx.peer
      if (!auth.checkLoginRate(clientIp)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
      if (!(await auth.verifyPassword(input.password ?? ''))) {
        auth.recordLoginAttempt(clientIp)
        throw new HttpError(401, 'Invalid password')
      }
      auth.clearLoginAttempts(clientIp)
      const cookieVal = auth.createSession({ authType: 'password' })
      ctx.queueCookie(ctx.authCookieHeader(cookieVal))
      return { ok: true as const }
    }),
    logout: os.auth.logout.handler(async ({ context }) => {
      const { ctx } = context
      const auth = ctx.deps.auth
      const sessionInfo = await ensureTrustedAuthSession(ctx)
      const cookieVal = ctx.trusted.cookieValue ?? ctx.authCookie()
      if (cookieVal) auth.invalidateSession(cookieVal)
      const payload: { ok: true; trusted_logout_url?: string } = { ok: true }
      if (sessionInfo?.auth_type === 'trusted') {
        const logoutUrl = (ctx.deps.config.env.HERMES_WEBUI_TRUSTED_AUTH_LOGOUT_URL ?? '').trim()
        if (logoutUrl) payload.trusted_logout_url = logoutUrl
      }
      ctx.queueCookie(clearAuthCookieHeader(ctx))
      ctx.queueCookie(clearProfileCookieHeader(ctx))
      return payload
    }),
  },
})

export type CoreRouter = typeof coreRouter

export function startupUnavailable(ctx: RequestContext): void {
  ctx.json({ error: 'Server is still starting', condition: STARTUP_RECOVERY_CONDITION, phase: ctx.deps.startup.phase }, { status: 503, headers: { 'Retry-After': '5' } })
}
