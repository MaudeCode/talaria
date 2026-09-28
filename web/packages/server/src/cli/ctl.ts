/**
 * `talaria-web ctl` (Python `ctl.sh`): background daemon control with the
 * same `webui.pid`, `webui.log`, and `webui.ctl.env` files under the Hermes
 * home (or a per-worktree runtime directory for git worktrees), the launchd /
 * systemd / foreign-responder guards, the startup grace watch, `status`, and
 * `logs`. `start --remote` runs the Vite dev server against a remote WebUI.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, connect as netConnect } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { loadLauncherDotenv, loadStartupEnv } from './dotenv.js'
import { str } from '../util.js'

export interface CtlContext {
  env: Record<string, string | undefined>
  webRoot: string
  home: string
  /** Command that runs the server in the foreground (the bin's `serve`). */
  serveCommand: string[]
  log: (line: string) => void
  warn: (line: string) => void
  now?: () => number
}

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

export interface CtlPaths { hermesHome: string; runtimeRoot: string; runtimeBase: string | null; worktreeMode: boolean; pidFile: string; logFile: string; stateFile: string; stateDir: string; launchdLabels: string[] }

function gitPath(webRoot: string, flag: string): string {
  const r = spawnSync('git', ['-C', webRoot, 'rev-parse', '--path-format=absolute', flag], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function cksum(text: string): string {
  // POSIX cksum (CRC-32 of the bytes followed by the length) as ctl.sh derives the worktree id.
  let crc = 0
  const table: number[] = []
  for (let i = 0; i < 256; i += 1) { let c = i << 24; for (let k = 0; k < 8; k += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; table.push(c >>> 0) }
  const bytes = Buffer.from(text, 'utf8')
  for (const b of bytes) crc = ((crc << 8) ^ (table[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0
  let len = bytes.length
  while (len > 0) { crc = ((crc << 8) ^ (table[((crc >>> 24) ^ (len & 0xff)) & 0xff] ?? 0)) >>> 0; len >>>= 8 }
  return String((~crc) >>> 0)
}

/** Python `ctl.sh` preamble: file locations, with worktree isolation when this checkout is a git worktree. */
export function ctlPaths(ctx: CtlContext): CtlPaths {
  const env = ctx.env
  const hermesHome = resolve((env.HERMES_HOME ?? '').trim() || join(ctx.home, '.hermes'))
  const isolate = (env.HERMES_WEBUI_CTL_ISOLATE_WORKTREE ?? 'auto').trim()
  let worktreeMode = isolate === '1'
  if (isolate !== '1' && isolate !== '0') {
    const gitDir = gitPath(ctx.webRoot, '--git-dir')
    const common = gitPath(ctx.webRoot, '--git-common-dir')
    worktreeMode = Boolean(gitDir && common && gitDir !== common)
  }
  let runtimeBase: string | null = null
  let runtimeRoot = hermesHome
  if (worktreeMode) {
    runtimeBase = join((env.XDG_RUNTIME_DIR ?? '').trim() || (env.TMPDIR ?? '').trim() || '/tmp', `hermes-webui-ctl-${String(userInfo().uid)}`)
    runtimeRoot = join(runtimeBase, cksum(ctx.webRoot))
  }
  let logFile = (env.HERMES_WEBUI_LOG_FILE ?? '').trim() || join(runtimeRoot, 'webui.log')
  if (!logFile.startsWith('/')) logFile = resolve(logFile)
  return {
    hermesHome, runtimeRoot, runtimeBase, worktreeMode,
    pidFile: (env.HERMES_WEBUI_PID_FILE ?? '').trim() || join(runtimeRoot, 'webui.pid'),
    logFile,
    stateFile: (env.HERMES_WEBUI_CTL_STATE_FILE ?? '').trim() || join(runtimeRoot, 'webui.ctl.env'),
    stateDir: (env.HERMES_WEBUI_STATE_DIR ?? '').trim() || join(runtimeRoot, 'webui'),
    // An override names the only job to probe; otherwise the current default, then the label upgraded installs still carry.
    launchdLabels: (env.HERMES_WEBUI_LAUNCHD_LABEL ?? '').trim() ? [(env.HERMES_WEBUI_LAUNCHD_LABEL ?? '').trim()] : ['dev.kil.talaria.web', 'com.parantoux.hermes-webui'],
  }
}

function ensureHome(p: CtlPaths): void {
  if (p.worktreeMode && p.runtimeBase) {
    if (existsSync(p.runtimeBase) && lstatSync(p.runtimeBase).isSymbolicLink()) throw new Error(`Refusing unsafe runtime directory symlink: ${p.runtimeBase}`)
    mkdirSync(p.runtimeBase, { recursive: true, mode: 0o700 })
    if (statSync(p.runtimeBase).uid !== userInfo().uid) throw new Error(`Refusing unsafe runtime directory not owned by the current user: ${p.runtimeBase}`)
    chmodSync(p.runtimeBase, 0o700)
  }
  for (const dir of [p.hermesHome, p.runtimeRoot, p.stateDir]) mkdirSync(dir, { recursive: true })
  if (p.worktreeMode) { chmodSync(p.runtimeRoot, 0o700); chmodSync(p.stateDir, 0o700) }
}

// ── state files ──────────────────────────────────────────────────────────

export interface CtlState { PID?: string; REPO_ROOT?: string; NODE_EXE?: string; HOST?: string; PORT?: string; LOG_FILE?: string; STATE_DIR?: string; STARTED_AT?: string }

const shellQuote = (v: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`)

function writeState(p: CtlPaths, state: Required<Omit<CtlState, 'STARTED_AT'>> & { STARTED_AT: string }): void {
  writeFileSync(p.stateFile, Object.entries(state).map(([k, v]) => `${k}=${shellQuote(v)}\n`).join(''))
}

export function readState(p: CtlPaths): CtlState {
  if (!existsSync(p.stateFile)) return {}
  const out: CtlState = {}
  for (const line of readFileSync(p.stateFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq) as keyof CtlState
    let value = line.slice(eq + 1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/'\\''/g, "'")
    out[key] = value
  }
  return out
}

function pidFromFile(p: CtlPaths): number | null {
  if (!existsSync(p.pidFile)) return null
  const raw = readFileSync(p.pidFile, 'utf8').trim()
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function procArgs(pid: number): string {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** Python `_is_owned_webui_pid`: the state file names this checkout and the process command line references our bin or node. */
function isOwnedPid(p: CtlPaths, ctx: CtlContext, pid: number): boolean {
  const state = readState(p)
  if (!state.REPO_ROOT || resolve(state.REPO_ROOT) !== resolve(ctx.webRoot)) return false
  const args = procArgs(pid)
  if (!args) return false
  const serve = ctx.serveCommand.slice(1).join(' ')
  // A reused PID belonging to an unrelated Node process must not be treated as ours: the command line has to name this checkout or the serve bin.
  return args.includes(ctx.webRoot) || (Boolean(serve) && args.includes(serve))
}

function currentPid(p: CtlPaths, ctx: CtlContext): number | null {
  const pid = pidFromFile(p)
  return pid !== null && isAlive(pid) && isOwnedPid(p, ctx, pid) ? pid : null
}

function clearStalePid(p: CtlPaths, log: (line: string) => void): void {
  if (!existsSync(p.pidFile)) return
  rmSync(p.pidFile, { force: true })
  rmSync(p.stateFile, { force: true })
  log(`[ctl] Removed stale PID file: ${p.pidFile}`)
}

// ── probes ───────────────────────────────────────────────────────────────

export function probeTargetHost(host: string): string {
  if (host === '0.0.0.0' || host === '' || host === '::') return '127.0.0.1'
  if (host.startsWith('[')) return host
  return host.includes(':') ? `[${host}]` : host
}

function anyHttpAnswer(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'GET', timeout: 2000, rejectUnauthorized: false }, (res) => { res.resume(); resolve(true) })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => { resolve(false) })
    req.end()
  })
}

/** Python `_port_answers_http`: anything answering an HTTP(S) request on host:port is a responder. */
export async function portAnswersHttp(host: string, port: number): Promise<boolean> {
  for (const scheme of ['http', 'https']) if (await anyHttpAnswer(`${scheme}://${host}:${String(port)}/health`)) return true
  return false
}

function healthBody(url: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: 'GET', timeout: 2000, rejectUnauthorized: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => { try { resolve(res.statusCode === 200 ? (JSON.parse(body) as Record<string, unknown>) : null) } catch { resolve(null) } })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => { resolve(null) })
    req.end()
  })
}

export async function healthLine(host: string, port: number, tls: boolean): Promise<string> {
  const scheme = tls ? 'https' : 'http'
  const url = `${scheme}://${host}:${String(port)}/health`
  const data = (await healthBody(url)) ?? (tls ? await healthBody(`http://${host}:${String(port)}/health`) : null)
  if (!data) return `unreachable (${url})`
  const status = str(data.status) || 'ok'
  return status === 'ok' ? `ok (${str(data.sessions) || '?'} sessions, ${str(data.active_streams) || '?'} active streams)` : status
}

/** Python `_port_is_bindable`: nothing accepts on the port and a listener can bind it. */
export function portIsBindable(host: string, port: number): Promise<boolean> {
  const connectHost = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' ? '::1' : host.replace(/^\[|\]$/g, '')
  return new Promise((resolve) => {
    const probe = netConnect({ host: connectHost, port })
    probe.setTimeout(200)
    const bindCheck = (): void => {
      const server = createServer()
      server.once('error', () => { resolve(false) })
      server.listen(port, host || undefined, () => { server.close(() => { resolve(true) }) })
    }
    probe.once('connect', () => { probe.destroy(); resolve(false) })
    probe.once('timeout', () => { probe.destroy(); bindCheck() })
    probe.once('error', () => { bindCheck() })
  })
}

function pidListensOnPort(pid: number, port: number): 0 | 1 | 2 {
  const lsof = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${String(port)}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  if (!lsof.error) return lsof.status === 0 ? 0 : 1
  const ss = spawnSync('ss', ['-tlnp'], { encoding: 'utf8' })
  if (ss.error || ss.status !== 0) return 2
  const rows = ss.stdout.split('\n').filter((row) => new RegExp(`:${String(port)}$`).test(row.split(/\s+/)[3] ?? ''))
  if (!rows.length) return 1
  if (rows.some((r) => r.includes(`pid=${String(pid)},`))) return 0
  return rows.some((r) => r.includes('pid=')) ? 1 : 2
}

/** Python `_launchd_webui_pid`: a launchd job with one of our labels listening on the wanted port blocks a second instance. */
export function launchdConflictPid(p: CtlPaths, env: Record<string, string | undefined>, wantPort: number): { pid: number; label: string } | null {
  if (truthy(env.HERMES_WEBUI_CTL_ALLOW_LAUNCHD_CONFLICT)) return null
  for (const label of p.launchdLabels) {
    const pid = launchdJobPid(label, wantPort)
    if (pid !== null) return { pid, label }
  }
  return null
}

function launchdJobPid(label: string, wantPort: number): number | null {
  const out = spawnSync('launchctl', ['print', `gui/${String(userInfo().uid)}/${label}`], { encoding: 'utf8' })
  if (out.error || out.status !== 0) return null
  const m = /^\s*pid = (\d+)/m.exec(out.stdout)
  const pid = m ? Number.parseInt(m[1] ?? '0', 10) : 0
  if (!pid || !isAlive(pid)) return null
  const listens = pidListensOnPort(pid, wantPort)
  if (listens === 0) return pid
  if (listens === 1) return null
  return wantPort === 8787 ? pid : null
}

function systemdUnitPort(scope: string, unit: string): string {
  const env = spawnSync('systemctl', [scope, 'show', '-p', 'Environment', '--value', unit], { encoding: 'utf8' })
  const m1 = /HERMES_WEBUI_PORT=(\d+)/.exec(env.stdout || '')
  if (m1) return m1[1] ?? ''
  const exec = spawnSync('systemctl', [scope, 'show', '-p', 'ExecStart', '--value', unit], { encoding: 'utf8' })
  const m2 = /--port[=\s](\d+)/.exec(exec.stdout || '')
  return m2 ? (m2[1] ?? '') : ''
}

/** Python `_systemd_webui_conflict`: an active or auto-restarting unit that owns our port. */
export function systemdConflict(env: Record<string, string | undefined>, wantPort: number): string | null {
  if (truthy(env.HERMES_WEBUI_CTL_ALLOW_SYSTEMD_CONFLICT)) return null
  const unit = (env.HERMES_WEBUI_SYSTEMD_UNIT ?? '').trim() || 'hermes-webui.service'
  for (const scope of ['--system', '--user']) {
    const state = spawnSync('systemctl', [scope, 'show', '-p', 'ActiveState', '--value', unit], { encoding: 'utf8' })
    if (state.error || state.status !== 0) continue
    const active = state.stdout.trim()
    if (active === 'active') {
      const mainPid = Number.parseInt(spawnSync('systemctl', [scope, 'show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8' }).stdout.trim() || '0', 10) || 0
      if (mainPid > 0) {
        const listens = pidListensOnPort(mainPid, wantPort)
        if (listens === 0) return `unit ${unit} is active (MainPID ${String(mainPid)} listens on port ${String(wantPort)})`
        if (listens === 1) continue
      }
      const unitPort = systemdUnitPort(scope, unit)
      if (unitPort) { if (unitPort === String(wantPort)) return `unit ${unit} is active (configured for port ${unitPort})` }
      else if (wantPort === 8787) return `unit ${unit} is active`
    } else if (active === 'activating' || active === 'reloading') {
      const unitPort = systemdUnitPort(scope, unit)
      if (unitPort) { if (unitPort === String(wantPort)) return `unit ${unit} is ${active} (auto-restart pending on port ${unitPort})` }
      else if (wantPort === 8787) return `unit ${unit} is ${active} (auto-restart pending)`
    }
  }
  return null
}

function listenerDiag(port: number): string {
  const ss = spawnSync('ss', ['-tlnp'], { encoding: 'utf8' })
  if (!ss.error && ss.status === 0) { const row = ss.stdout.split('\n').find((r) => new RegExp(`:${String(port)}$`).test(r.split(/\s+/)[3] ?? '')); if (row) return row.trim() }
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  if (!lsof.error && lsof.status === 0) return (lsof.stdout.split('\n')[1] ?? '').trim()
  return ''
}

// ── argument parsing ─────────────────────────────────────────────────────

export function parseLaunchBinding(argv: string[], env: Record<string, string | undefined>): { host: string; port: number; portExplicit: boolean; passthrough: string[] } {
  let host = (env.HERMES_WEBUI_HOST ?? '').trim() || '127.0.0.1'
  let port = Number.parseInt((env.HERMES_WEBUI_PORT ?? '').trim() || (env.HERMES_WEBUI_CTL_PORT_START ?? '').trim() || '8787', 10) || 8787
  let portExplicit = Boolean((env.HERMES_WEBUI_PORT ?? '').trim())
  const passthrough: string[] = []
  let sawPort = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--host') { host = argv[i + 1] ?? host; i += 1 }
    else if (arg.startsWith('--host=')) host = arg.slice('--host='.length)
    else if (arg.startsWith('--')) passthrough.push(arg)
    else if (!sawPort && /^\d+$/.test(arg)) { port = Number.parseInt(arg, 10); portExplicit = true; sawPort = true }
    else passthrough.push(arg)
  }
  return { host, port, portExplicit, passthrough }
}

// ── commands ─────────────────────────────────────────────────────────────

function applyDotenv(ctx: CtlContext, p: CtlPaths): void {
  loadLauncherDotenv({ env: ctx.env, repoEnvFile: join(ctx.webRoot, '.env'), hermesEnvFile: join(p.hermesHome, '.env'), log: ctx.warn })
}

export async function startCmd(ctx: CtlContext, argv: string[]): Promise<number> {
  // The checkout `.env` may define HERMES_HOME, so it loads before the paths are resolved.
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const p = ctlPaths(ctx)
  ensureHome(p)
  ctx.env.HERMES_WEBUI_STATE_DIR = (ctx.env.HERMES_WEBUI_STATE_DIR ?? '').trim() || p.stateDir
  mkdirSync(ctx.env.HERMES_WEBUI_STATE_DIR, { recursive: true })
  const binding = parseLaunchBinding(argv, ctx.env)
  const existing = currentPid(p, ctx)
  if (existing !== null) {
    const state = readState(p)
    ctx.log(`[ctl] Talaria Web is already running (PID ${String(existing)})`)
    printCoordinates(ctx, state.HOST ?? binding.host, Number.parseInt(state.PORT ?? '', 10) || binding.port)
    return 0
  }
  let port = binding.port
  if (p.worktreeMode && !binding.portExplicit) {
    // Python `_select_next_worktree_port`: the first bindable port from the start port.
    let found = false
    for (; port <= 65535; port += 1) if (await portIsBindable(binding.host, port)) { found = true; break }
    if (!found) { ctx.warn('[ctl] No free WebUI port is available'); return 1 }
  }
  ctx.env.HERMES_WEBUI_HOST = binding.host
  ctx.env.HERMES_WEBUI_PORT = String(port)
  const launchd = launchdConflictPid(p, ctx.env, port)
  if (launchd !== null) {
    ctx.warn(`[ctl] Refusing to start a second Talaria Web while launchd job ${launchd.label} is running (PID ${String(launchd.pid)}).`)
    ctx.warn(`[ctl] Use launchctl kickstart -k gui/${String(userInfo().uid)}/${launchd.label} or disable the launchd job before using talaria-web ctl start.`)
    return 2
  }
  const systemd = systemdConflict(ctx.env, port)
  if (systemd) {
    ctx.warn(`[ctl] Refusing to start a second Talaria Web: systemd ${systemd}.`)
    ctx.warn(`[ctl] Manage that instance with systemctl instead, or disable the unit before using talaria-web ctl start. Set HERMES_WEBUI_CTL_ALLOW_SYSTEMD_CONFLICT=1 to override.`)
    return 2
  }
  const probeHost = probeTargetHost(binding.host)
  if (!truthy(ctx.env.HERMES_WEBUI_CTL_ALLOW_PORT_CONFLICT) && (await portAnswersHttp(probeHost, port))) {
    ctx.warn(`[ctl] Refusing to start: a live server is already responding on ${probeHost}:${String(port)}.`)
    const diag = listenerDiag(port)
    if (diag) ctx.warn(`[ctl]   listener: ${diag}`)
    ctx.warn('[ctl] Stop that instance first (its own supervisor may restart it; check systemctl/launchctl).')
    return 2
  }
  clearStalePid(p, () => undefined)
  const fd = openSync(p.logFile, 'a')
  const [cmd, ...args] = ctx.serveCommand
  const child = spawn(cmd ?? process.execPath, [...args, '--foreground', '--no-browser', '--host', binding.host, String(port), ...binding.passthrough], {
    cwd: ctx.webRoot, env: { ...ctx.env, HERMES_WEBUI_PRESERVE_ENV: '1', HERMES_WEBUI_LOG_FILE: p.logFile }, stdio: ['ignore', fd, fd], detached: true,
  })
  closeSync(fd)
  const pid = child.pid ?? 0
  child.unref()
  writeFileSync(p.pidFile, `${String(pid)}\n`)
  writeState(p, { PID: String(pid), REPO_ROOT: ctx.webRoot, NODE_EXE: cmd ?? process.execPath, HOST: binding.host, PORT: String(port), LOG_FILE: p.logFile, STATE_DIR: ctx.env.HERMES_WEBUI_STATE_DIR, STARTED_AT: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') })
  let grace = Number.parseInt((ctx.env.HERMES_WEBUI_START_GRACE ?? '').trim() || '3', 10)
  if (!Number.isFinite(grace) || grace <= 0) grace = 3
  let healthy = false
  const failed = (): number => { ctx.warn(`[ctl] Talaria Web failed to stay running. Log: ${p.logFile}`); rmSync(p.pidFile, { force: true }); rmSync(p.stateFile, { force: true }); return 1 }
  for (let step = 0; step < grace * 4; step += 1) {
    if (!isAlive(pid)) return failed()
    if (await anyHttpAnswer(`http://${probeHost}:${String(port)}/health`) || await anyHttpAnswer(`https://${probeHost}:${String(port)}/health`)) { healthy = true; break }
    await sleep(250)
  }
  if (!isAlive(pid)) return failed()
  ctx.log(`[ctl] Started Talaria Web (PID ${String(pid)})`)
  ctx.log(`[ctl] Bound: ${binding.host}:${String(port)}`)
  ctx.log(`[ctl] Log: ${p.logFile}`)
  printCoordinates(ctx, binding.host, port)
  if (!healthy) ctx.log(`[ctl] Note: /health did not respond within ${String(grace)}s; check 'talaria-web ctl status' shortly.`)
  return 0
}

function printCoordinates(ctx: CtlContext, host: string, port: number): void {
  const tls = Boolean((ctx.env.HERMES_WEBUI_TLS_CERT ?? '').trim()) && Boolean((ctx.env.HERMES_WEBUI_TLS_KEY ?? '').trim())
  const scheme = tls ? 'https' : 'http'
  ctx.log(`HERMES_WEBUI_PORT=${String(port)}`)
  ctx.log(`HERMES_WEBUI_URL=${scheme}://${probeTargetHost(host)}:${String(port)}`)
}

async function warnIfUnmanaged(ctx: CtlContext, p: CtlPaths): Promise<void> {
  const state = readState(p)
  const host = state.HOST ?? (ctx.env.HERMES_WEBUI_HOST ?? '').trim() ?? '127.0.0.1'
  const port = Number.parseInt(state.PORT ?? (ctx.env.HERMES_WEBUI_PORT ?? '').trim() ?? '8787', 10) || 8787
  const probeHost = probeTargetHost(host || '127.0.0.1')
  if (await portAnswersHttp(probeHost, port)) {
    ctx.warn(`[ctl] Warning: an instance NOT managed by talaria-web ctl is still serving ${probeHost}:${String(port)}; not touching it.`)
    const diag = listenerDiag(port)
    if (diag) ctx.warn(`[ctl]   listener: ${diag}`)
    ctx.warn('[ctl] If it is supervised (systemd/launchd), stop or restart it there instead.')
  }
}

export async function stopCmd(ctx: CtlContext): Promise<number> {
  // Same `.env` order as `start`: HERMES_HOME / PID-file overrides must resolve to the same daemon it started.
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const p = ctlPaths(ctx)
  ensureHome(p)
  const pid = pidFromFile(p)
  if (pid === null) {
    ctx.log('[ctl] Talaria Web is stopped')
    await warnIfUnmanaged(ctx, p)
    rmSync(p.pidFile, { force: true }); rmSync(p.stateFile, { force: true })
    return 0
  }
  if (!isAlive(pid) || !isOwnedPid(p, ctx, pid)) { await warnIfUnmanaged(ctx, p); clearStalePid(p, ctx.log); return 0 }
  ctx.log(`[ctl] Stopping Talaria Web (PID ${String(pid)})`)
  try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  for (let i = 0; i < 50; i += 1) {
    if (!isAlive(pid)) { rmSync(p.pidFile, { force: true }); rmSync(p.stateFile, { force: true }); ctx.log('[ctl] Stopped'); return 0 }
    await sleep(100)
  }
  ctx.warn('[ctl] Process did not exit after SIGTERM; sending SIGKILL')
  // The daemon is its own process group (detached supervisor + worker): kill the group so the worker cannot keep the port.
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  rmSync(p.pidFile, { force: true }); rmSync(p.stateFile, { force: true })
  return 0
}

export async function statusCmd(ctx: CtlContext): Promise<number> {
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const p = ctlPaths(ctx)
  ensureHome(p)
  const state = readState(p)
  const host = state.HOST ?? ((ctx.env.HERMES_WEBUI_HOST ?? '').trim() || '127.0.0.1')
  const port = Number.parseInt(state.PORT ?? ((ctx.env.HERMES_WEBUI_PORT ?? '').trim() || '8787'), 10) || 8787
  const tls = Boolean((ctx.env.HERMES_WEBUI_TLS_CERT ?? '').trim()) && Boolean((ctx.env.HERMES_WEBUI_TLS_KEY ?? '').trim())
  const pid = currentPid(p, ctx)
  if (pid !== null) {
    const etime = spawnSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' }).stdout.trim()
    ctx.log('● talaria-web — running')
    ctx.log(`  PID:     ${String(pid)}`)
    ctx.log(`  Uptime:  ${etime || 'unknown'}`)
    ctx.log(`  Bound:   ${host}:${String(port)}`)
    ctx.log(`  Log:     ${p.logFile}`)
    ctx.log(`  Health:  ${await healthLine(probeTargetHost(host), port, tls)}`)
    return 0
  }
  if (existsSync(p.pidFile)) clearStalePid(p, () => undefined)
  const probeHost = probeTargetHost(host)
  if (await portAnswersHttp(probeHost, port)) {
    ctx.log('● talaria-web — running (not managed by talaria-web ctl)')
    ctx.log('  PID:     -')
    const diag = listenerDiag(port)
    if (diag) ctx.log(`  Listener: ${diag}`)
    ctx.log(`  Bound:   ${host}:${String(port)}`)
    ctx.log(`  Log:     ${p.logFile}`)
    ctx.log(`  Health:  ${await healthLine(probeHost, port, tls)}`)
    ctx.log('  Note:    manage it via its own supervisor (systemctl/launchctl) or the process directly.')
    return 0
  }
  ctx.log('● talaria-web — stopped')
  ctx.log('  PID:     -')
  ctx.log(`  Bound:   ${host}:${String(port)}`)
  ctx.log(`  Log:     ${p.logFile}`)
  ctx.log('  Health:  not checked')
  return 0
}

export function logsCmd(ctx: CtlContext, argv: string[]): number {
  loadStartupEnv({ env: ctx.env, webRoot: ctx.webRoot, home: ctx.home, log: ctx.warn })
  const p = ctlPaths(ctx)
  ensureHome(p)
  let lines = 100
  let follow = true
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--lines') { const v = argv[i + 1] ?? ''; if (!/^\d+$/.test(v)) { ctx.warn('[ctl] --lines requires a number'); return 2 } lines = Number.parseInt(v, 10); i += 1 }
    else if (arg.startsWith('--lines=')) { const v = arg.slice('--lines='.length); if (!/^\d+$/.test(v)) { ctx.warn('[ctl] --lines requires a number'); return 2 } lines = Number.parseInt(v, 10) }
    else if (arg === '--follow' || arg === '-f') follow = true
    else if (arg === '--no-follow') follow = false
    else { ctx.warn(`[ctl] Unknown logs option: ${arg}`); return 2 }
  }
  if (!existsSync(p.logFile)) writeFileSync(p.logFile, '')
  const result = spawnSync('tail', follow ? ['-n', String(lines), '-f', p.logFile] : ['-n', String(lines), p.logFile], { stdio: 'inherit' })
  return result.status ?? 0
}

export function startRemoteCmd(ctx: CtlContext, argv: string[]): number {
  const p = ctlPaths(ctx)
  applyDotenv(ctx, p)
  const proxy = (ctx.env.HERMES_WEBUI_DEV_PROXY ?? '').trim()
  if (!proxy) { ctx.warn('[ctl] HERMES_WEBUI_DEV_PROXY must be set in .env for --remote.'); return 2 }
  if (!/^https?:\/\//.test(proxy)) { ctx.warn('[ctl] HERMES_WEBUI_DEV_PROXY must start with http:// or https://.'); return 2 }
  const frontend = join(ctx.webRoot, 'packages', 'frontend')
  if (!existsSync(join(ctx.webRoot, 'node_modules'))) { ctx.warn("[ctl] Frontend dependencies are missing. Run 'npm ci' in web/ first."); return 2 }
  ctx.log('[ctl] Starting local frontend against HERMES_WEBUI_DEV_PROXY')
  ctx.log('[ctl] Note: passkey-only authentication cannot be used from a loopback frontend.')
  ctx.log('[ctl] Press Ctrl-C to stop')
  try {
    execFileSync('npm', ['run', 'dev', '--', '--host', '127.0.0.1', ...argv], { cwd: frontend, stdio: 'inherit', env: ctx.env })
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? 1
  }
}

export const CTL_USAGE = `Usage: talaria-web ctl <command> [args]

Commands:
  start [launcher args...]    Start Talaria Web as a background daemon
  start --remote [vite args...]
                              Start the local frontend against a configured WebUI
  stop                        Stop the daemon started by ctl
  restart [launcher args...]  Stop, then start again
  status                      Show daemon, host/port, log, and health status
  logs [--lines N] [--follow|--no-follow]
                              Show the daemon log (defaults to tail -n 100 -f)
`

export async function runCtl(ctx: CtlContext, argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'start': return rest[0] === '--remote' ? startRemoteCmd(ctx, rest.slice(1)) : startCmd(ctx, rest)
    case 'stop': return stopCmd(ctx)
    case 'restart': {
      if (rest[0] === '--remote') { ctx.warn("[ctl] Remote frontend mode stays attached; stop it with Ctrl-C, then run 'talaria-web ctl start --remote' again."); return 2 }
      const stopped = await stopCmd(ctx)
      if (stopped !== 0) return stopped
      return startCmd(ctx, rest)
    }
    case 'status': return statusCmd(ctx)
    case 'logs': return logsCmd(ctx, rest)
    case undefined: case '-h': case '--help': case 'help': ctx.log(CTL_USAGE); return 0
    default: ctx.warn(`[ctl] Unknown command: ${cmd}`); ctx.warn(CTL_USAGE); return 2
  }
}
