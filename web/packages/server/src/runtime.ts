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

export interface CreateDepsOptions extends LoadConfigOptions {
  log?: (line: string) => void
  now?: () => number
  version?: string
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
  return {
    config,
    settings,
    auth,
    startup: new StartupGate(),
    spa: new SpaShell(config.distRoot),
    staticFiles: new AssetCache(config.staticRoot),
    release,
    version,
    startedAt: (opts.now ?? (() => Date.now() / 1000))(),
    log,
    stats: { requestsTotal: 0, lastRequestAt: 0 },
    features: () => ({ dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false }),
    activeProfile: () => 'default',
    isRootProfile: (name) => name === 'default',
    onboardingCompleted: () => truthy(env.HERMES_WEBUI_SKIP_ONBOARDING) || Boolean(settings.load().onboarding_completed),
    health: () => ({ sessions: 0, activeStreams: 0, activeRuns: 0, runs: [], lastRunFinishedAt: null }),
  }
}
