/**
 * Embedded PTY terminals via `node-pty` (Python `api/terminal.py`): `$SHELL -i`,
 * env allowlist, resize clamp 8..80 × 20..240, 2000-line backlog with seq
 * replay, 32-terminal cap, SIGHUP→SIGKILL teardown, 900 s idle reap.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { str } from '../util.js'

export interface TerminalItem { seq: number; event: 'output' | 'terminal_closed' | 'terminal_error'; data: Record<string, unknown> }

export interface PtyProcessLike { pid: number; write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: (signal?: string) => void; onData: (cb: (data: string) => void) => void; onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void }
export interface PtyModuleLike { spawn: (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyProcessLike }

const BACKLOG_MAX = 2000
const MAX_TERMINALS = 32
const IDLE_GRACE_MS = 900_000
/** How long an exited terminal stays attachable so a viewer that connects late still replays its output and exit code. */
export const CLOSED_RETENTION_MS = 60_000
const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])

export function loadPty(): PtyModuleLike | null {
  try {
    return createRequire(import.meta.url)('node-pty') as PtyModuleLike
  } catch {
    return null
  }
}

export function shellPath(env: Record<string, string | undefined>): string {
  const shell = env.SHELL ?? ''
  if (shell && existsSync(shell)) return shell
  for (const dir of (env.PATH ?? '').split(':')) for (const name of ['zsh', 'bash', 'sh']) if (dir && existsSync(`${dir}/${name}`)) return `${dir}/${name}`
  return '/bin/sh'
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
    this.rows = Math.max(8, Math.min(Number.parseInt(str(rows ?? this.rows), 10) || this.rows || 24, 80))
    this.cols = Math.max(20, Math.min(Number.parseInt(str(cols ?? this.cols), 10) || this.cols || 80, 240))
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
    const rows = Math.max(8, Math.min(Number.parseInt(str(opts.rows ?? 24), 10) || 24, 80))
    const cols = Math.max(20, Math.min(Number.parseInt(str(opts.cols ?? 80), 10) || 80, 240))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.deps.env)) if (SAFE_ENV_KEYS.has(k) && v !== undefined) env[k] = v
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', COLUMNS: String(cols), LINES: String(rows), PWD: cwd, HERMES_WEBUI_TERMINAL: '1' })
    const shell = shellPath(this.deps.env)
    const proc = pty.spawn(shell, shellArgv(shell), { name: 'xterm-256color', cols, rows, cwd, env })
    const term = new TerminalSession(sid, cwd, proc, this.deps.now)
    term.rows = rows
    term.cols = cols
    proc.onData((data) => { term.put('output', { text: data }) })
    proc.onExit(({ exitCode }) => {
      if (term.closed) return
      term.closed = true
      term.closedAt = this.deps.now()
      term.exitCode = exitCode
      // The entry stays attachable (backlog + exit code) until a viewer closes it or the reaper retires it.
      term.put('terminal_closed', { exit_code: exitCode })
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

  /** Close every terminal; `immediate` also SIGKILLs the process groups now (the process is exiting and no timer will run). */
  closeAll(opts: { immediate?: boolean } = {}): void {
    for (const [sid, term] of this.terminals) { this.terminals.delete(sid); this.teardown(term, opts.immediate ?? false) }
    if (this.reaper) { clearInterval(this.reaper); this.reaper = null }
  }

  private teardown(term: TerminalSession, immediate = false): void {
    if (term.closed) return
    term.closed = true
    term.closedAt = this.deps.now()
    try { term.proc.kill('SIGHUP') } catch { /* gone */ }
    const pid = term.proc.pid
    const killGroup = (): void => { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
    if (immediate) { killGroup(); term.put('terminal_closed', { exit_code: term.exitCode }); return }
    const killer = setTimeout(killGroup, 1_500)
    killer.unref()
    term.put('terminal_closed', { exit_code: term.exitCode })
  }
}

export class TerminalNotRunning extends Error {
  constructor() { super('terminal not running') }
}
