import { z } from 'zod'

/** Extends auxiliary settings with the Agent's canonical route vocabulary. */
export const DelegationRouteSchema = z.object({
  name: z.string(), description: z.string().optional(), original_name: z.string().optional(),
  provider: z.string().optional(), model: z.string().optional(), base_url: z.string().optional(),
  api_mode: z.string().optional(), api_key_set: z.boolean().optional(),
  api_key: z.string().optional(), api_key_clear: z.boolean().optional(),
  reasoning_effort: z.string().optional(), service_tier: z.string().optional(),
  fallback_providers: z.array(z.unknown()).optional(), request_overrides: z.unknown().optional(),
  profile: z.string().optional(), label: z.string().optional(),
})
export const DelegationBlockSchema = z.object({
  options: z.array(DelegationRouteSchema).optional(), profiles: z.array(DelegationRouteSchema).optional(),
  default: z.string().nullable(),
})
export const DelegationWriteSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('backend'), backend: z.string() }),
  z.object({ action: z.literal('routes'), backend: z.enum(['model_map', 'profile_routes']), block: DelegationBlockSchema }),
])
export const DelegationRegistrySchema = z.object({
  supported: z.boolean(), configured: z.string(), effective: z.string().nullable(),
  available: z.boolean(), blocked_reason: z.string().nullable(), fixed_model_active: z.boolean(),
  backends: z.array(z.object({ name: z.string(), label: z.string(), description: z.string(), available: z.boolean(), reason: z.string() })),
  profiles: z.array(z.string()),
})
const PublicRoute = DelegationRouteSchema.omit({ api_key: true, api_key_clear: true, original_name: true, request_overrides: true })
const PublicBlock = DelegationBlockSchema.extend({ options: z.array(PublicRoute).optional(), profiles: z.array(PublicRoute).optional() })
export const DelegationSettingsSchema = DelegationRegistrySchema.extend({
  model_map: PublicBlock, profile_routes: PublicBlock,
})
export type DelegationSettings = z.infer<typeof DelegationSettingsSchema>
export type DelegationWrite = z.infer<typeof DelegationWriteSchema>
export type DelegationRoute = z.infer<typeof DelegationRouteSchema>
