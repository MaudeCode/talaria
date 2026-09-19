import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const STATE_FILE = join(tmpdir(), `hermes-e2e-${process.env.HERMES_E2E_PORT ?? '8797'}.json`)

export interface ServerHandle { pid: number; state: string; log: string }

/** Boot one isolated `server.py` and wait for `/health`. */
export async function bootServer(baseUrl: string, extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const port = new URL(baseUrl).port
  const state = mkdtempSync(join(tmpdir(), 'hermes-e2e-'))
  mkdirSync(join(state, 'workspace'))
  mkdirSync(join(state, 'claude-projects'))
  mkdirSync(join(state, 'sessions'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('HERMES_')) env[k] = v
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
  const python = process.env.HERMES_E2E_PYTHON ?? 'python3'
  const child: ChildProcess = spawn(python, [join(REPO_ROOT, 'server.py')], { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd], detached: true })
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
  const tail = readFileSync(log, 'utf8').slice(-3000)
  try { process.kill(child.pid!, 'SIGTERM') } catch { /* already gone */ }
  throw new Error(`server on ${baseUrl} did not become healthy:\n${tail}`)
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
