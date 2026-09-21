import { z } from 'zod'

/**
 * Wire events of `GET /api/chat/stream` as emitted by api/streaming.py
 * (docs/rfcs/session-sse-contract-v1.md, "Authoritative emitted events"),
 * modelled as a discriminated union on the SSE `event:` name. Payloads are
 * loose objects: the reducer reads the named fields and preserves the rest.
 */
const Text = z.looseObject({ text: z.string().optional(), already_streamed: z.boolean().optional(), reasoning_echo: z.boolean().optional(), session_id: z.string().optional() })
const Reasoning = z.looseObject({ text: z.string().optional(), titles: z.array(z.string()).optional(), name: z.string().optional(), session_id: z.string().optional() })
const Tool = z.looseObject({ name: z.string().optional(), preview: z.string().nullable().optional(), args: z.unknown().optional(), event_type: z.string().optional(), session_id: z.string().optional(), id: z.string().optional(), call_id: z.string().optional(), tool_call_id: z.string().optional(), timestamp: z.number().optional() })
const ToolComplete = Tool.extend({ duration: z.number().nullable().optional(), is_error: z.boolean().optional(), cost_usd: z.number().nullable().optional(), result: z.unknown().optional(), output: z.unknown().optional() })
const Approval = z.looseObject({ approval_id: z.string().optional(), session_id: z.string().optional(), command: z.string().optional(), description: z.string().optional(), title: z.string().optional(), name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), question: z.string().optional(), status: z.string().optional(), pending_count: z.number().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() })
const Clarify = z.looseObject({ clarify_id: z.string().optional(), session_id: z.string().optional(), question: z.string().optional(), choices: z.array(z.unknown()).optional(), title: z.string().optional(), name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), status: z.string().optional(), raw_preview: z.string().optional(), timeout_seconds: z.number().optional(), timeout_at: z.number().optional(), index: z.number().optional(), total: z.number().optional() })
const Compression = z.looseObject({ session_id: z.string().optional(), old_session_id: z.string().optional(), new_session_id: z.string().optional(), continuation_session_id: z.string().optional(), usage: z.unknown().optional() })
const Title = z.looseObject({ session_id: z.string().optional(), title: z.string().optional(), status: z.string().optional(), reason: z.string().optional(), message: z.string().optional(), message_key: z.string().optional(), message_args: z.array(z.unknown()).optional(), raw_preview: z.string().optional(), prefill: z.unknown().optional() })
const Warning = z.looseObject({ type: z.string().optional(), message: z.string().optional() })
const AppError = z.looseObject({ type: z.string().optional(), message: z.string().optional(), details: z.unknown().optional(), hint: z.string().optional(), session_id: z.string().optional(), old_session_id: z.string().optional(), new_session_id: z.string().optional(), continuation_session_id: z.string().optional(), status: z.union([z.string(), z.number()]).optional(), session: z.unknown().optional(), code: z.string().optional() })
const Done = z.looseObject({ session: z.unknown().optional(), usage: z.unknown().optional(), status: z.string().optional(), ephemeral: z.boolean().optional(), answer: z.string().optional() })
const StreamEnd = z.looseObject({ session_id: z.string().optional() })
const Metering = z.looseObject({ session_id: z.string().optional(), usage: z.unknown().optional(), tps: z.number().nullable().optional(), tps_available: z.boolean().optional(), estimated: z.boolean().optional() })
const ContextStatus = z.looseObject({ session_id: z.string().optional(), state: z.string().optional(), decision: z.string().optional(), message: z.string().optional(), message_key: z.string().optional(), message_args: z.array(z.unknown()).optional(), prefill: z.unknown().optional() })
const Goal = z.looseObject({ session_id: z.string().optional(), state: z.unknown().optional(), text: z.string().optional(), decision: z.string().optional(), continuation_prompt: z.string().optional() })
const Steer = z.looseObject({ session_id: z.string().optional(), steer_id: z.string().optional(), text: z.string().optional(), consumed_at: z.number().optional() })
const StateSaved = z.looseObject({ session_id: z.string().optional(), status: z.string().optional(), kind: z.string().optional(), name: z.string().optional(), reason: z.string().optional(), action: z.string().optional() })
const TodoState = z.looseObject({ session_id: z.string().optional(), todos: z.array(z.unknown()).optional(), version: z.number().optional(), ts: z.number().optional(), source: z.string().optional(), description: z.string().optional(), pending_count: z.number().optional() })
const BgTask = z.looseObject({ session_id: z.string().optional(), task_id: z.string().optional(), id: z.string().optional(), title: z.string().optional(), status: z.string().optional(), summary: z.string().optional(), error: z.string().optional() })
const ServerTurn = z.looseObject({ session_id: z.string().optional(), stream_id: z.string().optional(), turn_id: z.string().optional(), user_message_id: z.union([z.string(), z.number()]).optional() })
const Loose = z.looseObject({})

