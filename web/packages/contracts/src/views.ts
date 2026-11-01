import { DelegationSettingsSchema } from './delegation.js'
import { PlanGaugeSchema, PlanUsageSchema, ModelAllowanceSchema, ModelSectionsSchema } from './plan-usage.js'
import { McpCostPolicySchema } from './mcp-cost-policy.js'
/**
 * Pinned response shapes shared by every consumer (formerly the frontend's
 * hand-written `src/contracts/*` schemas). Known fields are typed; every
 * object keeps a catchall because sidecar rows carry operator-defined extras
 * that must survive a round trip (documented passthrough).
 */
import { z } from 'zod'
import { OutboundDraftRefSchema } from './outbound-drafts.js'
import { RunStatusSchema } from './run-status.js'
import { AgentRefreshConfirmationSchema, AgentUpdateOperationSchema } from './sidecar/runtime.js'
import { SpeedTierSchema } from './speed.js'
import { ExecutionModeSchema, OwnerAttachmentSchema, MessageReactionViewSchema } from './gateway-session.js'
import { NousAccountSchema, KanbanInspectionNodeSchema, KanbanInspectionSnapshotSchema, CanonicalBotChatSchema, GatewayModeSchema, PluginOAuthClientSchema, PluginSettingFieldSchema, SkillCatalogIdentitySchema } from './sidecar/namespaces.js'

export { SpeedTierSchema } from './speed.js'

const Json = z.unknown()
export const NullableString = z.string().nullable()
export const NullableNumber = z.number().nullable()
/** Unix seconds as the server emits them (float). */
export const UnixSeconds = z.number()

// ── sessions ─────────────────────────────────────────────────────────────

export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'invalid session id')
export type SessionId = z.infer<typeof SessionIdSchema>

