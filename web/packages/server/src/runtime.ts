/**
 * Assemble the application dependencies for one state directory. Used by the
 * launcher and by tests, which pass a temp directory and a fixed environment.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AuthStore } from './auth/store.js'
import { OidcService } from './auth/oidc.js'
import { PasskeyStore } from './auth/passkeys.js'
import { PresenceLeases, RelayService } from './sessions/relay.js'
import { CliSessionSource } from './sessions/cli-sessions.js'
import { GatewayWatcherRegistry } from './sessions/gateway-watcher.js'
import { CompletionDrain } from './sessions/completions.js'
import { HygieneTicker } from './tools/hygiene.js'
import { McpHealthProber } from './tools/mcp-health.js'
import { loadConfig, truthy, type Env, type LoadConfigOptions } from './config.js'
import type { AppDeps } from './http/context.js'
import { checkoutRevision, detectWebuiVersion, loadReleaseInfo } from './release.js'
import { githubJson, normalizeChannel, purgePycache, UpdateService, waitUntilRestartSafe, type RestartBlockers } from './tools/updates.js'
import { RESTART_EXIT_CODE } from './cli/supervise.js'
import { pyBool, SettingsStore } from './settings.js'
import { AssetCache, SpaShell } from './spa.js'
import { StartupGate } from './startup.js'
import { SessionStore } from './sessions/store.js'
import { DraftStore } from './sessions/drafts.js'
import { SessionEventBus } from './sessions/events.js'
import { ShareStore } from './sessions/shares.js'
import { SessionService } from './sessions/service.js'
import { ProjectStore } from './projects.js'
import { WorkspaceRegistry } from './workspace/workspaces.js'
import { resolvePathLikePython } from './workspace/paths.js'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Session } from './sessions/session.js'
import { GitRunner, GitWorkspaceError } from './workspace/git.js'
import { RollbackStore } from './workspace/rollback.js'
import { UploadInbox } from './workspace/upload.js'
import type { SidecarLike } from './sidecar/client.js'
import { TurnRunner } from './sessions/turn.js'
import { SessionChannels, StreamRegistry } from './sessions/streams.js'
import { PendingPrompts } from './sessions/pending.js'
import { RunJournal } from './sessions/journal.js'
import { BackgroundTasks } from './api/chat-router.js'
import { StreamSlots } from './api/sse-routes.js'
import { AgentConfig, coerceProviderCostBudgetValue, dict as asDict } from './config/agent-config.js'
import { ProviderCatalog } from './providers/catalog.js'
import { ProfileService } from './profiles/profiles.js'
import { Onboarding } from './onboarding.js'
import { SkillsService } from './tools/skills.js'
import { McpService } from './tools/mcp.js'
import { WindowLimiter } from './api/tools-router.js'
import { CronService } from './tools/crons.js'
import { KanbanService } from './tools/kanban.js'
import { ExtensionService } from './tools/extensions.js'
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
    oidcProbe: () => oidc?.resolve() ?? Promise.resolve(),
    passkeyConfigFlag: () => operatorConfigPeek()?.webui_passkey_enabled,
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
  const processProfile = isolatedProfile ?? readActiveProfileFile(config.hermesHome, PROFILE_RE)
  const activeProfile = (): string => requestScope.getStore()?.requestProfile ?? processProfile
  // Python `_is_root_profile`: `default` plus any renamed root alias the Agent reports; bound to the profile service below.
  let rootAlias: (name: string) => boolean = () => false
  const isRootProfile = (name: string): boolean => name === 'default' || rootAlias(name)
  const profilesMatch = (row: string | null | undefined, active: string | null | undefined): boolean => {
    const r = row ?? 'default'
    const a = active ?? 'default'
    return r === a || (isRootProfile(r) && isRootProfile(a))
  }
  // Python `_resolve_profile_home_for_name`: root aliases and invalid names clamp to the base home.
  const profileHome = (name: string): string => (name && name !== isolatedProfile && !isRootProfile(name) && PROFILE_RE.test(name) ? join(config.hermesHome, 'profiles', name) : config.hermesHome)
  const attachmentRoot = (): string => {
    const override = (env.HERMES_WEBUI_ATTACHMENT_DIR ?? '').trim()
    return resolvePathLikePython(override ? override.replace(/^~(?=$|\/)/, home) : join(config.stateDir, 'attachments'))
  }
  const sidecar = opts.sidecar ?? null
  const agentConfig = new AgentConfig({ sidecar: () => sidecar, env })
  const events = new SessionEventBus(isRootProfile)
  const drafts = new DraftStore(config.sessionDir)
  const registry = new StreamRegistry()
  const activeStreamIds = registry.liveIds
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
    defaults: (profile) => {
      const s = settings.load()
      return { workspace: workspaces.lastWorkspace(profile), model: typeof s.default_model === 'string' && s.default_model ? s.default_model : null }
    },
    activeStreamIds: () => activeStreamIds,
    now,
    log,
    cacheMax,
  })
  const projects = new ProjectStore(resolve(config.stateDir, 'projects.json'), () => store.readIndexEntries())
  const shares = new ShareStore(resolve(config.stateDir, 'shares'), now)
  const yoloSessions = new Set<string>()
  const attachmentDir = (sid: string): string => join(attachmentRoot(), (sid || 'session').replace(/[^\w.-]/g, '_').slice(0, 120))
  const cliSessions = new CliSessionSource({ store, profileHome, lastWorkspace: (p) => workspaces.lastWorkspace(p), now, log })
  const gatewayWatchers = new GatewayWatcherRegistry({ profileHome, now, log, ...(opts.gatewayPollMs !== undefined ? { pollIntervalMs: opts.gatewayPollMs } : {}) })
  const sessions = new SessionService({
    store,
    cliSessions: (profile, o) => cliSessions.load(profile, o),
    profileHome,
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
    redactEnabled: () => { try { return settings.load().api_redact_enabled !== false } catch { return true } },
    pinnedSessionsLimit: () => { const v = settings.load().pinned_sessions_limit; return typeof v === 'number' && v >= 1 ? v : 3 },
    // Chat runtime (checkpoint 6) replaces these with live stream and cron state.
    runtime: {
      activeStreamIds,
      runningCronJobs: new Map<string, number>(),
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
      evictAgent: (sid) => { if (sidecar) sidecar.call('chat.evict_agent', { session_id: sid }).catch(() => undefined) },
      closeTerminal: (sid) => { deps.terminals.close(sid) },
    },
    attachmentDir,
    hermesHome: config.hermesHome,
    home,
    syncTitle: () => undefined,
    contextLengthFor: () => null,
    modelStateFromRequest: (model, requestedProvider, currentProvider) => [typeof model === 'string' && model.trim() ? model.trim() : null, typeof requestedProvider === 'string' && requestedProvider.trim() ? requestedProvider.trim() : currentProvider],
    yolo: { isEnabled: (sid) => yoloSessions.has(sid), set: (sid, enabled) => { if (enabled) yoloSessions.add(sid); else yoloSessions.delete(sid) } },
  })
  const git = new GitRunner({ env })
  const rollback = new RollbackStore({ hermesHome: () => profileHome(activeProfile()), knownWorkspaces: () => workspaces.load(activeProfile()).map((w) => w.path) })
  const uploads = new UploadInbox(attachmentRoot)
  const channels = new SessionChannels()
  const pending = new PendingPrompts(events, now)
  const journal = new RunJournal(config.sessionDir, env)
  const background = new BackgroundTasks(now)
  const streamSlots = new StreamSlots(() => { const raw = Number.parseInt((env.HERMES_WEBUI_MAX_SSE_CLIENTS ?? '').trim(), 10); return Number.isFinite(raw) && raw > 0 ? raw : 64 })
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
  // eslint-disable-next-line prefer-const -- assigned after the turn runner exists
  let completions: CompletionDrain
  const relay = new RelayService({
    registry, pending, store, presence: new PresenceLeases(now), profileHome, profilesMatch, fetch: () => lazyFetch, now, log,
    stateDir: config.stateDir, env, canonicalProfile: (p) => (isRootProfile(p) ? 'default' : p), addListener: (listener) => events.addListener(listener),
  })
  const turns = new TurnRunner({
    store,
    service: () => sessions,
    events,
    onTerminal: (streamId, phase) => { relay.noteTerminal(streamId, phase) },
    onTurnEnd: (sessionId) => { void completions.drainDeferred(sessionId) },
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
    agentName: () => { try { const v = settings.load().bot_name; return typeof v === 'string' && v ? v : 'Hermes' } catch { return 'Hermes' } },
    titleGenerationEnabled: () => { try { return settings.load().auto_title_generation !== false } catch { return true } },
  })
  // Services read `deps.fetch` lazily so tests can swap the outbound HTTP client after boot.
  const lazyFetch: typeof fetch = (input, init) => deps.fetch(input, init)
  const catalog = new ProviderCatalog({ sidecar: () => sidecar, config: agentConfig, env, now, log, costBudget: () => coerceProviderCostBudgetValue(settings.load().provider_cost_budget), fetch: lazyFetch })
  const agentStatus = () => {
    const describe = sidecar?.describe ?? null
    const found = Boolean(describe?.agent_dir)
    const importsOk = Boolean(describe && describe.compatible && !describe.import_error)
    return { found, importsOk, missing: [] as string[], errors: describe?.import_error ? { agent: describe.import_error } : {} }
  }
  const profiles = new ProfileService({
    sidecar: () => sidecar,
    baseHome: config.hermesHome,
    profileHome,
    isolatedProfileMode,
    isolatedProfileName,
    config: agentConfig,
    defaultWorkspace: (profile) => workspaces.profileDefaultWorkspace(profile),
    models: (h) => catalog.models(h),
    streamsActive: () => activeStreamIds.size > 0,
    log,
  }, now)
  rootAlias = (name) => profiles.isRootProfile(name)
  const onboarding = new Onboarding({
    settings,
    config: agentConfig,
    env,
    profileHome: () => profileHome(activeProfile()),
    agentStatus,
    isAuthEnabled: () => auth.isAuthEnabled(),
    workspaces: () => ({ items: workspaces.load(activeProfile()), last: workspaces.lastWorkspace(activeProfile()) }),
    models: (h) => catalog.models(h),
    defaultWorkspace: () => config.defaultWorkspace,
    defaultModel: () => (env.HERMES_WEBUI_DEFAULT_MODEL ?? '').trim(),
    log,
  })
  oidc = new OidcService({ env, operatorConfig: () => agentConfig.read(config.hermesHome), profileHome, fetch: () => lazyFetch, now, log })
  operatorConfigPeek = () => agentConfig.peek(config.hermesHome)
  settings.hooks.defaultModel = () => { const cfg = agentConfig.peek(profileHome(activeProfile())); if (!cfg) return ''; if (typeof cfg.model === 'string') return cfg.model.trim(); const d = asDict(cfg.model).default; return typeof d === 'string' ? d.trim() : '' }
  settings.hooks.defaultModelProvider = () => { const cfg = agentConfig.peek(profileHome(activeProfile())); const p = asDict(cfg?.model).provider; return typeof p === 'string' && p ? p : undefined }
  const terminals = new TerminalRegistry({ env, now: () => Date.now(), log, ...(opts.pty !== undefined ? { pty: opts.pty } : {}) })
  const vscode = () => ({
    configuredCommand: 'code',
    command: (): string | null => {
      for (const dir of (env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, 'code'))) return join(dir, 'code')
      for (const fb of ['/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/bin/code', '/snap/bin/code']) if (existsSync(fb)) return fb
      return null
    },
    translate: (path: string) => path,
  })
  completions = new CompletionDrain({ sidecar: () => sidecar, profileHome: (p) => profileHome(p ?? activeProfile()), activeProfile, store, channels, registry, startTurn: (session, prompt) => turns.start(session, { msg: prompt, attachments: [], workspace: session.workspace, model: session.model, modelProvider: session.model_provider, source: 'process_wakeup' }), now, log, ...(opts.completionPollMs !== undefined ? { pollMs: opts.completionPollMs } : {}) })
  const mcpHealth = new McpHealthProber({ fetch: () => lazyFetch, now, log })
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
    features: () => ({ dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false }),
    activeProfile,
    requestScope,
    isRootProfile,
    onboardingCompleted: () => truthy(env.HERMES_WEBUI_SKIP_ONBOARDING) || Boolean(settings.load().onboarding_completed),
    health: () => ({ sessions: store.sessions.size, activeStreams: activeStreamIds.size, activeRuns: registry.activeRuns.size, runs: [...registry.activeRuns.values()].map((r) => ({ stream_id: r.stream_id, session_id: r.session_id, phase: r.phase, started_at: r.started_at })), lastRunFinishedAt: registry.lastRunFinishedAt }),
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
    mediaPolicy: { home, hermesHome: config.hermesHome, stateDir: config.stateDir, snapshotDir, activeWorkspace: mediaActiveWorkspace },
    mediaActiveWorkspace,
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
    runtimeDiagnostics: () => {
      const mem = process.memoryUsage()
      return { pid: process.pid, uptime_seconds: Math.round(process.uptime()), rss_bytes: mem.rss, heap_used_bytes: mem.heapUsed, sessions_cached: store.sessions.size, active_streams: activeStreamIds.size, active_runs: registry.activeRuns.size, sse_clients: streamSlots.active, sidecar_status: sidecar?.status ?? 'stopped' }
    },
    requestShutdown: () => { setTimeout(() => { process.kill(process.pid, 'SIGINT') }, 300).unref() },
    requestRestart: () => { void waitUntilRestartSafe(restartBlockers, { log }).then(() => { purgeAgentPycache(); process.exit(RESTART_EXIT_CODE) }) },
    updates: null as unknown as UpdateService,
    cspLimiter: new WindowLimiter(60, 100, now),
    clientEventLimiter: new WindowLimiter(60, 30, now),
    ttsLimiter: new WindowLimiter(2, 1, now),
    fetch: opts.fetch ?? fetch,
    crons: new CronService({
      sidecar: () => sidecar,
      profileHome,
      profileNames: async () => (await profiles.list('default')).map((r) => ({ name: String(r.name), visible: r.visible !== false })),
      profilesMatch,
      isolatedProfileMode,
      log,
    }),
    kanban: new KanbanService({ sidecar: () => sidecar, config: agentConfig }),
    extensions: new ExtensionService({ env, stateDir: config.stateDir, isAuthEnabled: () => auth.isAuthEnabled(), fetch: lazyFetch, log }),
    terminals,
    commitMessage: async (session, systemPrompt, userPrompt) => {
      if (!sidecar) throw new GitWorkspaceError('Commit message generation needs the Agent sidecar, which is not running', 'aux_unavailable')
      const result = await sidecar.call('aux.complete', { profile_home: profileHome(session.profile ?? activeProfile()), task: 'compression', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
      return result.text
    },
  }
  const restartBlockers = (): RestartBlockers => {
    const streams = [...activeStreamIds].map(String)
    const runs = [...registry.activeRuns.keys()].map(String)
    return { active_streams: streams.length, active_runs: runs.length, blocking_stream_ids: streams.slice(0, 10), blocking_run_ids: runs.slice(0, 10), restart_blocked: streams.length > 0 || runs.length > 0 }
  }
  const purgeAgentPycache = (): void => { const dir = sidecar?.describe?.agent_dir; if (dir) purgePycache(dir) }
  deps.updates = new UpdateService({
    webRoot: config.webRoot,
    getJson: githubJson(lazyFetch, env),
    identity: { release: () => release, stamped: () => stampedRelease, runningSourceRevision: () => runningSourceRevision },
    webuiVersion: version,
    agentDir: () => sidecar?.describe?.agent_dir ?? null,
    channel: () => normalizeChannel(settings.load().update_channel),
    includeAgent: () => !pyBool(settings.load().ignore_agent_updates),
    blockers: restartBlockers,
    scheduleRestart: () => { setTimeout(() => { deps.requestRestart() }, 2000).unref() },
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

  void profiles.warmRootAliases()
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
