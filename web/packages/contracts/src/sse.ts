import { z } from 'zod'
import { RateLimitWaitSchema, RunStatusSchema } from './run-status.js'
import { ApprovalPendingSchema, SessionSchema, AgentRuntimeMetadataSchema, ClarifyStepSchema, VaultPromptSchema, ConnectorOperationViewSchema, ContextUsageFields, PendingSteerSchema, SessionGoalSchema, SessionNoticeSchema, SteerWithdrawnSchema, ToolDisplayFields, ToolProgressSchema, ToolResultViewSchema, TodoStateSchema, TurnTerminalStateSchema } from './views.js'
export { RateLimitWaitSchema, type RateLimitWait } from './run-status.js'

/**
 * Wire events of `GET /api/chat/stream` and the per-session relay
 * (docs/rfcs/session-sse-contract-v1.md, "Chat stream events"),
 * modelled as a discriminated union on the SSE `event:` name. Payloads are
 * loose objects: the reducer reads the named fields and preserves the rest.
 */
const Text = z.looseObject({ text: z.string().optional(), already_streamed: z.boolean().optional(), reasoning_echo: z.boolean().optional(), session_id: z.string().optional() })
const Reasoning = z.looseObject({ text: z.string().optional(), titles: z.array(z.string()).optional(), name: z.string().optional(), session_id: z.string().optional() })
const Tool = z.looseObject({ name: z.string().optional(), ...ToolDisplayFields, preview: z.string().nullable().optional(), args: z.unknown().optional(), event_type: z.string().optional(), session_id: z.string().optional(), /** The call's one id, the same on its `tool` and `tool_complete` frames; `after_tool_call_id` names it. */ id: z.string(), timestamp: z.number().optional() })
const ToolComplete = Tool.extend({ duration: z.number().nullable().optional(), is_error: z.boolean().optional(), cost_usd: z.number().nullable().optional(), result: z.unknown().optional(), result_view: ToolResultViewSchema.optional(), output: z.unknown().optional() })
const Approval = z.looseObject({ allowed_choices: ApprovalPendingSchema.shape.allowed_choices, can_enable_yolo: ApprovalPendingSchema.shape.can_enable_yolo, approval_id: z.string().optional(), session_id: z.string().optional(), command: z.string().optional(), description: z.string().optional(), title: z.string().optional(), name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), question: z.string().optional(), status: z.string().optional(), pending_count: z.number().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() })
const Clarify = z.looseObject({ steps: z.array(ClarifyStepSchema).optional(), vault: VaultPromptSchema.optional(), clarify_id: z.string().optional(), session_id: z.string().optional(), question: z.string().optional(), choices: z.array(z.unknown()).optional(), title: z.string().optional(), name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), status: z.string().optional(), raw_preview: z.string().optional(), timeout_seconds: z.number().optional(), timeout_at: z.number().optional(), index: z.number().optional(), total: z.number().optional() })
const Compression = z.looseObject({ session_id: z.string().optional(), old_session_id: z.string().optional(), new_session_id: z.string().optional(), continuation_session_id: z.string().optional(), usage: z.looseObject(ContextUsageFields).optional() })
/**
 * TAL-1006: an open compression span. `started_at` (epoch seconds) is the span's start, the same on every heartbeat;
 * `compressed` closes it, as does the turn's terminal frame. A journal written before the field shipped omits it, and
 * clients time that span from its first frame (old-server fallback: delete once no such journal can replay).
 */
const Compressing = Compression.extend({ started_at: z.number().optional() })
const Title = z.looseObject({ session_id: z.string().optional(), title: z.string().optional(), status: z.string().optional(), reason: z.string().optional(), message: z.string().optional(), message_key: z.string().optional(), message_args: z.array(z.unknown()).optional(), raw_preview: z.string().optional(), prefill: z.unknown().optional() })
const Warning = z.looseObject({ type: z.string().optional(), message: z.string().optional() })
const AppError = z.looseObject({ ...AgentRuntimeMetadataSchema.shape, condition: z.string().optional(), terminal_state: TurnTerminalStateSchema.optional(), type: z.string().optional(), message: z.string().optional(), details: z.unknown().optional(), hint: z.string().optional(), session_id: z.string().optional(), old_session_id: z.string().optional(), new_session_id: z.string().optional(), continuation_session_id: z.string().optional(), status: z.union([z.string(), z.number()]).optional(), session: z.unknown().optional(), code: z.string().optional() })
/** `usage`: the session's token counters and turn timings, with the same context-ring figures as `session` (TAL-299). */
const Done = z.looseObject({ terminal_state: TurnTerminalStateSchema.optional(), session: z.unknown().optional(), usage: z.looseObject(ContextUsageFields).optional(), status: z.string().optional(), ephemeral: z.boolean().optional(), answer: z.string().optional() })
const Cancel = z.looseObject({ terminal_state: TurnTerminalStateSchema.optional(), type: z.string().optional(), message: z.string().optional(), hint: z.string().optional(), status: z.string().optional(), session_id: z.string().optional(), session: z.unknown().optional() })
const StreamEnd = z.looseObject({ session_id: z.string().optional() })
/** TAL-397: the session's token and cost counters as the turn will persist them. */
const MeteringUsage = z.looseObject({ input_tokens: z.number(), output_tokens: z.number(), estimated_cost: z.number().nullable(), cache_read_tokens: z.number(), cache_write_tokens: z.number() })
/**
 * TAL-397: the live turn's meter, sent when the Agent's counters change and at most once a second while text streams.
 * `tps` is the stream's delta rate (null, with `tps_available: false`, until two deltas are apart). The last frame before
 * `done` carries the persisted counters and the persisted turn rate.
 */
