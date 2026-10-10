/**
 * OIDC login (browser code flow and the native app handoff), byte-compatible
 * with Python `api/auth_oidc.py`: operator config (`webui_oidc` in the base
 * home config.yaml or `HERMES_WEBUI_OIDC_*`), PKCE S256, discovery/JWKS caches,
 * RS/ES JWT verification through `node:crypto`, allow/owner/profile policies,
 * and the session fingerprint = sha256(canonical policy JSON).
 */
import { readCapped } from '../http/capped.js'
import { isNonGlobalAddress } from '../http/addresses.js'
import { BlockedAddressError, vettedAddresses, type DnsLookup, type PinnedFetch } from '../http/pinned.js'
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { ConfigUnavailable, type Dict } from '../config/agent-config.js'
import { isDict } from '../config/agent-config.js'
import { str } from '../util.js'

export class OidcConfigError extends Error { nativeFlowId: string | null = null }
export class OidcAuthError extends Error {
  nativeFlowId: string | null = null
  constructor(message: string, readonly status = 401) { super(message) }
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email']
const PENDING_TTL_S = 600
const MAX_PENDING = 128
const CLOCK_SKEW_S = 60
const CACHE_TTL_S = 300
const NATIVE_FLOW_TTL_S = 600
const NATIVE_EXCHANGE_TTL_S = 60
const NATIVE_CALLBACK_HOST = 'oidc-callback'
const NATIVE_CALLBACK_SCHEMES = new Set(['talaria', 'talaria-branch'])
const NATIVE_VALUE_RE = /^[A-Za-z0-9._~-]{16,256}$/
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/
const UNRESOLVED_RE = /\$\{[^}]+\}/
const OWNER_POLICY_ERROR = 'webui_oidc.owner_claim and owner_values must both be set to a claim path and a non-empty list of strings; the OIDC owner allowlist matches nobody until they are'

export const b64u = (data: Buffer): string => data.toString('base64url')
export const b64uDecode = (data: string): Buffer => Buffer.from(data, 'base64url')
const safeEq = (a: string, b: string): boolean => { const x = Buffer.from(a, 'utf8'); const y = Buffer.from(b, 'utf8'); return x.length === y.length && timingSafeEqual(x, y) }

export interface OidcConfig {
  issuer: string; client_id: string; client_secret: string; redirect_uri: string; scopes: string[]; allow_claim: string; allow_values: string[]; trusted_private_hosts: string[]
  profile_claim: string; profile_map: Record<string, string> | null; profile_map_configured: boolean; profile_map_error: string | null
  owner_claim: string; owner_values: string[]; owner_policy_configured: boolean; owner_policy_error: string | null; config_read_failed: boolean
}

export interface OidcDeps {
  env: Record<string, string | undefined>
  /** Base-home config.yaml (the operator config), not the request profile's. */
  operatorConfig: () => Promise<Dict>
  profileHome: (name: string) => string
  fetch: () => typeof fetch
  /** Vetted outbound for untrusted hosts: DNS answers checked and the connection pinned to them (`http/pinned.ts`). */
  pinned: () => { lookup: DnsLookup; fetch: PinnedFetch }
  now: () => number
  log: (line: string) => void
}

function textList(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) return raw.map((v) => str(v).trim()).filter(Boolean)
  return str(raw).replaceAll('\n', ',').split(',').flatMap((part) => part.split(/\s+/)).map((v) => v.trim()).filter(Boolean)
}

function allowValues(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  const values = Array.isArray(raw) ? raw.map((v) => str(v).trim()).filter(Boolean) : str(raw).replaceAll('\n', ',').split(',').map((v) => v.trim()).filter(Boolean)
  return values.some((v) => UNRESOLVED_RE.test(v)) ? [] : values
}

/** Non-global destinations never receive the client credentials (`http/addresses.ts`). */
const disallowedIp = isNonGlobalAddress

export function safeNextPath(raw: unknown): string {
  const path = str(raw).trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/'
  if (/[\x00-\x1f\x7f\s]/.test(path)) return '/'
  return path
}