export const AttachmentSchema = z.looseObject({
  download_url: z.string().startsWith('/api/groups/file?').optional(),
  filename: z.string().optional(), name: z.string().optional(), path: z.string().optional(), size: z.number().optional(), mime: z.string().optional(), is_image: z.boolean().optional(), rollback_token: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

/** The server's display class for a tool call: clients map it to an icon and localized verb, and never classify names themselves. */
export const ToolKindSchema = z.enum(['shell', 'read', 'list', 'search', 'web', 'write', 'skill', 'memory', 'delegate', 'unknown'])
export type ToolKind = z.infer<typeof ToolKindSchema>
/**
 * TAL-604: one row of a unified diff hunk as the server parsed it. `text` is the raw line, its `+` / `-` / space prefix kept;
 * `old_line` / `new_line` number it on each side (null on the side it is absent from, and on a `\ No newline` marker).
 */
export const DiffLineSchema = z.object({ kind: z.enum(['addition', 'deletion', 'context']), old_line: z.number().int().nullable(), new_line: z.number().int().nullable(), text: z.string() })
/**
 * TAL-604: one hunk of a unified diff: its `@@` `header`, the first old and new line numbers, the last new line it covers
 * (`new_end`, at least `new_start`), its added and removed line counts, and its lines. A diff without `@@` headers yields
 * one hunk per file with an empty `header` and null numbers.
 */
export const DiffHunkSchema = z.object({
  header: z.string(), old_start: z.number().int().nullable(), new_start: z.number().int().nullable(), new_end: z.number().int().nullable(),
  additions: z.number().int(), deletions: z.number().int(), lines: z.array(DiffLineSchema),
})
export type DiffHunk = z.infer<typeof DiffHunkSchema>
/**
 * TAL-448: a completed file-edit call's change, from its result's unified diff: `added` / `removed` count the whole diff's
 * lines (file headers excluded); `diff` is the redacted diff, capped at 400 lines, with `truncated` when cut, and `hunks`
 * that diff parsed (TAL-604). Absent on a call whose result has no diff.
 */
export const ToolEditDiffSchema = z.object({ added: z.number().int(), removed: z.number().int(), diff: z.string(), truncated: z.boolean(), hunks: z.array(DiffHunkSchema) })
export type ToolEditDiff = z.infer<typeof ToolEditDiffSchema>
/** The latest server-normalized MCP update; never stored with the transcript. */
export const ToolProgressSchema = z.object({ percent: z.number().min(0).max(100).nullable(), message: z.string().nullable() })
export type ToolProgress = z.infer<typeof ToolProgressSchema>
/** Shared tool display fields. Progress is ephemeral, absent on older servers and null after completion. */
export const ToolDisplayFields = {
  progress: ToolProgressSchema.nullable().optional(), kind: ToolKindSchema.optional(), target: z.string().optional(), edit_diff: ToolEditDiffSchema.optional(),
  focus_path: NullableString.optional().describe('TAL-1458: a read or write call\'s file as a workspace-relative path, the file a companion page shows. TAL-1537: an absolute or `~/` path inside the session workspace counts, as its remainder under the workspace root. Absent for any other call, the workspace root itself, or a path outside the workspace.'),
}

/**
 * TAL-315: a tool result's display sections, decided by the server's one rule for live, replayed and persisted results
 * alike. Clients show `stdout`, `stderr`, a labelled `error` and a labelled `exit_code` (sent only when worth showing), or
 * `text`, in that order, and never parse result text. Each string is capped server-side; a client without the field
 * shows `preview`.
 */
export const ToolResultViewSchema = z.object({ outbound_draft: OutboundDraftRefSchema.optional(), text: z.string().optional(), stdout: z.string().optional(), stderr: z.string().optional(), error: z.string().optional(), exit_code: z.number().int().optional() })
export type ToolResultView = z.infer<typeof ToolResultViewSchema>

/**
 * Stored transcripts carry the OpenAI shape (`function.name` / `function.arguments` JSON string); live events carry `name` / `args`.
 * On an assistant row the server resolves every call (TAL-313, `session-sse-contract-v1.md`): Anthropic `tool_use` parts and
 * session-level-only calls join `tool_calls`; `done` is answered or outside the running turn; `is_error` is the server's
 * outcome rule over the result; `duration` is the seconds the live stream measured, else `null`; `result` is the redacted
 * result snippet, else `null`; `result_view` its display sections, else `null`. Clients render these and pair nothing themselves.
 */
export const ToolCallSchema = z.looseObject({
  ...ToolDisplayFields,
  name: z.string().optional(), args: Json.optional(), function: z.looseObject({ name: z.string().optional(), arguments: Json.optional() }).optional(), id: z.string().optional(), call_id: z.string().optional(), tool_call_id: z.string().optional(),
  done: z.boolean().optional(), is_error: z.boolean().optional(), preview: z.string().nullable().optional(), result: Json.optional(), result_view: ToolResultViewSchema.nullable().optional(), output: Json.optional(), duration: z.number().nullable().optional(), cost_usd: z.number().nullable().optional(),
  timestamp: z.number().nullable().optional(), event_type: z.string().optional(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const ContentPartSchema = z.looseObject({ type: z.string(), text: z.string().optional() })
export const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema), z.null()])
export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
/** Persisted rows have integer ids; live rows carry string ids. */
export const MessageIdSchema = z.union([z.string(), z.number()])

/**
 * TAL-372: the background work a delegation tool call started, on its scene row: the session's task ids it links to, their
 * combined status, and the subagent counts the row shows in place ("3 subagents · 2 done, 1 failed").
 */
export const BackgroundLinkSchema = z.object({
  task_ids: z.array(z.string()),
  status: z.enum(['running', 'attention', 'completed', 'failed', 'cancelled', 'unknown']),
  agents: z.object({ total: z.number().int(), completed: z.number().int(), failed: z.number().int(), running: z.number().int() }),
})
export type BackgroundLink = z.infer<typeof BackgroundLinkSchema>

/**
 * TAL-186: one local or remote media reference the server recognized in a message's Markdown (a `MEDIA:` token, a bare
 * `file://` URL or a local image destination), in content order. `url` is relative to the app root (`./api/media?path=…&session_id=…`)
 * for a local file the `/api/media` allow-list serves, or the remote `http(s)` URL as written. Clients render `image`
 * items inline from the display text and every other kind as a tile after it. A remote URL without a file
 * extension has no known kind and is a `file`.
 */
export const DisplayMediaSchema = z.object({ url: z.string(), name: z.string(), mime: z.string(), kind: z.enum(['image', 'audio', 'video', 'pdf', 'file']) })
export type DisplayMedia = z.infer<typeof DisplayMediaSchema>

/** One normalized activity row: the server decides role, order, tool completion/error, and steering consumption. */
export const ActivitySceneRowSchema = z.looseObject({
  row_id: z.string(), order_index: z.number().int(), role: z.enum(['prose', 'reasoning', 'tool', 'steering']), created_at: z.number().optional(),
  text: z.string().optional(), titles: z.array(z.string()).optional(),
  /** TAL-186: a prose row's `text` with its media references rewritten for display (see `_display_content`), and its media. */
  display_text: z.string().optional(), media: z.array(DisplayMediaSchema).optional(),
  tool: z.looseObject({ id: z.string(), name: z.string(), ...ToolDisplayFields, args: Json.optional(), preview: z.string().nullable(), result: Json.optional(), result_view: ToolResultViewSchema.nullable().optional(), done: z.boolean(), is_error: z.boolean(), duration: z.number().nullable(), cost_usd: z.number().nullable(), background: BackgroundLinkSchema.optional(),
    /** TAL-331: a limited response clipped `result` (originally `result_chars` long); `GET /api/session/tool-result` serves it whole. */
    result_truncated: z.literal(true).optional(), result_chars: z.number().int().nullable().optional() }).optional(),
  steering: z.looseObject({ steer_id: z.string(), consumed: z.boolean(), submitted_at: z.number().nullable(), consumed_at: z.number().nullable(), phase_duration: z.number().nullable().optional() }).optional(),
})
export type ActivitySceneRow = z.infer<typeof ActivitySceneRowSchema>

/** One file a turn changed: its normalized path as the tool reported it, and the strongest action taken on it (`added` / `deleted` / `renamed` outrank a plain `edited`). */
export const TurnFileChangeSchema = z.looseObject({ path: z.string(), action: z.enum(['added', 'edited', 'deleted', 'renamed']) })
export type TurnFileChange = z.infer<typeof TurnFileChangeSchema>

/** `_anchor_activity_scene`: a completed turn's server-owned presentation: the rows under "Worked" (a tail preview plus paging fields), the visible final answer, the outcome, and the default disclosure. */
/** How a turn ended: every terminal chat frame carries it, and the turn's settled scene shows the same value. */
export const TurnTerminalStateSchema = z.enum(['completed', 'no_response', 'cancelled', 'interrupted', 'tool_limit_reached', 'compression_exhausted', 'error'])
export type TurnTerminalState = z.infer<typeof TurnTerminalStateSchema>

export const ActivitySceneSchema = z.looseObject({
  version: z.literal('activity_scene_v1'), activity_rows: z.array(ActivitySceneRowSchema), final_answer: z.string().optional(),
  /** TAL-456: an older settled final answer too long to lay out whole. Absent on the session-global newest settled visible reply and throughout the next running turn. Clients render the excerpt with a local "Show more". */
  final_answer_excerpt: z.string().optional().describe("Collapsed preview of an older settled final answer. Absent on the session-global newest visible reply; its exemption transfers only when a newer visible reply settles."), turn_duration: z.number().nullable().optional(),
  /** TAL-186: `final_answer` with its media references rewritten for display (see `_display_content`), and its media. */
  final_answer_display: z.string().optional(), final_answer_media: z.array(DisplayMediaSchema).optional(),
  terminal_state: z.string().optional().describe('The turn\'s outcome: a `TurnTerminalState` (`completed`, `no_response`, `error`, `cancelled`, `interrupted`, `tool_limit_reached`, ...), or `running` for the running turn of a run with no journal to replay (TAL-374). A running scene holds every persisted row (no final answer) and renders open, with no "Worked" fold or outcome; the live rows streamed after attach continue it, and the settled scene replaces both.'),
  /** Whether the "Worked" disclosure opens by default: an unsuccessful outcome with work to read, or a running turn. */
  expanded_by_default: z.boolean().optional(),
  /** Seconds from the turn's last consumed steer to its end, when it has steers. */
  final_phase_duration: z.number().optional(),
  /** Whether any row of the whole scene (not only this preview) is a consumed steer. */
  has_consumed_steering: z.boolean().optional(),
  /** The files the whole turn's file-mutating calls changed, in first-touch order; clients join them to `git/status` for line counts. */
  file_changes: z.array(TurnFileChangeSchema).optional(),
  activity_rows_total: z.number().int().optional(), activity_rows_offset: z.number().int().optional(), activity_rows_complete: z.boolean().optional(), activity_rows_omitted: z.number().int().optional(), activity_scene_ref: z.string().optional(),
})
export type ActivityScene = z.infer<typeof ActivitySceneSchema>

/** The server-owned result-review lifecycle (TAL-1022). */
export const BackgroundReviewStateSchema = z.enum(['waiting', 'reviewing', 'reviewed', 'failed', 'unknown'])
export type BackgroundReviewState = z.infer<typeof BackgroundReviewStateSchema>

/** One finished background item (see `_background_update.lines`). */
export const BackgroundLineSchema = z.object({ kind: z.enum(['agent', 'command', 'other']), status: z.enum(['completed', 'failed', 'notice']), label: z.string(), exit_code: z.number().int().nullable().optional(),
  /** Server-composed worker and parent outcome. Failure/unknown worker outcomes take precedence. */
  review_state: BackgroundReviewStateSchema.optional(),
})
export type BackgroundLine = z.infer<typeof BackgroundLineSchema>

export const MessageSchema = z.looseObject({
  role: z.string(), content: MessageContentSchema.optional(), id: MessageIdSchema.optional(), message_id: MessageIdSchema.optional(), timestamp: z.number().nullable().optional(),
  reaction_view: MessageReactionViewSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(), tool_calls: z.array(ToolCallSchema).optional(),
  /**
   * TAL-302: an assistant row's whole reasoning as one string (its reasoning fields, typed thinking parts and inline
   * thinking blocks). Its `content` carries none of them and no leaked tool-call XML; `reasoning_content` and
   * `thinking` are not sent. Clients render both as shipped.
   */
  reasoning: z.string().optional(),
  tool_call_id: z.string().optional(), tool_use_id: z.string().optional(), name: z.string().optional(), badge: z.string().optional(), label: z.string().optional(),
  provider_details: Json.optional(), provider_details_label: z.string().optional(), recovery_control: Json.optional(), _anchor_activity_scene: ActivitySceneSchema.optional(),
  /** The turn this row belongs to; the server stamps every row it sends, so clients group turns by equality alone. */
  _turn_id: z.string().optional(),
  /** On a turn's last assistant row: seconds the turn ran. */
  _turnDuration: z.number().optional(),
  /** On a turn's last assistant row: output tokens per second, when the turn reported usage. */
  _turnTps: z.number().optional(),
  /** Epoch seconds the row was written; `timestamp` when absent. */
  _ts: z.number().optional(),
  /** Reasoning titles an older Web stored on the row, in order. */
  reasoning_titles: z.array(z.string()).optional(),
  /** The running turn's prompt, which the turn's settlement replaces with its persisted row. */
  _active_turn_user: z.boolean().optional(),
  /** A consumed steer at its causal place in the turn: display-only, never model history. A steer only the Agent recorded has no timing. */
  _steer: z.looseObject({ steer_id: z.string(), submitted_at: z.number().nullable().optional(), consumed_at: z.number().optional(), phase_duration: z.number().optional() }).optional(),
  /** On a steered turn's last reply: seconds from the last consumed steer to the turn's end. */
  _final_phase_duration: z.number().optional(),
  /** A settled body too long to lay out whole. The session-global newest settled visible assistant reply and running output carry no excerpt. Only a newer visible terminal answer transfers that exemption. Clients render `_display_excerpt` with a local "Show more" for full `content`. */
  _display_truncated: z.boolean().optional().describe("Whether this settled body has a collapsed preview. The newest settled visible assistant reply and active-turn output remain full."),
  _display_excerpt: z.string().optional().describe("Collapsed preview with full content retained. The newest settled visible assistant reply remains exempt throughout the next running turn, until a newer visible reply settles."),
  /**
   * TAL-452: a typed user message (never a steer, background update or marker) longer than 20 lines or 2,000
   * characters. Clients show it folded to a few lines with a local "Show more"; copy and edit use the whole `content`.
   */
  _collapsible: z.boolean().optional(),
  /**
   * TAL-186: an assistant row's text with each media reference the server serves rewritten to standard Markdown: an
   * image to `![alt](url)`, any other file to `[name](url)`. Clients render it in place of `content` as one Markdown
   * document; `content` stays as stored for copy and edit. Absent when the text has no such reference.
   */
  _display_content: z.string().optional(),
  /** TAL-186: the media `_display_content` references, in content order. */
  _media: z.array(DisplayMediaSchema).optional(),
  /**
   * TAL-371: an automatic background wakeup (delegation results, background process or watch notice), not a message the
   * user sent. Clients render it as a "Background update" disclosure: a localized label per `kind` (with `count`), a
   * warning when `attention`, the server's one-line `summary`, and `content` in full on expansion.
   */
  _background_update: z.object({
    kind: z.enum(['delegation', 'process', 'mixed', 'other']), attention: z.boolean(), count: z.number().int().positive(), summary: z.string(),
    /**
     * One completion line per finished item. Clients show its label and exactly one leading icon from `review_state`,
     * with localized accessible/help wording. Parent review never overrides failed/unknown worker outcomes.
     * `content` stays available in full on expansion.
     */
    lines: z.array(BackgroundLineSchema),
    /** Parent review only, established from admission, the live run, and terminal evidence. */
    review_state: BackgroundReviewStateSchema.optional(),
  }).optional(),
  /**
   * TAL-305: a marker around context compaction, not a message anyone typed. Clients render a collapsed line with a
   * localized title per kind and the body on expansion: `_marker_body` when sent, else `content`. TAL-1566: each compaction
   * Web runs is one row in its place, with role `marker` and a stable `message_id`, display-only and excluded from model
   * history; it is never a turn's prompt or reply.
   */
  _marker_kind: z.enum(['context_compaction', 'preserved_task_list']).optional(),
  /** TAL-305: a preserved task list's card body, without its marker line. */
  _marker_body: z.string().optional(),
  /**
   * TAL-815: an assistant row the Agent wrote as a notice, not the model's reply. `failed_turn`: the boundary closing a
   * turn that failed, with its copy in `content`. Clients show it as a notice in its place, never as a reply bubble or
   * part of a turn's reply; it is absent when Web's own error row already reports that turn. `session_finalize` is
   * a plugin's closing text after clear, with role `local_notice`, display-only and excluded from model history.
   */
  _notice_kind: z.enum(['failed_turn', 'session_finalize']).optional(),
  /**
   * TAL-816: a user row of a messaging session that the Agent's gateway mirrored after a webhook route's or cron job's
   * delivery to the chat, not a message the user sent. Clients show it as a delivery notice titled by a localized label
   * per `kind` with `name`, and `body` (the delivered text, without its label line) beneath, never as a user bubble.
   */
  _delivery: z.object({ kind: z.enum(['webhook', 'cron']), name: z.string(), body: z.string() }).optional(),
  /** TAL-460: part of the Agent's reply to the background update just before it in the same turn. */
  _background_reply: z.boolean().optional(),
  /** TAL-460: that reply is only a silence marker; clients show the update's lines and nothing of this turn's reply. */
  _background_silent: z.boolean().optional(),
  /**
   * TAL-600: how clients show the row, on every row the server sends: `row` on its own, `in_scene` only inside its turn's
   * activity scene (a tool result or a consumed steer), `hidden` not at all (a silent background reply, or a row with
   * nothing to show).
   */
  _display: z.enum(['row', 'hidden', 'in_scene']).optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const ComposerDraftSchema = z.looseObject({ text: z.string().optional(), files: z.array(Json).optional() })

/**
 * TAL-424: a steer the Agent has not taken yet, owned by the server and shown by every client in order. `state`
 * `sending_now`: a Send now is delivering it after the running tools yield. `actions` say what this client may offer.
 */
export const PendingSteerSchema = z.object({
  steer_id: z.string(), text: z.string(), submitted_at: z.number(), state: z.enum(['pending', 'sending_now']),
  actions: z.object({ edit: z.boolean(), cancel: z.boolean(), send_now: z.boolean() }),
})
export type PendingSteer = z.infer<typeof PendingSteerSchema>

/**
 * TAL-803: an out-of-band notice the Agent raised for the session (a memory provider that failed to load, credit and
 * usage warnings), one per `key`. The server keeps it until the Agent clears that key, `expires_at` passes, or a new agent
 * replaces the one that raised it.
 */
export const SessionNoticeSchema = z.object({
  key: z.string(), level: z.enum(['info', 'warn', 'error', 'success']), text: z.string(),
  expires_at: NullableNumber.describe('Unix seconds when the server drops it; null when only the Agent clears it.'),
})
export type SessionNotice = z.infer<typeof SessionNoticeSchema>

/**
 * TAL-808: the session's standing `/goal` while it runs, from the Agent's goal state. `parked` is an active goal waiting on
 * a process or a timer; `reason` is why it is paused or what it waits on. A done, cleared or absent goal is null.
 */
export const SessionGoalSchema = z.object({
  text: z.string(), status: z.enum(['active', 'paused', 'parked']), turns_used: z.number().int().nonnegative(), max_turns: z.number().int().nonnegative(),
  reason: NullableString, parked_until: NullableNumber.describe('Unix seconds a timed park ends; null otherwise.'),
})
export type SessionGoal = z.infer<typeof SessionGoalSchema>

/**
 * TAL-299: the context ring, computed by the server. `context_used_tokens` is the post-compression estimate, else the last
 * prompt (never the cumulative `input_tokens`); `context_window_tokens` is the model's window. The percents are rounded
 * and capped at 100. Each is null when unknown, and clients then show no percentage.
 */
export const ContextUsageFields = {
  context_used_tokens: z.number().int().positive().nullable().optional(), context_window_tokens: z.number().int().positive().nullable().optional(),
  context_usage_percent: z.number().int().min(0).max(100).nullable().optional(), context_threshold_percent: z.number().int().min(0).max(100).nullable().optional(),
}

// TAL-312: the server validates both flags on every session payload; clients render them and never re-derive them.
/** TAL-460: who started the running turn; `background` means a background result did, and the user's next message replaces it. */
const ActiveTurnOriginSchema = z.enum(['user', 'background']).nullable().optional().describe('Who started the running turn; null while idle.')
const IsStreamingSchema = z.boolean().describe('True only while the session\'s run is a live stream on this server.')
const ActiveStreamIdSchema = NullableString.optional().describe('The live stream id; non-null only while `is_streaming` is true.')
const ReadOnlyReasonSchema = NullableString.optional().describe('Server-owned reason this session is display-only or its ownership cannot be verified.')
const ReadOnlySchema = z.boolean().describe('The session cannot be modified from Web: a read-only import, a view-only subagent child, or a foreign session whose owner refuses claiming.')
const CanBranchSchema = z.boolean().describe('Web may branch this session: never a subagent child or an ownership-locked session; other read-only sessions only when they are cron runs.')
const CanPinSchema = z.boolean().describe('Web may pin or unpin this session: never a subagent child or a session locked by canonical ownership or unreadable ownership storage.')
const CanArchiveSchema = z.boolean().describe('Web may archive or unarchive this session: never a subagent child or a session locked by canonical ownership or unreadable ownership storage.')
const CanDeleteSchema = z.boolean().describe('Web may delete this session: never a read-only session (a read-only import, a view-only subagent child, or a foreign session whose owner refuses claiming).')
const CanDuplicateSchema = z.boolean().describe('Web may duplicate this session: it has a WebUI copy, is not a subagent child, and is not locked by canonical ownership or unreadable ownership storage.')
const CanShareSchema = z.boolean().describe('Web may create or refresh a public share of this session: never a Claude Code import (TAL-551).')
// TAL-310: the server classifies every session's source once; clients file rows by it and never scan source markers.
export const SourceKindSchema = z.enum(['webui', 'cli', 'messaging', 'cron', 'webhook', 'subagent', 'claude_code', 'kanban', 'api', 'other'])
  .describe('The session\'s source family. `is_cli_session` is true only for `cli` and `claude_code`.')
// TAL-306: clients keep the server's list order and date-bucket by this; they never sort or pick a timestamp themselves.
const SortTsSchema = z.number().describe('Epoch seconds the session sorts and date-buckets by: `last_message_at`, else `updated_at`, else `created_at`.')
const IsMessagingSessionSchema = z.boolean().describe('`source_kind` is `messaging`: a gateway chat (Telegram, Signal, WhatsApp, …) the server imports before Web continues it.')

/**
 * The label every client shows for the session's workspace: its registered name in the session profile's registry, else
 * the folder name (TAL-303). Null without a workspace; absent from an older server, where clients show no label.
 */
const WorkspaceNameSchema = NullableString.optional()

/** TAL-454: the chat a `/branch` copied, with its redacted title. */
export const BranchedFromSchema = z.object({ session_id: SessionIdSchema, title: z.string() })
export type BranchedFrom = z.infer<typeof BranchedFromSchema>

export const MAX_SOURCE_REFERENCES = 5
export const SourceReferenceSchema = z.object({
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('Retained logical conversation identity.'),
  tip_session_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  profile: z.string().min(1).max(128),
})
export type SourceReference = z.infer<typeof SourceReferenceSchema>
export const AcceptedSourceReferenceSchema = SourceReferenceSchema.extend({ title: z.string() })
export type AcceptedSourceReference = z.infer<typeof AcceptedSourceReferenceSchema>
/** Full session record from `GET /api/session` and mutations returning `session`. */
export const SessionActivityPhaseSchema = z.enum(['starting', 'running', 'waiting_for_approval', 'waiting_for_input', 'completed', 'failed', 'cancelled', 'stale'])
export type SessionActivityPhase = z.infer<typeof SessionActivityPhaseSchema>

/** Raw rows remain for older clients; current clients render only the server-normalized display items. */
export const TodoItemSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), text: z.string().optional(), content: z.string().optional(), title: z.string().optional(), status: z.string().optional(), done: z.boolean().optional(), completed: z.boolean().optional() })
export const TodoStateSchema = z.looseObject({
  display_items: z.array(z.object({ id: z.union([z.string(), z.number()]).optional(), text: z.string(), state: z.enum(['pending', 'in_progress', 'completed', 'cancelled']) })).optional(),
  total_count: z.number().int().nonnegative().optional(), completed_count: z.number().int().nonnegative().optional(),
  pending_count: z.number().int().nonnegative().optional(), in_progress_count: z.number().int().nonnegative().optional(), cancelled_count: z.number().int().nonnegative().optional(),
  session_id: z.string().optional(), todos: z.array(TodoItemSchema).optional(), summary: z.record(z.string(), z.unknown()).optional(),
  version: z.number().optional(), ts: z.number().optional(), source: z.string().optional(), description: z.string().optional(),
})
export type TodoState = z.infer<typeof TodoStateSchema>

export const SessionSchema = z.looseObject({
  plan_gauge: PlanGaugeSchema.nullable().optional(),
  show_reasoning: z.boolean().optional().describe('Server-resolved display preference. Hidden reasoning is omitted from live events, history and activity scenes; older servers omit this field.'),
  activity_phase: SessionActivityPhaseSchema.optional(),
  todo_state: TodoStateSchema.optional(),
  source_references: z.array(AcceptedSourceReferenceSchema).optional(),
  context_detail_key: z.string().nullable().optional().describe('Opaque identity for open-only context details; changes with owner epoch, model and context.'),
  composer_state_key: z.string().optional().describe('Opaque profile-home and owner identity for device-local composer state; never an API session id.'),
  clear_generation: NullableString.optional().describe('TAL-848: opaque marker that changes each time /clear empties the session; a client whose clear outcome is unknown compares it with its last read. Null before any clear; older servers omit it.'),
  session_id: SessionIdSchema, title: z.string(), workspace: z.string().optional(), created_workspace: z.string().nullable().optional(), model: NullableString.optional(), model_provider: NullableString.optional(),
  model_option_id: NullableString.optional().describe('TAL-301: the catalog entry id the stored model/provider selects; null when none.'),
  messages: z.array(MessageSchema).optional(), tool_calls: z.array(ToolCallSchema).optional(), created_at: UnixSeconds.optional(), updated_at: UnixSeconds.optional(), last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(), user_message_count: z.number().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: NullableString.optional(), profile: NullableString.optional(),
  personality: NullableString.optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional(), cache_write_tokens: z.number().optional(),
  cache_hit_percent: NullableNumber.optional(), estimated_cost: NullableNumber.optional(), active_stream_id: ActiveStreamIdSchema, is_streaming: IsStreamingSchema, active_turn_origin: ActiveTurnOriginSchema, pending_steers: z.array(PendingSteerSchema).optional().describe('TAL-424: the active stream\'s pending steers, oldest first.'),
  run_status: RunStatusSchema.nullable().optional().describe('Current server-selected run presentation; null when no turn runs. Older servers omit it.'),
  compression_started_at: NullableNumber.optional().describe('TAL-1006: when the compression clients show started (epoch seconds): the running manual job\'s, else the live run\'s open span; null when none runs.'),
  notices: z.array(SessionNoticeSchema).optional().describe('TAL-803: the Agent\'s active notices for the session, oldest first.'),
  goal: SessionGoalSchema.nullable().optional().describe('TAL-808: the standing /goal; null when none runs.'),
  automatic_turns_held: z.boolean().optional().describe('TAL-899: the user pressed Stop, so no automatic turn (background wakeup or goal continuation) starts until their next message.'), has_pending_user_message: z.boolean().optional(),
  pending_user_message: NullableString.optional(), pending_attachments: z.array(AttachmentSchema).optional(), pending_started_at: NullableNumber.optional(), pending_user_source: NullableString.optional(),
  context_length: NullableNumber.optional(), threshold_tokens: NullableNumber.optional(), last_prompt_tokens: NullableNumber.optional(), post_compression_context_tokens_estimate: NullableNumber.optional(), ...ContextUsageFields,
  execution_mode: ExecutionModeSchema.optional().describe('TAL-1040: the Agent execution policy frozen when the session was created; absent from older servers.'),
  enabled_toolsets: z.array(z.string()).nullable().optional(), composer_draft: ComposerDraftSchema.optional(), is_cli_session: z.boolean().optional(), source_kind: SourceKindSchema, is_messaging_session: IsMessagingSessionSchema, sort_ts: SortTsSchema, read_only: ReadOnlySchema, read_only_reason: ReadOnlyReasonSchema, owner_attachment: OwnerAttachmentSchema.optional(), can_branch: CanBranchSchema, can_pin: CanPinSchema, can_archive: CanArchiveSchema, can_delete: CanDeleteSchema, can_duplicate: CanDuplicateSchema, can_share: CanShareSchema, source_tag: NullableString.optional(),
  can_compress: z.boolean().optional().describe('TAL-614: a manual compression would start now: writable, no running turn, and at least four model-history messages. Only the full session detail carries it; absent means no.'),
  confirms_deep_truncate: z.boolean().optional().describe('TAL-929: this server holds a `session.truncate` that discards more than one user turn until it is confirmed; absent on older servers, which cut at once.'),
  source_label: NullableString.optional(), session_source: NullableString.optional(), raw_source: NullableString.optional(), parent_session_id: NullableString.optional(), worktree_path: NullableString.optional(),
  worktree_branch: NullableString.optional(), worktree_repo_root: NullableString.optional(),
  worktree_retained: z.literal(true).optional().describe('TAL-1254: the last sidecar start found this worktree gone from git; the Agent\'s sweep keeps an archived one under `refs/hermes/archive/`. Absent while the worktree exists.'),
  share_token: NullableString.optional(), share_url: NullableString.optional(), share_created_at: NullableNumber.optional(), manual_title: z.boolean().optional(),
  compression_anchor_summary: NullableString.optional(), compression_recovery: z.record(z.string(), Json).optional(), recommended_recovery_action: NullableString.optional(), compression_recovery_action: NullableString.optional(),
  compression_recovery_source_session_id: NullableString.optional(), gateway_routing: Json.optional(), _messages_offset: z.number().optional(), _messages_truncated: z.boolean().optional(), _msg_limit_max: z.number().optional(), _load_revision: z.string().optional(),
  /**
   * Where `messages` end in the run journal of `stream_id`: they hold nothing that journal delivers after `seq`, so a client
   * resumes that stream with `after_seq = seq` and renders the replay as-is. Null (no active run, or no journal to replay):
   * `messages` are the whole persisted transcript and a client attaches live without replay.
   */
  transcript_seq: z.object({ stream_id: z.string(), seq: z.number().int().nonnegative() }).nullable().optional(),
  /** The agent's display name: a named profile's own name, else the `bot_name` setting (TAL-458). */
  assistant_name: z.string().optional(),
  workspace_name: WorkspaceNameSchema,
  focus_path: NullableString.optional().describe('TAL-1458: the last non-null `focus_path` of the session\'s persisted tool calls, so a reopened chat shows its file before any stream event; null when none. TAL-1537: absolute paths inside the session workspace count.'),
  branched_from: BranchedFromSchema.nullable().optional().describe('TAL-454: the chat this one was branched from while it still loads (archived included); null for a compression continuation, a deleted or missing parent, and every other chat.'),
})
export type Session = z.infer<typeof SessionSchema>
export const SessionEnvelopeSchema = z.looseObject({ session: SessionSchema })

/**
 * TAL-1534: the sidebar group a listed row belongs to; `pinned` rows come first in the canonical order. TAL-1639: cron
 * and webhook rows belong to `scheduled` and `webhook` instead, pinned or archived, and count in `scheduled_session_count`
 * and `webhook_session_count`.
 */
export const SidebarGroupKindSchema = z.enum(['pinned', 'recent', 'scheduled', 'webhook'])
export type SidebarGroupKind = z.infer<typeof SidebarGroupKindSchema>
/** One group present in a session list, with its English caption; clients localize the known kinds. */
export const SidebarGroupSchema = z.object({ kind: SidebarGroupKindSchema, title: z.string() })
export type SidebarGroup = z.infer<typeof SidebarGroupSchema>

/** Sidebar row from `GET /api/sessions`. */
export const SessionRowSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string(), workspace: z.string().optional(), model: NullableString.optional(), created_at: UnixSeconds.optional(), updated_at: UnixSeconds.optional(), last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: NullableString.optional(), profile: NullableString.optional(), is_streaming: IsStreamingSchema,
  is_cli_session: z.boolean().optional(), source_kind: SourceKindSchema, is_messaging_session: IsMessagingSessionSchema, sort_ts: SortTsSchema, cron_running: z.boolean().optional(), read_only: ReadOnlySchema, read_only_reason: ReadOnlyReasonSchema, owner_attachment: OwnerAttachmentSchema.optional(), can_branch: CanBranchSchema, can_pin: CanPinSchema, can_archive: CanArchiveSchema, can_delete: CanDeleteSchema, can_duplicate: CanDuplicateSchema, can_share: CanShareSchema, attention: z.looseObject({ kind: z.string().optional(), count: z.number().optional() }).nullable().optional(),
  source_tag: NullableString.optional(), source_label: NullableString.optional(), session_source: NullableString.optional(), raw_source: NullableString.optional(), parent_session_id: NullableString.optional(),
  active_stream_id: ActiveStreamIdSchema, share_token: NullableString.optional(), share_url: NullableString.optional(), worktree_branch: NullableString.optional(), match_type: z.enum(['title', 'metadata', 'content']).optional(), match_preview: NullableString.optional(),
  workspace_name: WorkspaceNameSchema,
  sidebar_group: SidebarGroupKindSchema.nullable().optional().describe('TAL-1534: the sidebar group `GET /api/sessions` and its sidebar search file the row under; null for an archived row outside `scheduled` and `webhook`. Other routes omit it.'),
  sidebar_parent_session_id: NullableString.optional().describe('TAL-1151: the listed row this subagent row nests under (its nearest non-subagent ancestor, a compressed parent by its lineage tip, same profile); null when that row is not in the same response. A nested row files in its parent\'s project and source tab. `GET /api/sessions` and its sidebar search set it; older servers and other routes omit it.'),
  ...ContextUsageFields,
})
export type SessionRow = z.infer<typeof SessionRowSchema>

