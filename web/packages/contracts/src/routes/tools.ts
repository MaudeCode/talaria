import { oc } from '@orpc/contract'
import { z } from 'zod'
import { SkillsSchema, SkillContentSchema, SkillsUsageSchema, MemorySchema, PromptSchema, PromptsSchema, CommandsSchema, LogsSchema, InsightsSchema, AgentHealthSchema, SystemHealthSchema, McpServerSchema, McpServersSchema, McpToolsSchema, PluginsSchema, UpdatesCheckSchema, UpdatesSummarySchema, UpdateApplySchema, UpdateNotificationsSchema, UpdateNotificationSchema, TabIdSchema, FrontendBuildIdSchema, NotesSourcesSchema, NotesSearchSchema, NoteItemSchema, WikiStatusSchema, WikiBrowseSchema, WikiPageSchema, DashboardStatusSchema, TranscribeCapabilitySchema } from '../views.js'

/** Skills, memory, prompts, commands, notes, insights, logs, health, MCP, plugins, updates, and diagnostics. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['tools']
const Ok = z.object({ ok: z.literal(true) })


const AgentOptions = { agent_channel: z.enum(['stable', 'experimental']).optional(), confirmed_agent_revision: z.string().regex(/^[a-f0-9]{40}$/).optional() }
const Target = z.object({ target: z.string().optional(), channel: z.string().nullable().optional(), ...AgentOptions, tab_id: TabIdSchema.optional() })

export const toolsContract = {
  skills: {
    list: oc.route({ method: 'GET', path: '/api/skills', tags }).input(z.object({ category: z.string().optional() })).output(SkillsSchema),
    usage: oc.route({ method: 'GET', path: '/api/skills/usage', tags }).output(SkillsUsageSchema),
    content: oc.route({ method: 'GET', path: '/api/skills/content', tags, summary: 'Skill view, or one linked file when `file` is given.' }).input(z.object({ name: z.string().optional(), file: z.string().optional() })).output(SkillContentSchema),
    save: oc.route({ method: 'POST', path: '/api/skills/save', tags }).input(z.object({ name: z.string().optional(), content: z.string().optional(), category: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string(), path: z.string() })),
    delete: oc.route({ method: 'POST', path: '/api/skills/delete', tags }).input(z.object({ name: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string() })),
    toggle: oc.route({ method: 'POST', path: '/api/skills/toggle', tags, summary: 'Writes `skills.disabled` (and `skills.platform_disabled.webui` when present) in config.yaml.' }).input(z.object({ name: z.string().optional(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean() })),
  },
  memory: {
    get: oc.route({ method: 'GET', path: '/api/memory', tags }).input(z.object({ session_id: z.string().optional(), workspace: z.string().optional() })).output(MemorySchema),
    write: oc.route({ method: 'POST', path: '/api/memory/write', tags, summary: '`section` names the file (memory, user, soul); the legacy `target` alias is accepted.' }).input(z.object({ section: z.string().optional(), target: z.string().optional(), content: z.string().optional() })).output(z.object({ ok: z.literal(true), section: z.string(), path: z.string() })),
  },
  prompts: {
    list: oc.route({ method: 'GET', path: '/api/prompts', tags }).output(PromptsSchema),
    create: oc.route({ method: 'POST', path: '/api/prompts', tags }).input(z.object({ text: z.string().optional(), label: z.string().optional() })).output(z.object({ ok: z.literal(true), prompt: PromptSchema })),
    delete: oc.route({ method: 'DELETE', path: '/api/prompts', tags }).input(z.object({ id: z.string().optional() })).output(Ok),
  },
  commands: {
    list: oc.route({ method: 'GET', path: '/api/commands', tags }).output(CommandsSchema),
    exec: oc.route({ method: 'POST', path: '/api/commands/exec', tags }).input(z.object({ command: z.string().optional(), session_id: z.string().optional() })).output(z.object({ output: z.string() })),
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
    restart: oc.route({ method: 'POST', path: '/api/health/restart', tags, summary: 'Restart the Hermes gateway for the active profile (operator only).' }).input(Loose.optional()).output(z.object({ ok: z.literal(true), message: z.string() })),
    dashboard: oc.route({ method: 'GET', path: '/api/dashboard/status', tags }).output(DashboardStatusSchema),
    shutdown: oc.route({ method: 'POST', path: '/api/shutdown', tags, summary: 'Stop the server process (operator only).' }).input(Loose.optional()).output(z.object({ status: z.literal('shutting_down') })),
  },
  mcp: {
    servers: oc.route({ method: 'GET', path: '/api/mcp/servers', tags }).output(McpServersSchema),
    tools: oc.route({ method: 'GET', path: '/api/mcp/tools', tags, summary: '`q` keeps tools whose name, server, or description contains it (case-insensitive); `total` counts every known tool.' }).input(z.object({ q: z.string().optional() })).output(McpToolsSchema),
    action: oc.route({ method: 'POST', path: '/api/mcp/servers/{name}', tags, summary: '`{enabled}` toggles, `{delete: true}` removes, `{url|command, ...}` adds or updates the server in config.yaml.' }).input(z.object({ name: z.string() }).catchall(Json)).output(Loose),
    toggle: oc.route({ method: 'PATCH', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string(), enabled: Json.optional() })).output(z.object({ ok: z.literal(true), name: z.string(), enabled: z.boolean() })),
    update: oc.route({ method: 'PUT', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string() }).catchall(Json)).output(z.object({ ok: z.literal(true), server: McpServerSchema })),
    delete: oc.route({ method: 'DELETE', path: '/api/mcp/servers/{name}', tags }).input(z.object({ name: z.string() })).output(z.object({ ok: z.literal(true), deleted: z.string() })),
  },
  plugins: oc.route({ method: 'GET', path: '/api/plugins', tags }).output(PluginsSchema),
  updates: {
    check: oc.route({ method: 'GET', path: '/api/updates/check', tags, summary: 'Cached status; `POST` runs the check. Git source installs can update from completed releases (stable) or origin/main (experimental); direct global npm installs can update to completed stable npm releases.' }).output(UpdatesCheckSchema),
    checkNow: oc.route({ method: 'POST', path: '/api/updates/check', tags }).input(z.object({ force: Json.optional(), channel: z.string().nullable().optional(), agent_channel: AgentOptions.agent_channel })).output(UpdatesCheckSchema),
    apply: oc.route({ method: 'POST', path: '/api/updates/apply', tags }).input(Target).output(UpdateApplySchema),
    force: oc.route({ method: 'POST', path: '/api/updates/force', tags }).input(Target).output(UpdateApplySchema),
    clearLock: oc.route({ method: 'POST', path: '/api/updates/clear_lock', tags }).input(Target).output(UpdateApplySchema),
    summary: oc.route({ method: 'POST', path: '/api/updates/summary', tags }).input(z.object({ updates: Loose.optional(), target: z.string().nullable().optional() })).output(UpdatesSummarySchema),
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
  clientEvents: oc.route({ method: 'POST', path: '/api/client-events/log', tags, summary: 'Bounded browser diagnostics; only whitelisted scalar fields are logged.' }).input(Loose).output(z.object({ ok: z.literal(true), event: z.string().nullable() })),
}
