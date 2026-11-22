import { PlanGaugeSchema } from './plan-usage.js'
import { ContextDetailSchema } from './context-detail.js'
import { z } from 'zod'
import { CheckpointReadSchema } from './checkpoint.js'
import { ConnectorOperationSnapshotSchema, ConnectorOperationViewSchema } from './connector-operation.js'

const ObjectSchema = z.record(z.string(), z.unknown())
export const CapturedCommandSchema = z.string().min(1).max(8192).regex(/\S/, 'Command must not be blank')
/** UTF-16 limits cover the owner's 4000/2000 Unicode code points. Native owner redacts before bounding these captured streams. Never interpreted as terminal control sequences. */
export const CapturedCommandResultSchema = z.object({ stdout: z.string().max(8000), stderr: z.string().max(4000), code: z.number().int() })
/**
 * TAL-1338: one registered command the owner ran for its session (`command_dispatch`). `output` is the owner's reply text,
 * bounded; `prompt` means the owner answered with a turn for the client to send, which Talaria never submits from a command.
 */
export const OwnerCommandResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('output'), output: z.string().max(64_000) }),
  z.object({ kind: z.literal('prompt') }),
])
/** TAL-1338: a quick command the owner's profile config registers (`command_catalog`), listed as the owner lists it. */
export const OwnerQuickCommandSchema = z.object({ name: z.string().regex(/^[A-Za-z][\w-]*$/).max(64), description: z.string().max(200) })
export const OWNER_EXPORT_MAX_BYTES = 4 * 1024 * 1024
export const OwnerExportFormatSchema = z.enum(['json', 'markdown', 'html'])
export const OwnerExportSchema = z.object({
  format: OwnerExportFormatSchema, filename: z.string().min(1).max(255), content: z.string().max(OWNER_EXPORT_MAX_BYTES),
})
/** Closed Web reaction vocabulary; the owner always writes as the authenticated user. */
export const ReactionEmojiSchema = z.enum(['👍', '👎', '❤️', '😂', '😮', '🎉'])
export const ReactionStateSchema = z.object({
  items: z.array(z.object({ emoji: ReactionEmojiSchema, count: z.number().int().positive(), mine: z.boolean() })),
  selected: ReactionEmojiSchema.nullable(),
})
export const MessageReactionViewSchema = z.object({
  row_id: z.number().int().positive(), state: ReactionStateSchema,
  actions: z.array(z.object({ emoji: ReactionEmojiSchema.nullable(), result: ReactionStateSchema })),
})
export type ReactionState = z.infer<typeof ReactionStateSchema>
export type MessageReactionView = z.infer<typeof MessageReactionViewSchema>
export const GatewayAdmissionSchema = z.object({
  admission_id: z.string(), sequence: z.number().int(), status: z.enum(['queued', 'started', 'unknown', 'terminal']),
  outcome: z.string().nullable(), authority_epoch: z.number().int(), execution_generation: z.number().int().nullable(),
  controls: z.array(z.string()).optional(), steering: z.boolean().optional(),
  text: z.string().optional(), input_id: z.string().optional(),
})
/**
 * TAL-1344: the image kinds an owner chat takes, as the owner's `image.attach_bytes` stages them, at most
 * `OWNER_IMAGE_LIMIT` per message, `OWNER_IMAGE_MAX_BYTES` each and `OWNER_IMAGES_MAX_TOTAL_BYTES` together. The server verifies every file's bytes before staging.
 */
