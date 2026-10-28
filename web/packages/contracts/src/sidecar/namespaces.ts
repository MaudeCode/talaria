import { OutboundDraftRefSchema, OutboundDraftFieldsSchema, OutboundDraftResultSchema } from '../outbound-drafts.js'
import { McpCostPolicyDataSchema } from '../mcp-cost-policy.js'
import { ContextDetailSchema } from '../context-detail.js'
import { z } from 'zod'
import { ProviderPhaseSchema } from '../run-status.js'
import { SpeedTierSchema } from '../speed.js'
import { GatewayClarifyBatchSchema, GatewayCreateParamsSchema, GatewaySessionParamsSchema, GatewaySessionResultSchema } from '../gateway-session.js'

/** Warnings and wording come from the Agent's selection guard registry, including future guard kinds. */
export const ModelSelectionWarningSchema = z.object({ kind: z.string(), title: z.string(), model: z.string(), provider: z.string(), message: z.string() })

/** Shared param shapes. */
export const ProfileHomeParams = z.object({ profile_home: z.string().min(1) })
export const BaseHomeParams = z.object({ base_home: z.string().min(1) })
const Ok = z.object({ ok: z.boolean() })
const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())

/** Profile-scoped toolset choices; clients render policy and selection without deriving them. */
export const ToolsetsCatalogSchema = z.object({
  toolsets: z.array(z.object({
    name: z.string(), description: z.string(), available: z.boolean(), selected: z.boolean(),
    unavailable_reason: z.enum(['disabled', 'unavailable']).nullable(),
  })),
  selected_toolsets: z.array(z.string()), using_defaults: z.boolean(),
})
export const TOOLSETS_METHODS = {
  'toolsets.catalog': { params: ProfileHomeParams.extend({ enabled_toolsets: z.array(z.string()).nullable() }), result: ToolsetsCatalogSchema },
} as const

// ── goals ──────────────────────────────────────────────────────────────
export const GoalStateSchema = z.object({
  goal: z.string(), status: z.string(), turns_used: z.number().int(), max_turns: z.number().int(),
  last_verdict: z.string().nullable(), last_reason: z.string().nullable(), paused_reason: z.string().nullable(),
})
const GoalSession = ProfileHomeParams.extend({ session_id: z.string().min(1), default_max_turns: z.number().int().positive().optional() })
/** TAL-808: `parked` is an active goal's live wait barrier: its reason and, for a timed wait, the Unix-seconds deadline. */
export const GoalParkedSchema = z.object({ reason: z.string().nullable(), until: z.number().nullable() })
export const GoalStatusSchema = z.object({ goal: GoalStateSchema.nullable(), active: z.boolean(), parked: GoalParkedSchema.nullable(), message: z.string(), message_key: z.string().optional(), message_args: z.array(Json).optional() })
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
  // `workspace`: the session's declared workspace, where the Agent runs goal gates (TAL-882).
  'goals.command': { params: GoalSession.extend({ args: z.string(), stream_running: z.boolean().optional(), workspace: z.string().optional() }), result: GoalCommandResultSchema },
  'goals.snapshot': { params: GoalSession, result: z.object({ goal: GoalStateSchema.nullable(), snapshot: z.string().nullable() }) },
  'goals.restore': { params: GoalSession.extend({ snapshot: z.string().nullable() }), result: z.object({ goal: GoalStateSchema.nullable() }) },
  'goals.evaluate': { params: GoalSession.extend({ last_response: z.string(), user_initiated: z.boolean().optional(), workspace: z.string().optional() }), result: GoalDecisionSchema },
} as const

// ── commands / plugins ─────────────────────────────────────────────────
export const CommandSchema = z.object({
  name: z.string(), description: z.string(), category: z.string(), aliases: z.array(z.string()), args_hint: z.string(), subcommands: z.array(z.string()),
  cli_only: z.boolean(), gateway_only: z.boolean(),
  /** `commands.exec` runs it: the sidecar's runtime commands and every plugin command (TAL-561). */
  exec: z.boolean(),
  /**
   * An Agent prompt built-in, which every Agent surface answers by sending its builder's prompt as the turn (TAL-817):
   * `expand` when `commands.expand_prompt` can build it on this Agent, `unsupported` when it cannot; null for any other command.
   */
  prompt: z.enum(['expand', 'unsupported']).nullable(),
})
/**
 * A model-provider plugin installed and enabled in the profile (TAL-288); bundled providers are built-ins. `setup` is the Agent's
 * own verdict without spawning the plugin's CLI: `not_loaded` means the installed plugin could not be loaded (import failure, or its
 * provider id or directory name is taken by another profile's plugin in this process-wide registry).
 */
/**
 * TAL-806: one field of a plugin manifest's `config_schema` (Agent `plugin_settings_fields`) with its current value from
 * `plugins.entries.<key>.settings`, else `default`. A `secret` field carries its `.env` name and `has_value`, never a value.
 */
export const PluginSettingFieldSchema = z.object({
  key: z.string(), type: z.enum(['string', 'number', 'boolean', 'enum', 'json', 'secret']), label: z.string(), description: z.string(), required: z.boolean(),
  choices: z.array(z.string()).optional(), default: Json.optional(), value: Json.optional(), env: z.string().optional(), has_value: z.boolean().optional(),
})
export type PluginSettingField = z.infer<typeof PluginSettingFieldSchema>
/** Persistence succeeded; this separately describes application to live plugin MCP connections. */
export const PluginRuntimeApplicationSchema = z.enum(['applied', 'restart_required', 'unknown'])

/** TAL-1276: one OAuth client a plugin manifest declares, its grant's state as `hermes auth status` maps it, and the hosts the code is approved at and exchanged at. */
export const PluginOAuthStateSchema = z.enum(['signed_in', 'sign_in_needed', 'revoked', 'logged_out'])
export const PluginOAuthClientSchema = z.object({ id: z.string(), state: PluginOAuthStateSchema, authorize_host: z.string(), token_host: z.string() })
export type PluginOAuthClient = z.infer<typeof PluginOAuthClientSchema>
export const PluginUpdateResultSchema = z.discriminatedUnion('status', [
  z.object({ key: z.string(), status: z.literal('updated') }),
  z.object({ key: z.string(), status: z.literal('needs_consent'), verdict: z.literal('caution'), findings: z.string(), consent_token: z.string().min(1) }),
  z.object({ key: z.string(), status: z.literal('blocked'), verdict: z.string(), findings: z.string() }),
])
export type PluginUpdateResult = z.infer<typeof PluginUpdateResultSchema>

export const PluginCatalogQuerySchema = z.object({ query: z.string().trim().max(200).default(''), offset: z.coerce.number().int().min(0).max(10000).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) })
export const PluginInstallInputSchema = z.object({ name: z.string().regex(/^[a-z0-9_-]{1,64}$/), consent_token: z.string().min(1).max(128).optional() })
export const PluginCatalogSchema = z.object({ supported: z.boolean(), read_only: z.boolean().optional(), entries: z.array(z.object({
  name: z.string(), title: z.string(), description: z.string(), repo: z.string(), sha: z.string(), tier: z.string(), category: z.string(),
  requirements: z.array(z.string()), installed_key: z.string().nullable(), installed_sha: z.string().nullable(), can_install: z.boolean(), refusal: z.string().nullable(),
})), total: z.number().int().nonnegative(), next_offset: z.number().int().nullable() })
export const PluginInstallResultSchema = z.discriminatedUnion('status', [
  z.object({ name: z.string(), key: z.string(), status: z.literal('installed'), enabled: z.literal(false) }),
  z.object({ name: z.string(), status: z.literal('needs_consent'), findings: z.string(), consent_token: z.string() }),
  z.object({ name: z.string(), status: z.literal('blocked'), findings: z.string() }),
])
export type PluginInstallResult = z.infer<typeof PluginInstallResultSchema>
export type PluginCatalog = z.infer<typeof PluginCatalogSchema>
export const PluginProviderSchema = z.object({ name: z.string(), display_name: z.string(), auth_type: z.string(), setup: z.enum(['ready', 'missing_cli', 'needs_setup', 'not_loaded', 'unavailable']) })
/** Profile-owned Agent dashboards use Web protocol panels; native Desktop bundles need migration. */
export const AgentDashboardPluginSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), label: z.string().max(80), version: z.string().max(40), description: z.string().max(300),
  enabled: z.boolean(), panel: z.string().nullable(), has_api: z.boolean(),
})
export const AgentDashboardResponseSchema = z.object({ status: z.number().int().min(200).max(599), body: z.string(), content_type: z.string() })
const DashboardNameParams = ProfileHomeParams.extend({ name: z.string() })

/** A skill bundle: `/<name>` loads its `skill_count` skills in one message (TAL-265). */
export const CommandBundleSchema = z.object({ name: z.string(), description: z.string(), skill_count: z.number().int(), source: z.literal('bundle') })
/** `message` is the user message that loads the bundle's skills; members not installed or disabled are in `missing_skills` or left out. */
export const CommandBundleInvocationSchema = z.object({ name: z.string(), source: z.literal('bundle'), message: z.string(), loaded_skills: z.array(z.string()), missing_skills: z.array(z.string()) })
export const MAX_MANAGED_BUFFER_BYTES = 256 * 1024
const ManagedBufferName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const ManagedBufferSize = z.number().int().min(0).max(MAX_MANAGED_BUFFER_BYTES)

