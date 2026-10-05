/**
 * Embedded PTY terminals via `node-pty` (Python `api/terminal.py`): `$SHELL -i`,
 * env allowlist, resize clamp 8..80 × 20..240, 2000-line backlog with seq
 * replay, 32-terminal cap, SIGHUP→SIGKILL teardown, 900 s idle reap.
 */
import { accessSync, chmodSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { str } from '../util.js'

export interface TerminalItem { seq: number; event: 'output' | 'terminal_closed' | 'terminal_error'; data: Record<string, unknown> }

export interface PtyProcessLike { pid: number; write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: (signal?: string) => void; onData: (cb: (data: string) => void) => void; onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void; /** node-pty `UnixTerminal.destroy`: closes the pty master. */ destroy?: () => void; /** Signal the shell's whole process group (Python `os.killpg`); absent on test doubles, which get `kill`. */ killGroup?: (signal: NodeJS.Signals) => void }
export interface PtyModuleLike { spawn: (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyProcessLike }

export const BACKLOG_MAX = 2000
const MAX_TERMINALS = 32
const IDLE_GRACE_MS = 900_000
/** How long an exited terminal stays attachable so a viewer that connects late still replays its output and exit code. */
export const CLOSED_RETENTION_MS = 60_000
const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])

/**
 * node-pty 1.1.0 publishes its macOS prebuilt `spawn-helper` without the execute bit and no install script
 * sets it, so every spawn fails with `posix_spawnp failed`. Repair it once per process; best effort, since an
 * unwritable install still surfaces node-pty's own spawn error.
 */
export function ensureSpawnHelperExecutable(ptyRoot: string, platform: string = process.platform, arch: string = process.arch): void {
  const helper = join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper')
  try {
    if (!existsSync(helper)) return
    accessSync(helper, fsConstants.X_OK)
  } catch {
    try { chmodSync(helper, statSync(helper).mode | 0o111) } catch { /* not ours to change */ }
  }
}

export function loadPty(): PtyModuleLike | null {
  try {
    const require = createRequire(import.meta.url)
    const pty = require('node-pty') as PtyModuleLike
    ensureSpawnHelperExecutable(dirname(require.resolve('node-pty/package.json')))
    // node-pty's `kill` signals the shell pid only; Python `killpg`'d the group so background jobs got the HUP too.
    return { spawn: (file, args, opts) => { const proc = pty.spawn(file, args, opts); proc.killGroup = (signal) => { try { process.kill(-proc.pid, signal) } catch { proc.kill(signal) } }; return proc } }
  } catch {
    return null
  }
}

/** `shutil.which`: the first PATH entry holding an executable regular file of that name. */
function which(name: string, env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try { accessSync(candidate, fsConstants.X_OK); if (statSync(candidate).isFile()) return candidate } catch { /* next */ }
  }
  return null
}

/** Python `_shell_path`: `$SHELL` when it exists, else `which("zsh") or which("bash") or which("sh")`, else `/bin/sh`. */
export function shellPath(env: Record<string, string | undefined>): string {
  const shell = env.SHELL ?? ''
  if (shell && existsSync(shell)) return shell
  return which('zsh', env) ?? which('bash', env) ?? which('sh', env) ?? '/bin/sh'
}

/** Python `int(value or default)`: numbers truncate, booleans are 1/0, strings must be integer literals. */
export function pyIntOr(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '' || value === false || value === 0) return fallback
  if (typeof value === 'boolean') return 1
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`cannot convert float ${String(value)} to integer`); return Math.trunc(value) }
  const text = str(value).trim()
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(text)) throw new Error(`invalid literal for int() with base 10: '${str(value)}'`)
  return Number.parseInt(text, 10)
}

export function shellArgv(shell: string): string[] {
  return ['zsh', 'bash', 'sh'].includes(basename(shell)) ? ['-i'] : []
}

export class TerminalSession {
  rows = 24
  cols = 80
  closed = false
  /** When the shell exited or was torn down (`now()` clock); null while alive. */
  closedAt: number | null = null
  exitCode: number | null = null
  /** Set once the pty reported the shell's exit; the teardown escalation only SIGKILLs a shell still running. */
  exited = false
  lastActivity: number
  unwatchedSince: number | null
  private nextSeq = 1
  private readonly backlog: TerminalItem[] = []
  private readonly subscribers = new Set<(item: TerminalItem) => void>()

