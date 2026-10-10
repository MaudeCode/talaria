/**
 * Browser OIDC redirects (Python `/api/auth/oidc/start` and `/callback`):
 * 302 responses with `Cache-Control: no-store`, outside oRPC because they
 * set cookies and never answer JSON on success.
 */
import { truthy } from '../config.js'
import type { RequestContext } from '../http/context.js'
import { normalizeHostPort } from '../http/origin.js'
import { buildProfileCookie, safeLoginRedirectPath } from '../auth/gate.js'
import { OidcAuthError, OidcConfigError } from '../auth/oidc.js'

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

/** Python `_effective_request_host`: forwarded hosts count only with `HERMES_WEBUI_TRUST_FORWARDED_HOST` and when they agree. */
export function effectiveRequestHost(ctx: RequestContext): string {
  const direct = validatedRequestHost(ctx.header('host')) ?? '127.0.0.1:8787'
  if (!truthy(ctx.deps.config.env.HERMES_WEBUI_TRUST_FORWARDED_HOST)) return direct
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

function redirectNoStore(ctx: RequestContext, location: string): void {
  ctx.redirect(location, { headers: { 'Cache-Control': 'no-store', 'Content-Length': '0' } })
}

/** Python answered OIDC failures through `j()`: security headers, `application/json; charset=utf-8`, `no-store`. */
function oidcFailure(ctx: RequestContext, error: unknown): void {
  if (error instanceof OidcConfigError) ctx.json({ error: error.message }, { status: 404 })
  else if (error instanceof OidcAuthError) ctx.json({ error: error.message }, { status: error.status })
  else throw error
}

export async function handleOidcStart(ctx: RequestContext): Promise<void> {
  ctx.requestProfile = null
  const nextPath = safeLoginRedirectPath(ctx.query.get('next'))
  const nativeFlowId = (ctx.query.get('native_flow') ?? '').trim() || null
  let location: string
  try {
    location = await ctx.deps.oidc.authorizationRedirect(await requestBaseUrl(ctx), nextPath, nativeFlowId)
  } catch (error) {
    oidcFailure(ctx, error)
    return
  }
  redirectNoStore(ctx, location)
}

export async function handleOidcCallback(ctx: RequestContext): Promise<void> {
  ctx.requestProfile = null
  const { oidc, auth } = ctx.deps
  const query = ctx.query
  const state = (query.get('state') ?? '').trim()
  const providerError = (query.get('error') ?? '').trim()
  const base = await requestBaseUrl(ctx)
  if (providerError) {
    const nativeFlowId = oidc.consumeFailedProviderAuthorization(state)
    if (nativeFlowId) {
      try {
        redirectNoStore(ctx, oidc.failNative(base, nativeFlowId, 'provider_error'))
      } catch (error) {
        oidcFailure(ctx, error)
      }
      return
    }
    const description = (query.get('error_description') ?? '').trim()
    ctx.rawJson(401, { error: description || providerError })
    return
  }
  const code = (query.get('code') ?? '').trim()
  if (!state || !code) {
    ctx.rawJson(400, { error: 'Missing OIDC callback state or code' })
    return
  }
  let result: Awaited<ReturnType<typeof oidc.completeCodeFlow>>
  try {
    result = await oidc.completeCodeFlow(base, state, code)
  } catch (error) {
    const nativeFlowId = (error instanceof OidcConfigError || error instanceof OidcAuthError) ? error.nativeFlowId : null
    if (nativeFlowId) {
      try {
        redirectNoStore(ctx, oidc.failNative(base, nativeFlowId, 'authentication_failed'))
        return
      } catch { /* fall through to the JSON error */ }
    }
    oidcFailure(ctx, error)
    return
  }
  if (result.native_flow_id) {
    try {
      redirectNoStore(ctx, oidc.finishNative(base, result.native_flow_id, result))
    } catch (error) {
      oidcFailure(ctx, error)
    }
    return
  }
  const username = (result.email || result.subject).trim()
  const cookieVal = auth.createSession({ authType: 'oidc', username, boundProfile: result.bound_profile, oidcBinding: result.oidc_binding })
  ctx.queueCookie(ctx.authCookieHeader(cookieVal))
  if (result.bound_profile) ctx.queueCookie(await buildProfileCookie(ctx, result.bound_profile, cookieVal))
  redirectNoStore(ctx, safeLoginRedirectPath(result.next_path))
}
