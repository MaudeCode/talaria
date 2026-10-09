import { oc } from '@orpc/contract'
import { z } from 'zod'
import { ChatStartRequestSchema, ChatStartResponseSchema, StreamStatusSchema, CancelResponseSchema, SteerResponseSchema, SteerWithdrawRequestSchema, SteerWithdrawResponseSchema, SteerSendNowRequestSchema, SteerSendNowResponseSchema, ApprovalPendingEnvelopeSchema, ApprovalRespondResponseSchema, ClarifyPendingEnvelopeSchema, ClarifyRespondResponseSchema, ClarifyAnswersSchema, GoalResponseSchema, SessionSchema, BackgroundStatusSchema, BackgroundTaskSchema, BackgroundTasksResponseSchema, BackgroundTaskResultSchema, BackgroundDismissRequestSchema, BackgroundDismissResponseSchema } from '../views.js'

/** Agent turns, approvals, clarify prompts, goals, background tasks, and side questions. */

const Json = z.unknown()
const tags = ['chat']

export const ApprovalRespondSchema = z.object({ session_id: z.string().optional(), choice: z.string().optional(), approval_id: z.string().optional(), yolo: z.boolean().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() }).catchall(Json)
export const ClarifyRespondSchema = z.object({ session_id: z.string().optional(), answers: ClarifyAnswersSchema.optional(), response: z.string().optional(), answer: z.string().optional(), choice: z.string().optional(), clarify_id: z.string().optional() }).catchall(Json)
/** Legacy blocking chat (`POST /api/chat`): no current client; `result` is the server's own summary, not the Agent result. */
export const ChatSyncRequestSchema = z.object({ session_id: z.string().optional(), message: z.string().optional(), workspace: z.string().nullable().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional() }).catchall(Json)
export const ChatSyncResponseSchema = z.object({ answer: z.string(), status: z.enum(['done', 'partial']), session: SessionSchema, result: z.object({ final_response: z.string(), completed: z.boolean(), interrupted: z.boolean() }) })
export const GoalRequestSchema = z.object({ session_id: z.string().optional(), args: z.string().optional(), text: z.string().optional(), profile: z.string().optional(), workspace: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), explicit_model_pick: z.boolean().optional() }).catchall(Json)

export const chatContract = {
  chat: {
    sync: oc.route({ method: 'POST', path: '/api/chat', tags, summary: 'Legacy blocking turn: runs one turn to its end and answers with the reply.' }).input(ChatSyncRequestSchema).output(ChatSyncResponseSchema),
    start: oc.route({ method: 'POST', path: '/api/chat/start', tags, summary: 'Admit one agent turn and return the stream id for `/api/chat/stream`.' }).input(ChatStartRequestSchema).output(ChatStartResponseSchema),
    steer: oc.route({ method: 'POST', path: '/api/chat/steer', tags }).input(z.object({ session_id: z.string().optional(), text: z.string().optional(), display_text: z.string().optional(), steer_id: z.string().optional() }).catchall(Json)).output(SteerResponseSchema),
    steerWithdraw: oc.route({ method: 'POST', path: '/api/chat/steer/withdraw', tags, summary: 'Take a pending steer back (Edit, Cancel) before the Agent takes it.' }).input(SteerWithdrawRequestSchema).output(SteerWithdrawResponseSchema),
    steerSendNow: oc.route({ method: 'POST', path: '/api/chat/steer/send-now', tags, summary: 'Deliver a pending steer now instead of after the running tools.' }).input(SteerSendNowRequestSchema).output(SteerSendNowResponseSchema),
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
    /** Old clients only: each finished `/background` result once per server. `tasks` is the shared, non-destructive view. */
    status: oc.route({ method: 'GET', path: '/api/background/status', tags }).input(z.object({ session_id: z.string().optional() })).output(BackgroundStatusSchema),
    /** `kind` narrows the list to one kind (TAL-373: the Agents page lists delegations only). */
    tasks: oc.route({ method: 'GET', path: '/api/background/tasks', tags, summary: 'The background work a session owns: delegations, notified processes and /background tasks (TAL-372).' }).input(z.object({ session_id: z.string(), kind: BackgroundTaskSchema.shape.kind.optional() })).output(BackgroundTasksResponseSchema),
    result: oc.route({ method: 'GET', path: '/api/background/result', tags }).input(z.object({ session_id: z.string(), task_id: z.string() })).output(BackgroundTaskResultSchema),
    dismiss: oc.route({ method: 'POST', path: '/api/background/dismiss', tags }).input(BackgroundDismissRequestSchema).output(BackgroundDismissResponseSchema),
    ack: oc.route({ method: 'POST', path: '/api/bg-task-complete-ack', tags }).input(z.object({ session_id: z.string().optional(), task_id: z.string().optional(), process_id: z.string().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), session_id: z.string(), task_id: z.string(), noop: z.literal(true) })),
  },
  btw: oc.route({ method: 'POST', path: '/api/btw', tags, summary: 'Ephemeral side question answered in a hidden session that inherits the transcript.' }).input(z.object({ session_id: z.string().optional(), question: z.string().optional() }).catchall(Json)).output(z.object({ stream_id: z.string(), session_id: z.string(), parent_session_id: z.string() })),
}
