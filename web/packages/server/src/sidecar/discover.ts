/**
 * Hermes Agent discovery for the sidecar spawn (Python `bootstrap.py` rules):
 * `HERMES_WEBUI_AGENT_DIR`, `$HERMES_HOME/hermes-agent`, a sibling checkout of
 * this repository, `~/hermes-agent`, `/opt/hermes`, `/usr/local/lib/hermes-agent`;
 * the interpreter is `HERMES_WEBUI_PYTHON`, the PM generation, or `venv`/`.venv`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { platformDefaultHermesHome } from '../config.js'
import { supportedAgents } from '../release.js'
import { SidecarClient } from './client.js'

export interface DiscoverOptions {
  env: Record<string, string | undefined>
  hermesHome: string
  webRoot: string
  home: string
}

function isAgentCheckout(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return ['run_agent.py', 'hermes_cli', 'agent'].some((marker) => existsSync(join(dir, marker)))
}

export function agentCandidates(opts: DiscoverOptions): string[] {
  const explicit = (opts.env.HERMES_WEBUI_AGENT_DIR ?? '').trim().replace(/^~(?=$|\/)/, opts.home)
  return [
    explicit,
    join(opts.hermesHome, 'hermes-agent'),
    resolve(opts.webRoot, '..', 'hermes-agent'),
    join(opts.home, 'hermes-agent'),
    '/opt/hermes',
    '/usr/local/lib/hermes-agent',
  ].filter(Boolean).map((p) => resolve(p))
}

export function discoverAgentDir(opts: DiscoverOptions): string | null {
  for (const candidate of agentCandidates(opts)) if (isAgentCheckout(candidate)) return candidate
  return null
}

function walkUpForRunAgent(start: string): string | null {
  let dir = dirname(start)
  for (;;) {
    if (existsSync(join(dir, 'run_agent.py'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function which(name: string, env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    try { if (statSync(candidate).isFile()) return candidate } catch { /* next */ }
  }
  return null
}

