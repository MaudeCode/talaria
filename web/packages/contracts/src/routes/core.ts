import { oc } from '@orpc/contract'
import { z } from 'zod'

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

/** `api/_release.json` as validated by the Python `release_info` module; a development checkout reports nulls. */
export const ReleaseInfoSchema = z.object({
  tag: z.string().nullable(),
  version: z.string(),
  sourceRevision: Sha1.nullable(),
  releaseSet: Sha1.nullable(),
  upstreamBase: Sha1.nullable(),
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
})
export type Health = z.infer<typeof HealthSchema>

export const LoginRequestSchema = z.object({ password: z.string().optional() })
export const LoginResponseSchema = z.object({ ok: z.literal(true), message: z.string().optional() })
export const LogoutResponseSchema = z.object({ ok: z.literal(true), trusted_logout_url: z.string().optional() })

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
  },
}