/** Python `_normalize_server_origin`. */
export function normalizeServerOrigin(raw: string): string {
  let u: URL
  try { u = new URL(str(raw).trim()) } catch { throw new OidcAuthError('Invalid native OIDC server identity', 400) }
  const scheme = u.protocol.replace(':', '').toLowerCase()
  if (!['http', 'https'].includes(scheme) || !u.hostname || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new OidcAuthError('Invalid native OIDC server identity', 400)
  const host = u.hostname.toLowerCase()
  const display = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const port = u.port
  return `${scheme}://${display}${port ? `:${port}` : ''}`
}

function validateNativeCallback(raw: string): string {
  const value = str(raw).trim()
  const m = /^([a-z][a-z0-9+.-]{1,63}):\/\/([^/?#]*)(.*)$/i.exec(value)
  if (!m) throw new OidcAuthError('Invalid native OIDC callback URL', 400)
  const scheme = (m[1] ?? '').toLowerCase()
  const netloc = m[2] ?? ''
  const rest = m[3] ?? ''
  if (!NATIVE_CALLBACK_SCHEMES.has(scheme) || netloc.toLowerCase() !== NATIVE_CALLBACK_HOST || (rest !== '' && rest !== '/')) throw new OidcAuthError('Invalid native OIDC callback URL', 400)
  return `${scheme}://${netloc.toLowerCase()}`
}

function serverIdentity(origin: string): string {
  return b64u(createHash('sha256').update(origin, 'utf8').digest())
}

export function claimPath(claims: Dict, dotted: string): unknown {
  let current: unknown = claims
  for (const part of dotted.split('.')) {
    if (!isDict(current) || !(part in current)) return undefined
    current = current[part]
  }
  return current
}

function claimValues(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.map((v) => str(v)).filter((v) => v.trim()))
  if (isDict(value)) return new Set(Object.values(value).map((v) => str(v)).filter((v) => v.trim()))
  const text = str(value).trim()
  return text ? new Set([text]) : new Set()
}

interface Pending { created_at: number; nonce: string; code_verifier: string; next_path: string; native_flow_id: string | null }
interface NativeFlow { created_at: number; callback_url: string; client_state: string; code_challenge: string; server_origin: string; server_id: string }
interface Exchange { created_at: number; flow_id: string; client_state: string; code_challenge: string; server_origin: string; subject: string; email: string; bound_profile: string | null; oidc_binding: Dict | null }

export class OidcService {
  private readonly pending = new Map<string, Pending>()
  private readonly nativeFlows = new Map<string, NativeFlow>()
  private readonly exchanges = new Map<string, Exchange>()
  private readonly discovery = new Map<string, { until: number; value: Dict }>()
  private readonly jwks = new Map<string, { until: number; value: Dict }>()
  private lastConfig: OidcConfig | null = null
  private lastConfigAt = 0
  private inflight: Promise<OidcConfig> | null = null
  private warnedOwnerPolicy = false

  constructor(private readonly deps: OidcDeps) {}

  /** Python `is_oidc_enabled` on the last resolved config (sync for the auth gate): an unreadable config keeps it on. */
  enabledSync(): boolean {
    return this.availableSync() || this.lastConfig?.config_read_failed === true
  }

  /** The last config resolved and is complete enough to offer SSO; what login, status and native handoff advertise. */
  availableSync(): boolean {
    const cfg = this.lastConfig
    return Boolean(cfg && !cfg.config_read_failed && cfg.issuer && cfg.client_id && cfg.allow_claim && cfg.allow_values.length)
  }

  async enabled(): Promise<boolean> {
    await this.resolve()
    return this.enabledSync()
  }

  /** Python `_resolve_oidc_config`, cached for 5 s; concurrent misses share one operator config read. */
  resolve(): Promise<OidcConfig> {
    if (this.lastConfig && this.deps.now() - this.lastConfigAt < 5) return Promise.resolve(this.lastConfig)
    this.inflight ??= this.load().finally(() => { this.inflight = null })
    return this.inflight
  }

  private async load(): Promise<OidcConfig> {
    const env = this.deps.env
    let raw: Dict = {}
    let readFailed = false
    try {
      const cfg = await this.deps.operatorConfig()
      const value = cfg.webui_oidc
      if (isDict(value)) raw = this.expandEnv(value) as Dict
      else if (value !== null && value !== undefined) throw new OidcConfigError('webui_oidc must be a mapping')
    } catch (error) {
      // The auth policy is unknown, and an earlier snapshot is not authority: the gate stays closed (config_read_failed
      // reports OIDC as enabled and refuses login) until the operator config can be read; the 5 s cache retries.
      readFailed = true
      if (error instanceof ConfigUnavailable) this.deps.log('[oidc] operator config unavailable; failing closed until it is readable')
    }
    const pick = (name: string, envName: string): unknown => (env[envName] ?? raw[name])
    const scopesRaw = textList(pick('scopes', 'HERMES_WEBUI_OIDC_SCOPES'))
    const scopes = scopesRaw.length ? [...new Set(scopesRaw.includes('openid') ? scopesRaw : ['openid', ...scopesRaw])] : [...DEFAULT_SCOPES]
    const [profileMap, profileMapError, profileMapConfigured] = this.normalizeProfileMap(pick('profile_map', 'HERMES_WEBUI_OIDC_PROFILE_MAP'))
    const ownerClaimRaw = env.HERMES_WEBUI_OIDC_OWNER_CLAIM ?? ('owner_claim' in raw ? raw.owner_claim : undefined)
    const ownerValuesRaw = env.HERMES_WEBUI_OIDC_OWNER_VALUES ?? ('owner_values' in raw ? raw.owner_values : undefined)
    const ownerConfigured = ownerClaimRaw !== undefined || ownerValuesRaw !== undefined
    let ownerClaim = ''
    let ownerValues: string[] = []
    let ownerError: string | null = null
    if (ownerConfigured) {
      ownerClaim = typeof ownerClaimRaw === 'string' ? ownerClaimRaw.trim() : ''
      if (typeof ownerValuesRaw === 'string') ownerValues = ownerValuesRaw.replaceAll('\n', ',').split(',').map((v) => v.trim()).filter(Boolean)
      else if (Array.isArray(ownerValuesRaw) && ownerValuesRaw.every((v) => typeof v === 'string' && v.trim())) ownerValues = ownerValuesRaw.map((v) => str(v).trim())
      if (ownerValues.some((v) => UNRESOLVED_RE.test(v))) ownerValues = []
      if (!ownerClaim || !ownerValues.length || UNRESOLVED_RE.test(ownerClaim)) { ownerValues = []; ownerError = OWNER_POLICY_ERROR }
      if (ownerError && !this.warnedOwnerPolicy) { this.warnedOwnerPolicy = true; this.deps.log(`[oidc] ${ownerError}`) }
    }
    const rawProfileClaim = str(pick('profile_claim', 'HERMES_WEBUI_OIDC_PROFILE_CLAIM') || 'sub').trim()
    const profileClaim = UNRESOLVED_RE.test(rawProfileClaim) ? '' : rawProfileClaim
    const allowClaim = str(pick('allow_claim', 'HERMES_WEBUI_OIDC_ALLOW_CLAIM')).trim()
    const cfg: OidcConfig = {
      issuer: str(pick('issuer', 'HERMES_WEBUI_OIDC_ISSUER')).trim(), client_id: str(pick('client_id', 'HERMES_WEBUI_OIDC_CLIENT_ID')).trim(), client_secret: str(pick('client_secret', 'HERMES_WEBUI_OIDC_CLIENT_SECRET')).trim(),
      redirect_uri: str(pick('redirect_uri', 'HERMES_WEBUI_OIDC_REDIRECT_URI')).trim(), scopes, allow_claim: UNRESOLVED_RE.test(allowClaim) ? '' : allowClaim, allow_values: allowValues(pick('allow_values', 'HERMES_WEBUI_OIDC_ALLOW_VALUES')),
      trusted_private_hosts: this.trustedHosts(pick('trusted_private_hosts', 'HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS')), profile_claim: profileClaim, profile_map: profileMap, profile_map_configured: profileMapConfigured,
      profile_map_error: profileMapError ?? (profileClaim ? null : 'webui_oidc.profile_claim could not be resolved; it still contains an unexpanded ${...} reference'),
      owner_claim: ownerClaim, owner_values: ownerValues, owner_policy_configured: ownerConfigured, owner_policy_error: ownerError, config_read_failed: readFailed,
    }
    this.lastConfig = cfg
    this.lastConfigAt = this.deps.now()
    return cfg
  }

  private expandEnv(obj: unknown): unknown {
    if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (whole, name: string) => { return this.deps.env[name.trim()] ?? whole })
    if (Array.isArray(obj)) return obj.map((v) => this.expandEnv(v))
    if (isDict(obj)) return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, this.expandEnv(v)]))
    return obj
  }

  private normalizeProfileMap(raw: unknown): [Record<string, string> | null, string | null, boolean] {
    if (raw === null || raw === undefined || raw === '') return [null, null, false]
    let value: unknown = raw
    if (typeof raw === 'string') { try { value = JSON.parse(raw) } catch { return [null, 'webui_oidc.profile_map must be a JSON object', true] } }
    if (!isDict(value)) return [null, 'webui_oidc.profile_map must be an object', true]
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) {
      const claim = k.trim()
      const profile = str(v).trim()
      if (!claim || !profile) return [null, 'webui_oidc.profile_map entries must have non-empty claim values and profiles', true]
      map[claim] = profile
    }
    return [map, null, true]
  }

  private trustedHosts(raw: unknown): string[] {
    const out: string[] = []
    for (const value of textList(raw)) {
      const host = value.toLowerCase().replace(/\.+$/, '')
      if (!host || host === 'localhost' || isIP(host) || /[:/\\@*]/.test(host)) continue
      if (!host.split('.').every((l) => l && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/i.test(l))) continue
      if (!out.includes(host)) out.push(host)
    }
    return out
  }

  private async require(): Promise<OidcConfig> {
    const cfg = await this.resolve()
    if (cfg.config_read_failed) throw new OidcConfigError('The operator config could not be resolved; OIDC login is unavailable until it is readable')
    if (!cfg.issuer || !cfg.client_id) throw new OidcConfigError('Native OIDC login is not configured')
    if (!cfg.allow_claim || !cfg.allow_values.length) throw new OidcConfigError('Native OIDC login requires webui_oidc.allow_claim and allow_values')
    if (cfg.profile_map_error) throw new OidcConfigError(cfg.profile_map_error)
    return cfg
  }

  /** Configured `redirect_uri` origin, when set and valid (Python `_configured_oidc_origin`). */
  configuredOrigin(): string | null {
    const redirect = str(this.lastConfig?.redirect_uri).trim()
    if (!redirect) return null
    try { const u = new URL(redirect); return ['http:', 'https:'].includes(u.protocol) && u.host ? `${u.protocol}//${u.host.toLowerCase()}` : null } catch { return null }
  }

  private redirectUri(cfg: OidcConfig, requestBaseUrl: string): string {
    return cfg.redirect_uri || requestBaseUrl.replace(/\/+$/, '') + '/api/auth/oidc/callback'
  }

  private prune(): void {
    const now = this.deps.now()
    for (const [k, v] of this.pending) if (now - v.created_at > PENDING_TTL_S) this.pending.delete(k)
    for (const [k, v] of this.nativeFlows) if (now - v.created_at > NATIVE_FLOW_TTL_S) this.nativeFlows.delete(k)
    for (const [k, v] of this.exchanges) if (now - v.created_at > NATIVE_EXCHANGE_TTL_S) this.exchanges.delete(k)
  }

  private trim<T extends { created_at: number }>(map: Map<string, T>, max: number): void {
    const overflow = map.size - max + 1
    if (overflow <= 0) return
    for (const [k] of [...map.entries()].sort((a, b) => a[1].created_at - b[1].created_at).slice(0, overflow)) map.delete(k)
  }

  /** Python `build_authorization_redirect`. */
  async authorizationRedirect(requestBaseUrl: string, nextPath: string | null, nativeFlowId: string | null): Promise<string> {
    const cfg = await this.require()
    const discovery = await this.discoveryDocument(cfg)
    const endpoint = str(discovery.authorization_endpoint).trim()
    if (!endpoint) throw new OidcConfigError('OIDC discovery document is missing authorization_endpoint')
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = b64u(createHash('sha256').update(verifier, 'ascii').digest())
    this.prune()
    if (nativeFlowId) {
      const flow = this.nativeFlows.get(nativeFlowId)
      if (!flow) throw new OidcAuthError('Invalid or expired native OIDC flow', 401)
      if (!safeEq(normalizeServerOrigin(requestBaseUrl), flow.server_origin)) throw new OidcAuthError('Native OIDC flow belongs to a different server', 401)
    }
    this.trim(this.pending, MAX_PENDING)
    this.pending.set(state, { created_at: this.deps.now(), nonce, code_verifier: verifier, next_path: safeNextPath(nextPath), native_flow_id: nativeFlowId })
    const params = new URLSearchParams({ response_type: 'code', client_id: cfg.client_id, redirect_uri: this.redirectUri(cfg, requestBaseUrl), scope: cfg.scopes.join(' '), state, nonce, code_challenge: challenge, code_challenge_method: 'S256' })
    return `${endpoint}?${params.toString()}`
  }

  consumeFailedProviderAuthorization(state: string): string | null {
    this.prune()
    const pending = this.pending.get(state)
    this.pending.delete(state)
    return pending?.native_flow_id ?? null
  }

  /** Python `complete_authorization_code_flow`. */
  async completeCodeFlow(requestBaseUrl: string, state: string, code: string): Promise<{ next_path: string; native_flow_id: string | null; subject: string; email: string; bound_profile: string | null; oidc_binding: Dict; claims: Dict }> {
    const cfg = await this.require()
    this.prune()
    const pending = this.pending.get(state)
    this.pending.delete(state)
    if (!pending) throw new OidcAuthError('Invalid OIDC state', 401)
    try {
      const discovery = await this.discoveryDocument(cfg)
      const discoveryIssuer = str(discovery.issuer).trim()
      if (discoveryIssuer && discoveryIssuer !== cfg.issuer) throw new OidcAuthError('OIDC discovery issuer did not match the configured issuer', 502)
      const tokenEndpoint = str(discovery.token_endpoint).trim()
      if (!tokenEndpoint) throw new OidcConfigError('OIDC discovery document is missing token_endpoint')
      const form: Record<string, string> = { grant_type: 'authorization_code', client_id: cfg.client_id, code, code_verifier: pending.code_verifier, redirect_uri: this.redirectUri(cfg, requestBaseUrl) }
      if (cfg.client_secret) form.client_secret = cfg.client_secret
      const token = await this.postForm(cfg, tokenEndpoint, form)
      const idToken = str(token.id_token).trim()
      if (!idToken) throw new OidcAuthError('OIDC token response did not include an id_token', 502)
      const claims = await this.validateIdToken(cfg, idToken, pending.nonce, str(discovery.jwks_uri).trim())
      this.enforceAllowlist(claims, cfg)
      const boundProfile = this.resolveBoundProfile(cfg, claims)
      const binding = this.binding(cfg, boundProfile, this.ownerPermission(cfg, claims))
      binding.issuer = cfg.issuer
      binding.subject = str(claims.sub)
      return { next_path: pending.next_path, native_flow_id: pending.native_flow_id, subject: str(claims.sub), email: str(claims.email), bound_profile: boundProfile, oidc_binding: binding, claims }
    } catch (error) {
      if (error instanceof OidcAuthError || error instanceof OidcConfigError) error.nativeFlowId = pending.native_flow_id
      throw error
    }
  }

  /** Python `begin_native_authorization`. */
  async beginNative(requestBaseUrl: string, callbackUrl: string, clientState: string, codeChallenge: string): Promise<{ flow_id: string; authorization_url: string; server_id: string; expires_in: number }> {
    // The same resolved-config decision status advertises: an unresolved or incomplete config never mints a flow.
    await this.require()
    const origin = normalizeServerOrigin(requestBaseUrl)
    const callback = validateNativeCallback(callbackUrl)
    const state = str(clientState).trim()
    const challenge = str(codeChallenge).trim()
    if (!NATIVE_VALUE_RE.test(state)) throw new OidcAuthError('Invalid native OIDC state', 400)
    if (!PKCE_CHALLENGE_RE.test(challenge)) throw new OidcAuthError('Invalid native OIDC PKCE challenge', 400)
    this.prune()
    if (this.nativeFlows.size >= MAX_PENDING) throw new OidcAuthError('Too many pending native OIDC flows', 429)
    const flowId = randomBytes(24).toString('base64url')
    const serverId = serverIdentity(origin)
    this.nativeFlows.set(flowId, { created_at: this.deps.now(), callback_url: callback, client_state: state, code_challenge: challenge, server_origin: origin, server_id: serverId })
    return { flow_id: flowId, authorization_url: `${this.nativeAuthorizationBase(origin)}/api/auth/oidc/start?${new URLSearchParams({ native_flow: flowId }).toString()}`, server_id: serverId, expires_in: NATIVE_FLOW_TTL_S }
  }

  private nativeAuthorizationBase(origin: string): string {
    const redirect = str(this.lastConfig?.redirect_uri).trim()
    if (!redirect) return origin
    let u: URL
    try { u = new URL(redirect) } catch { return origin }
    const callbackPath = '/api/auth/oidc/callback'
    if (u.search || u.hash || !u.pathname.endsWith(callbackPath)) return origin
    let redirectOrigin: string
    try { redirectOrigin = normalizeServerOrigin(`${u.protocol}//${u.host}`) } catch { return origin }
    if (!safeEq(redirectOrigin, origin)) return origin
    const prefix = u.pathname.slice(0, -callbackPath.length).replace(/\/+$/, '')
    let decoded: string
    try { decoded = decodeURIComponent(prefix) } catch { return origin }
    if (!prefix || decoded.includes('\\') || decoded.split('/').some((s) => s === '.' || s === '..') || /[\x00-\x1f\x7f\s]/.test(decoded)) return origin
    return origin + prefix
  }

  private callbackWith(flow: NativeFlow, params: Record<string, string>): string {
    const sep = flow.callback_url.includes('?') ? '&' : '?'
    return flow.callback_url + sep + new URLSearchParams(params).toString()
  }

  /** Python `finish_native_authorization`: mint one short-lived exchange code. */
  finishNative(requestBaseUrl: string, flowId: string, identity: { subject: string; email: string; bound_profile: string | null; oidc_binding: Dict | null }): string {
    this.prune()
    const flow = this.nativeFlows.get(flowId)
    this.nativeFlows.delete(flowId)
    if (!flow) throw new OidcAuthError('Invalid or expired native OIDC flow', 401)
    if (!safeEq(normalizeServerOrigin(requestBaseUrl), flow.server_origin)) throw new OidcAuthError('Native OIDC flow belongs to a different server', 401)
    this.trim(this.exchanges, MAX_PENDING)
    const code = randomBytes(32).toString('base64url')
    this.exchanges.set(code, { created_at: this.deps.now(), flow_id: flowId, client_state: flow.client_state, code_challenge: flow.code_challenge, server_origin: flow.server_origin, subject: identity.subject, email: identity.email, bound_profile: identity.bound_profile, oidc_binding: identity.oidc_binding })
    return this.callbackWith(flow, { code, state: flow.client_state, flow_id: flowId, server_id: flow.server_id })
  }

  failNative(requestBaseUrl: string, flowId: string, error: string): string {
    this.prune()
    const flow = this.nativeFlows.get(flowId)
    this.nativeFlows.delete(flowId)
    if (!flow) throw new OidcAuthError('Invalid or expired native OIDC flow', 401)
    if (!safeEq(normalizeServerOrigin(requestBaseUrl), flow.server_origin)) throw new OidcAuthError('Native OIDC flow belongs to a different server', 401)
    return this.callbackWith(flow, { error: error || 'authentication_failed', state: flow.client_state, flow_id: flowId, server_id: flow.server_id })
  }

  /** Python `exchange_native_authorization`. */
  async exchangeNative(requestBaseUrl: string, flowId: string, code: string, clientState: string, verifier: string): Promise<{ subject: string; email: string; bound_profile: string | null; oidc_binding?: Dict }> {
    this.prune()
    const exchange = this.exchanges.get(code)
    this.exchanges.delete(code)
    if (!exchange) throw new OidcAuthError('Invalid or expired native OIDC exchange code', 401)
    if (!safeEq(normalizeServerOrigin(requestBaseUrl), exchange.server_origin)) throw new OidcAuthError('Native OIDC exchange code belongs to a different server', 401)
    if (!safeEq(flowId, exchange.flow_id)) throw new OidcAuthError('Native OIDC flow did not match', 401)
    if (!safeEq(clientState, exchange.client_state)) throw new OidcAuthError('Native OIDC state did not match', 401)
    if (!PKCE_VERIFIER_RE.test(verifier)) throw new OidcAuthError('Native OIDC PKCE verifier did not match', 401)
    if (!safeEq(b64u(createHash('sha256').update(verifier, 'ascii').digest()), exchange.code_challenge)) throw new OidcAuthError('Native OIDC PKCE verifier did not match', 401)
    if (!(await this.bindingIsCurrent(exchange.oidc_binding, exchange.bound_profile))) throw new OidcAuthError('OIDC policy changed; sign in again', 401)
    const result: { subject: string; email: string; bound_profile: string | null; oidc_binding?: Dict } = { subject: exchange.subject, email: exchange.email, bound_profile: exchange.bound_profile }
    if (exchange.oidc_binding) result.oidc_binding = exchange.oidc_binding
    return result
  }

  cancelNative(flowId: string, clientState: string): boolean {
    if (!NATIVE_VALUE_RE.test(flowId) || !NATIVE_VALUE_RE.test(clientState)) return false
    const flow = this.nativeFlows.get(flowId)
    if (flow && !safeEq(clientState, flow.client_state)) return false
    const matching = [...this.exchanges.entries()].filter(([, e]) => safeEq(e.flow_id, flowId))
    if (matching.some(([, e]) => !safeEq(clientState, e.client_state))) return false
    let removed = this.nativeFlows.delete(flowId)
    for (const [code] of matching) { this.exchanges.delete(code); removed = true }
    for (const [state, p] of this.pending) if (p.native_flow_id && safeEq(p.native_flow_id, flowId)) { this.pending.delete(state); removed = true }
    return removed
  }

  // ── policy ───────────────────────────────────────────────────────────

  private enforceAllowlist(claims: Dict, cfg: OidcConfig): void {
    if (!cfg.allow_claim) return
    const value = claimPath(claims, cfg.allow_claim)
    if (value === undefined || value === null) throw new OidcAuthError('OIDC identity is not allowed', 403)
    const actual = claimValues(value)
    if (cfg.allow_values.length) { if (!cfg.allow_values.some((v) => actual.has(v))) throw new OidcAuthError('OIDC identity is not allowed', 403); return }
    if (!actual.size) throw new OidcAuthError('OIDC identity is not allowed', 403)
  }

  private ownerPermission(cfg: OidcConfig, claims: Dict): boolean {
    if (!cfg.owner_policy_configured || !cfg.owner_values.length || !cfg.owner_claim) return false
    const value = claimPath(claims, cfg.owner_claim)
    const present = typeof value === 'string' ? [value] : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
    return present?.some((v) => cfg.owner_values.includes(v)) ?? false
  }

  private resolveBoundProfile(cfg: OidcConfig, claims: Dict): string | null {
    if (!cfg.profile_map_configured) return null
    const value = claimPath(claims, cfg.profile_claim || 'sub')
    if (isDict(value) || Array.isArray(value)) throw new OidcAuthError('OIDC identity is not assigned to a profile', 403)
    const profile = cfg.profile_map?.[str(value).trim()]
    if (!profile) throw new OidcAuthError('OIDC identity is not assigned to a profile', 403)
    if (profile !== 'default' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new OidcConfigError(`OIDC profile mapping targets invalid profile '${profile}'`)
    const home = this.deps.profileHome(profile)
    if (!existsSync(home) || !statSync(home).isDirectory()) throw new OidcConfigError(`OIDC profile mapping target '${profile}' does not exist`)
    return profile
  }

  /** Python `_oidc_profile_binding`: fingerprint of every policy input plus the profile identity (`st_dev:st_ino`). */
  binding(cfg: OidcConfig, profile: string | null, owner = false): Dict {
    const payload = {
      allow_claim: cfg.allow_claim, allow_values: [...cfg.allow_values].map(String).sort(), client_id: cfg.client_id, issuer: cfg.issuer, owner_claim: cfg.owner_claim, owner_policy_configured: cfg.owner_policy_configured,
      owner_values: [...cfg.owner_values].map(String).sort(), profile_claim: cfg.profile_claim || 'sub', profile_map: cfg.profile_map ?? {}, profile_map_configured: cfg.profile_map_configured,
    }
    const fingerprint = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
    let identity = ''
    if (profile) { const st = statSync(this.deps.profileHome(profile), { bigint: true }); identity = `${String(st.dev)}:${String(st.ino)}` }
    const out: Dict = { mapping_fingerprint: fingerprint, profile_identity: identity }
    if (owner) out.owner = true
    return out
  }

  async bindingIsCurrent(binding: Dict | null, profile: string | null, cfg?: OidcConfig): Promise<boolean> {
    if (!binding) return true
    try {
      const resolved = cfg ?? (await this.require())
      const expected = this.binding(resolved, str(profile).trim() || null)
      return safeEq(str(binding.mapping_fingerprint), str(expected.mapping_fingerprint)) && safeEq(str(binding.profile_identity), str(expected.profile_identity))
    } catch {
      return false
    }
  }

  /** Python `oidc_session_binding_is_current`. */
  async sessionBindingIsCurrent(info: Dict, cfg?: OidcConfig): Promise<boolean> {
    const profile = str(info.bound_profile).trim()
    const fingerprint = str(info.oidc_mapping_fingerprint)
    if (!fingerprint && !profile && !info.oidc_owner) return true
    return this.bindingIsCurrent({ mapping_fingerprint: fingerprint, profile_identity: info.oidc_profile_identity ?? '' }, profile, cfg)
  }

  /** Python `oidc_session_can_manage_server`. */
  async sessionCanManageServer(info: Dict): Promise<boolean> {
    let cfg: OidcConfig
    try { cfg = await this.require() } catch { return false }
    if (cfg.config_read_failed) return false
    if (!cfg.owner_policy_configured) return str(info.bound_profile).trim() ? false : this.sessionBindingIsCurrent(info, cfg)
    if (!info.oidc_owner) return false
    return this.sessionBindingIsCurrent(info, cfg)
  }

  /** Python `oidc_owner_policy_is_configured` (fails closed on an unreadable config). */
  async ownerPolicyConfigured(): Promise<boolean> {
    try { const cfg = await this.resolve(); return cfg.owner_policy_configured || cfg.config_read_failed } catch { return true }
  }

  // ── discovery, JWKS, tokens ──────────────────────────────────────────

  /** The vetted addresses to pin the request to, or null for an operator-trusted private host (plain fetch). */
  private async validateOutbound(cfg: OidcConfig, url: string): Promise<string[] | null> {
    let u: URL
    try { u = new URL(url) } catch { throw new OidcAuthError('OIDC endpoint URLs must use https', 502) }
    if (u.protocol !== 'https:') throw new OidcAuthError('OIDC endpoint URLs must use https', 502)
    if (u.username || u.password) throw new OidcAuthError('OIDC endpoint URLs must not contain credentials', 502)
    const hostname = u.hostname.replace(/^\[|\]$/g, '')
    if (!hostname) throw new OidcAuthError('OIDC endpoint URL was missing a hostname', 502)
    const normalized = hostname.toLowerCase().replace(/\.+$/, '')
    if (cfg.trusted_private_hosts.includes(normalized)) return null
    try {
      return await vettedAddresses(hostname, disallowedIp, this.deps.pinned().lookup)
    } catch (error) {
      if (error instanceof BlockedAddressError) throw new OidcAuthError('OIDC endpoint URLs must not target private or local addresses', 502)
      throw new OidcAuthError(`Failed to resolve OIDC endpoint host: ${hostname}`, 502)
    }
  }

  private async fetchJson(cfg: OidcConfig, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, failure: string): Promise<Dict> {
    const addresses = await this.validateOutbound(cfg, url)
    let res: Response
    try {
      const signal = AbortSignal.timeout(10_000)
      res = addresses ? await this.deps.pinned().fetch(url, { ...init, signal }, addresses) : await this.deps.fetch()(url, { ...init, redirect: 'error', signal })
    } catch { throw new OidcAuthError(failure, 502) }
    if (!res.ok) throw new OidcAuthError(failure, 502)
    let text: string
    try { const raw = await readCapped(res, 1024 * 1024); if (!raw) throw new Error('too large'); text = raw.toString('utf8') } catch { throw new OidcAuthError(failure, 502) }
    if (/\b(NaN|Infinity|-Infinity)\b/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, ''))) throw new OidcAuthError(`OIDC endpoint returned invalid JSON: ${url}`, 502)
    let payload: unknown
    try { payload = JSON.parse(text) } catch { throw new OidcAuthError(`OIDC endpoint returned invalid JSON: ${url}`, 502) }
    return isDict(payload) ? payload : {}
  }

  private async discoveryDocument(cfg: OidcConfig): Promise<Dict> {
    const url = cfg.issuer.endsWith('/.well-known/openid-configuration') ? cfg.issuer : cfg.issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration'
    const hit = this.discovery.get(url)
    if (hit && hit.until > this.deps.now()) return structuredClone(hit.value)
    const data = await this.fetchJson(cfg, url, { headers: { Accept: 'application/json' } }, `Failed to reach OIDC endpoint: ${url}`)
    if (!Object.keys(data).length) throw new OidcAuthError('OIDC discovery response was not a JSON object', 502)
    this.discovery.set(url, { until: this.deps.now() + CACHE_TTL_S, value: structuredClone(data) })
    return data
  }

  private async jwksDocument(cfg: OidcConfig, uri: string, force = false): Promise<Dict> {
    if (!uri) throw new OidcConfigError('OIDC discovery document is missing jwks_uri')
    if (force) this.jwks.delete(uri)
    else { const hit = this.jwks.get(uri); if (hit && hit.until > this.deps.now()) return structuredClone(hit.value) }
    const data = await this.fetchJson(cfg, uri, { headers: { Accept: 'application/json' } }, `Failed to reach OIDC endpoint: ${uri}`)
    this.jwks.set(uri, { until: this.deps.now() + CACHE_TTL_S, value: structuredClone(data) })
    return data
  }

  private postForm(cfg: OidcConfig, url: string, form: Record<string, string>): Promise<Dict> {
    return this.fetchJson(cfg, url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }, 'Failed to exchange the OIDC authorization code')
  }

  private async validateIdToken(cfg: OidcConfig, token: string, nonce: string, jwksUri: string): Promise<Dict> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new OidcAuthError('OIDC id_token was not a JWT')
    const [h, p, s] = parts as [string, string, string]
    let header: unknown
    let claims: unknown
    let signature: Buffer
    try { header = JSON.parse(b64uDecode(h).toString('utf8')); claims = JSON.parse(b64uDecode(p).toString('utf8')); signature = b64uDecode(s) } catch { throw new OidcAuthError('OIDC id_token could not be decoded') }
    if (!isDict(header) || !isDict(claims)) throw new OidcAuthError('OIDC id_token payload was malformed')
    const alg = str(header.alg).trim()
    if (!alg || alg === 'none') throw new OidcAuthError('OIDC id_token uses an unsupported signing algorithm')
    let jwks = await this.jwksDocument(cfg, jwksUri)
    let key: KeyObject
    try {
      key = selectKey(jwks, header, alg)
    } catch (error) {
      if (!(error instanceof OidcAuthError && error.message.includes('did not contain the signing key'))) throw error
      jwks = await this.jwksDocument(cfg, jwksUri, true)
      key = selectKey(jwks, header, alg)
    }
    verifyJwt(key, alg, Buffer.from(`${h}.${p}`, 'ascii'), signature)
    this.validateClaims(claims, cfg, nonce)
    if (!str(claims.sub).trim()) throw new OidcAuthError('OIDC id_token did not include a subject')
    return claims
  }

  private validateClaims(claims: Dict, cfg: OidcConfig, nonce: string): void {
    const now = this.deps.now()
    if (str(claims.iss).trim() !== cfg.issuer) throw new OidcAuthError('OIDC id_token issuer did not match the configured issuer')
    const aud = claims.aud
    const audiences = Array.isArray(aud) ? aud.map((a) => str(a)) : aud === null || aud === undefined ? [] : [str(aud)]
    if (!audiences.includes(cfg.client_id)) throw new OidcAuthError('OIDC id_token audience did not include this client')
    if (audiences.length > 1 && !['', cfg.client_id].includes(str(claims.azp).trim())) throw new OidcAuthError('OIDC id_token azp did not match this client')
    const num = (name: string): number | null => {
      const v = claims[name]
      if (v === null || v === undefined) return null
      const n = typeof v === 'number' ? v : Number(str(v))
      if (!Number.isFinite(n)) throw new OidcAuthError(`OIDC id_token claim ${name} was not numeric`)
      return n
    }
    const exp = num('exp')
    if (exp === null || exp < now - CLOCK_SKEW_S) throw new OidcAuthError('OIDC id_token has expired')
    const nbf = num('nbf')
    if (nbf !== null && nbf > now + CLOCK_SKEW_S) throw new OidcAuthError('OIDC id_token is not valid yet')
    const iat = num('iat')
    if (iat !== null && iat > now + CLOCK_SKEW_S) throw new OidcAuthError('OIDC id_token has an invalid issued-at time')
    if (str(claims.nonce).trim() !== nonce) throw new OidcAuthError('OIDC id_token nonce did not match the login request')
  }
}