export const COMMANDS_METHODS = {
  'drafts.review': { params: OutboundDraftRefSchema.extend({ profile_home: z.string().min(1), session_id: z.string().min(1), action: z.enum(['read', 'edit', 'approve']), version: z.number().int().positive().optional(), revision: z.string().optional(), fields: OutboundDraftFieldsSchema.optional() }), result: OutboundDraftResultSchema },
  'commands.registry': { params: ProfileHomeParams, result: z.object({ commands: z.array(CommandSchema) }) },
  /**
   * With `session_id`, a plugin command runs under that chat's session binding and `workspace` (TAL-904) and receives the session
   * as its handler declares it; every recognised command fires the Agent's `pre_command` hook with that session (TAL-1267).
   */
  'commands.exec': { params: ProfileHomeParams.extend({ command: z.string().min(1), session_id: z.string().min(1).optional(), workspace: z.string().optional() }), result: z.object({ output: z.string(), source: z.enum(['agent', 'plugin']) }) },
  /**
   * `/<prompt built-in> [args]` as the turn text (`message`) the Agent's builder writes for the session's profile, workspace and toolsets.
   * `name` is the built-in's canonical name, null when the command is not one; `message` is null when this Agent has no builder for it.
   * A failing builder errors `prompt_expand_failed`. Every built-in fires the Agent's `pre_command` hook with `session_id` (TAL-1279).
   */
  'commands.expand_prompt': { params: ProfileHomeParams.extend({ command: z.string().min(1), session_id: z.string().min(1).optional(), workspace: z.string(), enabled_toolsets: z.array(z.string()).nullable() }), result: z.object({ name: z.string().nullable(), message: z.string().nullable() }) },
  'commands.bundles': { params: ProfileHomeParams, result: z.object({ bundles: z.array(CommandBundleSchema) }) },
  'commands.bundle_resolve': { params: ProfileHomeParams.extend({ command: z.string().min(1) }), result: CommandBundleInvocationSchema },
  'commands.moa_preset': { params: ProfileHomeParams.extend({ preset: z.string().nullable().optional() }), result: z.object({ moa: Loose }) },
  /** Fixed devkit buffer adapter. No arbitrary HTTP paths, promotion or cleanup. Native saves are unconditional. */
  'plugins.buffers': {
    params: ProfileHomeParams.extend({ action: z.enum(['list', 'read', 'save']), session_id: z.string().min(1).max(200), name: ManagedBufferName.optional(), content: z.string().max(MAX_MANAGED_BUFFER_BYTES).optional() }),
    result: z.object({ supported: z.boolean(), buffers: z.array(z.object({ name: ManagedBufferName, size: ManagedBufferSize, read_only: z.boolean() })).max(200), content: z.string().max(MAX_MANAGED_BUFFER_BYTES).optional(), size: ManagedBufferSize.optional(), read_only: z.boolean().optional(), write_semantics: z.literal('unconditional') }),
  },
  'plugins.dashboard_list': { params: ProfileHomeParams, result: z.object({ supported: z.boolean(), plugins: z.array(AgentDashboardPluginSchema) }) },
  'plugins.dashboard_toggle': { params: DashboardNameParams.extend({ enabled: z.boolean() }), result: z.object({ ok: z.literal(true) }) },
  'plugins.dashboard_asset': { params: DashboardNameParams.extend({ path: z.string() }), result: AgentDashboardResponseSchema },
  /** Buffered HTTP only. Cancellation abandons the result; the Agent has no handler-cancel operation. */
  'plugins.dashboard_request': { params: DashboardNameParams.extend({ path: z.string(), method: z.string(), query: z.string(), headers: z.record(z.string(), z.string()), body: z.string(), authenticated: z.boolean(), websocket: z.boolean() }), result: AgentDashboardResponseSchema },
  'plugins.providers': { params: ProfileHomeParams, result: z.object({ providers: z.array(PluginProviderSchema) }) },
  'plugins.list': { params: ProfileHomeParams.extend({ selected_providers: z.record(z.string(), z.string()).optional() }), result: z.object({ plugins: z.array(z.object({ name: z.string(), key: z.string(), version: z.string(), description: z.string(), enabled: z.boolean(), kind: z.string(), activation: z.string(), hooks: z.array(z.string()), is_active_provider: z.boolean().optional(), update_available: z.boolean().optional(), latest_revision: z.string().optional() })), supported_hooks: z.array(z.string()) }) },
  'plugins.catalog': { params: ProfileHomeParams.extend(PluginCatalogQuerySchema.shape), result: PluginCatalogSchema },
  'plugins.install': { params: ProfileHomeParams.extend(PluginInstallInputSchema.shape), result: PluginInstallResultSchema },
  'plugins.update': { params: ProfileHomeParams.extend({ key: z.string().min(1), accept_caution: z.boolean().optional(), consent_token: z.string().min(1).max(128).optional() }), result: PluginUpdateResultSchema },
  /** TAL-820: each profile's `plugins.isolation` and installed third-party plugin count, read without loading a plugin. */
  'plugins.isolation': { params: BaseHomeParams, result: z.object({ profiles: z.array(z.object({ name: z.string(), isolation: z.enum(['in_process', 'host']), third_party_plugins: z.number().int() })) }) },
  /** TAL-806: plugins whose manifest declares settings; `supported` is false on an Agent without `hermes_cli.plugins_settings`. */
  'plugins.settings': { params: ProfileHomeParams, result: z.object({ supported: z.boolean(), plugins: z.array(z.object({ key: z.string(), fields: z.array(PluginSettingFieldSchema) })) }) },
  /**
   * TAL-1276: plugins whose manifest declares OAuth clients (Agent v0.22.3+), each client's sign-in state as
   * `hermes auth status <plugin>:<id>` reports it, and the hosts the CLI names before signing in: the code is approved
   * at `authorize_host` and exchanged at `token_host`. `supported` is false on an Agent without the plugin OAuth helpers.
   */
  'plugins.oauth_status': { params: ProfileHomeParams, result: z.object({ supported: z.boolean(), plugins: z.array(z.object({ key: z.string(), clients: z.array(PluginOAuthClientSchema) })) }) },
  /** TAL-1276: `hermes auth logout <plugin>:<id>`; `removed` is false when no grant was stored. Errors `oauth_unsupported` on older Agents. */
  'plugins.oauth_logout': { params: ProfileHomeParams.extend({ key: z.string().min(1), id: z.string().min(1) }), result: z.object({ key: z.string(), id: z.string(), removed: z.boolean() }) },
  /**
   * TAL-806: write non-secret `values` through the Agent's locked plugin-state writer and return the refreshed fields.
   * An undeclared key, a secret or a type mismatch is invalid params; a managed install or key errors `plugin_settings_managed`.
   * `secret_envs` (secret key → `.env` name the caller wrote) is checked against the current manifest before anything is
   * written; a key that is no longer a secret stored under that name errors `plugin_settings_changed`.
   */
  'plugins.settings_save': { params: ProfileHomeParams.extend({ key: z.string().min(1), values: z.record(z.string(), Json), secret_envs: z.record(z.string(), z.string()).optional() }), result: z.object({ key: z.string(), written: z.array(z.string()), fields: z.array(PluginSettingFieldSchema), runtime_application: PluginRuntimeApplicationSchema.optional() }) },
} as const

// ── kanban ─────────────────────────────────────────────────────────────
const Board = ProfileHomeParams.extend({ board: z.string().nullable().optional() })
/** `claim_live`: a running task's worker still holds its claim. `has_completion_evidence`: the task stores a result, which the Agent requires to complete it (TAL-557).
 * `agent_move_targets`: the Agent workflow's manual moves from the task's status, `null` before Agent 0.21.6 (TAL-796). */
