/** Crons, kanban, extensions, and terminal procedures (Python `api/routes.py` cron/terminal/extension sections, `api/kanban_bridge.py`). */
import { implement } from '@orpc/server'
import { automationContract } from '@maudecode/talaria-web-contracts'
import { HttpError, type ApiContext } from './router.js'
import { requestSessionIdGuard } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { activeProfileName } from '../auth/gate.js'
import { HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import { ConfigUnavailable, type Dict } from '../config/agent-config.js'
import { SidecarError } from '../sidecar/client.js'
import { ExtensionError } from '../tools/extensions.js'
import { boardSlug, intQuery, kanbanFailure, truthyQuery, withKanbanPolicy, withStatsTotals } from '../tools/kanban.js'
import { TerminalNotRunning } from '../tools/terminal.js'
import { onboardingGateAllows } from './settings-router.js'
import { sanitizeError } from '../workspace/media.js'
import { WORKSPACE_BUSY_MESSAGE } from '../workspace/git.js'
import { str } from '../util.js'

const os = implement(automationContract).$context<ApiContext>().use(requestSessionIdGuard)

export const TERMINAL_GATE_DENIED = 'Embedded terminal is only available from local networks when authentication is not configured. Configure a password/passkey, or set HERMES_WEBUI_ONBOARDING_OPEN=1 to allow it on a deliberately-exposed server.'
const REMOTE_TERMINAL_ERROR = { error: 'remote_terminal_backend_unsupported', message: 'Embedded terminal is only supported for local terminal backends.' }

function failure(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
  if (error instanceof ExtensionError) throw new HttpError(error.status, error.message)
  if (error instanceof SessionNotFound) throw new HttpError(404, 'Session not found')
  if (error instanceof ConfigUnavailable) throw new HttpError(503, error.message)
  if (error instanceof SidecarError) throw new HttpError(error.condition === 'sidecar_unavailable' ? 503 : 500, error.message, { condition: error.condition })
  throw error
}

/** Handler boundary: contract outputs are pinned loose objects (index signatures), so the concrete return type is erased here like the `as never` casts elsewhere. */
async function run<T>(fn: () => Promise<T> | T): Promise<never> {
  try {
    return (await fn()) as never
  } catch (error) {
    return failure(error)
  }
}

const home = (ctx: RequestContext): string => ctx.deps.profileHome(activeProfileName(ctx))
const boardOf = (v: unknown): string | null => str(v).trim() || null

/** Kanban dispatcher mapping: sidecar refusals → 400/404/409 like Python. Every returned task carries its card policy. */
async function kb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return withKanbanPolicy(await fn())
  } catch (error) {
    return kanbanFailure(error)
  }
}

/** Python `_terminal_local_io_allowed` + `_terminal_session_lookup`. */
function terminalSession(ctx: RequestContext, sid: string, missing = 'session_id required'): { workspace: string; profile: string | null } {
  if (!sid) throw new HttpError(400, missing)
  let session
  // Python surfaced the lookup's `KeyError` through `str(e)`, which keeps the repr quotes.
  try { session = ctx.deps.sessionStore.get(sid, { metadataOnly: true }) } catch { throw new HttpError(404, "'Session not found'") }
  if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) throw new HttpError(400, REMOTE_TERMINAL_ERROR.error, { message: REMOTE_TERMINAL_ERROR.message })
  return { workspace: str(session.workspace), profile: session.profile }
}

export async function terminalGate(ctx: RequestContext): Promise<void> {
  if (!(await onboardingGateAllows(ctx))) throw new HttpError(403, TERMINAL_GATE_DENIED)
}

