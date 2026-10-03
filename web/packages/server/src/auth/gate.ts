/**
 * The request auth gate (Python `api/auth.check_auth` and friends): public
 * paths, trusted-header session reconciliation, owner-only routes, profile
 * binding, CSRF, and the login redirect with a safe `next`.
 */
import { truthy } from '../config.js'
import { formatSetCookie } from './cookies.js'
import { COOKIE_NAME_RE } from './cookies.js'
import { AuthStore, CSRF_HEADER_NAME, type SessionInfo } from './store.js'
import { validProfileName, type RequestContext } from '../http/context.js'
import { checkSameOriginBrowserRequest, csrfRejectionError, isBrowserUnsafeRequest, rawPeerIsTrustedProxy, type CsrfFailure } from '../http/origin.js'
import type { AuthStatus } from '@maudecode/talaria-web-contracts'

export const PUBLIC_PATHS = new Set([
  '/login', '/health', '/favicon.ico', '/sw.js',
  '/api/bootstrap',
  '/api/auth/login', '/api/auth/status',
  '/api/auth/oidc/start', '/api/auth/oidc/callback',
  '/api/auth/oidc/native/start', '/api/auth/oidc/native/exchange', '/api/auth/oidc/native/cancel',
  '/api/auth/passkey/options', '/api/auth/passkey/login',
  '/share',
  '/manifest.json', '/manifest.webmanifest',
  '/session/manifest.json', '/session/manifest.webmanifest',
])

export const OPERATOR_ONLY_PATHS = new Set([
  '/api/shutdown', '/api/health/restart', '/api/updates/apply', '/api/updates/force', '/api/updates/clear_lock',
  '/api/extensions/toggle', '/api/extensions/sidecar-proxy-consent', '/api/extensions/install', '/api/extensions/uninstall',
  '/api/admin/reload', '/api/profile/create', '/api/profile/delete',
  '/api/auth/passkey/register/options', '/api/auth/passkey/register', '/api/auth/passkey/delete', '/api/auth/passkeys',
])

const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/passkey/options', '/api/auth/passkey/login', '/api/csp-report'])
export const PROFILE_COOKIE_NAME = 'hermes_profile'

export function isPublicPath(path: string): boolean {
  return (
    PUBLIC_PATHS.has(path) ||
    path.startsWith('/share/') ||
    (path.startsWith('/api/share/') && path !== '/api/share/create' && path !== '/api/share/revoke') ||
    path.startsWith('/static/') ||
    path.startsWith('/assets/') ||
    path.startsWith('/session/static/')
  )
}

export function isCsrfExemptPath(path: string): boolean {
  return CSRF_EXEMPT_PATHS.has(path)
}

// ── profile cookie ────────────────────────────────────────────────────────

export function profileCookieName(ctx: RequestContext): string {
  const env = ctx.deps.config.env
  const name = (env.HERMES_WEBUI_PROFILE_COOKIE_NAME ?? '').trim()
  if (name) return name
  const legacy = (env.WEBUI_PROFILE_COOKIE_NAME ?? '').trim()
  if (legacy) {
    ctx.deps.auth.warnOnce('legacy-profile-cookie', 'WEBUI_PROFILE_COOKIE_NAME is deprecated; use HERMES_WEBUI_PROFILE_COOKIE_NAME instead.')
    return legacy
  }
  return PROFILE_COOKIE_NAME
}

/** The authenticated active-profile cookie value, or null (Python `get_profile_cookie`). */
export async function getProfileCookie(ctx: RequestContext): Promise<string | null> {
  const raw = ctx.cookies.get(profileCookieName(ctx))
  if (!raw) return null
  if (await ctx.deps.auth.isAuthEnabled()) {
    const value = ctx.deps.auth.verifyProfileCookieValue(raw, ctx.authCookie(), validProfileName)
    return value && validProfileName(value) ? value : null
  }
  return validProfileName(raw) ? raw : null
}

/** `Set-Cookie` for the active profile; signed to the session when auth is on. */
export async function buildProfileCookie(ctx: RequestContext, name: string, sessionCookieValue?: string | null): Promise<string> {
  let value = name
  const auth = ctx.deps.auth
  if (sessionCookieValue !== undefined && sessionCookieValue !== null) value = auth.signProfileCookieValue(name, sessionCookieValue)
  else if (await auth.isAuthEnabled()) value = auth.signProfileCookieValue(name, ctx.authCookie())
  return formatSetCookie(profileCookieName(ctx), value, { path: '/', httpOnly: true, sameSite: 'Lax' })
}

export function clearProfileCookieHeader(ctx: RequestContext): string {
  return formatSetCookie(profileCookieName(ctx), '', { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: '0' })
}

export function clearAuthCookieHeader(ctx: RequestContext): string {
  return formatSetCookie(ctx.deps.auth.cookieName(), '', { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: '0' })
}