export const KanbanTaskSchema = z.object({ id: z.string(), title: z.string(), status: z.string(), priority: z.number().int(), claim_live: z.boolean(), has_completion_evidence: z.boolean(), agent_move_targets: z.array(z.string()).nullable() }).catchall(Json)
const TaskEnvelope = z.object({ task: KanbanTaskSchema, read_only: z.boolean() })
/** Task detail's links (TAL-809): `link_tasks` names each linked task that still exists; `current_run_started_at` is the active run's start, `null` without one (`started_at` is the first-ever start). */
export const KanbanTaskLinksShape = { links: z.object({ parents: z.array(z.string()), children: z.array(z.string()) }), link_tasks: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })) }
export const KanbanRunStartShape = { current_run_started_at: z.number().nullable() }
export const KanbanBoardSchema = z.union([
  z.object({ changed: z.literal(false), latest_event_id: z.number().int(), read_only: z.boolean() }),
  z.object({
    /** The Agent workflow's columns in board order (TAL-796): `name` is the status key, `label` the Agent's English label. */
    changed: z.literal(true), columns: z.array(z.object({ name: z.string(), label: z.string(), tasks: z.array(KanbanTaskSchema) })), tenants: z.array(z.string()), assignees: z.array(z.string()),
    latest_event_id: z.number().int(), read_only: z.boolean(),
    filters: z.object({ tenant: z.string().nullable(), assignee: z.string().nullable(), include_archived: z.boolean(), only_mine: z.boolean(), profile: z.string().nullable() }),
  }),
])
export const KanbanAssigneeSchema = z.union([z.string(), z.object({ name: z.string(), on_disk: z.boolean().optional(), counts: z.record(z.string(), z.number().int()).optional() }).catchall(Json)])
export const KanbanEventSchema = z.object({ id: z.number().int(), task_id: z.string().nullable(), run_id: z.union([z.number().int(), z.string()]).nullable(), kind: z.string(), payload: Json, created_at: z.number().nullable() })
export const KanbanBoardMetaSchema = z.object({ slug: z.string(), name: z.string().nullable().optional(), archived: z.boolean().optional() }).catchall(Json)
export const KanbanInspectionEdgeSchema = z.object({ source: z.string(), target: z.string() })
export const KanbanInspectionNodeSchema = z.object({ key: z.string(), board: z.string(), board_name: z.string(), task: KanbanTaskSchema.extend(KanbanRunStartShape) })
export const KanbanInspectionSnapshotSchema = z.object({
  nodes: z.array(KanbanInspectionNodeSchema).max(500),
  edges: z.array(KanbanInspectionEdgeSchema).max(2000), generated_at: z.number(), truncated: z.boolean(), read_only: z.boolean(),
})
export const KANBAN_METHODS = {
  'kanban.inspection': { params: Board.extend({ include_archived: z.boolean().optional() }), result: KanbanInspectionSnapshotSchema },
  'kanban.board': { params: Board.extend({ tenant: z.string().nullable().optional(), assignee: z.string().nullable().optional(), include_archived: z.boolean().optional(), only_mine: z.boolean().optional(), since: z.number().int().nullable().optional(), profile: z.string().nullable().optional() }), result: KanbanBoardSchema },
  'kanban.boards': { params: ProfileHomeParams.extend({ include_archived: z.boolean().optional() }), result: z.object({ boards: z.array(KanbanBoardMetaSchema.extend({ is_current: z.boolean(), counts: z.record(z.string(), z.number().int()), total: z.number().int() })), current: z.string(), read_only: z.boolean() }) },
  'kanban.create_board': { params: ProfileHomeParams.extend({ board_spec: Loose }), result: z.object({ board: KanbanBoardMetaSchema, current: z.string(), read_only: z.boolean() }) },
  'kanban.update_board': { params: ProfileHomeParams.extend({ slug: z.string(), board_spec: Loose }), result: z.object({ board: KanbanBoardMetaSchema, read_only: z.boolean() }) },
  'kanban.delete_board': { params: ProfileHomeParams.extend({ slug: z.string(), delete: z.boolean().optional() }), result: z.object({ result: Json, current: z.string(), read_only: z.boolean() }) },
  'kanban.switch_board': { params: ProfileHomeParams.extend({ slug: z.string() }), result: z.object({ current: z.string(), read_only: z.boolean() }) },
  'kanban.task': { params: Board.extend({ task_id: z.string() }), result: z.object({ task: KanbanTaskSchema.extend(KanbanRunStartShape), comments: z.array(Loose), events: z.array(Loose), ...KanbanTaskLinksShape, runs: z.array(Loose), read_only: z.boolean() }) },
  'kanban.create_task': { params: Board.extend({ task: Loose }), result: TaskEnvelope },
  'kanban.patch_task': { params: Board.extend({ task_id: z.string(), patch: Loose }), result: TaskEnvelope },
  'kanban.task_action': { params: Board.extend({ task_id: z.string(), action: z.enum(['block', 'unblock']), reason: z.string().nullable().optional(), confirm_running_exit: z.boolean().optional() }), result: TaskEnvelope },
  'kanban.comment': { params: Board.extend({ task_id: z.string(), body: z.string(), author: z.string().optional() }), result: z.object({ ok: z.literal(true), comment_id: z.union([z.number().int(), z.string()]), read_only: z.boolean() }) },
  'kanban.link': { params: Board.extend({ parent_id: z.string(), child_id: z.string() }), result: z.object({ ok: z.literal(true), parent_id: z.string(), child_id: z.string(), read_only: z.boolean() }) },
  'kanban.unlink': { params: Board.extend({ parent_id: z.string(), child_id: z.string() }), result: z.object({ ok: z.literal(true), changed: z.boolean(), parent_id: z.string(), child_id: z.string(), read_only: z.boolean() }) },
  'kanban.normalize_board': { params: Board, result: z.object({ board: z.string() }) },
  'kanban.events': { params: Board.extend({ since: z.number().int().optional(), limit: z.number().int().optional() }), result: z.object({ events: z.array(KanbanEventSchema), cursor: z.number().int(), latest_event_id: z.number().int(), read_only: z.boolean() }) },
  'kanban.config': { params: Board, result: z.object({ columns: z.array(z.string()), assignees: z.array(KanbanAssigneeSchema), default_tenant: z.string(), lane_by_profile: z.boolean(), include_archived_by_default: z.boolean(), render_markdown: z.boolean(), read_only: z.boolean() }) },
  /** `column_order`: the Agent workflow's column keys in board order (TAL-796). */
  'kanban.stats': { params: Board, result: z.object({ column_order: z.array(z.string()) }).catchall(Json) },
  'kanban.assignees': { params: Board, result: z.object({ assignees: z.array(KanbanAssigneeSchema) }) },
  'kanban.task_log': { params: Board.extend({ task_id: z.string(), tail: z.number().int().optional() }), result: z.object({ task_id: z.string(), path: z.string(), exists: z.boolean(), size_bytes: z.number().int(), content: z.string(), truncated: z.boolean() }) },
  'kanban.bulk': { params: Board.extend({ bulk: Loose }), result: z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })), read_only: z.boolean() }) },
  'kanban.dispatch': { params: Board.extend({ dry_run: z.boolean().optional(), max: z.number().int().optional() }), result: Loose },
} as const

// ── state_db ───────────────────────────────────────────────────────────
/** Busy Agent work, or retained canonical history that this Agent cannot safely retire. */
export const SessionDeleteRefusedSchema = z.enum(['active_turn', 'runtime_history_unsupported'])
export type SessionDeleteRefused = z.infer<typeof SessionDeleteRefusedSchema>
const Session = ProfileHomeParams.extend({ session_id: z.string().min(1) })
export const STATE_DB_METHODS = {
  'state_db.sync_start': { params: Session.extend({ model: z.string().nullable().optional() }), result: Ok },
  'state_db.sync_usage': { params: Session.extend({ input_tokens: z.number().int().optional(), output_tokens: z.number().int().optional(), estimated_cost: z.number().nullable().optional(), model: z.string().nullable().optional(), title: z.string().nullable().optional(), message_count: z.number().int().nullable().optional(), cache_read_tokens: z.number().int().optional(), cache_write_tokens: z.number().int().optional(), api_call_count: z.number().int().nullable().optional() }), result: Ok },
  /** TAL-574: `manual` writes a user-requested title (rename or regenerate) with `user` provenance; otherwise it is an `llm` auto title. */
  'state_db.sync_title': { params: Session.extend({ title: z.string(), manual: z.boolean().optional() }), result: Ok },
  /**
   * TAL-792: `include_compression_lineage` also removes the session's compression continuations, resolved and removed in the
   * same transaction (tip first). `refused` when another Agent process holds a live turn lease or compression lock on any
   * row the delete would remove, or the Agent lacks retirement APIs for retained canonical history; nothing is removed. `deleted_ids` is the transaction's committed target set,
   * including continuations/delegates; it remains present when only post-commit artifact cleanup failed.
   */
  'state_db.delete_cli_session': { params: Session.extend({ include_compression_lineage: z.boolean().optional() }), result: Ok.extend({ refused: SessionDeleteRefusedSchema.optional(), deleted_ids: z.array(z.string().min(1)).optional() }) },
  /** TAL-258: append one row through the Agent's `SessionDB.append_message` (bumps `message_count`); `ok` is false without a state.db. */
  'state_db.append_message': { params: Session.extend({ role: z.string().min(1), content: z.string(), tool_name: z.string().nullable().optional(), timestamp: z.number().nullable().optional() }), result: Ok },
  /**
   * TAL-1274: the Agent's low-disk session auto-prune question for the profile (Agent v0.22.3 `hermes_cli.prune_advisor`), as the
   * Agent's own `lines` naming `/autoprune on|off|later`; null while the Agent would not ask (disk not low, `sessions.auto_prune`
   * set, or snoozed) or has no advisor. May measure state.db, which takes seconds on a large store.
   */
  'state_db.prune_advice': { params: ProfileHomeParams, result: z.object({ advice: z.object({ lines: z.array(z.string()).min(1) }).nullable() }) },
} as const

// ── profiles ───────────────────────────────────────────────────────────
/** TAL-213: the profile's canonical Bot Chat (its session titled exactly "Bot Chat") and that chat's live compression tip. */
export const CanonicalBotChatSchema = z.object({ session_id: z.string(), tip_session_id: z.string() })
/**
 * TAL-805: a profile's gateway under the host multiplexer. `own` runs its own gateway process, `served` is served by the
 * live host gateway, `parked` was stopped through the host (`hermes -p X gateway stop`) and nothing runs, `standalone` opted out of the host
 * and is not running, `stopped` is none of these. Only `own` and `served` are running; Agents without the multiplexer
 * helpers report `own` or `stopped`.
 */
export const GatewayModeSchema = z.enum(['own', 'served', 'parked', 'standalone', 'stopped'])
export type GatewayMode = z.infer<typeof GatewayModeSchema>
export const ProfileRowSchema = z.object({
  name: z.string(), path: z.string(), is_default: z.boolean(), gateway_running: z.boolean(), model: z.string().nullable(), provider: z.string().nullable(), has_env: z.boolean(),
  visible: z.boolean(), skill_count: z.number().int(), enabled_skills: z.number().int(), total_skills: z.number().int(),
  gateway_mode: GatewayModeSchema.default('stopped'),
  // Absent reads as no identity and no chat, so hand-built rows (test fakes) need not spell them out.
  display_name: z.string().default(''), description: z.string().default(''), has_avatar: z.boolean().default(false),
  canonical_session: CanonicalBotChatSchema.nullable().default(null),
})
export const PROFILES_METHODS = {
  'profiles.list': { params: BaseHomeParams, result: z.object({ profiles: z.array(ProfileRowSchema) }) },
  'profiles.create': { params: BaseHomeParams.extend({ name: z.string().min(1), clone_from: z.string().nullable().optional(), clone_config: z.boolean().optional() }), result: z.object({ profile: ProfileRowSchema }) },
  'profiles.delete': { params: BaseHomeParams.extend({ name: z.string().min(1) }), result: z.object({ ok: z.literal(true) }) },
  'profiles.runtime_env': { params: ProfileHomeParams.extend({ protected_keys: z.array(z.string()).optional() }), result: z.object({ env: z.record(z.string(), z.string()) }) },
  'profiles.skills_stats': { params: ProfileHomeParams, result: z.object({ enabled: z.number().int(), total: z.number().int() }) },
} as const

