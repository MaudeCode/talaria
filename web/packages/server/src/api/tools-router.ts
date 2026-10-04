/** Skills, memory, prompts, commands, notes, insights, logs, health, MCP, plugins, updates, diagnostics (Python `api/routes.py` handlers of the same paths). */
import { implement } from '@orpc/server'
import { createHash } from 'node:crypto'
import { toolsContract } from '@maudecode/talaria-web-contracts'
import { HttpError, requireFields, type ApiContext } from './router.js'
import { requestSessionIdGuard } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { activeProfileName, ensureTrustedAuthSession, sessionCanManageServer } from '../auth/gate.js'
import { HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import { ConfigUnavailable, type Dict } from '../config/agent-config.js'
import { SidecarError } from '../sidecar/client.js'
import { createPrompt, deletePrompt, externalNotesEnabled, loadPrompts, readMemory, writeMemory } from '../tools/memory.js'
import { notesSources } from '../tools/mcp.js'
import { buildInsights } from '../tools/insights.js'
import { agentHealth, dashboardStatus, readLogTail, systemHealth } from '../tools/health.js'
import { normalizeChannel } from '../tools/updates.js'
import { pyBool } from '../settings.js'
import { str } from '../util.js'
import type { UpdateNotificationScope, UpdateNotificationTarget } from '../tools/update-notifications.js'
import type { SessionInfo } from '../auth/store.js'

const os = implement(toolsContract).$context<ApiContext>().use(requestSessionIdGuard)

function failure(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
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

const principalHash = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')

export function updateNotificationOwner(session: SessionInfo | null): string {
  const authType = str(session?.auth_type).trim()
  if (authType === 'oidc') {
    const issuer = str(session?.oidc_issuer).trim()
    const subject = typeof session?.oidc_subject === 'string' ? session.oidc_subject : ''
    if (issuer && subject.trim()) return `oidc:${principalHash(issuer, subject)}`
    const token = str(session?.token).trim()
    if (token) return `oidc-session:${principalHash(token)}`
  }
  const username = str(session?.username).trim()
  return username ? `${authType || 'auth'}:${username}` : 'local-owner'
}

async function updateNotificationScope(ctx: RequestContext, tab?: string): Promise<UpdateNotificationScope> {
  const session = await ensureTrustedAuthSession(ctx)
  return {
    owner: updateNotificationOwner(session),
    profile: activeProfileName(ctx),
    serverOwner: await sessionCanManageServer(ctx, session),
    tab: tab ?? null,
  }
}

async function applyWithNotification(
  ctx: RequestContext,
  target: UpdateNotificationTarget,
  apply: () => Promise<Dict>,
  confirmed = false,
  tab?: string,
): Promise<Dict> {
  const scope = await updateNotificationScope(ctx, tab)
  const active = ctx.deps.updateNotifications.activeUpdate(scope, target)
  if (active) ctx.deps.updateNotifications.watch(scope, active.id)
  if (active && (active.phase === 'applying' || active.phase === 'restarting')) {
    return { ok: false, status: 'already_in_progress', message: 'Update already in progress', notification_id: active.id }
  }
  const notification = active ?? ctx.deps.updateNotifications.begin(scope, target)
  if (active?.phase === 'awaiting_confirmation' && confirmed) ctx.deps.updateNotifications.transition(notification.id, 'applying')
  try {
    const result = await apply()
    const verifiedIdentity = typeof result.verified_revision === 'string'
      ? { revision: result.verified_revision, version: typeof result.verified_version === 'string' ? result.verified_version : null }
      : undefined
    if (result.confirmation_required === true) ctx.deps.updateNotifications.transition(notification.id, 'awaiting_confirmation', null, verifiedIdentity)
    else if (result.restart_blocked === true) ctx.deps.updateNotifications.transition(notification.id, 'blocked', null, verifiedIdentity, result.message)
    else if (result.ok !== true) ctx.deps.updateNotifications.transition(notification.id, 'failed', null, verifiedIdentity, result.message || result.error)
    else if (target === 'webui' && result.restart_scheduled === true) {
      ctx.deps.updateNotifications.transition(notification.id, 'restarting', str(result.sourceRevision || result.candidate_revision), verifiedIdentity)
    } else {
      // A kept Agent stash needs the user's attention; its recovery commands ride on the success record.
      ctx.deps.updateNotifications.transition(notification.id, 'succeeded', null, verifiedIdentity, result.stash_conflict === true ? result.message : undefined)
    }
    return { ...result, notification_id: notification.id }
  } catch (error) {
    ctx.deps.updateNotifications.transition(notification.id, 'failed', null, undefined, error instanceof Error ? error.message : null)
    throw error
  }
}

/** Rate limiter keyed by client IP over a sliding window (Python `_csp_report_rate_limited` / `_client_event_rate_limited`). */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(private readonly windowSeconds: number, private readonly max: number, private readonly now: () => number = () => Date.now() / 1000) {}
  limited(key: string): boolean {
    const now = this.now()
    const cutoff = now - this.windowSeconds
    if (this.hits.size > 4096) for (const [k, ts] of this.hits) if (!ts.some((t) => t >= cutoff)) this.hits.delete(k)
    const stamps = (this.hits.get(key) ?? []).filter((t) => t >= cutoff)
    if (stamps.length >= this.max) { this.hits.set(key, stamps); return true }
    stamps.push(now)
    this.hits.set(key, stamps)
    return false
  }
}

const CLIENT_EVENT_FIELDS: Record<string, number> = { event: 64, source: 80, session_id: 128, stream_id: 128, visibility_state: 32, url_path: 256, reason: 160 }

/** Python `_sanitize_client_event_payload`: bounded scalar metadata only. */
export function sanitizeClientEvent(payload: unknown): Dict {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { event: 'unknown' }
  const body = payload as Dict
  const out: Dict = {}
  for (const [field, limit] of Object.entries(CLIENT_EVENT_FIELDS)) {
    const raw = body[field]
    if (raw === null || raw === undefined) continue
    let text = str(raw).trim()
    if (!text) continue
    if (field === 'url_path') {
      let path: string
      try { path = new URL(text.slice(0, 1024), 'http://x').pathname || '/' } catch { path = text.split('?', 1)[0] ?? '/' }
      if (!path.startsWith('/')) path = '/' + path.replace(/^\/+/, '')
      text = path
    }
    out[field] = text.slice(0, limit)
  }
  // Python keeps `ready_state` (0..3, never a bool) and `online` (bool or a yes/no string) as typed values.
  const readyState = body.ready_state
  if (typeof readyState === 'number' && Number.isInteger(readyState) && readyState >= 0 && readyState <= 3) out.ready_state = readyState
  const online = body.online
  if (typeof online === 'boolean') out.online = online
  else if (typeof online === 'string') {
    const lowered = online.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(lowered)) out.online = true
    else if (['false', '0', 'no', 'off'].includes(lowered)) out.online = false
  }
  if (!out.event) out.event = 'unknown'
  return out
}

