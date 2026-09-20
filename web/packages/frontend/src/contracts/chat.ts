import { z } from 'zod'
import { NullableString } from './common'
import { AttachmentSchema, SessionIdSchema, SessionSchema } from './session'

export const ChatStartRequestSchema = z.object({
  session_id: SessionIdSchema,
  message: z.string(),
  model: z.string().optional(),
  model_provider: z.string().nullable().optional(),
  workspace: z.string().optional(),
  profile: z.string().optional(),
  explicit_model_pick: z.boolean().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  moa_config: z.boolean().optional(),
  regeneration_revision: z.string().optional(),
})
export type ChatStartRequest = z.infer<typeof ChatStartRequestSchema>

/** Accepted turn. `stream_id` is the owner identity for the SSE connection. */
export const ChatStartResponseSchema = z.looseObject({
  stream_id: z.string(),
  session_id: SessionIdSchema.optional(),
  turn_id: NullableString.optional(),
  user_message_id: z.union([z.string(), z.number()]).nullable().optional(),
  pending_started_at: z.number().nullable().optional(),
  title: z.string().optional(),
  effective_model: z.string().optional(),
  effective_model_provider: z.string().optional(),
  queued: z.boolean().optional(),
  ok: z.boolean().optional(),
  status: z.string().optional(),
  session: SessionSchema.optional(),
})
export type ChatStartResponse = z.infer<typeof ChatStartResponseSchema>

export const StreamStatusSchema = z.looseObject({
  active: z.boolean(),
  stream_id: z.string(),
  replay_available: z.boolean().optional(),
  journal: z.unknown().optional(),
})
export type StreamStatus = z.infer<typeof StreamStatusSchema>

export const CancelResponseSchema = z.looseObject({ cancelled: z.boolean().optional(), ok: z.boolean().optional(), error: z.string().optional() })

/** `POST /api/chat/steer` (api/streaming.py): `text` is delivered to the running agent; `display_text` is what the transcript shows. */
export const SteerRequestSchema = z.object({ session_id: SessionIdSchema, text: z.string().min(1), display_text: z.string().optional(), steer_id: z.string().optional() })
/** `accepted: false` with a `fallback` reason means the message was not delivered (e.g. the run already finished); the caller keeps the draft. */
export const SteerResponseSchema = z.looseObject({ accepted: z.boolean(), fallback: NullableString.optional(), stream_id: NullableString.optional() })

export const ApprovalPendingSchema = z.looseObject({
  approval_id: z.string().optional(),
  session_id: z.string().optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  reason: z.string().optional(),
  action: z.string().optional(),
  question: z.string().optional(),
  status: z.string().optional(),
  pending_count: z.number().optional(),
  run_id: z.string().optional(),
  mirror_token: z.string().optional(),
})
export type ApprovalPending = z.infer<typeof ApprovalPendingSchema>
export const ApprovalPendingEnvelopeSchema = z.looseObject({ pending: ApprovalPendingSchema.nullable(), pending_count: z.number().optional() })
export const ApprovalChoiceSchema = z.enum(['once', 'session', 'always', 'deny'])
export const ApprovalRespondRequestSchema = z.object({ session_id: SessionIdSchema, choice: ApprovalChoiceSchema, approval_id: z.string().optional(), command: z.string().optional(), yolo: z.boolean().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() })

export const ClarifyChoiceSchema = z.union([z.string(), z.looseObject({ label: z.string().optional(), value: z.string().optional(), text: z.string().optional() })])
export const ClarifyPendingSchema = z.looseObject({
  clarify_id: z.string().optional(),
  session_id: z.string().optional(),
  question: z.string().optional(),
  description: z.string().optional(),
  choices: z.array(ClarifyChoiceSchema).optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  reason: z.string().optional(),
  action: z.string().optional(),
  status: z.string().optional(),
  raw_preview: z.string().optional(),
  timeout_at: z.number().optional(),
  timeout_seconds: z.number().optional(),
  pending_count: z.number().optional(),
  index: z.number().optional(),
  total: z.number().optional(),
})
export type ClarifyPending = z.infer<typeof ClarifyPendingSchema>
export const ClarifyPendingEnvelopeSchema = z.looseObject({ pending: ClarifyPendingSchema.nullable(), pending_count: z.number().optional() })
export const ClarifyRespondRequestSchema = z.object({ session_id: SessionIdSchema, response: z.string(), clarify_id: z.string().optional() })
export const ClarifyRespondResponseSchema = z.looseObject({ ok: z.boolean().optional(), response: z.string().optional(), error: z.string().optional() })

export const DraftRequestSchema = z.object({ session_id: SessionIdSchema, draft: z.object({ text: z.string(), files: z.array(z.unknown()).optional() }), draft_version: z.number().nullable().optional() })
export const DraftResponseSchema = z.looseObject({ ok: z.boolean().optional(), draft: z.looseObject({ text: z.string().optional(), files: z.array(z.unknown()).optional() }).optional(), draft_version: z.number().nullable().optional(), unchanged: z.boolean().optional() })

export const UploadResponseSchema = z.looseObject({ filename: z.string(), path: z.string(), size: z.number(), mime: z.string(), is_image: z.boolean().optional(), rollback_token: z.string().optional() })
export type UploadResponse = z.infer<typeof UploadResponseSchema>

export const GoalStateSchema = z.looseObject({ text: z.string().optional(), state: z.string().optional(), status: z.string().optional(), turns: z.number().optional(), max_turns: z.number().optional(), reason: z.string().optional() })
export const GoalResponseSchema = z.looseObject({ ok: z.boolean().optional(), action: z.string().optional(), goal: GoalStateSchema.nullable().optional(), message: z.string().optional(), message_key: z.string().optional() })

export const BackgroundResultSchema = z.looseObject({ id: z.string().optional(), task_id: z.string().optional(), status: z.string().optional(), title: z.string().optional(), summary: z.string().optional(), error: z.string().optional(), completed_at: z.number().optional() })
export const BackgroundStatusSchema = z.looseObject({ results: z.array(BackgroundResultSchema) })

export const ShareCreateResponseSchema = z.looseObject({ ok: z.boolean().optional(), token: z.string().optional(), url: z.string().optional(), share: z.looseObject({ token: z.string().optional(), url: z.string().optional() }).optional(), error: z.string().optional() })
export const ShareMessageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.null(), z.array(z.unknown())]).optional() })
export const ShareReadSchema = z.looseObject({ share: z.looseObject({ title: z.string().optional(), created_at: z.number().optional(), messages: z.array(ShareMessageSchema).optional(), message_count: z.number().optional(), model: NullableString.optional() }) })

export const SessionNewRequestSchema = z.object({
  title: z.string().optional(),
  workspace: z.string().optional(),
  model: z.string().optional(),
  model_provider: z.string().nullable().optional(),
  profile: z.string().optional(),
  prev_session_id: z.string().optional(),
  worktree: z.boolean().optional(),
  enabled_toolsets: z.array(z.string()).nullable().optional(),
  parent_session_id: z.string().optional(),
})

export const TtsRequestSchema = z.object({ text: z.string(), voice: z.string().optional(), engine: z.string().optional() })
export const TranscribeCapabilitySchema = z.looseObject({ available: z.boolean().optional(), supported: z.boolean().optional(), engine: z.string().optional(), reason: z.string().optional() })