// ── skills ─────────────────────────────────────────────────────────────
export const SkillCatalogIdentitySchema = z.object({
  load_name: z.string().optional(), declared_name: z.string().optional(),
  status: z.enum(['unique', 'ambiguous', 'shadowed']).optional(), tier: z.number().int().optional(),
})
export const SkillRowSchema = SkillCatalogIdentitySchema.extend({ name: z.string(), description: z.string(), category: z.string().nullable(), disabled: z.boolean() })
export const SkillViewSchema = z.union([
  z.object({ success: z.literal(true), name: z.string(), description: z.string(), tags: z.array(z.string()), related_skills: z.array(z.string()), content: z.string(), path: z.string(), skill_dir: z.string().nullable(), linked_files: z.record(z.string(), z.array(z.string())), editable: z.boolean().optional() }),
  z.object({ success: z.literal(false), error: z.string(), available_skills: z.array(z.string()).optional(), available_skills_truncated: z.boolean().optional(), total_skills: z.number().int().optional(), hint: z.string().optional() }),
])
export const SKILLS_METHODS = {
  'skills.list': { params: ProfileHomeParams.extend({ category: z.string().nullable().optional() }), result: z.object({ success: z.boolean().optional(), skills: z.array(SkillRowSchema), categories: z.array(z.string()), count: z.number().int(), message: z.string().optional() }) },
  'skills.view': { params: ProfileHomeParams.extend({ name: z.string().min(1) }), result: SkillViewSchema },
  'skills.find': { params: ProfileHomeParams.extend({ name: z.string().min(1) }), result: z.object({ found: z.boolean(), skill_dir: z.string().nullable(), skill_md: z.string().nullable(), load_name: z.string().optional(), declared_name: z.string().optional(), sibling_load_names: z.array(z.string()).optional() }) },
} as const

// ── mcp ────────────────────────────────────────────────────────────────
export const MCP_METHODS = {
  'mcp.cost_policies': { params: ProfileHomeParams.extend({ servers: Loose }), result: z.object({ supported: z.boolean(), policies: z.array(McpCostPolicyDataSchema) }) },
  'mcp.status': { params: ProfileHomeParams, result: z.object({ servers: z.array(z.object({ name: z.string() }).catchall(Json)) }) },
  'mcp.registry_tools': { params: ProfileHomeParams, result: z.object({ tools: z.array(z.object({ name: z.string(), server: z.string(), schema: Loose })) }) },
  'mcp.reload': { params: ProfileHomeParams, result: z.object({ output: z.string() }) },
} as const

// ── connectors (TAL-818) ───────────────────────────────────────────────
/** Safe current-account display. Authentication success is independent of native app handoff state. */
export const NousAccountSchema = z.object({
  account_id: z.string().min(1), email: z.string().nullable(),
  state: z.enum(['idle', 'pending', 'retrying', 'claimed', 'gone', 'failed', 'paused', 'unknown', 'unavailable']),
  lines: z.array(z.string()), moved: z.array(z.string()), dropped: z.array(z.string()), reconnect: z.array(z.string()),
  poll_after: z.number().int().min(1).nullable(),
})
export type NousAccount = z.infer<typeof NousAccountSchema>

const ConnectorSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)
/** One portal policy layer's rules (the Agent's `PolicyBody`): `allow` names the apps that stay on, `deny` the ones off; `tools` turns single tools off. */
export const ConnectorPolicyBodySchema = z.object({
  mode: z.enum(['unrestricted', 'deny-all', 'allow', 'deny']),
  connectors: z.array(z.string()).optional(), disabled_connectors: z.array(z.string()).optional(),
  tools: z.record(z.string(), z.object({ disable: z.array(z.string()) })).optional(),
  tags: z.object({ enable: z.array(z.string()).optional(), disable: z.array(z.string()).optional() }).optional(),
})
/** A connection operation's target (`tools/connectors/operation.py`): a hosted app account, or an MCP server the card approves. */
export const ConnectorOperationTargetSchema = z.object({
  name: z.string(), kind: z.string(), state: z.enum(['pending', 'initiated', 'connected', 'skipped', 'failed', 'expired', 'not_connected']), detail: z.string(),
  connect_url: z.string().nullable().optional(),
  required_env: z.array(z.object({ name: z.string(), prompt: z.string(), required: z.boolean(), secret: z.boolean() })),
})
/** `owner`: `account` for the Connectors page's connect, `session` for a chat card, which `tool_call_id` opened. */
export const ConnectorOperationSnapshotSchema = z.object({ op_id: z.string(), settled: z.boolean(), owner: z.enum(['account', 'session']), tool_call_id: z.string().nullable(), targets: z.array(ConnectorOperationTargetSchema) })
const ConnectorOp = ProfileHomeParams.extend({ op_id: z.string().min(1) })
/**
 * Failures carry `data.condition`: `connectors_unavailable`, `connectors_sign_in`, `connectors_forbidden`, `connectors_org_required`,
 * `connector_not_found`, `connection_not_found`, `policy_conflict` (the member rules changed since `expected_revision`), `policy_invalid`,
 * `operation_not_found`, `operation_settled`, `operation_refused`, `connectors_failed`.
 */
const ConnectorOfferStatus = z.object({ available: z.boolean(), guest_id: z.string().nullable(), eligible: z.boolean(), due_in: z.number().int().nonnegative().nullable(), claimed: z.boolean() })
export const CONNECTORS_METHODS = {
  'connectors.offer.status': { params: ProfileHomeParams, result: ConnectorOfferStatus },
  'connectors.offer.claim': { params: ProfileHomeParams.extend({ guest_id: z.string().min(1) }), result: ConnectorOfferStatus },
  /** The Agent's `connectors_available()`; never creates an identity. */
  'connectors.available': { params: ProfileHomeParams, result: z.object({ available: z.boolean() }) },
  'connectors.catalog': { params: ProfileHomeParams, result: z.object({ connectors: z.array(z.object({ slug: z.string(), name: z.string(), description: z.string(), category: z.string(), logo_url: z.string().nullable() })) }) },
  'connectors.accounts': { params: ProfileHomeParams, result: z.object({ accounts: z.array(z.object({ connection_id: z.string(), connector: z.string(), status: z.string(), status_reason: z.string().nullable(), label: z.string(), alias: z.string().nullable(), active: z.boolean(), disabled: z.boolean(), created_at: z.string() })) }) },
  'connectors.remove': { params: ProfileHomeParams.extend({ connection_id: z.string().min(1) }), result: z.object({ connection_id: z.string(), connector: z.string(), status: z.literal('removed') }) },
  'connectors.tools': { params: ProfileHomeParams.extend({ connector: ConnectorSlug, refresh: z.boolean().optional() }), result: z.object({ connector: z.string(), tools: z.array(z.object({ slug: z.string(), name: z.string(), description: z.string(), facet: z.string(), hints: z.array(z.string()), categories: z.array(z.string()), deprecated: z.boolean() })) }) },
  'connectors.policy.get': { params: ProfileHomeParams, result: z.object({ layers: z.array(z.object({ kind: z.enum(['org', 'role', 'member']), revision: z.string(), body: ConnectorPolicyBodySchema })), effective: ConnectorPolicyBodySchema.extend({ revision: z.string() }) }) },
  /** One member-rule change: `enabled` turns the app on or off; `tool` with `tool_enabled` turns one of its tools on or off. */
  'connectors.policy.set': { params: ProfileHomeParams.extend({ connector: ConnectorSlug, expected_revision: z.string().min(1), enabled: z.boolean().optional(), tool: z.string().min(1).optional(), tool_enabled: z.boolean().optional() }), result: z.object({ revision: z.string() }) },
  /** Starts (or rejoins) the account-owned connect and waits for its authorization link. */
  'connectors.connect': { params: ProfileHomeParams.extend({ connector: ConnectorSlug, nous_account_id: z.string().min(1).optional() }), result: ConnectorOperationSnapshotSchema },
  'connectors.operation': { params: ConnectorOp, result: ConnectorOperationSnapshotSchema },
  'connectors.respond': { params: ConnectorOp.extend({ action: z.enum(['skip', 'retry', 'approve', 'continue']), target: z.string().optional(), env: z.record(z.string(), z.string()).optional() }), result: ConnectorOperationSnapshotSchema },
} as const

// ── tts ────────────────────────────────────────────────────────────────
/** The Agent owns speech providers, credentials and output encoding, as with STT. */
export const TTS_METHODS = {
  'tts.synthesize': {
    params: ProfileHomeParams.extend({ text: z.string().min(1).max(5000), provider: z.string().min(1), speed: z.number().min(0.5).max(2).optional() }),
    result: z.object({ provider: z.string(), format: z.string(), audio_b64: z.string() }),
  },
} as const