// ── profiles ──────────────────────────────────────────────────────────────

export function activeProfileName(ctx: RequestContext): string {
  return ctx.deps.isolatedProfileMode() ? ctx.deps.activeProfile() : ctx.requestProfile ?? ctx.deps.activeProfile()
}

export function profilesMatch(ctx: RequestContext, rowProfile: string | null | undefined, activeProfile: string | null | undefined): boolean {
  const row = rowProfile ?? 'default'
  const active = activeProfile ?? 'default'
  if (row === active) return true
  return ctx.deps.isRootProfile(row) && ctx.deps.isRootProfile(active)
}

function requestProfileMatchesBound(ctx: RequestContext, boundProfile: string | null): boolean {
  if (!boundProfile) return true
  return profilesMatch(ctx, boundProfile, activeProfileName(ctx))
}

// ── trusted-header auth ───────────────────────────────────────────────────

function trustedAuthHeaderName(ctx: RequestContext): string | null {
  const name = (ctx.deps.config.env.HERMES_WEBUI_TRUSTED_AUTH_HEADER ?? '').trim()
  if (!name) return null
  if (!COOKIE_NAME_RE.test(name)) {
    ctx.deps.auth.warnOnce('trusted-auth-header', `Ignoring invalid HERMES_WEBUI_TRUSTED_AUTH_HEADER=${JSON.stringify(name)}; trusted-header auth rejects every request`)
    return null
  }
  return name
}

export function trustedGroupProfileMap(ctx: RequestContext): Record<string, string> | null {
  const raw = (ctx.deps.config.env.HERMES_WEBUI_GROUP_PROFILE_MAP ?? '').trim()
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    ctx.deps.auth.warnOnce('trusted-group-map', 'Ignoring invalid HERMES_WEBUI_GROUP_PROFILE_MAP JSON; trusted-header auth falls back to default profile binding')
    return {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    ctx.deps.auth.warnOnce('trusted-group-map-type', 'Ignoring non-dict HERMES_WEBUI_GROUP_PROFILE_MAP; trusted-header auth falls back to default profile binding')
    return {}
  }
  const mapping: Record<string, string> = {}
  for (const [group, profile] of Object.entries(data as Record<string, unknown>)) {
    const groupName = group.trim()
    const profileName = typeof profile === 'string' ? profile.trim() : typeof profile === 'number' ? String(profile) : ''
    if (!groupName || !profileName) {
      ctx.deps.auth.warnOnce('trusted-group-map-entry', 'Ignoring invalid entry in HERMES_WEBUI_GROUP_PROFILE_MAP; trusted-header auth falls back to default profile binding')
      continue
    }
    mapping[groupName] = profileName
  }
  return mapping
}

export function trustedGroupsHeaderValue(ctx: RequestContext): string[] {
  const env = ctx.deps.config.env
  const headerName = (env.HERMES_WEBUI_TRUSTED_GROUPS_HEADER ?? '').trim()
  if (!headerName) return []
  const raw = ctx.headerAll(headerName).join(',')
  if (!raw) return []
  let normalized = raw.replace(/\n/g, ',')
  if (truthy(env.HERMES_WEBUI_TRUSTED_GROUPS_PIPE_SEPARATOR)) normalized = normalized.replace(/\|/g, ',')
  return normalized.split(',').map((p) => p.trim()).filter(Boolean)
}

function trustedAuthUsername(ctx: RequestContext): string | null {
  const headerName = trustedAuthHeaderName(ctx)
  if (!headerName) return null
  return (ctx.header(headerName) ?? '').trim() || null
}

function trustedAuthBoundProfile(ctx: RequestContext): string | null {
  const mapping = trustedGroupProfileMap(ctx)
  if (mapping === null) return null
  const groups = new Set(trustedGroupsHeaderValue(ctx))
  for (const [group, profile] of Object.entries(mapping)) if (groups.has(group)) return profile
  return 'default'
}

function remember(ctx: RequestContext, info: SessionInfo | null, cookieValue?: string | null): SessionInfo | null {
  ctx.trusted.reconciled = info
  if (info?.auth_type === 'trusted') {
    ctx.trusted.info = info
    ctx.trusted.cookieValue = cookieValue ?? null
  }
  return info
}

async function applyBoundSessionProfile(ctx: RequestContext, boundProfile: string | null, cookieValue: string): Promise<void> {
  if (boundProfile === null) return
  ctx.requestProfile = boundProfile
  if ((await getProfileCookie(ctx)) !== boundProfile) ctx.queueCookie(await buildProfileCookie(ctx, boundProfile, cookieValue))
}

