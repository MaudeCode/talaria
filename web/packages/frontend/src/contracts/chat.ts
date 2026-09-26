/** Chat shapes live in the contract package; re-exported for the existing import paths. */
import { z } from 'zod'
import { SessionIdSchema } from '@maudecode/talaria-web-contracts'
export {
  ChatStartRequestSchema, ChatStartResponseSchema, StreamStatusSchema, CancelResponseSchema, SteerRequestSchema, SteerResponseSchema, ApprovalPendingSchema, ApprovalPendingEnvelopeSchema, ApprovalChoiceSchema,
  ApprovalRespondRequestSchema, ClarifyChoiceSchema, ClarifyPendingSchema, ClarifyPendingEnvelopeSchema, ClarifyRespondRequestSchema, ClarifyRespondResponseSchema, DraftResponseSchema, UploadResponseSchema,
  GoalViewSchema as GoalStateSchema, GoalResponseSchema, BackgroundResultSchema, BackgroundStatusSchema, ShareCreateResponseSchema, ShareMessageSchema, ShareReadSchema, SessionNewRequestSchema, TranscribeCapabilitySchema,
  type ChatStartRequest, type ChatStartResponse, type StreamStatus, type ApprovalPending, type ClarifyPending, type ClarifyStep, type UploadResponse,
} from '@maudecode/talaria-web-contracts'
/** Composer draft save body (the route takes the flattened fields). */
export const DraftRequestSchema = z.object({ session_id: SessionIdSchema, draft: z.object({ text: z.string(), files: z.array(z.unknown()).optional() }), draft_version: z.string().nullable().optional() })
export const TtsRequestSchema = z.object({ text: z.string(), voice: z.string().optional(), engine: z.string().optional() })
