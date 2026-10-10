import { oc } from '@orpc/contract'
import { z } from 'zod'
import { SessionIdSchema, SessionRowSchema, SessionEnvelopeSchema, SessionsListSchema, SessionNewRequestSchema, DraftSchema, DraftResponseSchema, ProjectSchema, ProjectsSchema, SessionStatusSchema, SessionUsageSchema, SessionDeleteResultSchema, ShareReadSchema, ShareCreateResponseSchema, ActivitySceneRowSchema, ToolResultViewSchema, SessionSchema, AttachmentSchema } from '../views.js'

/** Session, project, share, and draft routes. Response rows are loose: the sidecar carries operator-defined extras. */

const Json = z.unknown()

export const OkSchema = z.object({ ok: z.literal(true) }).catchall(Json)
const SessionBody = z.object({ session_id: SessionIdSchema })
const SessionQuery = z.object({ session_id: z.string() })


export const SessionsListQuerySchema = z.object({
  include_archived: z.string().optional(), all_profiles: z.string().optional(), exclude_hidden: z.string().optional(), sidebar_source: z.string().optional(),
  archived_limit: z.string().optional(), archived_offset: z.string().optional(),
  show_cli_sessions: z.string().optional(), show_claude_code_sessions: z.string().optional(), show_cron_sessions: z.string().optional(),
  show_webhook_sessions: z.string().optional(), show_kanban_sessions: z.string().optional(),
})
export type SessionsListQuery = z.infer<typeof SessionsListQuerySchema>

/**
 * TAL-308: the sidebar search. Any filter here (`project_id`: a project id or `none`; `sidebar_source`; `include_archived`;
 * a `show_*` override) selects the `/api/sessions` rows and order, so the response is the complete result and says
 * `sidebar_filtered: true`. Without one the search keeps its older store-only behavior.
 */
export const SessionsSearchQuerySchema = SessionsListQuerySchema.omit({ archived_limit: true, archived_offset: true }).extend({
  q: z.string().optional(), content: z.string().optional(), depth: z.string().optional(), project_id: z.string().optional(),
})

export const SessionDetailQuerySchema = z.object({ session_id: z.string(), messages: z.string().optional(), msg_limit: z.string().optional(), msg_before: z.string().optional(), resolve_model: z.string().optional(), expand_renderable: z.string().optional() })





/** TAL-627: one bulk action over many sessions; ids are unique and the server answers each in input order. */
export const SessionsBulkRequestSchema = z.object({
  action: z.enum(['archive', 'unarchive', 'delete']),
  session_ids: z.array(SessionIdSchema).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, 'session_ids must be unique'),
})
/** Each id's outcome: `status`/`error` are what the single-session route would have answered; one failure never stops the rest. */
export const SessionsBulkResultSchema = z.object({
  results: z.array(z.object({ session_id: z.string(), ok: z.boolean(), status: z.number().int().optional(), error: z.string().optional(), state_db_cleanup_failed: z.boolean().optional() })),
})

/** TAL-258: the handoff dock's body. `since` is a unix time (a numeric string is accepted); only later messages count. */
const HandoffInputSchema = z.object({ session_id: z.string().optional(), since: Json.optional() })
/** A round is a user message (consecutive ones merge) answered by the assistant; the dock is offered from `threshold` rounds. */
export const ConversationRoundsSchema = z.object({ ok: z.literal(true), rounds: z.number().int(), threshold: z.number().int(), should_show: z.boolean() })
/**
 * The summary the session's main model wrote of its last 50 messages, also appended to the transcript as a display-only
 * `handoff_summary` tool row. `fallback` marks the deterministic local summary (no credential, a failed call, or output
 * still cut off after the longer retry); `warning` says why a failed call fell back.
 */
export const HandoffSummarySchema = z.object({ ok: z.literal(true), summary: z.string(), message_count: z.number().int(), rounds: z.number().int(), fallback: z.boolean(), warning: z.string().optional() })

const tags = ['sessions']
/** The Agent's manual-compression feedback (`summarize_manual_compression`) plus the reference line stored as the anchor summary. */
export const CompressionSummarySchema = z.looseObject({ headline: z.string().optional(), token_line: z.string().optional(), note: z.string().nullable().optional(), reference_message: z.string().nullable().optional() })
const CompressInputSchema = z.object({ session_id: z.string().optional(), focus_topic: z.string().nullable().optional(), topic: z.string().nullable().optional() })
/** `POST /api/session/compress`: the compressed session (with its display `messages`), the summary, and the focus topic used. */
export const CompressResultSchema = z.looseObject({ ok: z.literal(true), session: SessionSchema, summary: CompressionSummarySchema, focus_topic: z.string().nullable() })
/**
 * Manual compression job state: `running` while the worker runs, `done` with the compress result's fields, `error` with
 * the status the synchronous route would have answered (`error_status`, plus `type`/`retryable` for a stale Agent runtime),
 * or `idle` when no job exists. Finished jobs stay readable for ten minutes so every open tab sees the same result.
 */
