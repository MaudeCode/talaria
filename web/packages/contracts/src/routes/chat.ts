import { oc } from '@orpc/contract'
import { z } from 'zod'
import { ChatStartRequestSchema, ChatStartResponseSchema, StreamStatusSchema, CancelResponseSchema, SteerResponseSchema, ApprovalPendingEnvelopeSchema, ApprovalRespondResponseSchema, ClarifyPendingEnvelopeSchema, ClarifyRespondResponseSchema, ClarifyAnswersSchema, GoalResponseSchema, BackgroundStatusSchema } from '../views.js'

/** Agent turns, approvals, clarify prompts, goals, background tasks, and side questions. */

const Json = z.unknown()
const tags = ['chat']

export const ApprovalRespondSchema = z.object({ session_id: z.string().optional(), choice: z.string().optional(), approval_id: z.string().optional(), yolo: z.boolean().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() }).catchall(Json)
export const ClarifyRespondSchema = z.object({ session_id: z.string().optional(), answers: ClarifyAnswersSchema.optional(), response: z.string().optional(), answer: z.string().optional(), choice: z.string().optional(), clarify_id: z.string().optional() }).catchall(Json)
export const GoalRequestSchema = z.object({ session_id: z.string().optional(), args: z.string().optional(), text: z.string().optional(), profile: z.string().optional(), workspace: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), explicit_model_pick: z.boolean().optional() }).catchall(Json)

export const chatContract = {
  chat: {
    start: oc.route({ method: 'POST', path: '/api/chat/start', tags, summary: 'Admit one agent turn and return the stream id for `/api/chat/stream`.' }).input(ChatStartRequestSchema).output(ChatStartResponseSchema),
    steer: oc.route({ method: 'POST', path: '/api/chat/steer', tags }).input(z.object({ session_id: z.string().optional(), text: z.string().optional(), display_text: z.string().optional(), steer_id: z.string().optional() }).catchall(Json)).output(SteerResponseSchema),
    cancel: oc.route({ method: 'GET', path: '/api/chat/cancel', tags }).input(z.object({ stream_id: z.string().optional() })).output(CancelResponseSchema),
    streamStatus: oc.route({ method: 'GET', path: '/api/chat/stream/status', tags }).input(z.object({ stream_id: z.string().optional() })).output(StreamStatusSchema),
  },
  approval: {
    pending: oc.route({ method: 'GET', path: '/api/approval/pending', tags: ['approval'] }).input(z.object({ session_id: z.string().optional() })).output(ApprovalPendingEnvelopeSchema),
    respond: oc.route({ method: 'POST', path: '/api/approval/respond', tags: ['approval'] }).input(ApprovalRespondSchema).output(ApprovalRespondResponseSchema),
  },
  clarify: {
    pending: oc.route({ method: 'GET', path: '/api/clarify/pending', tags: ['approval'] }).input(z.object({ session_id: z.string().optional() })).output(ClarifyPendingEnvelopeSchema),
    respond: oc.route({ method: 'POST', path: '/api/clarify/respond', tags: ['approval'] }).input(ClarifyRespondSchema).output(ClarifyRespondResponseSchema),
  },
  goal: oc.route({ method: 'POST', path: '/api/goal', tags }).input(GoalRequestSchema).output(GoalResponseSchema),
  background: {
    start: oc.route({ method: 'POST', path: '/api/background', tags }).input(z.object({ session_id: z.string().optional(), prompt: z.string().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), task_id: z.string(), stream_id: z.string(), session_id: z.string() })),
    status: oc.route({ method: 'GET', path: '/api/background/status', tags }).input(z.object({ session_id: z.string().optional() })).output(BackgroundStatusSchema),
    ack: oc.route({ method: 'POST', path: '/api/bg-task-complete-ack', tags }).input(z.object({ session_id: z.string().optional(), task_id: z.string().optional(), process_id: z.string().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), session_id: z.string(), task_id: z.string(), noop: z.literal(true) })),
  },
  btw: oc.route({ method: 'POST', path: '/api/btw', tags, summary: 'Ephemeral side question answered in a hidden session that inherits the transcript.' }).input(z.object({ session_id: z.string().optional(), question: z.string().optional() }).catchall(Json)).output(z.object({ stream_id: z.string(), session_id: z.string(), parent_session_id: z.string() })),
}
