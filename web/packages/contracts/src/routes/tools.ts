import { McpCostPatchSchema } from '../mcp-cost-policy.js'
import { oc, type OpenAPI } from '@orpc/contract'
import { SkillRevisionsInputSchema, SkillRevisionsSchema } from '../sidecar/namespaces.js'
import { SkillReplayJobSchema, SkillReplayJobsSchema, SkillReplayPlanQuerySchema, SkillReplayPlanSchema, SkillReplayStartSchema } from '../skill-replay.js'
import { z } from 'zod'
import { ConnectorSignInOfferSchema, SkillsSchema, SkillContentSchema, SkillsUsageSchema, MemorySchema, PromptSchema, PromptsSchema, CommandsSchema, LogsSchema, InsightsSchema, AgentHealthSchema, SystemHealthSchema, McpServerSchema, McpServersSchema, McpToolsSchema, ConnectorsPageSchema, ConnectorToolsViewSchema, ConnectorOperationViewSchema, PluginsSchema, UpdatesCheckSchema, UpdatesSummarySchema, UpdateApplySchema, UpdateNotificationsSchema, UpdateNotificationSchema, TabIdSchema, FrontendBuildIdSchema, NotesSourcesSchema, NotesSearchSchema, NoteItemSchema, WikiStatusSchema, WikiBrowseSchema, WikiPageSchema, DashboardStatusSchema, DashboardConfigSchema, GatewayStatusSchema, GatewayActionSchema, ProjectOsDashboardSchema, TranscribeCapabilitySchema, SpeechPrepareSchema, PluginSettingViewSchema, OnboardingOAuthSchema } from '../views.js'
import { PluginCatalogQuerySchema, PluginCatalogSchema, PluginInstallInputSchema, PluginInstallResultSchema, PluginRuntimeApplicationSchema, PluginUpdateResultSchema, ToolsetsCatalogSchema, CommandBundleInvocationSchema, CommandBundleSchema, PendingWriteSchema, PendingWriteRefSchema } from '../sidecar/namespaces.js'

/** Skills, memory, prompts, commands, notes, insights, logs, health, MCP, plugins, updates, and diagnostics. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['tools']
const Ok = z.object({ ok: z.literal(true) })


const AgentOptions = { agent_channel: z.enum(['stable', 'experimental']).optional(), agent_refresh_token: z.string().regex(/^[a-f0-9]{32}$/).optional(), confirmed_agent_revision: z.string().regex(/^[a-f0-9]{40}$/).optional() }
const Target = z.object({ target: z.string().optional(), channel: z.string().nullable().optional(), ...AgentOptions,
  version: z.string().min(1).max(128).optional().describe('TAL-946: a Stable `versions[].ref` of this target to install instead of the newest. Rejected when it is not listed or on Experimental.'),
  tab_id: TabIdSchema.optional() })

/** TAL-784: a save whose `revision` no longer matches the file (409), so it would overwrite later changes. The page reloads. */
export const MemoryWriteConflictSchema = z.object({ error: z.string(), code: z.literal('memory_conflict') })
/**
 * TAL-886: a refused memory save (422) leaves the file untouched. `memory_char_limit`: the MEMORY.md / USER.md body is over the
 * Agent store's char limit as its parser counts it. `memory_mask_ambiguous`: the body holds a mask the page showed for more than
 * one hidden value, so the server cannot tell which one it stands for. `memory_mask_edited`: the body edits the text of a mask.
 * A conflict (409, TAL-784) leaves it untouched too.
 */
const MemoryWriteRejectionSchema = z.union([
  z.object({ error: z.string(), code: z.literal('memory_char_limit'), char_limit: z.object({ count: z.number().int(), limit: z.number().int() }) }),
  z.object({ error: z.string(), code: z.enum(['memory_mask_ambiguous', 'memory_mask_edited']), mask: z.string() }),
])
export const MemoryWriteRefusalSchema = z.union([...MemoryWriteRejectionSchema.options, MemoryWriteConflictSchema])
export type MemoryWriteRefusal = z.infer<typeof MemoryWriteRefusalSchema>
const openApiSchema = (schema: z.ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}