  constructor(readonly sessionId: string, readonly workspace: string, readonly proc: PtyProcessLike, private readonly now: () => number) {
    this.lastActivity = now()
    this.unwatchedSince = now()
  }

  get isAlive(): boolean { return !this.closed }

  put(event: TerminalItem['event'], data: Record<string, unknown>): void {
    this.lastActivity = this.now()
    const item: TerminalItem = { seq: this.nextSeq++, event, data }
    this.backlog.push(item)
    if (this.backlog.length > BACKLOG_MAX) this.backlog.shift()
    for (const sub of this.subscribers) sub(item)
  }

  /** Attach a viewer: replay the backlog after `afterSeq`, then live items. */
  subscribe(afterSeq: number | null, onItem: (item: TerminalItem) => void): () => void {
    for (const item of this.backlog) if (afterSeq === null || item.seq > afterSeq) onItem(item)
    this.subscribers.add(onItem)
    this.unwatchedSince = null
    return () => {
      this.subscribers.delete(onItem)
      if (!this.subscribers.size) this.unwatchedSince = this.now()
    }
  }

  setSize(rows: unknown, cols: unknown): void {
    this.rows = Math.max(8, Math.min(pyIntOr(rows, this.rows) || this.rows || 24, 80))
    this.cols = Math.max(20, Math.min(pyIntOr(cols, this.cols) || this.cols || 80, 240))
    if (!this.closed) { try { this.proc.resize(this.cols, this.rows) } catch { /* pty gone */ } }
  }
}

export class TerminalRegistry {
  readonly terminals = new Map<string, TerminalSession>()
  private reaper: NodeJS.Timeout | null = null

  constructor(private readonly deps: { env: Record<string, string | undefined>; now: () => number; log: (line: string) => void; pty?: PtyModuleLike | null }) {}

  get supported(): boolean { return (this.deps.pty ?? loadPty()) !== null }

  private ensureReaper(): void {
    if (this.reaper) return
    this.reaper = setInterval(() => { this.reapIdle() }, 60_000)
    this.reaper.unref()
  }

  reapIdle(now = this.deps.now()): number {
    let reaped = 0
    for (const [sid, term] of this.terminals) {
      const idle = term.unwatchedSince !== null && now - term.unwatchedSince >= IDLE_GRACE_MS
      const retired = term.closed && term.closedAt !== null && now - term.closedAt >= CLOSED_RETENTION_MS
      if (idle || retired) { this.terminals.delete(sid); this.teardown(term); reaped += 1 }
    }
    return reaped
  }

