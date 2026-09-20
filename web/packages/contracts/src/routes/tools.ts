import { oc } from '@orpc/contract'
import { z } from 'zod'

/** Skills, memory, prompts, commands, notes, insights, logs, health, MCP, plugins, updates, and diagnostics. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['tools']
const Ok = z.object({ ok: z.literal(true) })

export const SkillListRowSchema = z.object({ name: z.string(), description: z.string(), category: z.string().nullable(), disabled: z.boolean() })
export const SkillsUsageSchema = z.object({ usage: z.record(z.string(), Loose), skill_names: z.array(z.string()), total_invocations: z.number().int(), unique_skills_used: z.number().int() })
export const MemorySchema = z.object({
  memory: z.string(), user: z.string(), soul: z.string(), project_context: z.string(), memory_path: z.string(), user_path: z.string(), soul_path: z.string(), project_context_path: z.string(),
  project_context_name: z.string(), project_context_workspace: z.string(), memory_mtime: z.number().nullable(), user_mtime: z.number().nullable(), soul_mtime: z.number().nullable(), project_context_mtime: z.number().nullable(),
  project_context_shadowed: z.array(Loose), external_notes_enabled: z.boolean(),
})
export const PromptSchema = z.object({ id: z.string(), label: z.string(), text: z.string(), created_at: z.number() })
export const CommandRowSchema = z.object({ name: z.string(), description: z.string(), category: z.string(), aliases: z.array(z.string()), args_hint: z.string(), subcommands: z.array(z.string()), cli_only: z.boolean(), gateway_only: z.boolean() }).catchall(Json)
export const LogsSchema = z.object({ file: z.string(), tail: z.number().int(), lines: z.array(z.string()), truncated: z.boolean(), total_bytes: z.number().int(), mtime: z.number().nullable(), hint: z.string() })
export const InsightsSchema = z.object({
  period_days: z.number().int(), total_sessions: z.number().int(), total_messages: z.number().int(), total_input_tokens: z.number().int(), total_output_tokens: z.number().int(), total_cache_read_tokens: z.number().int(),
  total_cache_hit_percent: z.number().nullable(), total_tokens: z.number().int(), total_cost: z.number(), models: z.array(Loose), daily_tokens: z.array(Loose), activity_by_day: z.array(z.object({ day: z.string(), sessions: z.number().int() })), activity_by_hour: z.array(z.object({ hour: z.number().int(), sessions: z.number().int() })),
})
export const AgentHealthSchema = z.object({ alive: z.boolean().nullable(), checked_at: z.string(), details: Loose, gateway_chat: z.object({ enabled: z.boolean(), backend: z.string(), base_url_configured: z.boolean(), api_key_configured: z.boolean() }) })
export const SystemHealthSchema = z.object({ status: z.string(), available: z.boolean(), checked_at: z.string(), cpu: Loose.nullable(), memory: Loose.nullable(), disk: Loose.nullable(), webui_runtime: Loose, errors: z.array(z.object({ metric: z.string(), code: z.string() })) })
export const McpServerSchema = z.object({ name: z.string(), transport: z.string(), enabled: z.boolean(), active: z.boolean(), status: z.string(), tool_count: z.number().int().nullable(), health: z.string(), health_detail: z.string(), health_checked_at: Json, health_pending: z.boolean() }).catchall(Json)
export const McpServersSchema = z.object({ servers: z.array(McpServerSchema), toggle_supported: z.literal(true), reload_required: z.literal(true), health_pending: z.boolean() })
export const McpToolsSchema = z.object({ tools: z.array(Loose), total: z.number().int(), source: z.string(), inventory_scope: z.string(), unavailable_servers: z.array(z.string()) })
export const PluginsSchema = z.object({ plugins: z.array(Loose), empty: z.boolean(), supported_hooks: z.array(z.string()), read_only: z.literal(true), unavailable: z.boolean().optional() })
export const UpdateTargetSchema = z.object({ name: z.string(), behind: z.number().int().nullable(), current_sha: z.string().nullable(), latest_sha: z.string().nullable(), manual_update: z.boolean(), no_git: z.boolean(), ignored: z.boolean().optional(), current_version: z.string().optional(), error: z.string().optional() })
export const UpdatesCheckSchema = z.union([z.object({ disabled: z.literal(true) }), z.object({ webui: UpdateTargetSchema, agent: UpdateTargetSchema, checked_at: z.number(), include_agent: z.boolean(), channel: z.string(), cached: z.boolean() })])
export const NotesSourcesSchema = z.object({ enabled: z.boolean(), sources: z.array(Loose), source: z.string(), inventory_scope: z.string(), attach_supported: z.literal(false), automatic_recall_unchanged: z.literal(true), recent_ai_notes: z.array(Loose) })
export const DashboardStatusSchema = z.object({ running: z.boolean(), enabled: z.string(), url: z.string().optional(), browser_url: z.string().optional(), host: z.string().optional(), port: z.number().int().optional(), version: z.string().optional(), error: z.string().optional() })

const Target = z.object({ target: z.string().optional(), channel: z.string().nullable().optional() })

export const toolsContract = {
  skills: {
    list: oc.route({ method: 'GET', path: '/api/skills', tags }).input(z.object({ category: z.string().optional() })).output(z.object({ skills: z.array(SkillListRowSchema) })),
    usage: oc.route({ method: 'GET', path: '/api/skills/usage', tags }).output(SkillsUsageSchema),
    content: oc.route({ method: 'GET', path: '/api/skills/content', tags, summary: 'Skill view, or one linked file when `file` is given.' }).input(z.object({ name: z.string().optional(), file: z.string().optional() })).output(Loose),
    save: oc.route({ method: 'POST', path: '/api/skills/save', tags }).input(z.object({ name: z.string().optional(), content: z.string().optional(), category: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string(), path: z.string() })),
    delete: oc.route({ method: 'POST', path: '/api/skills/delete', tags }).input(z.object({ name: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string() })),
    toggle: oc.route({ method: 'POST', path: '/api/skills/toggle', tags, summary: 'Writes `skills.disabled` (and `skills.platform_disabled.webui` when present) in config.yaml.' }).input(z.object({ name: z.string().optional(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean() })),
  },
  memory: {
    get: oc.route({ method: 'GET', path: '/api/memory', tags }).input(z.object({ session_id: z.string().optional(), workspace: z.string().optional() })).output(MemorySchema),
    write: oc.route({ method: 'POST', path: '/api/memory/write', tags }).input(z.object({ section: z.string().optional(), target: z.string().optional(), content: z.string().optional() })).output(z.object({ ok: z.literal(true), section: z.string(), path: z.string() })),
  },
  prompts: {
    list: oc.route({ method: 'GET', path: '/api/prompts', tags }).output(z.object({ prompts: z.array(PromptSchema) })),
    create: oc.route({ method: 'POST', path: '/api/prompts', tags }).input(z.object({ text: z.string().optional(), label: z.string().optional() })).output(z.object({ ok: z.literal(true), prompt: PromptSchema })),
    delete: oc.route({ method: 'DELETE', path: '/api/prompts', tags }).input(z.object({ id: z.string().optional() })).output(Ok),
  },
  commands: {
    list: oc.route({ method: 'GET', path: '/api/commands', tags }).output(z.object({ commands: z.array(CommandRowSchema) })),
    exec: oc.route({ method: 'POST', path: '/api/commands/exec', tags }).input(z.object({ command: z.string().optional(), session_id: z.string().optional() })).output(z.object({ output: z.string() })),
  },
  notes: {
    sources: oc.route({ method: 'GET', path: '/api/notes/sources', tags }).output(NotesSourcesSchema),
    search: oc.route({ method: 'GET', path: '/api/notes/search', tags }).input(z.object({ source: z.string().optional(), q: z.string().optional(), limit: z.string().optional() })).output(Loose),
  },
  insights: oc.route({ method: 'GET', path: '/api/insights', tags }).input(z.object({ days: z.string().optional() })).output(InsightsSchema),
  logs: oc.route({ method: 'GET', path: '/api/logs', tags }).input(z.object({ file: z.string().optional(), tail: z.string().optional() })).output(LogsSchema),
  ops: {
    agent: oc.route({ method: 'GET', path: '/api/health/agent', tags }).output(AgentHealthSchema),
    system: oc.route({ method: 'GET', path: '/api/system/health', tags }).output(SystemHealthSchema),
    restart: oc.route({ method: 'POST', path: '/api/health/restart', tags, summary: 'Restart the Hermes gateway for the active profile (operator only).' }).input(Loose.optional()).output(z.object({ ok: z.literal(true), message: z.string() })),
    dashboard: oc.route({ method: 'GET', path: '/api/dashboard/status', tags }).output(DashboardStatusSchema),
    shutdown: oc.route({ method: 'POST', path: '/api/shutdown', tags, summary: 'Stop the server process (operator only).' }).input(Loose.optional()).output(z.object({ status: z.literal('shutting_down') })),
  },
  mcp: {
    servers: oc.route({ method: 'GET', path: '/api/mcp/servers', tags }).output(McpServersSchema),
    tools: oc.route({ method: 'GET', path: '/api/mcp/tools', tags }).output(McpToolsSchema),
    action: oc.route({ method: 'POST', path: '/api/mcp/servers/{name}', tags, summary: '`{enabled}` toggles, `{delete: true}` removes, `{url|command, ...}` adds or updates the server in config.yaml.' }).input(z.object({ name: z.string() }).catchall(Json)).output(Loose),
    toggle: oc.route({ method: 'PATCH', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean() })),
    update: oc.route({ method: 'PUT', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string() }).catchall(Json)).output(z.object({ ok: z.literal(true), server: McpServerSchema })),
    delete: oc.route({ method: 'DELETE', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string() })).output(z.object({ ok: z.literal(true), deleted: z.string() })),
  },
  plugins: oc.route({ method: 'GET', path: '/api/plugins', tags }).output(PluginsSchema),
  updates: {
    check: oc.route({ method: 'GET', path: '/api/updates/check', tags, summary: 'npm builds report `manual_update` targets; git-based self-update is not available.' }).output(UpdatesCheckSchema),
    checkNow: oc.route({ method: 'POST', path: '/api/updates/check', tags }).input(z.object({ force: Json.optional(), channel: z.string().nullable().optional() })).output(UpdatesCheckSchema),
    apply: oc.route({ method: 'POST', path: '/api/updates/apply', tags }).input(Target).output(Loose),
    force: oc.route({ method: 'POST', path: '/api/updates/force', tags }).input(Target).output(Loose),
    clearLock: oc.route({ method: 'POST', path: '/api/updates/clear_lock', tags }).input(Target).output(Loose),
    summary: oc.route({ method: 'POST', path: '/api/updates/summary', tags }).input(z.object({ updates: Loose.optional(), target: z.string().nullable().optional() })).output(Loose),
  },
  transcribeCapability: oc.route({ method: 'GET', path: '/api/transcribe/capability', tags }).output(z.object({ ok: z.literal(true), available: z.boolean(), provider: z.string() })),
  clientEvents: oc.route({ method: 'POST', path: '/api/client-events/log', tags, summary: 'Bounded browser diagnostics; only whitelisted scalar fields are logged.' }).input(Loose).output(z.object({ ok: z.literal(true), event: z.string().nullable() })),
}