export const CompressionStatusSchema = z.looseObject({
  ok: z.boolean().optional(), status: z.enum(['running', 'done', 'error', 'idle']), session_id: z.string().nullable().optional(), focus_topic: z.string().nullable().optional(),
  session: SessionSchema.optional(), summary: CompressionSummarySchema.optional(), error: z.string().optional(), error_status: z.number().int().optional(),
  type: z.string().optional(), retryable: z.boolean().optional(), restart_scheduled: z.boolean().optional(), agent_update_state: z.unknown().optional(),
  started_at: z.number().optional(), updated_at: z.number().optional(),
})

/** One `state.db` session in a lineage report: the walked tip, a hidden compression segment, or a separate child session. */
export const LineageReportRowSchema = z.object({
  session_id: z.string(), role: z.enum(['tip', 'hidden_segment', 'child_session']), title: z.string().nullable(), source: z.string().nullable(),
  started_at: z.number().nullable(), updated_at: z.number().nullable(), end_reason: z.string().nullable(), active: z.boolean(), archived: z.boolean(),
})
/**
 * `GET /api/session/lineage/report`: a read-only walk of up to 20 compression-continuation parents (`segments`, tip first)
 * and their non-continuation `children`, newest first. `manual_review` flags a cycle, the hop limit, or a branched lineage.
 */
export const LineageReportSchema = z.object({
  mutation: z.literal(false), found: z.literal(true), session_id: z.string(), lineage_key: z.string(), tip_session_id: z.string(),
  total_segments: z.number().int(), materialized_segments: z.number().int(), segments: z.array(LineageReportRowSchema), children: z.array(LineageReportRowSchema), manual_review: z.boolean(),
})
/** `POST /api/session/compression-recovery/start`: the focused continuation opened for `source_session_id`, new or reused. */
export const CompressionRecoveryStartSchema = z.object({ ok: z.literal(true), session: SessionSchema, source_session_id: z.string(), recommended_recovery_action: z.string(), message: z.string() })

/**
 * One recovery finding. `repairable` findings are what `repair-safe` fixes (or, for `turn_journal_pending_turn`, only
 * reports); `unsafe_to_repair` ones need an operator. Message counts are -1 when the file is missing or unreadable.
 */
export const RecoveryAuditItemSchema = z.object({
  session_id: z.string(),
  kind: z.enum(['shrunken_live', 'unstamped_legacy_backup', 'malformed_orphan_backup', 'orphan_backup', 'orphan_backup_without_state_row', 'state_db_deleted_webui_tombstone', 'index_unreadable', 'index_missing_file', 'index_missing_entry', 'state_db_orphan_webui_row', 'state_db_missing_sidecar', 'state_db_unreadable', 'turn_journal_pending_turn']),
  category: z.enum(['repairable', 'unsafe_to_repair']),
  recommendation: z.enum(['restore_from_bak', 'manual_review', 'deleted_session_skipped', 'rebuild_index', 'materialize_from_state_db', 'audit_only_pending_turn_journal']),
  live_messages: z.number().int(), bak_messages: z.number().int(), turn_id: z.string().optional(), event: z.string().optional(),
})
/** `GET /api/session/recovery/audit`: every session's backup, index, state.db, and turn-journal recovery findings; read-only. */
export const RecoveryAuditSchema = z.object({
  status: z.enum(['ok', 'warn', 'needs_manual_review']),
  summary: z.object({ ok: z.number().int(), repairable: z.number().int(), unsafe_to_repair: z.number().int() }),
  items: z.array(RecoveryAuditItemSchema),
})
/** `POST /api/session/recovery/repair-safe`: the audits before and after the repairs; 200 when `clean`, else 409 with this body. */
export const RecoveryRepairSchema = z.object({
  clean: z.boolean(), ok: z.boolean(), repaired: z.number().int(), before: RecoveryAuditSchema,
  backup_repair: z.object({ scanned: z.number().int(), restored: z.number().int(), orphaned_backups: z.number().int(), details: z.array(z.object({ session_id: z.string(), restored: z.boolean(), live_messages: z.number().int().optional(), bak_messages: z.number().int().optional(), skipped: z.string().optional(), error: z.string().optional() })) }),
  sidecar_repair: z.object({ scanned: z.number().int(), materialized: z.number().int(), details: z.array(z.object({ session_id: z.string(), materialized: z.boolean(), messages: z.number().int().optional(), skipped: z.string().optional(), error: z.string().optional() })) }),
  after: RecoveryAuditSchema,
})
export type RecoveryAuditItem = z.infer<typeof RecoveryAuditItemSchema>
export type RecoveryAudit = z.infer<typeof RecoveryAuditSchema>
export type RecoveryRepair = z.infer<typeof RecoveryRepairSchema>

