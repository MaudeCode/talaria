import { oc } from '@orpc/contract'
import { z } from 'zod'
import { CronJobSchema, KanbanAssigneeSchema, KanbanBoardMetaSchema, KanbanBoardSchema, KanbanEventSchema, KanbanTaskSchema } from '../sidecar/namespaces.js'

/** Crons, kanban, extensions, and the embedded terminal. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['automation']
const Ok = z.object({ ok: z.literal(true) })

export const CronRowSchema = CronJobSchema.extend({ owner_profile: z.string(), read_only: z.boolean() })
export const CronsSchema = z.union([
  z.object({ jobs: z.array(CronRowSchema), all_profiles: z.boolean(), active_profile: z.string(), other_profile_count: z.number().int() }),
  z.object({ jobs: z.array(CronRowSchema), cron_unavailable: z.literal(true) }),
])
const CronJobEnvelope = z.object({ ok: z.literal(true), job: CronJobSchema })
const JobId = z.object({ job_id: z.string().optional() })
export const TaskEnvelopeSchema = z.object({ task: KanbanTaskSchema, read_only: z.boolean() })
export const ExtensionStatusSchema = z.object({
  enabled: z.boolean(), extension_dir_configured: z.boolean(), extension_dir_valid: z.boolean(), script_urls: z.array(z.string()), stylesheet_urls: z.array(z.string()), sidecars: z.array(Loose),
  counts: z.object({ script_urls: z.number().int(), stylesheet_urls: z.number().int(), sidecars: z.number().int(), manifest_extensions: z.number().int(), user_disabled: z.number().int() }),
  manifest: Loose, extensions: z.array(Loose), gallery_installed: z.record(z.string(), Loose).optional(), warnings: z.array(z.object({ code: z.string(), source: z.string() })),
})
const TerminalBody = z.object({ session_id: z.string().optional() })

export const automationContract = {
  crons: {
    list: oc.route({ method: 'GET', path: '/api/crons', tags }).input(z.object({ all_profiles: z.string().optional() })).output(CronsSchema),
    history: oc.route({ method: 'GET', path: '/api/crons/history', tags }).input(JobId.extend({ offset: z.string().optional(), limit: z.string().optional() })).output(Loose),
    output: oc.route({ method: 'GET', path: '/api/crons/output', tags }).input(JobId.extend({ limit: z.string().optional() })).output(Loose),
    run: oc.route({ method: 'GET', path: '/api/crons/run', tags }).input(JobId.extend({ filename: z.string().optional() })).output(Loose),
    status: oc.route({ method: 'GET', path: '/api/crons/status', tags }).input(JobId).output(Loose),
    deliveryOptions: oc.route({ method: 'GET', path: '/api/crons/delivery-options', tags }).output(z.object({ platforms: z.array(z.object({ value: z.string(), label: z.string() })) })),
    create: oc.route({ method: 'POST', path: '/api/crons/create', tags }).input(Loose).output(CronJobEnvelope),
    update: oc.route({ method: 'POST', path: '/api/crons/update', tags }).input(Loose).output(CronJobEnvelope),
    delete: oc.route({ method: 'POST', path: '/api/crons/delete', tags }).input(JobId).output(z.object({ ok: z.literal(true), job_id: z.string() })),
    runNow: oc.route({ method: 'POST', path: '/api/crons/run', tags, summary: 'Start a manual run in the sidecar; answers immediately with `status: running` (or `already_running`).' }).input(JobId).output(z.object({ ok: z.boolean(), job_id: z.string(), status: z.string(), elapsed: z.number().optional() })),
    pause: oc.route({ method: 'POST', path: '/api/crons/pause', tags }).input(JobId.extend({ reason: z.string().nullable().optional() })).output(CronJobEnvelope),
    resume: oc.route({ method: 'POST', path: '/api/crons/resume', tags }).input(JobId).output(CronJobEnvelope),
  },
  kanban: {
    boards: oc.route({ method: 'GET', path: '/api/kanban/boards', tags }).input(z.object({ include_archived: z.string().optional() })).output(z.object({ boards: z.array(KanbanBoardMetaSchema), current: z.string(), read_only: z.boolean() })),
    board: oc.route({ method: 'GET', path: '/api/kanban/board', tags }).input(z.object({ board: z.string().optional(), tenant: z.string().optional(), assignee: z.string().optional(), include_archived: z.string().optional(), only_mine: z.string().optional(), since: z.string().optional() })).output(KanbanBoardSchema),
    config: oc.route({ method: 'GET', path: '/api/kanban/config', tags }).input(z.object({ board: z.string().optional() })).output(Loose),
    updateConfig: oc.route({ method: 'PATCH', path: '/api/kanban/config', tags }).input(z.object({ lane_by_profile: Json.optional() })).output(Loose),
    stats: oc.route({ method: 'GET', path: '/api/kanban/stats', tags }).input(z.object({ board: z.string().optional() })).output(Loose),
    assignees: oc.route({ method: 'GET', path: '/api/kanban/assignees', tags }).input(z.object({ board: z.string().optional() })).output(z.object({ assignees: z.array(KanbanAssigneeSchema) })),
    events: oc.route({ method: 'GET', path: '/api/kanban/events', tags }).input(z.object({ board: z.string().optional(), since: z.string().optional(), limit: z.string().optional() })).output(z.object({ events: z.array(KanbanEventSchema), cursor: z.number().int(), latest_event_id: z.number().int(), read_only: z.boolean() })),
    createBoard: oc.route({ method: 'POST', path: '/api/kanban/boards', tags }).input(Loose).output(z.object({ board: KanbanBoardMetaSchema, current: z.string(), read_only: z.boolean() })),
    switchBoard: oc.route({ method: 'POST', path: '/api/kanban/boards/{slug}/switch', tags }).input(z.object({ slug: z.string() })).output(z.object({ current: z.string(), read_only: z.boolean() })),
    updateBoard: oc.route({ method: 'PATCH', path: '/api/kanban/boards/{slug}', tags }).input(z.object({ slug: z.string() }).catchall(Json)).output(z.object({ board: KanbanBoardMetaSchema, read_only: z.boolean() })),
    deleteBoard: oc.route({ method: 'DELETE', path: '/api/kanban/boards/{slug}', tags }).input(z.object({ slug: z.string(), delete: z.string().optional() })).output(z.object({ result: Json, current: z.string(), read_only: z.boolean() })),
    dispatch: oc.route({ method: 'POST', path: '/api/kanban/dispatch', tags }).input(z.object({ board: z.string().optional(), dry_run: z.string().optional(), max: z.string().optional() })).output(Loose),
    bulk: oc.route({ method: 'POST', path: '/api/kanban/tasks/bulk', tags }).input(Loose).output(z.object({ results: z.array(Loose), read_only: z.boolean() })),
    createTask: oc.route({ method: 'POST', path: '/api/kanban/tasks', tags }).input(Loose).output(TaskEnvelopeSchema),
    link: oc.route({ method: 'POST', path: '/api/kanban/links', tags }).input(Loose).output(Loose),
    unlink: oc.route({ method: 'POST', path: '/api/kanban/links/delete', tags }).input(Loose).output(Loose),
    unlinkDelete: oc.route({ method: 'DELETE', path: '/api/kanban/links', tags }).input(Loose).output(Loose),
    task: oc.route({ method: 'GET', path: '/api/kanban/tasks/{task_id}', tags }).input(z.object({ task_id: z.string(), board: z.string().optional() })).output(Loose),
    taskLog: oc.route({ method: 'GET', path: '/api/kanban/tasks/{task_id}/log', tags }).input(z.object({ task_id: z.string(), board: z.string().optional(), tail: z.string().optional() })).output(Loose),
    comment: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/comments', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(Loose),
    block: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/block', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(TaskEnvelopeSchema),
    unblock: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/unblock', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(TaskEnvelopeSchema),
    patch: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/patch', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(TaskEnvelopeSchema),
    patchTask: oc.route({ method: 'PATCH', path: '/api/kanban/tasks/{task_id}', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(TaskEnvelopeSchema),
  },
  extensions: {
    status: oc.route({ method: 'GET', path: '/api/extensions/status', tags }).output(ExtensionStatusSchema),
    registry: oc.route({ method: 'GET', path: '/api/extensions/registry', tags }).output(z.object({ entries: z.array(Json), error: z.string().optional() })),
    manifests: oc.route({ method: 'GET', path: '/api/extensions/manifests', tags }).output(z.object({ protocol_version: z.literal(1), manifests: z.array(Loose) })),
    toggle: oc.route({ method: 'POST', path: '/api/extensions/toggle', tags }).input(z.object({ id: Json.optional(), enabled: Json.optional() })).output(ExtensionStatusSchema),
    consent: oc.route({ method: 'POST', path: '/api/extensions/sidecar-proxy-consent', tags }).input(z.object({ id: Json.optional(), approved: Json.optional() })).output(ExtensionStatusSchema),
    install: oc.route({ method: 'POST', path: '/api/extensions/install', tags }).input(z.object({ id: Json.optional(), download_url: Json.optional(), sha256: Json.optional() })).output(z.object({ installed: z.literal(true), id: z.string(), version: z.string() })),
    uninstall: oc.route({ method: 'POST', path: '/api/extensions/uninstall', tags }).input(z.object({ id: Json.optional() })).output(z.object({ uninstalled: z.literal(true), id: z.string() })),
  },
  terminal: {
    start: oc.route({ method: 'POST', path: '/api/terminal/start', tags, summary: 'Spawn (or reuse) the embedded PTY shell for a session workspace (local origin when auth is off).' }).input(TerminalBody.extend({ rows: Json.optional(), cols: Json.optional(), restart: Json.optional() })).output(z.object({ ok: z.literal(true), session_id: z.string(), workspace: z.string(), running: z.boolean() })),
    input: oc.route({ method: 'POST', path: '/api/terminal/input', tags }).input(TerminalBody.extend({ data: z.string().optional() })).output(Ok),
    resize: oc.route({ method: 'POST', path: '/api/terminal/resize', tags }).input(TerminalBody.extend({ rows: Json.optional(), cols: Json.optional() })).output(Ok),
    close: oc.route({ method: 'POST', path: '/api/terminal/close', tags }).input(TerminalBody).output(z.object({ ok: z.literal(true), closed: z.boolean() })),
  },
}
