import { z } from 'zod'

/** TAL-2655: the most fallback entries one read reports, and the longest error each carries. */
export const FALLBACK_CHECK_MAX_ENTRIES = 32
export const FALLBACK_CHECK_ERROR_MAX = 300

/** TAL-2655: one entry as the Agent's static `hermes fallback check` judged it (sidecar `providers.fallback_check`). */
export const FallbackCheckSidecarEntrySchema = z.object({
  provider: z.string(), model: z.string(), configured: z.boolean(), auth_ready: z.boolean(), ready: z.boolean(), error_class: z.string(), error: z.string(),
})
export const FallbackCheckSidecarSchema = z.object({
  available: z.boolean().describe('False when the Agent has no static fallback check; `entries` is then empty.'),
  entries: z.array(FallbackCheckSidecarEntrySchema),
})

export const FallbackStatusSchema = z.enum(['ready', 'auth', 'config'])
export type FallbackStatus = z.infer<typeof FallbackStatusSchema>

export const FallbackCheckEntrySchema = z.object({
  position: z.number().int().positive().describe('1-based place in the effective chain (`fallback_providers`, then legacy `fallback_model`).'),
  provider: z.string(),
  provider_label: z.string().describe('The provider as the catalog names it; the configured id when the Agent does not know the provider.'),
  model: z.string(),
  configured: z.boolean().describe('The Agent resolved a route for the entry.'),
  auth_ready: z.boolean().describe('The resolved route has usable credentials. Always false when `configured` is false.'),
  status: FallbackStatusSchema.describe('`ready`: configured with usable credentials (static; no request was sent). `auth`: configured, credentials missing or unusable. `config`: unknown provider or a route the Agent cannot build.'),
  error: z.string().max(FALLBACK_CHECK_ERROR_MAX).nullable().describe('The Agent\'s reason, redacted by the server; null when `status` is `ready`.'),
})
export type FallbackCheckEntry = z.infer<typeof FallbackCheckEntrySchema>

/** `/api/model/fallback` (TAL-2655): the active profile's fallback chain with each entry's static readiness, in chain order. */
export const FallbackCheckSchema = z.object({
  available: z.boolean().describe('False when the Agent cannot check its fallback chain; nothing is known about readiness and `entries` is empty.'),
  entries: z.array(FallbackCheckEntrySchema).max(FALLBACK_CHECK_MAX_ENTRIES).describe('Empty while available: the profile has no fallback chain.'),
})
export type FallbackCheck = z.infer<typeof FallbackCheckSchema>