// ── stt ────────────────────────────────────────────────────────────────
export const STT_METHODS = {
  /**
   * `streaming` (TAL-802): `stt.streaming` is on and the provider has a live wire with credentials, so `stt.stream` would open.
   * `warm_supported` (TAL-916): the available provider is the local engine and the Agent can pre-load it (`tools.stt_lease`),
   * so `stt.warm` does real work.
   */
  'stt.capability': { params: ProfileHomeParams, result: z.object({ available: z.boolean(), provider: z.string(), streaming: z.boolean(), warm_supported: z.boolean() }) },
  /**
   * TAL-916: pre-load the profile's local engine (first-use download and model load) so the next `stt.transcribe` starts
   * hot. Blocks until loaded; a no-op (`warmed: false`) for remote providers, and `action: 'unsupported'` on an Agent
   * without the warmer.
   */
  'stt.warm': { params: ProfileHomeParams, result: z.object({ provider: z.string(), warmed: z.boolean(), action: z.string(), error: z.string().optional() }) },
  'stt.transcribe': { params: ProfileHomeParams.extend({ audio_b64: z.string().min(1), suffix: z.string().optional() }), result: z.object({ transcript: z.string(), filtered: z.boolean() }) },
  /**
   * TAL-802: one live dictation. Opens the profile's streaming session for s16le mono PCM at `sample_rate` (the sidecar
   * resamples), emits `ready` with the `stream_id` that `stt.stream_audio` feeds, then `partial` text as the provider
   * recognizes it, and returns the session's final transcript once audio ends. Cancelling the call cancels the session.
   */
  'stt.stream': {
    params: ProfileHomeParams.extend({ sample_rate: z.number().int().min(8000).max(48000) }),
    result: z.object({ transcript: z.string(), filtered: z.boolean(), provider: z.string() }),
    stream: z.discriminatedUnion('event', [
      z.object({ event: z.literal('ready'), data: z.object({ stream_id: z.string() }) }),
      z.object({ event: z.literal('partial'), data: z.object({ text: z.string() }) }),
    ]),
  },
  /** TAL-802: feed one PCM chunk to an open `stt.stream`, in order; `end` marks the end of speech. */
  'stt.stream_audio': { params: z.object({ stream_id: z.string().min(1), audio_b64: z.string().optional(), end: z.boolean().optional() }), result: z.object({ ok: z.literal(true) }) },
} as const

// ── cron ───────────────────────────────────────────────────────────────
/** `running_elsewhere`: a live execution owner. `recovery_only`: a retained snapshot, not a source for new task context. */
export const CronJobSchema = z.object({ id: z.string(), name: z.string().nullable().optional(), profile: z.string().nullable(), toast_notifications: z.boolean(), monitor: z.string(), continuity: z.boolean(), running_elsewhere: z.boolean().optional(), recovery_only: z.boolean().optional() }).catchall(Json)
const CronJob = ProfileHomeParams.extend({ job_id: z.string().min(1) })
const JobEnvelope = z.object({ job: CronJobSchema })
export const CronUsageSchema = z.object({ model: z.string().optional(), provider: z.string().optional(), estimated_cost_usd: z.number().optional(), duration_seconds: z.number().optional(), input_tokens: z.number().int().nullable().optional(), output_tokens: z.number().int().nullable().optional(), total_tokens: z.number().int().nullable().optional() })
export const CronBlueprintSlotSchema = z.object({ name: z.string(), type: z.string(), label: z.string(), default: z.string().nullable(), options: z.array(z.string()), optional: z.boolean(), strict: z.boolean(), help: z.string() })
export const CronBlueprintsSchema = z.object({ blueprints: z.array(z.object({ key: z.string(), title: z.string(), description: z.string(), category: z.string(), source: z.enum(['builtin', 'plugin']), plugin: z.string().nullable(), schedule_label: z.string(), slots: z.array(CronBlueprintSlotSchema) })) })
export const CronBlueprintFillInputSchema = z.object({ key: z.string().min(1), values: z.record(z.string(), z.string()) })
export const CronBlueprintFillSchema = z.object({ draft: z.object({ name: z.string(), prompt: z.string(), schedule: z.string(), deliver: z.string(), skills: z.array(z.string()) }) })
export type CronBlueprint = z.infer<typeof CronBlueprintsSchema>['blueprints'][number]
export const CRON_METHODS = {
  'cron.blueprints': { params: ProfileHomeParams, result: CronBlueprintsSchema },
  'cron.blueprint_fill': { params: CronBlueprintFillInputSchema.extend({ profile_home: z.string().optional() }), result: CronBlueprintFillSchema },
  /** `probe_store` adds the store's write probe (TAL-810): null when writes land or the Agent predates the probe. */
  'cron.list': { params: ProfileHomeParams.extend({ probe_store: z.boolean().optional() }), result: z.object({ jobs: z.array(CronJobSchema), store_health: z.object({ store: z.string(), error: z.string(), since: z.string(), fix: z.string() }).nullable().optional() }) },
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
  'cron.delivery_options': { params: ProfileHomeParams, result: z.object({ platforms: z.array(z.object({ value: z.string(), label: z.string() })) }) },
} as const

// ── providers / models ─────────────────────────────────────────────────
/**
 * `providers.model_ids` `fallback` (TAL-799): the Agent served its curated list because the live catalog was unreachable.
 * `providers.local_models` (TAL-798): the GGUFs staged for the Agent's managed llama.cpp provider `provider_id`, and the
 * running server's base URL (`current_endpoint`, null while it is off).
 */
export const PROVIDERS_METHODS = {
  'providers.registry': { params: ProfileHomeParams, result: z.object({ providers: z.record(z.string(), z.object({ id: z.string(), name: z.string(), auth_type: z.string() }).catchall(Json)) }) },
  'providers.nous_account': { params: ProfileHomeParams, result: z.object({ nous_account: NousAccountSchema.nullable() }) },
  'providers.auth_status': { params: ProfileHomeParams.extend({ provider: z.string().nullable().optional() }), result: z.object({ status: z.object({ logged_in: z.boolean() }).catchall(Json) }) },
  'providers.model_ids': { params: ProfileHomeParams.extend({ provider: z.string().min(1), force_refresh: z.boolean().optional() }), result: z.object({ provider: z.string(), model_ids: z.array(z.string()), fallback: z.boolean().default(false) }) },
  'providers.local_models': { params: ProfileHomeParams, result: z.object({ provider_id: z.string(), models: z.array(z.string()), current_endpoint: z.string().nullable() }) },
  'providers.resolve_runtime': { params: ProfileHomeParams.extend({ requested: z.string().nullable().optional(), api_key: z.string().nullable().optional(), base_url: z.string().nullable().optional(), target_model: z.string().nullable().optional() }), result: z.object({ runtime: Loose }) },
  'providers.credential_pool': { params: ProfileHomeParams.extend({ provider: z.string().min(1) }), result: z.object({ available: z.boolean(), strategy: z.string(), entries: z.array(Loose) }) },
  'models.selection_warnings': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), model: z.string().min(1), provider: z.string().nullable(), current_model: z.string().nullable(), current_provider: z.string().nullable(), context_tokens: z.number().int().positive().nullable(), messages: z.array(Loose) }), result: z.object({ warnings: z.array(ModelSelectionWarningSchema), context_tokens: z.number().int().positive().nullable(), provider: z.string(), base_url: z.string() }) },
  'models.speed_tiers': { params: ProfileHomeParams.extend({ routes: z.array(z.object({ model: z.string().min(1), provider: z.string(), base_url: z.string().optional() })) }), result: z.object({ tiers: z.array(z.array(SpeedTierSchema)) }) },
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
 *
 * TAL-1276: provider `plugin:<key>:<id>` is the browser sign-in of a plugin-declared OAuth client. Its start has no
 * `user_code`; `verification_url` is the authorize link, `redirect_uri` the loopback address the browser is sent back
 * to, and `authorize_host`/`token_host` the hosts the code goes to. It finishes when that redirect reaches the sidecar's
 * listener or through `oauth.submit_redirect` with the address the browser showed (`oauth_redirect_invalid` for any
 * other address, `oauth_flow_ended` once the flow ended).
 */
export const OAuthFlowStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled', 'error'])
const OAuthFlow = z.object({ flow_id: z.string(), provider: z.string(), status: OAuthFlowStatusSchema, error: z.string().nullable(), nous_account: NousAccountSchema.nullable().optional() })
const OAuthFlowParams = ProfileHomeParams.extend({ flow_id: z.string().min(1) })
export const OAUTH_METHODS = {
  'oauth.start': { params: ProfileHomeParams.extend({ provider: z.string().min(1) }), result: z.object({ flow_id: z.string(), provider: z.string(), status: z.literal('pending'), user_code: z.string().optional(), verification_url: z.string(), expires_in: z.number().int(), interval: z.number().int(), redirect_uri: z.string().optional(), authorize_host: z.string().optional(), token_host: z.string().optional() }) },
  'oauth.poll': { params: OAuthFlowParams, result: OAuthFlow },
  'oauth.cancel': { params: OAuthFlowParams, result: OAuthFlow },
  'oauth.submit_redirect': { params: OAuthFlowParams.extend({ url: z.string().min(1) }), result: OAuthFlow },
} as const