export const OwnerImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const OWNER_IMAGE_LIMIT = 10
export const OWNER_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** All of one message's images together; the server also holds at most this many image bytes in flight at once. */
export const OWNER_IMAGES_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const GatewaySnapshotSchema = z.object({
  plan_gauge: PlanGaugeSchema.nullable().optional(),
  session_id: z.string(), stored_session_id: z.string(), messages: z.array(ObjectSchema), message_count: z.number().int(),
  running: z.boolean(), authority_epoch: z.number().int(), replay_epoch: z.string(), last_sequence: z.number().int(),
  subscription_id: z.string(), revision: z.number().int(), execution_generation: z.number().int(),
  reactions_supported: z.boolean().optional(),
  image_attachments: z.boolean().optional().describe('TAL-1344: the owner stages images (`image-attach-v1`). Absent from older sidecars.'),
  transcripts: z.boolean().optional().describe('TAL-2072: the owner serves `transcript`, its stored history read. Absent on older owners.'),
  todo_state: z.object({ todos: z.array(ObjectSchema), revision: z.number().int().nonnegative().optional() }).nullable().optional()
    .describe('Canonical owner plan. Null clears it; omission retains transcript fallback for older owners.'),
  pending: z.array(GatewayAdmissionSchema), prompts: z.array(ObjectSchema), info: ObjectSchema,
  pending_connection: ConnectorOperationSnapshotSchema.nullable().optional().describe("The owner's open connection operation. Null when none; omitted by older owners."),
})
/** Owner mutation receipts are distinct from prompt admissions. Applied mutations have no status. */
export const GatewayMutationReceiptSchema = z.looseObject({
  operation: z.string(), status: z.string().optional(),
})
/** TAL-1912: the owner's verdict on `session.steer`. A rejected steer never reached a turn that took it. */
export const GatewayCorrectionReceiptSchema = z.looseObject({ status: z.enum(['queued', 'redirected', 'rejected']), text: z.string() })
/** The server's model decision, shared by mutation responses and owner-session views. */
export const ModelChangeSchema = z.object({
  state: z.enum(['applied', 'deferred', 'confirmation_required', 'refused']),
  message: z.string().optional(), confirm: z.string().optional(),
  model: z.string().optional(), provider: z.string().nullable().optional(),
  reasoning: z.string().optional().describe('The level chosen with this model; a confirmed resend carries it again.'),
})
export type ModelChange = z.infer<typeof ModelChangeSchema>
/**
 * TAL-1336: the work an attached owner runs for one session, as its process and subagent rosters report it. A subagent is
 * `resident` when its owner can still tail and control it; a parent rebuilt since dispatch keeps its children readable only.
 */
export const OwnerWorkSchema = z.object({
  authority_epoch: z.number().int(),
  processes: z.array(z.object({ process_id: z.string().min(1), command: z.string(), running: z.boolean(), exit_code: z.number().int().nullable(),
    started_at: z.number().nullable(), exited_at: z.number().nullable(), completion_reason: z.string().nullable(), output_tail: z.string() })),
  subagents: z.array(z.object({ subagent_id: z.string().min(1), goal: z.string(), status: z.string(), started_at: z.number().nullable(),
    accepting_steer: z.boolean(), resident: z.boolean(),
    completed_at: z.number().nullable().optional().describe('TAL-2072: when a child the roster no longer lists finished; absent while it runs.') })),
  transcripts: z.boolean().optional().describe("TAL-2072: the owner serves each child's stored transcript, running or finished (`work_transcript`). Absent on older owners."),
})
export type OwnerWork = z.infer<typeof OwnerWorkSchema>
/** TAL-1336: the owner's verdict on one work control. `found: false` and an exited process are distinct from a refusal. */
export const OwnerWorkOutcomeSchema = z.enum(['stopped', 'not_running', 'not_found', 'queued', 'rejected'])
/** A detached native launch has no idempotency key. Unknown never permits an automatic resend. */
export const SideLaunchStateSchema = z.enum(['pending', 'accepted', 'failed', 'unsupported', 'unknown'])
/**
 * TAL-2072: display rows of an owner's stored read. `row_kind: 'compaction'` is a compaction handoff at its place in the
 * transcript (its summary in `text`); every other row is a display row, as a snapshot's `messages` holds it.
 */
