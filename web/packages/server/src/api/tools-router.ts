/** Skills, memory, prompts, commands, notes, insights, logs, health, MCP, plugins, updates, diagnostics (Python `api/routes.py` handlers of the same paths). */
import type { InferContractRouterInputs } from '@orpc/contract'
import { implement } from '@orpc/server'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { toolsContract, type GatewayLifecycle, type GatewayMode, type GatewayStatus, type PluginOAuthClientView, type PluginSettingField, type SidecarMethodName, type SidecarParams, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { HttpError, requireFields, type ApiContext } from './router.js'
import { requestSessionIdGuard } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { clientStreamKey } from './sse-routes.js'
import { activeProfileName, ensureTrustedAuthSession, sessionCanManageServer } from '../auth/gate.js'
import { currentChatReadiness, HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import { stateDbSessionReadAsync } from '../sessions/state-db.js'
import { ConfigUnavailable, type Config, type Dict } from '../config/agent-config.js'
import { SidecarError } from '../sidecar/client.js'
import { createPrompt, deletePrompt, externalNotesEnabled, loadPrompts, readMemory, writeMemory, previewMemoryCompaction, applyMemoryCompaction, type MemoryWriteDeps } from '../tools/memory.js'
import { JoplinError, joplinNote, joplinSearch, notesSources, type JoplinDeps } from '../tools/mcp.js'
import { catalogNames, connectorOperation, connectorsPage, connectorTools, rememberCatalogNames } from '../tools/connectors.js'
import { resolveWikiLocation, wikiPages, type WikiLocation } from '../tools/wiki.js'
import { buildInsights } from '../tools/insights.js'
import { commandCatalog, SESSION_EXEC_COMMANDS } from '../tools/commands.js'
import { spokenText } from './tools-raw.js'
import { agentHealth, applyDashboardConfig, dashboardConfig, dashboardStatus, forgetRemoteProbes, gatewayStatus, parseDashboardConfig, readLogTail, remoteGatewayBaseUrl, systemHealth } from '../tools/health.js'
import { EXTERNALLY_MANAGED } from '../tools/gateway-lifecycle.js'
import { NOT_CONTROLLED, restartGateway } from '../tools/gateway-restart.js'
import { projectOsDashboard } from '../tools/project-os.js'
import { PluginSettingsInvalid, planPluginSettings, pluginSettingsView, serializePluginSettingsSave } from '../tools/plugin-settings.js'
import { checkPastedRedirect } from '../tools/plugin-oauth.js'
import { oauthCall, oauthView } from './settings-router.js'
import { credentialShadowed, RuntimeCredentialError, writeRuntimeCredential } from '../providers/runtime-env.js'
import { EnvWriteError, loadEnvFile } from '../providers/env-file.js'
import { loadGatewaySessionIdentityMap } from '../sessions/list.js'
import { gitBadge } from '../workspace/git.js'
import { sanitizeError } from '../workspace/media.js'
import { isWebChannel, normalizeWebChannel, updatesCheckView, type WebChannel } from '../tools/updates.js'
import { pyBool } from '../settings.js'
import { str } from '../util.js'
import { redactString } from '../redact.js'
import { GATEWAY_RESTART_NOW, updateNotificationOwner, type UpdateNotificationScope } from '../tools/update-notifications.js'

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

/** Profile homes with an `stt.warm` in flight (TAL-916). */
const warmingHomes = new Set<string>()

function runningSidecar(ctx: RequestContext): NonNullable<ReturnType<RequestContext['deps']['sidecar']>> {
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) throw new HttpError(503, 'Hermes Agent sidecar is not running')
  return sidecar
}

/** A slash command's sidecar failure: `notFound` is 404, bad input 400, the rest as `failure` maps them. */
function commandFailure(error: unknown, notFound: string, message: string): never {
  if (error instanceof SidecarError && error.condition === notFound) throw new HttpError(404, message)
  if (error instanceof SidecarError && (error.condition === 'invalid_params' || error.code === -32602)) throw new HttpError(400, error.message)
  return failure(error)
}

/** TAL-820: several profiles have third-party plugins and one of them loads its plugins into the shared sidecar process. */
async function pluginIsolationAdvisory(ctx: RequestContext): Promise<boolean> {
  if (ctx.deps.isolatedProfileMode()) return false
  const { profiles } = await runningSidecar(ctx).call('plugins.isolation', { base_home: ctx.deps.profileHome('default') })
  const withPlugins = profiles.filter((profile) => profile.third_party_plugins > 0)
  return withPlugins.length > 1 && withPlugins.some((profile) => profile.isolation === 'in_process')
}

/** TAL-806: the active profile's plugins that declare settings; none on an Agent without the settings module. */
async function pluginSettingsList(ctx: RequestContext) {
  const result = await runningSidecar(ctx).call('plugins.settings', { profile_home: home(ctx) })
  return result.plugins.map((entry) => ({ key: entry.key, fields: pluginSettingsFieldsView(ctx, entry.fields) }))
}

/** TAL-1276: each plugin's declared OAuth clients by key; empty on an Agent without plugin OAuth. */
async function pluginOAuthClients(ctx: RequestContext) {
  const result = await runningSidecar(ctx).call('plugins.oauth_status', { profile_home: home(ctx) })
  return new Map(result.supported ? result.plugins.map((entry) => [entry.key, entry.clients.map((client) => ({ ...client, can_sign_out: client.state !== 'logged_out' }))]) : [])
}

const pluginSettingsFieldsView = (ctx: RequestContext, fields: PluginSettingField[]) => {
  const rootProfile = ctx.deps.isRootProfile(activeProfileName(ctx))
  return pluginSettingsView(fields, (envVar) => credentialShadowed(ctx.deps.config.env, rootProfile, envVar))
}

/** A refusal that proves nothing was written; a timeout or a sidecar exit leaves the outcome unknown. */
const definitiveRefusal = (error: unknown): boolean =>
  error instanceof SidecarError ? ['plugin_settings_managed', 'plugin_settings_changed', 'plugin_not_found'].includes(error.condition) || error.code === -32602
    : error instanceof EnvWriteError ? error.condition !== 'sidecar_unavailable'
    : error instanceof RuntimeCredentialError

/** TAL-818: a sidecar `connectors.*` condition as the HTTP status the contract names; the body's `code` is the condition. */
const CONNECTOR_STATUS: Record<string, number> = {
  connectors_unavailable: 404, connector_not_found: 404, connection_not_found: 404, operation_not_found: 404,
  connectors_sign_in: 403, connectors_forbidden: 403, policy_invalid: 400, connectors_failed: 502,
  policy_conflict: 409, connectors_org_required: 409, operation_settled: 409, operation_refused: 409,
}

async function connectorCall<M extends SidecarMethodName>(ctx: RequestContext, method: M, params: Omit<SidecarParams<M>, 'profile_home'>): Promise<SidecarResult<M>> {
  try {
    // A connect waits up to 31 s for its link; every portal request inside a call is bounded at 30 s.
    return await runningSidecar(ctx).call(method, { ...params, profile_home: home(ctx) } as SidecarParams<M>, { timeoutMs: 90_000 })
  } catch (error) {
    const status = error instanceof SidecarError ? CONNECTOR_STATUS[error.condition] : undefined
    if (status !== undefined) throw new HttpError(status, (error as Error).message, { code: (error as SidecarError).condition })
    if (error instanceof SidecarError && error.code === -32602) throw new HttpError(400, error.message)
    throw error
  }
}

/** The catalog's app names for the active profile: the last page read's, else one catalog read; none when it fails. */
async function connectorNames(ctx: RequestContext): Promise<Record<string, string>> {
  return catalogNames(home(ctx)) ?? await connectorCall(ctx, 'connectors.catalog', {}).then((r) => rememberCatalogNames(home(ctx), r.connectors), () => ({}))
}

/** An operation as the contract shows it, with the apps' catalog names. */
const operationView = async (ctx: RequestContext, snapshot: SidecarResult<'connectors.operation'>) => connectorOperation(snapshot, await connectorNames(ctx))

/** Read failures never create an identity. Auth refusals become a page sign-in state; unreadable rules fail closed. */
const connectorRead = <M extends 'connectors.catalog' | 'connectors.accounts' | 'connectors.policy.get'>(ctx: RequestContext, method: M): Promise<{ value: SidecarResult<M> | null; error: string | null; signInRequired: boolean }> =>
  connectorCall(ctx, method, {} as Omit<SidecarParams<M>, 'profile_home'>).then((value) => ({ value, error: null, signInRequired: false }), (error: unknown) => {
    if (error instanceof HttpError && (method === 'connectors.policy.get' || error.data?.code === 'connectors_sign_in')) {
      return { value: null, error: error.message, signInRequired: error.data?.code === 'connectors_sign_in' }
    }
    throw error
  })

const health = (ctx: RequestContext): Promise<Dict> => agentHealth({ env: ctx.deps.config.env, hermesHome: ctx.deps.config.hermesHome, profileHome: () => home(ctx), fetch: () => ctx.deps.fetch, now: ctx.deps.nowSeconds })

/**
 * TAL-805: the active profile's gateway mode from sidecar `gateway.mode`; null for a remote gateway. A named profile never
 * borrows the root's health: when the sidecar cannot answer, it reads `stopped`, while the root profile reads null and keeps
 * its health. The root profile's gateway in another container (`health` alive from its fresh runtime status) is invisible
 * to the sidecar's process checks, so it stays `own`.
 */
async function gatewayMode(ctx: RequestContext, health: Dict): Promise<GatewayMode | null> {
  if (remoteGatewayBaseUrl(ctx.deps.config.env) !== null) return null
  const sidecar = ctx.deps.sidecar()
  const name = activeProfileName(ctx)
  const isDefault = ctx.deps.isRootProfile(name)
  let mode: GatewayMode | null = null
  try {
    if (sidecar) mode = (await sidecar.call('gateway.mode', { profile_home: home(ctx), name, is_default: isDefault }, { timeoutMs: 10_000 })).gateway_mode
  } catch {
    mode = null
  }
  if (mode === null) return isDefault ? null : 'stopped'
  return mode === 'stopped' && isDefault && health.alive === true ? 'own' : mode
}

/** Python `_gateway_status_payload` for the active profile. */
async function currentGatewayStatus(ctx: RequestContext): Promise<GatewayStatus> {
  const sessionsPath = join(home(ctx), 'sessions', 'sessions.json')
  const probe = await health(ctx)
  const [mode, lifecycle] = await Promise.all([gatewayMode(ctx, probe), ctx.deps.gatewayLifecycle(home(ctx))])
  return gatewayStatus(probe, loadGatewaySessionIdentityMap(sessionsPath), sessionsPath, mode, lifecycle)
}

/**
 * TAL-1627: every lifecycle entry point asks first. A Gateway Web does not control is refused with a typed 409 before any
 * sidecar lock or CLI runs. Each dispatch then clears the remote probe cache, so the status it returns reads the Gateway afresh.
 */
async function controlledGateway<T>(ctx: RequestContext, action: 'start' | 'stop' | 'restart', run: () => Promise<T>): Promise<T> {
  const lifecycle: GatewayLifecycle = await ctx.deps.gatewayLifecycle(home(ctx))
  if (!lifecycle.managed) throw new HttpError(409, EXTERNALLY_MANAGED, { ok: false, code: 'gateway_externally_managed', action, lifecycle })
  return run()
}

const GATEWAY_ACTION_TIMEOUT_S = 60

/** Python `_handle_gateway_lifecycle` through sidecar `gateway.control`: 409 busy, 504 timeout, 500 failure; only the Agent's first error line (`reason`) leaves the server, never its CLI output (TAL-884). */
async function gatewayAction(ctx: RequestContext, action: 'start' | 'stop' | 'restart'): Promise<Dict> {
  return controlledGateway(ctx, action, () => runGatewayAction(ctx, action))
}

async function runGatewayAction(ctx: RequestContext, action: 'start' | 'stop' | 'restart'): Promise<Dict> {
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) throw new HttpError(500, 'Hermes Agent sidecar is not running', { ok: false, action })
  let outcome
  try {
    // A restart drains the old gateway for the Agent's own exit budget (TAL-894): the sidecar picks that wait, and the call has no deadline (TAL-980).
    outcome = action === 'restart'
      ? await sidecar.call('gateway.control', { profile_home: home(ctx), action, interrupt: true }, { timeoutMs: 0 })
      : await sidecar.call('gateway.control', { profile_home: home(ctx), action, interrupt: true, background_wait_seconds: GATEWAY_ACTION_TIMEOUT_S }, { timeoutMs: 300_000 })
  } catch (error) {
    throw new HttpError(500, sanitizeError(error), { ok: false, action })
  } finally {
    forgetRemoteProbes()
  }
  if (outcome.status === 'busy_live_work') throw new HttpError(409, outcome.reason || 'The gateway still has live work.', { ok: false, action })
  if (outcome.status === 'busy') throw new HttpError(409, 'Another gateway action is already in progress; try again shortly.', { ok: false, action })
  if (outcome.timed_out) throw new HttpError(504, outcome.message, { ok: false, action })
  if (outcome.status === 'failed' && outcome.returncode !== undefined) {
    const error = outcome.reason ? `Gateway ${action} failed: ${outcome.reason}` : `Gateway ${action} failed with exit code ${String(outcome.returncode)}`
    throw new HttpError(500, error, { ok: false, action, returncode: outcome.returncode })
  }
  if (outcome.status === 'failed') throw new HttpError(500, outcome.message, { ok: false, action })
  return { ok: true, action, message: `Gateway ${action} completed.`, status: await currentGatewayStatus(ctx) }
}