// ── aux / text / process / usage / gateway ─────────────────────────────
export const AuxUsageSchema = z.object({ prompt_tokens: z.number().int().optional(), completion_tokens: z.number().int().optional(), total_tokens: z.number().int().optional() })
export const AUX_METHODS = {
  /**
   * One auxiliary completion. TAL-258: `model` (with `provider`) asks that model itself, reasoning off and no tools, instead
   * of the task's auxiliary route; `credential_missing` means it has no credential. `finish_reason` is the provider's, when known.
   */
  'aux.complete': { params: ProfileHomeParams.extend({ task: z.string().min(1), messages: z.array(Loose).min(1), main_runtime: Loose.nullable().optional(), main_fallback: z.boolean().optional(), max_tokens: z.number().int().nullable().optional(), temperature: z.number().nullable().optional(), model: z.string().nullable().optional(), provider: z.string().nullable().optional() }), result: z.object({ model: z.string(), text: z.string(), usage: AuxUsageSchema.nullable(), finish_reason: z.string().nullable().default(null) }), stream: z.discriminatedUnion('event', [z.object({ event: z.literal('token'), data: z.object({ text: z.string() }) })]) },
  /**
   * TAL-800: the profile's auxiliary slots in Agent order (built-ins, then the profile's plugin tasks). `reasoning_effort`
   * is the slot's resolved effort (`''` = provider default); `effective` is the route an `inherit_from` task resolves to now.
   * `reserved`: the Agent's other `auxiliary.*` keys (settings and unlisted routes); a reset never touches them.
   */
  'aux.tasks': { params: ProfileHomeParams, result: z.object({ tasks: z.array(z.object({ key: z.string().min(1), label: z.string(), description: z.string(), inherit_from: z.string().nullable(), reasoning_effort: z.string(), effective: z.object({ provider: z.string(), model: z.string(), base_url: z.string() }).nullable() })), reserved: z.array(z.string()) }) },
  'aux.resolve': { params: ProfileHomeParams.extend({ task: z.string().min(1), main_runtime: Loose.nullable().optional() }), result: z.object({ configured: z.boolean(), model: z.string().nullable(), error: z.string().optional() }) },
} as const
export const TEXT_METHODS = {
  'text.image_mode': { params: ProfileHomeParams.extend({ provider: z.string(), model: z.string(), cfg: Loose.nullable().optional(), requested_provider: z.string().optional() }), result: z.object({ mode: z.enum(['native', 'text']), reason: z.string(), supports_vision: z.boolean().nullable() }) },
  'text.portal_tags': { params: ProfileHomeParams, result: z.object({ client_tag: z.string().nullable(), conversation_tag: z.string().nullable(), tags: z.union([z.array(z.string()), Loose]) }) },
  /** TAL-906: the Agent's read-aloud script (`prepare_spoken_text`); `text` as written on an Agent without it. */
  'text.spoken': { params: z.object({ text: z.string() }), result: z.object({ spoken_text: z.string() }) },
} as const
/**
 * TAL-886: the Agent's `MemoryStore` reading of a MEMORY.md / USER.md body: its char count and the profile's limit for that store.
 * TAL-784: `memory.write` replaces a memory page file with `content` only while its bytes still hash (SHA-256 hex) to `base`,
 * holding the Agent's per-file lock (`<file>.lock`); `written: false` means the file changed and is untouched.
 */
export const MEMORY_METHODS = {
  'memory.check': { params: ProfileHomeParams.extend({ target: z.enum(['memory', 'user']), content: z.string() }), result: z.object({ count: z.number().int(), limit: z.number().int() }) },
  'memory.write': { params: ProfileHomeParams.extend({ section: z.enum(['memory', 'user', 'soul']), base: z.string(), content: z.string() }), result: z.object({ written: z.boolean() }) },
} as const
/**
 * TAL-819: one write the Agent staged for approval (`skills.write_approval` / `memory.write_approval`). `target` is the skill
 * name(s), or `memory` / `user` for the memory store; `op` the staged action; `diff` the unified diff an approval would apply
 * (a skill create shows the new file, a write that would fail says why); `revision` is the SHA-256 of that diff, which an approval
 * must send back. `approvable` is false when no diff could be built or the Agent would refuse the write (`diff` says why;
 * `revision` is empty); such a write can only be rejected.
 */
export const PendingWriteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), kind: z.enum(['skills', 'memory']), target: z.string(), op: z.string(), summary: z.string(),
  origin: z.string(), created_at: z.number(), diff: z.string(), approvable: z.boolean(), revision: z.string(),
})
export type PendingWrite = z.infer<typeof PendingWriteSchema>
export const PendingWriteRefSchema = z.object({ id: PendingWriteSchema.shape.id, revision: z.string() })
const WriteApprovalParams = ProfileHomeParams.extend({ kind: z.enum(['skills', 'memory']), writes: z.array(PendingWriteRefSchema).min(1) })
const WriteApprovalResult = z.object({ results: z.array(z.object({ id: z.string(), done: z.boolean(), message: z.string() })) })
/**
 * TAL-819: the profile's staged writes of `kind`, oldest first, and whether its gate is on; `supported` is false on an Agent
 * without the review handlers. `approve` / `reject` run the Agent's `/skills` or `/memory` handler per write; `done` is true
 * once the record is gone (applied or dropped) and `message` is the handler's text. An approval whose diff no longer has the
 * reviewed `revision` is refused (`done: false`) without applying.
 */
export const WRITE_APPROVAL_METHODS = {
  'write_approval.pending': { params: ProfileHomeParams.extend({ kind: z.enum(['skills', 'memory']) }), result: z.object({ supported: z.boolean(), enabled: z.boolean(), items: z.array(PendingWriteSchema) }) },
  'write_approval.approve': { params: WriteApprovalParams, result: WriteApprovalResult },
  'write_approval.reject': { params: WriteApprovalParams, result: WriteApprovalResult },
} as const
export const ProcessEventSchema = z.object({ process_id: z.string(), consumed: z.boolean(), type: z.string().optional(), session_key: z.string().optional(), origin_ui_session_id: z.string().optional(), child_process: z.boolean().optional(), reconciliation_profile_home: z.string().optional() }).catchall(Json)
export const PROCESS_METHODS = {
  'process.drain': { params: ProfileHomeParams.extend({ max_events: z.number().int().positive().optional() }), result: z.object({ events: z.array(ProcessEventSchema) }) },
  /** TAL-533: re-adopt the base home's and every named profile's checkpointed background processes in a fresh sidecar. */
  'process.recover': { params: BaseHomeParams, result: z.object({ homes: z.number().int() }) },
  'process.requeue': { params: z.object({ events: z.array(Loose) }), result: z.object({ requeued: z.number().int() }) },
  'process.mark_consumed': { params: z.object({ process_id: z.string().min(1) }), result: Ok },
  /** TAL-532: the subset the agent already holds from its own turn (consumed via wait/log, or poll-observed). */
  'process.consumed': { params: z.object({ process_ids: z.array(z.string().min(1)) }), result: z.object({ consumed: z.array(z.string()) }) },
  /** TAL-459: the Agent's durable delivery ledger. A null claim means another consumer delivered (or holds) it; "" means nothing durable to acknowledge. */
  'process.claim_delivery': { params: ProfileHomeParams.extend({ event: Loose, consumer: z.string().min(1) }), result: z.object({ claim_id: z.string().nullable(), retryable: z.boolean().optional() }) },
  'process.complete_delivery': { params: ProfileHomeParams.extend({ event: Loose, claim_id: z.string() }), result: Ok },
  'process.release_delivery': { params: ProfileHomeParams.extend({ event: Loose, claim_id: z.string() }), result: Ok },
  /** Hands back a claim the busy target never admitted, without spending one of the Agent's delivery attempts. */
  'process.defer_delivery': { params: ProfileHomeParams.extend({ event: Loose, claim_id: z.string() }), result: Ok },
  'process.format_notification': { params: z.object({ event: Loose }), result: z.object({ text: z.string() }) },
  'process.stop': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), process_id: z.string().min(1) }), result: z.object({ outcome: z.enum(['stopped', 'not_running', 'not_found']) }) },
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
/**
 * TAL-548: one credential-pool entry's local state (no network, no secrets); the server derives a quota source per entry.
 * `matches_api_key`: the entry's key is the configured key, passed as `api_key` or resolved from `env_vars` in the profile's secret scope.
 */
export const PoolEntrySchema = z.object({
  credential_id: z.string(), label: z.string(), status: z.enum(['available', 'exhausted', 'dead']), unavailable_reason: z.string().nullable(), retry_after: z.string().nullable(),
  matches_api_key: z.boolean(),
})
const BalanceNumber = z.number().nullable()
/**
 * TAL-548: one key-based balance read. The key is the pool entry's (`credential_id`), a raw `api_key`, or resolved from `env_vars` in the profile's secret scope.
 * `ok` carries the provider's sanitised fields: OpenRouter `quota`/`label`, DeepSeek `balances`/`is_available`, OpenCode Go
 * `windows`; `http_error` carries the status code.
 */
