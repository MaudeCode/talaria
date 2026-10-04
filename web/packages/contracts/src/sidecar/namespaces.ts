import { z } from 'zod'

/** Shared param shapes. */
export const ProfileHomeParams = z.object({ profile_home: z.string().min(1) })
export const BaseHomeParams = z.object({ base_home: z.string().min(1) })
const Ok = z.object({ ok: z.boolean() })
const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())

// ── goals ──────────────────────────────────────────────────────────────
export const GoalStateSchema = z.object({
  goal: z.string(), status: z.string(), turns_used: z.number().int(), max_turns: z.number().int(),
  last_verdict: z.string().nullable(), last_reason: z.string().nullable(), paused_reason: z.string().nullable(),
})
const GoalSession = ProfileHomeParams.extend({ session_id: z.string().min(1), default_max_turns: z.number().int().positive().optional() })
export const GoalStatusSchema = z.object({ goal: GoalStateSchema.nullable(), active: z.boolean(), message: z.string(), message_key: z.string().optional(), message_args: z.array(Json).optional() })
export const GoalCommandResultSchema = z.object({
  ok: z.boolean(), action: z.string(), message: z.string(), goal: GoalStateSchema.nullable(), error: z.string().optional(), kickoff_prompt: z.string().optional(),
  message_key: z.string().optional(), message_args: z.array(Json).optional(),
})
export const GoalDecisionSchema = z.object({
  status: z.string().nullable(), should_continue: z.boolean(), continuation_prompt: z.string().nullable(), verdict: z.string(), reason: z.string(), message: z.string(),
  message_key: z.string().optional(), message_args: z.array(Json).optional(),
})
export const GOALS_METHODS = {
  'goals.get': { params: GoalSession, result: GoalStatusSchema },
  'goals.command': { params: GoalSession.extend({ args: z.string(), stream_running: z.boolean().optional() }), result: GoalCommandResultSchema },
  'goals.snapshot': { params: GoalSession, result: z.object({ goal: GoalStateSchema.nullable(), snapshot: z.string().nullable() }) },
  'goals.restore': { params: GoalSession.extend({ snapshot: z.string().nullable() }), result: z.object({ goal: GoalStateSchema.nullable() }) },
  'goals.evaluate': { params: GoalSession.extend({ last_response: z.string(), user_initiated: z.boolean().optional() }), result: GoalDecisionSchema },
} as const

// ── commands / plugins ─────────────────────────────────────────────────
export const CommandSchema = z.object({
  name: z.string(), description: z.string(), category: z.string(), aliases: z.array(z.string()), args_hint: z.string(), subcommands: z.array(z.string()),
  cli_only: z.boolean(), gateway_only: z.boolean(),
})
/**
 * A model-provider plugin installed and enabled in the profile (TAL-288); bundled providers are built-ins. `setup` is the Agent's
 * own verdict without spawning the plugin's CLI: `not_loaded` means the installed plugin could not be loaded (import failure, or its
 * provider id or directory name is taken by another profile's plugin in this process-wide registry).
 */
export const PluginProviderSchema = z.object({ name: z.string(), display_name: z.string(), auth_type: z.string(), setup: z.enum(['ready', 'missing_cli', 'needs_setup', 'not_loaded', 'unavailable']) })
export const COMMANDS_METHODS = {
  'commands.registry': { params: ProfileHomeParams, result: z.object({ commands: z.array(CommandSchema) }) },
  'commands.exec': { params: ProfileHomeParams.extend({ command: z.string().min(1) }), result: z.object({ output: z.string(), source: z.enum(['agent', 'plugin']) }) },
  'commands.moa_preset': { params: ProfileHomeParams.extend({ preset: z.string().nullable().optional() }), result: z.object({ moa: Loose }) },
  'plugins.providers': { params: ProfileHomeParams, result: z.object({ providers: z.array(PluginProviderSchema) }) },
  'plugins.list': { params: ProfileHomeParams.extend({ selected_providers: z.record(z.string(), z.string()).optional() }), result: z.object({ plugins: z.array(z.object({ name: z.string(), key: z.string(), version: z.string(), description: z.string(), enabled: z.boolean(), kind: z.string(), activation: z.string(), hooks: z.array(z.string()), is_active_provider: z.boolean().optional() })), supported_hooks: z.array(z.string()) }) },
} as const

