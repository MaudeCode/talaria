import { z } from 'zod'

export const SpeedTierSchema = z.object({
  id: z.enum(['standard', 'priority', 'ultrafast', 'fast']),
  service_tier: z.enum(['default', 'priority', 'ultrafast']).describe('Value to save; Anthropic Fast is persisted as priority and sent as speed: fast.'),
})