const principalHash = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')

/** TAL-1563: a replay belongs to the authenticated owner and the profile that admitted it. */
async function replayScope(ctx: RequestContext): Promise<{ owner: string; profile: string }> {
  return { owner: updateNotificationOwner(await ensureTrustedAuthSession(ctx)), profile: activeProfileName(ctx) }
}
const replayRedact = (ctx: RequestContext) => (text: string): string => redactString(text, ctx.deps.sessions.deps.redactEnabled())

async function updateNotificationScope(ctx: RequestContext, tab?: string): Promise<UpdateNotificationScope> {
  const session = await ensureTrustedAuthSession(ctx)
  const profile = activeProfileName(ctx)
  return {
    owner: updateNotificationOwner(session),
    profile,
    serverOwner: await sessionCanManageServer(ctx, session),
    tab: tab ?? null,
    rootProfile: ctx.deps.isRootProfile(profile),
  }
}

async function applyWithNotification(
  ctx: RequestContext,
  input: InferContractRouterInputs<typeof toolsContract>['updates']['apply'],
  action: 'apply' | 'force' | 'clearLock',
): Promise<Dict> {
  const target = updateTarget(input.target)
  const confirmed = input.confirmed_agent_revision !== undefined || input.agent_refresh_token !== undefined
  const scope = await updateNotificationScope(ctx, input.tab_id)
  const active = ctx.deps.updateNotifications.activeUpdate(scope, target)
  if (active) (await ctx.deps.updateNotifications.watch(scope, active.id))
  if (active && (active.phase === 'applying' || active.phase === 'restarting' || active.phase === 'verifying' || active.phase === 'recovering')) {
    return { ok: false, status: 'already_in_progress', message: 'Update already in progress', notification_id: active.id }
  }
  const notification = active ?? (await ctx.deps.updateNotifications.begin(scope, target))
  if (active?.phase === 'awaiting_confirmation' && confirmed) (await ctx.deps.updateNotifications.transition(notification.id, 'applying'))
  // TAL-1138: the gateways running before an Agent update; the update's check needs a new process for each.
  const gatewaysBefore = target === 'agent' ? await ctx.deps.gatewayRestarts.gateways(scope.profile).catch(() => []) : []
  try {
    const options = { operationId: notification.id,
      onTransaction: (baseline: string, selected: string) => ctx.deps.updateNotifications.bindAgentOperation(notification.id, baseline, selected),
      onFailure: (detail: unknown, identity?: { revision: string | null; version: string | null }) => ctx.deps.updateNotifications.handoffAgentRecovery(notification.id, detail, identity),
      agentChannel: input.agent_channel, confirmedRevision: input.confirmed_agent_revision, version: input.version, refreshToken: input.agent_refresh_token, mutationIntent: principalHash(scope.owner, scope.profile, notification.id),
      // TAL-1429: the Updating dialog shows what the running update waits for; a lost refresh only delays that wording.
      onProgress: (detail: string) => { ctx.deps.updateNotifications.transition(notification.id, 'applying', null, undefined, detail).catch(() => undefined) } }
    const result = action === 'apply' ? await ctx.deps.updates.apply(target, bodyChannel(input.channel), () => true, options)
      : action === 'force' ? await ctx.deps.updates.force(target, bodyChannel(input.channel), options)
        : await ctx.deps.updates.clearLock(target, options)
    const verifiedIdentity = typeof result.verified_revision === 'string'
      ? { revision: result.verified_revision, version: typeof result.verified_version === 'string' ? result.verified_version : null }
      : undefined
    if (result.recovery_only === true) {
      await ctx.deps.updateNotifications.transition(notification.id, 'unknown', null, verifiedIdentity, `Retained Agent recovery was attempted. The requested update outcome is unverified. ${str(result.message)}`)
      return { ...result, ok: false, notification_id: notification.id }
    }
    if (result.recovery_pending === true) return { ...result, notification_id: notification.id }
    if (result.confirmation_required === true) (await ctx.deps.updateNotifications.transition(notification.id, 'awaiting_confirmation', null, verifiedIdentity, result.message))
    else if (result.restart_blocked === true) (await ctx.deps.updateNotifications.transition(notification.id, 'blocked', null, verifiedIdentity, result.message))
    else if (result.ok !== true) (await ctx.deps.updateNotifications.transition(notification.id, 'failed', null, verifiedIdentity, result.message || result.error))
    else if (target === 'webui' && result.restart_scheduled === true) {
      await ctx.deps.updateNotifications.transition(notification.id, 'restarting', str(result.sourceRevision || result.candidate_revision), verifiedIdentity)
    } else if (target === 'agent' && result.gateway_restart === 'resumed') {
      // TAL-1138: the native updater restarted the gateways inside its writer pause. Agent responding still needs the
      // new gateway processes and a current Agent runtime; a scheduled Web restart runs that check from the new server.
      // TAL-1627: the updater restarts only the local gateways it paused; a monitored Gateway Web does not control is named as not restarted.
      const controlled = await ctx.deps.gatewayLifecycle(home(ctx)).then((lifecycle) => lifecycle.managed, () => false)
      const detail = [result.stash_conflict === true ? str(result.message) : null, controlled ? null : NOT_CONTROLLED].filter(Boolean).join('\n\n') || null
      await ctx.deps.updateNotifications.recordGatewayBaseline(notification.id, gatewaysBefore)
      await ctx.deps.updateNotifications.transition(notification.id, 'verifying', null, verifiedIdentity, detail)
      if (result.restart_scheduled === true) (await ctx.deps.updateNotifications.markWebRestart(notification.id))
      else void ctx.deps.gatewayRestarts.verify(notification.id, scope.profile, gatewaysBefore, detail)
    } else if (result.gateway_restart === 'waiting_for_idle' || (target === 'agent' && ctx.deps.gatewayRestarts.pendingId() !== null)) {
      // TAL-953: the gateway restarts once its own work drains. A restart already waiting covers this update too, and a
      // repeated request that found the Agent current follows that wait rather than reporting success before it.
      const detail = result.stash_conflict === true ? str(result.message) : null
      await ctx.deps.updateNotifications.transition(notification.id, 'waiting_for_idle', null, verifiedIdentity, detail)
      // TAL-1138: a scheduled Web restart goes first, and the restarted server resumes this wait.
      if (result.restart_scheduled === true && ctx.deps.gatewayRestarts.pendingId() === null) {
        await ctx.deps.updateNotifications.markWebRestart(notification.id)
        return { ...result, notification_id: notification.id }
      }
      const pending = (await ctx.deps.gatewayRestarts.schedule(notification.id, scope.profile, detail))
      if (pending !== notification.id) (await ctx.deps.updateNotifications.watch(scope, pending))
      return { ...result, notification_id: pending }
    } else {
      // A kept Agent stash needs the user's attention; its recovery commands ride on the success record.
      await ctx.deps.updateNotifications.transition(notification.id, 'succeeded', null, verifiedIdentity, result.stash_conflict === true ? result.message : undefined)
    }
    return { ...result, notification_id: notification.id }
  } catch (error) {
    const detail = error instanceof Error ? error.message : null
    if (!await ctx.deps.updateNotifications.handoffAgentRecovery(notification.id, detail)) await ctx.deps.updateNotifications.transition(notification.id, 'failed', null, undefined, detail)
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

async function memoryWorkspace(ctx: RequestContext, sessionId: string, workspace: string): Promise<string | null> {
  if (sessionId) {
    try {
      const session = (await ctx.deps.sessionStore.get(sessionId, { metadataOnly: true }))
      if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) return null
      const ws = str(session.workspace).trim()
      return ws ? ctx.deps.workspaces.resolvePath(ws, session.profile) : null
    } catch {
      return null
    }
  }
  const profile = activeProfileName(ctx)
  if (!ctx.deps.workspaces.profileSupportsLocalIo(profile)) return null
  const raw = workspace || (ctx.deps.config.env.TERMINAL_CWD ?? '') || (await ctx.deps.workspaces.lastWorkspace(profile))
  if (!raw) return null
  try { return (await ctx.deps.workspaces.resolveTrusted(raw, profile)) } catch { return null }
}

/** The external notes drawer's Joplin access; 404 while the drawer is disabled. */
async function joplinDeps(ctx: RequestContext, disabled: Dict): Promise<JoplinDeps> {
  const config = await ctx.deps.agentConfig.read(home(ctx))
  if (!externalNotesEnabled(ctx.deps.config.env, config)) throw new HttpError(404, 'External notes sources are disabled.', { source: 'disabled', ...disabled })
  return { config, env: ctx.deps.config.env, fetch: ctx.deps.fetch, redact: ctx.deps.sessions.deps.redactEnabled() }
}

/** A Joplin failure answers 502 with its fixed message. */
async function joplin<T>(extra: Dict, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof JoplinError) throw new HttpError(502, error.message, { source: 'joplin', ...extra })
    throw error
  }
}

