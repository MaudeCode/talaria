/**
 * `talaria-web` launcher (Python `bootstrap.py`): Agent discovery with the
 * `hermes` CLI walk-up, sidecar preflight, optional Agent install, foreground
 * (supervisor) versus detached start, TLS-aware health wait, browser open.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { discoverAgentDirForLaunch, discoverAgentPython, which } from '../sidecar/discover.js'
export { agentDirFromHermesCli, discoverAgentDirForLaunch } from '../sidecar/discover.js'

export const SUPERVISOR_ENV_VARS = ['INVOCATION_ID', 'JOURNAL_STREAM', 'NOTIFY_SOCKET', 'XPC_SERVICE_NAME', 'SUPERVISOR_ENABLED'] as const
const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

export function isWsl(env: Record<string, string | undefined>, release = ''): boolean {
  if (process.platform !== 'linux') return false
  const r = release.toLowerCase()
  return r.includes('microsoft') || r.includes('wsl') || Boolean(env.WSL_DISTRO_NAME)
}

/** Python `_python_can_run_webui_and_agent`: the sidecar preflight. */
export function sidecarPreflight(python: string, agentDir: string, env: Record<string, string | undefined>): { ok: boolean; detail: string } {
  const pythonPath = env.PYTHONPATH ? `${agentDir}${delimiter}${env.PYTHONPATH}` : agentDir
  const result = spawnSync(python, ['-c', 'import yaml\nfrom run_agent import AIAgent\n'], { env: { ...env, PYTHONPATH: pythonPath }, encoding: 'utf8', timeout: 60_000 })
  if (result.error) return { ok: false, detail: result.error.message }
  return { ok: result.status === 0, detail: (result.stderr || '').trim().split('\n').slice(-1)[0] ?? '' }
}

/** Python `install_hermes_agent`: the official installer pinned to the compatible revision (POSIX only). */
export function installHermesAgent(sourceRevision: string, log: (line: string) => void): void {
  if (process.platform === 'win32') throw new Error('Auto-install is not supported on native Windows. Install hermes-agent manually first.')
  const url = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${sourceRevision}/scripts/install.sh`
  log(`[bootstrap] Hermes Agent not found. Attempting install via ${url}`)
  execFileSync('/bin/bash', ['-o', 'pipefail', '-c', `curl -fsSL ${url} | bash -s -- --commit ${sourceRevision}`], { stdio: 'inherit' })
}

/** Python `_detect_supervisor`: the env var that marks a supervisor launch (launchd noise values excluded). */
export function detectSupervisor(env: Record<string, string | undefined>): string | null {
  if (truthy(env.HERMES_WEBUI_FOREGROUND)) return 'HERMES_WEBUI_FOREGROUND'
  for (const name of SUPERVISOR_ENV_VARS) {
    const value = env[name] ?? ''
    if (!value) continue
    if (name === 'XPC_SERVICE_NAME' && (value === '0' || value.startsWith('application.'))) continue
    return name
  }
  return null
}

function probeOnce(url: string, verify: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = lib(u, { method: 'GET', timeout: 2000, rejectUnauthorized: verify }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { try { resolve(res.statusCode === 200 && (JSON.parse(body) as { status?: unknown }).status === 'ok') } catch { resolve(false) } })
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => { resolve(false) })
    req.end()
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

/** Python `wait_for_health`: HTTPS first when TLS is configured (self-signed accepted with a warning), HTTP fallback; answers the scheme that responded. */
/** `host:port` with an IPv6 literal bracketed (URL authority form). */
export function hostAuthority(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${String(port)}` : `${host}:${String(port)}`
}

export async function waitForHealth(host: string, port: number, opts: { tls: boolean; insecureOptIn: boolean; timeoutMs: number; log: (line: string) => void; now?: () => number }): Promise<'http' | 'https' | ''> {
  const now = opts.now ?? Date.now
  const deadline = now() + opts.timeoutMs
  const authority = hostAuthority(host, port)
  let warned = false
  while (now() < deadline) {
    if (!opts.tls) {
      if (await probeOnce(`http://${authority}/health`, true)) return 'http'
    } else {
      if (opts.insecureOptIn) { if (await probeOnce(`https://${authority}/health`, false)) return 'https' }
      else {
        if (await probeOnce(`https://${authority}/health`, true)) return 'https'
        if (await probeOnce(`https://${authority}/health`, false)) {
          if (!warned) { warned = true; opts.log(`[bootstrap] [warn] Health probe: TLS certificate at https://${authority}/health is self-signed or not trusted; proceeding without verification.`) }
          return 'https'
        }
      }
      if (await probeOnce(`http://${authority}/health`, true)) return 'http'
    }
    await sleep(400)
  }
  return ''
}

export function openBrowser(url: string, log: (line: string) => void): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', (error) => { log(`[bootstrap] Could not open browser automatically: ${error.message}`) })
    child.unref()
  } catch (error) { log(`[bootstrap] Could not open browser automatically: ${(error as Error).message}`) }
}

export interface BootstrapArgs { port: number; host: string; noBrowser: boolean; skipAgentInstall: boolean; foreground: boolean }