// ── kanban ─────────────────────────────────────────────────────────────
const Board = ProfileHomeParams.extend({ board: z.string().nullable().optional() })
export const KanbanTaskSchema = z.object({ id: z.string(), title: z.string(), status: z.string(), priority: z.number().int() }).catchall(Json)
const TaskEnvelope = z.object({ task: KanbanTaskSchema, read_only: z.boolean() })
export const KanbanBoardSchema = z.union([
  z.object({ changed: z.literal(false), latest_event_id: z.number().int(), read_only: z.boolean() }),
  z.object({
    changed: z.literal(true), columns: z.array(z.object({ name: z.string(), tasks: z.array(KanbanTaskSchema) })), tenants: z.array(z.string()), assignees: z.array(z.string()),
    latest_event_id: z.number().int(), read_only: z.boolean(),
    filters: z.object({ tenant: z.string().nullable(), assignee: z.string().nullable(), include_archived: z.boolean(), only_mine: z.boolean(), profile: z.string().nullable() }),
  }),
])
export const KanbanAssigneeSchema = z.union([z.string(), z.object({ name: z.string(), on_disk: z.boolean().optional(), counts: z.record(z.string(), z.number().int()).optional() }).catchall(Json)])
export const KanbanEventSchema = z.object({ id: z.number().int(), task_id: z.string().nullable(), run_id: z.union([z.number().int(), z.string()]).nullable(), kind: z.string(), payload: Json, created_at: z.number().nullable() })
export const KanbanBoardMetaSchema = z.object({ slug: z.string(), name: z.string().nullable().optional(), archived: z.boolean().optional() }).catchall(Json)
export const KANBAN_METHODS = {
  'kanban.board': { params: Board.extend({ tenant: z.string().nullable().optional(), assignee: z.string().nullable().optional(), include_archived: z.boolean().optional(), only_mine: z.boolean().optional(), since: z.number().int().nullable().optional(), profile: z.string().nullable().optional() }), result: KanbanBoardSchema },
  'kanban.boards': { params: ProfileHomeParams.extend({ include_archived: z.boolean().optional() }), result: z.object({ boards: z.array(KanbanBoardMetaSchema.extend({ is_current: z.boolean(), counts: z.record(z.string(), z.number().int()), total: z.number().int() })), current: z.string(), read_only: z.boolean() }) },
  'kanban.create_board': { params: ProfileHomeParams.extend({ board_spec: Loose }), result: z.object({ board: KanbanBoardMetaSchema, current: z.string(), read_only: z.boolean() }) },
  'kanban.update_board': { params: ProfileHomeParams.extend({ slug: z.string(), board_spec: Loose }), result: z.object({ board: KanbanBoardMetaSchema, read_only: z.boolean() }) },
  'kanban.delete_board': { params: ProfileHomeParams.extend({ slug: z.string(), delete: z.boolean().optional() }), result: z.object({ result: Json, current: z.string(), read_only: z.boolean() }) },
  'kanban.switch_board': { params: ProfileHomeParams.extend({ slug: z.string() }), result: z.object({ current: z.string(), read_only: z.boolean() }) },
  'kanban.task': { params: Board.extend({ task_id: z.string() }), result: z.object({ task: KanbanTaskSchema, comments: z.array(Loose), events: z.array(Loose), links: z.object({ parents: z.array(z.string()), children: z.array(z.string()) }), runs: z.array(Loose), read_only: z.boolean() }) },
  'kanban.create_task': { params: Board.extend({ task: Loose }), result: TaskEnvelope },
  'kanban.patch_task': { params: Board.extend({ task_id: z.string(), patch: Loose }), result: TaskEnvelope },
  'kanban.task_action': { params: Board.extend({ task_id: z.string(), action: z.enum(['block', 'unblock']), reason: z.string().nullable().optional() }), result: TaskEnvelope },
  'kanban.comment': { params: Board.extend({ task_id: z.string(), body: z.string(), author: z.string().optional() }), result: z.object({ ok: z.literal(true), comment_id: z.union([z.number().int(), z.string()]), read_only: z.boolean() }) },
  'kanban.link': { params: Board.extend({ parent_id: z.string(), child_id: z.string() }), result: z.object({ ok: z.literal(true), parent_id: z.string(), child_id: z.string(), read_only: z.boolean() }) },
  'kanban.unlink': { params: Board.extend({ parent_id: z.string(), child_id: z.string() }), result: z.object({ ok: z.literal(true), changed: z.boolean(), parent_id: z.string(), child_id: z.string(), read_only: z.boolean() }) },
  'kanban.normalize_board': { params: Board, result: z.object({ board: z.string() }) },
  'kanban.events': { params: Board.extend({ since: z.number().int().optional(), limit: z.number().int().optional() }), result: z.object({ events: z.array(KanbanEventSchema), cursor: z.number().int(), latest_event_id: z.number().int(), read_only: z.boolean() }) },
  'kanban.config': { params: Board, result: z.object({ columns: z.array(z.string()), assignees: z.array(KanbanAssigneeSchema), default_tenant: z.string(), lane_by_profile: z.boolean(), include_archived_by_default: z.boolean(), render_markdown: z.boolean(), read_only: z.boolean() }) },
  'kanban.stats': { params: Board, result: Loose },
  'kanban.assignees': { params: Board, result: z.object({ assignees: z.array(KanbanAssigneeSchema) }) },
  'kanban.task_log': { params: Board.extend({ task_id: z.string(), tail: z.number().int().optional() }), result: z.object({ task_id: z.string(), path: z.string(), exists: z.boolean(), size_bytes: z.number().int(), content: z.string(), truncated: z.boolean() }) },
  'kanban.bulk': { params: Board.extend({ bulk: Loose }), result: z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })), read_only: z.boolean() }) },
  'kanban.dispatch': { params: Board.extend({ dry_run: z.boolean().optional(), max: z.number().int().optional() }), result: Loose },
} as const

