/**
 * Pinned response shapes shared by every consumer (formerly the frontend's
 * hand-written `src/contracts/*` schemas). Known fields are typed; every
 * object keeps a catchall because sidecar rows carry operator-defined extras
 * that must survive a round trip (documented passthrough).
 */
import { z } from 'zod'

const Json = z.unknown()
export const NullableString = z.string().nullable()
export const NullableNumber = z.number().nullable()
/** Unix seconds as the server emits them (float). */
export const UnixSeconds = z.number()

// ── sessions ─────────────────────────────────────────────────────────────

export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'invalid session id')
export type SessionId = z.infer<typeof SessionIdSchema>

export const AttachmentSchema = z.looseObject({
  filename: z.string().optional(), name: z.string().optional(), path: z.string().optional(), size: z.number().optional(), mime: z.string().optional(), is_image: z.boolean().optional(), rollback_token: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

/** The server's display class for a tool call: clients map it to an icon and localized verb, and never classify names themselves. */
export const ToolKindSchema = z.enum(['shell', 'read', 'list', 'search', 'web', 'write', 'skill', 'memory', 'delegate', 'unknown'])
export type ToolKind = z.infer<typeof ToolKindSchema>
/**
 * TAL-448: a completed file-edit call's change, from its result's unified diff: `added` / `removed` count the whole diff's
 * lines (file headers excluded); `diff` is the redacted diff, capped at 400 lines, with `truncated` when cut. Absent on a
 * call whose result has no diff.
 */
export const ToolEditDiffSchema = z.object({ added: z.number().int(), removed: z.number().int(), diff: z.string(), truncated: z.boolean() })
export type ToolEditDiff = z.infer<typeof ToolEditDiffSchema>
/** Server-derived display fields every tool call carries: the kind, and the redacted first-line label of its main argument (`''` when none; omitted on a live frame with none, which keeps its start frame's target), and a file edit's `edit_diff`. */
export const ToolDisplayFields = { kind: ToolKindSchema.optional(), target: z.string().optional(), edit_diff: ToolEditDiffSchema.optional() }

/**
 * TAL-315: a tool result's display sections, decided by the server's one rule for live, replayed and persisted results
 * alike. Clients show `stdout`, `stderr`, a labelled `error` and a labelled `exit_code` (sent only when worth showing), or
 * `text`, in that order, and never parse result text. Each string is capped server-side; a client without the field
 * shows `preview`.
 */
export const ToolResultViewSchema = z.object({ text: z.string().optional(), stdout: z.string().optional(), stderr: z.string().optional(), error: z.string().optional(), exit_code: z.number().int().optional() })
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
  /** TAL-456: a settled final answer too long to lay out whole; clients render it collapsed, with a local "Show more". */
  final_answer_excerpt: z.string().optional(), turn_duration: z.number().nullable().optional(),
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

/** TAL-460: one finished background item (see `_background_update.lines`). */
export const BackgroundLineSchema = z.object({ kind: z.enum(['agent', 'command', 'other']), status: z.enum(['completed', 'failed', 'notice']), label: z.string(), exit_code: z.number().int().nullable().optional() })
export type BackgroundLine = z.infer<typeof BackgroundLineSchema>

export const MessageSchema = z.looseObject({
  role: z.string(), content: MessageContentSchema.optional(), id: MessageIdSchema.optional(), message_id: MessageIdSchema.optional(), timestamp: z.number().nullable().optional(),
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
  /** The running turn's prompt, which the turn's settlement replaces with its persisted row. */
  _active_turn_user: z.boolean().optional(),
  /** A consumed steer at its causal place in the turn: display-only, never model history. A steer only the Agent recorded has no timing. */
  _steer: z.looseObject({ steer_id: z.string(), submitted_at: z.number().nullable().optional(), consumed_at: z.number().optional(), phase_duration: z.number().optional() }).optional(),
  /** On a steered turn's last reply: seconds from the last consumed steer to the turn's end. */
  _final_phase_duration: z.number().optional(),
  /** A settled body too long to lay out whole: clients render `_display_excerpt` collapsed, with a local "Show more" for `content`. */
  _display_truncated: z.boolean().optional(),
  _display_excerpt: z.string().optional(),
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
     * TAL-460: one completion line per finished item, shown in place of the row. Clients localize the wording per
     * `kind` and `status`: an agent by its goal (`completed` / `failed`), a command (`finished` / `failed` with
     * `exit_code`), or `label` as written for any other notice. `content` stays available in full on expansion.
     */
    lines: z.array(BackgroundLineSchema),
  }).optional(),
  /**
   * TAL-305: a marker the Agent wrote around context compaction, not a message anyone typed. Clients render a collapsed
   * card with a localized title per kind and the body on expansion: `_marker_body` when sent, else `content`.
   */
  _marker_kind: z.enum(['context_compaction', 'preserved_task_list']).optional(),
  /** TAL-305: a preserved task list's card body, without its marker line. */
  _marker_body: z.string().optional(),
  /** TAL-460: part of the Agent's reply to the background update just before it in the same turn. */
  _background_reply: z.boolean().optional(),
  /** TAL-460: that reply is only a silence marker; clients show the update's lines and nothing of this turn's reply. */
  _background_silent: z.boolean().optional(),
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
const ReadOnlySchema = z.boolean().describe('The session cannot be modified from Web: a read-only import, a view-only subagent child, or a foreign session whose owner refuses claiming.')
const CanBranchSchema = z.boolean().describe('Web may branch this session: never a subagent child, and a read-only session only when it is a cron run.')
const CanPinSchema = z.boolean().describe('Web may pin or unpin this session: never a subagent child.')
const CanArchiveSchema = z.boolean().describe('Web may archive or unarchive this session: never a subagent child.')
const CanDeleteSchema = z.boolean().describe('Web may delete this session: never a read-only session (a read-only import, a view-only subagent child, or a foreign session whose owner refuses claiming).')
const CanDuplicateSchema = z.boolean().describe('Web may duplicate this session: it has a WebUI copy and is not a subagent child.')
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

/** Full session record from `GET /api/session` and mutations returning `session`. */
export const SessionSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string(), workspace: z.string().optional(), created_workspace: z.string().nullable().optional(), model: NullableString.optional(), model_provider: NullableString.optional(),
  model_option_id: NullableString.optional().describe('TAL-301: the catalog entry id the stored model/provider selects; null when none.'),
  messages: z.array(MessageSchema).optional(), tool_calls: z.array(ToolCallSchema).optional(), created_at: UnixSeconds.optional(), updated_at: UnixSeconds.optional(), last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(), user_message_count: z.number().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: NullableString.optional(), profile: NullableString.optional(),
  personality: NullableString.optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional(), cache_write_tokens: z.number().optional(),
  cache_hit_percent: NullableNumber.optional(), estimated_cost: NullableNumber.optional(), active_stream_id: ActiveStreamIdSchema, is_streaming: IsStreamingSchema, active_turn_origin: ActiveTurnOriginSchema, pending_steers: z.array(PendingSteerSchema).optional().describe('TAL-424: the active stream\'s pending steers, oldest first.'), has_pending_user_message: z.boolean().optional(),
  pending_user_message: NullableString.optional(), pending_attachments: z.array(AttachmentSchema).optional(), pending_started_at: NullableNumber.optional(), pending_user_source: NullableString.optional(),
  context_length: NullableNumber.optional(), threshold_tokens: NullableNumber.optional(), last_prompt_tokens: NullableNumber.optional(), post_compression_context_tokens_estimate: NullableNumber.optional(), ...ContextUsageFields,
  enabled_toolsets: z.array(z.string()).nullable().optional(), composer_draft: ComposerDraftSchema.optional(), is_cli_session: z.boolean().optional(), source_kind: SourceKindSchema, is_messaging_session: IsMessagingSessionSchema, sort_ts: SortTsSchema, read_only: ReadOnlySchema, can_branch: CanBranchSchema, can_pin: CanPinSchema, can_archive: CanArchiveSchema, can_delete: CanDeleteSchema, can_duplicate: CanDuplicateSchema, source_tag: NullableString.optional(),
  source_label: NullableString.optional(), session_source: NullableString.optional(), raw_source: NullableString.optional(), parent_session_id: NullableString.optional(), worktree_path: NullableString.optional(),
  worktree_branch: NullableString.optional(), worktree_repo_root: NullableString.optional(), share_token: NullableString.optional(), share_created_at: NullableNumber.optional(), manual_title: z.boolean().optional(),
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
})
export type Session = z.infer<typeof SessionSchema>
export const SessionEnvelopeSchema = z.looseObject({ session: SessionSchema })