export const OwnerTranscriptRowsSchema = z.array(ObjectSchema)
export const OwnerTranscriptPageSchema = z.object({
  rows: OwnerTranscriptRowsSchema, next_cursor: z.string().nullable(),
  reset: z.boolean().describe('The cursor no longer holds (a compaction, rewind or rewrite since): this page starts again from the first row.'),
})
export const SideLaunchSchema = z.object({ state: SideLaunchStateSchema, task_id: z.string().min(1).nullable() })
export type SideLaunch = z.infer<typeof SideLaunchSchema>
export const GatewaySessionResultSchema = z.object({
  state: z.enum(['attached', 'stopped', 'unavailable', 'incompatible', 'refused']), reason: z.string().nullable(),
  replay_gap: z.boolean().optional(), snapshot: GatewaySnapshotSchema.nullable(), receipt: z.union([
    GatewayAdmissionSchema.extend({ voice_stopped: z.never().optional() }),
    GatewayMutationReceiptSchema.extend({ voice_stopped: z.never().optional() }),
    GatewayCorrectionReceiptSchema.extend({ voice_stopped: z.never().optional() }),
    z.strictObject({ voice_stopped: z.literal(true) }),
  ]).nullable(),
  model_change: ModelChangeSchema.optional(),
  launch: SideLaunchSchema.optional(),
  context_detail: ContextDetailSchema.optional(),
  export: OwnerExportSchema.optional(),
  checkpoint_diff: CheckpointReadSchema.optional(),
  shell: CapturedCommandResultSchema.optional(),
  connection: ConnectorOperationSnapshotSchema.optional().describe('`connection_status`, `connection_retry`: the operation as the owner holds it.'),
  connection_settled: z.boolean().optional().describe('`connection_respond`: the answer settled the operation, which the owner then closed.'),
  restarting: z.boolean().optional().describe("The owner is in a restart's after-turn wait: parked prompts stay answerable, new work is refused."),
  work: OwnerWorkSchema.optional().describe('`work_list`: the session\'s processes and subagents on its owner.'),
  work_tail: z.object({ available: z.boolean(), text: z.string(), truncated: z.boolean() }).optional().describe('`work_tail`: a resident subagent\'s live transcript tail.'),
  transcript: OwnerTranscriptPageSchema.optional().describe('`transcript`: one page of the session\'s stored history, read without attaching.'),
  work_transcript: z.object({ available: z.boolean(), running: z.boolean(), rows: OwnerTranscriptRowsSchema }).optional()
    .describe("`work_transcript`: a child's newest stored rows, running or finished; unavailable when its owner cannot place it."),
  work_outcome: OwnerWorkOutcomeSchema.optional().describe('`work_stop`, `work_steer`: what the owner did with this one row.'),
  lock: z.object({ status: z.enum(['ok', 'expired']), remaining: z.array(z.string()).optional() }).optional()
    .describe('`clarify_lock`: the batch question ids the owner still waits on; `expired` when the batch already ended.'),
  command_result: OwnerCommandResultSchema.optional().describe('`command_dispatch`: what the owner did with the command.'),
  quick_commands: z.array(OwnerQuickCommandSchema).max(200).optional().describe("`command_catalog`: the session profile's registered quick commands."),
})
/** TAL-1271: the owner's multi-question clarify, asked once of the viewers attached when it parks (watch stream `clarify_batch`). */
export const GatewayClarifyBatchSchema = z.object({
  request_id: z.string().min(1),
  questions: z.array(z.object({ qid: z.string().min(1), question: z.string(), choices: z.array(z.string()).optional(), multi_select: z.boolean().optional() })).min(1),
})
export type GatewayClarifyBatch = z.infer<typeof GatewayClarifyBatchSchema>
/** One row's move or Continue, never both. `env` travels only here: no snapshot, event, log or notice carries its values. */
export const ConnectionAnswerSchema = z.union([
  z.strictObject({ targets: z.tuple([z.strictObject({ name: z.string().min(1), status: z.enum(['approved', 'skipped']), env: z.record(z.string(), z.string()).optional() })]) }),
  z.strictObject({ settled_by: z.literal('continue') }),
])
export type ConnectionAnswer = z.infer<typeof ConnectionAnswerSchema>
export const GatewaySessionParamsSchema = z.object({
  profile_home: z.string().min(1), session_id: z.string().min(1),
  action: z.enum(['snapshot', 'watch', 'transcript', 'context_detail', 'submit', 'receipt', 'cancel', 'steer', 'steer_queued', 'replace_queued', 'interrupt', 'approval', 'clarify', 'clarify_lock', 'discard', 'mutate', 'export', 'checkpoint_diff', 'terminal_info', 'shell_exec', 'react', 'connection_status', 'connection_wake', 'connection_respond', 'connection_retry', 'work_list', 'work_tail', 'work_transcript', 'work_stop', 'work_steer', 'launch_background', 'launch_btw', 'command_dispatch', 'command_catalog']),
  row_id: z.number().int().positive().optional(), emoji: ReactionEmojiSchema.nullable().optional(),
  format: OwnerExportFormatSchema.optional(), redact: z.boolean().optional(),
  command: CapturedCommandSchema.optional(),
  name: z.string().regex(/^[A-Za-z][\w-]*$/).max(64).optional().describe('`command_dispatch`: the registered command, as typed without its slash.'),
  arg: z.string().max(8192).optional().describe('`command_dispatch`: the rest of the typed command.'),
  authority_epoch: z.number().int().nonnegative().optional(), replay_epoch: z.string().min(1).optional(),
  request_id: z.string().min(1).max(128).optional(), text: z.string().optional(),
  submission_id: z.string().min(1).max(128).optional(),
  images: z.array(z.strictObject({ data_base64: z.string().min(1), ext: z.enum(['png', 'jpg', 'gif', 'webp']) })).min(1).max(OWNER_IMAGE_LIMIT).optional()
    .describe('`submit`: verified image bytes the owner stages before admitting the input; needs `authority_epoch`. Staged paths never come back.'),
  show_reasoning: z.boolean().optional().describe('Whether the owner sends reasoning to the server observer; client visibility uses the current profile preference.'),
  admission_id: z.string().optional(), execution_generation: z.number().int().nonnegative().optional(),
  prompt_id: z.string().optional(), choice: z.enum(['once', 'session', 'always', 'deny']).optional(),
  question_id: z.string().min(1).optional(), answer: z.string().optional(),
  expected_revision: z.number().int().nonnegative().optional(),
  operation: z.enum(['rename', 'archive', 'sidebar', 'branch', 'delete', 'rewind', 'reset', 'model', 'reasoning', 'workspace', 'compress']).optional(),
  payload: ObjectSchema.optional(),
  op_id: z.string().min(1).optional().describe('`connection_*`: the operation; bound by the owner to this session, and by `authority_epoch` to this owner.'),
  connection_answer: ConnectionAnswerSchema.optional(),
  connector: z.string().min(1).optional().describe('`connection_retry`: the target to run again.'),
  order: z.enum(['oldest', 'latest']).optional().describe('`transcript`: page forward from the first row or back from the newest.'),
  cursor: z.string().min(1).max(1024).optional().describe('`transcript`: the `next_cursor` of the page before, for the same order.'),
  limit: z.number().int().min(1).max(500).optional().describe('`transcript`: rows per page; a tool result may ride with its call beyond it.'),
  work_kind: z.enum(['process', 'subagent']).optional().describe('`work_tail`, `work_transcript`, `work_stop`, `work_steer`: the roster `work_id` comes from; bound by `authority_epoch` to this owner.'),
  work_id: z.string().min(1).optional(),
  reaction_poll_seconds: z.number().positive().optional().describe("`watch`: how often an idle watch rereads the transcript for another viewer's reaction, which the owner announces with no event. Defaults to 10."),
})
/**
 * TAL-1040: how a fresh chat's Agent runs, frozen at creation. `ignore_config` runs explicit settings without the profile's
 * config.yaml/.env; `safe` also leaves out plugins, MCP, hooks, rules, soul, skills and memory. Troubleshooting isolation,
 * not a security sandbox.
 */