/** User-requested preview, separate from Agent pending writes; apply accepts only this opaque receipt. */
export const MemoryCompactionPreviewSchema = z.object({
  section: z.enum(['memory', 'user']), revision: z.string(), proposed_revision: z.string(), receipt: z.string().min(1).max(64_000),
  source: z.string(), proposed: z.string(), diff: z.string(), model: z.string(), expires_at: z.number(),
})
export type MemoryCompactionPreview = z.infer<typeof MemoryCompactionPreviewSchema>
export const MemoryCompactionApplySchema = z.object({ ok: z.literal(true), section: z.enum(['memory', 'user']), revision: z.string() })

export const MemoryCompactionRefusalSchema = z.union([
  MemoryWriteRefusalSchema,
  z.object({ error: z.string(), code: z.enum(['memory_compaction_conflict', 'memory_compaction_invalid']) }),
  z.object({ error: z.string(), code: z.literal('memory_compaction_unavailable'), condition: z.string() }),
])
const compactionSpec = (op: OpenAPI.OperationObject): OpenAPI.OperationObject => ({ ...op, responses: {
  ...op.responses,
  ...Object.fromEntries([409, 422, 503].map((status) => [status, { description: 'Compaction refused or unavailable. The review is retained; no unconfirmed write is replayed.', content: { 'application/json': { schema: openApiSchema(MemoryCompactionRefusalSchema) } } }])),
} })

/** TAL-819: a kind's staged writes and whether the page shows its review panel. */
export const PendingWritesSchema = z.object({ kind: z.enum(['skills', 'memory']), visible: z.boolean(), enabled: z.boolean(), items: z.array(PendingWriteSchema) })
export type PendingWrites = z.infer<typeof PendingWritesSchema>
const PendingWritesReviewInput = z.object({ kind: z.enum(['skills', 'memory']), writes: z.array(PendingWriteRefSchema).min(1) })
const PendingWritesReviewSchema = z.object({ results: z.array(z.object({ id: z.string(), done: z.boolean(), message: z.string() })) })