/** Sidebar row from `GET /api/sessions`. */
export const SessionRowSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string(), workspace: z.string().optional(), model: NullableString.optional(), created_at: UnixSeconds.optional(), updated_at: UnixSeconds.optional(), last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: NullableString.optional(), profile: NullableString.optional(), is_streaming: IsStreamingSchema,
  is_cli_session: z.boolean().optional(), source_kind: SourceKindSchema, is_messaging_session: IsMessagingSessionSchema, sort_ts: SortTsSchema, cron_running: z.boolean().optional(), read_only: ReadOnlySchema, can_branch: CanBranchSchema, can_pin: CanPinSchema, can_archive: CanArchiveSchema, can_delete: CanDeleteSchema, can_duplicate: CanDuplicateSchema, attention: z.looseObject({ kind: z.string().optional(), count: z.number().optional() }).nullable().optional(),
  source_tag: NullableString.optional(), source_label: NullableString.optional(), session_source: NullableString.optional(), raw_source: NullableString.optional(), parent_session_id: NullableString.optional(),
  active_stream_id: ActiveStreamIdSchema, share_token: NullableString.optional(), worktree_branch: NullableString.optional(), match_type: z.enum(['title', 'metadata', 'content']).optional(), match_preview: NullableString.optional(),
  workspace_name: WorkspaceNameSchema,
  ...ContextUsageFields,
})
export type SessionRow = z.infer<typeof SessionRowSchema>

