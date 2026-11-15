/**
 * Browser OIDC redirects (Python `/api/auth/oidc/start` and `/callback`):
 * 302 responses with `Cache-Control: no-store`, outside oRPC because they
 * set cookies and never answer JSON on success.
 */
import { truthy } from '../config.js'
import type { RequestContext } from '../http/context.js'
import { normalizeHostPort } from '../http/origin.js'
import { buildProfileCookie, loginRedirectPath, safeLoginRedirectPath } from '../auth/gate.js'
import { hmacHex, safeEqual } from '../auth/crypto.js'
import { OidcAuthError, OidcConfigError, PENDING_TTL_S } from '../auth/oidc.js'
import { rateLimitClientIp } from './router.js'

/** Python `_validated_request_host`: a bare `host[:port]` with no userinfo, path, or stray separators. */
export function validatedRequestHost(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value || /[\s/\\?#,@%]/.test(value)) return null
  let url: URL
  try {
    url = new URL(`http://${value}`)
  } catch {
    return null
  }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.endsWith(':')) return null
  const [host, port] = normalizeHostPort(value)
  if (!host) return null
  return port ? `${host}:${port}` : host
}

/** Python `_effective_request_host`: forwarded hosts count only with `TALARIA_WEB_TRUST_FORWARDED_HOST` and when they agree. */
export function effectiveRequestHost(ctx: RequestContext): string {
  const direct = validatedRequestHost(ctx.header('host')) ?? '127.0.0.1:8787'
  if (!truthy(ctx.deps.config.env.TALARIA_WEB_TRUST_FORWARDED_HOST)) return direct
  const forwarded = [ctx.header('x-forwarded-host'), ctx.header('x-real-host')].map((v) => (v ?? '').trim()).filter(Boolean)
  if (!forwarded.length) return direct
  const normalized = forwarded.map(validatedRequestHost)
  if (normalized.some((v) => v === null) || new Set(normalized).size !== 1) return direct
  return normalized[0] ?? direct
}

/** Python `_request_base_url`: the configured OIDC origin wins, else scheme + effective host. */
export async function requestBaseUrl(ctx: RequestContext): Promise<string> {
  const configured = await ctx.deps.oidc.configuredOrigin()
  if (configured) return configured
  return `${ctx.isSecureContext() ? 'https' : 'http'}://${effectiveRequestHost(ctx)}`
}

async function redirectNoStore(ctx: RequestContext, location: string): Promise<void> {
  await ctx.redirect(location, { headers: { 'Cache-Control': 'no-store', 'Content-Length': '0' } })
}

/** Python answered OIDC failures through `j()`: security headers, `application/json; charset=utf-8`, `no-store`. */
async function oidcFailure(ctx: RequestContext, error: unknown): Promise<void> {
  if (error instanceof OidcConfigError) (await ctx.json({ error: error.message }, { status: 404 }))
  else if (error instanceof OidcAuthError) (await ctx.json({ error: error.message }, { status: error.status }))
  else throw error
}

/** TAL-2206: the browser that starts a sign-in carries an HMAC of its state, so a callback link replayed into another browser (a login swap) is refused. */
const OIDC_STATE_COOKIE = 'hermes_oidc_state'

function oidcStateCookie(ctx: RequestContext, value: string, maxAge: number, path: string): string {
  const parts = [`${OIDC_STATE_COOKIE}=${value}`, 'HttpOnly', `Max-Age=${String(maxAge)}`, `Path=${path}`, 'SameSite=Lax']
  if (ctx.isSecureContext()) parts.push('Secure')
  return parts.join('; ')
}

const oidcStateMac = (ctx: RequestContext, state: string): string => hmacHex(ctx.deps.auth.signingKey(), `oidc_state:${state}`)

export async function handleOidcStart(ctx: RequestContext): Promise<void> {
  ctx.requestProfile = null
  if (ctx.deps.browserOidcLimiter.limited(rateLimitClientIp(ctx))) {
    await ctx.rawJson(429, { error: 'Too many OIDC sign-in starts; try again in a minute' })
    return
  }
  const nextPath = loginRedirectPath(ctx.query.get('next'), ctx.query.get('mount_path'))
  const nativeFlowId = (ctx.query.get('native_flow') ?? '').trim() || null
  let base: string
  let location: string
  try {
    base = await requestBaseUrl(ctx)
    location = await ctx.deps.oidc.authorizationRedirect(base, nextPath, nativeFlowId)
  } catch (error) {
    await oidcFailure(ctx, error)
    return
  }
  if (!nativeFlowId) {
    const state = new URL(location).searchParams.get('state') ?? ''
    ctx.queueCookie(oidcStateCookie(ctx, oidcStateMac(ctx, state), PENDING_TTL_S, await ctx.deps.oidc.callbackDirectory(base)))
  }
  await redirectNoStore(ctx, location)
}

export async function handleOidcCallback(ctx: RequestContext): Promise<void> {
  ctx.requestProfile = null
  const { oidc, auth } = ctx.deps
  const query = ctx.query
  const state = (query.get('state') ?? '').trim()
  const providerError = (query.get('error') ?? '').trim()
  const base = await requestBaseUrl(ctx)
  const stateCookie = ctx.cookies.get(OIDC_STATE_COOKIE) ?? null
  if (stateCookie !== null) ctx.queueCookie(oidcStateCookie(ctx, '', 0, await oidc.callbackDirectory(base)))
  if (providerError) {
    const nativeFlowId = oidc.consumeFailedProviderAuthorization(state)
    if (nativeFlowId) {
      try {
        await redirectNoStore(ctx, oidc.failNative(base, nativeFlowId, 'provider_error'))
      } catch (error) {
        await oidcFailure(ctx, error)
      }
      return
    }
    const description = (query.get('error_description') ?? '').trim()
    await ctx.rawJson(401, { error: description || providerError })
    return
  }
  const code = (query.get('code') ?? '').trim()
  if (!state || !code) {
    await ctx.rawJson(400, { error: 'Missing OIDC callback state or code' })
    return
  }
  let result: Awaited<ReturnType<typeof oidc.completeCodeFlow>>
  try {
    result = await oidc.completeCodeFlow(base, state, code, stateCookie !== null && safeEqual(stateCookie, oidcStateMac(ctx, state)))
  } catch (error) {
    const nativeFlowId = (error instanceof OidcConfigError || error instanceof OidcAuthError) ? error.nativeFlowId : null
    if (nativeFlowId) {
      try {
        await redirectNoStore(ctx, oidc.failNative(base, nativeFlowId, 'authentication_failed'))
        return
      } catch { /* fall through to the JSON error */ }
    }
    await oidcFailure(ctx, error)
    return
  }
  if (result.native_flow_id) {
    try {
      await redirectNoStore(ctx, oidc.finishNative(base, result.native_flow_id, result))
    } catch (error) {
      await oidcFailure(ctx, error)
    }
    return
  }
  const username = (result.email || result.subject).trim()
  const cookieVal = auth.createSession({ authType: 'oidc', username, boundProfile: result.bound_profile, oidcBinding: result.oidc_binding })
  ctx.queueCookie(ctx.authCookieHeader(cookieVal))
  if (result.bound_profile) ctx.queueCookie(await buildProfileCookie(ctx, result.bound_profile, cookieVal))
  await redirectNoStore(ctx, safeLoginRedirectPath(result.next_path))
}