/** Python `int(limit or 20)`, falling back to 20 for anything unparseable or zero. */
const notesLimit = (raw: string | undefined): number => (/^\s*[+-]?\d+\s*$/.test(raw ?? '') ? Number.parseInt(String(raw).trim(), 10) : 0) || 20

/** The wiki root for the active profile; an unreadable config.yaml falls through to the default. */
async function wikiLocation(ctx: RequestContext): Promise<WikiLocation> {
  const profileHome = home(ctx)
  const config: Config = await ctx.deps.agentConfig.read(profileHome).catch(() => ({}))
  return resolveWikiLocation(ctx.deps.config.env, profileHome, config, ctx.deps.config.homeDir)
}

/** TAL-819: the Agent's review handler per write; its message can quote the entry text an approval replaced or removed. */
async function reviewPendingWrites(ctx: RequestContext, verb: 'approve' | 'reject', input: { kind: 'skills' | 'memory'; writes: { id: string; revision: string }[] }) {
  const { results } = await runningSidecar(ctx).call(`write_approval.${verb}`, { profile_home: home(ctx), kind: input.kind, writes: input.writes })
  return { results: results.map((r) => ({ ...r, message: redactString(r.message, ctx.deps.sessions.deps.redactEnabled()) })) }
}

function memoryWriteDeps(ctx: RequestContext, profileHome: string): MemoryWriteDeps {
  return {
    key: ctx.deps.auth.signingKey(),
    check: (target, content) => runningSidecar(ctx).call('memory.check', { profile_home: profileHome, target, content }),
    write: (section, base, content) => runningSidecar(ctx).call('memory.write', { profile_home: profileHome, section, base, content }),
  }
}