/** Reconcile the request's session with the trusted proxy identity (Python `ensure_trusted_auth_session`). */
export async function ensureTrustedAuthSession(ctx: RequestContext): Promise<SessionInfo | null> {
  if ('reconciled' in ctx.trusted) return ctx.trusted.reconciled ?? null
  const auth = ctx.deps.auth
  let cookieValue = ctx.authCookie()
  const info = cookieValue && auth.verifySession(cookieValue) ? auth.getSessionInfo(cookieValue) : null
  if (info?.auth_type !== undefined && info?.auth_type !== 'trusted') {
    if (info.auth_type === 'oidc' && !(await ctx.deps.oidc.sessionBindingIsCurrent(info))) {
      auth.invalidateSession(cookieValue)
      ctx.trusted.rejected = true
      return remember(ctx, null)
    }
    await applyBoundSessionProfile(ctx, (info.bound_profile ?? '').trim() || null, cookieValue ?? '')
    return remember(ctx, info)
  }
  const reject = () => {
    if (info) {
      auth.invalidateSession(cookieValue)
      ctx.trusted.rejected = true
    }
    return remember(ctx, null)
  }
  if (!auth.isTrustedAuthEnabled()) return reject()
  if (!rawPeerIsTrustedProxy(ctx.peer, ctx.deps.config.env)) return reject()
  const username = trustedAuthUsername(ctx)
  if (!username) return reject()
  const boundProfile = trustedAuthBoundProfile(ctx)
  if (info?.username === username && info?.bound_profile === boundProfile) {
    await applyBoundSessionProfile(ctx, boundProfile, cookieValue ?? '')
    return remember(ctx, info, cookieValue)
  }
  if (info) auth.invalidateSession(cookieValue)
  cookieValue = auth.createSession({ authType: 'trusted', username, boundProfile })
  ctx.queueCookie(ctx.authCookieHeader(cookieValue))
  await applyBoundSessionProfile(ctx, boundProfile, cookieValue)
  return remember(ctx, auth.getSessionInfo(cookieValue), cookieValue)
}

export function trustedSessionAllowsActiveProfile(ctx: RequestContext, info: SessionInfo | null): boolean {
  if (!info) return true
  return requestProfileMatchesBound(ctx, (info.bound_profile ?? '') || null)
}

/** Owner authority for `OPERATOR_ONLY_PATHS` (Python `session_can_manage_server`). */
export async function sessionCanManageServer(ctx: RequestContext, info: SessionInfo | null): Promise<boolean> {
  if (!(await ctx.deps.auth.isAuthEnabled())) return true
  if (!info) return false
  const authType = info.auth_type ?? ''
  if (authType === 'oidc') return ctx.deps.oidc.sessionCanManageServer(info)
  // An untyped record predates typed logins; unknown provenance is not owner authority under a selective policy.
  if (!authType && (await ctx.deps.oidc.ownerPolicyConfigured())) return false
  return !(info.bound_profile ?? '').trim()
}

// ── login redirect ────────────────────────────────────────────────────────

function isLoginShaped(probe: string): boolean {
  const p = (probe.split('?', 1)[0] ?? '').split('#', 1)[0]?.split('&', 1)[0]?.replace(/\/+$/, '') ?? ''
  return p === '/login' || p.endsWith('/login')
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
  }
}

/** Python `_safe_login_redirect_path`: a safe path-absolute `next`, else `/`. */
export function safeLoginRedirectPath(rawPath: string | null | undefined): string {
  const path = (rawPath ?? '').trim()
  if (!path || !path.startsWith('/') || path[1] === '/' || path[1] === '\\') return '/'
  if (/[\x00-\x1f\x7f\s]/.test(path) || path.length > 2048) return '/'
  let probe = path
  for (let i = 0; i < 8; i += 1) {
    if (isLoginShaped(probe)) return '/'
    const decoded = decodeOnce(probe)
    if (decoded === probe) return path
    probe = decoded
  }
  return '/'
}

/** Python `_safe_login_inner_next`: preserve a safe non-login inner `next`, else ``. */
export function safeLoginInnerNext(query: URLSearchParams): string {
  const path = (query.get('next') ?? '').trim()
  if (!path || !path.startsWith('/') || path[1] === '/' || path[1] === '\\') return ''
  if (/[\x00-\x1f\x7f\s]/.test(path) || path.length > 2048) return ''
  let probe = path
  for (let i = 0; i < 8; i += 1) {
    if (isLoginShaped(probe)) return ''
    const decoded = decodeOnce(probe)
    if (decoded === probe) return path
    probe = decoded
  }
  return ''
}

