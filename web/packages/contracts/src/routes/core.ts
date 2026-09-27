import { oc } from '@orpc/contract'
import { z } from 'zod'
import { LoginResponseSchema } from '../views.js'

/**
 * Core routes: liveness, the public bootstrap document, and password
 * sessions. Shapes mirror the Python backend byte for byte where a consumer
 * (frontend `BootstrapSchema`, iOS app, `ctl` scripts) reads them.
 */

const NullableString = z.string().nullable()

export const ErrorBodySchema = z.object({ error: z.string() }).catchall(z.unknown())
export type ErrorBody = z.infer<typeof ErrorBodySchema>

export const AuthStatusSchema = z.object({
  auth_enabled: z.boolean(),
  logged_in: z.boolean(),
  oidc_enabled: z.boolean(),
  oidc_native_handoff_enabled: z.boolean(),
  password_auth_enabled: z.boolean(),
  passwordless_enabled: z.boolean(),
  passkeys_enabled: z.boolean(),
  passkeys_count: z.number().int(),
  passkey_feature_flag: z.boolean(),
  auth_disabled_acknowledged: z.boolean(),
  can_manage_server: z.boolean(),
  trusted_auth_enabled: z.boolean().optional(),
  auth_type: z.string().optional(),
  user: NullableString.optional(),
  bound_profile: NullableString.optional(),
})
export type AuthStatus = z.infer<typeof AuthStatusSchema>

export const BootstrapFeaturesSchema = z.object({
  dashboard: z.boolean(),
  terminal_remote_backend: z.boolean(),
  extensions: z.boolean(),
  single_profile_mode: z.boolean(),
})
export type BootstrapFeatures = z.infer<typeof BootstrapFeaturesSchema>

export const BootstrapSchema = z.object({
  webui_version: z.string(),
  max_upload_bytes: z.number().int().positive(),
  csrf_token: z.string(),
  language: z.string(),
  bot_name: z.string(),
  auth: AuthStatusSchema,
  profile: z.object({ name: z.string(), is_default: z.boolean() }).nullable(),
  onboarding: z.object({ completed: z.boolean() }).nullable(),
  features: BootstrapFeaturesSchema,
})
export type Bootstrap = z.infer<typeof BootstrapSchema>

const Sha1 = z.string().regex(/^[a-f0-9]{40}$/)

/** `<webRoot>/_release.json` as written by `scripts/stamp-release.py`; a development checkout reports nulls. */
export const ReleaseInfoSchema = z.object({
  tag: z.string().nullable(),
  version: z.string(),
  sourceRevision: Sha1.nullable(),
  releaseSet: Sha1.nullable(),
  contracts: z.object({ appWeb: z.array(z.number().int()), webRelay: z.array(z.number().int()) }),
  compatibleAgent: z.object({ sourceRevision: Sha1, version: z.string(), image: z.string() }).catchall(z.unknown()),
})
export type ReleaseInfo = z.infer<typeof ReleaseInfoSchema>

export const HealthSchema = z.object({
  release: ReleaseInfoSchema,
  status: z.enum(['ok', 'degraded', 'starting']),
  phase: z.string().optional(),
  sessions: z.number().int(),
  active_streams: z.number().int(),
  active_runs: z.number().int(),
  runs: z.array(z.record(z.string(), z.unknown())),
  last_run_finished_at: z.number().nullable(),
  server_started_at: z.number(),
  uptime_seconds: z.number(),
  accept_loop: z.object({ requests_total: z.number().int(), last_request_at: z.number() }),
  checks: z.record(z.string(), z.unknown()).optional(),
  /** Hermes Agent sidecar readiness, separate from server liveness: chat needs `ready`; `unavailable` means no Agent is configured. */
  agent: z.object({ status: z.enum(['ready', 'starting', 'restarting', 'incompatible', 'stopped', 'unavailable']) }),
})
export type Health = z.infer<typeof HealthSchema>

export const LoginRequestSchema = z.object({ password: z.string().optional() })
export const LogoutResponseSchema = z.object({ ok: z.literal(true), trusted_logout_url: z.string().optional() })

export const OidcNativeStartRequestSchema = z.object({ callback_url: z.string(), state: z.string(), code_challenge: z.string(), code_challenge_method: z.string() })
export const OidcNativeStartResponseSchema = z.object({ flow_id: z.string(), authorization_url: z.string(), server_id: z.string(), expires_in: z.number().int() })
export const OidcNativeExchangeRequestSchema = z.object({ flow_id: z.string(), code: z.string(), state: z.string(), code_verifier: z.string() })
export const OidcNativeCancelRequestSchema = z.object({ flow_id: z.string(), state: z.string() })
const AuthOkSchema = z.object({ ok: z.literal(true) })
const OkFlagSchema = z.object({ ok: z.boolean() })