export const SessionsListSchema = z.looseObject({
  sessions: z.array(SessionRowSchema).describe('Canonical display order (TAL-306): pinned first, then active (streaming or a pending prompt), then newest `sort_ts`, then `session_id`. Clients keep it.'), sidebar_reference_sessions: z.array(SessionRowSchema), server_time: z.number(), server_tz: z.string(), active_profile: z.string(), all_profiles: z.boolean(), include_archived: z.boolean(),
  archived_count: z.number().int(), archived_webui_count: z.number().int(), archived_cli_count: z.number().int(), other_profile_count: z.number().int(), cli_count: z.number().int(), webui_session_count: z.number().int(),
  cli_session_count: z.number().int(),
  // TAL-482: sidebar counts for the "Scheduled sessions" / "Webhook sessions" groups; `_truncated` means more exist than are listed.
  scheduled_session_count: z.number().int().nonnegative(), scheduled_sessions_truncated: z.boolean(),
  webhook_session_count: z.number().int().nonnegative(), webhook_sessions_truncated: z.boolean(),
  archived_limit: z.number().int().nullable().optional(), archived_offset: z.number().int().optional(),
})
export type SessionsList = z.infer<typeof SessionsListSchema>

export const SessionStatusSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string().optional(), active_stream_id: ActiveStreamIdSchema, active_turn_origin: ActiveTurnOriginSchema, agent_running: IsStreamingSchema, is_streaming: IsStreamingSchema, read_only: ReadOnlySchema, message_count: z.number().optional(), model: NullableString.optional(),
  profile: NullableString.optional(), workspace: z.string().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(), estimated_cost: NullableNumber.optional(), updated_at: UnixSeconds.optional(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export const SessionUsageSchema = z.looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(), estimated_cost: NullableNumber.optional(), model: NullableString.optional() })

export const ProjectSchema = z.looseObject({ project_id: z.string(), name: z.string(), color: z.string().nullable().optional(), profile: NullableString.optional(), created_at: z.number().optional() })
export const ProjectsSchema = z.looseObject({ projects: z.array(ProjectSchema), active_profile: z.string(), all_profiles: z.boolean(), other_profile_count: z.number().int() })
export const SessionDeleteResultSchema = z.looseObject({ ok: z.literal(true), state_db_cleanup_failed: z.boolean().optional() })

// ── chat ─────────────────────────────────────────────────────────────────

export const ChatStartRequestSchema = z.looseObject({
  session_id: SessionIdSchema, message: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), workspace: z.string().nullable().optional(), profile: z.string().nullable().optional(),
  explicit_model_pick: z.boolean().optional(), attachments: z.array(z.union([AttachmentSchema, z.string()])).optional(), moa_config: z.boolean().optional(), regenerate: z.boolean().optional(), regeneration_revision: z.string().optional(),
})
export type ChatStartRequest = z.infer<typeof ChatStartRequestSchema>
/** Accepted turn. `stream_id` is the owner identity for the SSE connection. */
export const ChatStartResponseSchema = z.looseObject({
  stream_id: z.string().optional(), session_id: SessionIdSchema.optional(), turn_id: z.string().optional(), user_message_id: z.union([z.string(), z.number()]).nullable().optional(), pending_started_at: z.number().nullable().optional(),
  title: z.string().optional(), effective_model: z.string().optional(), effective_model_provider: z.string().optional(), queued: z.boolean().optional(), ok: z.boolean().optional(), status: z.string().optional(), reason: z.string().optional(), session: SessionSchema.optional(),
})
export type ChatStartResponse = z.infer<typeof ChatStartResponseSchema>
export const StreamStatusSchema = z.looseObject({ active: z.boolean(), stream_id: z.string(), replay_available: z.boolean().optional(), journal: Json.optional() })
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
export const CancelResponseSchema = z.looseObject({ ok: z.boolean(), cancelled: z.boolean(), stream_id: z.string().optional(), withdrawn_steers: z.array(SteerWithdrawnSchema).optional(), error: z.string().optional() })
export const SteerWithdrawRequestSchema = z.object({ session_id: SessionIdSchema, steer_id: z.string().min(1), reason: z.enum(['edit', 'cancel']) })
export type SteerWithdrawRequest = z.infer<typeof SteerWithdrawRequestSchema>
/** `withdrawn: false` when the steer is unknown, already taken by the Agent (it then settles as consumed), or being sent. */
export const SteerWithdrawResponseSchema = z.object({ withdrawn: z.boolean(), text: z.string().optional() })
export const SteerSendNowRequestSchema = z.object({ session_id: SessionIdSchema, steer_id: z.string().min(1) })
/** `redirected: false` when nothing is live to deliver it to now; the steer stays pending. */
export const SteerSendNowResponseSchema = z.object({ redirected: z.boolean() })

/** `text` is delivered to the running agent; `display_text` is what the transcript shows. */
export const SteerRequestSchema = z.looseObject({ session_id: SessionIdSchema, text: z.string().min(1), display_text: z.string().optional(), steer_id: z.string().optional() })
/** `accepted: false` with a `fallback` reason means the message was not delivered; the caller keeps the draft. */
/** TAL-460: a steer sent while a background turn runs starts the user's own turn instead; `started_turn` is its start response. */
export const SteerResponseSchema = z.looseObject({ accepted: z.boolean(), fallback: NullableString.optional(), stream_id: NullableString.optional(), steer_id: z.string().optional(), started_turn: ChatStartResponseSchema.optional() })