// ── state_db ───────────────────────────────────────────────────────────
const Session = ProfileHomeParams.extend({ session_id: z.string().min(1) })
export const STATE_DB_METHODS = {
  'state_db.sync_start': { params: Session.extend({ model: z.string().nullable().optional() }), result: Ok },
  'state_db.sync_usage': { params: Session.extend({ input_tokens: z.number().int().optional(), output_tokens: z.number().int().optional(), estimated_cost: z.number().nullable().optional(), model: z.string().nullable().optional(), title: z.string().nullable().optional(), message_count: z.number().int().nullable().optional(), cache_read_tokens: z.number().int().optional(), cache_write_tokens: z.number().int().optional(), api_call_count: z.number().int().nullable().optional() }), result: Ok },
  'state_db.sync_title': { params: Session.extend({ title: z.string() }), result: Ok },
  'state_db.delete_cli_session': { params: Session, result: Ok },
} as const

// ── profiles ───────────────────────────────────────────────────────────
export const ProfileRowSchema = z.object({
  name: z.string(), path: z.string(), is_default: z.boolean(), gateway_running: z.boolean(), model: z.string().nullable(), provider: z.string().nullable(), has_env: z.boolean(),
  visible: z.boolean(), skill_count: z.number().int(), enabled_skills: z.number().int(), total_skills: z.number().int(),
})
export const PROFILES_METHODS = {
  'profiles.list': { params: BaseHomeParams, result: z.object({ profiles: z.array(ProfileRowSchema) }) },
  'profiles.create': { params: BaseHomeParams.extend({ name: z.string().min(1), clone_from: z.string().nullable().optional(), clone_config: z.boolean().optional() }), result: z.object({ profile: ProfileRowSchema }) },
  'profiles.delete': { params: BaseHomeParams.extend({ name: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },
  'profiles.runtime_env': { params: ProfileHomeParams.extend({ protected_keys: z.array(z.string()).optional() }), result: z.object({ env: z.record(z.string(), z.string()) }) },
  'profiles.skills_stats': { params: ProfileHomeParams, result: z.object({ enabled: z.number().int(), total: z.number().int() }) },
} as const

// ── skills ─────────────────────────────────────────────────────────────
export const SkillRowSchema = z.object({ name: z.string(), description: z.string(), category: z.string().nullable(), disabled: z.boolean() })
export const SkillViewSchema = z.union([
  z.object({ success: z.literal(true), name: z.string(), description: z.string(), tags: z.array(z.string()), related_skills: z.array(z.string()), content: z.string(), path: z.string(), skill_dir: z.string().nullable(), linked_files: z.record(z.string(), z.array(z.string())) }),
  z.object({ success: z.literal(false), error: z.string(), available_skills: z.array(z.string()).optional(), available_skills_truncated: z.boolean().optional(), total_skills: z.number().int().optional(), hint: z.string().optional() }),
])
export const SKILLS_METHODS = {
  'skills.list': { params: ProfileHomeParams.extend({ category: z.string().nullable().optional() }), result: z.object({ success: z.boolean().optional(), skills: z.array(SkillRowSchema), categories: z.array(z.string()), count: z.number().int(), message: z.string().optional() }) },
  'skills.view': { params: ProfileHomeParams.extend({ name: z.string().min(1) }), result: SkillViewSchema },
  'skills.find': { params: ProfileHomeParams.extend({ name: z.string().min(1) }), result: z.object({ found: z.boolean(), skill_dir: z.string().nullable(), skill_md: z.string().nullable() }) },
} as const

// ── mcp ────────────────────────────────────────────────────────────────
export const MCP_METHODS = {
  'mcp.status': { params: ProfileHomeParams, result: z.object({ servers: z.array(z.object({ name: z.string() }).catchall(Json)) }) },
  'mcp.registry_tools': { params: ProfileHomeParams, result: z.object({ tools: z.array(z.object({ name: z.string(), server: z.string(), schema: Loose })) }) },
  'mcp.reload': { params: ProfileHomeParams, result: z.object({ output: z.string() }) },
} as const

// ── stt ────────────────────────────────────────────────────────────────
export const STT_METHODS = {
  'stt.capability': { params: ProfileHomeParams, result: z.object({ available: z.boolean(), provider: z.string() }) },
  'stt.transcribe': { params: ProfileHomeParams.extend({ audio_b64: z.string().min(1), suffix: z.string().optional() }), result: z.object({ transcript: z.string() }) },
} as const

// ── cron ───────────────────────────────────────────────────────────────
export const CronJobSchema = z.object({ id: z.string(), name: z.string().nullable().optional(), profile: z.string().nullable(), toast_notifications: z.boolean(), monitor: z.string(), continuity: z.boolean() }).catchall(Json)
const CronJob = ProfileHomeParams.extend({ job_id: z.string().min(1) })
const JobEnvelope = z.object({ job: CronJobSchema })
export const CronUsageSchema = z.object({ model: z.string().optional(), provider: z.string().optional(), estimated_cost_usd: z.number().optional(), duration_seconds: z.number().optional(), input_tokens: z.number().int().nullable().optional(), output_tokens: z.number().int().nullable().optional(), total_tokens: z.number().int().nullable().optional() })
export const CRON_METHODS = {
  'cron.list': { params: ProfileHomeParams, result: z.object({ jobs: z.array(CronJobSchema) }) },
  'cron.get': { params: CronJob, result: z.object({ job: CronJobSchema.nullable() }) },
  'cron.create': { params: ProfileHomeParams.extend({ job: Loose, execution_home: z.string().nullable().optional() }), result: JobEnvelope },
  'cron.update': { params: CronJob.extend({ updates: Loose }), result: JobEnvelope },
  'cron.delete': { params: CronJob, result: z.object({ ok: z.literal(true), job_id: z.string() }) },
  // Python answered pause/resume with the raw `pause_job`/`resume_job` record (no API decoration).
  'cron.pause': { params: CronJob.extend({ reason: z.string().nullable().optional() }), result: z.object({ job: z.object({ id: z.string() }).catchall(Json) }) },
  'cron.resume': { params: CronJob, result: z.object({ job: z.object({ id: z.string() }).catchall(Json) }) },
  'cron.run': { params: CronJob.extend({ execution_home: z.string().nullable().optional() }), result: z.union([
    z.object({ job_id: z.string(), status: z.literal('already_running'), elapsed: z.number() }),
    z.object({ job_id: z.string(), status: z.enum(['completed', 'failed']), success: z.boolean(), error: z.string().nullable().optional(), delivery_error: z.string().nullable().optional() }),
  ]), stream: z.discriminatedUnion('event', [z.object({ event: z.literal('started'), data: z.object({ job_id: z.string() }) })]) },
  'cron.status': { params: z.object({ job_id: z.string().optional() }), result: z.union([z.object({ job_id: z.string(), running: z.boolean(), elapsed: z.number() }), z.object({ running: z.record(z.string(), z.number()) })]) },
  'cron.history': { params: CronJob.extend({ offset: z.number().int().optional(), limit: z.number().int().optional() }), result: z.object({ job_id: z.string(), runs: z.array(z.object({ filename: z.string(), size: z.number().int(), modified: z.number(), usage: CronUsageSchema })), total: z.number().int(), offset: z.number().int() }) },
  'cron.run_detail': { params: CronJob.extend({ filename: z.string().min(1) }), result: z.object({ job_id: z.string(), filename: z.string(), content: z.string(), snippet: z.string(), usage: CronUsageSchema }) },
  'cron.output': { params: CronJob.extend({ limit: z.number().int().optional() }), result: z.object({ job_id: z.string(), outputs: z.array(z.object({ filename: z.string(), content: z.string() })) }) },
  'cron.delivery_options': { params: z.object({}), result: z.object({ platforms: z.array(z.object({ value: z.string(), label: z.string() })) }) },
} as const

// ── providers / models ─────────────────────────────────────────────────
export const PROVIDERS_METHODS = {
  'providers.registry': { params: ProfileHomeParams, result: z.object({ providers: z.record(z.string(), z.object({ id: z.string(), name: z.string(), auth_type: z.string() }).catchall(Json)) }) },
  'providers.auth_status': { params: ProfileHomeParams.extend({ provider: z.string().nullable().optional() }), result: z.object({ status: z.object({ logged_in: z.boolean() }).catchall(Json) }) },
  'providers.model_ids': { params: ProfileHomeParams.extend({ provider: z.string().min(1), force_refresh: z.boolean().optional() }), result: z.object({ provider: z.string(), model_ids: z.array(z.string()) }) },
  'providers.resolve_runtime': { params: ProfileHomeParams.extend({ requested: z.string().nullable().optional(), api_key: z.string().nullable().optional(), base_url: z.string().nullable().optional(), target_model: z.string().nullable().optional() }), result: z.object({ runtime: Loose }) },
  'providers.credential_pool': { params: ProfileHomeParams.extend({ provider: z.string().min(1) }), result: z.object({ available: z.boolean(), strategy: z.string(), entries: z.array(Loose) }) },
  'models.context_length': { params: ProfileHomeParams.extend({ model: z.string().min(1), base_url: z.string().optional(), api_key: z.string().optional(), provider: z.string().optional(), config_context_length: z.number().int().nullable().optional() }), result: z.object({ model: z.string(), context_length: z.number().int().nullable() }) },
  'models.estimate_tokens': { params: z.object({ messages: z.array(Loose) }), result: z.object({ tokens: z.number().int() }) },
  'models.capabilities': { params: ProfileHomeParams.extend({ provider: z.string(), model: z.string() }), result: z.object({ capabilities: Loose.nullable() }) },
} as const

// ── oauth ──────────────────────────────────────────────────────────────
/**
 * TAL-398: an Agent device-code sign-in (Nous Portal, OpenAI Codex, xAI, MiniMax) the sidecar runs for one profile home.
 * `oauth.start` answers the code to show; a sidecar thread polls the provider and writes the credential through the
 * Agent's own auth store. A flow belongs to the profile home that started it: poll and cancel from another home do not
 * find it. `error` is the Agent's reason for a flow that ended without a credential.
 */
export const OAuthFlowStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled', 'error'])
const OAuthFlow = z.object({ flow_id: z.string(), provider: z.string(), status: OAuthFlowStatusSchema, error: z.string().nullable() })
const OAuthFlowParams = ProfileHomeParams.extend({ flow_id: z.string().min(1) })
export const OAUTH_METHODS = {
  'oauth.start': { params: ProfileHomeParams.extend({ provider: z.string().min(1) }), result: z.object({ flow_id: z.string(), provider: z.string(), status: z.literal('pending'), user_code: z.string(), verification_url: z.string(), expires_in: z.number().int(), interval: z.number().int() }) },
  'oauth.poll': { params: OAuthFlowParams, result: OAuthFlow },
  'oauth.cancel': { params: OAuthFlowParams, result: OAuthFlow },
} as const

// ── aux / text / process / usage / gateway ─────────────────────────────
export const AuxUsageSchema = z.object({ prompt_tokens: z.number().int().optional(), completion_tokens: z.number().int().optional(), total_tokens: z.number().int().optional() })
export const AUX_METHODS = {
  'aux.complete': { params: ProfileHomeParams.extend({ task: z.string().min(1), messages: z.array(Loose).min(1), main_runtime: Loose.nullable().optional(), main_fallback: z.boolean().optional(), max_tokens: z.number().int().nullable().optional(), temperature: z.number().nullable().optional() }), result: z.object({ model: z.string(), text: z.string(), usage: AuxUsageSchema.nullable() }), stream: z.discriminatedUnion('event', [z.object({ event: z.literal('token'), data: z.object({ text: z.string() }) })]) },
  'aux.resolve': { params: ProfileHomeParams.extend({ task: z.string().min(1), main_runtime: Loose.nullable().optional() }), result: z.object({ configured: z.boolean(), model: z.string().nullable(), error: z.string().optional() }) },
} as const
export const TEXT_METHODS = {
  'text.image_mode': { params: ProfileHomeParams.extend({ provider: z.string(), model: z.string(), cfg: Loose.nullable().optional(), requested_provider: z.string().optional() }), result: z.object({ mode: z.enum(['native', 'text']), reason: z.string(), supports_vision: z.boolean().nullable() }) },
  'text.portal_tags': { params: ProfileHomeParams, result: z.object({ client_tag: z.string().nullable(), conversation_tag: z.string().nullable(), tags: z.union([z.array(z.string()), Loose]) }) },
} as const
export const ProcessEventSchema = z.object({ process_id: z.string(), consumed: z.boolean(), type: z.string().optional(), session_key: z.string().optional(), origin_ui_session_id: z.string().optional() }).catchall(Json)
export const PROCESS_METHODS = {
  'process.drain': { params: ProfileHomeParams.extend({ max_events: z.number().int().positive().optional() }), result: z.object({ events: z.array(ProcessEventSchema) }) },
  'process.requeue': { params: z.object({ events: z.array(Loose) }), result: z.object({ requeued: z.number().int() }) },
  'process.mark_consumed': { params: z.object({ process_id: z.string().min(1) }), result: Ok },
  /** TAL-459: the Agent's durable delivery ledger. A null claim means another consumer delivered (or holds) it; "" means nothing durable to acknowledge. */
  'process.claim_delivery': { params: ProfileHomeParams.extend({ event: Loose, consumer: z.string().min(1) }), result: z.object({ claim_id: z.string().nullable() }) },
  'process.complete_delivery': { params: ProfileHomeParams.extend({ event: Loose, claim_id: z.string() }), result: Ok },
  'process.release_delivery': { params: ProfileHomeParams.extend({ event: Loose, claim_id: z.string() }), result: Ok },
  /** Hands back a claim the busy target never admitted, without spending one of the Agent's delivery attempts. */
  'process.defer_delivery': { params: ProfileHomeParams.extend({ event: Loose, claim_id: z.string() }), result: Ok },
  'process.format_notification': { params: z.object({ event: Loose }), result: z.object({ text: z.string() }) },
  'process.list': { params: ProfileHomeParams, result: z.object({ sessions: z.array(Loose) }) },
  /** TAL-372: the Agent's view of these WebUI sessions' background work: ledger delegations (with live status) and notified processes. */
  'process.background_list': {
    params: ProfileHomeParams.extend({ session_ids: z.array(z.string().min(1)) }),
    result: z.object({
      delegations: z.array(z.object({
        delegation_id: z.string(), origin_ui_session_id: z.string(), state: z.string(), dispatched_at: z.number().nullable(), completed_at: z.number().nullable(),
        updated_at: z.number().nullable(), goals: z.array(z.string()), child_statuses: z.array(z.string()), has_result: z.boolean(), live_status: z.string().nullable(),
        /** TAL-494: the subagent sessions this unit ran (absent from a sidecar before TAL-494). */
        children: z.array(z.object({ goal: z.string(), session_id: z.string() })).optional(),
      })),
      processes: z.array(z.object({
        process_id: z.string(), session_key: z.string(), command: z.string(), started_at: z.number().nullable(), exited: z.boolean(), exited_at: z.number().nullable(),
        exit_code: z.number().int().nullable(), completion_reason: z.string(), watched: z.boolean(),
      })),
    }),
  },
  'process.delegation_result': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), delegation_id: z.string().min(1) }), result: z.object({ text: z.string() }) },
} as const
export const AccountUsageSnapshotSchema = z.object({ provider: z.string().nullable(), available: z.boolean(), unavailable_reason: z.string().nullable().optional(), windows: z.array(Loose), details: z.array(Json) }).catchall(Json)
export const USAGE_METHODS = {
  'usage.account': { params: ProfileHomeParams.extend({ provider: z.string().min(1), base_url: z.string().nullable().optional(), api_key: z.string().nullable().optional() }), result: z.object({ snapshot: AccountUsageSnapshotSchema.nullable() }) },
} as const
export const CONFIG_METHODS = {
  // `config_path` is the server-resolved file (honouring HERMES_CONFIG_PATH); the sidecar reads and writes exactly that path.
  'config.get': { params: ProfileHomeParams.extend({ config_path: z.string().min(1) }), result: z.object({ path: z.string(), exists: z.boolean(), config: Loose }) },
  'config.set': { params: ProfileHomeParams.extend({ config_path: z.string().min(1), config: Loose }), result: z.object({ ok: z.literal(true), path: z.string() }) },
  'models.reasoning_efforts': { params: ProfileHomeParams.extend({ model: z.string(), provider: z.string() }), result: z.object({ efforts: z.array(z.string()), supports_reasoning: z.boolean().nullable() }) },
} as const
export const WORKTREE_METHODS = {
  'worktree.create': { params: ProfileHomeParams.extend({ repo_root: z.string().min(1) }), result: z.object({ path: z.string(), branch: z.string(), repo_root: z.string(), base: z.string().nullable() }) },
} as const
// ── chat / approval / clarify ──────────────────────────────────────────
export const ChatUsageSchema = z.object({ prompt_tokens: z.number().int(), completion_tokens: z.number().int(), cache_read_tokens: z.number().int(), cache_write_tokens: z.number().int(), estimated_cost_usd: z.number().nullable() })
/** `failed`, `partial`, and `compression_exhausted` are the Agent's own turn-result flags, forwarded as sent; `failed` also sets `status: 'error'`. */
export const ChatStartResultSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'error']), messages: z.array(Loose), final_response: z.string(), error: z.string().nullable(),
  failed: z.boolean(), partial: z.boolean(), compression_exhausted: z.boolean(),
  tool_limit_reached: z.boolean(), usage: ChatUsageSchema, context: Loose, model: z.string(), provider: z.string(), compressed: z.boolean(), agent_session_id: z.string(),
  token_sent: z.boolean(), pending_steer: z.string(), live_tool_calls: z.array(Loose),
})
const Text = z.object({ text: z.string() }).catchall(Json)
/**
 * A `tool_complete` frame carries `raw_result` (through the catch-all): the result object's first 64 top-level fields
 * (scalars as sent, text and nested values as capped text) or its capped text. The server decides `is_error` from it and never forwards it; `is_error` is only an older sidecar's `false`.
 */