/**
 * TAL-785: whether the Agent's `state.db` could serve the Agent session rows. `corrupt`: SQLite reports the file
 * damaged; `unavailable`: it could not be read for another reason (permissions, a lock, an I/O error); `outdated`: a
 * readable database from an older hermes-agent. `reason` explains a degraded state.
 */
export const AgentStorageSchema = z.object({ state: z.enum(['ok', 'corrupt', 'unavailable', 'outdated']), reason: z.string().nullable() })
export type AgentStorage = z.infer<typeof AgentStorageSchema>

export const SessionsListSchema = z.looseObject({
  sessions: z.array(SessionRowSchema).describe('Canonical display order (TAL-306): pinned first, then active (streaming or a pending prompt), then newest `sort_ts`, then `session_id`. Clients keep it.'), sidebar_reference_sessions: z.array(SessionRowSchema), server_time: z.number(), server_tz: z.string(), active_profile: z.string(), all_profiles: z.boolean(), include_archived: z.boolean(),
  archived_count: z.number().int(), archived_webui_count: z.number().int(), archived_cli_count: z.number().int(), other_profile_count: z.number().int(), cli_count: z.number().int(), webui_session_count: z.number().int(),
  cli_session_count: z.number().int(),
  // TAL-482: sidebar counts for the "Scheduled sessions" / "Webhook sessions" groups; `_truncated` means more exist than are listed.
  scheduled_session_count: z.number().int().nonnegative(), scheduled_sessions_truncated: z.boolean(),
  webhook_session_count: z.number().int().nonnegative(), webhook_sessions_truncated: z.boolean(),
  sidebar_groups: z.array(SidebarGroupSchema).describe('TAL-1534: the groups the `sessions` rows fill, in display order (archived rows fill only `scheduled` and `webhook`); a client captions only these.'),
  agent_storage: AgentStorageSchema.describe('Agent session storage health; a degraded state explains an empty or missing Agent session list.'),
  archived_limit: z.number().int().nullable().optional(), archived_offset: z.number().int().optional(),
})
export type SessionsList = z.infer<typeof SessionsListSchema>

export const SessionStatusSchema = z.looseObject({
  activity_phase: SessionActivityPhaseSchema.optional(),
  session_id: SessionIdSchema, title: z.string().optional(), active_stream_id: ActiveStreamIdSchema, active_turn_origin: ActiveTurnOriginSchema, agent_running: IsStreamingSchema, is_streaming: IsStreamingSchema, read_only: ReadOnlySchema, read_only_reason: ReadOnlyReasonSchema, owner_attachment: OwnerAttachmentSchema.optional(), message_count: z.number().optional(), model: NullableString.optional(),
  profile: NullableString.optional(), workspace: z.string().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(), estimated_cost: NullableNumber.optional(), updated_at: UnixSeconds.optional(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export const SessionUsageSchema = z.looseObject({ plan_gauge: PlanGaugeSchema.nullable().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(), estimated_cost: NullableNumber.optional(), model: NullableString.optional() })

export const ProjectSchema = z.looseObject({ project_id: z.string(), name: z.string(), color: z.string().nullable().optional(), profile: NullableString.optional(), created_at: z.number().optional() })
export const ProjectsSchema = z.looseObject({ projects: z.array(ProjectSchema), active_profile: z.string(), all_profiles: z.boolean(), other_profile_count: z.number().int() })
export const SessionDeleteResultSchema = z.looseObject({ ok: z.literal(true), state_db_cleanup_failed: z.boolean().optional() })

// ── chat ─────────────────────────────────────────────────────────────────

/** `voice_turn` (TAL-801): the turn was spoken (an App voice note), so the Agent runs it on `auxiliary.voice_chat`. */
export const ChatStartRequestSchema = z.looseObject({
  submission_id: z.string().min(1).max(128).optional().describe('Stable native-owner admission identity. Reuse only for an exact retry of the same submission.'),
  session_id: SessionIdSchema, message: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), workspace: z.string().nullable().optional(), profile: z.string().nullable().optional(),
  explicit_model_pick: z.boolean().optional(), attachments: z.array(z.union([AttachmentSchema, z.string()])).optional(), moa_config: z.boolean().optional(), regenerate: z.boolean().optional(), regeneration_revision: z.string().optional(),
  voice_turn: z.boolean().optional(),
  /** TAL-818: this client renders `connect_card`, so a `manage_connections` call waits on the card; without it the Agent answers with plain links. */
  connect_card: z.boolean().optional(),
  /** The starting client renders the masked `skill_secret` prompt; omitted by older and native clients. */
  skill_secret: z.boolean().optional(),
})
export type ChatStartRequest = z.infer<typeof ChatStartRequestSchema>
/** Accepted turn. `stream_id` is the owner identity for the SSE connection. */
export const ChatStartResponseSchema = z.looseObject({
  owner_attachment: OwnerAttachmentSchema.optional(), admission_id: z.string().optional(),
  stream_id: z.string().optional(), session_id: SessionIdSchema.optional(), turn_id: z.string().optional(), user_message_id: z.union([z.string(), z.number()]).nullable().optional(), pending_started_at: z.number().nullable().optional(),
  title: z.string().optional(), effective_model: z.string().optional(), effective_model_provider: z.string().optional(), queued: z.boolean().optional(), ok: z.boolean().optional(), status: z.string().optional(), reason: z.string().optional(), session: SessionSchema.optional(),
})
export type ChatStartResponse = z.infer<typeof ChatStartResponseSchema>
/**
 * `active` is whether this stream's channel is still live. `blocking_stream_id` (TAL-622) is the run that still holds the
 * stream's session: this run while it unwinds after a Stop, or a successor such as a goal continuation. A session delete
 * answers 409 while it is set, so a client draining a session before deleting it waits until it is null.
 */
export const StreamStatusSchema = z.looseObject({ activity_phase: SessionActivityPhaseSchema.optional(), active: z.boolean(), stream_id: z.string(), replay_available: z.boolean().optional(), journal: Json.optional(), blocking_stream_id: z.string().nullable() })
export type StreamStatus = z.infer<typeof StreamStatusSchema>
/**
 * TAL-424: a pending steer is no longer pending without the Agent taking it: Edit and Cancel by the user, `stopped` by a
 * Stop (`text` goes back to the composer), or `followup` when the server sends it as the next turn. `steer_id` is null
 * for text another surface queued with the Agent.
 */
export const SteerWithdrawnSchema = z.object({ steer_id: z.string().nullable(), reason: z.enum(['edit', 'cancel', 'stopped', 'followup']), text: z.string() })
export type SteerWithdrawn = z.infer<typeof SteerWithdrawnSchema>
/**
 * `withdrawn_steers` (TAL-426): the steers this Stop withdrew, the same `steer_withdrawn` (stopped) the stream carries, so
 * a client that stops reading the stream once the Stop answers still gives its own text back.
 */
export const CancelResponseSchema = z.looseObject({ activity_phase: SessionActivityPhaseSchema.optional(), ok: z.boolean(), cancelled: z.boolean(), stream_id: z.string().optional(), withdrawn_steers: z.array(SteerWithdrawnSchema).optional(), error: z.string().optional() })
export const SteerWithdrawRequestSchema = z.object({ session_id: SessionIdSchema, steer_id: z.string().min(1), reason: z.enum(['edit', 'cancel']) })
export type SteerWithdrawRequest = z.infer<typeof SteerWithdrawRequestSchema>
/** `withdrawn: false` when the steer is unknown, already taken by the Agent (it then settles as consumed), or being sent. */
export const SteerWithdrawResponseSchema = z.object({ withdrawn: z.boolean(), text: z.string().optional() })
export const SteerSendNowRequestSchema = z.object({ session_id: SessionIdSchema, steer_id: z.string().min(1) })
/** The server decides why Send now did or did not deliver. `redirected` remains for older clients. */
export const SteerSendNowResponseSchema = z.object({ redirected: z.boolean(), outcome: z.enum(['delivered', 'next_step', 'not_running', 'taken', 'failed']) })
export type SteerSendNowResponse = z.infer<typeof SteerSendNowResponseSchema>

/** `text` is delivered to the running agent; `display_text` is what the transcript shows. */
export const SteerRequestSchema = z.looseObject({ session_id: SessionIdSchema, text: z.string().min(1), display_text: z.string().optional(), steer_id: z.string().optional() })
/** `accepted: false` with a `fallback` reason means the message was not delivered; the caller keeps the draft. */
/** TAL-460: a steer sent while a background turn runs starts the user's own turn instead; `started_turn` is its start response. */
export const SteerResponseSchema = z.looseObject({ accepted: z.boolean(), fallback: NullableString.optional(), stream_id: NullableString.optional(), steer_id: z.string().optional(), started_turn: ChatStartResponseSchema.optional() })
export type SteerResponse = z.infer<typeof SteerResponseSchema>

export const ApprovalPendingSchema = z.looseObject({
  allowed_choices: z.array(z.enum(['once', 'session', 'always', 'deny'])).optional()
    .describe('The answers this approval accepts; empty when its owner offered none Talaria can send. Absent (older servers, direct sessions) accepts all four.'),
  can_enable_yolo: z.boolean().optional(),
  approval_id: z.string().optional(), session_id: z.string().optional(), command: z.string().optional(), description: z.string().optional(), title: z.string().optional(), name: z.string().optional(), kind: z.string().optional(),
  reason: z.string().optional(), action: z.string().optional(), question: z.string().optional(), status: z.string().optional(), pending_count: z.number().optional(), run_id: z.string().optional(), mirror_token: z.string().optional(),
})
export type ApprovalPending = z.infer<typeof ApprovalPendingSchema>
export const ApprovalPendingEnvelopeSchema = z.looseObject({ pending: ApprovalPendingSchema.nullable(), pending_count: z.number().int() })
export const ApprovalChoiceSchema = z.enum(['once', 'session', 'always', 'deny'])
export const ApprovalRespondRequestSchema = z.looseObject({ session_id: SessionIdSchema, choice: ApprovalChoiceSchema, approval_id: z.string().optional(), command: z.string().optional(), yolo: z.boolean().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() })
export const ApprovalRespondResponseSchema = z.looseObject({ ok: z.boolean(), choice: z.string().optional(), yolo_enabled: z.boolean().optional(), stale_cleared: z.boolean().optional(), error: z.string().optional(), pending_count: z.number().optional() })

export const ClarifyChoiceSchema = z.union([z.string(), z.looseObject({ label: z.string().optional(), value: z.string().optional(), text: z.string().optional() })])
/** One question the client asks, in server order; answers are keyed by `qid`. A single-question prompt is one `q0` step. */
export const ClarifyStepSchema = z.looseObject({ qid: z.string(), question: z.string(), choices: z.array(z.string()), multi_select: z.boolean(),
  answered: z.boolean().optional().describe('TAL-1271: a gateway-owned batch question the owner already holds an answer for; it stays editable until the last answer.') })
export type ClarifyStep = z.infer<typeof ClarifyStepSchema>
/** Keyed step answers; a multi-select step takes a list. The server shapes them into the Agent's reply. */
export const ClarifyAnswersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
export type ClarifyAnswers = z.infer<typeof ClarifyAnswersSchema>
/** TAL-887: one input of a password-manager prompt, answered under its `key`; a `secure` input is masked. */
export const VaultPromptFieldSchema = z.object({ key: z.enum(['master_password', 'identifier', 'password', 'code', 'secret']), secure: z.boolean() })
export type VaultPromptField = z.infer<typeof VaultPromptFieldSchema>
/**
 * TAL-887: the Agent asks for a password manager's master password (`vault_unlock`), a login to save for the page it is
 * on (`vault_save_login`), a one-time code (`vault_code`), or a skill environment secret (`skill_secret`). Clients answer through
 * `/api/clarify/respond` with keyed `answers`, or `decline`; an empty answer, a decline, a cancel and `timeout_at` all
 * resolve it unanswered. Answers never enter chat, logs, streams, or responses. Skill secrets are saved only to the invoking profile.
 */
export const VaultPromptSchema = z.object({
  kind: z.enum(['vault_unlock', 'vault_save_login', 'vault_code', 'skill_secret']),
  backend: z.string().nullable().describe('The password manager (`vault_unlock`).'),
  display_name: z.string().nullable().describe('Its display name (`vault_unlock`).'),
  origin: z.string().nullable().describe('The page origin the login is saved for (`vault_save_login`).'),
  site: z.string().nullable().describe('The site, by host (`vault_save_login`, `vault_code`).'),
  hint: z.string().nullable().describe('Where the code was sent, when the Agent says (`vault_code`).'),
  skill: z.object({ env_var: z.string(), skill_name: z.string(), help: z.string().nullable(), required_for: z.string().nullable() }).optional().describe('Profile-local environment setup metadata (`skill_secret`).'),
  fields: z.array(VaultPromptFieldSchema),
  timeout_at: z.number().describe('Unix seconds when the Agent stops waiting.'),
})
export type VaultPrompt = z.infer<typeof VaultPromptSchema>
export const ClarifyPendingSchema = z.looseObject({
  steps: z.array(ClarifyStepSchema).optional(),
  vault: VaultPromptSchema.optional(),
  clarify_id: z.string().optional(), session_id: z.string().optional(), question: z.string().optional(), description: z.string().optional(), choices: z.array(ClarifyChoiceSchema).optional(), title: z.string().optional(),
  name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), status: z.string().optional(), raw_preview: z.string().optional(), timeout_at: z.number().optional(),
  timeout_seconds: z.number().optional(), pending_count: z.number().optional(), index: z.number().optional(), total: z.number().optional(),
})
export type ClarifyPending = z.infer<typeof ClarifyPendingSchema>
export const ClarifyPendingEnvelopeSchema = z.looseObject({ pending: ClarifyPendingSchema.nullable(), pending_count: z.number().int() })
export const ClarifyRespondRequestSchema = z.looseObject({ session_id: SessionIdSchema, answers: ClarifyAnswersSchema.optional(), response: z.string().optional(), answer: z.string().optional(), choice: z.string().optional(), clarify_id: z.string().optional(), decline: z.boolean().optional() })
export const ClarifyRespondResponseSchema = z.looseObject({ ok: z.boolean(), response: z.string().optional(), error: z.string().optional(), stale: z.boolean().optional() })

export const DraftSchema = z.looseObject({ text: z.string(), files: z.array(Json) })
export const DraftResponseSchema = z.looseObject({ ok: z.literal(true), draft: DraftSchema, draft_version: z.string().nullable(), unchanged: z.boolean().optional() })
/** At most this many attachments ride one chat message; the server names each in the prompt (TAL-276, TAL-635). */
export const MAX_CHAT_ATTACHMENTS = 20
export const UploadResponseSchema = z.looseObject({ filename: z.string(), path: z.string(), size: z.number(), mime: z.string(), is_image: z.boolean().optional(), rollback_token: z.string().optional(), named_in_prompt: z.boolean().optional(), max_attachments_per_message: z.number().int().positive().optional() })
export type UploadResponse = z.infer<typeof UploadResponseSchema>
export const GoalViewSchema = z.looseObject({ text: z.string().optional(), state: z.string().optional(), status: z.string().optional(), turns: z.number().optional(), max_turns: z.number().optional(), reason: z.string().optional() })
export const GoalResponseSchema = z.looseObject({ ok: z.boolean().optional(), action: z.string().optional(), goal: GoalViewSchema.nullable().optional(), message: z.string().optional(), message_key: z.string().optional(), stream_id: z.string().optional(), status: z.string().optional(), reason: z.string().optional() })
/**
 * TAL-372: one piece of background work a session owns, the same record for every client, reload and restart.
 * - `task_id` is stable: the delegation unit's id, the process id, or the `/background` task id.
 * - `status` `attention` is a stalled agent or a matched watch; `unknown` is running work the Agent cannot confirm now.
 * - `title` is the goal, command or prompt (one line, never output); `agents` counts a delegation's subagents.
 * - `result_available` means `GET /api/background/result` returns its full result.
 * - `pinned` puts it in the chat's background tray: running work, and a finished `/background` result until dismissed.
 * - `dismissible` offers Dismiss: a finished `/background` result, or work nobody can confirm (`unknown`).
 * - `active`: not settled yet (running, attention or unknown); clients keep refreshing while any record is active.
 */
export const BackgroundTaskSchema = z.object({
  task_id: z.string(),
  kind: z.enum(['delegation', 'process', 'background_command']),
  status: BackgroundLinkSchema.shape.status,
  title: z.string(),
  started_at: z.number().nullable(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
  result_available: z.boolean(),
  /** TAL-494: each subagent session a delegation ran, by its goal: a read-only transcript to open. */
  child_sessions: z.array(z.object({ goal: z.string(), session_id: SessionIdSchema })),
  exit_code: z.number().int().nullable(),
  agents: BackgroundLinkSchema.shape.agents.nullable(),
  pinned: z.boolean(),
  dismissible: z.boolean(),
  /** TAL-1172: confirmed running work this session may stop. */
  can_stop: z.boolean().optional(),
  active: z.boolean(),
})
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>
/**
 * `agent_available: false` when the Agent could not be asked: running work then shows `unknown`. Reading never consumes a
 * result. `agents_working` (TAL-373): a delegation is running or needs attention, whatever `kind` the list is narrowed to;
 * the chat's side panel opens on Agents for it. Absent from servers before TAL-373.
 */
export const BackgroundTasksResponseSchema = z.object({ activity_phase: SessionActivityPhaseSchema.optional(), session_id: z.string(), tasks: z.array(BackgroundTaskSchema), agent_available: z.boolean(), agents_working: z.boolean().optional() })
export const BackgroundTaskResultSchema = z.object({ task_id: z.string(), text: z.string() })
export const BackgroundDismissRequestSchema = z.object({ session_id: SessionIdSchema, task_id: z.string().min(1) })
export const BackgroundStopResponseSchema = z.object({ outcome: z.enum(['stopped', 'not_running', 'not_found']) })
export const BackgroundDismissResponseSchema = z.object({ ok: z.literal(true), task: BackgroundTaskSchema })
export const ShareCreateResponseSchema = z.looseObject({ ok: z.literal(true), share: z.looseObject({ token: z.string(), url: z.string(), title: z.string(), message_count: z.number().int(), created_at: z.number(), updated_at: z.number() }), session: SessionRowSchema })
export const ShareMessageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.null(), z.array(Json)]).optional() })
export const ShareSchema = z.looseObject({ title: z.string(), messages: z.array(ShareMessageSchema), message_count: z.number().int(), created_at: z.number().optional(), updated_at: z.number().optional(), model: NullableString.optional() })
export const ShareReadSchema = z.looseObject({ share: ShareSchema })

