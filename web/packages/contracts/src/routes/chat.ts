import { oc } from '@orpc/contract'
import { z } from 'zod'

/** Agent turns, approvals, clarify prompts, goals, background tasks, and side questions. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['chat']

export const AttachmentSchema = z.object({ name: z.string().optional(), filename: z.string().optional(), path: z.string().optional(), mime: z.string().optional(), size: z.number().int().optional(), is_image: z.boolean().optional() }).catchall(Json)
export const ChatStartRequestSchema = z.object({
  session_id: z.string(), message: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), workspace: z.string().nullable().optional(),
  profile: z.string().nullable().optional(), explicit_model_pick: z.boolean().optional(), attachments: z.array(z.union([AttachmentSchema, z.string()])).optional(), moa_config: z.boolean().optional(),
  regenerate: z.boolean().optional(), regeneration_revision: z.string().optional(),
}).catchall(Json)
export const ChatStartResponseSchema = z.object({
  stream_id: z.string().optional(), session_id: z.string().optional(), pending_started_at: z.number().nullable().optional(), turn_id: z.string().nullable().optional(), title: z.string().optional(),
  effective_model: z.string().optional(), effective_model_provider: z.string().optional(), status: z.string().optional(), reason: z.string().optional(),
})
export const StreamStatusSchema = z.object({ active: z.boolean(), stream_id: z.string(), replay_available: z.boolean(), journal: Loose.optional() })
export const CancelResponseSchema = z.object({ ok: z.boolean(), cancelled: z.boolean(), stream_id: z.string() })
export const SteerResponseSchema = z.object({ accepted: z.boolean(), fallback: z.string().nullable(), stream_id: z.string().nullable(), steer_id: z.string().optional() })
export const PendingEnvelopeSchema = z.object({ pending: Loose.nullable(), pending_count: z.number().int() })
export const ApprovalRespondSchema = z.object({ session_id: z.string().optional(), choice: z.string().optional(), approval_id: z.string().optional(), yolo: z.boolean().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() }).catchall(Json)
export const ClarifyRespondSchema = z.object({ session_id: z.string().optional(), response: z.string().optional(), answer: z.string().optional(), choice: z.string().optional(), clarify_id: z.string().optional() }).catchall(Json)
export const GoalRequestSchema = z.object({ session_id: z.string().optional(), args: z.string().optional(), text: z.string().optional(), profile: z.string().optional(), workspace: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), explicit_model_pick: z.boolean().optional() }).catchall(Json)

export const chatContract = {
  chat: {
    start: oc.route({ method: 'POST', path: '/api/chat/start', tags, summary: 'Admit one agent turn and return the stream id for `/api/chat/stream`.' }).input(ChatStartRequestSchema).output(ChatStartResponseSchema),
    steer: oc.route({ method: 'POST', path: '/api/chat/steer', tags }).input(z.object({ session_id: z.string().optional(), text: z.string().optional(), display_text: z.string().optional(), steer_id: z.string().optional() }).catchall(Json)).output(SteerResponseSchema),
    cancel: oc.route({ method: 'GET', path: '/api/chat/cancel', tags }).input(z.object({ stream_id: z.string().optional() })).output(CancelResponseSchema),
    streamStatus: oc.route({ method: 'GET', path: '/api/chat/stream/status', tags }).input(z.object({ stream_id: z.string().optional() })).output(StreamStatusSchema),
  },
  approval: {
    pending: oc.route({ method: 'GET', path: '/api/approval/pending', tags: ['approval'] }).input(z.object({ session_id: z.string().optional() })).output(PendingEnvelopeSchema),
    respond: oc.route({ method: 'POST', path: '/api/approval/respond', tags: ['approval'] }).input(ApprovalRespondSchema).output(z.object({ ok: z.boolean(), choice: z.string().optional(), yolo_enabled: z.boolean().optional(), stale_cleared: z.boolean().optional() }).catchall(Json)),
  },
  clarify: {
    pending: oc.route({ method: 'GET', path: '/api/clarify/pending', tags: ['approval'] }).input(z.object({ session_id: z.string().optional() })).output(PendingEnvelopeSchema),
    respond: oc.route({ method: 'POST', path: '/api/clarify/respond', tags: ['approval'] }).input(ClarifyRespondSchema).output(z.object({ ok: z.boolean(), response: z.string().optional(), error: z.string().optional(), stale: z.boolean().optional() })),
  },
  goal: oc.route({ method: 'POST', path: '/api/goal', tags }).input(GoalRequestSchema).output(z.object({ ok: z.boolean().optional(), action: z.string().optional(), goal: Loose.nullable().optional(), message: z.string().optional(), message_key: z.string().optional(), stream_id: z.string().optional(), status: z.string().optional(), reason: z.string().optional() }).catchall(Json)),
  background: {
    start: oc.route({ method: 'POST', path: '/api/background', tags }).input(z.object({ session_id: z.string().optional(), prompt: z.string().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), task_id: z.string(), stream_id: z.string(), session_id: z.string() })),
    status: oc.route({ method: 'GET', path: '/api/background/status', tags }).input(z.object({ session_id: z.string().optional() })).output(z.object({ results: z.array(Loose) })),
    ack: oc.route({ method: 'POST', path: '/api/bg-task-complete-ack', tags }).input(z.object({ session_id: z.string().optional(), task_id: z.string().optional(), process_id: z.string().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), session_id: z.string(), task_id: z.string(), noop: z.literal(true) })),
  },
  btw: oc.route({ method: 'POST', path: '/api/btw', tags, summary: 'Ephemeral side question answered in a hidden session that inherits the transcript.' }).input(z.object({ session_id: z.string().optional(), question: z.string().optional() }).catchall(Json)).output(z.object({ stream_id: z.string(), session_id: z.string(), parent_session_id: z.string() })),
}