/** Python `_agent_dir_from_hermes_cli`: read the `hermes` launcher and walk up from any absolute path it references. */
export function agentDirFromHermesCli(env: Record<string, string | undefined>): string | null {
  const launcher = which('hermes', env)
  if (!launcher) return null
  let head: string
  try { head = readFileSync(launcher, { encoding: 'utf8', flag: 'r' }).split('\n').slice(0, 20).join('\n') } catch { return null }
  if (!head.startsWith('#!')) return null
  const lines = head.split('\n')
  const candidates: string[] = []
  const interp = (lines[0] ?? '').slice(2).trim().split(/\s+/)[0] ?? ''
  if (interp.startsWith('/') && !interp.endsWith('/env')) candidates.push(interp)
  for (const line of lines.slice(1)) {
    for (const m of line.matchAll(/['"](\/[^'"]+)['"]/g)) candidates.push(m[1] ?? '')
    const exec = /^\s*exec\s+(\/[^\s'";|&<>]+)(?:\s|$)/.exec(line)
    if (exec?.[1]) candidates.push(exec[1])
  }
  for (const c of candidates) { const found = c ? walkUpForRunAgent(c) : null; if (found) return found }
  return null
}

/** Python `discover_agent_dir` with the launcher fallbacks (`run_agent.py` is the marker). */
export function discoverAgentDirForLaunch(opts: DiscoverOptions): string | null {
  for (const candidate of [...agentCandidates(opts), join(opts.home, '.hermes', 'hermes-agent')]) if (existsSync(join(candidate, 'run_agent.py'))) return resolve(candidate)
  return agentDirFromHermesCli(opts.env)
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Match PM's data root: named profiles share their root's install records. */
function dependencyRoot(env: Record<string, string | undefined>, hermesHome?: string): string {
  const home = env.HOME ?? homedir()
  const native = platformDefaultHermesHome(env, home)
  const selected = hermesHome ?? resolve((env.HERMES_HOME ?? '').trim().replace(/^~(?=$|\/)/, home) || native)
  const canonical = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }
  if (within(canonical(native), canonical(selected))) return native
  return basename(dirname(selected)) === 'profiles' ? dirname(dirname(selected)) : selected
}

/** Undefined means no PM selection; a broken selection fails closed instead of loading an older venv. */
function recordedPython(root: string, agentDir: string): string | null | undefined {
  try {
    const key = createHash('sha256').update(realpathSync(agentDir)).digest('hex').slice(0, 16)
    const install = join(root, 'installs', key)
    let raw: string
    try { raw = readFileSync(join(install, 'facts.json'), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return null
    }
    let fact: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    for (const key of ['packages', 'venv', 'environment']) {
      if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return null
      fact = (fact as Record<string, unknown>)[key]
      if (fact === undefined) return undefined
    }
    const environment = fact
    if (environment === undefined || environment === null) return undefined
    if (typeof environment !== 'string' || !isAbsolute(environment)) return null
    const venv = realpathSync(environment)
    if (!within(realpathSync(join(install, 'environments')), venv) || !statSync(join(venv, 'pyvenv.cfg')).isFile()) return null
    for (const bin of [join(venv, 'bin', 'python'), join(venv, 'Scripts', 'python.exe')]) {
      if (existsSync(bin) && statSync(bin).isFile()) return bin
    }
    return null
  } catch { return null }
}

/** A venv's `bin/python` is a symlink to its base interpreter, so only its directory is canonicalised. */
function sameInterpreter(a: string, b: string): boolean {
  const canonical = (path: string) => { try { return join(realpathSync(dirname(path)), basename(path)) } catch { return resolve(path) } }
  return canonical(a) === canonical(b)
}

/** `warn` reports an explicit `HERMES_WEBUI_PYTHON` that overrides a different PM-recorded interpreter; the override still wins. */
export function discoverAgentPython(env: Record<string, string | undefined>, agentDir: string | null, hermesHome?: string, warn?: (line: string) => void): string | null {
  const explicit = (env.HERMES_WEBUI_PYTHON ?? '').trim()
  const recorded = agentDir ? recordedPython(dependencyRoot(env, hermesHome), agentDir) : undefined
  if (explicit) {
    if (warn && typeof recorded === 'string' && !sameInterpreter(explicit, recorded)) {
      warn(`[sidecar] [warn] HERMES_WEBUI_PYTHON=${explicit} overrides the Agent's package-manager interpreter ${recorded}; unset HERMES_WEBUI_PYTHON unless this install has no package-manager environment`)
    }
    return explicit
  }
  if (!agentDir) return null
  if (recorded !== undefined) return recorded
  for (const venv of ['venv', '.venv']) {
    for (const bin of [join(agentDir, venv, 'bin', 'python'), join(agentDir, venv, 'Scripts', 'python.exe')]) if (existsSync(bin)) return bin
  }
  return null
}

export interface LaunchOptions extends DiscoverOptions {
  log: (line: string) => void
}

/** `HERMES_WEBUI_SIDECAR_COMMAND`: a JSON array (or whitespace-separated command) that replaces `<python> -m talaria_sidecar`, e.g. the fixture replay sidecar. */
export function scriptedSidecarCommand(env: Record<string, string | undefined>): string[] | null {
  const raw = (env.HERMES_WEBUI_SIDECAR_COMMAND ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((v) => typeof v === 'string')) throw new Error('HERMES_WEBUI_SIDECAR_COMMAND must be a JSON array of strings')
    return parsed
  }
  return raw.split(/\s+/)
}

/** The configured process environment (shell plus launcher-loaded `.env` files) as the Agent saw it in-process in Python. */
function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

/** Discover the Agent and spawn the sidecar on its venv; null when no Agent is installed (chat answers 503 `sidecar_unavailable`). */
export function launchSidecar(opts: LaunchOptions): SidecarClient | null {
  const scripted = scriptedSidecarCommand(opts.env)
  if (scripted) {
    opts.log(`[sidecar] starting scripted sidecar ${scripted.join(' ')}`)
    return new SidecarClient({ python: scripted[0] ?? '', command: scripted, agentDir: discoverAgentDirForLaunch(opts) ?? '', sidecarDir: join(opts.webRoot, 'sidecar'), hermesHome: opts.hermesHome, env: () => stringEnv(opts.env), log: opts.log, supportedAgents: supportedAgents(opts.webRoot) })
  }
  const agentDir = discoverAgentDirForLaunch(opts)
  if (!agentDir) {
    opts.log(`[sidecar] Hermes Agent not found (looked in ${agentCandidates(opts).join(', ')}); set HERMES_WEBUI_AGENT_DIR to enable chat`)
    return null
  }
  const client = new SidecarClient({ python: () => discoverAgentPython(opts.env, agentDir, opts.hermesHome, opts.log), agentDir, sidecarDir: join(opts.webRoot, 'sidecar'), hermesHome: opts.hermesHome, env: () => stringEnv(opts.env), log: opts.log, supportedAgents: supportedAgents(opts.webRoot) })
  opts.log(`[sidecar] starting for agent ${agentDir}`)
  return client
}