/** WebAuthn options are handed to the browser verbatim (`PublicKeyCredentialCreationOptions` / `RequestOptions` with base64url binaries). */
export const PasskeyOptionsResponseSchema = z.object({ ok: z.literal(true), publicKey: z.record(z.string(), z.unknown()) })
export const PasskeyCredentialSchema = z.object({ id: z.string(), label: z.string(), created_at: z.number(), last_used_at: z.number().nullable(), sign_count: z.number().int() })
export type PasskeyCredential = z.infer<typeof PasskeyCredentialSchema>
/** A serialised `PublicKeyCredential` (`id`, `rawId`, `type`, `response.{clientDataJSON,attestationObject|authenticatorData,signature}`), plus an optional `label` on register (the Python field; the frontend's `name` is reconciled in checkpoint 8). */
export const PasskeyAssertionSchema = z.object({ id: z.string().optional(), rawId: z.string().optional(), type: z.string().optional(), name: z.string().optional(), response: z.record(z.string(), z.unknown()).optional() }).catchall(z.unknown())
export const PasskeyRegisterResponseSchema = z.object({ ok: z.literal(true), credential: z.object({ id: z.string(), label: z.string() }), credentials: z.array(PasskeyCredentialSchema) })
export const PasskeyLoginResponseSchema = z.object({ ok: z.literal(true) })
export const PasskeyDeleteRequestSchema = z.object({ id: z.string() })
export const PasskeyDeleteResponseSchema = z.object({ ok: z.literal(true), credentials: z.array(PasskeyCredentialSchema) })
export const PasskeysListSchema = z.object({ credentials: z.array(PasskeyCredentialSchema), disabled: z.boolean().optional() })

export const coreContract = {
  health: oc
    .route({ method: 'GET', path: '/health', tags: ['core'], summary: 'Liveness and release identity; `deep=1` adds startup and store probes.' })
    .input(z.object({ deep: z.string().optional() }))
    .output(HealthSchema),
  bootstrap: oc
    .route({ method: 'GET', path: '/api/bootstrap', tags: ['core'], summary: 'Public runtime configuration and initial state for the shell.' })
    .output(BootstrapSchema),
  auth: {
    status: oc.route({ method: 'GET', path: '/api/auth/status', tags: ['auth'] }).output(AuthStatusSchema),
    login: oc.route({ method: 'POST', path: '/api/auth/login', tags: ['auth'] }).input(LoginRequestSchema).output(LoginResponseSchema),
    logout: oc.route({ method: 'POST', path: '/api/auth/logout', tags: ['auth'] }).output(LogoutResponseSchema),
    oidcNativeStart: oc
      .route({ method: 'POST', path: '/api/auth/oidc/native/start', tags: ['auth'], summary: 'Begin a native-app OIDC handoff (S256 PKCE, rate limited per client IP).' })
      .input(OidcNativeStartRequestSchema).output(OidcNativeStartResponseSchema),
    oidcNativeExchange: oc
      .route({ method: 'POST', path: '/api/auth/oidc/native/exchange', tags: ['auth'], summary: 'Redeem the one-time native handoff code for a session cookie.' })
      .input(OidcNativeExchangeRequestSchema).output(AuthOkSchema),
    oidcNativeCancel: oc
      .route({ method: 'POST', path: '/api/auth/oidc/native/cancel', tags: ['auth'], summary: 'Abandon a pending native handoff.' })
      .input(OidcNativeCancelRequestSchema).output(OkFlagSchema),
    passkeyOptions: oc
      .route({ method: 'POST', path: '/api/auth/passkey/options', tags: ['auth'], summary: 'WebAuthn assertion options for login (public; CSRF exempt).' })
      .output(PasskeyOptionsResponseSchema),
    passkeyLogin: oc
      .route({ method: 'POST', path: '/api/auth/passkey/login', tags: ['auth'], summary: 'Verify a passkey assertion and start a session (public; CSRF exempt).' })
      .input(PasskeyAssertionSchema).output(PasskeyLoginResponseSchema),
    passkeyRegisterOptions: oc
      .route({ method: 'POST', path: '/api/auth/passkey/register/options', tags: ['auth'], summary: 'WebAuthn creation options (owner session or local first-run bootstrap).' })
      .output(PasskeyOptionsResponseSchema),
    passkeyRegister: oc
      .route({ method: 'POST', path: '/api/auth/passkey/register', tags: ['auth'], summary: 'Store a new ES256 passkey credential.' })
      .input(PasskeyAssertionSchema).output(PasskeyRegisterResponseSchema),
    passkeyDelete: oc
      .route({ method: 'POST', path: '/api/auth/passkey/delete', tags: ['auth'], summary: 'Remove a passkey; the last one is kept while no password is set (409).' })
      .input(PasskeyDeleteRequestSchema).output(PasskeyDeleteResponseSchema),
    passkeys: oc
      .route({ method: 'GET', path: '/api/auth/passkeys', tags: ['auth'], summary: 'Registered passkey metadata (`disabled: true` when the feature flag is off).' })
      .output(PasskeysListSchema),
  },
}