export const automationRouter = os.router({
  crons: {
    contextSources: os.crons.contextSources.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.contextSources(home(ctx), input))),
    list: os.crons.list.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.list(activeProfileName(ctx), truthyQuery(input.all_profiles)) as Promise<never>)),
    history: os.crons.history.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.history(home(ctx), str(input.job_id), input.offset, input.limit))),
    output: os.crons.output.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.output(home(ctx), str(input.job_id), input.limit))),
    run: os.crons.run.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.runDetail(home(ctx), str(input.job_id), str(input.filename)))),
    status: os.crons.status.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.status(str(input.job_id)))),
    recent: os.crons.recent.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.recent(home(ctx), input.since))),
    deliveryOptions: os.crons.deliveryOptions.handler(({ context: { ctx } }) => run(() => ctx.deps.crons.deliveryOptions())),
    create: os.crons.create.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.create(home(ctx), input) as Promise<never>)),
    update: os.crons.update.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.update(home(ctx), input) as Promise<never>)),
    delete: os.crons.delete.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.delete(home(ctx), str(input.job_id)) as Promise<never>)),
    runNow: os.crons.runNow.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.runNow(home(ctx), str(input.job_id)) as Promise<never>)),
    pause: os.crons.pause.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.pause(home(ctx), str(input.job_id), input.reason ?? null) as Promise<never>)),
    resume: os.crons.resume.handler(({ input, context: { ctx } }) => run(() => ctx.deps.crons.resume(home(ctx), str(input.job_id)) as Promise<never>)),
  },
  kanban: {
    boards: os.kanban.boards.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.boards', { profile_home: home(ctx), include_archived: truthyQuery(input.include_archived) }).then((r) => ({ ...r, boards: r.boards.map((b) => ({ ...b, removable: b.slug !== 'default' })) }))))),
    board: os.kanban.board.handler(({ input, context: { ctx } }) => run(() => ctx.deps.kanban.board(home(ctx), input, activeProfileName(ctx)) as Promise<never>)),
    config: os.kanban.config.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.config', { profile_home: home(ctx), board: boardOf(input.board) })))),
    updateConfig: os.kanban.updateConfig.handler(({ input, context: { ctx } }) => run(() => ctx.deps.kanban.updateConfig(home(ctx), input))),
    stats: os.kanban.stats.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.stats', { profile_home: home(ctx), board: boardOf(input.board) }).then(withStatsTotals)))),
    assignees: os.kanban.assignees.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.assignees', { profile_home: home(ctx), board: boardOf(input.board) })))),
    events: os.kanban.events.handler(({ input, context: { ctx } }) => run(() => ctx.deps.kanban.events(home(ctx), boardOf(input.board), input.since, input.limit) as Promise<never>)),
    createBoard: os.kanban.createBoard.handler(({ input, context: { ctx } }) => run(() => kb(async () => {
      const spec: Dict = { ...input }
      // A board named without a slug gets one from its name.
      if (!str(spec.slug).trim()) spec.slug = boardSlug(str(spec.name))
      if ('default_workdir' in spec) { const raw = str(spec.default_workdir).trim(); spec.default_workdir = raw ? ctx.deps.workspaces.resolveTrusted(raw, activeProfileName(ctx)) : '' }
      return ctx.deps.kanban.sidecar().call('kanban.create_board', { profile_home: home(ctx), board_spec: spec })
    }))),
    switchBoard: os.kanban.switchBoard.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.switch_board', { profile_home: home(ctx), slug: pathParam(ctx, 'slug', input.slug) })))),
    updateBoard: os.kanban.updateBoard.handler(({ input, context: { ctx } }) => run(() => kb(async () => {
      const { slug, ...spec } = input
      if ('default_workdir' in spec) { const raw = str(spec.default_workdir).trim(); spec.default_workdir = raw ? ctx.deps.workspaces.resolveTrusted(raw, activeProfileName(ctx)) : '' }
      if (typeof spec.archived === 'string') spec.archived = truthyQuery(spec.archived)
      return ctx.deps.kanban.sidecar().call('kanban.update_board', { profile_home: home(ctx), slug: pathParam(ctx, 'slug', slug), board_spec: spec })
    }))),
    deleteBoard: os.kanban.deleteBoard.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.delete_board', { profile_home: home(ctx), slug: pathParam(ctx, 'slug', input.slug), delete: truthyQuery(input.delete) })))),
    dispatch: os.kanban.dispatch.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.dispatch', { profile_home: home(ctx), board: boardOf(input.board), dry_run: truthyQuery(input.dry_run), max: intQuery(input.max, 8, 1, 100) ?? 8 })))),
    bulk: os.kanban.bulk.handler(({ input, context: { ctx } }) => run(() => kb(() => { const { board, ...bulk } = input; return ctx.deps.kanban.sidecar().call('kanban.bulk', { profile_home: home(ctx), board: boardOf(board), bulk }) }))),
    createTask: os.kanban.createTask.handler(({ input, context: { ctx } }) => run(() => kb(() => { const { board, ...task } = input; return ctx.deps.kanban.sidecar().call('kanban.create_task', { profile_home: home(ctx), board: boardOf(board), task }) }))),
    link: os.kanban.link.handler(({ input, context: { ctx } }) => run(() => kb(() => linkCall(ctx, input, false)))),
    unlink: os.kanban.unlink.handler(({ input, context: { ctx } }) => run(() => kb(() => linkCall(ctx, input, true)))),
    unlinkDelete: os.kanban.unlinkDelete.handler(({ input, context: { ctx } }) => run(() => kb(() => linkCall(ctx, input, true)))),
    task: os.kanban.task.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.task', { profile_home: home(ctx), board: boardOf(input.board), task_id: pathParam(ctx, 'task_id', input.task_id) })))),
    taskLog: os.kanban.taskLog.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.task_log', { profile_home: home(ctx), board: boardOf(input.board), task_id: pathParam(ctx, 'task_id', input.task_id), ...(intQuery(input.tail, null, 1, 2_000_000) !== null ? { tail: intQuery(input.tail, null, 1, 2_000_000) ?? 0 } : {}) })))),
    comment: os.kanban.comment.handler(({ input, context: { ctx } }) => run(() => kb(() => {
      const { board, body, author } = input
      const task_id = pathParam(ctx, 'task_id', input.task_id)
      if (!str(task_id).trim()) throw new HttpFailure(400, 'task_id is required')
      if (!str(body).trim()) throw new HttpFailure(400, 'body is required')
      return ctx.deps.kanban.sidecar().call('kanban.comment', { profile_home: home(ctx), board: boardOf(board), task_id: task_id.trim(), body: str(body).trim(), ...(author ? { author: str(author) } : {}) })
    }))),
    // Python: `body.get("reason") or body.get("block_reason")` — an empty reason falls through to `block_reason`.
    block: os.kanban.block.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.task_action', { profile_home: home(ctx), board: boardOf(input.board), task_id: pathParam(ctx, 'task_id', input.task_id).trim(), action: 'block', reason: str(input.reason) || str(input.block_reason) || null, confirm_running_exit: input.confirm_running_exit === true })))),
    unblock: os.kanban.unblock.handler(({ input, context: { ctx } }) => run(() => kb(() => ctx.deps.kanban.sidecar().call('kanban.task_action', { profile_home: home(ctx), board: boardOf(input.board), task_id: pathParam(ctx, 'task_id', input.task_id).trim(), action: 'unblock' })))),
    patch: os.kanban.patch.handler(({ input, context: { ctx } }) => run(() => kb(() => patchCall(ctx, input)))),
    patchTask: os.kanban.patchTask.handler(({ input, context: { ctx } }) => run(() => kb(() => patchCall(ctx, input)))),
  },
  extensions: {
    status: os.extensions.status.handler(({ context: { ctx } }) => run(() => ctx.deps.extensions.status() as Promise<never>)),
    registry: os.extensions.registry.handler(({ context: { ctx } }) => run(() => ctx.deps.extensions.registry())),
    manifests: os.extensions.manifests.handler(({ context: { ctx } }) => run(() => ctx.deps.extensions.manifests())),
    toggle: os.extensions.toggle.handler(({ input, context: { ctx } }) => run(() => ctx.deps.extensions.setEnabled(input.id, input.enabled) as Promise<never>)),
    consent: os.extensions.consent.handler(({ input, context: { ctx } }) => run(() => ctx.deps.extensions.setConsent(input.id, input.approved) as Promise<never>)),
    install: os.extensions.install.handler(({ input, context: { ctx } }) => run(() => ctx.deps.extensions.install(input.id, input.download_url, input.sha256))),
    uninstall: os.extensions.uninstall.handler(({ input, context: { ctx } }) => run(() => ctx.deps.extensions.uninstall(input.id))),
  },
  terminal: {
    start: os.terminal.start.handler(({ input, context: { ctx } }) => run(async () => {
      await terminalGate(ctx)
      const sid = str(input.session_id).trim()
      const { workspace, profile } = terminalSession(ctx, sid)
      let cwd: string
      // Python answered `resolve_trusted_workspace`'s ValueError text unsanitised.
      try { cwd = ctx.deps.workspaces.resolveTrusted(workspace, profile) } catch (error) { throw new HttpError(400, (error as Error).message) }
      if (ctx.deps.git.workspaceBusy(cwd)) throw new HttpError(409, WORKSPACE_BUSY_MESSAGE)
      try {
        const term = ctx.deps.terminals.start(sid, cwd, { rows: input.rows, cols: input.cols, restart: Boolean(input.restart) })
        return { ok: true as const, session_id: sid, workspace: term.workspace, running: term.isAlive }
      } catch (error) {
        const message = str((error as Error).message)
        // Python: `int()` failures and other ValueErrors → 400 with the text; unexpected errors → 500 sanitised.
        throw new HttpError(/not a directory|required|capacity|invalid literal|cannot convert/.test(message) ? 400 : 500, message.includes('not supported') ? message : sanitizeError(error))
      }
    })),
    input: os.terminal.input.handler(({ input, context: { ctx } }) => run(async () => {
      await terminalGate(ctx)
      const sid = str(input.session_id).trim()
      terminalSession(ctx, sid, 'Missing required field(s): session_id')
      const data = str(input.data)
      if (data.length > 8192) throw new HttpError(413, 'input too large')
      try { ctx.deps.terminals.write(sid, data) } catch (error) { if (error instanceof TerminalNotRunning) throw new HttpError(404, `'${error.message}'`); throw error }
      return { ok: true as const }
    })),
    resize: os.terminal.resize.handler(({ input, context: { ctx } }) => run(async () => {
      await terminalGate(ctx)
      const sid = str(input.session_id).trim()
      terminalSession(ctx, sid, 'Missing required field(s): session_id')
      try { ctx.deps.terminals.resize(sid, input.rows ?? 24, input.cols ?? 80) } catch (error) {
        if (error instanceof TerminalNotRunning) throw new HttpError(404, `'${error.message}'`)
        const message = str((error as Error).message)
        if (/invalid literal|cannot convert/.test(message)) throw new HttpError(400, message)
        throw error
      }
      return { ok: true as const }
    })),
    close: os.terminal.close.handler(({ input, context: { ctx } }) => run(async () => {
      await terminalGate(ctx)
      const sid = str(input.session_id).trim()
      if (!sid) throw new HttpError(400, 'Missing required field(s): session_id')
      return { ok: true as const, closed: ctx.deps.terminals.close(sid) }
    })),
  },
})