export const SourceReferenceSearchSchema = z.object({
  sessions: z.array(SessionRowSchema.extend({ source_reference: SourceReferenceSchema })),
  active_profile: z.string(), max_sources: z.number().int(),
})

export const SessionNewRequestSchema = z.looseObject({
  title: z.string().optional(), workspace: z.string().optional(), workspace_inherited_from_prev_session: z.boolean().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(),
  profile: z.string().nullable().optional(), prev_session_id: z.string().optional(), project_id: z.string().nullable().optional(), worktree: Json.optional(), enabled_toolsets: z.array(z.string()).nullable().optional(), parent_session_id: z.string().optional(),
  execution_mode: ExecutionModeSchema.optional().describe('TAL-1040: `ignore_config` and `safe` start the session through the Agent owner; omitted means normal.'),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe('TAL-1040: stable creation identity for a diagnostic or referenced chat. Reuse it only to retry the same creation.'),
  source_references: z.array(SourceReferenceSchema).max(MAX_SOURCE_REFERENCES).optional().describe('Same-profile search pointers. Nonempty selections require request_id; unavailable or changed identities refuse creation.'),
})
/**
 * `streaming` (TAL-802): live dictation over `TRANSCRIBE_STREAM_PATH` would open for this profile (`stt.streaming` on, a live provider wire).
 * `warm_supported` (TAL-916): a client starting a recording should `POST /api/transcribe/warm` so the engine loads while the user speaks.
 */
export const TranscribeCapabilitySchema = z.looseObject({ ok: z.literal(true), available: z.boolean(), provider: z.string(), streaming: z.boolean(), warm_supported: z.boolean() })
/** TAL-906: what read-aloud speaks for a message; clients play it as is. */
export const SpeechPrepareSchema = z.object({ spoken_text: z.string() })
/**
 * `POST /api/transcribe`: the recording's transcript; `filtered` (TAL-917) when the server emptied a phrase Whisper invents on silent audio.
 * `no_speech` (TAL-1608): the provider ran cleanly and produced no transcript; clients show their no-speech notice and keep the draft.
 */
export const TranscribeResponseSchema = z.looseObject({ ok: z.literal(true), transcript: z.string(), filtered: z.boolean(), no_speech: z.boolean().default(false) })

// ── settings, profiles, models, providers ───────────────────────────────

/** TAL-411: the request profile's quota urgency thresholds. A save patches valid fields and clamps critical to at most warning. */
export const QuotaThresholdsSchema = z.object({
  warning_remaining_percent: z.number().int().min(1).max(99), critical_remaining_percent: z.number().int().min(0).max(99), pace_tolerance_percent: z.number().int().min(0).max(25),
  pace_warning_burn_rate_percent: z.number().int().min(100).max(300), pace_critical_burn_rate_percent: z.number().int().min(100).max(400), pace_minimum_elapsed_hours: z.number().int().min(0).max(72),
})
export type QuotaThresholds = z.infer<typeof QuotaThresholdsSchema>
/** TAL-1075: where a browser goes after sign-in, resolved by the server against the page's mount exactly once. */
export const LoginRedirectSchema = z.object({ redirect_path: z.string().optional().describe('Same-origin path-absolute destination for a browser sign-in, mounted exactly once; absent from older servers.') })
export const LoginResponseSchema = z.looseObject({ ok: z.literal(true), message: z.string().optional(), ...LoginRedirectSchema.shape })
/** TAL-1569: Talaria Web update channels, in display order. Nightly is a daily snapshot of the Experimental artifact. */
export const WebUpdateChannelSchema = z.enum(['stable', 'nightly', 'experimental'])
export type WebUpdateChannel = z.infer<typeof WebUpdateChannelSchema>
export const SettingsSchema = z.looseObject({
  bot_name: z.string().optional(), default_model: z.string().optional(), default_workspace: z.string().optional(), language: z.string().optional(), send_key: z.string().optional(), font_size: z.string().optional(),
  full_width_chat: z.boolean().optional(), chat_width: z.enum(['comfortable', 'wide', 'full']).optional(), auto_scroll_follow: z.boolean().optional(), render_user_markdown: z.boolean().optional(), chat_activity_display_mode: z.string().optional(), default_message_mode: z.string().optional(),
  fade_text_effect: z.boolean().optional(), hidden_tabs: z.array(z.string()).optional(), composer_control_order: z.array(z.string()).optional(), show_cli_sessions: z.boolean().optional(), show_claude_code_sessions: z.boolean().optional(),
  show_cron_sessions: z.boolean().optional(), show_sidebar_feedback: z.boolean().optional().describe('TAL-1588: show Send feedback in the Web rail above Notifications.'), show_webhook_sessions: z.boolean().optional(), show_kanban_sessions: z.boolean().optional(), check_for_updates: z.boolean().optional(), summarize_updates_automatically: z.boolean().optional(), ignore_agent_updates: z.boolean().optional(),
  auth_enabled: z.boolean().optional(), password_auth_enabled: z.boolean().optional(), password_env_var: z.boolean().optional(), passkeys_enabled: z.boolean().optional(), passwordless_enabled: z.boolean().optional(),
  auth_disabled_acknowledged: z.boolean().optional(), webui_version: z.string().optional(), agent_version: z.string().optional(), update_channel: z.string().optional(), update_channels: z.array(WebUpdateChannelSchema).optional().describe('TAL-1569: the Web update channels this server offers, in display order.'), agent_update_channel: z.enum(['stable', 'experimental']).optional(), update_channel_version: NullableString.optional(),
  max_tokens: NullableNumber.optional(), max_tokens_effective: NullableNumber.optional(), max_tokens_fallback: NullableNumber.optional(), tts_engine: z.string().optional(), tts_voice: z.string().optional(),
  dictation_append: z.boolean().optional(), persisted_speech_keys: z.array(z.string()).optional(),
  /** TAL-279: ask before opening external chat links; `trusted_link_hosts` are exact, server-normalized hostnames that skip the ask. */
  confirm_external_links: z.boolean().optional(), trusted_link_hosts: z.array(z.string()).optional(),
  provider_quota_thresholds: QuotaThresholdsSchema.optional(),
})
export type Settings = z.infer<typeof SettingsSchema>
export const ProfileSchema = z.looseObject({
  name: z.string(), path: z.string().optional(), is_active: z.boolean().optional(), is_default: z.boolean().optional(), model: NullableString.optional(), provider: NullableString.optional(), skill_count: z.number().optional(),
  total_skills: z.number().optional(), enabled_skills: z.number().optional(), gateway_running: z.boolean().optional(), has_env: z.boolean().optional(), visible: z.boolean().optional(),
  /** TAL-805: the profile's gateway mode; `gateway_running` is true exactly for `own` and `served`. */
  gateway_mode: GatewayModeSchema.optional(),
  /** TAL-213: Bot Mode identity from `profile.yaml` (the bot's roster title, else the profile's display name), one bounded printable line each. */
  display_name: z.string().optional(), description: z.string().optional(), has_avatar: z.boolean().optional(),
  /** TAL-213: present only when the profile has a canonical Bot Chat; clients open `tip_session_id` after switching to the profile. */
  canonical_session: CanonicalBotChatSchema.nullable().optional(),
  /** TAL-819: skill and memory writes the Agent staged for approval, reviewed on the Skills and Memory pages. */
  pending_writes: z.number().int().optional(),
})
export const ProfilesSchema = z.looseObject({ profiles: z.array(ProfileSchema), active: z.string(), single_profile_mode: z.boolean().optional() })
export type Profiles = z.infer<typeof ProfilesSchema>
export const ActiveProfileSchema = z.looseObject({ name: z.string(), path: z.string().optional(), is_default: z.boolean().optional(), default_workspace: NullableString.optional() })
export const ProfileSwitchSchema = ProfilesSchema.extend({ is_default: z.boolean(), default_model: Json, default_model_provider: Json, default_workspace: z.string().nullable() })
/** `/api/reasoning`: config.yaml agent.reasoning_effort / display.show_reasoning, resolved for a model. */
export const ReasoningStatusSchema = z.looseObject({ show_reasoning: z.boolean().optional(), reasoning_effort: z.string().nullable().optional(), supported_efforts: z.array(z.string()).optional(), supports_reasoning_effort: z.boolean().optional(), supports_thinking_toggle: z.boolean().optional(), supports_session_scope: z.boolean().optional() })
export type ReasoningStatus = z.infer<typeof ReasoningStatusSchema>
export const QuotaLevelSchema = z.enum(['healthy', 'warning', 'critical', 'stale', 'unavailable'])
export type QuotaLevel = z.infer<typeof QuotaLevelSchema>
/**
 * TAL-301: `provider_id`/`bare_id` are the server's split of `id`; clients match a stored `(model, provider)` against them and send `id` back.
 * TAL-807: `limit` is present while the provider's credential pool cannot serve this model until `resets_at` (ISO-8601 UTC).
 */
export const ModelEntrySchema = z.looseObject({
  allowance: ModelAllowanceSchema.optional(),
  id: z.string(), label: z.string().optional(), provider: z.string().optional(), provider_id: z.string().optional(), bare_id: z.string().optional(), supports_fast_tier: z.boolean().optional(), supported_speed_tiers: z.array(SpeedTierSchema).optional(),
  limit: z.object({ scope: z.literal('model'), resets_at: z.string() }).optional(),
})
/** TAL-807: a group's rate limit: every pool account benched until `resets_at`, else the entry ids (`models`) cooling down until their reset. */
export const ModelGroupLimitSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('account'), resets_at: z.string() }),
  z.object({ scope: z.literal('models'), models: z.record(z.string(), z.string()) }),
])
/**
 * TAL-807: `limit` is the provider's live pool rate limit; `quota_level` is the TAL-411 `remaining` level of the tightest
 * account-scope window in the provider's last account-usage read (a model-family window never counts), absent without one
 * and while the group is account-limited.
 */