export const ApprovalPendingSchema = z.looseObject({
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
export const ClarifyStepSchema = z.looseObject({ qid: z.string(), question: z.string(), choices: z.array(z.string()), multi_select: z.boolean() })
export type ClarifyStep = z.infer<typeof ClarifyStepSchema>
/** Keyed step answers; a multi-select step takes a list. The server shapes them into the Agent's reply. */
export const ClarifyAnswersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
export type ClarifyAnswers = z.infer<typeof ClarifyAnswersSchema>
export const ClarifyPendingSchema = z.looseObject({
  steps: z.array(ClarifyStepSchema).optional(),
  clarify_id: z.string().optional(), session_id: z.string().optional(), question: z.string().optional(), description: z.string().optional(), choices: z.array(ClarifyChoiceSchema).optional(), title: z.string().optional(),
  name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), status: z.string().optional(), raw_preview: z.string().optional(), timeout_at: z.number().optional(),
  timeout_seconds: z.number().optional(), pending_count: z.number().optional(), index: z.number().optional(), total: z.number().optional(),
})
export type ClarifyPending = z.infer<typeof ClarifyPendingSchema>
export const ClarifyPendingEnvelopeSchema = z.looseObject({ pending: ClarifyPendingSchema.nullable(), pending_count: z.number().int() })
export const ClarifyRespondRequestSchema = z.looseObject({ session_id: SessionIdSchema, answers: ClarifyAnswersSchema.optional(), response: z.string().optional(), answer: z.string().optional(), choice: z.string().optional(), clarify_id: z.string().optional() })
export const ClarifyRespondResponseSchema = z.looseObject({ ok: z.boolean(), response: z.string().optional(), error: z.string().optional(), stale: z.boolean().optional() })

export const DraftSchema = z.looseObject({ text: z.string(), files: z.array(Json) })
export const DraftResponseSchema = z.looseObject({ ok: z.literal(true), draft: DraftSchema, draft_version: z.string().nullable(), unchanged: z.boolean().optional() })
/** At most this many attachments ride one chat message; the server names each in the prompt (TAL-276, TAL-635). */
export const MAX_CHAT_ATTACHMENTS = 20
export const UploadResponseSchema = z.looseObject({ filename: z.string(), path: z.string(), size: z.number(), mime: z.string(), is_image: z.boolean().optional(), rollback_token: z.string().optional(), named_in_prompt: z.boolean().optional(), max_attachments_per_message: z.number().int().positive().optional() })
export type UploadResponse = z.infer<typeof UploadResponseSchema>
export const GoalViewSchema = z.looseObject({ text: z.string().optional(), state: z.string().optional(), status: z.string().optional(), turns: z.number().optional(), max_turns: z.number().optional(), reason: z.string().optional() })
export const GoalResponseSchema = z.looseObject({ ok: z.boolean().optional(), action: z.string().optional(), goal: GoalViewSchema.nullable().optional(), message: z.string().optional(), message_key: z.string().optional(), stream_id: z.string().optional(), status: z.string().optional(), reason: z.string().optional() })
export const BackgroundResultSchema = z.looseObject({ id: z.string().optional(), task_id: z.string().optional(), status: z.string().optional(), title: z.string().optional(), summary: z.string().optional(), prompt: z.string().optional(), answer: NullableString.optional(), error: z.string().optional(), completed_at: z.number().nullable().optional() })
export const BackgroundStatusSchema = z.looseObject({ results: z.array(BackgroundResultSchema) })
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
  active: z.boolean(),
})
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>
/**
 * `agent_available: false` when the Agent could not be asked: running work then shows `unknown`. Reading never consumes a
 * result. `agents_working` (TAL-373): a delegation is running or needs attention, whatever `kind` the list is narrowed to;
 * the chat's side panel opens on Agents for it. Absent from servers before TAL-373.
 */
export const BackgroundTasksResponseSchema = z.object({ session_id: z.string(), tasks: z.array(BackgroundTaskSchema), agent_available: z.boolean(), agents_working: z.boolean().optional() })
export const BackgroundTaskResultSchema = z.object({ task_id: z.string(), text: z.string() })
export const BackgroundDismissRequestSchema = z.object({ session_id: SessionIdSchema, task_id: z.string().min(1) })
export const BackgroundDismissResponseSchema = z.object({ ok: z.literal(true), task: BackgroundTaskSchema })
export const ShareCreateResponseSchema = z.looseObject({ ok: z.literal(true), share: z.looseObject({ token: z.string(), url: z.string(), title: z.string(), message_count: z.number().int(), created_at: z.number(), updated_at: z.number() }), session: SessionRowSchema })
export const ShareMessageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.null(), z.array(Json)]).optional() })
export const ShareSchema = z.looseObject({ title: z.string(), messages: z.array(ShareMessageSchema), message_count: z.number().int(), created_at: z.number().optional(), updated_at: z.number().optional(), model: NullableString.optional() })
export const ShareReadSchema = z.looseObject({ share: ShareSchema })

export const SessionNewRequestSchema = z.looseObject({
  title: z.string().optional(), workspace: z.string().optional(), workspace_inherited_from_prev_session: z.boolean().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(),
  profile: z.string().nullable().optional(), prev_session_id: z.string().optional(), project_id: z.string().nullable().optional(), worktree: Json.optional(), enabled_toolsets: z.array(z.string()).nullable().optional(), parent_session_id: z.string().optional(),
})
export const TranscribeCapabilitySchema = z.looseObject({ ok: z.literal(true), available: z.boolean(), provider: z.string() })

