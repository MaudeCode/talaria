import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** `web/` (the npm workspaces root). */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SERVER_BIN = join(REPO_ROOT, 'packages', 'server', 'dist', 'bin', 'talaria-web.js')

let bundleBuilt = false

/**
 * The TS server ships as a built bin (built once when a fresh checkout has no `dist/`) and serves the frontend
 * bundle, which is not committed (TAL-379). The bundle is rebuilt once per run, so a leftover build from another
 * checkout state can never pass Playwright against stale source. It imports the contracts package, built first.
 */
function ensureServerBuilt(): void {
  if (bundleBuilt) return
  execFileSync('npm', ['run', 'build', '-w', 'packages/contracts'], { cwd: REPO_ROOT, stdio: 'inherit' })
  if (!existsSync(SERVER_BIN)) execFileSync('npm', ['run', 'build', '-w', 'packages/server'], { cwd: REPO_ROOT, stdio: 'inherit' })
  execFileSync('npm', ['run', 'build:fast', '-w', 'packages/frontend'], { cwd: REPO_ROOT, stdio: 'inherit' })
  bundleBuilt = true
}
const STATE_FILE = join(tmpdir(), `hermes-e2e-${process.env.HERMES_E2E_PORT ?? '8797'}.json`)
/**
 * Server state lives on tmpfs where the OS has one. The login and session stores fsync on the request path, and on a
 * shared CI disk a neighbouring `npm ci` or browser install can stall each fsync for seconds, blocking the server.
 */
const STATE_ROOT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()

export interface ServerHandle { pid: number; state: string; log: string }

/** Boot one isolated Talaria Web server (the Node bin) and wait for `/health`. */
export async function bootServer(baseUrl: string, extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const port = new URL(baseUrl).port
  const state = mkdtempSync(join(STATE_ROOT, 'hermes-e2e-'))
  mkdirSync(join(state, 'workspace'))
  mkdirSync(join(state, 'claude-projects'))
  mkdirSync(join(state, 'sessions'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('HERMES_')) env[k] = v
  // The isolated HERMES_HOME hides the developer's Agent checkout; point the sidecar at it explicitly (same default as sidecar/scripts/test.sh).
  env.HERMES_WEBUI_AGENT_DIR = process.env.HERMES_WEBUI_AGENT_DIR ?? join(process.env.HOME ?? '', '.hermes', 'hermes-agent')
  for (const key of ['HERMES_WEBUI_PYTHON', 'HERMES_WEBUI_SIDECAR_COMMAND']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, {
    HERMES_WEBUI_PORT: port,
    HERMES_WEBUI_HOST: '127.0.0.1',
    HERMES_WEBUI_STATE_DIR: state,
    HERMES_WEBUI_DEFAULT_WORKSPACE: join(state, 'workspace'),
    HERMES_HOME: state,
    HERMES_BASE_HOME: state,
    HERMES_CONFIG_PATH: join(state, 'config.yaml'),
    // Keep the developer's real ~/.claude/projects out of the imported-session list.
    HERMES_WEBUI_CLAUDE_PROJECTS_DIR: join(state, 'claude-projects'),
    HERMES_WEBUI_SKIP_ONBOARDING: '1',
    HERMES_WEBUI_TEST_NETWORK_BLOCK: '1',
    AWS_EC2_METADATA_DISABLED: 'true',
    ...extraEnv,
  })
  const log = join(state, 'server.log')
  const fd = openSync(log, 'w')
  ensureServerBuilt()
  env.TALARIA_WEB_ROOT = REPO_ROOT
  // Foreground keeps the launcher attached as the supervisor of the server worker; SIGTERM to it stops both.
  const child: ChildProcess = spawn(process.execPath, [SERVER_BIN, '--foreground', '--no-browser'], { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd], detached: true })
  child.unref()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return { pid: child.pid!, state, log }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  const output = readFileSync(log, 'utf8')
  const excerpt = output.length > 6000 ? `${output.slice(0, 3000)}\n[... ${String(output.length - 6000)} bytes ...]\n${output.slice(-3000)}` : output
  try { process.kill(child.pid!, 'SIGTERM') } catch { /* already gone */ }
  throw new Error(`server on ${baseUrl} did not become healthy (exit ${String(child.exitCode)}):\n${excerpt}`)
}

export function saveHandles(handles: ServerHandle[]): void { writeFileSync(STATE_FILE, JSON.stringify(handles)) }

export function stopServers(): void {
  let handles: ServerHandle[] = []
  try { handles = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServerHandle[] } catch { return }
  for (const h of handles) {
    try { process.kill(h.pid, 'SIGTERM') } catch { /* already gone */ }
    if (!process.env.HERMES_E2E_KEEP_STATE) rmSync(h.state, { recursive: true, force: true })
  }
  rmSync(STATE_FILE, { force: true })
}