export const CatalogAvailabilitySchema = z.object({ status: z.enum(['available', 'stale', 'unavailable']), authoritative: z.boolean(), unavailable_reason: NullableString, generation: z.string().min(1).describe('Opaque source generation; cached data from another generation must never be merged.') })
export type CatalogAvailability = z.infer<typeof CatalogAvailabilitySchema>
export const ModelGroupSchema = z.looseObject({
  plan_usage: PlanUsageSchema.nullable().optional(), plan_stale: z.boolean().optional(), sections: ModelSectionsSchema.optional(),
  availability: CatalogAvailabilitySchema.optional(),
  provider: z.string(), provider_id: z.string().optional(), models: z.array(ModelEntrySchema), extra_models: z.array(ModelEntrySchema).optional(),
  limit: ModelGroupLimitSchema.optional(), quota_level: QuotaLevelSchema.optional(),
})
export const ModelsSchema = z.looseObject({ availability: CatalogAvailabilitySchema.optional(), active_provider: NullableString.optional(), default_model: z.string().optional(), default_provider_id: NullableString.optional(), default_bare_id: z.string().optional(), default_option_id: NullableString.optional(), groups: z.array(ModelGroupSchema), aliases: z.record(z.string(), Json).optional(), configured_model_badges: z.record(z.string(), Json).optional() })
export const ModelsLiveSchema = z.looseObject({ availability: CatalogAvailabilitySchema.optional(), provider: z.string().optional(), source: z.string().optional(), models: z.array(ModelEntrySchema), count: z.number().optional(), error: z.string().optional() })
export type Models = z.infer<typeof ModelsSchema>
/** TAL-603: where a card's credential comes from; `other` is a source the server cannot name, shown as its raw `key_source`. */
export const KeySourceKindSchema = z.enum(['env', 'oauth', 'config', 'pool', 'plugin', 'other'])
export type KeySourceKind = z.infer<typeof KeySourceKindSchema>
/**
 * `has_key` reports a credential; `configured` (TAL-570) is the row's setup status, which a keyless Ollama or LM Studio endpoint also meets.
 * TAL-603: `is_active` marks the active provider's card; `key_source_kind` is the key badge (`null` without a credential);
 * `models_total` is the catalog size, never below `models.length`. `is_active` and `key_source_kind` are absent from older servers.
 * TAL-641: `removable` marks a key Remove would clear: a built-in, not self-hosted, provider whose only key is its own profile `.env` variable.
 */
export const ProviderSchema = z.looseObject({
  id: z.string(), display_name: z.string().optional(), has_key: z.boolean().optional(), configured: z.boolean().optional(), configurable: z.boolean().optional(), is_oauth: z.boolean().optional(), is_plugin_provider: z.boolean().optional(), is_self_hosted: z.boolean().optional(),
  is_custom: z.boolean().optional(), key_source: z.string().optional(), base_url: NullableString.optional(), auth_error: NullableString.optional(), env_var: NullableString.optional(), models: z.array(ModelEntrySchema).optional(), models_total: z.number().optional(),
  nous_account: NousAccountSchema.nullable().optional(), nous_account_error: NullableString.optional(),
  is_active: z.boolean().optional(), key_source_kind: KeySourceKindSchema.nullable().optional(), removable: z.boolean().optional(),
})
export const ProvidersSchema = z.looseObject({ availability: CatalogAvailabilitySchema.optional(), providers: z.array(ProviderSchema), active_provider: NullableString.optional() })
/** TAL-411: the server's classification per colour basis; `/api/provider/quotas` only, at the profile's thresholds. */
export const QuotaUrgencySchema = z.looseObject({ remaining: QuotaLevelSchema, pace: QuotaLevelSchema.describe('Burn rate and pace tolerance; the remaining classification when the window has no pace.') })
/** TAL-409: a window's pace as of the envelope's `computed_at`. Stale once `valid_until` (the window's reset) passes. */
export const QuotaPaceSchema = z.looseObject({
  expected_remaining_percent: z.number(), pace_delta_percent: z.number(), burn_rate: z.number(), minutes_to_reset: z.number(),
  projected_minutes_to_empty: NullableNumber.describe('Minutes until the window empties at the current burn; null when nothing has been used.'),
  elapsed_minutes: z.number(), valid_until: z.string(),
  status: z.enum(['over', 'on', 'under']).optional().describe('TAL-411, `/api/provider/quotas` only: over when behind pace by at least the tolerance, under when more than 1 point ahead.'),
})
export const QuotaForecastSchema = z.looseObject({
  outcome: z.enum(['safe', 'warning']).describe('`warning` when the projection empties the window before it resets.'),
  budget_unit: z.enum(['hour', 'day']), budget_percent: NullableNumber.describe('Remaining percent per `budget_unit` until reset.'),
  depletion_margin_minutes: NullableNumber.describe('Projected empty minus reset, in minutes; negative empties early, null when no depletion is projected.'),
})
export const QuotaWindowSchema = z.looseObject({
  label: z.string().describe('The provider label; a generic "Session"/"Weekly" its provider duration contradicts names that duration instead (`24-hour`).'),
  used_percent: NullableNumber, remaining_percent: NullableNumber, reset_at: NullableString.describe('ISO-8601 UTC.'), detail: NullableString,
  window_seconds: NullableNumber.describe('The provider duration (`window_seconds`, else `limit_window_seconds`), which outranks the label; else 5h or weekly from the label; null when unknown.'),
  pace: QuotaPaceSchema.nullable().describe('Null for a window without a future reset, a usage value, or a 5h/weekly length.'),
  forecast: QuotaForecastSchema.nullable(),
  projection_eligible: z.boolean().optional().describe('TAL-411, `/api/provider/quotas` only: the burn-rate breakpoints apply (enough elapsed time and use, and the projection empties the window before reset).'),
  urgency: QuotaUrgencySchema.optional(),
})
const QuotaWindowIndex = z.number().int().nullable().optional()
export const QuotaSourceSchema = z.looseObject({
  plan_usage: PlanUsageSchema.nullable().optional(), plan_stale: z.boolean().optional(),
  computed_at: z.string().optional().describe('Original reference time of this source, retained with stale windows.'),
  source_id: z.string(), provider_id: z.string().optional(), provider_label: z.string().optional(), account_label: z.string().optional(), status: z.string().optional(), supported: z.boolean().optional(), message: z.string().nullable().optional(),
  is_active_provider: z.boolean().optional(), quota: Json.optional(), windows: z.array(QuotaWindowSchema).optional(), balances: Json.optional(), plan: Json.optional(), details: Json.optional(), unavailable_reason: Json.optional(), retry_after: Json.optional(), fetched_at: Json.optional(),
  pace_window_index: QuotaWindowIndex.describe('The window a pace-coloured widget shows: the weekly one, else the first 5h/session window.'),
  session_window_index: QuotaWindowIndex.describe('The session (else 5h) window.'), weekly_window_index: QuotaWindowIndex.describe('The weekly window.'),
  urgency: QuotaUrgencySchema.optional().describe('TAL-411: `remaining` of the first window, `pace` of the pace window; alerts and the source colour follow it.'),
})
/** An account-usage provider's normalised snapshot on `/api/provider/quota` (the same windows and indexes as a quotas source). */
export const QuotaAccountLimitsSchema = z.looseObject({
  plan_usage: PlanUsageSchema.nullable().optional(), plan_stale: z.boolean().optional(),
  available: z.boolean().optional(), stale: z.boolean().optional(), title: z.string().optional(), plan: Json.optional(), unavailable_reason: NullableString.optional(),
  windows: z.array(QuotaWindowSchema), details: Json.optional(), fetched_at: NullableString.describe('ISO-8601 UTC.'),
  pace_window_index: QuotaWindowIndex, session_window_index: QuotaWindowIndex, weekly_window_index: QuotaWindowIndex,
})
/** Python `get_provider_quota`: one provider's quota status. */
export const ProviderQuotaSchema = z.looseObject({
  computed_at: z.string().describe('ISO-8601 UTC reference time of every window `pace`.'),
  ok: z.boolean(), provider: NullableString, display_name: NullableString, supported: z.boolean(), status: z.string(), label: z.string().optional(), message: z.string(),
  quota: Json.describe('OpenRouter credits (`limit_remaining`, `usage`, `limit`), else null.'),
  account_limits: QuotaAccountLimitsSchema.nullable().optional(),
})
/** Python `get_provider_quotas`: the stable identity envelope the iOS quota widget persists (`scope_id`/`profile_id`). */
export const ProviderQuotasSchema = z.looseObject({ availability: CatalogAvailabilitySchema.optional(),
  version: z.number(), computed_at: z.string().describe('ISO-8601 UTC request reference time; coalesced or stale sources retain their own computed_at.'), scope_id: z.string(), profile_id: z.string(), active_provider: NullableString, requested_source_id: NullableString,
  missing_source: z.boolean().describe('True when `?source=` names a source id this scope no longer has; `sources` is then empty.'),
  sources: z.array(QuotaSourceSchema).describe('Each live source id exactly once, ordered by `provider_id`, then `account_label`, then `source_id`. Clients render this list as-is; a `?source=` read returns that one row.'),
})
/** One day of OpenRouter spend on `/api/provider/cost-history` (TAL-412). */
export const CostSnapshotSchema = z.looseObject({
  date: z.string().describe('UTC day, `YYYY-MM-DD`.'), used: NullableNumber.describe('Cumulative OpenRouter usage in USD that day.'),
  delta: NullableNumber.describe("Spend since the previous day; the day's `used` after a credit reset; null for the first day or a missing `used`."),
  bar_percent: z.number().describe('Bar height: `delta` as a percent of the window\'s largest delta, at least 2 for any positive delta, 0 for a null delta.'),
})
/** Python `get_provider_cost_history`: OpenRouter daily spend with the server-computed monthly pace and budget standing. */
export const ProviderCostHistorySchema = z.looseObject({
  ok: z.boolean(), provider: NullableString, display_name: z.string().optional(), supported: z.boolean().optional(), status: z.string().describe('`available`, `unavailable` (the snapshots are the last known data), `no_key`, `unsupported`, or `missing_provider`.'), message: z.string(),
  window_days: z.number().int().optional(), snapshots: z.array(CostSnapshotSchema).optional(), limit: NullableNumber.optional(), label: NullableString.optional(),
  monthly_budget: NullableNumber.optional().describe('Settings `provider_cost_budget`.'),
  monthly_pace: NullableNumber.optional().describe('Mean of the non-null deltas × 30, in USD rounded to cents; null without a delta.'),
  has_enough_data: z.boolean().optional().describe('At least one non-null delta (two daily snapshots).'),
  budget_percent: NullableNumber.optional().describe('round(pace / budget × 100); null without a positive pace and a budget.'),
  budget_level: z.enum(['ok', 'warn', 'over']).nullable().optional().describe('`warn` from 80%, `over` from 100%; null without `budget_percent`.'),
})
export type ProviderCostHistory = z.infer<typeof ProviderCostHistorySchema>
export const PersonalitiesSchema = z.looseObject({ personalities: z.array(z.looseObject({ name: z.string(), description: z.string().optional() })) })
export const AuxiliaryReasoningSchema = z.looseObject({
  saved: z.string().nullable().describe("The effort saved on the slot (`none` disables reasoning); null when none is saved and the slot inherits its default."),
  effective: z.string().nullable().describe("The effort the slot runs with; `''` is the default named by `default_source`; null when the Agent does not report it."),
  inherited: z.boolean().describe('No effort is saved, so the slot runs with its default.'),
  default_source: z.enum(['provider', 'parent']).describe("What the default is: the provider's (auxiliary tasks) or the parent agent's (delegation)."),
  options: z.array(z.string()).describe("Efforts the slot may save, in order (`none` last). Empty when `unavailable` is set."),
  unavailable: z.enum(['slot', 'model', 'agent']).nullable().describe("Why no effort can be saved: the slot ignores one, its route's model has no reasoning control, or the Agent did not say. Null when `options` apply."),
})
/** One auxiliary task slot in server order (TAL-388). The server owns ordering, normalization, and catalog matching. */
export const AuxiliaryTaskSchema = z.looseObject({
  task: z.string(), label: z.string(), description: z.string(),
  /** Saved provider (`auto` when unset) and bare model id. */
  provider: z.string(), model: z.string(),
  base_url: z.string().optional(), api_key_set: z.boolean().optional(),
  /** No override is saved: the task falls back to the main chat model. */
  is_auto: z.boolean(),
  /** Display of the model the task uses (the main chat model when `is_auto`): catalog label, else the saved model id, and its provider name. */
  value_label: z.string().nullable(), provider_label: z.string().nullable(),
  /** The `/api/models` entry id matching the saved provider/model pair; null for Auto or a model absent from the catalog. */
  selected_option_id: z.string().nullable(),
  /** False only for a pinned model the current catalog does not list; it stays visible and editable. */
  in_catalog: z.boolean(),
  /** TAL-800: the slot a plugin task inherits its route from; while the task is Auto, `value_label` names that slot's model. */
  inherit_from: z.string().nullable(),
  /** TAL-800: the reasoning effort the slot runs with (the Agent's default until one is saved; `''` = provider default); null when the Agent does not report its slots. */
  reasoning_effort: z.string().nullable(),
  /** TAL-1285: the slot's reasoning control, resolved by the server against the route the slot runs on (its pin, the slot it inherits, else the main model). */
  reasoning: AuxiliaryReasoningSchema,
})
export const AuxiliaryModelsSchema = z.looseObject({ delegation: DelegationSettingsSchema.optional(), main: z.looseObject({ model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional(), api_key_set: z.boolean().optional(), service_tier: z.enum(['', 'default', 'priority', 'ultrafast']).optional().describe('Empty string is the Standard value returned by older servers.'), supported_speed_tiers: z.array(SpeedTierSchema).optional() }), tasks: z.array(AuxiliaryTaskSchema) })
export const MaxTokensSchema = z.looseObject({ max_tokens: NullableNumber, max_tokens_effective: NullableNumber, max_tokens_fallback: NullableNumber })

// ── workspaces, files, git ───────────────────────────────────────────────

/** A registry entry; `name` is never empty (the folder name when none is registered, `Home` for `default`), so pickers show it as-is (TAL-303). */
export const WorkspaceEntrySchema = z.looseObject({ name: z.string().min(1), path: z.string() })
export type Workspace = z.infer<typeof WorkspaceEntrySchema>
export const WorkspacesSchema = z.looseObject({ workspaces: z.array(WorkspaceEntrySchema), last: NullableString.optional(), terminal_remote_backend: z.boolean().optional() })
export type Workspaces = z.infer<typeof WorkspacesSchema>
export const FileEntrySchema = z.looseObject({
  read_only: z.boolean().optional(), name: z.string(), path: z.string().optional(), is_dir: z.boolean().optional(), type: z.string().optional(), size: z.number().nullable().optional(), mtime: z.number().nullable().optional(), mtime_ns: z.union([z.number(), z.string()]).nullable().optional(),
  birthtime_ns: z.union([z.number(), z.string()]).nullable().optional(), hidden: z.boolean().optional(), workspace_sort_rank: z.number().int().optional(), target: z.string().optional(), target_outside_workspace: z.boolean().optional(),
})
export const FileSourceSchema = z.enum(['workspace', 'managed'])
const ManagedFileFields = { source: FileSourceSchema.optional(), read_only: z.boolean().optional(), write_semantics: z.literal('unconditional').optional() }
export const DirListingSchema = z.looseObject({ ...ManagedFileFields, unavailable: z.boolean().optional(), path: z.string().optional(), entries: z.array(FileEntrySchema), signature: z.string().optional(), workspace: z.string().optional(), workspace_recovered: z.boolean().optional(), is_git: z.boolean().optional() })
/** How a workspace file renders (TAL-566): media streams from `/api/file/raw`; text kinds carry `content`. */
export const FilePreviewKindSchema = z.enum(['text', 'markdown', 'csv', 'html', 'image', 'pdf', 'audio', 'video', 'binary'])
export type FilePreviewKind = z.infer<typeof FilePreviewKindSchema>
/** `table` is a `csv` preview's leading rows (header first); `table_truncated` says the file has more. `preview_url` is an
 * `html` preview's app-relative frame URL, under which the page's relative assets also resolve. */