export const CHAT_EVENT_NAMES = [
  'token', 'reasoning', 'tool', 'tool_complete', 'interim_assistant', 'approval', 'clarify', 'compressing', 'compressed',
  'title', 'title_status', 'warning', 'apperror', 'cancel', 'error', 'done', 'stream_end', 'metering', 'context_status',
  'goal', 'goal_continue', 'pending_steer_leftover', 'steer_consumed', 'state_saved', 'todo_state', 'bg_task_complete',
  'server_turn_started', 'hello', 'initial', 'events', 'gateway_status', 'sessions_changed',
] as const
export type ChatEventName = (typeof CHAT_EVENT_NAMES)[number]

export const ChatEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('token'), data: Text }),
  z.object({ event: z.literal('interim_assistant'), data: Text }),
  z.object({ event: z.literal('reasoning'), data: Reasoning }),
  z.object({ event: z.literal('tool'), data: Tool }),
  z.object({ event: z.literal('tool_complete'), data: ToolComplete }),
  z.object({ event: z.literal('approval'), data: Approval }),
  z.object({ event: z.literal('clarify'), data: Clarify }),
  z.object({ event: z.literal('compressing'), data: Compression }),
  z.object({ event: z.literal('compressed'), data: Compression }),
  z.object({ event: z.literal('title'), data: Title }),
  z.object({ event: z.literal('title_status'), data: Title }),
  z.object({ event: z.literal('warning'), data: Warning }),
  z.object({ event: z.literal('apperror'), data: AppError }),
  z.object({ event: z.literal('error'), data: AppError }),
  z.object({ event: z.literal('cancel'), data: Loose }),
  z.object({ event: z.literal('done'), data: Done }),
  z.object({ event: z.literal('stream_end'), data: StreamEnd }),
  z.object({ event: z.literal('metering'), data: Metering }),
  z.object({ event: z.literal('context_status'), data: ContextStatus }),
  z.object({ event: z.literal('goal'), data: Goal }),
  z.object({ event: z.literal('goal_continue'), data: Goal }),
  z.object({ event: z.literal('pending_steer_leftover'), data: Steer }),
  z.object({ event: z.literal('steer_consumed'), data: Steer }),
  z.object({ event: z.literal('state_saved'), data: StateSaved }),
  z.object({ event: z.literal('todo_state'), data: TodoState }),
  z.object({ event: z.literal('bg_task_complete'), data: BgTask }),
  z.object({ event: z.literal('server_turn_started'), data: ServerTurn }),
  z.object({ event: z.literal('hello'), data: Loose }),
  z.object({ event: z.literal('initial'), data: Loose }),
  z.object({ event: z.literal('events'), data: Loose }),
  z.object({ event: z.literal('gateway_status'), data: Loose }),
  z.object({ event: z.literal('sessions_changed'), data: Loose }),
])
export type ChatEvent = z.infer<typeof ChatEventSchema>

/** Relay close set: stop draining after these (api.run_journal.SSE_RELAY_CLOSE_EVENTS). */
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
