/**
 * Implementation of the core route contract. Procedures receive the
 * `RequestContext` and may throw `HttpError` for a byte-compatible
 * `{"error": ...}` body, or `RawResponse` to emit an arbitrary payload/status.
 */
import { implement, ORPCError } from '@orpc/server'
import { coreContract, type AuthStatus, type Bootstrap, type Health, type PasskeysList } from '@maudecode/talaria-web-contracts'
import type { RequestContext } from '../http/context.js'
import { activeProfileName, authStatusPayload, clearAuthCookieHeader, clearProfileCookieHeader, ensureTrustedAuthSession, sessionCanManageServer } from '../auth/gate.js'
import { OidcAuthError, OidcConfigError } from '../auth/oidc.js'
import { PasskeyError, PasskeyRateLimitError, rpContext } from '../auth/passkeys.js'
import { requestBaseUrl } from './auth-raw.js'
import { onboardingGateAllows } from './settings-router.js'
import { forwardedClientIp, rawPeerIsTrustedProxy } from '../http/origin.js'
import { truthy } from '../config.js'
import { STARTUP_RECOVERY_CONDITION } from '../startup.js'
import { displayBotName } from '../settings.js'

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

/** Python `require()`: every named field must be present and truthy (`0` counts as present); all misses are named at once. */
export function requireFields(input: Record<string, unknown>, ...fields: string[]): void {
  const missing = fields.filter((f) => { const v = input[f]; return v === undefined || v === null || v === '' || v === false })
  if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`)
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
    const mapped = issues.map((i) => ({ path: i.path ?? [], message: i.message ?? '' }))
    // Python `require()` named every absent top-level field at once; only a malformed value is reported as invalid.
    const missing = issues.filter((i) => i.path?.length === 1 && (i.message ?? '').includes('received undefined')).map((i) => String(i.path?.[0]))
    if (missing.length && missing.length === issues.length) return { error: `Missing required field(s): ${missing.join(', ')}`, issues: mapped }
    const first = issues[0]
    const field = first?.path?.map(String).join('.') ?? ''
    return { error: field ? `Invalid ${field}` : 'Invalid request', issues: mapped }
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
  if (auth.auth_enabled && auth.logged_in) {
    const cookieVal = ctx.authCookie() ?? ctx.trusted.cookieValue ?? null
    if (cookieVal && deps.auth.verifySession(cookieVal)) csrfToken = deps.auth.csrfTokenForSession(cookieVal) ?? ''
  }
  const authenticated = !auth.auth_enabled || auth.logged_in
  const settings = authenticated ? deps.settings.load() : {}
  let profile: Bootstrap['profile'] = null
  let onboarding: Bootstrap['onboarding'] = null
  let features: Bootstrap['features'] = { dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false }
  if (authenticated) {
    const active = activeProfileName(ctx)
    profile = { name: active, is_default: deps.isRootProfile(active) }
    onboarding = { completed: deps.onboardingCompleted() }
    features = deps.features()
  }
  return {
    webui_version: deps.version,
    max_upload_bytes: deps.config.maxUploadBytes,
    csrf_token: csrfToken,
    language: authenticated ? shellLanguage(ctx) : '',
    bot_name: displayBotName(authenticated ? settings.bot_name : null),
    assistant_name: authenticated ? deps.assistantName(activeProfileName(ctx)) : 'Hermes',
    auth,
    profile,
    onboarding,
    features,
  }
}

/** Python `_SHELL_LANG_RE`. */
const SHELL_LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

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
    agent: { status: deps.sidecar()?.status ?? 'unavailable' },
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
      // Reserve the attempt before the async hash so concurrent guesses see it; success releases only this one.
      const reservation = auth.recordLoginAttempt(clientIp)
      if (!(await auth.verifyPassword(input.password ?? ''))) throw new HttpError(401, 'Invalid password')
      auth.releaseLoginAttempt(clientIp, reservation)
      const cookieVal = auth.createSession({ authType: 'password' })
      ctx.queueCookie(ctx.authCookieHeader(cookieVal))
      return { ok: true as const }
    }),
    logout: os.auth.logout.handler(async ({ context }) => {
      const { ctx } = context
      const auth = ctx.deps.auth
      const sessionInfo = await ensureTrustedAuthSession(ctx)
      const cookieVal = ctx.trusted.cookieValue ?? ctx.authCookie()
      if (cookieVal) await auth.revokeSession(cookieVal)
      const payload: { ok: true; trusted_logout_url?: string } = { ok: true }
      if (sessionInfo?.auth_type === 'trusted') {
        const logoutUrl = (ctx.deps.config.env.HERMES_WEBUI_TRUSTED_AUTH_LOGOUT_URL ?? '').trim()
        if (logoutUrl) payload.trusted_logout_url = logoutUrl
      }
      ctx.queueCookie(clearAuthCookieHeader(ctx))
      ctx.queueCookie(clearProfileCookieHeader(ctx))
      return payload
    }),
    oidcNativeStart: os.auth.oidcNativeStart.handler(async ({ input, context }) => {
      const { ctx } = context
      if (input.code_challenge_method !== 'S256') throw new HttpError(400, 'Native OIDC requires S256 PKCE')
      if (ctx.deps.nativeOidcLimiter.limited(rateLimitClientIp(ctx))) throw new HttpError(429, 'Too many native OIDC starts; try again in a minute')
      return oidcCall(async () => ctx.deps.oidc.beginNative(await requestBaseUrl(ctx), input.callback_url, input.state, input.code_challenge))
    }),
    oidcNativeExchange: os.auth.oidcNativeExchange.handler(async ({ input, context }) => {
      const { ctx } = context
      const identity = await oidcCall(async () => ctx.deps.oidc.exchangeNative(await requestBaseUrl(ctx), input.flow_id, input.code, input.state, input.code_verifier))
      const cookieVal = ctx.deps.auth.createSession({ authType: 'oidc', username: identity.email || identity.subject, boundProfile: identity.bound_profile, oidcBinding: identity.oidc_binding ?? null })
      ctx.queueCookie(ctx.authCookieHeader(cookieVal))
      return { ok: true as const }
    }),
    oidcNativeCancel: os.auth.oidcNativeCancel.handler(({ input, context }) => ({ ok: context.ctx.deps.oidc.cancelNative(input.flow_id, input.state) })),
    passkeyOptions: os.auth.passkeyOptions.handler(async ({ context }) => {
      const { ctx } = context
      if (!ctx.deps.auth.passkeyFeatureFlagEnabled()) throw new HttpError(404, 'Passkey support is disabled. Set HERMES_WEBUI_PASSKEY=1 or webui_passkey_enabled: true to enable.')
      if (!(await ctx.deps.auth.isAuthEnabled())) throw new HttpError(400, 'Auth not enabled')
      const [rpId, origin] = passkeyRp(ctx)
      return { ok: true as const, publicKey: passkeyCall(() => ctx.deps.passkeys.authenticationOptions(rpId, origin)) }
    }),
    passkeyLogin: os.auth.passkeyLogin.handler(async ({ input, context }) => {
      const { ctx } = context
      const auth = ctx.deps.auth
      if (!auth.passkeyFeatureFlagEnabled()) throw new HttpError(404, 'Passkey support is disabled.')
      if (!(await auth.isAuthEnabled())) throw new HttpError(400, 'Auth not enabled')
      const clientIp = ctx.peer
      if (!auth.checkLoginRate(clientIp)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
      try {
        ctx.deps.passkeys.finishLogin(input)
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error
        auth.recordLoginAttempt(clientIp)
        throw new HttpError(401, error.message)
      }
      ctx.queueCookie(ctx.authCookieHeader(auth.createSession({ authType: 'passkey' })))
      return { ok: true as const }
    }),
    passkeyRegisterOptions: os.auth.passkeyRegisterOptions.handler(async ({ context }) => {
      const { ctx } = context
      if (!ctx.deps.auth.passkeyFeatureFlagEnabled()) throw new HttpError(404, 'Passkey support is disabled.')
      await requirePasskeyManagementAuth(ctx)
      const [rpId, origin] = passkeyRp(ctx)
      return { ok: true as const, publicKey: passkeyCall(() => ctx.deps.passkeys.registrationOptions(rpId, origin)) }
    }),
    passkeyRegister: os.auth.passkeyRegister.handler(async ({ input, context }) => {
      const { ctx } = context
      if (!ctx.deps.auth.passkeyFeatureFlagEnabled()) throw new HttpError(404, 'Passkey support is disabled.')
      await requirePasskeyManagementAuth(ctx)
      const result = passkeyCall(() => ctx.deps.passkeys.finishRegistration(input))
      return { ...result, credentials: ctx.deps.passkeys.registered() as never }
    }),
    passkeyDelete: os.auth.passkeyDelete.handler(async ({ input, context }) => {
      const { ctx } = context
      if (!ctx.deps.auth.passkeyFeatureFlagEnabled()) throw new HttpError(404, 'Passkey support is disabled.')
      await requirePasskeyManagementAuth(ctx)
      const creds = ctx.deps.passkeys.registered()
      if ((await ctx.deps.auth.getPasswordHash()) === null && creds.length <= 1 && creds.some((c) => c.id === input.id)) {
        throw new HttpError(409, 'Set a password or disable auth before removing the last passkey.')
      }
      try {
        return ctx.deps.passkeys.delete(input.id) as never
      } catch (error) {
        if (error instanceof PasskeyError) throw new HttpError(404, error.message)
        throw error
      }
    }),
    passkeys: os.auth.passkeys.handler(({ context }) => passkeyList(context.ctx)),
    passkeysPost: os.auth.passkeysPost.handler(({ context }) => passkeyList(context.ctx)),
  },
})

/** The passkey list; owner-only for both methods through `OPERATOR_ONLY_PATHS`. */
function passkeyList(ctx: RequestContext): PasskeysList {
  if (!ctx.deps.auth.passkeyFeatureFlagEnabled()) return { credentials: [], disabled: true }
  return { credentials: ctx.deps.passkeys.registered() as PasskeysList['credentials'] }
}

/** Python `_client_ip_for_rate_limit` + trusted-proxy forwarding for the native OIDC start limiter. */
export function rateLimitClientIp(ctx: RequestContext): string {
  const env = ctx.deps.config.env
  if (truthy(env.HERMES_WEBUI_TRUST_FORWARDED_FOR) && rawPeerIsTrustedProxy(ctx.peer, env)) {
    const forwarded = forwardedClientIp(ctx.headerAll('x-forwarded-for'), ctx.header('x-real-ip'), ctx.peer, env)
    if (forwarded !== null) return forwarded
  }
  return ctx.peer
}

async function oidcCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof OidcConfigError) throw new HttpError(404, error.message)
    if (error instanceof OidcAuthError) throw new HttpError(error.status, error.message)
    throw error
  }
}

function passkeyCall<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof PasskeyRateLimitError) throw new HttpError(429, error.message)
    if (error instanceof PasskeyError) throw new HttpError(400, error.message)
    throw error
  }
}

function passkeyRp(ctx: RequestContext): [string, string] {
  return rpContext({ origin: ctx.header('origin'), host: ctx.header('host'), forwardedProto: ctx.header('x-forwarded-proto') }, ctx.isSecureContext())
}

/** Python `_require_passkey_management_auth`: an owner session, or the local first-run bootstrap gate while auth is off. */
async function requirePasskeyManagementAuth(ctx: RequestContext): Promise<void> {
  const auth = ctx.deps.auth
  const enabled = await auth.isAuthEnabled()
  if (!enabled) {
    if (await onboardingGateAllows(ctx, enabled)) return
    throw new HttpError(401, 'Authentication required')
  }
  const cookieVal = ctx.authCookie()
  if (!cookieVal || !auth.verifySession(cookieVal)) throw new HttpError(401, 'Authentication required')
  if (!(await sessionCanManageServer(ctx, await ensureTrustedAuthSession(ctx)))) throw new HttpError(403, 'An owner session is required to manage owner authentication credentials')
}

export type CoreRouter = typeof coreRouter

/** Python `_send_still_starting`: the phase is in the text, and the connection closes after the 503. */
export function startupUnavailable(ctx: RequestContext): void {
  const phase = ctx.deps.startup.phase
  ctx.json({ error: `Server is still starting: ${phase}`, phase, condition: STARTUP_RECOVERY_CONDITION }, { status: 503, headers: { 'Retry-After': '5', Connection: 'close' } })
}