/** Python `parse_args`: `[port] [--host H] [--no-browser] [--skip-agent-install] [--foreground]`. */
export function parseBootstrapArgs(argv: string[], env: Record<string, string | undefined>): BootstrapArgs {
  const args: BootstrapArgs = { port: Number.parseInt(env.HERMES_WEBUI_PORT ?? '8787', 10) || 8787, host: env.HERMES_WEBUI_HOST ?? '127.0.0.1', noBrowser: false, skipAgentInstall: false, foreground: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--host') { args.host = argv[i + 1] ?? args.host; i += 1 }
    else if (arg.startsWith('--host=')) args.host = arg.slice('--host='.length)
    else if (arg === '--no-browser') args.noBrowser = true
    else if (arg === '--skip-agent-install') args.skipAgentInstall = true
    else if (arg === '--foreground') args.foreground = true
    else if (/^\d+$/.test(arg)) args.port = Number.parseInt(arg, 10)
    else if (arg === '-h' || arg === '--help') throw new Error('usage: talaria-web [port] [--host HOST] [--no-browser] [--skip-agent-install] [--foreground]')
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

export interface LaunchContext {
  env: Record<string, string | undefined>
  webRoot: string
  hermesHome: string
  home: string
  compatibleAgentRevision: string
  /** Command that runs the server in the foreground (the bin's `serve`). */
  serveCommand: string[]
  log: (line: string) => void
}

/**
 * Python `bootstrap.main` minus the process replacement: resolves the Agent,
 * mutates `env` for the child, and either runs the server in-process
 * (`foreground`) or spawns it detached with `bootstrap-<port>.log`, waits
 * for `/health`, prints the ready URL, and opens the browser.
 */
export async function runBootstrap(ctx: LaunchContext, args: BootstrapArgs, serveInProcess: () => Promise<void>): Promise<number> {
  const { env, log } = ctx
  const discover = { env, hermesHome: ctx.hermesHome, webRoot: ctx.webRoot, home: ctx.home }
  let agentDir = discoverAgentDirForLaunch(discover)
  // A scripted sidecar (fixture replay, contract runners) needs no Agent: never run the installer for it.
  const scriptedSidecar = Boolean((env.HERMES_WEBUI_SIDECAR_COMMAND ?? '').trim())
  if (!agentDir && !scriptedSidecar && !which('hermes', env)) {
    if (args.skipAgentInstall) throw new Error('Hermes Agent was not found and auto-install was disabled.')
    installHermesAgent(ctx.compatibleAgentRevision, log)
    agentDir = discoverAgentDirForLaunch(discover)
  }
  const python = discoverAgentPython(env, agentDir)
  if (agentDir && python) {
    const preflight = sidecarPreflight(python, agentDir, env)
    if (!preflight.ok) throw new Error(`Python environment at ${python} cannot import Hermes Agent (${preflight.detail || 'preflight failed'}). Set HERMES_WEBUI_PYTHON to the Agent venv interpreter.`)
  } else if (scriptedSidecar) log('[bootstrap] Using the sidecar command from HERMES_WEBUI_SIDECAR_COMMAND; no Hermes Agent checkout required')
  else log('[bootstrap] [warn] Hermes Agent venv not found; chat stays unavailable until HERMES_WEBUI_AGENT_DIR points at an installed Agent')
  const stateDir = resolve((env.HERMES_WEBUI_STATE_DIR ?? '').trim().replace(/^~(?=$|\/)/, ctx.home) || join(ctx.hermesHome, 'webui'))
  mkdirSync(stateDir, { recursive: true })
  env.HERMES_WEBUI_HOST = args.host
  env.HERMES_WEBUI_PORT = String(args.port)
  env.HERMES_WEBUI_STATE_DIR ??= stateDir
  if (agentDir) env.HERMES_WEBUI_AGENT_DIR = agentDir
  if (python) env.HERMES_WEBUI_PYTHON = python
  const tls = Boolean((env.HERMES_WEBUI_TLS_CERT ?? '').trim()) && Boolean((env.HERMES_WEBUI_TLS_KEY ?? '').trim())
  const scheme = tls ? 'https' : 'http'
  const foregroundReason = args.foreground ? '--foreground' : detectSupervisor(env)
  if (foregroundReason) {
    log(`[bootstrap] Starting Talaria Web on ${scheme}://${hostAuthority(args.host, args.port)} (foreground mode: ${foregroundReason})`)
    await serveInProcess()
    return 0
  }
  const logPath = join(stateDir, `bootstrap-${String(args.port)}.log`)
  log(`[bootstrap] Starting Talaria Web on ${scheme}://${hostAuthority(args.host, args.port)}`)
  const fd = openSync(logPath, 'a')
  // The worker re-applies the checkout `.env` before serving; the resolved host/port travel as explicit serve
  // arguments so a `.env` HERMES_WEBUI_PORT cannot override what the user asked for on the command line.
  const [cmd, ...cmdArgs] = [...ctx.serveCommand, '--host', args.host, String(args.port)]
  const child = spawn(cmd ?? process.execPath, cmdArgs, { cwd: (env.HERMES_WEBUI_SERVER_CWD ?? '').trim() || agentDir || ctx.webRoot, env, stdio: ['ignore', fd, fd], detached: true })
  child.unref()
  closeSync(fd)
  const healthy = await waitForHealth(args.host, args.port, { tls, insecureOptIn: truthy(env.HERMES_WEBUI_TLS_INSECURE_PROBE), timeoutMs: 25_000, log })
  if (!healthy) throw new Error(`Web UI did not become healthy at ${scheme}://${hostAuthority(args.host, args.port)}/health. Check the log at ${logPath}. Server PID: ${String(child.pid ?? '?')}`)
  // Loopback and wildcard binds open as `localhost`; any other IPv6 literal is bracketed like the health probe.
  const browserHost = ['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1', '[::]', '[::1]'].includes(args.host) ? 'localhost' : args.host.includes(':') && !args.host.startsWith('[') ? `[${args.host}]` : args.host
  const appUrl = `${healthy}://${browserHost}:${String(args.port)}`
  log(`[bootstrap] Web UI is ready: ${appUrl}`)
  log(`[bootstrap] Log file: ${logPath}`)
  if (!args.noBrowser) openBrowser(appUrl, log)
  return 0
}