/** Python `urllib.parse.quote(value, safe='/')`. */
export function quotePath(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/').replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

// ── the gate ──────────────────────────────────────────────────────────────

/** True when the request may proceed; otherwise the 401/403/302 has been sent. */
export async function checkAuth(ctx: RequestContext): Promise<boolean> {
  const auth = ctx.deps.auth
  if (!(await auth.isAuthEnabled())) return true
  const path = ctx.path
  if (isPublicPath(path)) return true
  const cookieVal = ctx.authCookie()
  const hasSession = Boolean(cookieVal && auth.verifySession(cookieVal))
  if (path === '/api/auth/logout') {
    if (hasSession) return true
    ctx.rawJson(401, { error: 'Authentication required' })
    return false
  }
  const info = await ensureTrustedAuthSession(ctx)
  if (info) {
    if (OPERATOR_ONLY_PATHS.has(path) && !(await sessionCanManageServer(ctx, info))) {
      ctx.rawJson(403, { error: 'Owner session required' })
      return false
    }
    if (!trustedSessionAllowsActiveProfile(ctx, info)) {
      if (path.startsWith('/api/')) ctx.rawJson(403, { error: 'Profile access forbidden' })
      else ctx.send({ status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Profile access forbidden', security: false })
      return false
    }
    ctx.authRefreshCookie = ctx.trusted.cookieValue ?? cookieVal
    return true
  }
  if (path.startsWith('/api/')) {
    ctx.rawJson(401, { error: 'Authentication required' })
    return false
  }
  const loginPath = (path || '/').replace(/\/+$/, '')
  if (loginPath === '/login' || loginPath.endsWith('/login')) {
    let target = loginPath.replace(/^\/+/, '').includes('/') ? '../login' : 'login'
    const inner = safeLoginInnerNext(ctx.query)
    if (inner) target += '?next=' + quotePath(inner)
    ctx.redirect(target, { security: false })
    return false
  }
  let pathWithQuery = path || '/'
  if (ctx.search) pathWithQuery += ctx.search
  ctx.redirect('login?next=' + quotePath(pathWithQuery), { security: false })
  return false
}

/** Python `_check_csrf`: cross-origin or tokenless authenticated browser writes are rejected. */
export async function checkCsrf(ctx: RequestContext): Promise<boolean> {
  const headers = {
    origin: ctx.header('origin'), referer: ctx.header('referer'), host: ctx.header('host'), secFetchSite: ctx.header('sec-fetch-site'),
    forwardedHost: ctx.header('x-forwarded-host'), realHost: ctx.header('x-real-host'),
  }
  ctx.csrfFailure = checkSameOriginBrowserRequest(headers, ctx.deps.config.env)
  if (ctx.csrfFailure) return false
  if (!isBrowserUnsafeRequest(headers)) return true
  if (!(await ctx.deps.auth.isAuthEnabled())) return true
  const submitted = ctx.header(CSRF_HEADER_NAME) ?? ctx.header('x-csrf-token') ?? ''
  if (ctx.deps.auth.verifyCsrfToken(ctx.authCookie() ?? '', submitted)) return true
  ctx.csrfFailure = 'token_mismatch'
  return false
}

export function csrfError(reason: CsrfFailure): string {
  return csrfRejectionError(reason)
}

/** `/api/auth/status` and the `auth` block of `/api/bootstrap`. */
export async function authStatusPayload(ctx: RequestContext): Promise<AuthStatus> {
  const auth = ctx.deps.auth
  const authEnabled = await auth.isAuthEnabled()
  const oidcEnabled = auth.oidcEnabled()
  let sessionInfo: SessionInfo | null = null
  let loggedIn = false
  if (authEnabled) {
    sessionInfo = await ensureTrustedAuthSession(ctx)
    loggedIn = Boolean(sessionInfo)
  }
  const passkeyFlag = auth.passkeyFeatureFlagEnabled()
  const passkeys = passkeyFlag ? ctx.deps.passkeys.registered().length : 0
  const passwordAuthEnabled = (await auth.getPasswordHash()) !== null
  const payload: AuthStatus = {
    auth_enabled: authEnabled,
    logged_in: loggedIn,
    oidc_enabled: oidcEnabled,
    oidc_native_handoff_enabled: oidcEnabled,
    password_auth_enabled: passwordAuthEnabled,
    passwordless_enabled: passkeys > 0 && !passwordAuthEnabled,
    passkeys_enabled: passkeys > 0,
    passkeys_count: passkeys,
    passkey_feature_flag: passkeyFlag,
    auth_disabled_acknowledged: authEnabled ? false : Boolean(ctx.deps.settings.load().auth_disabled_acknowledged),
    can_manage_server: await sessionCanManageServer(ctx, sessionInfo),
  }
  if (auth.isTrustedAuthEnabled() || sessionInfo?.auth_type === 'trusted') payload.trusted_auth_enabled = true
  if (sessionInfo && (sessionInfo.auth_type === 'trusted' || sessionInfo.auth_type === 'oidc')) {
    payload.auth_type = sessionInfo.auth_type
    payload.user = sessionInfo.username
    payload.bound_profile = sessionInfo.bound_profile
  }
  return payload
}

export { AuthStore }