export const sessionsContract = {
  sessions: {
    list: oc.route({ method: 'GET', path: '/api/sessions', tags, summary: 'Sidebar rows for the active profile.' }).input(SessionsListQuerySchema).output(SessionsListSchema),
    search: oc.route({ method: 'GET', path: '/api/sessions/search', tags, summary: 'Title, metadata and content matches; any sidebar filter answers from the /api/sessions rows, in their order.' }).input(SessionsSearchQuerySchema).output(z.looseObject({ sessions: z.array(SessionRowSchema), query: z.string().optional(), count: z.number().int().optional(), all_profiles: z.boolean(), active_profile: z.string(), sidebar_filtered: z.boolean().optional() })),
    bulk: oc.route({ method: 'POST', path: '/api/sessions/bulk', tags, summary: 'Archive, unarchive or delete up to 200 sessions, one ordered result per id.' }).input(SessionsBulkRequestSchema).output(SessionsBulkResultSchema),
    cleanup: oc.route({ method: 'POST', path: '/api/sessions/cleanup', tags, summary: 'Delete empty Untitled sessions and index rows with no session file.' }).input(z.object({}).catchall(Json)).output(z.object({ ok: z.literal(true), cleaned: z.number().int() })),
    cleanupZeroMessage: oc.route({ method: 'POST', path: '/api/sessions/cleanup_zero_message', tags }).input(z.object({}).catchall(Json)).output(z.object({ ok: z.literal(true), cleaned: z.number().int() })),
  },
  session: {
    get: oc.route({ method: 'GET', path: '/api/session', tags, summary: 'One session with a bounded message window.' }).input(SessionDetailQuerySchema).output(SessionEnvelopeSchema),
    status: oc.route({ method: 'GET', path: '/api/session/status', tags }).input(SessionQuery).output(SessionStatusSchema),
    usage: oc.route({ method: 'GET', path: '/api/session/usage', tags }).input(SessionQuery).output(SessionUsageSchema),
    new: oc.route({ method: 'POST', path: '/api/session/new', tags }).input(SessionNewRequestSchema).output(SessionEnvelopeSchema.extend({ worktree_skipped: z.string().optional() })),
    rename: oc.route({ method: 'POST', path: '/api/session/rename', tags }).input(SessionBody.extend({ title: z.string() })).output(SessionEnvelopeSchema),
    delete: oc.route({ method: 'POST', path: '/api/session/delete', tags }).input(z.object({ session_id: z.string() })).output(SessionDeleteResultSchema),
    pin: oc.route({ method: 'POST', path: '/api/session/pin', tags }).input(SessionBody.extend({ pinned: z.boolean().optional() })).output(OkSchema.extend({ session: SessionRowSchema })),
    archive: oc.route({ method: 'POST', path: '/api/session/archive', tags }).input(SessionBody.extend({ archived: z.boolean().optional() })).output(OkSchema.extend({ session: SessionRowSchema })),
    move: oc.route({ method: 'POST', path: '/api/session/move', tags }).input(SessionBody.extend({ project_id: z.string().nullable().optional() })).output(OkSchema.extend({ session: SessionRowSchema })),
    duplicate: oc.route({ method: 'POST', path: '/api/session/duplicate', tags }).input(z.object({ session_id: z.string() })).output(SessionEnvelopeSchema),
    branch: oc.route({ method: 'POST', path: '/api/session/branch', tags }).input(SessionBody.extend({ keep_count: z.number().int().nullable().optional(), title: z.string().nullable().optional() })).output(z.object({ session_id: z.string(), title: z.string(), parent_session_id: z.string() })),
    truncate: oc.route({ method: 'POST', path: '/api/session/truncate', tags }).input(SessionBody.extend({ keep_count: Json.optional() })).output(OkSchema.extend({ session: SessionRowSchema })),
    clear: oc.route({ method: 'POST', path: '/api/session/clear', tags }).input(SessionBody).output(OkSchema.extend({ session: SessionRowSchema })),
    retry: oc.route({ method: 'POST', path: '/api/session/retry', tags, description: '`last_user_text` is the stored row\'s text; `last_user_prompt` and `last_user_attachments` are what to resend as the new turn.' }).input(SessionBody).output(z.object({ ok: z.literal(true), last_user_text: z.string(), last_user_prompt: z.string().optional(), last_user_attachments: z.array(AttachmentSchema).optional(), removed_count: z.number().int() }).or(z.object({ error: z.string() }))),
    undo: oc.route({ method: 'POST', path: '/api/session/undo', tags }).input(SessionBody).output(z.object({ ok: z.literal(true), removed_count: z.number().int(), removed_preview: z.string() }).or(z.object({ error: z.string() }))),
    update: oc.route({ method: 'POST', path: '/api/session/update', tags }).input(SessionBody.extend({ workspace: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional() })).output(SessionEnvelopeSchema),
    toolsets: oc.route({ method: 'POST', path: '/api/session/toolsets', tags }).input(SessionBody.extend({ toolsets: z.array(z.string()).nullable().optional() })).output(z.object({ ok: z.literal(true), enabled_toolsets: z.array(z.string()).nullable() })),
    yoloGet: oc.route({ method: 'GET', path: '/api/session/yolo', tags }).input(SessionQuery).output(z.object({ yolo_enabled: z.boolean() })),
    // Python: `enabled` is truthy-checked; enabling reports `stale_cleared` when a parked approval was released.
    yoloSet: oc.route({ method: 'POST', path: '/api/session/yolo', tags }).input(z.object({ session_id: z.string(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), yolo_enabled: z.boolean(), stale_cleared: z.boolean().optional() })),
    // Accepts a JSON export's document as-is: its null `title`/`workspace`/`model`/`pinned` fall back to the defaults.
    import: oc.route({ method: 'POST', path: '/api/session/import', tags }).input(z.object({ messages: Json.optional(), tool_calls: Json.optional(), title: z.string().nullable().optional(), workspace: z.string().nullable().optional(), model: z.string().nullable().optional(), pinned: z.boolean().nullable().optional() }).catchall(Json)).output(OkSchema.extend({ session: SessionRowSchema })),
    regenerateTitle: oc.route({ method: 'POST', path: '/api/session/title/regenerate', tags, summary: 'Generate a title from the first (or latest) complete exchange through the auxiliary model and persist it.' }).input(SessionBody.extend({ prefer_latest: z.boolean().optional() })).output(z.looseObject({ session: SessionRowSchema, title: z.string(), status: z.string(), raw_preview: z.string() })),
    recoveryAudit: oc.route({ method: 'GET', path: '/api/session/recovery/audit', tags, summary: 'Owner only. Read-only audit of session backups, the index, state.db rows without a sidecar, and pending turn journals.' }).input(z.object({})).output(RecoveryAuditSchema),
    recoveryRepairSafe: oc.route({ method: 'POST', path: '/api/session/recovery/repair-safe', tags, summary: 'Owner only. Apply the repairable findings and audit again; 409 with the same body unless the result is clean.' }).input(z.object({}).catchall(Json)).output(RecoveryRepairSchema),
    lineageReport: oc.route({ method: 'GET', path: '/api/session/lineage/report', tags, summary: 'Read-only compression lineage of a state.db session; 404 when the active profile\'s state.db lacks it.' }).input(z.object({ session_id: z.string().optional() })).output(LineageReportSchema),
    compressionRecoveryStart: oc.route({ method: 'POST', path: '/api/session/compression-recovery/start', tags, summary: 'Open the focused continuation of a compression-exhausted session; a retry reuses the existing one.' }).input(z.object({ session_id: z.string().optional() })).output(CompressionRecoveryStartSchema),
    compress: oc.route({ method: 'POST', path: '/api/session/compress', tags, summary: 'Compress the session\'s model context now (iOS `/compress`). `focus_topic` (alias `topic`) is capped at 500 characters.' }).input(CompressInputSchema).output(CompressResultSchema),
    compressStart: oc.route({ method: 'POST', path: '/api/session/compress/start', tags, summary: 'Start (or join) the session\'s manual compression job; poll `compress/status`.' }).input(CompressInputSchema).output(CompressionStatusSchema),
    compressStatus: oc.route({ method: 'GET', path: '/api/session/compress/status', tags }).input(SessionQuery).output(CompressionStatusSchema),
    conversationRounds: oc.route({ method: 'POST', path: '/api/session/conversation-rounds', tags, summary: 'Count the session\'s conversation rounds in state.db and whether the handoff dock is due.' }).input(HandoffInputSchema).output(ConversationRoundsSchema),
    handoffSummary: oc.route({ method: 'POST', path: '/api/session/handoff-summary', tags, summary: 'Summarize the session\'s recent conversation for a handoff and append the summary card; needs the dock\'s round threshold.' }).input(HandoffInputSchema).output(HandoffSummarySchema),
    draftGet: oc.route({ method: 'GET', path: '/api/session/draft', tags }).input(SessionQuery).output(z.object({ draft: DraftSchema, draft_version: z.string().nullable() })),
    draftSave: oc.route({ method: 'POST', path: '/api/session/draft', tags }).input(z.object({ session_id: z.string(), text: Json.optional(), files: Json.optional(), draft_version: Json.optional() })).output(DraftResponseSchema),
    anchorSceneGet: oc.route({ method: 'GET', path: '/api/session/anchor-scene', tags }).input(z.object({ session_id: z.string(), message_ref: z.string().optional(), message_index: z.string().optional(), before: z.string().optional(), limit: z.string().optional() })).output(z.object({ scene_ref: z.string(), rows: z.array(ActivitySceneRowSchema), start: z.number().int(), end: z.number().int(), total: z.number().int(), complete: z.boolean() })),
    toolResult: oc.route({ method: 'GET', path: '/api/session/tool-result', tags, summary: 'One tool call\'s whole, redacted result, for a scene row a limited response clipped (`result_truncated`); 404 for an unknown call id.' }).input(z.object({ session_id: z.string(), tool_call_id: z.string() })).output(z.object({ tool_call_id: z.string(), result: z.string(), result_view: ToolResultViewSchema })),
    anchorSceneSave: oc.route({ method: 'POST', path: '/api/session/anchor-scene', tags }).input(z.object({ session_id: z.string(), scene: Json.optional(), message_ref: z.string().optional(), message_index: Json.optional(), message_offset: Json.optional(), message_window_index: Json.optional(), stream_id: z.string().optional() })).output(z.object({ ok: z.literal(true), message_index: z.number().int(), message_ref: z.string() })),
  },
  projects: {
    list: oc.route({ method: 'GET', path: '/api/projects', tags: ['projects'] }).input(z.object({ all_profiles: z.string().optional() })).output(ProjectsSchema),
    create: oc.route({ method: 'POST', path: '/api/projects/create', tags: ['projects'] }).input(z.object({ name: z.string(), color: z.string().nullable().optional(), profile: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), project: ProjectSchema })),
    rename: oc.route({ method: 'POST', path: '/api/projects/rename', tags: ['projects'] }).input(z.object({ project_id: z.string(), name: z.string(), color: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), project: ProjectSchema })),
    delete: oc.route({ method: 'POST', path: '/api/projects/delete', tags: ['projects'] }).input(z.object({ project_id: z.string() })).output(z.object({ ok: z.literal(true) })),
  },
  share: {
    create: oc.route({ method: 'POST', path: '/api/share/create', tags: ['shares'] }).input(z.object({ session_id: z.string() })).output(ShareCreateResponseSchema),
    revoke: oc.route({ method: 'POST', path: '/api/share/revoke', tags: ['shares'] }).input(z.object({ session_id: z.string() })).output(OkSchema.extend({ session: SessionRowSchema })),
    read: oc.route({ method: 'GET', path: '/api/share/{token}', tags: ['shares'], summary: 'Public read of a shared conversation snapshot.' }).input(z.object({ token: z.string() })).output(ShareReadSchema),
  },
  talaria: {
    pair: oc.route({ method: 'POST', path: '/api/talaria/relay/pair', tags: ['talaria'], summary: 'Register this server with Talaria Relay (owner) or enroll the active profile (any session).' })
      .input(z.object({ relay_url: z.string(), publisher_id: z.string(), publisher_invitation: z.string(), label: z.string().optional() }))
      .output(z.object({ ok: z.literal(true), publisher_id: z.string() })),
    presence: oc.route({ method: 'POST', path: '/api/talaria/presence', tags: ['talaria'], summary: 'Renew or revoke one browser tab\'s activity lease; a fresh lease mutes relay alerts for the profile.' })
      .input(z.object({ tab_id: z.string(), active: z.boolean(), seq: z.number().int() }))
      .output(z.object({ ok: z.literal(true), lease_seconds: z.number().int() })),
    viewed: oc.route({ method: 'POST', path: '/api/talaria/viewed', tags: ['talaria'], summary: 'Report a session as viewed through now so the relay clears its finished runs from Live Activities; a no-op without a relay.' })
      .input(z.object({ session_id: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
  },
}