export const BalanceResultSchema = z.object({
  status: z.enum(['ok', 'no_key', 'http_error', 'unavailable']), http_status: z.number().int().nullable(),
  quota: z.object({ limit_remaining: BalanceNumber, usage: BalanceNumber, limit: BalanceNumber }).nullable(), label: z.string().nullable(),
  is_available: z.boolean().nullable(), balances: z.array(z.object({ currency: z.enum(['CNY', 'USD']), total: z.number(), granted: BalanceNumber, topped_up: BalanceNumber })),
  windows: z.array(z.object({ key: z.enum(['rolling', 'weekly', 'monthly']), used_percent: z.number(), reset_at: z.string(), rate_limited: z.boolean() })),
})
const CredentialId = z.string().min(1).nullable().optional()
/** TAL-807: the Agent's `CredentialPool.limit_state`: every live account benched until `resets_at`, else the given models no usable account serves until their ISO reset. */
export const PoolLimitSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('account'), resets_at: z.string() }),
  z.object({ scope: z.literal('models'), models: z.record(z.string(), z.string()) }),
])
export const USAGE_METHODS = {
  'usage.account': { params: ProfileHomeParams.extend({ provider: z.string().min(1), base_url: z.string().nullable().optional(), api_key: z.string().nullable().optional(), credential_id: CredentialId }), result: z.object({ snapshot: AccountUsageSnapshotSchema.nullable() }) },
  'usage.pool': { params: ProfileHomeParams.extend({ provider: z.string().min(1), api_key: z.string().nullable().optional(), env_vars: z.array(z.string().min(1)).optional() }), result: z.object({ entries: z.array(PoolEntrySchema), has_api_key: z.boolean().optional() }) },
  /** TAL-548: the providers whose persisted credential pool holds an account the user added, keyed or not. */
  'usage.pool_providers': { params: ProfileHomeParams.extend({ key_envs: z.record(z.string(), z.array(z.string().min(1))).optional() }), result: z.object({ providers: z.array(z.string()), keys: z.record(z.string(), z.object({ present: z.boolean(), revision: z.string().nullable() })).default({}) }) },
  /** TAL-807: pool rate limits by provider slug, only for pooled providers that are limited; `models` are bare ids. */
  'usage.limits': { params: ProfileHomeParams.extend({ providers: z.array(z.object({ slug: z.string().min(1), models: z.array(z.string()) })) }), result: z.object({ limits: z.record(z.string(), PoolLimitSchema) }) },
  'usage.balance': { params: ProfileHomeParams.extend({ provider: z.enum(['openrouter', 'deepseek', 'opencode-go']), credential_id: CredentialId, api_key: z.string().nullable().optional(), env_vars: z.array(z.string().min(1)).optional() }), result: BalanceResultSchema },
} as const
export const CONFIG_METHODS = {
  // `config_path` is the server-resolved file (honouring HERMES_CONFIG_PATH); the sidecar reads and writes exactly that path.
  'config.get': { params: ProfileHomeParams.extend({ config_path: z.string().min(1) }), result: z.object({ path: z.string(), exists: z.boolean(), config: Loose }) },
  'config.set': { params: ProfileHomeParams.extend({ config_path: z.string().min(1), config: Loose }), result: z.object({ ok: z.literal(true), path: z.string() }) },
  /** TAL-797: `.env` edits through the Agent's locked writer; `null` removes a key, an empty value is skipped; line breaks, spaces, quotes, `#` and non-ASCII are refused. */
  'config.env_write': { params: ProfileHomeParams.extend({ updates: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().nullable()) }), result: z.object({ ok: z.literal(true), path: z.string() }) },
  'models.reasoning_efforts': { params: ProfileHomeParams.extend({ model: z.string(), provider: z.string() }), result: z.object({ efforts: z.array(z.string()), supports_reasoning: z.boolean().nullable() }) },
  /**
   * TAL-901: the Agent's personalities for `config` (its built-ins, then the top-level `personalities:` block, then
   * `agent.personalities`), by case-folded name in the Agent's order; `prompt` is the rendered overlay text.
   */
  'personalities.list': { params: z.object({ config: Loose }), result: z.object({ personalities: z.array(z.object({ name: z.string().min(1), description: z.string(), prompt: z.string() })) }) },
} as const
export const WORKTREE_METHODS = {
  'worktree.create': { params: ProfileHomeParams.extend({ repo_root: z.string().min(1) }), result: z.object({ path: z.string(), branch: z.string(), repo_root: z.string(), base: z.string().nullable() }) },
  /**
   * TAL-1254: relock Talaria's worktrees for this sidecar (`hermes pid=<pid>`) so the Agent's worktree sweep reads them as
   * live. `foreign_lock`: a lock that is not a `hermes pid=` one holds the tree and stays. A tree this sidecar does not
   * hold yet (a running process's `hermes pid=` lock, or a git failure) is absent from `results`; the caller retries it.
   */
  'worktree.retain': { params: z.object({ paths: z.array(z.string().min(1)) }), result: z.object({ results: z.record(z.string(), z.enum(['retained', 'missing', 'foreign_lock'])) }) },
} as const
/** TAL-913: a workspace's checkpoints, read and restored through the Agent's `CheckpointManager`; `store` is its shared git store. */
const CheckpointTarget = ProfileHomeParams.extend({ workspace: z.string().min(1) })
export const AgentCheckpointSchema = z.object({ hash: z.string(), short_hash: z.string(), timestamp: z.string(), reason: z.string(), files_changed: z.number().int(), insertions: z.number().int(), deletions: z.number().int() })
export const CHECKPOINTS_METHODS = {
  'checkpoints.list': { params: CheckpointTarget, result: z.object({ checkpoints: z.array(AgentCheckpointSchema), store: z.string() }) },
  /** `diff` is `git diff <checkpoint> --cached` over the workspace: `a/` is the checkpoint, `b/` the files now. */
  'checkpoints.diff': { params: CheckpointTarget.extend({ checkpoint: z.string().min(1) }), result: z.object({ stat: z.string(), diff: z.string() }) },
  /**
   * Safe unless `all` (TAL-1260): only files still as the Agent last wrote them are reverted, and `kept_user_edits` names the
   * hand-edited ones left in place. `restored_files` is what a safe restore acted on; null when the whole tree was checked out.
   */
  'checkpoints.restore': {
    params: CheckpointTarget.extend({ checkpoint: z.string().min(1), all: z.boolean().optional() }),
    result: z.object({ restored_to: z.string(), reason: z.string(), restored_files: z.array(z.string()).nullable(), kept_user_edits: z.array(z.string()), skipped_oversize: z.array(z.string()), failed_deletes: z.array(z.string()) }),
  },
} as const
// ── chat / approval / clarify ──────────────────────────────────────────
export const ChatUsageSchema = z.object({ prompt_tokens: z.number().int(), completion_tokens: z.number().int(), cache_read_tokens: z.number().int(), cache_write_tokens: z.number().int(), estimated_cost_usd: z.number().nullable() })
/**
 * `failed`, `partial`, and `compression_exhausted` are the Agent's own turn-result flags, forwarded as sent; `failed` also sets `status: 'error'`.
 * `max_iterations_summary_request` is the Agent's text for the user row it appends to ask for a summary once its tool budget runs out
 * (`tool_limit_reached`); the server drops that trailing row of an exhausted turn from the transcript and the model context (TAL-537).
 * A completed `compressed` turn also carries `context_messages`, its `messages` with tool output pruned and capped for the model (row for row),
 * and `post_compression_context_tokens_estimate`, the next request's estimated size (TAL-539); both are null otherwise.
 */
/**
 * The turn agent's context figures (`context_length`, `threshold_tokens`, `last_prompt_tokens`, `compression_count`). TAL-1005:
 * `next_turn_threshold_tokens` is the compression threshold the next turn runs under, the primary runtime's when a fallback ran
 * this one (the Agent restores the primary each turn); absent when the Agent reports none.
 */
const ChatContextSchema = z.looseObject({ next_turn_threshold_tokens: z.number().int().positive().optional() })
export const ChatStartResultSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'error']), messages: z.array(Loose), context_messages: z.array(Loose).nullable().optional(), post_compression_context_tokens_estimate: z.number().int().nullable().optional(), final_response: z.string(), error: z.string().nullable(),
  failed: z.boolean(), partial: z.boolean(), compression_exhausted: z.boolean(),
  tool_limit_reached: z.boolean(), max_iterations_summary_request: z.string(), usage: ChatUsageSchema, context: ChatContextSchema, model: z.string(), provider: z.string(), compressed: z.boolean(), agent_session_id: z.string(),
  token_sent: z.boolean(), pending_steer: z.string(), live_tool_calls: z.array(Loose),
})
const Text = z.object({ text: z.string() }).catchall(Json)
/**
 * A `tool_complete` frame carries `raw_result` (through the catch-all): the result object's first 64 top-level fields
 * (scalars as sent, text and nested values as capped text) or its capped text. The server decides `is_error` from it and never forwards it; `is_error` is only an older sidecar's `false`.
 * A `todo` tool's frame also carries `todo_result`, the tool's full result text, which the server turns into `todo_state` (TAL-397) and never forwards.
 * A result with a string `diff` also carries `result_diff`, that whole diff, which the server turns into `edit_diff` (TAL-448) and never forwards.
 * TAL-909: `display_metadata` is the dict the sidecar returned for the Agent to persist on the tool-result row (a file edit's unified `diff`
 * from the Agent's before-snapshot); the server turns its `diff` into `edit_diff` when the result has none, and never forwards it.
 */
