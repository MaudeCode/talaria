import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

interface ServerHandle { pid: number; state: string; log: string }

/** A listener on the port would answer the `/health` wait below for a server that could not bind. Only a refused connection proves the port free. */
function assertPortFree(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`e2e port ${url.port} is already in use, likely by another run. Set HERMES_E2E_PORT to a free port; the run also uses the next port.`))
    })
    socket.once('error', (err: NodeJS.ErrnoException) => { if (err.code === 'ECONNREFUSED') resolve(); else reject(err) })
  })
}

/** Boot one isolated Talaria Web server (the Node bin) and wait for `/health`. */
export async function bootServer(baseUrl: string, extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const url = new URL(baseUrl)
  await assertPortFree(url)
  const port = url.port
  const state = mkdtempSync(join(STATE_ROOT, 'hermes-e2e-'))
  mkdirSync(join(state, 'workspace'))
  mkdirSync(join(state, 'claude-projects'))
  mkdirSync(join(state, 'sessions'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('HERMES_') && !k.startsWith('TALARIA_WEB_')) env[k] = v
  // The isolated HERMES_HOME hides the developer's ~/.hermes Agent; playwright.config.ts defaults to the replay sidecar.
  for (const key of ['TALARIA_WEB_AGENT_DIR', 'TALARIA_WEB_PYTHON', 'TALARIA_WEB_SIDECAR_COMMAND']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, {
    // The tmpfs workspace must be inside the same disposable user home as the server.
    HOME: state,
    TALARIA_WEB_PORT: port,
    TALARIA_WEB_HOST: '127.0.0.1',
    TALARIA_WEB_STATE_DIR: state,
    TALARIA_WEB_DEFAULT_WORKSPACE: join(state, 'workspace'),
    HERMES_HOME: state,
    HERMES_BASE_HOME: state,
    HERMES_CONFIG_PATH: join(state, 'config.yaml'),
    // Keep the developer's real ~/.claude/projects out of the imported-session list.
    TALARIA_WEB_CLAUDE_PROJECTS_DIR: join(state, 'claude-projects'),
    TALARIA_WEB_SKIP_ONBOARDING: '1',
    TALARIA_WEB_TEST_NETWORK_BLOCK: '1',
    AWS_EC2_METADATA_DISABLED: 'true',
    // Native Agent trials use their preprovisioned interpreter and no scanner download/updater.
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    TIRITH_ENABLED: '0',
    ...extraEnv,
  })
  const log = join(state, 'server.log')
  const fd = openSync(log, 'w')
  ensureServerBuilt()
  env.TALARIA_WEB_ROOT = REPO_ROOT
  // Foreground keeps the launcher attached as the supervisor of the server worker; SIGTERM to it stops both.
  const child: ChildProcess = spawn(process.execPath, [SERVER_BIN, '--foreground', '--no-browser'], { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd], detached: true })
  child.unref()
  if (await listening(child, log)) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return { pid: child.pid!, state, log }
    } catch { /* reported with the log below */ }
  }
  const output = readFileSync(log, 'utf8')
  const excerpt = output.length > 6000 ? `${output.slice(0, 3000)}\n[... ${String(output.length - 6000)} bytes ...]\n${output.slice(-3000)}` : output
  try { process.kill(child.pid!, 'SIGTERM') } catch { /* already gone */ }
  throw new Error(`server on ${baseUrl} did not become healthy (exit ${String(child.exitCode)}):\n${excerpt}`)
}

/** Wakes on each write to the server's log and on its exit, so readiness is the listening line itself, under one 60 s ceiling. */
function listening(child: ChildProcess, log: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (up: boolean) => {
      if (settled) return
      settled = true
      watcher.close()
      clearTimeout(ceiling)
      child.off('exit', exited)
      resolve(up)
    }
    const check = () => { if (readFileSync(log, 'utf8').includes('Talaria Web listening on')) finish(true) }
    const exited = () => { check(); finish(false) }
    const watcher = watch(log, check)
    const ceiling = setTimeout(() => { finish(false) }, 60_000)
    child.once('exit', exited)
    if (child.exitCode !== null) exited()
    else check()
  })
}

export function saveHandles(handles: ServerHandle[]): void { writeFileSync(STATE_FILE, JSON.stringify(handles)) }

/** Disposable server state for specs that seed server-read files. */
export function serverState(kind: 'open' | 'authenticated'): string { return (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServerHandle[])[kind === 'open' ? 0 : 1]!.state }
export function openServerState(): string { return serverState('open') }

/** A spec's own handle on a server's Agent state.db. The server reads the same file while it runs, so writes wait out its lock instead of failing with "database is locked". */
export function openStateDb(state: string): DatabaseSync { return new DatabaseSync(join(state, 'state.db'), { timeout: 5000 }) }

export function stopHandles(handles: ServerHandle[]): void {
  for (const h of handles) {
    try { process.kill(h.pid, 'SIGTERM') } catch { /* already gone */ }
    if (!process.env.HERMES_E2E_KEEP_STATE) rmSync(h.state, { recursive: true, force: true })
  }
}

export function stopServers(): void {
  let handles: ServerHandle[] = []
  try { handles = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServerHandle[] } catch { return }
  stopHandles(handles)
  rmSync(STATE_FILE, { force: true })
}
