/**
 * Hermes Agent discovery for the sidecar spawn (Python `bootstrap.py` rules):
 * `HERMES_WEBUI_AGENT_DIR`, `$HERMES_HOME/hermes-agent`, a sibling checkout of
 * this repository, `~/hermes-agent`, `/opt/hermes`, `/usr/local/lib/hermes-agent`;
 * the interpreter is `HERMES_WEBUI_PYTHON` or the Agent's `venv`/`.venv`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
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
  for (const line of lines.slice(1)) for (const m of line.matchAll(/['"](\/[^'"]+)['"]/g)) candidates.push(m[1] ?? '')
  for (const c of candidates) { const found = c ? walkUpForRunAgent(c) : null; if (found) return found }
  return null
}

/** Python `discover_agent_dir` with the launcher fallbacks (`run_agent.py` is the marker). */
export function discoverAgentDirForLaunch(opts: DiscoverOptions): string | null {
  for (const candidate of [...agentCandidates(opts), join(opts.home, '.hermes', 'hermes-agent')]) if (existsSync(join(candidate, 'run_agent.py'))) return resolve(candidate)
  return agentDirFromHermesCli(opts.env)
}

export function discoverAgentPython(env: Record<string, string | undefined>, agentDir: string | null): string | null {
  const explicit = (env.HERMES_WEBUI_PYTHON ?? '').trim()
  if (explicit) return explicit
  if (!agentDir) return null
  for (const venv of ['venv', '.venv']) {
    for (const bin of [join(agentDir, venv, 'bin', 'python'), join(agentDir, venv, 'Scripts', 'python.exe')]) if (existsSync(bin)) return bin
  }
  return null
}

export interface LaunchOptions extends DiscoverOptions {
  log: (line: string) => void
}

/** Discover the Agent and spawn the sidecar on its venv; null when no Agent is installed (chat answers 503 `sidecar_unavailable`). */
export function launchSidecar(opts: LaunchOptions): SidecarClient | null {
  const agentDir = discoverAgentDirForLaunch(opts)
  const python = discoverAgentPython(opts.env, agentDir)
  if (!agentDir || !python) {
    opts.log(`[sidecar] Hermes Agent not found (looked in ${agentCandidates(opts).join(', ')}); set HERMES_WEBUI_AGENT_DIR to enable chat`)
    return null
  }
  const client = new SidecarClient({ python, agentDir, sidecarDir: join(opts.webRoot, 'sidecar'), hermesHome: opts.hermesHome, log: opts.log })
  opts.log(`[sidecar] starting on ${python} (agent ${agentDir})`)
  return client
}