const Metering = z.looseObject({ session_id: z.string().optional(), usage: MeteringUsage.optional(), tps: z.number().nullable().optional(), tps_available: z.boolean().optional(), estimated: z.boolean().optional() })
const ContextStatus = z.looseObject({ session_id: z.string().optional(), state: z.string().optional(), decision: z.string().optional(), message: z.string().optional(), message_key: z.string().optional(), message_args: z.array(z.unknown()).optional(), prefill: z.unknown().optional() })
/**
 * TAL-396: `/goal` progress after a goal turn settles. `state` is `evaluating`, `continuing` or `idle`; `decision` is the
 * Agent's verdict (`continue`, `done`, `inactive`, `error`…); `goal_continue` names the continuation turn's `stream_id`.
 */
const Goal = z.looseObject({ session_id: z.string().optional(), state: z.unknown().optional(), text: z.string().optional(), decision: z.string().optional(), continuation_prompt: z.string().optional(), stream_id: z.string().optional(), message: z.string().optional(), message_key: z.string().optional(), message_args: z.array(z.unknown()).optional() })
/** `after_tool_call_id`: the tool that had completed when the Agent took the steer (null before any tool), its causal place. */
const Steer = z.looseObject({ session_id: z.string().optional(), steer_id: z.string().optional(), text: z.string().optional(), consumed_at: z.number().optional(), after_tool_call_id: z.string().nullable().optional() })
const StateSaved = z.looseObject({ session_id: z.string().optional(), status: z.string().optional(), kind: z.string().optional(), name: z.string().optional(), reason: z.string().optional(), action: z.string().optional() })
/** TAL-397: the `todo` tool's new list, sent live as the tool completes (`source: 'live'`); the settled session's `todo_state` matches it. */
const TodoState = TodoStateSchema.extend({ stream_id: z.string().optional() })
const BgTask = z.looseObject({ session_id: z.string().optional(), task_id: z.string().optional(), id: z.string().optional(), title: z.string().optional(), status: z.string().optional(), summary: z.string().optional(), error: z.string().optional() })
const ServerTurn = z.looseObject({ session_id: z.string().optional(), stream_id: z.string().optional(), turn_id: z.string().optional(), user_message_id: z.union([z.string(), z.number()]).optional() })
const Loose = z.looseObject({})
export const CHAT_EVENT_NAMES = [
  'session_snapshot', 'token', 'reasoning', 'tool', 'tool_progress', 'tool_complete', 'interim_assistant', 'approval', 'approval_cleared', 'clarify', 'compressing', 'compressed',
  'title', 'title_status', 'warning', 'apperror', 'cancel', 'error', 'done', 'stream_end', 'metering', 'context_status',
  'goal', 'goal_continue', 'steer_consumed', 'steer_pending', 'steer_withdrawn', 'state_saved', 'todo_state', 'bg_task_complete',
  'server_turn_started', 'notices', 'session_goal', 'rate_limit_wait', 'run_status', 'connect_card', 'hello', 'initial', 'events', 'gateway_status', 'sessions_changed',
] as const
export type ChatEventName = (typeof CHAT_EVENT_NAMES)[number]