export const FileContentSchema = z.looseObject({ ...ManagedFileFields, name: z.string().optional(),
  path: z.string().optional(), content: z.string().optional(), lines: z.number().optional(), size: z.number().optional(), truncated: z.boolean().optional(), binary: z.boolean().optional(), mime: z.string().optional(),
  preview: FilePreviewKindSchema.optional(), table: z.array(z.array(z.string())).optional(), table_truncated: z.boolean().optional(),
  preview_url: z.string().optional(),
})
const GitBadgeSchema = z.looseObject({ is_git: z.boolean().optional(), branch: NullableString.optional(), dirty: z.number().optional(), modified: z.number().optional(), untracked: z.number().optional(), ahead: z.number().optional(), behind: z.number().optional() })
export const GitInfoSchema = z.looseObject({ git: GitBadgeSchema.nullable().optional() })

// ── tools ────────────────────────────────────────────────────────────────

export const SkillSchema = z.looseObject({ ...SkillCatalogIdentitySchema.shape, name: z.string(), description: NullableString.optional(), category: NullableString.optional(), disabled: z.boolean().optional() })
export const SkillsSchema = z.looseObject({ skills: z.array(SkillSchema), categories: z.array(Json).optional() })
/**
 * `linked_files` groups the skill directory's files by folder (`references`, `templates`, ...); open one with `?file=`.
 * A linked file that is not UTF-8 text carries `binary: true` and its `size` instead of `content`.
 */
export const SkillContentSchema = z.looseObject({ editable: z.boolean().optional(), name: z.string().optional(), content: z.string().optional(), path: z.string().optional(), linked_files: z.record(z.string(), z.array(z.string())).optional(), binary: z.literal(true).optional(), size: z.number().optional(), success: z.boolean().optional(), message: z.string().optional(), ok: z.boolean().optional() })
export const SkillsUsageSchema = z.looseObject({ usage: z.record(z.string(), z.looseObject({ use_count: z.number().optional(), view_count: z.number().optional(), patch_count: z.number().optional() })), skill_names: z.array(z.string()).optional(), total_invocations: z.number().optional(), unique_skills_used: z.number().optional() })
export const MemorySchema = z.looseObject({
  memory: z.string(), user: z.string(), soul: z.string(), project_context: z.string().optional(), memory_path: z.string().optional(), user_path: z.string().optional(), soul_path: z.string().optional(), project_context_path: z.string().optional(),
  project_context_name: z.string().optional(), project_context_workspace: z.string().optional(), memory_mtime: NullableNumber.optional(), user_mtime: NullableNumber.optional(), soul_mtime: NullableNumber.optional(), project_context_mtime: NullableNumber.optional(),
  project_context_shadowed: z.array(Json).optional(), external_notes_enabled: z.boolean().optional(),
  /** TAL-784: the revision of each file as this read found it. A save sends the revision its edit started from. */
  memory_revision: z.string(), user_revision: z.string(), soul_revision: z.string(),
})
export type Memory = z.infer<typeof MemorySchema>
export const PromptSchema = z.looseObject({ id: z.string().optional(), name: z.string().optional(), title: z.string().optional(), label: z.string().optional(), text: z.string().optional(), content: z.string().optional(), created_at: z.number().optional() })
export const PromptsSchema = z.looseObject({ prompts: z.array(PromptSchema) })
/**
 * One slash command in the server's canonical catalog (TAL-314). `GET /api/commands` lists the client-handled commands
 * first, then the Agent registry, in display order; each name appears once. `handler` says who runs it, `clients` which
 * clients can run it, and `unsupported_message` is the English text a client outside `clients` shows when it is typed.
 * Clients suggest the entries listing them whose name or any alias starts with the typed text (case-insensitive), and
 * resolve a typed alias to the entry's `name`. `exec` marks an Agent entry `POST /api/commands/exec` runs: the client
 * posts the typed text there with the open chat's `session_id` and shows the returned output instead of starting a chat turn
 * (TAL-561); `/refine` reviews that chat (TAL-902).
 * `handler: 'prompt'` marks an Agent prompt built-in: the client sends the typed text as a chat turn and the server starts the
 * turn with the Agent's expansion of it (TAL-817).
 */
export const CommandClientSchema = z.enum(['web', 'ios'])
export const CommandRowSchema = z.looseObject({
  name: z.string(), description: z.string().optional(), aliases: z.array(z.string()), args_hint: z.string().optional(), category: z.string().optional(),
  handler: z.enum(['client', 'agent', 'prompt']), clients: z.array(CommandClientSchema), unsupported_message: z.string().optional(),
  cli_only: z.boolean().optional(), gateway_only: z.boolean().optional(), subcommands: z.array(Json).optional(), exec: z.boolean().optional(),
})
export const CommandsSchema = z.looseObject({ commands: z.array(CommandRowSchema) })
export type Command = z.infer<typeof CommandRowSchema>
export type CommandClient = z.infer<typeof CommandClientSchema>
export const LogsSchema = z.looseObject({ file: z.string(), tail: z.number().optional(), lines: z.array(z.string()), truncated: z.boolean().optional(), total_bytes: z.number().optional(), mtime: NullableNumber.optional(), hint: z.string().optional() })
export type Logs = z.infer<typeof LogsSchema>
export const InsightsSchema = z.looseObject({
  period_days: z.number().optional(), total_sessions: z.number().optional(), total_messages: z.number().optional(), total_tokens: z.number().optional(), total_input_tokens: z.number().optional(), total_output_tokens: z.number().optional(),
  total_cache_read_tokens: z.number().optional(), total_cache_hit_percent: NullableNumber.optional(), total_cost: z.number().optional(), activity_by_day: z.array(z.looseObject({ day: z.string(), sessions: z.number() })).optional(),
  activity_by_hour: z.array(z.looseObject({ hour: z.number(), sessions: z.number() })).optional(), daily_tokens: z.array(z.looseObject({ date: z.string(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional(), cost: z.number().optional(), sessions: z.number().optional() })).optional(),
  models: z.array(z.looseObject({ model: z.string().optional(), sessions: z.number().optional(), tokens: z.number().optional(), cost: z.number().optional() })).optional(),
})
export type Insights = z.infer<typeof InsightsSchema>
export const DashboardStatusSchema = z.looseObject({ running: z.boolean(), enabled: z.string().optional(), url: z.string().optional(), browser_url: z.string().optional(), host: z.string().optional(), port: z.number().int().optional(), version: z.string().optional(), error: z.string().optional() })
/**
 * Gateway status for the Settings banner (TAL-266). `running` and `configured` come from the Agent health probe; when it
 * is inconclusive, stale running metadata or known gateway sessions mark the gateway configured. `platforms` are the
 * messaging platforms of known gateway sessions; `last_active` is the gateway session index's ISO mtime while running, else "".
 * TAL-805: `gateway_mode` is the active profile's mode and decides `running` when it is not null. It is null for a remote
 * gateway, or for the root profile when the sidecar cannot answer; a named profile whose mode is unconfirmed reads `stopped`.
 */
/**
 * TAL-1627: whether Web's local `hermes gateway` CLI controls the Gateway it monitors, the one answer every lifecycle entry
 * point (Gateway Start/Stop/Restart, health restart, the post-update restart) and Settings read. `local_gateway` (managed):
 * no explicit Gateway URL, or a loopback URL whose endpoint a verified gateway of the active profile owns now or owned
 * before (Web's custody record). `external_gateway`: a non-loopback, malformed or foreign-held URL. `local_gateway_unproven`:
 * a loopback URL no gateway of this profile has been proven to serve. `unverified`: the ownership evidence could not be read.
 * `start_command` is the profile's exact one-time CLI start, sent only for a stopped unproven loopback Gateway.
 */
export const GatewayLifecycleSchema = z.object({
  managed: z.boolean(),
  reason: z.enum(['local_gateway', 'external_gateway', 'local_gateway_unproven', 'unverified']),
  start_command: NullableString,
})
export type GatewayLifecycle = z.infer<typeof GatewayLifecycleSchema>
/** TAL-1627: the 409 body of a lifecycle action refused because Web does not control the monitored Gateway; nothing ran. */
export const GatewayLifecycleRefusalSchema = z.object({ error: z.string(), ok: z.literal(false), code: z.literal('gateway_externally_managed'), action: z.enum(['start', 'stop', 'restart']), lifecycle: GatewayLifecycleSchema })
export const GatewayStatusSchema = z.object({
  running: z.boolean(), configured: z.boolean(), gateway_mode: GatewayModeSchema.nullable(), platforms: z.array(z.object({ name: z.string(), label: z.string() })), last_active: z.string(), session_count: z.number().int(),
  health: z.object({ state: NullableString, reason: NullableString, gateway_state: NullableString }),
  lifecycle: GatewayLifecycleSchema.describe('TAL-1627: whether Start/Stop/Restart may run; clients offer them only when `managed`.'),
})
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>
export const GatewayActionSchema = z.object({ ok: z.literal(true), action: z.enum(['start', 'stop', 'restart']), message: z.string(), status: GatewayStatusSchema })
export const DashboardConfigSchema = z.object({ enabled: z.enum(['auto', 'always', 'never']), url: z.string() })
/**
 * Project OS dashboard for a repo found from the last workspace or the `board`'s default workdir (TAL-266). Every field is
 * null or empty when the profile has no local workspace I/O or no repo is found. `onboarding.active` means the docs came
 * from the repo root's `PROJECT.md`/`PLAN.md`/`STATUS.md` instead of `docs/project-os/`.
 */
export const ProjectOsDashboardSchema = z.object({
  workspace: NullableString, repo_root: NullableString, selected_board_slug: NullableString.optional(), git: GitBadgeSchema.nullable(),
  docs: z.object({ project: FileContentSchema.nullable(), plan: FileContentSchema.nullable(), status: FileContentSchema.nullable(), blocker_resolver: FileContentSchema.nullable() }).partial(),
  handoff: z.record(z.string(), Json).nullable(), active: z.record(z.string(), Json).nullable(), heartbeat: z.record(z.string(), Json).nullable(),
  onboarding: z.looseObject({ active: z.boolean(), doc_source: z.enum(['project-os', 'root']) }).optional(), goal_summary: z.string(),
})
export type ProjectOsDashboard = z.infer<typeof ProjectOsDashboardSchema>
/** One server projection used by chat readiness, HTTP refusals, and persisted stream errors. */
export const AgentRuntimeMetadataSchema = z.object({
  agent_runtime_reason: z.enum(['update_active', 'recovery_incomplete', 'source_changed', 'unknown']).optional(),
  agent_update_state: z.string().optional(),
  retryable: z.boolean().optional(),
  restart_scheduled: z.boolean().optional(),
})
export type AgentRuntimeMetadata = z.infer<typeof AgentRuntimeMetadataSchema>
/** TAL-951: whether Web chat can run, from the Agent sidecar's status; `condition` says why not, null when available. */
export const ChatReadinessSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), condition: z.null() }),
  z.object({ available: z.literal(false), condition: z.enum(['sidecar_unavailable', 'agent_incompatible', 'agent_runtime_stale']), ...AgentRuntimeMetadataSchema.shape }),
])
export type ChatReadiness = z.infer<typeof ChatReadinessSchema>
/** Messaging-gateway liveness (`alive`, `details`, `gateway_chat`) for Settings → System, plus Web chat readiness in `chat`. */
export const AgentHealthSchema = z.looseObject({ chat: ChatReadinessSchema.optional().describe('Always sent since TAL-951; absent from older servers.'), gateway_lifecycle: GatewayLifecycleSchema.optional().describe('TAL-1627: whether the gateway restart may run; clients offer it only when `managed`. Absent from older servers.'), alive: z.boolean().nullable().optional(), checked_at: z.string().optional(), details: z.looseObject({ state: z.string().optional(), reason: z.string().optional() }).optional(), gateway_chat: z.looseObject({ enabled: z.boolean().optional(), backend: z.string().optional(), base_url_configured: z.boolean().optional(), api_key_configured: z.boolean().optional() }).optional(), error: z.string().optional() })
export const SystemHealthSchema = z.looseObject({
  available: z.boolean().optional(), status: z.string().optional(), checked_at: z.string().optional(), cpu: Json.nullable().optional(), memory: Json.nullable().optional(), disk: z.looseObject({ percent: z.number().optional(), total_bytes: z.number().optional(), used_bytes: z.number().optional() }).nullable().optional(),
  errors: z.array(z.looseObject({ code: z.string().optional(), metric: z.string().optional() })).optional(), webui_runtime: Json.optional(),
})
export const UpdateStateSchema = z.enum(['up_to_date', 'release_ready', 'commits_behind', 'local_changes', 'finish', 'manual', 'check_failed', 'off', 'unknown'])
export type UpdateState = z.infer<typeof UpdateStateSchema>
const AgentSupportSchema = z.enum(['supported', 'unchecked'])
export const UpdateVersionSchema = z.object({
  version: z.string().describe('The release as shown: the Agent tag or the Web release tag.'),
  ref: z.string().describe('What `updates.apply`/`updates.force` accept back as `version`: the Agent tag or the Web semver.'),
  sha: z.string().optional().describe('Agent only: the commit the tag peels to.'),
  release_url: z.string().nullable(),
  latest: z.boolean().describe('The channel\'s newest release, the one an update without `version` installs.'),
  folded: z.boolean().describe('Shown behind the folded "more versions" node: every entry except the newest.'),
  support: AgentSupportSchema.optional().describe('Agent only: this release\'s classification against the verified Agent window.'),
  support_label: z.string().optional().describe('Agent only: `support` worded to fit one phone line.'),
}).describe('TAL-946: one installable Stable release newer than the installed one.')
export type UpdateVersion = z.infer<typeof UpdateVersionSchema>
export const UpdateTargetSchema = z.looseObject({
  failed_update: z.object({ version: z.string(), restored_version: z.string() }).optional().describe('Web only: the update that failed before HTTP readiness and the restored package version. Manual retry remains available.'),
  name: z.string().optional(), channel: WebUpdateChannelSchema.optional(),
  unsupported: z.boolean().optional().describe('Deprecated (TAL-350): `support === \'unchecked\'`, kept for older clients.'),
  support: AgentSupportSchema.optional().describe('Agent target only (TAL-350): `supported` when the target revision is exactly a release in the verified Agent window, else `unchecked`; an `unchecked` apply requires `confirmed_agent_revision`.'),
  support_label: z.string().optional().describe('Agent target only (TAL-946): `support` worded to fit one phone line.'),
  current_support: AgentSupportSchema.optional().describe('Agent target only: the same classification for the installed Agent revision.'),
  supported_revision: z.string().optional(), supported_version: z.string().optional(), candidate_revision: z.string().optional(), behind: z.number().nullable().optional(), current_sha: z.string().nullable().optional(), latest_sha: z.string().nullable().optional(), compare_url: z.string().optional(), repo_url: z.string().optional(), error: z.string().optional(), ok: z.boolean().optional(), manual_update: z.boolean().optional(), no_git: z.boolean().optional(), install_kind: z.literal('npm').optional(), npm: z.string().optional(), channel_switch: z.boolean().optional(), dirty: z.boolean().optional(), metadata_repair: z.boolean().optional(), release_url: z.string().optional(), ignored: z.boolean().optional(), stale_check: z.boolean().optional(), current_version: z.string().optional(),
  state: UpdateStateSchema.describe('TAL-559: the status clients word; `off` when checks are disabled or Agent updates are ignored.'),
  can_apply: z.boolean().describe('The apply action is available for this target.'),
  installed_unverified: z.boolean().describe('`release_ready` only: the installed revision sits on no release tag.'),
  manual_link: z.boolean().describe('Show the manual-install (releases) link.'),
  target_version: z.string().nullable().describe('The version the update path leads to, when one is shown.'),
  summary_available: z.boolean().describe('TAL-759: offer "Summarize with AI" for this target (`release_ready` or `commits_behind`).'),
  versions: z.array(UpdateVersionSchema).describe('TAL-946: every installable Stable release newer than the installed one, newest first; empty unless `release_ready` can apply.'),
  folded_count: z.number().int().nonnegative().describe('How many `versions` are `folded`.'),
})
export const AgentRecoveryStateSchema = z.object({ phase: z.enum(['idle', 'running', 'waiting', 'complete', 'blocked']), attempt: z.number().int().nonnegative(), detail: z.string(), retry_at: z.string().nullable(), operation_id: z.uuid().optional(), operation: AgentUpdateOperationSchema.optional(), verified_revision: z.string().regex(/^[a-f0-9]{40}$/).optional(), runtime_revision: z.string().regex(/^[a-f0-9]{40}$/).optional(), verified_version: z.string().nullable().optional() })
export type AgentRecoveryState = z.infer<typeof AgentRecoveryStateSchema>
export const UpdatesCheckSchema = z.looseObject({ agent_recovery: AgentRecoveryStateSchema.optional(), disabled: z.boolean().optional(), cached: z.boolean().optional(), channel: z.string().optional(), agent_channel: z.enum(['stable', 'experimental']).optional(), checked_at: z.number().optional(), include_agent: z.boolean().optional(), webui: UpdateTargetSchema.nullable().optional(), agent: UpdateTargetSchema.nullable().optional() })
export const UpdatesSummarySchema = z.object({
  ok: z.boolean(), target: z.enum(['webui', 'agent']), summary: z.string(),
  current_version: z.string().nullable().describe('The installed version this summary starts from.'),
  target_version: z.string().nullable().describe('The version this summary leads to, when the update names one.'),
  summary_sections: z.array(z.object({ title: z.string(), items: z.array(z.string()) })).describe('Display-ready headed bullet lists; empty when nothing is pending.'),
  generated_by: z.enum(['llm', 'fallback', 'none']).describe('`fallback` when no model answered; `none` when the target has no pending update to summarize.'),
  source: z.enum(['release_notes', 'commits', 'none']).describe('Stable targets summarize the release notes they install; commit-tracking targets, or unreadable notes, use commit subjects.'),
  cached: z.boolean(),
})
export type UpdatesSummary = z.infer<typeof UpdatesSummarySchema>
export const UpdateApplySchema = z.looseObject({
  recovery_only: z.boolean().optional().describe('Only a retained transaction was repaired; the selected update outcome remains unverified.'),
  recovery_pending: z.boolean().optional().describe('The initiating operation remains active through automatic recovery; follow its notification_id without replaying the update.'),
  verified_revision: z.string().regex(/^[a-f0-9]{40}$/).optional(), verified_version: z.string().nullable().optional(),
  recovery_compatibility: z.object({ manual_execution: z.boolean(), bot_chat_delivery: z.boolean() }).optional()
    .describe('Whether the target Agent can reconcile retained manual execution and pending Bot Chat records. A false value blocks the update before any source or repair-intent change.'),
  ok: z.boolean().optional(), status: z.string().optional(), error: z.string().optional(), message: z.string().optional(), lock: Json.optional(), confirmation_required: z.boolean().optional(), refresh_confirmation: AgentRefreshConfirmationSchema.optional(), candidate_revision: z.string().optional(), supported_revision: z.string().optional(), supported_version: z.string().optional(), agent_channel: z.enum(['stable', 'experimental']).optional(), notification_id: z.uuid().optional(), channel_switch: z.boolean().optional(), backup_dir: z.string().nullable().optional(), backup_failed: z.boolean().optional(), stash_conflict: z.boolean().optional(), gateway_restart: z.string().optional().describe('TAL-953: `waiting_for_idle` when an Agent update left the gateway restart to wait for the gateway\'s running work; the update notification reports its outcome.') })
