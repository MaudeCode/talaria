/**
 * Assemble the application dependencies for one state directory. Used by the
 * launcher and by tests, which pass a temp directory and a fixed environment.
 */
import type { PendingSteer } from '@maudecode/talaria-web-contracts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pinnedFetch, systemDnsLookup } from './http/pinned.js'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AuthStore } from './auth/store.js'
import { OidcService } from './auth/oidc.js'
import { PasskeyStore } from './auth/passkeys.js'
import { PresenceLeases, RelayService } from './sessions/relay.js'
import { CliSessionSource } from './sessions/cli-sessions.js'
import { ClaudeCodeSessionSource, claudeCodeProjectsDir } from './sessions/claude-code.js'
import { GatewayWatcherRegistry } from './sessions/gateway-watcher.js'
import { readImportableAgentSessionRows } from './sessions/state-db.js'
import { CompletionDrain } from './sessions/completions.js'
import { BackgroundActivity, BackgroundTaskStore } from './sessions/background-tasks.js'
import { HygieneTicker } from './tools/hygiene.js'
import { McpHealthProber } from './tools/mcp-health.js'
import { loadConfig, truthy, type Env, type LoadConfigOptions } from './config.js'
import type { AppDeps } from './http/context.js'
import { checkoutRevision, detectWebuiVersion, loadReleaseInfo } from './release.js'
import { ghcrExperimental, githubJson, normalizeChannel, purgePycache, UpdateService, waitUntilRestartSafe, type RestartBlockers } from './tools/updates.js'
import { UpdateNotificationStore } from './tools/update-notifications.js'
import { RESTART_EXIT_CODE } from './cli/supervise.js'
import { displayBotName, pyBool, SettingsStore } from './settings.js'
import { AssetCache, SpaShell } from './spa.js'
import { StartupGate } from './startup.js'
import { SessionStore } from './sessions/store.js'
import { DraftStore } from './sessions/drafts.js'
import { SessionEventBus } from './sessions/events.js'
import { ShareStore } from './sessions/shares.js'
import { ensureAgentRuntimeCurrent, HttpFailure, SessionService } from './sessions/service.js'
import { recoveryStampingSince } from './sessions/recovery.js'
import { ProjectStore } from './projects.js'
import { WorkspaceRegistry } from './workspace/workspaces.js'
import { resolvePathLikePython } from './workspace/paths.js'
import type { MediaAccessDeps, MediaPolicyDeps } from './workspace/media.js'
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import type { Session } from './sessions/session.js'
import { GitRunner, GitWorkspaceError, pathsOverlap } from './workspace/git.js'
import { RollbackStore } from './workspace/rollback.js'
import { UploadInbox } from './workspace/upload.js'
import { EscapeGrants } from './workspace/escape.js'
import type { SidecarLike } from './sidecar/client.js'
import { TurnRunner } from './sessions/turn.js'
import { SessionChannels, StreamRegistry } from './sessions/streams.js'
import { PendingPrompts } from './sessions/pending.js'
import { RunJournal } from './sessions/journal.js'
import { StreamSlots } from './api/sse-routes.js'
import { AgentConfig, coerceProviderCostBudgetValue, dict as asDict, parseProviderQualifiedModel } from './config/agent-config.js'
import { ProviderCatalog } from './providers/catalog.js'
import { ProfileService } from './profiles/profiles.js'
import { Onboarding } from './onboarding.js'
import { SkillsService } from './tools/skills.js'
import { McpService } from './tools/mcp.js'
import { WindowLimiter } from './api/tools-router.js'
import { CronService } from './tools/crons.js'
import { KanbanService } from './tools/kanban.js'
import { DashboardPlugins } from './tools/dashboard-plugins.js'
import { ExtensionService } from './tools/extensions.js'
import { dashboardStatus } from './tools/health.js'
import { TerminalRegistry } from './tools/terminal.js'

export interface CreateDepsOptions extends LoadConfigOptions {
  log?: (line: string) => void
  now?: () => number
  version?: string
  home?: string
  /** The Python sidecar (auxiliary completions, worktree creation); null runs without Agent-backed features. */
  sidecar?: SidecarLike | null
  /** Outbound HTTP (TTS proxies, dashboard probe, OpenRouter); tests inject a stub. */
  fetch?: typeof fetch
  /** `node-pty` module override (tests inject a fake); null disables the terminal. */
  pty?: import('./tools/terminal.js').PtyModuleLike | null
  /** Gateway watcher poll interval (tests shorten the 5 s default). */
  gatewayPollMs?: number
  /** Completion drain poll interval (tests shorten the 1 s default). */
  completionPollMs?: number
}

export function packageVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}