const ToolFrame = z.object({ event_type: z.string(), name: z.string().nullable().optional(), preview: Json.optional(), args: Loose.optional(), tid: z.string().optional(), is_error: z.boolean().optional() }).catchall(Json)
export const ChatStreamSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('token'), data: Text }),
  z.object({ event: z.literal('reasoning'), data: Text }),
  /** The Agent's pending steer text before a content frame (server-side steer consumption). */
  z.object({ event: z.literal('steer_pending'), data: Text }),
  z.object({ event: z.literal('interim_assistant'), data: Text }),
  /** TAL-397: the Agent's session counters, before the content frame that follows a change. */
  z.object({ event: z.literal('usage'), data: ChatUsageSchema }),
  z.object({ event: z.literal('tool'), data: ToolFrame }),
  z.object({ event: z.literal('tool_progress'), data: z.object({ tool_call_id: z.string(), message: z.string().nullable().optional(), progress: z.number().nullable().optional(), total: z.number().nullable().optional(), percent: z.number().nullable().optional() }) }),
  z.object({ event: z.literal('tool_complete'), data: ToolFrame }),
  z.object({ event: z.literal('approval'), data: Loose }),
  z.object({ event: z.literal('clarify'), data: Loose }),
  z.object({ event: z.literal('clarify_resolved'), data: Loose }),
  /** TAL-818: a `manage_connections` card opened; `tool_call_id` is the call that opened it. */
  z.object({ event: z.literal('connection'), data: ConnectorOperationSnapshotSchema }),
  /** The Agent stopped waiting on an approval: `reason` is its settle cause (`resolved`, `timeout`, `interrupted`, `session_closed`). */
  z.object({ event: z.literal('approval_resolved'), data: z.looseObject({ approval_id: z.string(), session_id: z.string().optional(), reason: z.string().optional() }) }),
  z.object({ event: z.literal('compressing'), data: Loose }),
  /** TAL-1006: the Agent finished the compaction the last `compressing` started; an aborted one sends none. */
  z.object({ event: z.literal('compression_finished'), data: Loose }),
  z.object({ event: z.literal('warning'), data: Loose }),
  z.object({ event: z.literal('status'), data: Loose }),
  /**
   * TAL-803: the Agent's `AgentNotice` (`kind` `sticky` or `ttl`, `ttl_ms` only for `ttl`), the clear of one by `key`, and
   * `notices_reset` before a new agent for the session is built: the notices of the one it replaces with
   * `lapses_with_agent` lapse (an Agent startup warning, raised once per process, does not).
   */
  z.object({ event: z.literal('notice'), data: z.looseObject({ id: z.string().nullable().optional(), key: z.string().nullable().optional(), level: z.string(), kind: z.string(), ttl_ms: z.number().int().nullable().optional(), text: z.string(), lapses_with_agent: z.boolean().optional() }) }),
  z.object({ event: z.literal('notice_clear'), data: z.looseObject({ key: z.string() }) }),
  z.object({ event: z.literal('notices_reset'), data: Loose }),
  z.object({ event: z.literal('provider_phase'), data: z.object({ phase: ProviderPhaseSchema.nullable() }) }),
  /** TAL-821: the Agent's live rate-limit wait (`until`, epoch seconds: the limit's reset or the Agent's retry, as `until_kind` says); a null `until` ends it. */
  z.object({ event: z.literal('rate_limit_wait'), data: z.looseObject({ provider: z.string().nullable(), until: z.number().nullable(), until_kind: z.enum(['reset', 'retry']).optional() }) }),
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
      /** TAL-529: the user's own text, which state.db stores in place of `user_message` (workspace prefix, attachment parts). */
      persist_user_message: z.string().optional(),
      /** TAL-529: a `/btw` side question, whose throwaway session the Agent keeps out of the profile's state.db. */
      ephemeral: z.boolean().optional(),
      /** TAL-801: a spoken turn, which the Agent runs on the profile's `auxiliary.voice_chat` slot when it has that route. */
      voice_turn: z.boolean().optional(),
      /** TAL-818: attach the Agent's `connection_callback`, so `manage_connections` streams a `connection` frame and waits on the card. */
      connect_card: z.boolean().optional(),
      /** Bind turn-local skill capture only for a client that renders the masked prompt. */
      skill_secret: z.boolean().optional(),
      /** TAL-903: `workspace` is a host path (the profile's terminal runs locally), so the Agent anchors AGENTS.md discovery and its memory provider there. A remote backend's target-side path is never read on the host. */
      workspace_local: z.boolean().optional(),
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
   * place (`kept`) or last (`last`); `withdrawn: false` when the Agent already took it, or `reason: not_running` when the run or Agent is absent.
   */
  'chat.steer_now': {
    params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional(), pending: z.array(z.string().min(1)).min(1), index: z.number().int().nonnegative() }),
    result: z.object({ redirected: z.boolean(), withdrawn: z.boolean(), delivery: z.enum(['redirect', 'steer']).optional(), requeued: z.enum(['kept', 'last']).optional(), reason: z.enum(['not_running']).optional() }),
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
  /** TAL-1333: safe metadata from the existing matching resident Agent, never a new Agent. */
  'chat.context_detail': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), model: z.string().nullable(), model_provider: z.string().nullable(), workspace: z.string().nullable() }), result: ContextDetailSchema },
  /** TAL-255: second phase of `chat.compress`; `finalized: false` when the token is unknown or already expired. */
  'chat.compress_finalize': { params: z.object({ commit_token: z.string().min(1), committed: z.boolean() }), result: z.object({ finalized: z.boolean() }) },
  /** Archive only emits on_session_delete for the committed local transition; it never closes the Agent session. */
  'chat.finalize_session': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), reason: z.enum(['clear', 'delete', 'archive']), lineage: z.array(z.string().min(1)).max(10_000).optional() }), result: z.object({ messages: z.array(z.string()) }) },
  'chat.evict_agent': { params: z.object({ session_id: z.string().min(1), clear_session: z.boolean().optional() }), result: z.object({ evicted: z.boolean() }) },
  'chat.commit_memory': { params: ProfileHomeParams.extend({ session_id: z.string().min(1) }), result: z.object({ committed: z.boolean() }) },
  /**
   * TAL-902: `/refine [focus]`, the Agent's on-demand memory/skill review of `messages` (the session's model context) on the
   * session's cached agent, else one built from the turn parameters and cached like a turn's. `output` is the Agent's
   * wording: the review started, or why not (a turn is running, the conversation is empty).
   */
  'chat.refine': {
    params: ProfileHomeParams.extend({
      session_id: z.string().min(1), messages: z.array(Loose), focus: z.string(), model: z.string(), model_provider: z.string().nullable().optional(),
      enabled_toolsets: z.array(z.string()).nullable().optional(), max_iterations: z.number().int().nullable().optional(), max_tokens: z.number().int().nullable().optional(),
      reasoning_config: z.object({ enabled: z.boolean(), effort: z.string().optional() }).nullable().optional(),
      /** TAL-903: the session's workspace, as `chat.start` sends it, so the agent built here is the one its next turn reuses. */
      workspace: z.string().optional(), workspace_local: z.boolean().optional(),
    }),
    result: z.object({ output: z.string() }),
  },
  'approval.respond': { params: ProfileHomeParams.extend({ session_id: z.string().min(1), choice: z.enum(['once', 'session', 'always', 'deny']), request_id: z.string().nullable().optional() }), result: z.object({ ok: z.boolean(), resolved: z.number().int(), choice: z.string() }) },
  'approval.pending': { params: z.object({ session_id: z.string().min(1) }), result: z.object({ pending: z.array(Loose) }) },
  'approval.set_yolo': { params: z.object({ session_id: z.string().min(1), enabled: z.boolean() }), result: z.object({ yolo_enabled: z.boolean(), released: z.number().int() }) },
  'clarify.respond': { params: z.object({ stream_id: z.string().optional(), session_id: z.string().optional(), clarify_id: z.string().optional(), response: z.string() }), result: z.object({ ok: z.boolean(), clarify_id: z.string().optional() }) },
} as const
const GatewayActionParams = ProfileHomeParams.extend({ interrupt: z.boolean().optional(), cli_profile: z.string().nullable().optional(), quick_timeout_seconds: z.number().optional(), background_wait_seconds: z.number().optional() })
/**
 * A lifecycle run of `hermes --profile <name> gateway <action>` for the profile at `profile_home` (TAL-894). `busy` means another
 * action holds the lock; `busy_live_work` is an Agent live-work refusal. `interrupt` explicitly consents to interruption.
 * `timed_out` marks a child killed after `background_wait_seconds` (a restart defaults to the Agent CLI's own
 * restart budget plus 30 s) or cancelled. `detail` is CLI output, never shown to a browser; `reason` is the Agent's first error line of a
 * failed run (TAL-884), the one line the server shows.
 */
const GatewayActionResult = z.object({ status: z.enum(['completed', 'failed', 'busy', 'busy_live_work']), message: z.string(), detail: z.string().optional(), returncode: z.number().int().optional(), reason: z.string().optional(), timed_out: z.boolean().optional() })
const GatewayActionStream = z.discriminatedUnion('event', [z.object({ event: z.literal('progress'), data: z.object({ phase: z.enum(['started', 'draining']) }) })])
export const GATEWAY_ACTIONS = ['start', 'stop', 'restart'] as const
export const GATEWAY_METHODS = {
  'gateway.session': { params: GatewaySessionParamsSchema, result: GatewaySessionResultSchema, stream: z.discriminatedUnion('event', [
    z.object({ event: z.literal('snapshot'), data: GatewaySessionResultSchema.extend({ replaying: z.boolean().optional(), reaction_only: z.boolean().optional() }) }),
    z.object({ event: z.literal('event'), data: Loose }),
    z.object({ event: z.literal('replay_complete'), data: z.object({}) }),
    z.object({ event: z.literal('clarify_batch'), data: GatewayClarifyBatchSchema }),
    z.object({ event: z.literal('restarting'), data: z.object({ restarting: z.literal(true) }) }),
  ]) },
  'gateway.create': { params: GatewayCreateParamsSchema, result: GatewaySessionResultSchema },
  'gateway.control': { params: GatewayActionParams.extend({ action: z.enum(GATEWAY_ACTIONS) }), result: GatewayActionResult, stream: GatewayActionStream },
  'gateway.restart': { params: GatewayActionParams, result: GatewayActionResult, stream: GatewayActionStream },
  /** TAL-805: the gateway mode of the profile `name` at `profile_home`; the root profile (`is_default`) is the host itself. */
  'gateway.mode': { params: ProfileHomeParams.extend({ name: z.string().min(1), is_default: z.boolean() }), result: z.object({ gateway_mode: GatewayModeSchema }) },
} as const