function linkCall(ctx: RequestContext, input: Dict, unlink: boolean): Promise<Dict> {
  const parent = str(input.parent_id).trim()
  const child = str(input.child_id).trim()
  if (!parent || !child) throw new HttpFailure(400, 'parent_id and child_id are required')
  const params = { profile_home: home(ctx), board: boardOf(input.board), parent_id: parent, child_id: child }
  return unlink ? ctx.deps.kanban.sidecar().call('kanban.unlink', params) : ctx.deps.kanban.sidecar().call('kanban.link', params)
}

function patchCall(ctx: RequestContext, input: { task_id: string } & Dict): Promise<never> {
  const { task_id, board, ...patch } = input
  const id = pathParam(ctx, 'task_id', str(task_id)).trim()
  if (!id) throw new HttpFailure(400, 'task_id is required')
  return ctx.deps.kanban.sidecar().call('kanban.patch_task', { profile_home: home(ctx), board: boardOf(board), task_id: id, patch }) as Promise<never>
}

/**
 * Python read `slug` / `task_id` from the URL path only (`unquote`d once); oRPC spreads the JSON body over the path
 * parameters, so the path segment is re-read from the request so a body key of the same name cannot redirect a write.
 */
function pathParam(ctx: RequestContext, name: 'slug' | 'task_id', fallback: string): string {
  const segments = ctx.path.split('/')
  const anchor = name === 'slug' ? segments.indexOf('boards') : segments.indexOf('tasks')
  const raw = anchor >= 0 ? segments[anchor + 1] : undefined
  if (raw === undefined || raw === '') return fallback
  try { return decodeURIComponent(raw) } catch { return raw }
}
