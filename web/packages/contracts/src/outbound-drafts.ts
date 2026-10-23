import { z } from 'zod'

/** A locator from a tool reply, never trusted content or permission. The backend resolves it again. */
export const OutboundDraftRefSchema = z.object({ draft_id: z.string().regex(/^d_[0-9a-f]{8}$/), card: z.number().int().positive() })
export type OutboundDraftRef = z.infer<typeof OutboundDraftRefSchema>
export const OutboundDraftFieldsSchema = z.object({
  from: z.string().max(320), to: z.array(z.string().max(320)).max(50), cc: z.array(z.string().max(320)).max(50), bcc: z.array(z.string().max(320)).max(50),
  subject: z.string().max(300), body: z.string().max(20_000),
})
/** Server/sidecar-owned content, state, provenance and actions; clients only format and render them. */
export const OutboundDraftSchema = OutboundDraftRefSchema.extend({
  producer: z.literal('draft-cards'), producer_revision: z.string(), kind: z.enum(['email', 'message']), platform: z.string(),
  version: z.number().int().positive(), revision: z.string(), fields: OutboundDraftFieldsSchema,
  state: z.enum(['draft', 'approved', 'sent', 'saved', 'failed', 'discarded', 'superseded', 'unavailable']),
  can_edit: z.boolean(), can_approve: z.boolean(), masked: z.boolean(),
})
export type OutboundDraft = z.infer<typeof OutboundDraftSchema>
export const OutboundDraftResultSchema = z.object({ draft: OutboundDraftSchema.nullable() })
export const OutboundDraftQuerySchema = OutboundDraftRefSchema.extend({ session_id: z.string().min(1), tool_call_id: z.string().min(1) })
export const OutboundDraftActionSchema = OutboundDraftQuerySchema.extend({
  action: z.enum(['edit', 'approve']), version: z.number().int().positive(), revision: z.string().min(1), fields: OutboundDraftFieldsSchema.optional(),
})
export type OutboundDraftAction = z.infer<typeof OutboundDraftActionSchema>