function memoryWorkspace(ctx: RequestContext, sessionId: string, workspace: string): string | null {
  if (sessionId) {
    try {
      const session = ctx.deps.sessionStore.get(sessionId, { metadataOnly: true })
      if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) return null
      const ws = str(session.workspace).trim()
      return ws ? ctx.deps.workspaces.resolvePath(ws, session.profile) : null
    } catch {
      return null
    }
  }
  const profile = activeProfileName(ctx)
  if (!ctx.deps.workspaces.profileSupportsLocalIo(profile)) return null
  const raw = workspace || (ctx.deps.config.env.TERMINAL_CWD ?? '') || ctx.deps.workspaces.lastWorkspace(profile)
  if (!raw) return null
  try { return ctx.deps.workspaces.resolveTrusted(raw, profile) } catch { return null }
}

export const toolsRouter = os.router({
  skills: {
    list: os.skills.list.handler(({ input, context: { ctx } }) => run(async () => ({ skills: await ctx.deps.skills.list(home(ctx), str(input.category).trim() || null) }))),
    usage: os.skills.usage.handler(({ context: { ctx } }) => run(() => ctx.deps.skills.usage(home(ctx)) as Promise<never>)),
    content: os.skills.content.handler(({ input, context: { ctx } }) => run(async () => {
      const name = str(input.name)
      if (!name) throw new HttpError(400, 'name required')
      const file = str(input.file)
      if (file) return ctx.deps.skills.linkedFile(home(ctx), name, file)
      return ctx.deps.skills.view(home(ctx), name)
    })),
    save: os.skills.save.handler(({ input, context: { ctx } }) => run(() => {
      requireFields(input, 'name', 'content')
      return ctx.deps.skills.save(home(ctx), str(input.name), str(input.content), str(input.category))
    })),
    delete: os.skills.delete.handler(({ input, context: { ctx } }) => run(() => {
      if (input.name === undefined) throw new HttpError(400, 'Missing required field(s): name')
      return ctx.deps.skills.delete(home(ctx), str(input.name))
    })),
    toggle: os.skills.toggle.handler(({ input, context: { ctx } }) => run(() => {
      if (input.name === undefined || input.enabled === undefined) throw new HttpError(400, 'Missing required field(s): name, enabled')
      return ctx.deps.skills.toggle(home(ctx), str(input.name).trim(), pyBool(input.enabled))
    })),
  },
  memory: {
    get: os.memory.get.handler(({ input, context: { ctx } }) => run(async () => {
      const config = await ctx.deps.agentConfig.read(home(ctx))
      return readMemory(home(ctx), config, memoryWorkspace(ctx, str(input.session_id), str(input.workspace)), ctx.deps.config.env, ctx.deps.sessions.deps.redactEnabled()) as never
    })),
    write: os.memory.write.handler(({ input, context: { ctx } }) => run(async () => {
      const section = input.section ?? input.target
      if (section === undefined || input.content === undefined) throw new HttpError(400, 'Missing required field(s): section, content')
      return writeMemory(home(ctx), await ctx.deps.agentConfig.read(home(ctx)), str(section), str(input.content))
    })),
  },
  prompts: {
    list: os.prompts.list.handler(({ context: { ctx } }) => run(() => ({ prompts: loadPrompts(home(ctx)) }))),
    create: os.prompts.create.handler(({ input, context: { ctx } }) => run(() => ({ ok: true as const, prompt: createPrompt(home(ctx), str(input.text), str(input.label), ctx.deps.nowSeconds()) }))),
    delete: os.prompts.delete.handler(({ input, context: { ctx } }) => run(() => { deletePrompt(home(ctx), str(input.id).trim()); return { ok: true as const } })),
  },
  commands: {
    list: os.commands.list.handler(({ context: { ctx } }) => run(async () => {
      const sidecar = ctx.deps.sidecar()
      if (!sidecar) return { commands: [] }
      try {
        return { commands: (await sidecar.call('commands.registry', { profile_home: home(ctx) })).commands.filter((c) => !c.gateway_only) }
      } catch {
        return { commands: [] }
      }
    })),
    exec: os.commands.exec.handler(({ input, context: { ctx } }) => run(async () => {
      const command = str(input.command).trim()
      if (!command) throw new HttpError(400, 'command is required')
      const sidecar = ctx.deps.sidecar()
      if (!sidecar) throw new HttpError(503, 'Hermes Agent sidecar is not running')
      try {
        return { output: (await sidecar.call('commands.exec', { profile_home: home(ctx), command }, { timeoutMs: 120_000 })).output }
      } catch (error) {
        if (error instanceof SidecarError) {
          if (error.condition === 'command_not_found') throw new HttpError(404, 'Plugin command not found')
          if (error.condition === 'invalid_params' || error.code === -32602) throw new HttpError(400, error.message)
          throw new HttpError(500, error.message)
        }
        throw error
      }
    })),
  },
  notes: {
    sources: os.notes.sources.handler(({ context: { ctx } }) => run(async () => {
      const config = await ctx.deps.agentConfig.read(home(ctx))
      return notesSources(config, externalNotesEnabled(ctx.deps.config.env, config)) as never
    })),
    search: os.notes.search.handler(({ input, context: { ctx } }) => run(async () => {
      const config = await ctx.deps.agentConfig.read(home(ctx))
      if (!externalNotesEnabled(ctx.deps.config.env, config)) throw new HttpError(404, 'External notes sources are disabled.', { source: 'disabled', results: [] })
      const source = str(input.source ?? 'joplin').trim().toLowerCase() || 'joplin'
      throw new HttpError(source === 'joplin' ? 502 : 400, source === 'joplin' ? 'Joplin search is not available in this release.' : 'Search is currently implemented for Joplin sources only.', { source, results: [] })
    })),
  },
  insights: os.insights.handler(({ input, context: { ctx } }) => run(() => {
    let entries: Dict[] = []
    try { entries = ctx.deps.sessionStore.readIndexEntries() } catch { entries = [] }
    return buildInsights(entries, input.days, ctx.deps.nowSeconds()) as never
  })),
  logs: os.logs.handler(({ input, context: { ctx } }) => run(() => readLogTail(home(ctx), input.file, input.tail) as never)),
  ops: {
    agent: os.ops.agent.handler(({ context: { ctx } }) => run(() => agentHealth({ env: ctx.deps.config.env, hermesHome: ctx.deps.config.hermesHome, profileHome: () => ctx.deps.profileHome(ctx.deps.activeProfile()), fetch: () => ctx.deps.fetch, now: ctx.deps.nowSeconds }) as Promise<never>)),
    system: os.ops.system.handler(({ context: { ctx } }) => run(() => systemHealth(ctx.deps.config.homeDir, ctx.deps.runtimeDiagnostics()) as never)),
    restart: os.ops.restart.handler(({ context: { ctx } }) => run(async () => {
      const sidecar = ctx.deps.sidecar()
      if (!sidecar) throw new HttpError(500, 'Hermes Agent sidecar is not running')
      const outcome = await sidecar.call('gateway.restart', { profile_home: home(ctx) }, { timeoutMs: 300_000 })
      if (outcome.status === 'completed') return { ok: true as const, message: 'Gateway service restarted successfully' }
      if (outcome.status === 'busy') throw new HttpError(429, outcome.message || 'Restart already in progress. Please wait a moment and try again.')
      throw new HttpError(500, outcome.message || 'Internal error running restart')
    })),
    dashboard: os.ops.dashboard.handler(({ context: { ctx } }) => run(async () => { const config: Dict = await ctx.deps.agentConfig.read(home(ctx)).catch(() => ({})); return dashboardStatus(config, ctx.deps.config.env, ctx.deps.fetch) as Promise<never> })),
    shutdown: os.ops.shutdown.handler(({ context: { ctx } }) => run(() => {
      ctx.deps.log(`[shutdown-request] remote=${ctx.peer || 'unknown'} method=${ctx.method} path=${ctx.path.slice(0, 240)} ua=${(ctx.header('user-agent') ?? 'no-ua').replace(/[\x00-\x1f\x7f]+/g, '?').slice(0, 240)}`)
      ctx.deps.requestShutdown()
      return { status: 'shutting_down' as const }
    })),
  },
  mcp: {
    servers: os.mcp.servers.handler(({ context: { ctx } }) => run(() => ctx.deps.mcp.servers(home(ctx)) as Promise<never>)),
    tools: os.mcp.tools.handler(({ context: { ctx } }) => run(() => ctx.deps.mcp.tools(home(ctx)) as Promise<never>)),
    action: os.mcp.action.handler(({ input, context: { ctx } }) => run(async () => {
      const { name, ...body } = input
      const target = decodeURIComponent(name)
      if (body.delete === true) return ctx.deps.mcp.delete(home(ctx), target)
      if ('enabled' in body && !('url' in body) && !('command' in body)) return ctx.deps.mcp.toggle(home(ctx), target, body.enabled)
      return ctx.deps.mcp.update(home(ctx), target, body)
    })),
    toggle: os.mcp.toggle.handler(({ input, context: { ctx } }) => run(() => ctx.deps.mcp.toggle(home(ctx), decodeURIComponent(input.name), input.enabled))),
    update: os.mcp.update.handler(({ input, context: { ctx } }) => run(() => { const { name, ...body } = input; return ctx.deps.mcp.update(home(ctx), decodeURIComponent(name), body) as Promise<never> })),
    delete: os.mcp.delete.handler(({ input, context: { ctx } }) => run(() => ctx.deps.mcp.delete(home(ctx), decodeURIComponent(input.name)))),
  },
  plugins: os.plugins.handler(({ context: { ctx } }) => run(async () => {
    const sidecar = ctx.deps.sidecar()
    const hooks = ['pre_tool_call', 'post_tool_call', 'pre_llm_call', 'post_llm_call']
    if (!sidecar) return { plugins: [], empty: true, supported_hooks: hooks, read_only: true as const, unavailable: true }
    try {
      const config: Dict = await ctx.deps.agentConfig.read(home(ctx)).catch(() => ({}))
      const selected: Record<string, string> = {}
      for (const [k, v] of Object.entries(config)) if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Dict).provider === 'string') selected[k] = str((v as Dict).provider).trim().toLowerCase()
      const result = await sidecar.call('plugins.list', { profile_home: home(ctx), selected_providers: selected })
      return { plugins: result.plugins, empty: result.plugins.length === 0, supported_hooks: result.supported_hooks, read_only: true as const }
    } catch (error) {
      ctx.deps.log(`[plugins] visibility payload failed: ${str((error as Error).message)}`)
      return { plugins: [], empty: true, supported_hooks: hooks, read_only: true as const, unavailable: true }
    }
  })),
  updates: {
    check: os.updates.check.handler(({ context: { ctx } }) => run(() => {
      const settings = ctx.deps.settings.load()
      if (settings.check_for_updates === false) return { disabled: true as const }
      return ctx.deps.updates.cachedStatus(!pyBool(settings.ignore_agent_updates)) as never
    })),
    checkNow: os.updates.checkNow.handler(({ input, context: { ctx } }) => run(async () => {
      const settings = ctx.deps.settings.load()
      const force = pyBool(input.force)
      if (settings.check_for_updates === false && !force) return { disabled: true as const }
      // An explicit body channel wins over a debounced, not-yet-saved setting.
      const channel = input.channel === 'stable' || input.channel === 'experimental' ? input.channel : normalizeChannel(settings.update_channel)
      ctx.deps.log(`[updates] checking for updates (force=${String(force)}, channel=${channel})`)
      return (await ctx.deps.updates.check(force, !pyBool(settings.ignore_agent_updates), channel, input.agent_channel)) as never
    })),
    apply: os.updates.apply.handler(({ input, context: { ctx } }) => run(() => { const target = updateTarget(input.target); return applyWithNotification(ctx, target, () => ctx.deps.updates.apply(target, bodyChannel(input.channel), () => true, { agentChannel: input.agent_channel, confirmedRevision: input.confirmed_agent_revision }), input.confirmed_agent_revision !== undefined, input.tab_id) as never })),
    force: os.updates.force.handler(({ input, context: { ctx } }) => run(() => { const target = updateTarget(input.target); return applyWithNotification(ctx, target, () => ctx.deps.updates.force(target, bodyChannel(input.channel), { agentChannel: input.agent_channel, confirmedRevision: input.confirmed_agent_revision }), input.confirmed_agent_revision !== undefined, input.tab_id) as never })),
    clearLock: os.updates.clearLock.handler(({ input, context: { ctx } }) => run(() => { const target = updateTarget(input.target); return applyWithNotification(ctx, target, () => ctx.deps.updates.clearLock(target, { agentChannel: input.agent_channel, confirmedRevision: input.confirmed_agent_revision }), input.confirmed_agent_revision !== undefined, input.tab_id) as never })),
    summary: os.updates.summary.handler(({ input, context: { ctx } }) => run(() => ctx.deps.updates.summarize(input.updates ?? {}, input.target) as never)),
  },
  updateNotifications: {
    list: os.updateNotifications.list.handler(({ input, context: { ctx } }) => run(async () => {
      const scope = await updateNotificationScope(ctx, input.tab_id)
      const frontendBuild = ctx.deps.updateNotifications.syncTabBuild(scope, input.loaded_build ?? null, ctx.deps.spa.buildId())
      return { ...ctx.deps.updateNotifications.list(scope), frontend_build: frontendBuild } as never
    })),
    read: os.updateNotifications.read.handler(({ input, context: { ctx } }) => run(async () => {
      const notification = ctx.deps.updateNotifications.read(await updateNotificationScope(ctx, input.tab_id), input.id)
      if (!notification) throw new HttpError(404, 'Update notification not found')
      return notification as never
    })),
    dismiss: os.updateNotifications.dismiss.handler(({ input, context: { ctx } }) => run(async () => {
      const result = ctx.deps.updateNotifications.dismiss(await updateNotificationScope(ctx, input.tab_id), input.id)
      if (result === 'acknowledgement_required') throw new HttpError(409, 'This notification requires acknowledgement before it can be dismissed')
      return { ok: true as const }
    })),
    clear: os.updateNotifications.clear.handler(({ input, context: { ctx } }) => run(async () => {
      const scope = await updateNotificationScope(ctx, input.tab_id)
      const frontendBuild = ctx.deps.updateNotifications.syncTabBuild(scope, input.loaded_build ?? null, ctx.deps.spa.buildId())
      return { ...ctx.deps.updateNotifications.clear(scope), frontend_build: frontendBuild } as never
    })),
    cancel: os.updateNotifications.cancel.handler(({ input, context: { ctx } }) => run(async () => {
      const notification = ctx.deps.updateNotifications.cancelUpdate(await updateNotificationScope(ctx), input.id)
      if (!notification) throw new HttpError(404, 'Awaiting update notification not found')
      return notification as never
    })),
    action: os.updateNotifications.action.handler(({ input, context: { ctx } }) => run(async () => {
      const notification = ctx.deps.updateNotifications.action(await updateNotificationScope(ctx, input.tab_id), input.id, input.action_id)
      if (!notification) throw new HttpError(404, 'Notification action not found')
      return notification as never
    })),
  },
  transcribeCapability: os.transcribeCapability.handler(({ context: { ctx } }) => run(async () => {
    const sidecar = ctx.deps.sidecar()
    if (!sidecar) return { ok: true as const, available: false, provider: 'none' }
    try {
      const cap = await sidecar.call('stt.capability', { profile_home: home(ctx) })
      return { ok: true as const, available: cap.available, provider: cap.provider || 'none' }
    } catch {
      return { ok: true as const, available: false, provider: 'none' }
    }
  })),
  clientEvents: os.clientEvents.handler(({ input, context: { ctx } }) => run(() => {
    if (ctx.deps.clientEventLimiter.limited(ctx.peer || 'unknown')) throw new HttpError(429, 'rate_limited', { ok: false })
    const payload = sanitizeClientEvent(input)
    ctx.deps.log(`[client-event] from ${ctx.peer || 'unknown'}: ${JSON.stringify(payload)}`)
    return { ok: true as const, event: str(payload.event) || null }
  })),
})

function updateTarget(raw: unknown): 'webui' | 'agent' {
  if (raw !== 'webui' && raw !== 'agent') throw new HttpError(400, 'target must be "webui" or "agent"')
  return raw
}

const bodyChannel = (raw: unknown): 'stable' | 'experimental' | null => (raw === 'stable' || raw === 'experimental' ? raw : null)