export const ChatEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('session_snapshot'), data: z.object({ session: SessionSchema, replay_gap: z.boolean().optional() }) }),
  z.object({ event: z.literal('token'), data: Text }),
  z.object({ event: z.literal('interim_assistant'), data: Text }),
  z.object({ event: z.literal('reasoning'), data: Reasoning }),
  z.object({ event: z.literal('tool'), data: Tool }),
  z.object({ event: z.literal('tool_progress'), data: z.object({ id: z.string(), progress: ToolProgressSchema.nullable() }) }),
  z.object({ event: z.literal('tool_complete'), data: ToolComplete }),
  z.object({ event: z.literal('approval'), data: Approval }),
  /** TAL-514: the last pending approval was withdrawn (answered elsewhere, or the Agent stopped waiting); clients drop the card. */
  z.object({ event: z.literal('approval_cleared'), data: z.looseObject({ session_id: z.string().optional(), pending_count: z.number() }) }),
  z.object({ event: z.literal('clarify'), data: Clarify }),
  z.object({ event: z.literal('compressing'), data: Compressing }),
  z.object({ event: z.literal('compressed'), data: Compression }),
  z.object({ event: z.literal('title'), data: Title }),
  z.object({ event: z.literal('title_status'), data: Title }),
  z.object({ event: z.literal('warning'), data: Warning }),
  z.object({ event: z.literal('apperror'), data: AppError }),
  z.object({ event: z.literal('error'), data: AppError }),
  z.object({ event: z.literal('cancel'), data: Cancel }),
  z.object({ event: z.literal('done'), data: Done }),
  z.object({ event: z.literal('stream_end'), data: StreamEnd }),
  z.object({ event: z.literal('metering'), data: Metering }),
  z.object({ event: z.literal('context_status'), data: ContextStatus }),
  z.object({ event: z.literal('goal'), data: Goal }),
  z.object({ event: z.literal('goal_continue'), data: Goal }),
  z.object({ event: z.literal('steer_consumed'), data: Steer }),
  /** TAL-424: a pending steer was added or changed state; every client shows it until `steer_consumed` or `steer_withdrawn`. */
  z.object({ event: z.literal('steer_pending'), data: PendingSteerSchema }),
  z.object({ event: z.literal('steer_withdrawn'), data: SteerWithdrawnSchema }),
  z.object({ event: z.literal('state_saved'), data: StateSaved }),
  z.object({ event: z.literal('todo_state'), data: TodoState }),
  z.object({ event: z.literal('bg_task_complete'), data: BgTask }),
  z.object({ event: z.literal('server_turn_started'), data: ServerTurn }),
  /** TAL-803: the session's notices changed; `notices` replaces the session's `notices`. */
  z.object({ event: z.literal('notices'), data: z.looseObject({ session_id: z.string().optional(), notices: z.array(SessionNoticeSchema) }) }),
  /** TAL-808: the session's standing goal changed; `goal` replaces the session's `goal`. */
  z.object({ event: z.literal('session_goal'), data: z.looseObject({ session_id: z.string().optional(), goal: SessionGoalSchema.nullable() }) }),
  z.object({ event: z.literal('run_status'), data: z.object({ session_id: z.string(), status: RunStatusSchema.nullable() }) }),
  z.object({ event: z.literal('rate_limit_wait'), data: z.looseObject({ session_id: z.string().optional(), wait: RateLimitWaitSchema.nullable() }) }),
  /** TAL-818: a `manage_connections` card opened in this turn; clients read and answer it through `/api/connectors/operations/{op_id}`. */
  z.object({ event: z.literal('connect_card'), data: ConnectorOperationViewSchema }),
  z.object({ event: z.literal('hello'), data: Loose }),
  z.object({ event: z.literal('initial'), data: Loose }),
  z.object({ event: z.literal('events'), data: Loose }),
  z.object({ event: z.literal('gateway_status'), data: Loose }),
  z.object({ event: z.literal('sessions_changed'), data: Loose }),
])
export type ChatEvent = z.infer<typeof ChatEventSchema>

/** Relay close set: stop draining after these (the server's `SSE_RELAY_CLOSE_EVENTS`). */
export const RELAY_CLOSE_EVENTS: ReadonlySet<ChatEventName> = new Set(['stream_end', 'cancel', 'apperror', 'error'])

/** `GET /api/sessions/events` (global session list invalidation; `/api/session/stream` is the per-session channel). */
export const SessionsChangedSchema = z.looseObject({ type: z.literal('sessions_changed').optional(), version: z.number().optional(), reason: z.string().optional(), profile: z.string().nullable().optional(), session_id: z.string().nullable().optional() })
export const SessionListEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('initial'), data: Loose }),
  z.object({ event: z.literal('sessions_changed'), data: SessionsChangedSchema }),
  z.object({ event: z.literal('gateway_status'), data: Loose }),
  z.object({ event: z.literal('hello'), data: Loose }),
])
export type SessionListEvent = z.infer<typeof SessionListEventSchema>

/** Parse a raw SSE frame (`event` name + JSON `data`) into a typed chat event; unknown names are dropped, malformed data rejected. */
export function parseChatEvent(event: string, rawData: string): ChatEvent | null {
  let data: unknown
  try {
    data = rawData === '' ? {} : JSON.parse(rawData)
  } catch {
    return null
  }
  const result = ChatEventSchema.safeParse({ event, data })
  return result.success ? result.data : null
}