/** `verifying` (TAL-1138): the gateway restarted, and the server is checking that the new gateway process and the Agent runtime answer. */
export const UpdateNotificationPhaseSchema = z.enum(['applying', 'awaiting_confirmation', 'waiting_for_idle', 'restarting', 'verifying', 'recovering', 'succeeded', 'blocked', 'failed', 'unknown'])
export const UpdateNotificationActionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(80),
  style: z.enum(['default', 'primary', 'destructive']),
  acknowledges: z.boolean(),
})
export const UpdateNotificationDestinationSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_.-]*$/),
  label: z.string().min(1).max(80),
})
/** TAL-1138: one step of an update as its Updating dialog lists it; the server derives every label and state. */
export const UpdateStepSchema = z.object({
  id: z.enum(['install', 'web_restart', 'ready', 'gateway_wait', 'gateway_restart', 'agent_ready', 'recovery']),
  label: z.string().min(1).max(80),
  state: z.enum(['done', 'active', 'pending', 'failed']),
})
export const AgentUpdateRecoverySchema = z.object({
  operation: AgentUpdateOperationSchema, attempt_error: z.string().max(2000).nullable(), runtime_revision: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  rollback: z.boolean().nullable().optional(),
  outcome: z.enum(['recovering', 'target_installed', 'baseline_restored', 'other_revision', 'blocked', 'unknown']),
})
export const UpdateNotificationSchema = z.object({
  id: z.uuid(),
  kind: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  target: z.enum(['webui', 'agent']).nullable(),
  phase: z.union([UpdateNotificationPhaseSchema, z.string().min(1).max(64)]),
  severity: z.enum(['info', 'warning', 'critical']),
  persistent: z.boolean(),
  requires_acknowledgement: z.boolean(),
  actions: z.array(UpdateNotificationActionSchema).max(4),
  destination: UpdateNotificationDestinationSchema.nullable(),
  title: z.string(),
  message: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  read_at: z.iso.datetime().nullable(),
  acknowledged_at: z.iso.datetime().nullable(),
  acknowledged_action_id: z.string().nullable(),
  verified_revision: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  verified_version: z.string().min(1).max(80).nullable(),
  /** The apply's own explanation of a failed or blocked attempt, or of a success that needs attention (an Agent update that kept local edits in the git stash), line breaks kept; null otherwise. */
  detail: z.string().max(2000).nullable(),
  recovery: AgentUpdateRecoverySchema.optional(),
  unread: z.boolean(),
  active: z.boolean(),
  requires_interaction: z.boolean(),
  can_dismiss: z.boolean(),
  /** TAL-1138: the update's steps in order; empty for records that are not updates. */
  steps: z.array(UpdateStepSchema).max(8),
  /** TAL-1138: every client that sees this record opens its Updating dialog, which cannot be closed while this holds. */
  presents_dialog: z.boolean(),
  /** TAL-1138: how an open Updating dialog for this record closes: not at all, with Close, with Restart later (the wait goes on), or by itself after showing the outcome. */
  dialog_close: z.enum(['none', 'close', 'restart_later', 'auto']),
})
export const FrontendBuildIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const TabIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
/** Server comparison of the frontend build one Web tab loaded against the build the server now serves. */
export const FrontendBuildSchema = z.object({
  current_build: FrontendBuildIdSchema.nullable(),
  loaded_build: FrontendBuildIdSchema.nullable(),
  refresh_required: z.boolean(),
  notification_id: z.uuid().nullable(),
})
export const UpdateNotificationsSchema = z.object({
  scope_id: z.string().min(1).max(64),
  frontend_build: FrontendBuildSchema,
  notifications: z.array(UpdateNotificationSchema),
  /** Update operation the requesting tab most recently started or rejoined from Settings (even once dismissed); its Updating dialog follows this record. */
  tab_update: UpdateNotificationSchema.nullable(),
  /** When the requesting tab last started or rejoined `tab_update`; a rejoin changes only this. */
  tab_joined_at: z.iso.datetime().nullable(),
  unread_count: z.number().int().nonnegative(),
  clearable_count: z.number().int().nonnegative(),
  can_clear: z.boolean(),
})
export type UpdateNotification = z.infer<typeof UpdateNotificationSchema>
export type UpdateNotifications = z.infer<typeof UpdateNotificationsSchema>
/** TAL-806: a plugin setting as Settings shows it; `locked` marks a secret the server's launch environment supplies, so an edit would not take effect. */
export const PluginSettingViewSchema = PluginSettingFieldSchema.extend({ locked: z.boolean().optional() })
export type PluginSettingView = z.infer<typeof PluginSettingViewSchema>
/** TAL-1276: a plugin OAuth client as Settings shows it; `can_sign_out` is true while the profile stores a grant for it (any state but `logged_out`). */
export const PluginOAuthClientViewSchema = PluginOAuthClientSchema.extend({ can_sign_out: z.boolean() })
export type PluginOAuthClientView = z.infer<typeof PluginOAuthClientViewSchema>
export const PluginSchema = z.looseObject({ key: z.string(), name: z.string().optional(), kind: z.string().optional(), enabled: z.boolean().optional(), description: z.string().optional(), version: z.string().optional(), activation: z.string().optional(), is_active_provider: z.boolean().optional(), hooks: z.array(Json).optional(),
  /** Stored Agent check, absent when the installed Agent lacks cached update support. */
  update: z.object({ available: z.boolean(), latest_revision: z.string().optional() }).optional(),
  /** TAL-806: the manifest's `config_schema` fields with current values; absent when the plugin declares none. */
  settings: z.array(PluginSettingViewSchema).optional(),
  /**
   * TAL-1276: the OAuth clients the manifest declares (Agent v0.22.3+), each with its sign-in state and the two hosts the
   * sign-in sends the code to. Sign in through `/api/onboarding/oauth/start` with provider `plugin:<key>:<id>`; absent
   * when the plugin declares none or the Agent cannot sign in to plugin clients.
   */
  oauth_clients: z.array(PluginOAuthClientViewSchema).optional() })
/**
 * `read_only` (TAL-806): this session may not save plugin `settings` (not the server owner, or no sidecar).
 * `plugin_isolation_advisory` (TAL-820): more than one profile has third-party plugins installed and one of those runs them
 * `in_process`, so Settings recommends `plugins.isolation: host`; Talaria never sets the mode.
 */
export const PluginsSchema = z.looseObject({ plugins: z.array(PluginSchema), empty: z.boolean().optional(), read_only: z.boolean().optional(), supported_hooks: z.array(z.string()).optional(), unavailable: z.boolean().optional(), plugin_isolation_advisory: z.boolean().optional() })
export const McpServerSchema = z.looseObject({ cost_policy: McpCostPolicySchema.nullable().optional(), name: z.string(), id: z.string().optional(), transport: z.string().optional(), enabled: z.boolean().optional(), can_toggle: z.boolean().optional().describe('Whether PATCH can enable or disable this server; false for invalid config.'), active: z.boolean().optional(), status: z.string().optional(), tools: z.number().optional(), tool_count: z.number().int().nullable().optional(), health: z.string().optional(), health_detail: z.string().optional(), health_checked_at: Json.optional(), health_pending: z.boolean().optional() })
export const McpServersSchema = z.looseObject({ servers: z.array(McpServerSchema), health_pending: z.boolean().optional(), reload_required: z.boolean().optional(), toggle_supported: z.boolean().optional() })
/** TAL-818: one connected account of a Nous tool-gateway app; `name` is its alias, else the vendor label. `problem` is its gateway status while it is not active, else null. */
export const ConnectorAccountViewSchema = z.object({ connection_id: z.string(), name: z.string(), problem: z.enum(['pending', 'failed', 'expired', 'revoked', 'inactive']).nullable(), status_reason: z.string().nullable(), active: z.boolean(), created_at: z.string() })
/**
 * TAL-818: one app on the Connectors page. `accounts` are its live accounts, active first. `enabled`: Hermes may use it (the
 * member rule allows it and no other layer locks it). `org_locked` means an organization or role rule keeps it off whatever the member rule says. `rules_editable`: the switch
 * may change the member rule (readable rules and no lock). `tools_off` counts the tools the member rules turn off.
 */
export const ConnectorViewSchema = z.object({
  slug: z.string(), name: z.string(), description: z.string(), category: z.string(), logo_url: z.string().nullable(),
  connected: z.boolean(), accounts: z.array(ConnectorAccountViewSchema), enabled: z.boolean(), org_locked: z.boolean(), rules_editable: z.boolean(), tools_off: z.number().int(),
})
/**
 * TAL-818: the Connectors page. `available` is the Agent's connectors gate; false hides the page. `policy_revision` is the
 * member rules' revision every rule change sends back; null when the rules are read-only (no member layer, or unreadable),
 * so no switch changes them. `sign_in_required` offers Nous sign-in without creating a guest on reads.
 * `rules_error`: why the rules could not be read; every app then reads off (fails closed).
 */
export const ConnectorSignInOfferSchema = z.object({
  available: z.boolean(), due: z.boolean().describe('The native eligible due check at this read; an already delivered offer remains visible independently.'), visible: z.boolean(), offer_id: z.string().nullable(),
  actions: z.array(z.enum(['sign_in', 'dismiss'])), refresh_after: z.number().int().positive().nullable(),
})
export type ConnectorSignInOffer = z.infer<typeof ConnectorSignInOfferSchema>
export const ConnectorsPageSchema = z.object({ available: z.boolean(), sign_in_required: z.boolean().default(false), sign_in_offer: ConnectorSignInOfferSchema.optional(), connectors: z.array(ConnectorViewSchema), policy_revision: z.string().nullable(), rules_error: z.string().nullable() })
/**
 * TAL-818: one app's tools: `enabled`: Hermes may use it (the member rules leave it on and nothing locks it); `locked`: an
 * organization or role rule (by name or tag) keeps it off. `editable`: its switch may change the member rule (readable rules, the app on in them, and no lock).
 */
export const ConnectorToolsViewSchema = z.object({
  connector: z.string(), policy_revision: z.string().nullable(),
  tools: z.array(z.object({ slug: z.string(), name: z.string(), description: z.string(), facet: z.enum(['read', 'write', 'destructive', 'unclassified']), deprecated: z.boolean(), enabled: z.boolean(), locked: z.boolean(), editable: z.boolean() })),
})
/**
 * TAL-818: a connection operation, from the Connectors page's Connect or a chat's `manage_connections` card. Each target's
 * `connect_url` is the authorization link while it waits on one; `actions` are the moves the user may make on it now, and
 * `env_fields` the credentials an `approve` sends, each with its `label`. `can_continue`: the card may end the wait for the
 * rest (chat only). `outcome` is null while the operation is open, then `connected` when every target connected.
 */