export const ExecutionModeSchema = z.enum(['normal', 'ignore_config', 'safe'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>
/** `probe` asks whether the owner can create diagnostic sessions and creates nothing. Never carries a credential. */
export const GatewayCreateParamsSchema = z.object({
  profile_home: z.string().min(1), probe: z.boolean().optional(),
  request_id: z.string().min(1).max(128).optional(), execution_mode: ExecutionModeSchema.exclude(['normal']).optional(),
  cwd: z.string().min(1).optional(), model: z.string().min(1).optional(), provider: z.string().min(1).optional(), base_url: z.string().min(1).optional(),
  toolsets: z.array(z.string().min(1)).optional(),
})
export type GatewayCreateParams = z.infer<typeof GatewayCreateParamsSchema>
/** Why the server cannot start a fresh chat in a mode; clients word each code. */
export const ExecutionModeUnavailableSchema = z.enum(['agent_unsupported', 'served_profile', 'gateway_stopped', 'gateway_unavailable'])
export const ExecutionModesSchema = z.object({
  modes: z.array(z.object({ mode: ExecutionModeSchema, available: z.boolean(), reason: ExecutionModeUnavailableSchema.nullable(),
    can_reference: z.boolean().optional().describe('A fresh chat in this mode accepts earlier-conversation references. Absent means unavailable.'),
    can_attach: z.boolean().describe('A fresh chat in this mode accepts file attachments.') })),
  selectable: z.boolean().describe('TAL-2097: more than one mode is available, so a fresh chat has a mode to choose.'),
})
export type ExecutionModes = z.infer<typeof ExecutionModesSchema>
const OwnerActionBase = z.object({ session_id: z.string().min(1) })
const RecoveryAction = OwnerActionBase.extend({ admission_id: z.string().min(1), execution_generation: z.number().int().positive() })
export const OwnerActionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ session_id: z.string().min(1), action: z.literal('react'), row_id: z.number().int().positive(), emoji: ReactionEmojiSchema.nullable() }),
  OwnerActionBase.extend({ action: z.literal('cancel'), admission_id: z.string().min(1) }),
  OwnerActionBase.extend({ action: z.literal('steer_queued'), admission_id: z.string().min(1) }),
  OwnerActionBase.extend({ action: z.literal('replace_queued'), admission_id: z.string().min(1),
    submission_id: z.string().min(1).max(128), text: z.string().trim().min(1) }),
  RecoveryAction.extend({ action: z.literal('discard') }),
  RecoveryAction.extend({ action: z.literal('retry') }),
  OwnerActionBase.extend({ action: z.literal('mutate'), request_id: GatewaySessionParamsSchema.shape.request_id.unwrap(),
    expected_revision: z.number().int().nonnegative(), execution_generation: z.number().int().nonnegative(),
    operation: z.enum(['rename', 'rewind', 'reset', 'model', 'reasoning', 'workspace', 'compress']), payload: ObjectSchema.describe('`reasoning`: `{effort}`, null resets to the profile. `model` may carry `reasoning` to commit both at once.') }),
])
export type OwnerActionRequest = z.infer<typeof OwnerActionRequestSchema>
/** TAL-1319: one owner chat's own level, in `ReasoningStatus` terms. Read from its owner, never from the profile config. */
export const OwnerReasoningSchema = z.object({
  reasoning_effort: z.string().nullable().describe('The level this chat runs now, clamped for its route. Null is the provider default.'),
  supported_efforts: z.array(z.string()).describe('TAL-2506: normalized as `ReasoningStatus.supported_efforts`.'),
  effort_options: z.array(z.string()).describe('TAL-2529: the levels a picker offers, as `ReasoningStatus.effort_options`.'), supports_reasoning_effort: z.boolean(), supports_thinking_toggle: z.boolean(),
  actions: z.array(z.enum(['set', 'reset'])).describe('What this client may ask the owner now. Empty while the owner cannot take a change.'),
  deferred: z.object({ effort: z.string().nullable() }).nullable().describe('A pick the owner holds for the end of the running turn; `reasoning_effort` stays the actual level. Null effort is a held reset.'),
})
export type OwnerReasoning = z.infer<typeof OwnerReasoningSchema>
/** The server decides every action. Native paths, principal bindings and transport tickets stay private. */
export const OwnerAttachmentSchema = z.object({
  state: GatewaySessionResultSchema.shape.state, reason: z.string().nullable(),
  can_submit: z.boolean(), can_interrupt: z.boolean(), can_attach: z.boolean(),
  attachment_mimes: z.array(OwnerImageMimeSchema).optional().describe('TAL-1344: the file kinds this chat takes, empty when `can_attach` is false. Pickers offer only these. Absent from older servers, which never attach.'),
  restarting: z.boolean().describe('The owning gateway is restarting once this turn ends; sending waits until it is back.'),
  revision: z.number().int().nullable(), execution_generation: z.number().int().nullable(),
  model_change: ModelChangeSchema.optional(),
  active_admission: GatewayAdmissionSchema.nullable().optional(),
  admissions: z.array(GatewayAdmissionSchema.extend({ actions: z.array(z.enum(['cancel', 'steer', 'edit', 'retry', 'discard'])) })),
  queued_input_count: z.number().int().nonnegative().describe('TAL-1531: how many inputs `admissions` shows, outcome-unknown ones included; every client shows this count. Absent from older servers.'),
  connection: ConnectorOperationViewSchema.nullable().optional().describe("TAL-1317: the owner's open connection operation, restored on attach. Absent outside a session view."),
  reasoning_control: OwnerReasoningSchema.optional().describe('Absent when the owner reports no level (an older owner or server) or outside a session view: the chat offers no picker.'),
})
export type OwnerAttachment = z.infer<typeof OwnerAttachmentSchema>
export type GatewaySnapshot = z.infer<typeof GatewaySnapshotSchema>
export type GatewaySessionResult = z.infer<typeof GatewaySessionResultSchema>
export type GatewaySessionParams = z.infer<typeof GatewaySessionParamsSchema>