export function createDeps(opts: CreateDepsOptions): AppDeps {
  const log = opts.log ?? ((line) => { console.log(line) })
  const config = loadConfig(opts)
  const env: Env = config.env
  mkdirSync(config.stateDir, { recursive: true })
  mkdirSync(config.sessionDir, { recursive: true })
  const settings = new SettingsStore({ file: config.settingsFile, env, stateDir: config.stateDir, defaultWorkspace: config.defaultWorkspace, botName: config.botName, log })
  const now = opts.now ?? (() => Date.now() / 1000)
  const passkeys = new PasskeyStore(config.stateDir, now)
  // Resolved below once the sidecar-backed config store exists; the auth store reads it lazily.
  let oidc: OidcService | null = null
  let operatorConfigPeek: () => Record<string, unknown> | null = () => null
  const auth = new AuthStore({
    stateDir: config.stateDir, env, settings, log, now,
    passkeysEnabled: () => passkeys.available(),
    oidcEnabled: () => oidc?.enabledSync() ?? false,
    oidcAvailable: () => oidc?.availableSync() ?? false,
    oidcProbe: () => oidc?.resolve() ?? Promise.resolve(),
    passkeyConfigFlag: () => { const cfg = operatorConfigPeek(); return cfg === null ? null : cfg.webui_passkey_enabled },
  })
  settings.hooks = {
    hashPassword: (pw) => auth.hashPassword(pw),
    onPasswordChanged: () => { auth.invalidatePasswordHashCache() },
  }
  settings.applyStartupWorkspace()
  config.defaultWorkspace = settings.defaultWorkspace
  const release = loadReleaseInfo({ webRoot: config.webRoot })
  const stampedRelease = loadReleaseInfo({ webRoot: config.webRoot }, { verifyCheckout: false })
  const runningSourceRevision = checkoutRevision(config.webRoot)
  // Container images bake `TALARIA_WEB_VERSION` (Python `api/_version.py`) because .git is not shipped.
  const version = opts.version ?? detectWebuiVersion(release, config.webRoot, (env.TALARIA_WEB_VERSION ?? '').trim() || packageVersion())
  const updateNotifications = new UpdateNotificationStore(config.stateDir, () => new Date(now() * 1000))
  const verifiedRunningVersion = /^web-(?:exp-)?v\d+\.\d+\.\d+$/.test(version) ? version : null
  updateNotifications.reconcileInterruptedUpdates(runningSourceRevision ?? release.sourceRevision, verifiedRunningVersion)
  const home = opts.home ?? config.homeDir
  const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
  // Python `init_profile_state` + `switch_profile(process_wide=False)`: the sticky `~/.hermes/active_profile` is
  // the process default; a request's profile cookie or bound session overrides it for that request only, and
  // `activeProfile()` reads the request scope so every domain (sessions, workspaces, drains) sees the same answer.
  const requestScope = new AsyncLocalStorage<{ requestProfile: string | null }>()
  // Python `_is_isolated_profile_mode`: the explicit startup opt-in AND a `.../profiles/<name>` shaped HERMES_HOME pin
  // the process to that one profile (no switching, listing, creating, deleting, or cross-profile reads).
  const isolatedProfile = truthy(env.HERMES_WEBUI_ISOLATED_PROFILE) && basename(dirname(config.hermesHome)) === 'profiles' && existsSync(dirname(dirname(config.hermesHome))) ? basename(config.hermesHome) : null
  const isolatedProfileMode = (): boolean => isolatedProfile !== null
  const isolatedProfileName = (): string => isolatedProfile ?? 'default'
  // Python `_resolve_base_hermes_home`: profiles live under the base home (HERMES_BASE_HOME, else HERMES_HOME unless it is
  // itself a profile directory, whose grandparent is the base); the pinned home stays authoritative in isolated mode.
  const explicitBase = (env.HERMES_BASE_HOME ?? '').trim()
  const baseHome = isolatedProfile !== null ? config.hermesHome : explicitBase ? resolve(explicitBase.replace(/^~(?=$|\/)/, home)) : basename(dirname(config.hermesHome)) === 'profiles' ? dirname(dirname(config.hermesHome)) : config.hermesHome
  const processProfile = isolatedProfile ?? readActiveProfileFile(baseHome, PROFILE_RE)
  // Isolated mode ignores the request's cookie or bound profile (Python `get_active_profile_name`); the gate refuses a mismatched binding.
  const activeProfile = (): string => isolatedProfile ?? requestScope.getStore()?.requestProfile ?? processProfile
  // Python `_is_root_profile`: `default` plus any renamed root alias the Agent reports; bound to the profile service below.
  let rootAlias: (name: string) => boolean = () => false
  const isRootProfile = (name: string): boolean => name === 'default' || rootAlias(name)
  const profilesMatch = (row: string | null | undefined, active: string | null | undefined): boolean => {
    const r = row ?? 'default'
    const a = active ?? 'default'
    return r === a || (isRootProfile(r) && isRootProfile(a))
  }
  // The agent's name on every client: a named profile's own name, else the root profile's `bot_name` setting.
  const assistantName = (profile: string | null): string => {
    if (profile && !isRootProfile(profile)) return profile.charAt(0).toUpperCase() + profile.slice(1)
    try { return displayBotName(settings.load().bot_name) } catch { return displayBotName(null) }
  }
  // Python `_resolve_profile_home_for_name`: root aliases and invalid names clamp to the base home.
  // Isolated mode never resolves outside the pinned home, whatever name is asked for (Python `_resolve_profile_home_for_name`).
  const profileHome = (name: string): string => (isolatedProfile === null && name && !isRootProfile(name) && PROFILE_RE.test(name) ? join(baseHome, 'profiles', name) : isolatedProfile === null ? baseHome : config.hermesHome)
  const attachmentRoot = (): string => {
    const override = (env.HERMES_WEBUI_ATTACHMENT_DIR ?? '').trim()
    return resolvePathLikePython(override ? override.replace(/^~(?=$|\/)/, home) : join(config.stateDir, 'attachments'))
  }
  const sidecar = opts.sidecar ?? null
  const agentConfig = new AgentConfig({ sidecar: () => sidecar, env })
  /** A profile's config.yaml `model` as [model, provider] as written; '' / null when unset or not yet read. */
  const profileDefaultModel = (profile: string | null): [string, string | null] => {
    const cfg = agentConfig.peek(profileHome(profile ?? activeProfile()))
    if (typeof cfg?.model === 'string') return [cfg.model.trim(), null]
    const { default: d, provider: p } = asDict(cfg?.model)
    return [typeof d === 'string' ? d.trim() : '', typeof p === 'string' && p ? p : null]
  }
  const events = new SessionEventBus(isRootProfile)
  const drafts = new DraftStore(config.sessionDir)
  const registry = new StreamRegistry()
  const activeStreamIds = registry.liveIds
  const runningCronJobs = new Map<string, number>()
  const workspaces = new WorkspaceRegistry({
    stateDir: config.stateDir,
    defaultWorkspace: () => config.defaultWorkspace,
    profileHome,
    activeProfile,
    isRootProfileHome: (h) => resolvePathLikePython(h) === resolvePathLikePython(config.hermesHome),
    profileConfig: (profile) => {
      const cfg = agentConfig.peek(profileHome(profile ?? activeProfile()))
      if (!cfg) return null
      const terminal = asDict(cfg.terminal)
      return { terminal: { ...(typeof terminal.backend === 'string' ? { backend: terminal.backend } : {}), ...(typeof terminal.cwd === 'string' ? { cwd: terminal.cwd } : {}) }, ...(typeof cfg.workspace === 'string' ? { workspace: cfg.workspace } : {}), ...(typeof cfg.default_workspace === 'string' ? { default_workspace: cfg.default_workspace } : {}) }
    },
    home,
  })
  const cacheMax = (): number => {
    const raw = Number.parseInt((env.HERMES_WEBUI_SESSIONS_MAX ?? '').trim(), 10)
    return Number.isFinite(raw) && raw >= 1 ? raw : 100
  }
  const store = new SessionStore({
    sessionDir: config.sessionDir,
    drafts,
    events,
    // Python `_profile_default_model_state`: the profile's own config.yaml model, else the global default. The provider
    // always comes with its model, so a provider-only profile never pairs with another profile's model.
    defaults: (profile) => {
      let [model, provider] = profileDefaultModel(profile)
      if (!model) {
        const s = settings.load()
        model = typeof s.default_model === 'string' ? s.default_model : ''
        provider = model && typeof s.default_model_provider === 'string' && s.default_model_provider ? s.default_model_provider : null
      }
      const [bare, modelProvider] = parseProviderQualifiedModel(model) ?? [model || null, provider]
      return { workspace: workspaces.lastWorkspace(profile), model: bare, modelProvider }
    },
    activeStreamIds: () => activeStreamIds,
    now,
    log,
    cacheMax,
    onDeleted: (sid) => { backgroundStore.evict(sid) },
  })
  const projects = new ProjectStore(resolve(config.stateDir, 'projects.json'), () => store.readIndexEntries(), isRootProfile)
  const shares = new ShareStore(resolve(config.stateDir, 'shares'), now)
  const yoloSessions = new Set<string>()
  const attachmentDir = (sid: string): string => join(attachmentRoot(), (sid || 'session').replace(/[^\w.-]/g, '_').slice(0, 120))
  const cliSessions = new CliSessionSource({ store, profileHome, lastWorkspace: (p) => workspaces.lastWorkspace(p), backgroundProjectId: (kind, p) => projects.ensureSystemProject(kind, p, { create: kind === 'webhook' || projects.hasUserProjects(p) }), now, log })
  const gatewayWatchers = new GatewayWatcherRegistry({ profileHome, now, log, ...(opts.gatewayPollMs !== undefined ? { pollIntervalMs: opts.gatewayPollMs } : {}) })
  const journal = new RunJournal(config.sessionDir, env)
  const contextLengths = new Map<string, number | null>()
  const contextInflight = new Map<string, Promise<number | null>>()
  const contextKey = (model: string | null, provider: string | null, profile: string | null): string | null => (model?.trim() ? `${profileHome(profile ?? activeProfile())}\0${provider?.trim() ?? ''}\0${model.trim()}` : null)
  const resolveContextLength = async (model: string | null, provider: string | null, profile: string | null): Promise<number | null> => {
    const key = contextKey(model, provider, profile)
    if (!key || !sidecar) return null
    const hit = contextLengths.get(key)
    if (hit !== undefined) return hit
    const pending = contextInflight.get(key)
    if (pending) return pending
    const home = profileHome(profile ?? activeProfile())
    const run = catalog.contextLengthInputs(home, model!.trim(), provider?.trim() || null)
      .then((inputs) => sidecar.call('models.context_length', { profile_home: home, model: model!.trim(), ...(provider?.trim() ? { provider: provider.trim() } : {}), ...inputs }))
      .then((r) => { contextLengths.set(key, r.context_length); return r.context_length })
      .catch((error: unknown) => { log(`[webui] context length for ${model ?? ''} failed: ${(error as Error).message}`); return null })
      .finally(() => { contextInflight.delete(key) })
    contextInflight.set(key, run)
    return run
  }
  /** Detached sidecar work per profile (memory commits, manual compression) that deletion has to wait out like a live run. */
  const profileOps = new Map<string, number>()
  const profileActivity = (profile: string | null): (() => void) => {
    const key = profile ?? 'default'
    profileOps.set(key, (profileOps.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (profileOps.get(key) ?? 1) - 1
      if (n > 0) profileOps.set(key, n); else profileOps.delete(key)
    }
  }
  const mediaActiveWorkspace = (): string | null => {
    if (!workspaces.profileSupportsLocalIo(null)) return null
    try {
      const ws = resolvePathLikePython(workspaces.lastWorkspace(activeProfile()))
      return statSync(ws).isDirectory() ? ws : null
    } catch {
      return null
    }
  }
  const snapshotDir = (): string => {
    const override = (env.HERMES_WEBUI_MEDIA_SNAPSHOT_DIR ?? '').trim()
    return override ? override.replace(/^~(?=$|\/)/, home) : join(config.stateDir, 'media_snapshots')
  }
  const mediaPolicy: MediaPolicyDeps = { home, hermesHome: config.hermesHome, stateDir: config.stateDir, snapshotDir, activeWorkspace: mediaActiveWorkspace }
  const mediaAccess: MediaAccessDeps = { home: config.homeDir, hermesHome: config.hermesHome, extraRoots: env.MEDIA_ALLOWED_ROOTS ?? '', activeWorkspace: mediaActiveWorkspace, policy: mediaPolicy }
  // TAL-259: record when this server started stamping deliberate shrinks; older backups go to manual review.
  try { recoveryStampingSince(config.stateDir) } catch (error) { log(`[webui] WARNING: could not record recovery_stamping_since: ${(error as Error).message}`) }
  const sessions = new SessionService({
    recoveryStampingSince: () => recoveryStampingSince(config.stateDir),
    sidecar: () => sidecar,
    media: { access: mediaAccess, localIo: (profile) => workspaces.profileSupportsLocalIo(profile) },
    profileActivity,
    profileDeleting: (profile) => profiles.isDeleting(profile),
    backgroundReceipts: (sid) => background.receipts(sid),
    journal,
    clearRelayCompletions: (sid, profile) => { relay.clearDeleted(sid, profile) },
    store,
    cliSessions: (profile, o) => cliSessions.read(profile, o),
    claudeCode: new ClaudeCodeSessionSource(() => claudeCodeProjectsDir(env, home)),
    profileHome,
    // The commit runs detached from the request, so it is registered as profile activity until it settles: profile
    // deletion must not remove the memory files the cached Agent is still writing.
    commitSessionMemory: (sid) => {
      if (!sidecar) return
      let profile: string | null = null
      try { profile = store.get(sid, { metadataOnly: true }).profile ?? null } catch { profile = null }
      const release = profileActivity(profile)
      void sidecar.call('chat.commit_memory', { profile_home: profileHome(profile ?? activeProfile()), session_id: sid })
        .catch((error: unknown) => { log(`[webui] memory commit for ${sid} failed: ${(error as Error).message}`) })
        .finally(release)
    },
    drafts,
    events,
    workspaces,
    projects,
    shares,
    now,
    log,
    activeProfile,
    isolatedProfileMode,
    profilesMatch,
    assistantName,
    redactEnabled: () => { try { return settings.load().api_redact_enabled !== false } catch { return true } },
    pinnedSessionsLimit: () => { const v = settings.load().pinned_sessions_limit; return typeof v === 'number' && v >= 1 ? v : 3 },
    // Chat runtime (checkpoint 6) replaces these with live stream and cron state.
    runtime: {
      activeStreamIds,
      runningCronJobs,
      live: (sid): Session | undefined => (registry.activeRunStreamForSession(sid) ? store.sessions.get(sid) : undefined),
      // Python `_session_attention_summary`: approvals outrank clarify prompts.
      attention: (sid) => {
        const approvals = pending.approvalPending(sid).pending_count
        if (approvals > 0) return { kind: 'approval', count: approvals, severity: 'critical' }
        const clarifies = pending.clarifyPending(sid).pending_count
        if (clarifies > 0) return { kind: 'clarify', count: clarifies, severity: 'question' }
        return null
      },
      activeRunStream: (sid) => registry.activeRunStreamForSession(sid),
      journalDegraded: (streamId) => registry.degradedJournals.has(streamId),
      pendingSteers: (streamId: string): PendingSteer[] => turns.pendingSteers(streamId),
      evictAgent: (sid, endSession) => { if (sidecar) sidecar.call('chat.evict_agent', endSession ? { session_id: sid, clear_session: true } : { session_id: sid }).catch(() => undefined) },
      closeTerminal: (sid) => { deps.terminals.close(sid) },
      deleteCliSession: async (profile, sid) => {
        if (!sidecar) return false
        return (await sidecar.call('state_db.delete_cli_session', { profile_home: profileHome(profile ?? activeProfile()), session_id: sid })).ok
      },
    },
    attachmentDir,
    hermesHome: config.hermesHome,
    home,
    // Python `_sync_session_title_to_state_db`: with `sync_to_insights` on, the state.db row follows a rename.
    syncTitle: async (session, manual) => {
      if (!sidecar || !pyBool(settings.load().sync_to_insights)) return
      // Awaited by callers: the rename/regenerate response and the title stream's teardown follow the state.db write.
      try {
        await sidecar.call('state_db.sync_title', { profile_home: profileHome(session.profile ?? activeProfile()), session_id: session.session_id, title: session.title, manual: manual === true })
      } catch (error) {
        log(`[webui] state.db title sync failed for ${session.session_id}: ${(error as Error).message}`)
      }
    },
    // Python `_resolve_model_context_length`: the sidecar's authoritative value per model/provider, cached; a sync miss
    // starts the lookup in the background so the next read (detail load, composer gauge) has it.
    contextLengthFor: (model, provider) => {
      const key = contextKey(model, provider, null)
      if (!key) return null
      const hit = contextLengths.get(key)
      if (hit !== undefined) return hit
      void resolveContextLength(model, provider, activeProfile())
      return null
    },
    resolveContextLength,
    modelOptionFor: (model, provider) => catalog.modelOptionFor(profileHome(activeProfile()), model, provider),
    warmModelOptions: () => catalog.warmModelOptions(profileHome(activeProfile())),
    // Python `_session_model_state_from_request`: a provider-qualified id (`@nous:openai/gpt-5.4-mini`) is split so the
    // sidecar receives the bare model and the explicit provider wins over the requested one.
    modelStateFromRequest: (model, requestedProvider, currentProvider) => {
      const raw = typeof model === 'string' ? model.trim() : ''
      let provider = typeof requestedProvider === 'string' && requestedProvider.trim() ? requestedProvider.trim() : null
      if (!raw) return [null, provider]
      const parsed = parseProviderQualifiedModel(raw)
      if (parsed) return [parsed[0], parsed[1]]
      if (requestedProvider === undefined && !provider) provider = currentProvider
      return [raw, provider]
    },
    repairSessionModel: (profile, model, provider) => catalog.sessionModelRepair(profileHome(profile ?? activeProfile()), model, provider),
    warmSessionModelRepair: (profile) => catalog.warmSessionModelRepair(profileHome(profile ?? activeProfile())),
    yolo: { isEnabled: (sid) => yoloSessions.has(sid), set: (sid, enabled) => { if (enabled) yoloSessions.add(sid); else yoloSessions.delete(sid) } },
  })
  // A working-tree mutation refuses while a run is active anywhere it would change files.
  const git = new GitRunner({ env, activeRunIn: (path) => [...registry.activeRuns.values()].some((run) => Boolean(run.workspace) && pathsOverlap(run.workspace, path)) })
  const rollback = new RollbackStore({ hermesHome: () => profileHome(activeProfile()), knownWorkspaces: () => workspaces.load(activeProfile()).map((w) => w.path) })
  const uploads = new UploadInbox(attachmentRoot)
  const channels = new SessionChannels()
  const pending = new PendingPrompts(events, now)
  // TAL-372: one durable record per piece of background work; a change refreshes every client showing the session.
  const backgroundStore = new BackgroundTaskStore(config.sessionDir, now, (sid) => {
    let profile: string | null = null
    try { profile = store.get(sid, { metadataOnly: true, promote: false, cacheOnMiss: false }).profile } catch { profile = null }
    events.publish('background_task', { profile, sessionId: sid })
  })
  const background = new BackgroundActivity({ store: backgroundStore, sidecar: () => sidecar, profileHome: (p) => profileHome(p ?? activeProfile()), liveStream: (id) => registry.liveIds.has(id), now, log })
  // Python `_MAX_SSE_CLIENTS_PER_IDENTITY`: eight concurrent streams per client identity unless overridden.
  const streamSlots = new StreamSlots(() => { const raw = Number.parseInt((env.HERMES_WEBUI_MAX_SSE_CLIENTS ?? '').trim(), 10); return Number.isFinite(raw) && raw > 0 ? raw : 8 })
  // eslint-disable-next-line prefer-const -- assigned after the turn runner exists
  let completions: CompletionDrain
  const relay = new RelayService({
    registry, pending, store, presence: new PresenceLeases(now), profileHome, profilesMatch, fetch: () => lazyFetch, now, log,
    agentSessions: (profile) => readImportableAgentSessionRows(join(profileHome(profile), 'state.db')),
    stateDir: config.stateDir, env, canonicalProfile: (p) => (isRootProfile(p) ? 'default' : p), addListener: (listener) => events.addListener(listener),
  })
  const turns = new TurnRunner({
    store,
    service: () => sessions,
    events,
    onTerminal: (streamId, phase) => { relay.noteTerminal(streamId, phase) },
    onTurnEnd: (sessionId) => { void completions.drainDeferred(sessionId) },
    profileDeleting: (profile) => profiles.isDeleting(profile),
    updateInProgress: () => deps.updates.blocksNewWork(),
    workspaceBusy: (workspace) => deps.git.workspaceBusy(workspace),
    syncTitle: (session) => sessions.deps.syncTitle(session),
    // Python `sync_session_usage` after a settled turn: with `sync_to_insights` on, the state.db row carries the usage.
    syncUsage: async (session, model) => {
      if (!sidecar || !pyBool(settings.load().sync_to_insights)) return
      try {
        await sidecar.call('state_db.sync_usage', {
          profile_home: profileHome(session.profile ?? activeProfile()), session_id: session.session_id,
          input_tokens: session.input_tokens || 0, output_tokens: session.output_tokens || 0, estimated_cost: typeof session.estimated_cost === 'number' ? session.estimated_cost : null,
          cache_read_tokens: session.cache_read_tokens || 0, cache_write_tokens: session.cache_write_tokens || 0,
          model, title: session.title, message_count: session.messages.length,
        })
      } catch (error) {
        log(`[webui] state.db usage sync failed for ${session.session_id}: ${(error as Error).message}`)
      }
    },
    profileConfig: async (profile) => { try { return await agentConfig.read(profileHome(profile ?? activeProfile())) } catch { return null } },
    env,
    hermesHome: config.hermesHome,
    // Python `display_hermes_home`: the home shown to the model, `~`-relative when it sits under $HOME.
    homeDisplay: () => (config.hermesHome.startsWith(`${home}/`) ? `~${config.hermesHome.slice(home.length)}` : config.hermesHome),
    registry,
    channels,
    pending,
    journal,
    sidecar: () => sidecar,
    profileHome: (profile) => profileHome(profile ?? activeProfile()),
    workspaces,
    now,
    log,
    redactEnabled: () => { try { return settings.load().api_redact_enabled !== false } catch { return true } },
    saveMode: () => ((env.HERMES_WEBUI_SESSION_SAVE_MODE ?? '').trim().toLowerCase() === 'eager' ? 'eager' : 'deferred'),
    toolsetsFor: (session) => session.enabled_toolsets,
    attachmentDir,
  })
  // Services read `deps.fetch` lazily so tests can swap the outbound HTTP client after boot.
  const lazyFetch: typeof fetch = (input, init) => deps.fetch(input, init)
  const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: agentConfig, env, now, log, costBudget: () => coerceProviderCostBudgetValue(settings.load().provider_cost_budget), quotaThresholds: (profile) => settings.quotaThresholds(profile), isRootProfileHome: (h) => resolvePathLikePython(h) === resolvePathLikePython(config.hermesHome), stateDir: config.stateDir })
  const agentStatus = () => {
    const describe = sidecar?.describe ?? null
    const found = Boolean(describe?.agent_dir)
    const importsOk = Boolean(describe && describe.compatible && !describe.import_error)
    return { found, importsOk, missing: [] as string[], errors: describe?.import_error ? { agent: describe.import_error } : {} }
  }
  const profiles = new ProfileService({
    sidecar: () => sidecar,
    baseHome,
    profileHome,
    isolatedProfileMode,
    isolatedProfileName,
    config: agentConfig,
    defaultWorkspace: (profile) => workspaces.profileDefaultWorkspace(profile),
    models: (h) => catalog.models(h),
    streamsActive: () => activeStreamIds.size > 0,
    profileRunsActive: (name) => {
      // Admission (`activeRuns`) is released before the post-turn title work, but the stream stays live until
      // teardown: both count, so a profile is never deleted while its sidecar work is still in flight.
      const sessionIds = new Set<string>()
      for (const run of registry.activeRuns.values()) sessionIds.add(run.session_id)
      for (const streamId of registry.liveIds) { const owner = registry.ownerSessionId(streamId); if (owner) sessionIds.add(owner) }
      for (const sessionId of sessionIds) {
        let profile: string | null = null
        try { profile = store.get(sessionId, { metadataOnly: true }).profile ?? null } catch { continue }
        if (profiles.isRootProfile(profile ?? 'default') ? profiles.isRootProfile(name) : profile === name) return true
      }
      for (const [profile, count] of profileOps) if (count > 0 && (profiles.isRootProfile(profile) ? profiles.isRootProfile(name) : profile === name)) return true
      return false
    },
    tombstoneFile: join(config.stateDir, 'deleted-profiles.json'),
    log,
  }, now)
  rootAlias = (name) => profiles.isRootProfile(name)
  const onboarding = new Onboarding({
    settings,
    config: agentConfig,
    env,
    profileHome: () => profileHome(activeProfile()),
    isRootProfileHome: (h) => resolvePathLikePython(h) === resolvePathLikePython(config.hermesHome),
    sidecar: () => sidecar,
    agentStatus,
    isAuthEnabled: () => auth.isAuthEnabled(),
    workspaces: () => ({ items: workspaces.load(activeProfile()), last: workspaces.lastWorkspace(activeProfile()) }),
    models: (h) => catalog.models(h),
    defaultWorkspace: () => config.defaultWorkspace,
    defaultModel: () => (env.HERMES_WEBUI_DEFAULT_MODEL ?? '').trim(),
    log,
  })
  oidc = new OidcService({ env, operatorConfig: () => agentConfig.read(baseHome), profileHome, fetch: () => lazyFetch, pinned: () => ({ lookup: deps.dnsLookup, fetch: deps.pinnedFetch }), now, log })
  operatorConfigPeek = () => agentConfig.peek(config.hermesHome)
  settings.hooks.defaultModel = () => profileDefaultModel(null)[0]
  settings.hooks.defaultModelProvider = () => profileDefaultModel(null)[1] ?? undefined
  const terminals = new TerminalRegistry({ env, now: () => Date.now(), log, ...(opts.pty !== undefined ? { pty: opts.pty } : {}) })
  // Python `_handle_file_open_vscode` / `_handle_file_reveal`: `vscode.command`, `vscode.container_path_prefix` and
  // `vscode.host_path_prefix` from the active profile's config.yaml (Docker host/container path translation).
  const vscode = () => {
    const cfg = asDict(agentConfig.peek(profileHome(activeProfile()))?.vscode)
    const configuredCommand = (typeof cfg.command === 'string' && cfg.command.trim()) || 'code'
    const containerPrefix = typeof cfg.container_path_prefix === 'string' ? cfg.container_path_prefix : ''
    const hostPrefix = typeof cfg.host_path_prefix === 'string' ? cfg.host_path_prefix : ''
    const executable = (p: string): boolean => { try { accessSync(p, fsConstants.X_OK); return statSync(p).isFile() } catch { return false } }
    return {
      configuredCommand,
      command: (): string | null => {
        // `shutil.which`: an absolute or relative command is checked as-is, a bare name is searched on PATH.
        if (configuredCommand.includes('/')) return executable(configuredCommand) ? configuredCommand : null
        for (const dir of (env.PATH ?? '').split(delimiter)) if (dir && executable(join(dir, configuredCommand))) return join(dir, configuredCommand)
        const local = env.LOCALAPPDATA ?? ''
        const fallbacks = ['/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/bin/code', '/snap/bin/code',
          local ? join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : '', join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft VS Code', 'bin', 'code.cmd'), join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft VS Code', 'bin', 'code.cmd')]
        for (const fb of fallbacks) if (fb && existsSync(fb)) return fb
        return null
      },
      translate: (path: string): string => {
        if (!containerPrefix || !hostPrefix) return path
        const norm = `${containerPrefix.replace(/\/+$/, '')}/`
        return path.startsWith(norm) || path === containerPrefix.replace(/\/+$/, '') ? hostPrefix + path.slice(containerPrefix.length) : path
      },
    }
  }
  completions = new CompletionDrain({ sidecar: () => sidecar, baseHome, profileHome: (p) => profileHome(p ?? activeProfile()), activeProfile, store, channels, registry, startTurn: async (session, prompt) => {
    // TAL-577: a wakeup passes the user-turn admission; a stale runtime answers a retryable 409, which defers it on a retry timer.
    // TAL-542: its model repair reads the cached catalog only (Python `prefer_cached_catalog`), never waiting on a build.
    try {
      await ensureAgentRuntimeCurrent(sidecar)
      const workspace = sessions.turnWorkspace(session)
      const [model, modelProvider] = sessions.turnModel(session)
      return turns.start(session, { msg: prompt, attachments: [], workspace, model, modelProvider, source: 'process_wakeup' })
    } catch (error) {
      if (error instanceof HttpFailure) return { _status: error.status, error: error.message, retryable: error.extra.retryable === true }
      throw error
    }
  }, background, now, log, ...(opts.completionPollMs !== undefined ? { pollMs: opts.completionPollMs } : {}) })
  const mcpHealth = new McpHealthProber({ fetch: () => lazyFetch, now, log })
  // Dashboard reachability is probed in the background (Python `dashboard_probe.get_dashboard_status`), never per request.
  let dashboardRunning = false
  let dashboardCheckedAt = 0
  const refreshDashboard = (): void => {
    const at = now()
    if (at - dashboardCheckedAt < 30) return
    dashboardCheckedAt = at
    agentConfig.read(profileHome(activeProfile())).then((cfg) => dashboardStatus(cfg, env, lazyFetch)).then((status) => { dashboardRunning = status.running === true }).catch(() => { dashboardRunning = false })
  }
  const extensionsEnabled = (): boolean => { try { return deps.extensions.enabledSync() } catch { return false } }
  const deps: AppDeps = {
    config,
    settings,
    auth,
    startup: new StartupGate(),
    spa: new SpaShell(config.distRoot),
    staticFiles: new AssetCache(config.staticRoot),
    release,
    version,
    startedAt: now(),
    log,
    stats: { requestsTotal: 0, lastRequestAt: 0 },
    // Python bootstrap `features`: live dashboard, remote terminal backend, extensions enabled, isolated mode.
    features: () => { refreshDashboard(); return { dashboard: dashboardRunning, terminal_remote_backend: !workspaces.profileSupportsLocalIo(activeProfile()), extensions: extensionsEnabled(), single_profile_mode: isolatedProfileMode() } },
    activeProfile,
    requestScope,
    isRootProfile,
    assistantName,
    onboardingCompleted: () => truthy(env.HERMES_WEBUI_SKIP_ONBOARDING) || Boolean(settings.load().onboarding_completed),
    health: () => ({ sessions: store.sessions.size, activeStreams: activeStreamIds.size, activeRuns: registry.activeRuns.size, runs: [...registry.activeRuns.values()].map((r) => ({ phase: r.phase, started_at: r.started_at })), lastRunFinishedAt: registry.lastRunFinishedAt }),
    sessions,
    sessionStore: store,
    events,
    projects,
    workspaces,
    isolatedProfileMode,
    profilesMatch,
    // Python `_worktree_default_from_config`: only a real YAML `true` opts a profile's new sessions into worktrees.
    worktreeDefault: (profile) => agentConfig.peek(profileHome(profile ?? activeProfile()))?.worktree === true,
    worktrees: {
      create: async (workspace) => {
        if (!sidecar) throw new Error('Hermes Agent worktree helper is unavailable')
        const result = await sidecar.call('worktree.create', { profile_home: profileHome(activeProfile()), repo_root: workspace })
        return { path: result.path, branch: result.branch, repo_root: result.repo_root, created_at: now() }
      },
    },
    vscode,
    git,
    rollback,
    uploads,
    escapeGrants: new EscapeGrants(now),
    mediaPolicy,
    mediaAccess,
    worktreeLocks: { lockedByStream: (s) => Boolean(s.active_stream_id && activeStreamIds.has(s.active_stream_id)), lockedByTerminal: (sid, worktreePath) => { const term = deps.terminals.get(sid); return Boolean(term?.isAlive) && resolvePathLikePython(term?.workspace ?? '') === resolvePathLikePython(worktreePath) } },
    sidecar: () => sidecar,
    turns,
    registry,
    channels,
    pending,
    journal,
    background,
    streamSlots,
    profileHome,
    agentConfig,
    catalog,
    profiles,
    onboarding,
    agentVersion: () => sidecar?.describe?.agent_version ?? sidecar?.describe?.pinned_version ?? release.compatibleAgent.version,
    cliSessions,
    gatewayWatchers,
    relay,
    oidc,
    passkeys,
    nativeOidcLimiter: new WindowLimiter(60, 10, now),
    clearPasskeys: () => { passkeys.clear() },
    skills: new SkillsService({ sidecar: () => sidecar, config: agentConfig, log }),
    mcp: new McpService({ sidecar: () => sidecar, config: agentConfig, health: mcpHealth }),
    completions,
    hygiene: new HygieneTicker({ env, stateDir: config.stateDir, port: () => config.port, journal, activeJournalPaths: () => turns.activeJournalPaths(), now, log, sweeps: [() => { completions.sweep() }] }),
    mcpHealth,
    nowSeconds: now,
    // Python `_webui_runtime_payload`: the four owner sections with their `available` flags.
    runtimeDiagnostics: () => {
      const channels = [...registry.streams.values()].map((c) => c.diagnosticSnapshot())
      const sum = (key: string): number => channels.reduce((n, c) => n + (c[key] ?? 0), 0)
      const catalogStats = catalog.diagnosticSnapshot()
      return {
        sessions: { available: true, resident: store.sessions.size, cap: cacheMax() },
        streams: { available: true, active: activeStreamIds.size, agent_instances: registry.activeRuns.size, subscribers: sum('subscriber_count'), offline_buffered_events: sum('offline_buffered_events'), offline_dropped_events: sum('offline_dropped_events'), subscriber_dropped_events: sum('subscriber_dropped_events'), unavailable_channels: 0 },
        // The list is projected per request (no resident cache), which Python reported as an unavailable owner.
        session_list_cache: { available: false, entries: 0, inflight_rebuilds: 0, cap: 0 },
        models_cache: { available: true, groups: catalogStats.groups, models: catalogStats.models, age_seconds: catalogStats.age_seconds },
      }
    },
    requestShutdown: () => { setTimeout(() => { process.kill(process.pid, 'SIGINT') }, 300).unref() },
    // Embedded shells are separate process groups that would outlive the worker: terminate and reap them on both exits.
    // A running retention sweep stops before the exit, like on shutdown.
    requestRestart: () => { void waitUntilRestartSafe(restartBlockers, { log }).then(() => deps.hygiene.stop()).then(() => auth.flushPersistence()).then(() => { deps.terminals.closeAll({ immediate: true }); purgeAgentPycache(); process.exit(RESTART_EXIT_CODE) }) },
    updates: null as unknown as UpdateService,
    updateNotifications,
    cspLimiter: new WindowLimiter(60, 100, now),
    clientEventLimiter: new WindowLimiter(60, 30, now),
    ttsLimiter: new WindowLimiter(2, 1, now),
    fetch: opts.fetch ?? fetch,
    dnsLookup: systemDnsLookup,
    pinnedFetch,
    crons: new CronService({
      sidecar: () => sidecar,
      profileHome,
      profileNames: async () => (await profiles.list('default')).map((r) => ({ name: String(r.name), visible: r.visible !== false })),
      profilesMatch,
      isolatedProfileMode,
      log,
      publishSessionsChanged: (reason, profile) => { events.publish(reason, { profile }) },
      runningJobs: runningCronJobs,
      modelOptionFor: async (home, model, provider) => { await catalog.warmModelOptions(home); return catalog.modelOptionFor(home, model, provider) },
    }),
    kanban: new KanbanService({ sidecar: () => sidecar, config: agentConfig }),
    extensions: new ExtensionService({ env, stateDir: config.stateDir, isAuthEnabled: () => auth.isAuthEnabled(), fetch: lazyFetch, log }),
    dashboardPlugins: new DashboardPlugins({ env, hermesHome: config.hermesHome, settings: () => settings.load() }),
    terminals,
    commitMessage: async (session, systemPrompt, userPrompt) => {
      if (!sidecar) throw new GitWorkspaceError('Commit message generation needs the Agent sidecar, which is not running', 'aux_unavailable')
      // Python `_llm_git_commit_message`: the session's main model is the auxiliary client's `main_runtime`, and the
      // main model itself answers (through AIAgent) when no auxiliary client is configured or the call fails.
      const result = await sidecar.call('aux.complete', {
        profile_home: profileHome(session.profile ?? activeProfile()), task: 'compression',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        main_runtime: { model: session.model ?? '', provider: session.model_provider ?? null }, main_fallback: true,
      })
      return result.text
    },
  }
  const restartBlockers = (): RestartBlockers => {
    const streams = [...activeStreamIds].map(String)
    const runs = [...registry.activeRuns.keys()].map(String)
    const terminals = [...deps.terminals.terminals.values()].filter((term) => term.isAlive).length
    const crons = runningCronJobs.size
    return { active_streams: streams.length, active_runs: runs.length, active_terminals: terminals, active_cron_jobs: crons, blocking_stream_ids: streams.slice(0, 10), blocking_run_ids: runs.slice(0, 10), restart_blocked: streams.length > 0 || runs.length > 0 || terminals > 0 || crons > 0 }
  }
  const purgeAgentPycache = (): void => { const dir = sidecar?.describe?.agent_dir; if (dir) purgePycache(dir) }
  deps.updates = new UpdateService({
    webRoot: config.webRoot,
    getJson: githubJson(lazyFetch, env),
    experimental: ghcrExperimental(lazyFetch),
    stateDir: config.stateDir,
    identity: { release: () => release, stamped: () => stampedRelease, runningSourceRevision: () => runningSourceRevision },
    webuiVersion: version,
    // Describe again only while HEAD is still the running revision; a pending restart keeps the running label.
    refreshWebuiVersion: () => {
      if (!opts.version && runningSourceRevision && checkoutRevision(config.webRoot) === runningSourceRevision) deps.version = detectWebuiVersion(release, config.webRoot, (env.TALARIA_WEB_VERSION ?? '').trim() || packageVersion())
      return deps.version
    },
    agentDir: () => sidecar?.describe?.agent_dir ?? null,
    channel: () => normalizeChannel(settings.load().update_channel),
    agentChannel: () => normalizeChannel(settings.load().agent_update_channel),
    includeAgent: () => !pyBool(settings.load().ignore_agent_updates),
    autoApply: () => settings.load().check_for_updates !== false && settings.load().auto_apply_updates === true,
    checkEnabled: () => !truthy(env.HERMES_WEBUI_TEST_NETWORK_BLOCK) && settings.load().check_for_updates !== false,
    autoNotification: {
      begin: () => updateNotifications.begin({ owner: '*', profile: 'default', serverOwner: true }, 'webui').id,
      transition: (id, phase, expectedIdentity, verifiedIdentity, detail) => { updateNotifications.transition(id, phase, expectedIdentity, verifiedIdentity, detail) },
    },
    blockers: restartBlockers,
    scheduleRestart: () => { setTimeout(() => { void waitUntilRestartSafe(restartBlockers, { maxWaitMs: Infinity, log }).then(() => { deps.requestRestart() }) }, 2000).unref() },
    gatewayRestart: async () => {
      if (!sidecar) throw new Error('Hermes Agent sidecar is unavailable')
      return sidecar.call('gateway.restart', { profile_home: profileHome(activeProfile()) }, { timeoutMs: 300_000 })
    },
    llm: async (system, user) => {
      if (!sidecar || !pyBool(settings.load().whats_new_summary_enabled)) return ''
      const result = await sidecar.call('aux.complete', { profile_home: profileHome(activeProfile()), task: 'update_summary', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
      return result.text
    },
    log,
  })

  return deps
}

/** Python `_read_active_profile_file`: the sticky profile name, or `default` when absent, unreadable, or malformed. */
function readActiveProfileFile(hermesHome: string, pattern: RegExp): string {
  try {
    const name = readFileSync(join(hermesHome, 'active_profile'), 'utf8').trim()
    return name && pattern.test(name) ? name : 'default'
  } catch {
    return 'default'
  }
}
