/**
 * Wire shapes both the sidecar RPC and the browser-facing routes and views use. The browser entry reaches these
 * without loading a file under `sidecar/` (TAL-1698); a schema only the sidecar RPC reads stays in `sidecar/`.
 */
import { z } from 'zod'

/** Warnings and wording come from the Agent's selection guard registry, including future guard kinds. */
export const ModelSelectionWarningSchema = z.object({ kind: z.string(), title: z.string(), model: z.string(), provider: z.string(), message: z.string() })
const Json = z.unknown()
/** Profile-scoped toolset choices; clients render policy and selection without deriving them. */
export const ToolsetsCatalogSchema = z.object({
  toolsets: z.array(z.object({
    name: z.string(), description: z.string(), available: z.boolean(), selected: z.boolean(),
    unavailable_reason: z.enum(['disabled', 'unavailable']).nullable(),
    /** TAL-1813: the tools `agent.disabled_toolsets` cuts from a toolset it leaves standing, and the entries that do it; empty on Agents before v0.22.6. */
    stripped_tools: z.array(z.string()).optional(), stripped_by: z.array(z.string()).optional(),
  })),
  selected_toolsets: z.array(z.string()), using_defaults: z.boolean(),
})
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
/** TAL-1829: why the plugin is off when something other than the user turned it off; `update` comes from the Agent's `plugins.disabled_by_update` record (v0.22.6+). */
export const PluginDisabledReasonSchema = z.object({ kind: z.literal('update'), reason: z.string() })
export const PluginUpdateResultSchema = z.discriminatedUnion('status', [
  z.object({ key: z.string(), status: z.literal('updated') }),
  /** `caution`: the scan of a Git update needs confirming. `widened` (TAL-1914): a catalog pin adds surface the install lacks. */
  z.object({ key: z.string(), status: z.literal('needs_consent'), verdict: z.enum(['caution', 'widened']), findings: z.string(), consent_token: z.string().min(1) }),
  z.object({ key: z.string(), status: z.literal('blocked'), verdict: z.string(), findings: z.string() }),
])
export type PluginUpdateResult = z.infer<typeof PluginUpdateResultSchema>
/** TAL-1914: one plugin Update all looked at. `needs_review` and `skipped` changed nothing; `needs_review` goes through the plugin's own Update. */
export const PluginUpdateAllRowSchema = z.object({ name: z.string(), status: z.enum(['updated', 'current', 'failed', 'needs_review', 'skipped']), detail: z.string() })
export type PluginUpdateAllRow = z.infer<typeof PluginUpdateAllRowSchema>
/** `current` counts the plugins the check found up to date; they have no row. */
export const PluginUpdateAllResultSchema = z.object({ results: z.array(PluginUpdateAllRowSchema), current: z.number().int().nonnegative() })
export const PluginCatalogQuerySchema = z.object({ query: z.string().trim().max(200).default(''), offset: z.coerce.number().int().min(0).max(10000).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) })
export const PluginInstallInputSchema = z.object({ name: z.string().regex(/^[a-z0-9_-]{1,64}$/), consent_token: z.string().min(1).max(128).optional() })
export const PluginCatalogSchema = z.object({ supported: z.boolean(), read_only: z.boolean().optional(), entries: z.array(z.object({
  name: z.string(), title: z.string(), description: z.string(), repo: z.string(), sha: z.string(), tier: z.string(), category: z.string(),
  requirements: z.array(z.string()), installed_key: z.string().nullable(), installed_sha: z.string().nullable(), can_install: z.boolean(), refusal: z.string().nullable(),
  /** TAL-1914: the install is behind this entry's pin and may move: not held with `--ref`, not refused, and this session may update. */
  can_update: z.boolean(),
})), total: z.number().int().nonnegative(), next_offset: z.number().int().nullable() })
export const PluginInstallResultSchema = z.discriminatedUnion('status', [
  z.object({ name: z.string(), key: z.string(), status: z.literal('installed'), enabled: z.literal(false) }),
  z.object({ name: z.string(), status: z.literal('needs_consent'), findings: z.string(), consent_token: z.string() }),
  z.object({ name: z.string(), status: z.literal('blocked'), findings: z.string() }),
])
export type PluginInstallResult = z.infer<typeof PluginInstallResultSchema>
export type PluginCatalog = z.infer<typeof PluginCatalogSchema>
/** A skill bundle: `/<name>` loads its `skill_count` skills in one message (TAL-265). */
export const CommandBundleSchema = z.object({ name: z.string(), description: z.string(), skill_count: z.number().int(), source: z.literal('bundle') })
/** `message` is the user message that loads the bundle's skills; members not installed or disabled are in `missing_skills` or left out. */
export const CommandBundleInvocationSchema = z.object({ name: z.string(), source: z.literal('bundle'), message: z.string(), loaded_skills: z.array(z.string()), missing_skills: z.array(z.string()) })
/** `claim_live`: a running task's worker still holds its claim. `has_completion_evidence`: the task stores a result, which the Agent requires to complete it (TAL-557).
 * `agent_move_targets`: the Agent workflow's manual moves from the task's status, `null` before Agent 0.21.6 (TAL-796). */