export const toolsRouter = os.router({
  toolsetsCatalog: os.toolsetsCatalog.handler(({ input, context: { ctx } }) => run(() =>
    runningSidecar(ctx).call('toolsets.catalog', { profile_home: home(ctx), enabled_toolsets: input.toolsets }),
  )),
  skills: {
    revisions: os.skills.revisions.handler(({ input, context: { ctx } }) => run(async () => {
      const history = await ctx.deps.skills.revisions(home(ctx), input)
      const redact = (text: string) => redactString(text, ctx.deps.sessions.deps.redactEnabled())
      return { ...history, revisions: history.revisions.map((row) => ({ ...row, actor: row.actor === null ? null : redact(row.actor) })),
        selected: history.selected && { ...history.selected, content: redact(history.selected.content) },
        comparison: history.comparison && { ...history.comparison, diff: redact(history.comparison.diff) } }
    })),
    replayPlan: os.skills.replayPlan.handler(({ input, context: { ctx } }) => run(() => ctx.deps.skillReplays.plan(home(ctx), input, replayRedact(ctx)))),
    replays: os.skills.replays.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.skillReplays.list(await replayScope(ctx), input.name, replayRedact(ctx)))),
    replayStart: os.skills.replayStart.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.skillReplays.start(await replayScope(ctx), home(ctx), input, replayRedact(ctx)))),
    replayCancel: os.skills.replayCancel.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.skillReplays.cancel(await replayScope(ctx), input.id, replayRedact(ctx)))),
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
    compactionPreview: os.memory.compactionPreview.handler(({ input, context: { ctx } }) => run(async () => {
      const profileHome = home(ctx)
      return previewMemoryCompaction(profileHome, await ctx.deps.agentConfig.read(profileHome), input.section, input.revision, {
        ...memoryWriteDeps(ctx, profileHome), now: ctx.deps.nowSeconds,
        complete: (messages) => runningSidecar(ctx).call('aux.complete', { profile_home: profileHome, task: 'compression', messages, main_fallback: false, max_tokens: 4096, temperature: 0.2 }, { timeoutMs: 60_000 }),
      })
    })),
    compactionApply: os.memory.compactionApply.handler(({ input, context: { ctx } }) => run(async () => {
      const profileHome = home(ctx)
      return applyMemoryCompaction(profileHome, await ctx.deps.agentConfig.read(profileHome), input.receipt, { ...memoryWriteDeps(ctx, profileHome), now: ctx.deps.nowSeconds })
    })),
    get: os.memory.get.handler(({ input, context: { ctx } }) => run(async () => {
      const config = await ctx.deps.agentConfig.read(home(ctx))
      return readMemory(home(ctx), config, (await memoryWorkspace(ctx, str(input.session_id), str(input.workspace))), ctx.deps.config.env, ctx.deps.sessions.deps.redactEnabled(), ctx.deps.auth.signingKey()) as never
    })),
    write: os.memory.write.handler(({ input, context: { ctx } }) => run(async () => {
      const section = input.section ?? input.target
      if (section === undefined || input.content === undefined) throw new HttpError(400, 'Missing required field(s): section, content')
      const profileHome = home(ctx)
      return writeMemory(profileHome, await ctx.deps.agentConfig.read(profileHome), str(section), str(input.content), input.revision, memoryWriteDeps(ctx, profileHome))
    })),
  },
  pendingWrites: {
    list: os.pendingWrites.list.handler(({ input, context: { ctx } }) => run(async () => {
      // Without the Agent nothing can be reviewed, so the page shows no panel (the Agent's own status reports it down).
      const sidecar = ctx.deps.sidecar()
      const { enabled, items } = sidecar ? await sidecar.call('write_approval.pending', { profile_home: home(ctx), kind: input.kind }) : { enabled: false, items: [] }
      const redact = (text: string): string => redactString(text, ctx.deps.sessions.deps.redactEnabled())
      // Display text is redacted like the memory page; `revision` stays the sidecar's hash of the raw diff it rechecks.
      return { kind: input.kind, visible: items.length > 0, enabled, items: items.map((item) => ({ ...item, summary: redact(item.summary), diff: redact(item.diff) })) }
    })),
    approve: os.pendingWrites.approve.handler(({ input, context: { ctx } }) => run(() => reviewPendingWrites(ctx, 'approve', input))),
    reject: os.pendingWrites.reject.handler(({ input, context: { ctx } }) => run(() => reviewPendingWrites(ctx, 'reject', input))),
  },
  prompts: {
    list: os.prompts.list.handler(({ context: { ctx } }) => run(() => ({ prompts: loadPrompts(home(ctx)) }))),
    create: os.prompts.create.handler(({ input, context: { ctx } }) => run(() => ({ ok: true as const, prompt: createPrompt(home(ctx), str(input.text), str(input.label), ctx.deps.nowSeconds()) }))),
    delete: os.prompts.delete.handler(({ input, context: { ctx } }) => run(() => { deletePrompt(home(ctx), str(input.id).trim()); return { ok: true as const } })),
  },
  commands: {
    list: os.commands.list.handler(({ context: { ctx } }) => run(async () => {
      const sidecar = ctx.deps.sidecar()
      let agent: Parameters<typeof commandCatalog>[0] = []
      try {
        if (sidecar) agent = (await sidecar.call('commands.registry', { profile_home: home(ctx) })).commands
      } catch { /* the client commands still list without the Agent registry */ }
      return { commands: commandCatalog(agent) }
    })),
    exec: os.commands.exec.handler(({ input, signal, context: { ctx } }) => run(async () => {
      const command = str(input.command).trim()
      if (!command) throw new HttpError(400, 'command is required')
      const [, name = '', args = ''] = /^\/?(\S*)\s*([\s\S]*)$/.exec(command) ?? []
      const sessionId = str(input.session_id).trim()
      if (sessionId) (await ctx.deps.sessions.assertWritable(sessionId))
      // TAL-902: a session command runs on the chat's own agent (the request guard already checked the chat's profile).
      if (SESSION_EXEC_COMMANDS.has(name.toLowerCase())) {
        return { output: await ctx.deps.turns.refine(sessionId ? (await ctx.deps.sessionStore.get(sessionId)) : null, args.trim()) }
      }
      // TAL-904: a chat's command runs under that chat's session and the workspace its next turn would use. An unknown
      // chat (404) or a workspace that turn would refuse (400) refuses the command rather than run it half-bound.
      const chat = sessionId ? { session_id: sessionId, workspace: (await ctx.deps.sessions.turnWorkspace((await ctx.deps.sessionStore.get(sessionId, { metadataOnly: true })))) } : {}
      // Workspace resolution can yield to native adoption; recheck at the local execution boundary.
      if (sessionId) await ctx.deps.sessions.assertWritable(sessionId)
      const releasePrincipal = ctx.deps.commandSlots.claim(JSON.stringify(['principal', ctx.notificationOwner ?? clientStreamKey(ctx)]))
      const releaseProfile = releasePrincipal ? ctx.deps.commandSlots.claim(JSON.stringify(['profile', home(ctx)])) : null
      if (!releaseProfile) {
        releasePrincipal?.()
        throw new HttpError(429, 'Too many running commands; wait for one to finish.')
      }
      let output: string
      const controller = new AbortController()
      const prompts = new Set<string>()
      const cancel = () => {
        controller.abort()
        for (const id of prompts) ctx.deps.pending.resolveClarify(sessionId, id)
        prompts.clear()
      }
      signal?.addEventListener('abort', cancel, { once: true })
      ctx.res.once('close', cancel)
      if (signal?.aborted || ctx.res.destroyed) cancel()
      try {
        output = (await runningSidecar(ctx).call('commands.exec', { profile_home: home(ctx), command, ...chat }, {
          timeoutMs: 120_000,
          signal: controller.signal,
          onStream: (frame) => {
            if (!sessionId || controller.signal.aborted || !frame.data || typeof frame.data !== 'object') return
            const data = frame.data as Record<string, unknown>
            const id = str(data.clarify_id)
            if (!id || data.session_id !== sessionId) return
            if (frame.event === 'clarify') {
              prompts.add(id)
              ctx.deps.pending.submitClarify(sessionId, data, 'command')
            } else if (frame.event === 'clarify_resolved' && prompts.delete(id)) ctx.deps.pending.resolveClarify(sessionId, id)
          },
        })).output
      } catch (error) {
        return commandFailure(error, 'command_not_found', 'Plugin command not found')
      } finally {
        releaseProfile()
        releasePrincipal?.()
        signal?.removeEventListener('abort', cancel)
        ctx.res.off('close', cancel)
        for (const id of prompts) ctx.deps.pending.resolveClarify(sessionId, id)
      }
      // TAL-1274: an /autoprune answer typed in the composer withdraws the profile's open auto-prune question.
      if (name.toLowerCase() === 'autoprune') {
        const profile = activeProfileName(ctx)
        await ctx.deps.pruneAdvice.check(ctx.deps.isRootProfile(profile) ? 'default' : profile, home(ctx))
      }
      return { output }
    })),
    bundles: os.commands.bundles.handler(({ context: { ctx } }) => run(async () => {
      const sidecar = ctx.deps.sidecar()
      try {
        return { bundles: sidecar ? (await sidecar.call('commands.bundles', { profile_home: home(ctx) })).bundles : [] }
      } catch {
        return { bundles: [] }
      }
    })),
    resolveBundle: os.commands.resolveBundle.handler(({ input, context: { ctx } }) => run(async () => {
      const command = str(input.command).trim()
      if (!command) throw new HttpError(400, 'command is required')
      try {
        return await runningSidecar(ctx).call('commands.bundle_resolve', { profile_home: home(ctx), command }, { timeoutMs: 120_000 })
      } catch (error) {
        return commandFailure(error, 'bundle_not_found', 'Bundle command not found')
      }
    })),
    resolveMoa: os.commands.resolveMoa.handler(({ input, context: { ctx } }) => run(async () => {
      try {
        return (await runningSidecar(ctx).call('commands.moa_preset', { profile_home: home(ctx), preset: str(input.preset).trim() || null })).moa
      } catch (error) {
        if (error instanceof SidecarError && error.condition === 'moa_unavailable') throw new HttpError(503, error.message)
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
      const deps = await joplinDeps(ctx, { results: [] })
      const source = str(input.source).trim().toLowerCase() || 'joplin'
      const query = str(input.q).trim()
      if (source !== 'joplin') throw new HttpError(400, 'Search is currently implemented for Joplin sources only.', { source, results: [] })
      return { source: 'joplin' as const, query, results: await joplin({ query, results: [] }, () => joplinSearch(deps, query, notesLimit(input.limit))) }
    })),
    item: os.notes.item.handler(({ input, context: { ctx } }) => run(async () => {
      const deps = await joplinDeps(ctx, {})
      const source = str(input.source).trim().toLowerCase() || 'joplin'
      if (source !== 'joplin') throw new HttpError(400, 'Preview is currently implemented for Joplin sources only.', { source })
      return { source: 'joplin' as const, note: await joplin({}, () => joplinNote(deps, str(input.id))) }
    })),
  },
  wiki: {
    status: os.wiki.status.handler(({ context: { ctx } }) => run(async () => wikiPages.status(await wikiLocation(ctx)))),
    browse: os.wiki.browse.handler(({ context: { ctx } }) => run(async () => wikiPages.browse(await wikiLocation(ctx)))),
    page: os.wiki.page.handler(({ input, context: { ctx } }) => run(async () => wikiPages.page(await wikiLocation(ctx), str(input.path)))),
  },
  insights: os.insights.handler(({ input, context: { ctx } }) => run(async () => {
    let entries: Dict[] = []
    try { entries = (await ctx.deps.sessionStore.readIndexEntries()) } catch { entries = [] }
    return buildInsights(entries, input.days, ctx.deps.nowSeconds(), (cutoff) => stateDbSessionReadAsync([], 'insightsSessionRows', join(home(ctx), 'state.db'), cutoff)) as never
  })),
  logs: os.logs.handler(({ input, signal, context: { ctx } }) => run(() => readLogTail(home(ctx), input.file, input.tail, signal) as Promise<never>)),
  ops: {
    agent: os.ops.agent.handler(({ context: { ctx } }) => run(async () => { const [gateway, chat, lifecycle] = await Promise.all([health(ctx), currentChatReadiness(ctx.deps.sidecar()), ctx.deps.gatewayLifecycle(home(ctx))]); return { ...gateway, chat, gateway_lifecycle: lifecycle } })),
    system: os.ops.system.handler(({ context: { ctx } }) => run(() => systemHealth(ctx.deps.config.homeDir, ctx.deps.runtimeDiagnostics()) as never)),
    restart: os.ops.restart.handler(({ context: { ctx } }) => run(() => controlledGateway(ctx, 'restart', async () => {
      const sidecar = ctx.deps.sidecar()
      if (!sidecar) throw new HttpError(500, 'Hermes Agent sidecar is not running')
      const outcome = await restartGateway(sidecar, home(ctx), true).finally(forgetRemoteProbes)
      if (outcome.status === 'completed') return { ok: true as const, message: 'Gateway service restarted successfully' }
      if (outcome.status === 'busy') throw new HttpError(429, outcome.message || 'Restart already in progress. Please wait a moment and try again.')
      throw new HttpError(500, outcome.message || 'Internal error running restart')
    }))),
    dashboard: os.ops.dashboard.handler(({ context: { ctx } }) => run(async () => { const config: Dict = await ctx.deps.agentConfig.read(home(ctx)).catch(() => ({})); return dashboardStatus(config, ctx.deps.config.env, ctx.deps.fetch) as Promise<never> })),
    dashboardConfig: os.ops.dashboardConfig.handler(({ context: { ctx } }) => run(async () => dashboardConfig(await ctx.deps.agentConfig.read(home(ctx)).catch(() => ({}))))),
    saveDashboardConfig: os.ops.saveDashboardConfig.handler(({ input, context: { ctx } }) => run(async () => {
      const next = parseDashboardConfig(input)
      await ctx.deps.agentConfig.update(home(ctx), (config) => { applyDashboardConfig(config, next) })
      return next
    })),
    projectOs: os.ops.projectOs.handler(({ input, context: { ctx } }) => run(async () => {
      const profile = activeProfileName(ctx)
      return projectOsDashboard(str(input.board), {
        localIo: ctx.deps.workspaces.profileSupportsLocalIo(profile),
        lastWorkspace: (await ctx.deps.workspaces.lastWorkspace(profile)),
        boards: async () => (await runningSidecar(ctx).call('kanban.boards', { profile_home: home(ctx), include_archived: true })).boards,
        git: async (repoRoot) => gitBadge(await ctx.deps.git.status(repoRoot, { useCache: true })),
        cwd: process.cwd(),
      })
    })),
    shutdown: os.ops.shutdown.handler(({ context: { ctx } }) => run(() => {
      ctx.deps.log(`[shutdown-request] remote=${ctx.peer || 'unknown'} method=${ctx.method} path=${ctx.path.slice(0, 240)} ua=${(ctx.header('user-agent') ?? 'no-ua').replace(/[\x00-\x1f\x7f]+/g, '?').slice(0, 240)}`)
      ctx.deps.requestShutdown()
      return { status: 'shutting_down' as const }
    })),
  },
  gateway: {
    status: os.gateway.status.handler(({ context: { ctx } }) => run(() => currentGatewayStatus(ctx))),
    start: os.gateway.start.handler(({ context: { ctx } }) => run(() => gatewayAction(ctx, 'start'))),
    stop: os.gateway.stop.handler(({ context: { ctx } }) => run(() => gatewayAction(ctx, 'stop'))),
    restart: os.gateway.restart.handler(({ context: { ctx } }) => run(() => gatewayAction(ctx, 'restart'))),
  },
  mcp: {
    servers: os.mcp.servers.handler(({ context: { ctx } }) => run(() => ctx.deps.mcp.servers(home(ctx)) as Promise<never>)),
    tools: os.mcp.tools.handler(({ input, context: { ctx } }) => run(() => ctx.deps.mcp.tools(home(ctx), input.q) as Promise<never>)),
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
  connectors: {
    // Fails closed: no sidecar, or one that cannot answer, hides the page.
    available: os.connectors.available.handler(({ context: { ctx } }) => run(async () => ({ available: ctx.deps.sidecar() ? await connectorCall(ctx, 'connectors.available', {}).then((r) => r.available, () => false) : false }))),
    page: os.connectors.page.handler(({ context: { ctx } }) => run(async () => {
      if (!ctx.deps.sidecar() || !(await connectorCall(ctx, 'connectors.available', {})).available) return { available: false, connectors: [], policy_revision: null, rules_error: null, sign_in_required: false }
      const [catalog, accounts, policy] = await Promise.all([
        connectorRead(ctx, 'connectors.catalog'), connectorRead(ctx, 'connectors.accounts'), connectorRead(ctx, 'connectors.policy.get'),
      ])
      rememberCatalogNames(home(ctx), catalog.value?.connectors ?? [])
      const page = connectorsPage(catalog.value?.connectors ?? [], accounts.value?.accounts ?? [], policy.value, policy.error,
        catalog.signInRequired || accounts.signInRequired || policy.signInRequired)
      // Accounts has already recorded native sightings, including connections made outside Web.
      return { ...page, sign_in_offer: await ctx.deps.connectorOffers.view(home(ctx), runningSidecar(ctx)) }
    })),
    dismissOffer: os.connectors.dismissOffer.handler(({ input, context: { ctx } }) => run(() => ctx.deps.connectorOffers.view(home(ctx), runningSidecar(ctx), input.offer_id))),
    tools: os.connectors.tools.handler(({ input, context: { ctx } }) => run(async () => {
      const [listing, policy] = await Promise.all([connectorCall(ctx, 'connectors.tools', { connector: input.connector }), connectorRead(ctx, 'connectors.policy.get')])
      return connectorTools(listing, policy.value)
    })),
    setPolicy: os.connectors.setPolicy.handler(({ input, context: { ctx } }) => run(async () => {
      const change = input.tool === undefined ? (typeof input.enabled === 'boolean' ? { enabled: input.enabled } : null)
        : typeof input.tool_enabled === 'boolean' && input.enabled === undefined ? { tool: input.tool, tool_enabled: input.tool_enabled } : null
      if (!change) throw new HttpError(400, 'Send `enabled`, or `tool` with `tool_enabled`.', { code: 'policy_invalid' })
      const { revision } = await connectorCall(ctx, 'connectors.policy.set', { connector: input.connector, expected_revision: input.revision, ...change })
      return { ok: true as const, revision }
    })),
    connect: os.connectors.connect.handler(({ input, context: { ctx } }) => run(async () => operationView(ctx, await connectorCall(ctx, 'connectors.connect', { connector: input.connector, ...(input.nous_account_id ? { nous_account_id: input.nous_account_id } : {}) })))),
    removeAccount: os.connectors.removeAccount.handler(({ input, context: { ctx } }) => run(async () => {
      await connectorCall(ctx, 'connectors.remove', { connection_id: input.connection_id })
      return { ok: true as const }
    })),
    operation: os.connectors.operation.handler(({ input, context: { ctx } }) => run(async () => operationView(ctx, await connectorCall(ctx, 'connectors.operation', { op_id: input.op_id })))),
    respond: os.connectors.respond.handler(({ input, context: { ctx } }) => run(async () => {
      // Only a move the operation offers now reaches the Agent: the view decides, the sidecar applies.
      const view = connectorOperation(await connectorCall(ctx, 'connectors.operation', { op_id: input.op_id }))
      const { action } = input
      const offered = action === 'continue' ? view.can_continue : view.targets.some((t) => t.name === input.target && t.actions.includes(action))
      if (!offered) throw new HttpError(409, 'That move is not open on this connection.', { code: 'operation_refused' })
      return operationView(ctx, await connectorCall(ctx, 'connectors.respond', { op_id: input.op_id, action, ...(input.target ? { target: input.target } : {}), ...(input.env ? { env: input.env } : {}) }))
    })),
  },
  plugins: os.plugins.handler(({ context: { ctx } }) => run(async () => {
    const sidecar = ctx.deps.sidecar()
    const hooks = ['pre_tool_call', 'post_tool_call', 'pre_llm_call', 'post_llm_call']
    const editable = await sessionCanManageServer(ctx, await ensureTrustedAuthSession(ctx))
    if (!sidecar) return { plugins: [], empty: true, supported_hooks: hooks, read_only: true, unavailable: true }
    try {
      const config: Dict = await ctx.deps.agentConfig.read(home(ctx)).catch(() => ({}))
      const selected: Record<string, string> = {}
      for (const [k, v] of Object.entries(config)) if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Dict).provider === 'string') selected[k] = str((v as Dict).provider).trim().toLowerCase()
      const result = await sidecar.call('plugins.list', { profile_home: home(ctx), selected_providers: selected })
      // A settings failure leaves the list itself readable.
      const declared = await pluginSettingsList(ctx).catch((error: unknown) => { ctx.deps.log(`[plugins] settings fields failed: ${str((error as Error).message)}`); return [] })
      const settings = new Map(declared.map((entry) => [entry.key, entry.fields]))
      // So does an OAuth status failure.
      const oauth = await pluginOAuthClients(ctx).catch((error: unknown) => { ctx.deps.log(`[plugins] oauth status failed: ${str((error as Error).message)}`); return new Map<string, PluginOAuthClientView[]>() })
      const plugins = result.plugins.map(({ update_available, latest_revision, ...plugin }) => ({
        ...plugin,
        ...(update_available === undefined ? {} : { update: { available: update_available, ...(latest_revision ? { latest_revision } : {}) } }),
        ...(settings.has(plugin.key) ? { settings: settings.get(plugin.key) } : {}),
        ...(oauth.has(plugin.key) ? { oauth_clients: oauth.get(plugin.key) } : {}),
      }))
      // An advisory failure leaves the list itself readable.
      const advisory = await pluginIsolationAdvisory(ctx).catch((error: unknown) => { ctx.deps.log(`[plugins] isolation advisory failed: ${str((error as Error).message)}`); return false })
      return { plugins, empty: plugins.length === 0, supported_hooks: result.supported_hooks, read_only: !editable, plugin_isolation_advisory: advisory }
    } catch (error) {
      ctx.deps.log(`[plugins] visibility payload failed: ${str((error as Error).message)}`)
      return { plugins: [], empty: true, supported_hooks: hooks, read_only: true, unavailable: true }
    }
  })),
  pluginCatalog: os.pluginCatalog.handler(({ input, context: { ctx } }) => run(async () => {
    const result = await runningSidecar(ctx).call('plugins.catalog', { profile_home: home(ctx), ...input })
    const readOnly = !await sessionCanManageServer(ctx, await ensureTrustedAuthSession(ctx))
    return { ...result, read_only: readOnly, entries: result.entries.map((entry) => ({ ...entry, can_install: !readOnly && entry.can_install })) }
  })),
  pluginInstall: os.pluginInstall.handler(({ input, context: { ctx } }) => run(async () => {
    try {
      return await runningSidecar(ctx).call('plugins.install', { profile_home: home(ctx), ...input }, { timeoutMs: 0 })
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'plugin_install_consent_changed') throw new HttpError(409, error.message, { condition: error.condition })
      if (error instanceof SidecarError && error.condition === 'plugin_install_refused') throw new HttpError(409, error.message, { condition: error.condition })
      if (error instanceof SidecarError && error.condition === 'plugin_catalog_unsupported') throw new HttpError(503, error.message, { condition: error.condition })
      if (!definitiveRefusal(error)) throw new HttpError(503, 'Install outcome is unknown. Refresh Plugins to check the installed identity before trying again.', { condition: 'plugin_install_unconfirmed' })
      throw error
    }
  })),
  pluginUpdate: os.pluginUpdate.handler(({ input, context: { ctx } }) => run(async () => {
    try {
      return await runningSidecar(ctx).call('plugins.update', { profile_home: home(ctx), key: input.key, accept_caution: input.accept_caution, ...(input.consent_token ? { consent_token: input.consent_token } : {}) }, { timeoutMs: 0 })
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'plugin_not_found') throw new HttpError(404, error.message)
      if (error instanceof SidecarError && ['plugin_update_refused', 'plugin_update_consent_changed'].includes(error.condition)) throw new HttpError(409, error.message, { condition: error.condition })
      throw error
    }
  })),
  pluginSettings: os.pluginSettings.handler(({ input, context: { ctx } }) => run(() => serializePluginSettingsSave(async () => {
    const sidecar = runningSidecar(ctx)
    const fields = (await pluginSettingsList(ctx)).find((entry) => entry.key === input.key)?.fields
    if (!fields) throw new HttpError(404, `Plugin '${input.key}' declares no settings`)
    let plan
    try {
      plan = planPluginSettings(fields, input.values ?? {}, input.secrets ?? {})
    } catch (error) {
      if (error instanceof PluginSettingsInvalid) throw new HttpError(400, error.message)
      throw error
    }
    const secretFields = fields.filter((field) => field.env && field.env in plan.secrets)
    // Secrets never reach config.yaml: each goes to the profile `.env` under the name the manifest field declares. They are
    // written first and restored if a later write fails, so a refused save changes neither file. The save call always runs:
    // it resolves the plugin again and refuses (before writing) when a secret's `.env` name no longer matches its manifest.
    const credential = (envVar: string, value: string | null) => writeRuntimeCredential({ env: ctx.deps.config.env, sidecar: ctx.deps.sidecar, log: ctx.deps.log }, ctx.deps.isRootProfile(activeProfileName(ctx)), home(ctx), envVar, value)
    const previous = loadEnvFile(join(home(ctx), '.env'))
    const applied: string[] = []
    let result
    try {
      for (const [envVar, value] of Object.entries(plan.secrets)) {
        await credential(envVar, value)
        applied.push(envVar)
      }
      result = await sidecar.call('plugins.settings_save', { profile_home: home(ctx), key: input.key, values: plan.values, secret_envs: Object.fromEntries(secretFields.map((field) => [field.key, field.env!])) })
    } catch (error) {
      if (!definitiveRefusal(error)) {
        throw new HttpError(503, 'The Agent sidecar stopped before confirming the save, so it may be partly applied; reload Settings to see what was saved', { condition: 'plugin_settings_unconfirmed' })
      }
      for (const envVar of applied.reverse()) {
        await credential(envVar, previous[envVar] ?? null).catch((restore: unknown) => { ctx.deps.log(`[plugins] could not restore ${envVar} after a failed settings save: ${str((restore as Error).message)}`) })
      }
      if (error instanceof SidecarError && error.condition === 'plugin_settings_managed') throw new HttpError(403, error.message, { condition: error.condition })
      if (error instanceof SidecarError && error.condition === 'plugin_settings_changed') throw new HttpError(409, `${error.message}; reload and try again`, { condition: error.condition })
      if (error instanceof SidecarError && error.condition === 'plugin_not_found') throw new HttpError(404, error.message)
      if (error instanceof SidecarError && error.code === -32602) throw new HttpError(400, error.message)
      if (error instanceof RuntimeCredentialError) throw new HttpError(503, error.message)
      if (error instanceof EnvWriteError) throw new HttpError(error.status, `Failed to save a secret: ${error.message}`, { condition: error.condition })
      throw error
    }
    return { ok: true as const, key: result.key, runtime_application: result.runtime_application ?? 'restart_required', written: [...result.written, ...secretFields.map((field) => field.key)], settings: pluginSettingsFieldsView(ctx, result.fields) }
  }))),
  pluginOAuthRedirect: os.pluginOAuthRedirect.handler(({ input, context: { ctx } }) => run(async () => {
    // Only this flow's own answer reaches the sidecar: its loopback address and its `state`.
    const verdict = checkPastedRedirect(input.flow_id, home(ctx), input.url)
    if (verdict === 'unknown') throw new HttpError(404, 'Unknown or expired sign-in.', { condition: 'oauth_flow_not_found' })
    if (verdict === 'invalid') throw new HttpError(400, 'That is not the address this sign-in sends the browser back to.', { condition: 'oauth_redirect_invalid' })
    return oauthView(await oauthCall(ctx, 'oauth.submit_redirect', { profile_home: home(ctx), flow_id: input.flow_id, url: input.url }))
  })),
  pluginOAuthLogout: os.pluginOAuthLogout.handler(({ input, context: { ctx } }) => run(async () => {
    try {
      const result = await runningSidecar(ctx).call('plugins.oauth_logout', { profile_home: home(ctx), key: input.key, id: input.id })
      return { ok: true as const, removed: result.removed }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'oauth_unsupported') throw new HttpError(409, error.message, { condition: error.condition })
      return failure(error)
    }
  })),
  updates: {
    check: os.updates.check.handler(({ context: { ctx } }) => run(async () => {
      const settings = (await ctx.deps.settings.load())
      if (settings.check_for_updates === false) return updatesCheckView({ disabled: true }) as never
      return updatesCheckView(ctx.deps.updates.cachedStatus(!pyBool(settings.ignore_agent_updates))) as never
    })),
    checkNow: os.updates.checkNow.handler(({ input, context: { ctx } }) => run(async () => {
      const settings = (await ctx.deps.settings.load())
      const force = pyBool(input.force)
      if (settings.check_for_updates === false && !force) return updatesCheckView({ disabled: true }) as never
      // An explicit body channel wins over a debounced, not-yet-saved setting.
      const channel = isWebChannel(input.channel) ? input.channel : normalizeWebChannel(settings.update_channel)
      ctx.deps.log(`[updates] checking for updates (force=${String(force)}, channel=${channel})`)
      return updatesCheckView(await ctx.deps.updates.check(force, !pyBool(settings.ignore_agent_updates), channel, input.agent_channel)) as never
    })),
    apply: os.updates.apply.handler(({ input, context: { ctx } }) => run(() => applyWithNotification(ctx, input, 'apply'))),
    force: os.updates.force.handler(({ input, context: { ctx } }) => run(() => applyWithNotification(ctx, input, 'force'))),
    clearLock: os.updates.clearLock.handler(({ input, context: { ctx } }) => run(() => applyWithNotification(ctx, input, 'clearLock'))),
    summary: os.updates.summary.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.updates.summarize(input.target, (await ctx.deps.settings.load()).check_for_updates === false) as never)),
  },
  updateNotifications: {
    list: os.updateNotifications.list.handler(({ input, context: { ctx } }) => run(async () => {
      const scope = await updateNotificationScope(ctx, input.tab_id)
      const frontendBuild = (await ctx.deps.updateNotifications.syncTabBuild(scope, input.loaded_build ?? null, ctx.deps.spa.buildId()))
      return { ...(await ctx.deps.updateNotifications.list(scope, frontendBuild.refresh_required)), frontend_build: frontendBuild } as never
    })),
    read: os.updateNotifications.read.handler(({ input, context: { ctx } }) => run(async () => {
      const notification = (await ctx.deps.updateNotifications.read(await updateNotificationScope(ctx, input.tab_id), input.id))
      if (!notification) throw new HttpError(404, 'Update notification not found')
      return notification as never
    })),
    dismiss: os.updateNotifications.dismiss.handler(({ input, context: { ctx } }) => run(async () => {
      const result = (await ctx.deps.updateNotifications.dismiss(await updateNotificationScope(ctx, input.tab_id), input.id))
      if (result === 'acknowledgement_required') throw new HttpError(409, 'This notification requires acknowledgement before it can be dismissed')
      return { ok: true as const }
    })),
    clear: os.updateNotifications.clear.handler(({ input, context: { ctx } }) => run(async () => {
      const scope = await updateNotificationScope(ctx, input.tab_id)
      const frontendBuild = (await ctx.deps.updateNotifications.syncTabBuild(scope, input.loaded_build ?? null, ctx.deps.spa.buildId()))
      return { ...(await ctx.deps.updateNotifications.clear(scope, frontendBuild.refresh_required)), frontend_build: frontendBuild } as never
    })),
    cancel: os.updateNotifications.cancel.handler(({ input, context: { ctx } }) => run(async () => {
      const notification = (await ctx.deps.updateNotifications.cancelUpdate(await updateNotificationScope(ctx), input.id))
      if (!notification) throw new HttpError(404, 'Awaiting update notification not found')
      return notification as never
    })),
    action: os.updateNotifications.action.handler(({ input, context: { ctx } }) => run(async () => {
      const scope = await updateNotificationScope(ctx, input.tab_id)
      // TAL-1274: an auto-prune answer runs the Agent's /autoprune for the profile before the question records it.
      const answer = await ctx.deps.pruneAdvice.answer(scope, input.id, input.action_id, home(ctx))
      if (answer && 'refused' in answer) throw new HttpError(409, answer.refused)
      if (answer) return answer.notification as never
      const notification = (await ctx.deps.updateNotifications.action(scope, input.id, input.action_id))
      if (!notification) throw new HttpError(404, 'Notification action not found')
      if (input.action_id === GATEWAY_RESTART_NOW) ctx.deps.gatewayRestarts.restartNow(notification.id)
      return notification as never
    })),
  },
  transcribeCapability: os.transcribeCapability.handler(({ context: { ctx } }) => run(async () => {
    const unavailable = { ok: true as const, available: false, provider: 'none', streaming: false, warm_supported: false }
    const sidecar = ctx.deps.sidecar()
    if (!sidecar) return unavailable
    try {
      const cap = await sidecar.call('stt.capability', { profile_home: home(ctx) })
      return { ok: true as const, available: cap.available, provider: cap.provider || 'none', streaming: cap.available && cap.streaming, warm_supported: cap.available && cap.warm_supported }
    } catch {
      return unavailable
    }
  })),
  speech: {
    prepare: os.speech.prepare.handler(({ input, context: { ctx } }) => run(async () => ({ spoken_text: await spokenText(ctx, input.text.trim()) }))),
  },
  transcribeWarm: os.transcribeWarm.handler(({ context: { ctx } }) => run(() => {
    const sidecar = ctx.deps.sidecar()
    const profileHome = home(ctx)
    // One load per profile at a time: a record start during a running load joins it rather than holding another sidecar slot.
    if (sidecar && !warmingHomes.has(profileHome)) {
      warmingHomes.add(profileHome)
      // The load outlives this request's write lease: it is the profile's activity until it settles, so the profile
      // cannot be deleted under it. Taken while the request's lease still refuses a deletion in progress.
      const release = ctx.deps.profileActivity(activeProfileName(ctx))
      // A first use downloads the model, and the Agent's load cannot be cancelled, so the call has no deadline: the entry
      // lives exactly as long as the sidecar worker (a sidecar exit rejects it). Nobody waits on it.
      void sidecar.call('stt.warm', { profile_home: profileHome }, { timeoutMs: 0 })
        .then((result) => { if (result.action === 'error') ctx.deps.log(`[stt] warm-up failed (${result.provider}): ${str(result.error)}`) })
        .catch((error: unknown) => { ctx.deps.log(`[stt] warm-up failed: ${str((error as Error).message)}`) })
        .finally(() => { warmingHomes.delete(profileHome); release() })
    }
    return { ok: true as const }
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

const bodyChannel = (raw: unknown): WebChannel | null => (isWebChannel(raw) ? raw : null)