/**
 * Python `json.dumps(value, sort_keys=True, separators=(",", ":"))` — including its default `ensure_ascii=True`, which
 * escapes every non-ASCII character as `\uXXXX`; the mapping fingerprint persisted by the Python server must verify here.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isDict(value)) return `{${Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${pyJsonString(k)}:${canonicalJson(value[k])}`).join(',')}}`
  if (typeof value === 'string') return pyJsonString(value)
  return JSON.stringify(value)
}

/** `json.dumps` of one string with `ensure_ascii=True` (UTF-16 code units above 0x7f become `\uXXXX`). */
function pyJsonString(text: string): string {
  return JSON.stringify(text).replaceAll(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

const EC_CURVES: Record<string, string> = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }

function selectKey(jwks: Dict, header: Dict, alg: string): KeyObject {
  const keys = Array.isArray(jwks.keys) ? jwks.keys.filter(isDict) : []
  if (!keys.length) throw new OidcAuthError('OIDC JWKS did not contain any signing keys', 502)
  const kid = str(header.kid).trim()
  const match = keys.find((k) => {
    if (k.use !== undefined && k.use !== null && k.use !== 'sig') return false
    if (kid && str(k.kid).trim() !== kid) return false
    if (k.alg !== undefined && k.alg !== null && k.alg !== alg) return false
    const kty = str(k.kty).trim()
    if (alg.startsWith('RS')) return kty === 'RSA'
    if (alg.startsWith('ES')) return kty === 'EC' && str(k.crv).trim() === EC_CURVES[alg]
    return true
  })
  if (!match) throw new OidcAuthError('OIDC JWKS did not contain the signing key for this id_token', 502)
  const kty = str(match.kty).trim()
  try {
    if (kty === 'RSA') { if (!match.n || !match.e) throw new Error('missing'); return createPublicKey({ key: { kty: 'RSA', n: str(match.n), e: str(match.e) }, format: 'jwk' }) }
    if (kty === 'EC') {
      const crv = str(match.crv).trim()
      if (!['P-256', 'P-384', 'P-521'].includes(crv)) throw new OidcAuthError(`Unsupported OIDC EC curve: ${crv}`, 502)
      if (!match.x || !match.y) throw new Error('missing')
      return createPublicKey({ key: { kty: 'EC', crv, x: str(match.x), y: str(match.y) }, format: 'jwk' })
    }
  } catch (error) {
    if (error instanceof OidcAuthError) throw error
    throw new OidcAuthError('OIDC JWKS key was missing a required parameter', 502)
  }
  throw new OidcAuthError(`Unsupported OIDC key type: ${kty}`, 502)
}

function verifyJwt(key: KeyObject, alg: string, signed: Buffer, signature: Buffer): void {
  const hash = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' }[alg]
  if (!hash) throw new OidcAuthError(`Unsupported OIDC signing algorithm: ${alg}`, 502)
  const partSize = { ES256: 32, ES384: 48, ES512: 66 }[alg]
  if (partSize !== undefined && signature.length !== partSize * 2) throw new OidcAuthError('OIDC id_token ECDSA signature was malformed')
  let ok = false
  try { ok = cryptoVerify(hash, signed, alg.startsWith('ES') ? { key, dsaEncoding: 'ieee-p1363' } : key, signature) } catch { ok = false }
  if (!ok) throw new OidcAuthError('OIDC id_token signature verification failed')
}