  private enforceCap(excludeSid: string): void {
    while (this.terminals.size >= MAX_TERMINALS) {
      const candidates = [...this.terminals.entries()].filter(([sid]) => sid !== excludeSid)
      const victim = candidates.find(([, t]) => t.closed) ?? candidates.sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0]
      if (!victim) throw new Error('terminal capacity is busy')
      this.terminals.delete(victim[0])
      this.teardown(victim[1])
    }
  }

  start(sessionId: string, workspace: string, opts: { rows?: unknown; cols?: unknown; restart?: boolean } = {}): TerminalSession {
    const pty = this.deps.pty ?? loadPty()
    if (!pty) throw new Error('Embedded terminal is not supported: node-pty is unavailable')
    const sid = sessionId.trim()
    if (!sid) throw new Error('session_id is required')
    const cwd = resolve(workspace)
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('workspace is not a directory')
    const current = this.terminals.get(sid)
    if (current?.isAlive && !opts.restart && current.workspace === cwd) { current.setSize(opts.rows, opts.cols); return current }
    if (current) { this.terminals.delete(sid); this.teardown(current) }
    this.enforceCap(sid)
    // Python exported the requested (unclamped) size into the shell's environment and clamped only the winsize.
    const requestedRows = pyIntOr(opts.rows, 24)
    const requestedCols = pyIntOr(opts.cols, 80)
    const rows = Math.max(8, Math.min(requestedRows || 24, 80))
    const cols = Math.max(20, Math.min(requestedCols || 80, 240))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.deps.env)) if (SAFE_ENV_KEYS.has(k) && v !== undefined) env[k] = v
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', COLUMNS: String(requestedCols), LINES: String(requestedRows), PWD: cwd, HERMES_WEBUI_TERMINAL: '1' })
    const shell = shellPath(this.deps.env)
    const proc = pty.spawn(shell, shellArgv(shell), { name: 'xterm-256color', cols, rows, cwd, env })
    const term = new TerminalSession(sid, cwd, proc, this.deps.now)
    term.rows = rows
    term.cols = cols
    proc.onData((data) => { term.put('output', { text: data }) })
    proc.onExit(({ exitCode, signal }) => {
      term.exited = true
      if (term.closed) return
      term.closed = true
      term.closedAt = this.deps.now()
      // Python reported `proc.poll()`: a negative signal number for a shell killed by a signal.
      term.exitCode = signal ? -signal : exitCode
      try { proc.destroy?.() } catch { /* master already closed */ }
      // The entry stays attachable (backlog + exit code) until a viewer closes it or the reaper retires it.
      term.put('terminal_closed', { exit_code: term.exitCode })
    })
    this.terminals.set(sid, term)
    this.ensureReaper()
    return term
  }

  get(sessionId: string): TerminalSession | null {
    return this.terminals.get(sessionId) ?? null
  }

  write(sessionId: string, data: string): void {
    const term = this.terminals.get(sessionId)
    if (!term?.isAlive) throw new TerminalNotRunning()
    term.proc.write(data)
    term.lastActivity = this.deps.now()
  }

  resize(sessionId: string, rows: unknown, cols: unknown): void {
    const term = this.terminals.get(sessionId)
    if (!term) throw new TerminalNotRunning()
    term.setSize(rows, cols)
  }

  close(sessionId: string): boolean {
    const term = this.terminals.get(sessionId)
    if (!term) return false
    this.terminals.delete(sessionId)
    this.teardown(term)
    return true
  }

  /**
   * Close every terminal. `immediate` runs the Python `atexit` escalation synchronously (the process is exiting and
   * no timer will run): SIGHUP to each process group, up to 1.5 s for the shells to exit, then SIGKILL the survivors.
   */
  closeAll(opts: { immediate?: boolean } = {}): void {
    const terms = [...this.terminals.values()]
    this.terminals.clear()
    if (this.reaper) { clearInterval(this.reaper); this.reaper = null }
    if (!opts.immediate) { for (const term of terms) this.teardown(term); return }
    const live = terms.filter((t) => !t.closed)
    for (const term of live) { term.closed = true; term.closedAt = this.deps.now(); signalGroup(term.proc, 'SIGHUP') }
    const deadline = Date.now() + 1_500
    const sleeper = new Int32Array(new SharedArrayBuffer(4))
    // The exit callback cannot run while this loop blocks the event loop, so a real shell is probed directly.
    const alive = (t: TerminalSession): boolean => !t.exited && (t.proc.killGroup ? pidAlive(t.proc.pid) : true)
    while (Date.now() < deadline && live.some(alive)) Atomics.wait(sleeper, 0, 0, 50)
    for (const term of live) { if (alive(term)) signalGroup(term.proc, 'SIGKILL'); try { term.proc.destroy?.() } catch { /* closed */ } term.put('terminal_closed', { exit_code: term.exitCode }) }
  }

  /** Python `_teardown_terminal`: SIGHUP the group, wait 1.5 s, SIGKILL only if still alive, then close the master. */
  private teardown(term: TerminalSession): void {
    if (term.closed) return
    term.closed = true
    term.closedAt = this.deps.now()
    signalGroup(term.proc, 'SIGHUP')
    const escalate = (): void => { if (!term.exited) signalGroup(term.proc, 'SIGKILL'); try { term.proc.destroy?.() } catch { /* closed */ } }
    const killer = setTimeout(escalate, 1_500)
    killer.unref()
    term.put('terminal_closed', { exit_code: term.exitCode })
  }
}

function signalGroup(proc: PtyProcessLike, signal: NodeJS.Signals): void {
  try { if (proc.killGroup) proc.killGroup(signal); else proc.kill(signal) } catch { /* gone */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export class TerminalNotRunning extends Error {
  constructor() { super('terminal not running') }
}
