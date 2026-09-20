import { z } from 'zod'
import { AuthStatusSchema } from './resources'

export const BootstrapSchema = z.object({
  webui_version: z.string(),
  max_upload_bytes: z.number().int().positive(),
  csrf_token: z.string(),
  language: z.string(),
  bot_name: z.string(),
  auth: AuthStatusSchema,
  profile: z.object({ name: z.string(), is_default: z.boolean() }).nullable(),
  onboarding: z.object({ completed: z.boolean() }).nullable(),
  features: z.object({ dashboard: z.boolean(), terminal_remote_backend: z.boolean(), extensions: z.boolean(), single_profile_mode: z.boolean() }),
})
export type Bootstrap = z.infer<typeof BootstrapSchema>

export function isAuthenticated(b: Bootstrap): boolean {
  return !b.auth.auth_enabled || b.auth.logged_in
}
