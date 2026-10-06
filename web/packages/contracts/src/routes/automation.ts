import { oc } from '@orpc/contract'
import { z } from 'zod'
import { CronsSchema, CronContextSourcesSchema, CronRecentSchema, CronHistorySchema, CronRunSchema, CronStatusSchema, CronMutationSchema, KanbanBoardsViewSchema, KanbanBoardViewSchema, KanbanTaskPolicyShape, ExtensionStatusSchema } from '../views.js'
import { KanbanAssigneeSchema, KanbanBoardMetaSchema, KanbanEventSchema, KanbanTaskSchema } from '../sidecar/namespaces.js'

/** Crons, kanban, extensions, and the embedded terminal. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['automation']
const Ok = z.object({ ok: z.literal(true) })

const JobId = z.object({ job_id: z.string().optional() })
const PolicyTaskSchema = KanbanTaskSchema.extend(KanbanTaskPolicyShape)
/** The newest Block or Unblock in the task's events (TAL-557); a client whose write outcome was lost compares `event_id` with the cursor it held when writing. */
const KanbanLastCardActionSchema = z.object({ action: z.enum(['block', 'unblock']), event_id: z.number().int() }).nullable()
export const TaskEnvelopeSchema = z.object({ task: PolicyTaskSchema, read_only: z.boolean() })
/** A card write taking a task out of Running must carry `confirm_running_exit: true`, or the server answers 409 (TAL-557). */
const CardWriteInput = z.object({ task_id: z.string(), confirm_running_exit: z.boolean().optional() }).catchall(Json)
const TerminalBody = z.object({ session_id: z.string().optional() })

export const automationContract = {
  crons: {
    contextSources: oc.route({ method: 'POST', path: '/api/crons/context-sources', tags, summary: 'Read eligible context sources for the editor execution store.' }).input(z.object({ profile: z.string().optional(), editing_job_id: z.string().optional(), exclude_job_id: z.string().optional(), selected_refs: z.array(z.string()).optional() })).output(CronContextSourcesSchema),
    list: oc.route({ method: 'GET', path: '/api/crons', tags }).input(z.object({ all_profiles: z.string().optional() })).output(CronsSchema),
    history: oc.route({ method: 'GET', path: '/api/crons/history', tags }).input(JobId.extend({ offset: z.string().optional(), limit: z.string().optional() })).output(CronHistorySchema),
    output: oc.route({ method: 'GET', path: '/api/crons/output', tags }).input(JobId.extend({ limit: z.string().optional() })).output(Loose),
    run: oc.route({ method: 'GET', path: '/api/crons/run', tags }).input(JobId.extend({ filename: z.string().optional() })).output(CronRunSchema),
    status: oc.route({ method: 'GET', path: '/api/crons/status', tags }).input(JobId).output(CronStatusSchema),
    recent: oc.route({ method: 'GET', path: '/api/crons/recent', tags, summary: "Each active-profile job's latest completion after `since` (Unix seconds), newest first. Not a run archive." }).input(z.object({ since: z.string().optional() })).output(CronRecentSchema),
    deliveryOptions: oc.route({ method: 'GET', path: '/api/crons/delivery-options', tags }).output(z.object({ platforms: z.array(z.object({ value: z.string(), label: z.string() })) })),
    create: oc.route({ method: 'POST', path: '/api/crons/create', tags }).input(Loose).output(CronMutationSchema),
    update: oc.route({ method: 'POST', path: '/api/crons/update', tags }).input(Loose).output(CronMutationSchema),
    delete: oc.route({ method: 'POST', path: '/api/crons/delete', tags }).input(JobId).output(CronMutationSchema),
    runNow: oc.route({ method: 'POST', path: '/api/crons/run', tags, summary: 'Start a manual run in the sidecar; answers immediately with `status: running` (or `already_running`).' }).input(JobId).output(CronMutationSchema),
    pause: oc.route({ method: 'POST', path: '/api/crons/pause', tags }).input(JobId.extend({ reason: z.string().nullable().optional() })).output(CronMutationSchema),
    resume: oc.route({ method: 'POST', path: '/api/crons/resume', tags }).input(JobId).output(CronMutationSchema),
  },
  kanban: {
    boards: oc.route({ method: 'GET', path: '/api/kanban/boards', tags }).input(z.object({ include_archived: z.string().optional() })).output(KanbanBoardsViewSchema),
    board: oc.route({ method: 'GET', path: '/api/kanban/board', tags }).input(z.object({ board: z.string().optional(), tenant: z.string().optional(), assignee: z.string().optional(), include_archived: z.string().optional(), only_mine: z.string().optional(), since: z.string().optional() })).output(KanbanBoardViewSchema),
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
    task: oc.route({ method: 'GET', path: '/api/kanban/tasks/{task_id}', tags }).input(z.object({ task_id: z.string(), board: z.string().optional() })).output(z.looseObject({ task: PolicyTaskSchema, last_card_action: KanbanLastCardActionSchema })),
    taskLog: oc.route({ method: 'GET', path: '/api/kanban/tasks/{task_id}/log', tags }).input(z.object({ task_id: z.string(), board: z.string().optional(), tail: z.string().optional() })).output(z.looseObject({ log: z.array(Json).optional(), entries: z.array(Json).optional() })),
    comment: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/comments', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(Loose),
    block: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/block', tags }).input(CardWriteInput).output(TaskEnvelopeSchema),
    unblock: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/unblock', tags }).input(z.object({ task_id: z.string() }).catchall(Json)).output(TaskEnvelopeSchema),
    patch: oc.route({ method: 'POST', path: '/api/kanban/tasks/{task_id}/patch', tags }).input(CardWriteInput).output(TaskEnvelopeSchema),
    patchTask: oc.route({ method: 'PATCH', path: '/api/kanban/tasks/{task_id}', tags }).input(CardWriteInput).output(TaskEnvelopeSchema),
  },
  extensions: {
    status: oc.route({ method: 'GET', path: '/api/extensions/status', tags }).output(ExtensionStatusSchema),
    registry: oc.route({ method: 'GET', path: '/api/extensions/registry', tags }).output(z.looseObject({ entries: z.array(Json), error: z.string().optional(), unavailable: z.boolean().optional() })),
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