export const toolsContract = {
  toolsetsCatalog: oc.route({ method: 'POST', path: '/api/toolsets', tags, summary: 'Read the current profile catalog with a draft selection. Null uses profile defaults.' }).input(z.object({ session_id: z.string().optional(), toolsets: z.array(z.string()).nullable() })).output(ToolsetsCatalogSchema),
  skills: {
    revisions: oc.route({ method: 'GET', path: '/api/skills/revisions', tags, summary: 'Inspect actual saved skill history from the consented reviewed backend. Profile/skill-bound IDs refuse stale or foreign selections. No history is fabricated; inspection cannot execute checks, call providers, run a judge or change skills.' }).input(SkillRevisionsInputSchema).output(SkillRevisionsSchema),
    replayPlan: oc.route({ method: 'GET', path: '/api/skills/replays/plan', tags, summary: 'The consent summary for replaying the skill\'s saved cases against two exact revisions: case fixtures, the verified provider route and the reserved budget. Reads only.' }).input(SkillReplayPlanQuerySchema).output(SkillReplayPlanSchema),
    replays: oc.route({ method: 'GET', path: '/api/skills/replays', tags, summary: 'This owner\'s retained replay jobs for the skill in the active profile, newest first.' }).input(z.object({ name: z.string().min(1).max(256) })).output(SkillReplayJobsSchema),
    replayStart: oc.route({ method: 'POST', path: '/api/skills/replays', tags, summary: 'Admit one confirmed replay. The request binds owner, profile, skill, both revisions, case fixtures, route and budget; any drift refuses before a provider call. Repeating a request_id returns the admitted job. 409: drift, a reused request_id, a request_id whose results were pruned, or a replay already running.' }).input(SkillReplayStartSchema).output(SkillReplayJobSchema),
    replayCancel: oc.route({ method: 'POST', path: '/api/skills/replays/cancel', tags, summary: 'Stop a replay\'s remaining calls. A call already sent keeps its actual or unknown outcome. 404 outside the owner and profile that admitted it.' }).input(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) })).output(SkillReplayJobSchema),
    list: oc.route({ method: 'GET', path: '/api/skills', tags }).input(z.object({ category: z.string().optional() })).output(SkillsSchema),
    usage: oc.route({ method: 'GET', path: '/api/skills/usage', tags }).output(SkillsUsageSchema),
    content: oc.route({ method: 'GET', path: '/api/skills/content', tags, summary: 'Skill view, or one linked file when `file` is given.' }).input(z.object({ name: z.string().optional(), file: z.string().optional() })).output(SkillContentSchema),
    save: oc.route({ method: 'POST', path: '/api/skills/save', tags }).input(z.object({ name: z.string().optional(), content: z.string().optional(), category: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string(), path: z.string() })),
    delete: oc.route({ method: 'POST', path: '/api/skills/delete', tags }).input(z.object({ name: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string() })),
    toggle: oc.route({ method: 'POST', path: '/api/skills/toggle', tags, summary: 'Writes `skills.disabled` (and `skills.platform_disabled.webui` when present) in config.yaml.' }).input(z.object({ name: z.string().optional(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean() })),
  },
  memory: {
    compactionPreview: oc.route({ method: 'POST', path: '/api/memory/compaction/preview', tags, spec: compactionSpec, summary: 'Generate a bounded compaction through the configured compression auxiliary route, without writing. Secrets and protected entries are retained locally. Preview binds the active profile, source revision, proposal and expiry; an unavailable privacy-safe route returns 503.' }).input(z.object({ section: z.enum(['memory', 'user']), revision: z.string() })).output(MemoryCompactionPreviewSchema),
    compactionApply: oc.route({ method: 'POST', path: '/api/memory/compaction/apply', tags, spec: compactionSpec, summary: 'Explicitly apply the exact preview receipt through the Agent-format and locked revision gate. Stale, foreign or expired receipts are refused. Repeated acknowledgments reconcile with the exact proposed bytes without rewriting.' }).input(z.object({ receipt: z.string().min(1).max(64_000) })).output(MemoryCompactionApplySchema),
    get: oc.route({ method: 'GET', path: '/api/memory', tags }).input(z.object({ session_id: z.string().optional(), workspace: z.string().optional() })).output(MemorySchema),
    write: oc.route({ method: 'POST', path: '/api/memory/write', tags, summary: '`section` names the file (memory, user, soul); the legacy `target` alias is accepted. `revision` is the section\'s `*_revision` the edit started from; 409 refuses the save when the file changed since. Masks the page showed are restored to the values they hide; 422 refuses an ambiguous or edited mask, or a MEMORY.md / USER.md body over the Agent store limit.', spec: (op) => ({ ...op, responses: { ...op.responses, 409: { description: 'The file changed since `revision`; the file is untouched.', content: { 'application/json': { schema: openApiSchema(MemoryWriteConflictSchema) } } }, 422: { description: 'Refused; the file is untouched.', content: { 'application/json': { schema: openApiSchema(MemoryWriteRejectionSchema) } } } } }) }).input(z.object({ section: z.string().optional(), target: z.string().optional(), content: z.string().optional(), revision: z.string() })).output(z.object({ ok: z.literal(true), section: z.string(), path: z.string() })),
  },
  pendingWrites: {
    list: oc.route({ method: 'GET', path: '/api/pending-writes', tags, summary: 'TAL-819: the active profile\'s skill or memory writes the Agent staged for approval, oldest first, each with the diff approving it applies. `visible` is whether the page shows its review panel (any write pending); `enabled` is the profile\'s `<kind>.write_approval` gate. `summary` and `diff` are redacted like the memory page (`api_redact_enabled`); `revision` is the hash of the raw diff. An Agent without the review handlers, or no running Agent, lists none.' })
      .input(z.object({ kind: z.enum(['skills', 'memory']) })).output(PendingWritesSchema),
    approve: oc.route({ method: 'POST', path: '/api/pending-writes/approve', tags, summary: 'TAL-819: apply each staged write through the Agent\'s `/skills` or `/memory approve`. Each write carries the `revision` the user reviewed; a write whose diff changed since is refused unapplied. `done` is false when the write was not applied (its record stays pending); `message` is the Agent\'s text either way, redacted.' })
      .input(PendingWritesReviewInput).output(PendingWritesReviewSchema),
    reject: oc.route({ method: 'POST', path: '/api/pending-writes/reject', tags, summary: 'TAL-819: discard each staged write through the Agent\'s `/skills` or `/memory reject`.' })
      .input(PendingWritesReviewInput).output(PendingWritesReviewSchema),
  },
  prompts: {
    list: oc.route({ method: 'GET', path: '/api/prompts', tags }).output(PromptsSchema),
    create: oc.route({ method: 'POST', path: '/api/prompts', tags }).input(z.object({ text: z.string().optional(), label: z.string().optional() })).output(z.object({ ok: z.literal(true), prompt: PromptSchema })),
    delete: oc.route({ method: 'DELETE', path: '/api/prompts', tags }).input(z.object({ id: z.string().optional() })).output(Ok),
  },
  commands: {
    list: oc.route({ method: 'GET', path: '/api/commands', tags }).output(CommandsSchema),
    exec: oc.route({ method: 'POST', path: '/api/commands/exec', tags }).input(z.object({ command: z.string().optional(), session_id: z.string().optional() })).output(z.object({ output: z.string() })),
    bundles: oc.route({ method: 'GET', path: '/api/commands/bundles', tags, summary: "The active profile's skill bundles; empty when the Agent is unavailable." }).output(z.object({ bundles: z.array(CommandBundleSchema) })),
    resolveBundle: oc.route({ method: 'POST', path: '/api/commands/bundles/resolve', tags, summary: 'Expands `/<bundle> [instruction]` into the user message that loads its skills. 404 for an unknown bundle.' }).input(z.object({ command: z.string().optional() })).output(CommandBundleInvocationSchema),
    resolveMoa: oc.route({ method: 'GET', path: '/api/commands/moa/resolve', tags, summary: "The active profile's normalized MoA config merged with `preset`, or its default preset when that is absent or unknown. 503 when the Agent has no MoA." }).input(z.object({ preset: z.string().optional() })).output(z.looseObject({ preset: z.string(), usage: z.string() })),
  },
  notes: {
    sources: oc.route({ method: 'GET', path: '/api/notes/sources', tags }).output(NotesSourcesSchema),
    search: oc.route({ method: 'GET', path: '/api/notes/search', tags, summary: 'Joplin notes matching `q` (`limit` 1-50, default 20). 404 while external notes sources are disabled; 502 when Joplin fails.' }).input(z.object({ source: z.string().optional(), q: z.string().optional(), limit: z.string().optional() })).output(NotesSearchSchema),
    item: oc.route({ method: 'GET', path: '/api/notes/item', tags, summary: 'One Joplin note for preview. 404 while external notes sources are disabled; 502 for an invalid id or a Joplin failure.' }).input(z.object({ source: z.string().optional(), id: z.string().optional() })).output(NoteItemSchema),
  },
  wiki: {
    status: oc.route({ method: 'GET', path: '/api/wiki/status', tags, summary: 'LLM wiki summary from `WIKI_PATH` (env, then the profile `.env`), `skills.config.wiki.path` or `wiki.path` in config.yaml, else `~/wiki`. Always 200.' }).output(WikiStatusSchema),
    browse: oc.route({ method: 'GET', path: '/api/wiki/browse', tags, summary: 'Allowlisted `*.md` pages under `entities`, `concepts`, `comparisons`, and `queries`; 404 when the wiki directory is missing.' }).output(WikiBrowseSchema),
    page: oc.route({ method: 'GET', path: '/api/wiki/page', tags, summary: 'One allowlisted page, cut at 2 MiB. 400 for a missing or non-canonical path; 404 for anything not listed.' }).input(z.object({ path: z.string().optional() })).output(WikiPageSchema),
  },
  insights: oc.route({ method: 'GET', path: '/api/insights', tags }).input(z.object({ days: z.string().optional() })).output(InsightsSchema),
  logs: oc.route({ method: 'GET', path: '/api/logs', tags }).input(z.object({ file: z.string().optional(), tail: z.string().optional() })).output(LogsSchema),
  ops: {
    agent: oc.route({ method: 'GET', path: '/api/health/agent', tags }).output(AgentHealthSchema),
    system: oc.route({ method: 'GET', path: '/api/system/health', tags }).output(SystemHealthSchema),
    restart: oc.route({ method: 'POST', path: '/api/health/restart', tags, summary: 'Restart the Hermes gateway for the active profile (operator only). 409 `gateway_externally_managed` (`GatewayLifecycleRefusal`) before anything runs when Web does not control the monitored Gateway (TAL-1627).' }).input(Loose.optional()).output(z.object({ ok: z.literal(true), message: z.string() })),
    dashboard: oc.route({ method: 'GET', path: '/api/dashboard/status', tags }).output(DashboardStatusSchema),
    dashboardConfig: oc.route({ method: 'GET', path: '/api/dashboard/config', tags, summary: "The active profile's `webui.dashboard` link settings. 400 when the stored URL is invalid." }).output(DashboardConfigSchema),
    saveDashboardConfig: oc.route({ method: 'POST', path: '/api/dashboard/config', tags, summary: "Writes `webui.dashboard.{enabled,url}` to the active profile's config.yaml; an empty `url` removes it. 400 for an invalid mode or URL." }).input(z.object({ enabled: Json.optional(), url: Json.optional() })).output(DashboardConfigSchema),
    projectOs: oc.route({ method: 'GET', path: '/api/project-os/dashboard', tags, summary: 'Project OS handoff, status, and docs for the current repo. Always 200.' }).input(z.object({ board: z.string().optional() })).output(ProjectOsDashboardSchema),
    shutdown: oc.route({ method: 'POST', path: '/api/shutdown', tags, summary: 'Stop the server process (operator only).' }).input(Loose.optional()).output(z.object({ status: z.literal('shutting_down') })),
  },
  gateway: {
    status: oc.route({ method: 'GET', path: '/api/gateway/status', tags }).output(GatewayStatusSchema),
    start: oc.route({ method: 'POST', path: '/api/gateway/start', tags, summary: 'Run `hermes gateway start` for the active profile (operator only). A named profile the Agent refuses its own gateway starts the host gateway from the root profile, then retries. 409 while another gateway action runs, 500 with the Agent\'s first error line on failure, 504 after 60 seconds. 409 `gateway_externally_managed` (`GatewayLifecycleRefusal`) before anything runs when Web does not control the monitored Gateway (TAL-1627).' }).input(Loose.optional()).output(GatewayActionSchema),
    stop: oc.route({ method: 'POST', path: '/api/gateway/stop', tags, summary: 'Run `hermes gateway stop` for the active profile (operator only). 409 while another gateway action runs, 500 with the Agent\'s first error line on failure, 504 after 60 seconds. 409 `gateway_externally_managed` (`GatewayLifecycleRefusal`) before anything runs when Web does not control the monitored Gateway (TAL-1627).' }).input(Loose.optional()).output(GatewayActionSchema),
    restart: oc.route({ method: 'POST', path: '/api/gateway/restart', tags, summary: 'Run `hermes gateway restart` for the active profile (operator only). A named profile the Agent refuses its own gateway starts the host gateway from the root profile, then retries. The old gateway drains for the Agent\'s own restart budget before it is replaced. 409 while another gateway action runs, 500 with the Agent\'s first error line on failure, 504 with the sidecar\'s timeout message once that budget runs out. 409 `gateway_externally_managed` (`GatewayLifecycleRefusal`) before anything runs when Web does not control the monitored Gateway (TAL-1627).' }).input(Loose.optional()).output(GatewayActionSchema),
  },
  mcp: {
    servers: oc.route({ method: 'GET', path: '/api/mcp/servers', tags }).output(McpServersSchema),
    tools: oc.route({ method: 'GET', path: '/api/mcp/tools', tags, summary: '`q` keeps tools whose name, server, or description contains it (case-insensitive); `total` counts every known tool.' }).input(z.object({ q: z.string().optional() })).output(McpToolsSchema),
    action: oc.route({ method: 'POST', path: '/api/mcp/servers/{name}', tags, summary: '`{enabled}` toggles, `{delete: true}` removes, `{url|command, ...}` adds or updates the server in config.yaml.' }).input(z.object({ name: z.string() }).catchall(Json)).output(Loose),
    toggle: oc.route({ method: 'PATCH', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean() })),
    update: oc.route({ method: 'PUT', path: '/api/mcp/servers/{name}', tags, summary: '`{events}` alone sets the experimental MCP events opt-in and nothing else (TAL-1510); `{cost_policy, config_revision}` edits the declared cost policy; otherwise `{url|command, ...}` replaces the transport.' }).input(z.object({ name: z.string(), config_revision: z.string().optional(), cost_policy: McpCostPatchSchema.optional(), events: z.boolean().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), server: McpServerSchema })),
    delete: oc.route({ method: 'DELETE', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string() })).output(z.object({ ok: z.literal(true), deleted: z.string() })),
  },
  /**
   * TAL-818: Nous tool-gateway apps (the Agent's portal connectors). Failures carry `code`: `connectors_unavailable` (404),
   * `connectors_sign_in` / `connectors_forbidden` (403), `policy_conflict` / `connectors_org_required` / `operation_settled` /
   * `operation_refused` (409), `connector_not_found` / `connection_not_found` / `operation_not_found` (404), `policy_invalid` (400),
   * `connectors_failed` (502).
   */
  connectors: {
    available: oc.route({ method: 'GET', path: '/api/connectors/available', tags, summary: "Whether the active profile has connectors; false hides the Connectors page. Never creates an identity." }).output(z.object({ available: z.boolean() })),
    page: oc.route({ method: 'GET', path: '/api/connectors', tags, summary: 'Every catalog app with its accounts and member rules. `available: false` with no apps when the profile has no connectors.' }).output(ConnectorsPageSchema),
    dismissOffer: oc.route({ method: 'POST', path: '/api/connectors/sign-in-offer/dismiss', tags, summary: 'Acknowledge the current profile guest offer. Idempotent for the same offer; preserves native backoff.' }).input(z.object({ offer_id: z.string().min(1) })).output(ConnectorSignInOfferSchema),
    tools: oc.route({ method: 'GET', path: '/api/connectors/{connector}/tools', tags, summary: "One app's tools with their member and organization rules." }).input(z.object({ connector: z.string() })).output(ConnectorToolsViewSchema),
    setPolicy: oc.route({ method: 'POST', path: '/api/connectors/{connector}/policy', tags, summary: 'One member-rule change from `revision` (the page\'s `policy_revision`): `enabled` turns the app on or off, or `tool` with `tool_enabled` one of its tools. 409 `policy_conflict` when the rules changed since.' }).input(z.object({ connector: z.string(), revision: z.string().min(1), enabled: z.boolean().optional(), tool: z.string().min(1).optional(), tool_enabled: z.boolean().optional() })).output(z.object({ ok: z.literal(true), revision: z.string() })),
    connect: oc.route({ method: 'POST', path: '/api/connectors/{connector}/connect', tags, summary: "Starts the app's authorization (or rejoins an open one) and answers with its link; poll the operation until it settles." }).input(z.object({ connector: z.string(), nous_account_id: z.string().min(1).optional() })).output(ConnectorOperationViewSchema),
    removeAccount: oc.route({ method: 'DELETE', path: '/api/connectors/accounts/{connection_id}', tags, summary: 'Disconnects one account at the portal.' }).input(z.object({ connection_id: z.string().min(1) })).output(Ok),
    operation: oc.route({ method: 'GET', path: '/api/connectors/operations/{op_id}', tags }).input(z.object({ op_id: z.string().min(1) })).output(ConnectorOperationViewSchema),
    respond: oc.route({ method: 'POST', path: '/api/connectors/operations/{op_id}', tags, summary: '`skip`, `retry` or `approve` (with `env`) one `target`, as its `actions` allow, or `continue` the card without the rest.' }).input(z.object({ op_id: z.string().min(1), action: z.enum(['skip', 'retry', 'approve', 'continue']), target: z.string().optional(), env: z.record(z.string(), z.string()).optional() })).output(ConnectorOperationViewSchema),
  },
  plugins: oc.route({ method: 'GET', path: '/api/plugins', tags }).output(PluginsSchema),
  pluginCatalog: oc.route({ method: 'GET', path: '/api/plugins/catalog', tags }).input(PluginCatalogQuerySchema).output(PluginCatalogSchema),
  pluginInstall: oc.route({ method: 'POST', path: '/api/plugins/install', tags, summary: 'Operator only: preview or confirm a reviewed catalog pin. Confirmation is single use and binds the profile, catalog entry and staged tree. Native scan and admission apply; no replacement, dependency approval, enabling or Desktop UI grant.' })
    .input(PluginInstallInputSchema).output(PluginInstallResultSchema),
  pluginUpdate: oc.route({ method: 'POST', path: '/api/plugins/update', tags, summary: 'Operator only: update a profile-installed Git plugin through the Agent scan transaction. Caution requires accept_caution plus the single-use consent_token bound to the profile, installation and scanned revision; changed or expired consent returns 409. Dangerous always blocks.' })
    .input(z.object({ key: z.string().trim().min(1), accept_caution: z.boolean().default(false), consent_token: z.string().min(1).max(128).optional() }))
    .output(PluginUpdateResultSchema),
  pluginSettings: oc.route({ method: 'POST', path: '/api/plugins/settings', tags, summary: 'TAL-806 (operator only): save a plugin\'s manifest-declared settings. `values` holds non-secret fields as the form entered them (numbers and JSON as text); the server checks each against the field list, writes the changed ones to `plugins.entries.<key>.settings`, and writes `secrets` to the profile `.env` under each field\'s `env` name (an empty one removes it). Secrets are written first; when a later write is refused, the ones already written are restored. 400 for an undeclared key, a bad value or a `locked` secret; 409 when the manifest changed; 503 when the Agent sidecar stopped before confirming (secrets stay written); 403 on a managed install, 404 for an unknown plugin. After persistence, runtime_application separately reports applied, restart_required, or unknown; runtime reconnect failures never roll saved secrets back.' })
    .input(z.object({ key: z.string().min(1), values: z.record(z.string(), Json).optional(), secrets: z.record(z.string(), z.string()).optional() }))
    .output(z.object({ ok: z.literal(true), key: z.string(), written: z.array(z.string()), settings: z.array(PluginSettingViewSchema), runtime_application: PluginRuntimeApplicationSchema })),
  pluginOAuthRedirect: oc.route({ method: 'POST', path: '/api/plugins/oauth/redirect', tags, summary: 'TAL-1276 (operator only): finish a plugin client\'s browser sign-in with `url`, the address the browser showed after the approval, when that address does not open on the Agent\'s machine. 400 `oauth_redirect_invalid` unless it is the flow\'s `redirect_uri` on 127.0.0.1 with the flow\'s `state`; 404 for an unknown flow, 409 `oauth_flow_ended` once it ended. Poll the flow afterwards.' })
    .input(z.object({ flow_id: z.string().min(1), url: z.string().min(1) })).output(OnboardingOAuthSchema),
  pluginOAuthLogout: oc.route({ method: 'POST', path: '/api/plugins/oauth/logout', tags, summary: 'TAL-1276 (operator only): sign out of a plugin-declared OAuth client (`hermes auth logout <key>:<id>`). `removed` is false when no grant was stored.' })
    .input(z.object({ key: z.string().min(1), id: z.string().min(1) })).output(z.object({ ok: z.literal(true), removed: z.boolean() })),
  updates: {
    check: oc.route({ method: 'GET', path: '/api/updates/check', tags, summary: 'Cached status; `POST` runs the check. Git source installs can update from completed releases (stable) or origin/main (experimental); direct global npm installs can update to completed stable npm releases.' }).output(UpdatesCheckSchema),
    checkNow: oc.route({ method: 'POST', path: '/api/updates/check', tags }).input(z.object({ force: Json.optional(), channel: z.string().nullable().optional(), agent_channel: AgentOptions.agent_channel })).output(UpdatesCheckSchema),
    apply: oc.route({ method: 'POST', path: '/api/updates/apply', tags }).input(Target).output(UpdateApplySchema),
    force: oc.route({ method: 'POST', path: '/api/updates/force', tags }).input(Target).output(UpdateApplySchema),
    clearLock: oc.route({ method: 'POST', path: '/api/updates/clear_lock', tags }).input(Target).output(UpdateApplySchema),
    summary: oc.route({ method: 'POST', path: '/api/updates/summary', tags }).input(z.strictObject({ target: z.enum(['webui', 'agent']) })).output(UpdatesSummarySchema),
  },
  updateNotifications: {
    list: oc.route({ method: 'GET', path: '/api/update-notifications', tags, summary: 'Server-owned update operation history for the authenticated owner and active profile. A Web tab passes its tab_id and loaded_build so the server compares that build and keeps its tab-scoped refresh notice.' }).input(z.object({ tab_id: TabIdSchema.optional(), loaded_build: FrontendBuildIdSchema.optional() })).output(UpdateNotificationsSchema),
    read: oc.route({ method: 'POST', path: '/api/update-notifications/{id}/read', tags }).input(z.object({ id: z.uuid(), read: z.literal(true), tab_id: TabIdSchema.optional() })).output(UpdateNotificationSchema),
    dismiss: oc.route({ method: 'POST', path: '/api/update-notifications/{id}/dismiss', tags }).input(z.object({ id: z.uuid(), dismiss: z.literal(true), tab_id: TabIdSchema.optional() })).output(z.object({ ok: z.literal(true) })),
    clear: oc.route({ method: 'POST', path: '/api/update-notifications/clear', tags }).input(z.object({ clear: z.literal(true), tab_id: TabIdSchema.optional(), loaded_build: FrontendBuildIdSchema.optional() })).output(UpdateNotificationsSchema),
    cancel: oc.route({ method: 'POST', path: '/api/update-notifications/{id}/cancel', tags }).input(z.object({ id: z.uuid(), cancel: z.literal(true) })).output(UpdateNotificationSchema),
    action: oc.route({ method: 'POST', path: '/api/update-notifications/{id}/actions/{action_id}', tags }).input(z.object({ id: z.uuid(), action_id: z.string().min(1).max(64), perform: z.literal(true), tab_id: TabIdSchema.optional() })).output(UpdateNotificationSchema),
  },
  transcribeCapability: oc.route({ method: 'GET', path: '/api/transcribe/capability', tags }).output(TranscribeCapabilitySchema),
  speech: {
    prepare: oc.route({ method: 'POST', path: '/api/speech/prepare', tags, summary: 'TAL-906: the read-aloud script for `text` (the Agent\'s `prepare_spoken_text`): Markdown, reasoning blocks, filenames, paths, UUIDs, hashes, and URLs are dropped, at most 4000 characters. `/api/tts` speaks the same script. The text as written, trimmed, when the Agent cannot prepare it.' })
      .input(z.object({ text: z.string().max(100_000) })).output(SpeechPrepareSchema),
  },
  transcribeWarm: oc.route({ method: 'POST', path: '/api/transcribe/warm', tags, summary: 'Start loading the profile\'s speech-to-text engine in the background and answer at once (TAL-916). Send when a recording starts and the capability has warm_supported.' }).output(z.object({ ok: z.literal(true) })),
  clientEvents: oc.route({ method: 'POST', path: '/api/client-events/log', tags, summary: 'Bounded browser diagnostics; only whitelisted scalar fields are logged.' }).input(Loose).output(z.object({ ok: z.literal(true), event: z.string().nullable() })),
}