export const ConnectorOperationViewSchema = z.object({
  op_id: z.string(), settled: z.boolean(), outcome: z.enum(['connected', 'not_connected']).nullable(), can_continue: z.boolean(), tool_call_id: z.string().nullable(),
  targets: z.array(z.object({
    name: z.string(), title: z.string(), kind: z.string(), state: z.enum(['pending', 'initiated', 'connected', 'skipped', 'failed', 'expired', 'not_connected']),
    detail: z.string(), connect_url: z.string().nullable(), actions: z.array(z.enum(['skip', 'retry', 'approve'])),
    env_fields: z.array(z.object({ name: z.string(), label: z.string(), required: z.boolean(), secret: z.boolean() })),
  })),
})
export type ConnectorsPage = z.infer<typeof ConnectorsPageSchema>
export type ConnectorView = z.infer<typeof ConnectorViewSchema>
export type ConnectorToolsView = z.infer<typeof ConnectorToolsViewSchema>
export type ConnectorOperationView = z.infer<typeof ConnectorOperationViewSchema>
export const McpToolsSchema = z.looseObject({ tools: z.array(z.looseObject({ name: z.string().optional(), server: z.string().optional(), description: z.string().optional() })), total: z.number().int().optional(), source: z.string().optional(), inventory_scope: z.string().optional(), unavailable_servers: z.array(z.string()).optional() })
export const NotesSourcesSchema = z.looseObject({ enabled: z.boolean().optional(), sources: z.array(Json).optional(), source: z.string().optional(), inventory_scope: z.string().optional(), recent_ai_notes: z.array(Json).optional(), attach_supported: z.boolean().optional(), automatic_recall_unchanged: z.boolean().optional() })
/** Joplin search hit: bounded, redacted display text and a snippet around the query; `updated_time` is Joplin's raw value. */
export const NoteSearchResultSchema = z.object({ id: z.string(), title: z.string(), snippet: z.string(), parent_id: z.string(), updated_time: Json, source: z.literal('joplin') })
export const NotesSearchSchema = z.object({ source: z.literal('joplin'), query: z.string(), results: z.array(NoteSearchResultSchema) })
/** One Joplin note for preview: `body` is cut at 50,000 characters (with a notice) and redacted. */
export const NoteItemSchema = z.object({ source: z.literal('joplin'), note: z.object({ id: z.string(), title: z.string(), body: z.string(), parent_id: z.string(), updated_time: Json, created_time: Json, source: z.literal('joplin') }) })
/** LLM wiki summary: counts and timestamps only, never page bodies or the wiki path. `error` names the exception type when `status` is `error`. */
export const WikiStatusSchema = z.object({
  available: z.boolean(), enabled: z.boolean(), status: z.enum(['missing', 'not_directory', 'ready', 'empty', 'error']), entry_count: z.number().int(), page_count: z.number().int(), raw_source_count: z.number().int(),
  last_updated: z.string().nullable(), last_writer: z.string(), path_configured: z.boolean(), path_source: z.string(), toggle_available: z.literal(false), toggle_reason: z.string(), docs_url: z.string(), error: z.string().optional(),
})
export const WikiBrowseSchema = z.object({ pages: z.array(z.object({ name: z.string(), path: z.string(), size: z.number().int(), mtime: z.number().int() })) })
export const WikiPageSchema = z.object({ content: z.string(), path: z.string() })


// ── onboarding ───────────────────────────────────────────────────────────

/** `oauth_flow` (TAL-398): `device_code` when the provider signs in through `/api/onboarding/oauth/*` instead of taking an API key; `oauth_label` then names the account to sign in with, and `signed_in` says whether the profile already holds its credential. */
export const OnboardingProviderSchema = z.looseObject({ id: z.string(), name: z.string().optional(), label: z.string().optional(), kind: z.string().optional(), oauth: z.boolean().optional(), needs_key: z.boolean().optional(), base_url: NullableString.optional(), models: z.array(Json).optional(), category: z.string().optional(), default_model: z.string().optional(), oauth_flow: z.literal('device_code').nullable().optional(), oauth_label: z.string().optional(), signed_in: z.boolean().optional() })
export const OnboardingStatusSchema = z.looseObject({
  completed: z.boolean(),
  settings: z.looseObject({ bot_name: z.string().optional(), default_model: z.string().optional(), default_workspace: NullableString.optional(), password_enabled: z.boolean().optional() }).optional(),
  setup: z.looseObject({ providers: z.array(OnboardingProviderSchema).optional(), categories: z.array(Json).optional(), current: z.looseObject({ provider: z.string().optional(), model: z.string().optional(), base_url: z.string().optional() }).optional(), current_is_oauth: z.boolean().optional(), unsupported_note: z.string().optional() }).optional(),
  system: z.looseObject({ hermes_found: z.boolean().optional(), imports_ok: z.boolean().optional(), chat_ready: z.boolean().optional(), provider_ready: z.boolean().optional(), provider_configured: z.boolean().optional(), setup_state: z.string().optional(), provider_note: z.string().optional(), provider_note_key: z.string().optional(), missing_modules: z.array(z.string()).optional(), import_errors: z.record(z.string(), z.string()).optional(), config_path: z.string().optional(), env_path: z.string().optional() }).optional(),
  workspaces: z.looseObject({ items: z.array(WorkspaceEntrySchema).optional(), last: NullableString.optional() }).optional(),
  models: ModelsSchema.optional(),
})
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>
export const OnboardingProbeSchema = z.looseObject({ ok: z.boolean().optional(), success: z.boolean().optional(), error: z.string().optional(), message: z.string().optional(), models: z.array(Json).optional() })
/**
 * One device-code sign-in (TAL-398). `status` is `pending` until the flow ends `approved`, `denied`, `expired`, `cancelled`
 * or `error`; `ok` is false for every ending without a credential, and `error` then carries the Agent's reason.
 * `user_code`, `verification_url`, `expires_in` and `interval` (seconds between polls) come with the start.
 */
export const OnboardingOAuthSchema = z.looseObject({
  nous_account: NousAccountSchema.nullable().optional(),
  ok: z.boolean().optional(), status: z.string().optional(), url: z.string().optional(), verification_url: z.string().optional(), user_code: z.string().optional(), message: z.string().optional(),
  error: z.string().nullable().optional(), flow_id: z.string().optional(), provider: z.string().optional(), expires_in: z.number().int().optional(), interval: z.number().int().optional(),
  /**
   * TAL-1276, a plugin client's browser sign-in (`plugin:<key>:<id>`, no `user_code`): `verification_url` is the
   * authorize link, `authorize_host` and `token_host` the hosts the code goes to, and `redirect_uri` the address the
   * browser is sent back to. When that address does not open on this machine, send the one the browser shows to
   * `/api/plugins/oauth/redirect`.
   */
  authorize_host: z.string().optional(), token_host: z.string().optional(), redirect_uri: z.string().optional(),
})

// ── automation ───────────────────────────────────────────────────────────

export const CronScheduleSchema = z.looseObject({ kind: z.string().optional(), expr: z.string().optional(), minutes: z.number().optional(), run_at: z.string().optional(), display: z.string().optional() })
export const CronRepeatSchema = z.looseObject({ times: NullableNumber.optional(), completed: z.number().optional() })
export const CronDerivedStateSchema = z.enum(['needs_attention', 'schedule_error', 'paused', 'off', 'error', 'active'])
export type CronDerivedState = z.infer<typeof CronDerivedStateSchema>
export const CronJobViewSchema = z.looseObject({
  read_only: z.boolean().optional(), owner_profile: NullableString.optional(), id: z.string().optional(), job_id: z.string().optional(), name: z.string().nullable().optional(), prompt: z.string().optional(), schedule: z.union([z.string(), CronScheduleSchema]).optional(),
  /** Server-filled (TAL-298): `schedule_display` is the schedule text clients show; `schedule_input` is the editor prefill the scheduler accepts back. */
  schedule_display: z.string(), schedule_input: z.string(), enabled: z.boolean().optional(), paused: z.boolean().optional(), paused_reason: NullableString.optional(), state: NullableString.optional(), last_status: NullableString.optional(), last_error: NullableString.optional(),
  last_delivery_error: NullableString.optional(), next_run_at: z.union([z.string(), z.number(), z.null()]).optional(), last_run_at: z.union([z.string(), z.number(), z.null()]).optional(), repeat: z.union([CronRepeatSchema, z.number(), z.null()]).optional(),
  status: z.string().optional(), last_run: Json.optional(), next_run: Json.optional(), profile: NullableString.optional(), session_id: NullableString.optional(), model: NullableString.optional(), provider: NullableString.optional(), model_option_id: NullableString.optional(), workspace: NullableString.optional(),
  workdir: NullableString.optional(), deliver: NullableString.optional(), skills: z.array(z.string()).optional(), no_agent: z.boolean().optional(), script: NullableString.optional(), monitor: NullableString.optional(), continuity: z.boolean().optional(),
  context_from: z.union([z.array(z.string()), z.string(), z.null()]).optional(), reasoning_effort: NullableString.optional(), toast_notifications: z.boolean().optional(), running: z.boolean().optional(),
  /** Server-derived (TAL-296): the job's status, whether it needs attention, and whether its primary action is Resume. Live runs overlay it. */
  derived_state: CronDerivedStateSchema.optional(), needs_attention: z.boolean().optional(), resumable: z.boolean().optional(),
  /** Server-derived (TAL-599): a known cause clients explain in the needs-attention banner. */
  attention_hint: z.enum(['croniter_missing']).nullable(),
  /** Server-normalized (TAL-810): the job's latest failed run, kept after later successes; `at` is epoch seconds, null when unparseable. */
  last_failure: z.object({ at: z.number().nullable(), detail: z.string() }).nullable(),
})
export type CronJob = z.infer<typeof CronJobViewSchema>
/** TAL-810: a listed profile's cron store whose writes fail (full disk, read-only mount, permissions), so its scheduler skips every run. `error` and `fix` are the Agent's text; `since` is the last write that landed (epoch seconds), null when unknown. */
export const CronStoreHealthSchema = z.object({ profile: z.string(), store: z.string(), error: z.string(), fix: z.string(), since: z.number().nullable() })
export type CronStoreHealth = z.infer<typeof CronStoreHealthSchema>
export const CronsSchema = z.looseObject({
  jobs: z.array(CronJobViewSchema),
  /** TAL-601: `jobs` arrive in display order (running first, then soonest next run, none last, then name); clients keep it. Absent from older servers. */
  ordered: z.boolean().optional(),
  active_profile: z.string().optional(), all_profiles: z.boolean().optional(), other_profile_count: z.number().optional(), cron_unavailable: z.boolean().optional(),
  unwritable_stores: z.array(CronStoreHealthSchema),
})
export type Crons = z.infer<typeof CronsSchema>
export const CronContextSourcesSchema = z.object({ profile: z.string(), sources: z.array(z.object({ job_id: z.string(), label: z.string(), selectable: z.boolean() })) })
export type CronContextSources = z.infer<typeof CronContextSourcesSchema>
/** `GET /api/crons/recent` row: one job's latest completion, ordered and classified by the server. */
export const CronRecentCompletionSchema = z.object({
  job_id: z.string(), name: z.string().nullable(), status: z.string().nullable(), outcome: z.enum(['succeeded', 'failed', 'unknown']), completed_at: z.number(),
  toast_notifications: z.boolean(), session_id: z.string(), message_count: z.number().int().optional(),
})
export type CronRecentCompletion = z.infer<typeof CronRecentCompletionSchema>
export const CronRecentSchema = z.object({ completions: z.array(CronRecentCompletionSchema), since: z.number() })
export const CronMutationSchema = z.looseObject({ ok: z.boolean().optional(), job: CronJobViewSchema.optional(), job_id: z.string().optional(), status: z.string().optional(), error: z.string().optional(), elapsed: z.number().optional() })
export const CronRunUsageSchema = z.looseObject({ input_tokens: NullableNumber.optional(), output_tokens: NullableNumber.optional(), total_tokens: NullableNumber.optional(), estimated_cost_usd: NullableNumber.optional(), duration_seconds: NullableNumber.optional(), model: z.string().optional(), provider: z.string().optional() })
export const CronRunSummarySchema = z.looseObject({ filename: z.string(), size: z.number(), modified: z.number(), usage: CronRunUsageSchema.optional() })
export const CronHistorySchema = z.looseObject({ job_id: z.string().optional(), runs: z.array(CronRunSummarySchema), total: z.number().optional(), offset: z.number().optional() })
export type CronHistory = z.infer<typeof CronHistorySchema>
/** `response` is server-extracted (TAL-599): the agent's reply after the run file's `## Response` heading, else the whole text. */
export const CronRunSchema = z.looseObject({ content: z.string().optional(), snippet: z.string().optional(), response: z.string().optional(), usage: CronRunUsageSchema.optional(), error: z.string().optional() })
export const CronStatusSchema = z.looseObject({ running: z.union([z.boolean(), z.record(z.string(), z.number())]).optional() })
/** Card actions the server offers for a task's current status (TAL-557); clients show exactly these. `move_to` lists the statuses a Move may target, in display order. */
export const KanbanTaskActionsSchema = z.object({ block: z.boolean(), unblock: z.boolean(), complete: z.boolean(), archive: z.boolean(), move_to: z.array(z.string()) })
/** Server-computed card policy on every task the Kanban routes return (TAL-557). `requires_running_exit_confirmation`: any action takes the task out of a live run, so clients confirm first. */
export const KanbanTaskPolicyShape = { available_actions: KanbanTaskActionsSchema, requires_running_exit_confirmation: z.boolean() }
export const KanbanTaskViewSchema = z.looseObject({ id: z.union([z.string(), z.number()]), title: z.string().optional(), status: z.string().optional(), assignee: NullableString.optional(), priority: z.union([z.string(), z.number()]).nullable().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), session_id: NullableString.optional(), archived: z.boolean().optional(), created_at: Json.optional(), updated_at: Json.optional(), ...KanbanTaskPolicyShape })
/** A board column in the Agent workflow's order (TAL-796): `name` is the status key, `label` the Agent's English label. */
export const KanbanColumnSchema = z.looseObject({ name: z.string(), label: z.string(), tasks: z.array(KanbanTaskViewSchema) })
/** One bounded profile-scoped read shared by timeline and relationship layouts. Null timing means unknown, never planned effort. */
export const KanbanInspectionSchema = KanbanInspectionSnapshotSchema.extend({
  nodes: z.array(KanbanInspectionNodeSchema.extend({ task: KanbanTaskViewSchema,
    ancestors: z.array(z.string()), descendants: z.array(z.string()), cycle: z.boolean(), running_lineage: z.boolean(),
    timing: z.object({ start: z.number().nullable(), end: z.number().nullable(), duration_seconds: z.number().nullable(), offset: z.number().nullable(), width: z.number().nullable() }),
  })).max(500),
  window: z.object({ start: z.number().nullable(), end: z.number().nullable() }),
})
/** One profile lane (TAL-567): an assignee's tasks (`null` = unassigned) across every board column, with its task count. */
export const KanbanLaneSchema = z.object({ assignee: z.string().nullable(), count: z.number().int(), columns: z.array(KanbanColumnSchema) })
export const KanbanBoardViewSchema = z.looseObject({ columns: z.array(KanbanColumnSchema).optional(), assignees: z.array(Json).optional(), filters: Json.optional(), latest_event_id: z.number().optional(), read_only: z.boolean().optional(), tenants: z.array(Json).optional(), changed: z.boolean().optional(),
  /** Statuses a bulk status change may target (TAL-557). */
  bulk_move_targets: z.array(z.string()),
  /** Statuses a new task may start in (TAL-796). */
  create_statuses: z.array(z.string()),
  /** The saved board view (TAL-567): `true` groups the board into `lanes` by assignee. */
  lane_by_profile: z.boolean(),
  /** Present when `lane_by_profile`: the columns split into profile lanes, assignees in name order, unassigned last. */
  lanes: z.array(KanbanLaneSchema).optional() })
export const KanbanBoardsViewSchema = z.looseObject({ boards: z.array(z.looseObject({ slug: z.string(), name: z.string().nullable().optional(), is_current: z.boolean().optional(), total: z.number().optional(), archived: z.boolean().optional(), color: z.string().optional(), icon: z.string().optional(), description: z.string().optional(),
  /** Whether the board can be archived or deleted; the default board (TAL-567) and an archived board (TAL-795) cannot. */
  removable: z.boolean() })), current: z.string().optional(), read_only: z.boolean().optional() })
/** Board-wide task counts (TAL-567): `status_counts` in board-column order, unknown statuses after; `total` excludes archived tasks. */
export const KanbanStatsViewSchema = z.looseObject({ by_status: z.record(z.string(), z.number()), total: z.number().int(), status_counts: z.array(z.object({ status: z.string(), count: z.number().int() })) })
export const ExtensionStatusSchema = z.looseObject({
  enabled: z.boolean(), extension_dir_configured: z.boolean().optional(), extension_dir_valid: z.boolean().optional(), script_urls: z.array(z.string()).optional(), stylesheet_urls: z.array(z.string()).optional(), sidecars: z.array(Json).optional(),
  extensions: z.array(z.looseObject({ id: z.string(), enabled: z.boolean().optional(), name: z.string().optional(), version: z.string().optional() })).optional(), warnings: z.array(Json).optional(),
  manifest: z.looseObject({ configured: z.boolean().optional(), loaded: z.boolean().optional(), status: z.string().optional(), entry_count: z.number().optional() }).optional(), counts: z.record(z.string(), z.number()).optional(), gallery_installed: z.record(z.string(), Json).optional(),
})
