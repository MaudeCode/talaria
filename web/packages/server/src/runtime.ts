/**
 * Assemble the application dependencies for one state directory. Used by the
 * launcher and by tests, which pass a temp directory and a fixed environment.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AuthStore } from './auth/store.js'
import { loadConfig, truthy, type Env, type LoadConfigOptions } from './config.js'
import type { AppDeps } from './http/context.js'
import { detectWebuiVersion, loadReleaseInfo } from './release.js'
import { SettingsStore } from './settings.js'
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
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from './sessions/session.js'

export interface CreateDepsOptions extends LoadConfigOptions {
  log?: (line: string) => void
  now?: () => number
  version?: string
  home?: string
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
  const auth = new AuthStore({ stateDir: config.stateDir, env, settings, log, ...(opts.now ? { now: opts.now } : {}) })
  settings.hooks = {
    hashPassword: (pw) => auth.hashPassword(pw),
    onPasswordChanged: () => { auth.invalidatePasswordHashCache() },
  }
  settings.applyStartupWorkspace()
  config.defaultWorkspace = settings.defaultWorkspace
  const release = loadReleaseInfo({ webRoot: config.webRoot })
  const version = opts.version ?? detectWebuiVersion(release, config.webRoot, packageVersion())
  const now = opts.now ?? (() => Date.now() / 1000)
  const home = opts.home ?? homedir()
  const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const activeProfile = (): string => 'default'
  const isRootProfile = (name: string): boolean => name === 'default'
  const profilesMatch = (row: string | null | undefined, active: string | null | undefined): boolean => {
    const r = row ?? 'default'
    const a = active ?? 'default'
    return r === a || (isRootProfile(r) && isRootProfile(a))
  }
  // Python `_resolve_profile_home_for_name`: root aliases and invalid names clamp to the base home.
  const profileHome = (name: string): string => (name && name !== 'default' && PROFILE_RE.test(name) ? join(config.hermesHome, 'profiles', name) : config.hermesHome)
  const attachmentRoot = (): string => {
    const override = (env.HERMES_WEBUI_ATTACHMENT_DIR ?? '').trim()
    return resolvePathLikePython(override ? override.replace(/^~(?=$|\/)/, home) : join(config.stateDir, 'attachments'))
  }
  const events = new SessionEventBus(isRootProfile)
  const drafts = new DraftStore(config.sessionDir)
  const activeStreamIds = new Set<string>()
  const workspaces = new WorkspaceRegistry({
    stateDir: config.stateDir,
    defaultWorkspace: () => config.defaultWorkspace,
    profileHome,
    activeProfile,
    isRootProfileHome: (h) => resolvePathLikePython(h) === resolvePathLikePython(config.hermesHome),
    // config.yaml reads land with the profile domain (checkpoint 7); until then the registry sees no per-profile overrides.
    profileConfig: () => null,
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
  const sessions = new SessionService({
    store,
    drafts,
    events,
    workspaces,
    projects,
    shares,
    now,
    log,
    activeProfile,
    isolatedProfileMode: () => false,
    profilesMatch,
    redactEnabled: () => { try { return settings.load().api_redact_enabled !== false } catch { return true } },
    pinnedSessionsLimit: () => { const v = settings.load().pinned_sessions_limit; return typeof v === 'number' && v >= 1 ? v : 3 },
    // Chat runtime (checkpoint 6) replaces these with live stream and cron state.
    runtime: {
      activeStreamIds,
      runningCronJobs: new Map<string, number>(),
      live: (): Session | undefined => undefined,
      attention: () => null,
      activeRunStream: () => null,
      evictAgent: () => undefined,
      closeTerminal: () => undefined,
    },
    attachmentDir: (sid) => join(attachmentRoot(), (sid || 'session').replace(/[^\w.-]/g, '_').slice(0, 120)),
    hermesHome: config.hermesHome,
    home,
    syncTitle: () => undefined,
    contextLengthFor: () => null,
    modelStateFromRequest: (model, requestedProvider, currentProvider) => [typeof model === 'string' && model.trim() ? model.trim() : null, typeof requestedProvider === 'string' && requestedProvider.trim() ? requestedProvider.trim() : currentProvider],
    yolo: { isEnabled: (sid) => yoloSessions.has(sid), set: (sid, enabled) => { if (enabled) yoloSessions.add(sid); else yoloSessions.delete(sid) } },
  })
  const vscode = () => ({
    configuredCommand: 'code',
    command: (): string | null => {
      for (const dir of (env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, 'code'))) return join(dir, 'code')
      for (const fb of ['/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', '/usr/bin/code', '/snap/bin/code']) if (existsSync(fb)) return fb
      return null
    },
    translate: (path: string) => path,
  })
  return {
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
    isRootProfile,
    onboardingCompleted: () => truthy(env.HERMES_WEBUI_SKIP_ONBOARDING) || Boolean(settings.load().onboarding_completed),
    health: () => ({ sessions: store.sessions.size, activeStreams: activeStreamIds.size, activeRuns: 0, runs: [], lastRunFinishedAt: null }),
    sessions,
    sessionStore: store,
    events,
    projects,
    workspaces,
    isolatedProfileMode: () => false,
    profilesMatch,
    worktreeDefault: () => false,
    worktrees: { create: () => Promise.reject(new Error('Worktree creation is not available yet')) },
    vscode,
  }
}