// ── settings, profiles, models, providers ───────────────────────────────

/** TAL-411: the request profile's quota urgency thresholds. A save patches valid fields and clamps critical to at most warning. */
export const QuotaThresholdsSchema = z.object({
  warning_remaining_percent: z.number().int().min(1).max(99), critical_remaining_percent: z.number().int().min(0).max(99), pace_tolerance_percent: z.number().int().min(0).max(25),
  pace_warning_burn_rate_percent: z.number().int().min(100).max(300), pace_critical_burn_rate_percent: z.number().int().min(100).max(400), pace_minimum_elapsed_hours: z.number().int().min(0).max(72),
})
export type QuotaThresholds = z.infer<typeof QuotaThresholdsSchema>
export const LoginResponseSchema = z.looseObject({ ok: z.literal(true), message: z.string().optional() })
export const SettingsSchema = z.looseObject({
  bot_name: z.string().optional(), default_model: z.string().optional(), default_workspace: z.string().optional(), language: z.string().optional(), send_key: z.string().optional(), font_size: z.string().optional(),
  full_width_chat: z.boolean().optional(), chat_width: z.enum(['comfortable', 'wide', 'full']).optional(), auto_scroll_follow: z.boolean().optional(), render_user_markdown: z.boolean().optional(), chat_activity_display_mode: z.string().optional(), default_message_mode: z.string().optional(),
  fade_text_effect: z.boolean().optional(), hidden_tabs: z.array(z.string()).optional(), composer_control_order: z.array(z.string()).optional(), show_cli_sessions: z.boolean().optional(), show_claude_code_sessions: z.boolean().optional(),
  show_cron_sessions: z.boolean().optional(), show_webhook_sessions: z.boolean().optional(), show_kanban_sessions: z.boolean().optional(), check_for_updates: z.boolean().optional(), ignore_agent_updates: z.boolean().optional(),
  auth_enabled: z.boolean().optional(), password_auth_enabled: z.boolean().optional(), password_env_var: z.boolean().optional(), passkeys_enabled: z.boolean().optional(), passwordless_enabled: z.boolean().optional(),
  auth_disabled_acknowledged: z.boolean().optional(), webui_version: z.string().optional(), agent_version: z.string().optional(), update_channel: z.string().optional(), agent_update_channel: z.enum(['stable', 'experimental']).optional(), update_channel_version: NullableString.optional(),
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
})
export const ProfilesSchema = z.looseObject({ profiles: z.array(ProfileSchema), active: z.string(), single_profile_mode: z.boolean().optional() })
export type Profiles = z.infer<typeof ProfilesSchema>
export const ActiveProfileSchema = z.looseObject({ name: z.string(), path: z.string().optional(), is_default: z.boolean().optional(), default_workspace: NullableString.optional() })
export const ProfileSwitchSchema = ProfilesSchema.extend({ is_default: z.boolean(), default_model: Json, default_model_provider: Json, default_workspace: z.string().nullable() })
/** `/api/reasoning`: config.yaml agent.reasoning_effort / display.show_reasoning, resolved for a model. */
export const ReasoningStatusSchema = z.looseObject({ show_reasoning: z.boolean().optional(), reasoning_effort: z.string().nullable().optional(), supported_efforts: z.array(z.string()).optional(), supports_reasoning_effort: z.boolean().optional(), supports_thinking_toggle: z.boolean().optional() })
export type ReasoningStatus = z.infer<typeof ReasoningStatusSchema>
/** TAL-301: `provider_id`/`bare_id` are the server's split of `id`; clients match a stored `(model, provider)` against them and send `id` back. */
export const ModelEntrySchema = z.looseObject({ id: z.string(), label: z.string().optional(), provider: z.string().optional(), provider_id: z.string().optional(), bare_id: z.string().optional(), supports_fast_tier: z.boolean().optional() })
export const ModelGroupSchema = z.looseObject({ provider: z.string(), provider_id: z.string().optional(), models: z.array(ModelEntrySchema), extra_models: z.array(ModelEntrySchema).optional() })
export const ModelsSchema = z.looseObject({ active_provider: NullableString.optional(), default_model: z.string().optional(), default_provider_id: NullableString.optional(), default_bare_id: z.string().optional(), default_option_id: NullableString.optional(), groups: z.array(ModelGroupSchema), aliases: z.record(z.string(), Json).optional(), configured_model_badges: z.record(z.string(), Json).optional() })
export type Models = z.infer<typeof ModelsSchema>
export const ProviderSchema = z.looseObject({
  id: z.string(), display_name: z.string().optional(), has_key: z.boolean().optional(), configurable: z.boolean().optional(), is_oauth: z.boolean().optional(), is_plugin_provider: z.boolean().optional(), is_self_hosted: z.boolean().optional(),
  is_custom: z.boolean().optional(), key_source: z.string().optional(), base_url: NullableString.optional(), auth_error: NullableString.optional(), env_var: NullableString.optional(), models: z.array(ModelEntrySchema).optional(), models_total: z.number().optional(),
})
export const ProvidersSchema = z.looseObject({ providers: z.array(ProviderSchema), active_provider: NullableString.optional() })
export const QuotaLevelSchema = z.enum(['healthy', 'warning', 'critical', 'stale', 'unavailable'])
export type QuotaLevel = z.infer<typeof QuotaLevelSchema>
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
  label: z.string(), used_percent: NullableNumber, remaining_percent: NullableNumber, reset_at: NullableString.describe('ISO-8601 UTC.'), detail: NullableString,
  window_seconds: NullableNumber.describe('The provider value, else 5h or weekly from the label; null when unknown.'),
  pace: QuotaPaceSchema.nullable().describe('Null for a window without a future reset, a usage value, or a 5h/weekly length.'),
  forecast: QuotaForecastSchema.nullable(),
  projection_eligible: z.boolean().optional().describe('TAL-411, `/api/provider/quotas` only: the burn-rate breakpoints apply (enough elapsed time and use, and the projection empties the window before reset).'),
  urgency: QuotaUrgencySchema.optional(),
})
const QuotaWindowIndex = z.number().int().nullable().optional()
export const QuotaSourceSchema = z.looseObject({
  source_id: z.string(), provider_id: z.string().optional(), provider_label: z.string().optional(), account_label: z.string().optional(), status: z.string().optional(), supported: z.boolean().optional(), message: z.string().nullable().optional(),
  is_active_provider: z.boolean().optional(), quota: Json.optional(), windows: z.array(QuotaWindowSchema).optional(), balances: Json.optional(), plan: Json.optional(), details: Json.optional(), unavailable_reason: Json.optional(), retry_after: Json.optional(), fetched_at: Json.optional(),
  pace_window_index: QuotaWindowIndex.describe('The window a pace-coloured widget shows: the weekly one, else the first 5h/session window.'),
  session_window_index: QuotaWindowIndex.describe('The session (else 5h) window.'), weekly_window_index: QuotaWindowIndex.describe('The weekly window.'),
  urgency: QuotaUrgencySchema.optional().describe('TAL-411: `remaining` of the first window, `pace` of the pace window; alerts and the source colour follow it.'),
})
/** An account-usage provider's normalised snapshot on `/api/provider/quota` (the same windows and indexes as a quotas source). */
export const QuotaAccountLimitsSchema = z.looseObject({
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
export const ProviderQuotasSchema = z.looseObject({
  version: z.number(), computed_at: z.string().describe('ISO-8601 UTC reference time of every window `pace`.'), scope_id: z.string(), profile_id: z.string(), active_provider: NullableString, requested_source_id: NullableString,
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
})
export const AuxiliaryModelsSchema = z.looseObject({ main: z.looseObject({ model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional(), api_key_set: z.boolean().optional() }), tasks: z.array(AuxiliaryTaskSchema) })
export const MaxTokensSchema = z.looseObject({ max_tokens: NullableNumber, max_tokens_effective: NullableNumber, max_tokens_fallback: NullableNumber })

// ── workspaces, files, git ───────────────────────────────────────────────

/** A registry entry; `name` is never empty (the folder name when none is registered, `Home` for `default`), so pickers show it as-is (TAL-303). */
export const WorkspaceEntrySchema = z.looseObject({ name: z.string().min(1), path: z.string() })
export type Workspace = z.infer<typeof WorkspaceEntrySchema>
export const WorkspacesSchema = z.looseObject({ workspaces: z.array(WorkspaceEntrySchema), last: NullableString.optional(), terminal_remote_backend: z.boolean().optional() })
export type Workspaces = z.infer<typeof WorkspacesSchema>
export const FileEntrySchema = z.looseObject({
  name: z.string(), path: z.string().optional(), is_dir: z.boolean().optional(), type: z.string().optional(), size: z.number().nullable().optional(), mtime: z.number().nullable().optional(), mtime_ns: z.union([z.number(), z.string()]).nullable().optional(),
  birthtime_ns: z.union([z.number(), z.string()]).nullable().optional(), hidden: z.boolean().optional(), workspace_sort_rank: z.number().int().optional(), target: z.string().optional(), target_outside_workspace: z.boolean().optional(),
})
export const DirListingSchema = z.looseObject({ path: z.string().optional(), entries: z.array(FileEntrySchema), signature: z.string().optional(), workspace: z.string().optional(), workspace_recovered: z.boolean().optional(), is_git: z.boolean().optional() })
export const FileContentSchema = z.looseObject({ path: z.string().optional(), content: z.string().optional(), lines: z.number().optional(), size: z.number().optional(), truncated: z.boolean().optional(), binary: z.boolean().optional(), mime: z.string().optional() })
export const GitInfoSchema = z.looseObject({ git: z.looseObject({ is_git: z.boolean().optional(), branch: NullableString.optional(), dirty: z.number().optional(), modified: z.number().optional(), untracked: z.number().optional(), ahead: z.number().optional(), behind: z.number().optional() }).nullable().optional() })

// ── tools ────────────────────────────────────────────────────────────────

export const SkillSchema = z.looseObject({ name: z.string(), description: NullableString.optional(), category: NullableString.optional(), disabled: z.boolean().optional() })
export const SkillsSchema = z.looseObject({ skills: z.array(SkillSchema), categories: z.array(Json).optional() })
export const SkillContentSchema = z.looseObject({ name: z.string().optional(), content: z.string().optional(), path: z.string().optional(), success: z.boolean().optional(), message: z.string().optional(), ok: z.boolean().optional() })
export const SkillsUsageSchema = z.looseObject({ usage: z.record(z.string(), z.looseObject({ use_count: z.number().optional(), view_count: z.number().optional(), patch_count: z.number().optional() })), skill_names: z.array(z.string()).optional(), total_invocations: z.number().optional(), unique_skills_used: z.number().optional() })
export const MemorySchema = z.looseObject({
  memory: z.string(), user: z.string(), soul: z.string(), project_context: z.string().optional(), memory_path: z.string().optional(), user_path: z.string().optional(), soul_path: z.string().optional(), project_context_path: z.string().optional(),
  project_context_name: z.string().optional(), project_context_workspace: z.string().optional(), memory_mtime: NullableNumber.optional(), user_mtime: NullableNumber.optional(), soul_mtime: NullableNumber.optional(), project_context_mtime: NullableNumber.optional(),
  project_context_shadowed: z.array(Json).optional(), external_notes_enabled: z.boolean().optional(),
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
 * posts the typed text there and shows the returned output instead of starting a chat turn (TAL-561).
 */
export const CommandClientSchema = z.enum(['web', 'ios'])
export const CommandRowSchema = z.looseObject({
  name: z.string(), description: z.string().optional(), aliases: z.array(z.string()), args_hint: z.string().optional(), category: z.string().optional(),
  handler: z.enum(['client', 'agent']), clients: z.array(CommandClientSchema), unsupported_message: z.string().optional(),
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
export const AgentHealthSchema = z.looseObject({ alive: z.boolean().nullable().optional(), checked_at: z.string().optional(), details: z.looseObject({ state: z.string().optional(), reason: z.string().optional() }).optional(), gateway_chat: z.looseObject({ enabled: z.boolean().optional(), backend: z.string().optional(), base_url_configured: z.boolean().optional(), api_key_configured: z.boolean().optional() }).optional(), error: z.string().optional() })
export const SystemHealthSchema = z.looseObject({
  available: z.boolean().optional(), status: z.string().optional(), checked_at: z.string().optional(), cpu: Json.nullable().optional(), memory: Json.nullable().optional(), disk: z.looseObject({ percent: z.number().optional(), total_bytes: z.number().optional(), used_bytes: z.number().optional() }).nullable().optional(),
  errors: z.array(z.looseObject({ code: z.string().optional(), metric: z.string().optional() })).optional(), webui_runtime: Json.optional(),
})
export const UpdateTargetSchema = z.looseObject({ name: z.string().optional(), channel: z.enum(['stable', 'experimental']).optional(), unsupported: z.boolean().optional(), supported_revision: z.string().optional(), supported_version: z.string().optional(), candidate_revision: z.string().optional(), behind: z.number().nullable().optional(), current_sha: z.string().nullable().optional(), latest_sha: z.string().nullable().optional(), compare_url: z.string().optional(), repo_url: z.string().optional(), error: z.string().optional(), ok: z.boolean().optional(), manual_update: z.boolean().optional(), no_git: z.boolean().optional(), install_kind: z.literal('npm').optional(), npm: z.string().optional(), channel_switch: z.boolean().optional(), dirty: z.boolean().optional(), metadata_repair: z.boolean().optional(), release_url: z.string().optional(), ignored: z.boolean().optional(), stale_check: z.boolean().optional(), current_version: z.string().optional() })
export const UpdatesCheckSchema = z.looseObject({ disabled: z.boolean().optional(), cached: z.boolean().optional(), channel: z.string().optional(), agent_channel: z.enum(['stable', 'experimental']).optional(), checked_at: z.number().optional(), include_agent: z.boolean().optional(), webui: UpdateTargetSchema.nullable().optional(), agent: UpdateTargetSchema.nullable().optional() })
export const UpdatesSummarySchema = z.looseObject({ summary: z.string().optional(), text: z.string().optional(), ok: z.boolean().optional(), error: z.string().optional(), diff_links: z.array(Json).optional() })
export const UpdateApplySchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional(), error: z.string().optional(), message: z.string().optional(), lock: Json.optional(), confirmation_required: z.boolean().optional(), candidate_revision: z.string().optional(), supported_revision: z.string().optional(), supported_version: z.string().optional(), agent_channel: z.enum(['stable', 'experimental']).optional(), notification_id: z.uuid().optional(), channel_switch: z.boolean().optional(), backup_dir: z.string().nullable().optional(), backup_failed: z.boolean().optional(), stash_conflict: z.boolean().optional() })
export const UpdateNotificationPhaseSchema = z.enum(['applying', 'awaiting_confirmation', 'restarting', 'succeeded', 'blocked', 'failed', 'unknown'])
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
  unread: z.boolean(),
  active: z.boolean(),
  requires_interaction: z.boolean(),
  can_dismiss: z.boolean(),
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
export const PluginSchema = z.looseObject({ key: z.string(), name: z.string().optional(), kind: z.string().optional(), enabled: z.boolean().optional(), description: z.string().optional(), version: z.string().optional(), activation: z.string().optional(), is_active_provider: z.boolean().optional(), hooks: z.array(Json).optional() })
export const PluginsSchema = z.looseObject({ plugins: z.array(PluginSchema), empty: z.boolean().optional(), read_only: z.boolean().optional(), supported_hooks: z.array(z.string()).optional(), unavailable: z.boolean().optional() })
export const McpServerSchema = z.looseObject({ name: z.string(), id: z.string().optional(), transport: z.string().optional(), enabled: z.boolean().optional(), active: z.boolean().optional(), status: z.string().optional(), tools: z.number().optional(), tool_count: z.number().int().nullable().optional(), health: z.string().optional(), health_detail: z.string().optional(), health_checked_at: Json.optional(), health_pending: z.boolean().optional() })
export const McpServersSchema = z.looseObject({ servers: z.array(McpServerSchema), health_pending: z.boolean().optional(), reload_required: z.boolean().optional(), toggle_supported: z.boolean().optional() })
export const McpToolsSchema = z.looseObject({ tools: z.array(z.looseObject({ name: z.string().optional(), server: z.string().optional(), description: z.string().optional() })), total: z.number().int().optional(), source: z.string().optional(), inventory_scope: z.string().optional(), unavailable_servers: z.array(z.string()).optional() })
export const NotesSourcesSchema = z.looseObject({ enabled: z.boolean().optional(), sources: z.array(Json).optional(), source: z.string().optional(), inventory_scope: z.string().optional(), recent_ai_notes: z.array(Json).optional(), attach_supported: z.boolean().optional(), automatic_recall_unchanged: z.boolean().optional() })
export const TodoItemSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), text: z.string().optional(), content: z.string().optional(), title: z.string().optional(), status: z.string().optional(), done: z.boolean().optional(), completed: z.boolean().optional() })
export const TodoStateSchema = z.looseObject({ session_id: z.string().optional(), todos: z.array(TodoItemSchema).optional(), summary: z.record(z.string(), z.unknown()).optional(), version: z.number().optional(), ts: z.number().optional(), source: z.string().optional(), description: z.string().optional(), pending_count: z.number().optional() })
export type TodoState = z.infer<typeof TodoStateSchema>

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
  ok: z.boolean().optional(), status: z.string().optional(), url: z.string().optional(), verification_url: z.string().optional(), user_code: z.string().optional(), message: z.string().optional(),
  error: z.string().nullable().optional(), flow_id: z.string().optional(), provider: z.string().optional(), expires_in: z.number().int().optional(), interval: z.number().int().optional(),
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
})
export type CronJob = z.infer<typeof CronJobViewSchema>
export const CronsSchema = z.looseObject({ jobs: z.array(CronJobViewSchema), active_profile: z.string().optional(), all_profiles: z.boolean().optional(), other_profile_count: z.number().optional(), cron_unavailable: z.boolean().optional() })
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
export const CronRunSchema = z.looseObject({ content: z.string().optional(), snippet: z.string().optional(), usage: CronRunUsageSchema.optional(), error: z.string().optional() })
export const CronStatusSchema = z.looseObject({ running: z.union([z.boolean(), z.record(z.string(), z.number())]).optional() })
export const KanbanTaskViewSchema = z.looseObject({ id: z.union([z.string(), z.number()]), title: z.string().optional(), status: z.string().optional(), assignee: NullableString.optional(), priority: z.union([z.string(), z.number()]).nullable().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), session_id: NullableString.optional(), archived: z.boolean().optional(), created_at: Json.optional(), updated_at: Json.optional() })
export const KanbanColumnSchema = z.looseObject({ name: z.string(), tasks: z.array(KanbanTaskViewSchema) })
export const KanbanBoardViewSchema = z.looseObject({ columns: z.array(KanbanColumnSchema).optional(), assignees: z.array(Json).optional(), filters: Json.optional(), latest_event_id: z.number().optional(), read_only: z.boolean().optional(), tenants: z.array(Json).optional(), changed: z.boolean().optional() })
export const KanbanBoardsViewSchema = z.looseObject({ boards: z.array(z.looseObject({ slug: z.string(), name: z.string().nullable().optional(), is_current: z.boolean().optional(), total: z.number().optional(), archived: z.boolean().optional(), color: z.string().optional(), icon: z.string().optional(), description: z.string().optional() })), current: z.string().optional(), read_only: z.boolean().optional() })
export const ExtensionStatusSchema = z.looseObject({
  enabled: z.boolean(), extension_dir_configured: z.boolean().optional(), extension_dir_valid: z.boolean().optional(), script_urls: z.array(z.string()).optional(), stylesheet_urls: z.array(z.string()).optional(), sidecars: z.array(Json).optional(),
  extensions: z.array(z.looseObject({ id: z.string(), enabled: z.boolean().optional(), name: z.string().optional(), version: z.string().optional() })).optional(), warnings: z.array(Json).optional(),
  manifest: z.looseObject({ configured: z.boolean().optional(), loaded: z.boolean().optional(), status: z.string().optional(), entry_count: z.number().optional() }).optional(), counts: z.record(z.string(), z.number()).optional(), gallery_installed: z.record(z.string(), Json).optional(),
})