const ToolFrame = z.object({ event_type: z.string(), name: z.string().nullable().optional(), preview: Json.optional(), args: Loose.optional(), tid: z.string().optional(), is_error: z.boolean().optional() }).catchall(Json)
export const ChatStreamSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('token'), data: Text }),
  z.object({ event: z.literal('reasoning'), data: Text }),
  /** The Agent's pending steer text before a content frame (server-side steer consumption). */
  z.object({ event: z.literal('steer_pending'), data: Text }),
  z.object({ event: z.literal('interim_assistant'), data: Text }),
  z.object({ event: z.literal('tool'), data: ToolFrame }),
  z.object({ event: z.literal('tool_complete'), data: ToolFrame }),
  z.object({ event: z.literal('approval'), data: Loose }),
  z.object({ event: z.literal('clarify'), data: Loose }),
  z.object({ event: z.literal('clarify_resolved'), data: Loose }),
  z.object({ event: z.literal('compressing'), data: Loose }),
  z.object({ event: z.literal('warning'), data: Loose }),
  z.object({ event: z.literal('status'), data: Loose }),
])
export const CHAT_METHODS = {
  'chat.start': {
    params: ProfileHomeParams.extend({
      session_id: z.string().min(1), stream_id: z.string().min(1), workspace: z.string(), model: z.string(), model_provider: z.string().nullable().optional(),
      user_message: z.union([z.string(), z.array(Loose)]), system_message: z.string().nullable().optional(), conversation_history: z.array(Loose),
      enabled_toolsets: z.array(z.string()).nullable().optional(), max_iterations: z.number().int().nullable().optional(), max_tokens: z.number().int().nullable().optional(),
      clarify_timeout_seconds: z.number().nullable().optional(),
      /** Python `parse_reasoning_effort` output (`{enabled, effort}`) and the WebUI-only runtime instructions. */
      reasoning_config: z.object({ enabled: z.boolean(), effort: z.string().optional() }).nullable().optional(), ephemeral_system_prompt: z.string().nullable().optional(),
    }),
    result: ChatStartResultSchema,
    stream: ChatStreamSchema,
  },
  'chat.interrupt': {
    params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional() }),
    /** `checkpoint`: the Agent's canonical transcript for the stopped turn, captured before the interrupt (absent until it has one). */
    result: z.object({ ok: z.boolean(), reason: z.string().optional(), pending_steer: z.string().optional(), checkpoint: z.array(Loose).optional() }),
  },
  /** `can_redirect`: the Agent can deliver a pending steer now (TAL-424 Send now). */
  'chat.steer': { params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional(), text: z.string().min(1) }), result: z.object({ accepted: z.boolean(), fallback: z.string().nullable().optional(), can_redirect: z.boolean().optional() }) },
  /**
   * TAL-424: take `pending[index]` back out of the Agent's pending steer slot (Edit, Cancel). `pending` is the server's
   * not-yet-consumed steer texts, oldest first. `withdrawn: false` when the Agent already took it; the slot is untouched.
   */
  'chat.steer_withdraw': { params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional(), pending: z.array(z.string().min(1)).min(1), index: z.number().int().nonnegative() }), result: z.object({ withdrawn: z.boolean() }) },
  /**
   * TAL-424: deliver `pending[index]` now with the Agent's `redirect`: `delivery: redirect` restarts the model request with
   * it, `delivery: steer` puts it last on the slot while tools yield. Not redirected: it stays pending, `requeued` in its
   * place (`kept`) or last (`last`); `withdrawn: false` when the Agent already took it.
   */
  'chat.steer_now': {
    params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional(), pending: z.array(z.string().min(1)).min(1), index: z.number().int().nonnegative() }),
    result: z.object({ redirected: z.boolean(), withdrawn: z.boolean(), delivery: z.enum(['redirect', 'steer']).optional(), requeued: z.enum(['kept', 'last']).optional() }),
  },
  /**
   * TAL-255: manual `/compress` of `conversation_history` through the Agent's `compress_now` on a throwaway agent. Nothing is
   * persisted: the server installs `messages` as the session's model context. `message` is the Agent's text for a result
   * that did not compress; `agent_session_id` is the state.db id after a possible rotation. A compressed result holds its
   * Agent's context-engine notification until `chat.compress_finalize` reports whether the server installed it.
   */
  'chat.compress': {
    params: ProfileHomeParams.extend({
      session_id: z.string().min(1), model: z.string(), model_provider: z.string().nullable().optional(), conversation_history: z.array(Loose),
      focus_topic: z.string().nullable().optional(), enabled_toolsets: z.array(z.string()).nullable().optional(),
    }),
    result: z.object({
      status: z.enum(['compressed', 'lock_skipped', 'nothing_to_do']), messages: z.array(Loose), before_tokens: z.number().int(), after_tokens: z.number().int(),
      summary: z.looseObject({ headline: z.string().optional(), token_line: z.string().optional(), note: z.string().nullable().optional() }).nullable(), message: z.string().nullable(), agent_session_id: z.string(),
      commit_token: z.string().nullable(),
    }),
  },
  /** TAL-255: second phase of `chat.compress`; `finalized: false` when the token is unknown or already expired. */
  'chat.compress_finalize': { params: z.object({ commit_token: z.string().min(1), committed: z.boolean() }), result: z.object({ finalized: z.boolean() }) },
  'chat.evict_agent': { params: z.object({ session_id: z.string().min(1) }), result: z.object({ evicted: z.boolean() }) },
  'chat.commit_memory': { params: z.object({ session_id: z.string().min(1) }), result: z.object({ committed: z.boolean() }) },
  'approval.respond': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), choice: z.enum(['once', 'session', 'always', 'deny']), request_id: z.string().nullable().optional() }), result: z.object({ ok: z.boolean(), resolved: z.number().int(), choice: z.string() }) },
  'approval.pending': { params: z.object({ session_id: z.string().min(1) }), result: z.object({ pending: z.array(Loose) }) },
  'approval.set_yolo': { params: z.object({ session_id: z.string().min(1), enabled: z.boolean() }), result: z.object({ yolo_enabled: z.boolean(), released: z.number().int() }) },
  'clarify.respond': { params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional(), clarify_id: z.string().optional(), response: z.string().min(1) }), result: z.object({ ok: z.boolean(), clarify_id: z.string().optional() }) },
} as const
export const GATEWAY_METHODS = {
  'gateway.restart': { params: ProfileHomeParams.extend({ cli_profile: z.string().nullable().optional(), quick_timeout_seconds: z.number().optional(), background_wait_seconds: z.number().optional() }), result: z.object({ status: z.enum(['completed', 'failed', 'busy']), message: z.string(), detail: z.string().optional(), returncode: z.number().int().optional() }), stream: z.discriminatedUnion('event', [z.object({ event: z.literal('progress'), data: z.object({ phase: z.enum(['started', 'draining']) }) })]) },
} as const