export const KanbanTaskSchema = z.object({ id: z.string(), title: z.string(), status: z.string(), priority: z.number().int(), claim_live: z.boolean(), has_completion_evidence: z.boolean(), agent_move_targets: z.array(z.string()).nullable() }).catchall(Json)
/** Task detail's links (TAL-809): `link_tasks` names each linked task that still exists; `current_run_started_at` is the active run's start, `null` without one (`started_at` is the first-ever start). */
export const KanbanTaskLinksShape = { links: z.object({ parents: z.array(z.string()), children: z.array(z.string()) }), link_tasks: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })) }
export const KanbanRunStartShape = { current_run_started_at: z.number().nullable() }
export const KanbanAssigneeSchema = z.union([z.string(), z.object({ name: z.string(), on_disk: z.boolean().optional(), counts: z.record(z.string(), z.number().int()).optional() }).catchall(Json)])
export const KanbanEventSchema = z.object({ id: z.number().int(), task_id: z.string().nullable(), run_id: z.union([z.number().int(), z.string()]).nullable(), kind: z.string(), payload: Json, created_at: z.number().nullable() })
export const KanbanBoardMetaSchema = z.object({ slug: z.string(), name: z.string().nullable().optional(), archived: z.boolean().optional() }).catchall(Json)
export const KanbanInspectionEdgeSchema = z.object({ source: z.string(), target: z.string() })
export const KanbanInspectionNodeSchema = z.object({ key: z.string(), board: z.string(), board_name: z.string(), task: KanbanTaskSchema.extend(KanbanRunStartShape) })
export const KanbanInspectionSnapshotSchema = z.object({
  nodes: z.array(KanbanInspectionNodeSchema).max(500),
  edges: z.array(KanbanInspectionEdgeSchema).max(2000), generated_at: z.number(), truncated: z.boolean(), read_only: z.boolean(),
})
/** Busy Agent work, or retained canonical history that this Agent cannot safely retire. */
export const SessionDeleteRefusedSchema = z.enum(['active_turn', 'runtime_history_unsupported'])
export type SessionDeleteRefused = z.infer<typeof SessionDeleteRefusedSchema>
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
export const SkillCatalogIdentitySchema = z.object({
  load_name: z.string().optional(), declared_name: z.string().optional(),
  status: z.enum(['unique', 'ambiguous', 'shadowed']).optional(), tier: z.number().int().optional(),
})
export const SkillRevisionIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const SkillRevisionsInputSchema = z.object({ name: z.string().min(1).max(256), revision: SkillRevisionIdSchema.optional(), compare_to: SkillRevisionIdSchema.optional() })
/** Read-only, profile/skill-bound saved history. Raw content hashes never authorize a write or replay. */
export const SkillRevisionsSchema = z.object({
  state: z.enum(['available', 'missing', 'unavailable']),
  reason: z.enum(['backend_unavailable', 'identity_unavailable', 'history_unavailable', 'invalid_history']).nullable(),
  backend_revision: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  revisions: z.array(z.object({ id: SkillRevisionIdSchema, sha256: SkillRevisionIdSchema, label: z.string().max(12), saved_at: z.string().nullable(), actor: z.string().max(80).nullable(), current: z.boolean() })).max(64),
  selected: z.object({ revision: SkillRevisionIdSchema, content: z.string().max(32 * 1024) }).nullable(),
  comparison: z.object({ from_revision: SkillRevisionIdSchema, to_revision: SkillRevisionIdSchema, diff: z.string().max(128 * 1024) }).nullable(),
  /** Two saved revisions exist to replay against each other; the replay plan decides whether execution is possible. */
  replay_available: z.boolean(),
})
const ReplayReason = z.enum(['backend_unavailable', 'identity_unavailable', 'history_unavailable', 'invalid_history', 'route_unsupported', 'no_cases'])
export const SkillReplayRouteSchema = z.object({ provider: z.string().min(1).max(64), model: z.string().min(1).max(200) })
export const SkillReplayPlanInputSchema = z.object({ name: z.string().min(1).max(256), baseline: SkillRevisionIdSchema, candidate: SkillRevisionIdSchema })
export const SkillReplayRevisionSchema = z.object({ id: SkillRevisionIdSchema, sha256: SkillRevisionIdSchema, label: z.string().max(12), role: z.enum(['baseline', 'candidate']) })
/** One saved case's fixed recorded fixture; `id` binds the exact recorded turn, profile and skill. */
export const SkillReplayCaseSchema = z.object({ id: SkillRevisionIdSchema, case_id: z.string().max(128), title: z.string().max(120), mode: z.enum(['plan', 'reply']), input_tokens_bound: z.number().int().positive() })
export const SkillReplayPlanSidecarSchema = z.object({
  state: z.enum(['ready', 'unavailable']), reason: ReplayReason.nullable(),
  revisions: z.array(SkillReplayRevisionSchema).max(2), cases: z.array(SkillReplayCaseSchema).max(12), unavailable_cases: z.number().int().nonnegative(),
  route: SkillReplayRouteSchema.nullable(), max_output_tokens: z.number().int().positive(),
})
/** One provider call's actual answer. `unknown`: the request may have reached the provider; it is never resent. */
export const SkillReplayCaseResultSchema = z.object({
  outcome: z.enum(['completed', 'error', 'unknown']), error: z.string().max(240).nullable(), finish_reason: z.string().max(40).nullable(), provider: z.string().max(80).nullable(),
  content: z.string().max(4000), tool_calls: z.array(z.object({ name: z.string().max(128), arguments: z.string().max(1000) })).max(32),
  input_tokens: z.number().nullable(), output_tokens: z.number().nullable(), cost_usd: z.number().nullable(),
  checks: z.record(z.string(), z.boolean()), passed: z.boolean().nullable(), input_tokens_bound: z.number().int(),
})
/** Safe current-account display. Authentication success is independent of native app handoff state. */
export const NousAccountSchema = z.object({
  account_id: z.string().min(1), email: z.string().nullable(),
  state: z.enum(['idle', 'pending', 'retrying', 'claimed', 'gone', 'failed', 'paused', 'unknown', 'unavailable']),
  lines: z.array(z.string()), moved: z.array(z.string()), dropped: z.array(z.string()), reconnect: z.array(z.string()),
  poll_after: z.number().int().min(1).nullable(),
})
export type NousAccount = z.infer<typeof NousAccountSchema>
export const CronBlueprintSlotSchema = z.object({ name: z.string(), type: z.string(), label: z.string(), default: z.string().nullable(), options: z.array(z.string()), optional: z.boolean(), strict: z.boolean(), help: z.string() })
export const CronBlueprintsSchema = z.object({ blueprints: z.array(z.object({ key: z.string(), title: z.string(), description: z.string(), category: z.string(), source: z.enum(['builtin', 'plugin']), plugin: z.string().nullable(), schedule_label: z.string(), slots: z.array(CronBlueprintSlotSchema) })) })
export const CronBlueprintFillInputSchema = z.object({ key: z.string().min(1), values: z.record(z.string(), z.string()) })
export const CronBlueprintFillSchema = z.object({ draft: z.object({ name: z.string(), prompt: z.string(), schedule: z.string(), deliver: z.string(), skills: z.array(z.string()) }) })
export type CronBlueprint = z.infer<typeof CronBlueprintsSchema>['blueprints'][number]
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
const AgentUpdateStageSchema = z.enum(['install', 'gateway_restart', 'agent_ready'])
/** Immutable association retained with the existing native transaction, including its recovered outcome. */
export const AgentUpdateOperationSchema = z.object({
  operation_id: z.uuid(), baseline_revision: z.string().regex(/^[a-f0-9]{40}$/), target_revision: z.string().regex(/^[a-f0-9]{40}$/),
  stage: AgentUpdateStageSchema,
  recovered_revision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  source_moved: z.boolean().optional(),
  attempt_error: z.string().max(2000).optional(), failed_stage: AgentUpdateStageSchema.optional(),
})
export type AgentUpdateOperation = z.infer<typeof AgentUpdateOperationSchema>
/** A single-use interruption consent; the sidecar binds it to the operator intent and attested services. */
export const AgentRefreshConfirmationSchema = z.object({ token: z.string().regex(/^[a-f0-9]{32}$/), services: z.array(z.string().min(1)).min(1) })
