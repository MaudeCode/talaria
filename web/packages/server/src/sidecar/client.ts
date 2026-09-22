/**
 * Sidecar client: spawns `python -m talaria_sidecar` on the Agent venv, speaks
 * newline-delimited JSON-RPC 2.0 over its stdio, and restarts it on crash
 * (docs/architecture/sidecar-rpc.md).
 *
 * The server never imports Agent code; every Agent-backed capability is one
 * `call()` here. While the sidecar is absent, restarting, stale, or
 * incompatible, calls fail closed with a `SidecarError` whose `condition` the
 * HTTP layer forwards as the 503 `condition` field.
 */
import { delimiter } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  RPC_ERROR_CODES, RpcIncomingSchema, SIDECAR_METHODS, SIDECAR_RPC_VERSION,
  type RpcErrorObject, type RuntimeDescribe, type SidecarMethodName, type SidecarParams, type SidecarResult,
} from '@maudecode/talaria-web-contracts'

export class SidecarError extends Error {
  readonly code: number
  readonly condition: string
  readonly data: Record<string, unknown>

  constructor(message: string, opts: { code?: number; condition: string; data?: Record<string, unknown> }) {
    super(message)
    this.name = 'SidecarError'
    this.code = opts.code ?? RPC_ERROR_CODES.application
    this.condition = opts.condition
    this.data = opts.data ?? {}
  }

  static fromRpc(error: RpcErrorObject): SidecarError {
    const condition = error.data?.condition ?? (error.code === RPC_ERROR_CODES.cancelled ? 'cancelled' : 'sidecar_error')
    return new SidecarError(error.message, { code: error.code, condition, data: error.data ?? {} })
  }
}

export interface StreamFrame { seq: number; event: string; data: unknown }

export interface CallOptions {
  /** Receives every stream frame the sidecar emits for this request, in order. */
  onStream?: (frame: StreamFrame) => void
  signal?: AbortSignal
  /** Milliseconds before the call fails with `sidecar_timeout`; 0 disables. */
  timeoutMs?: number
}

export interface SidecarSpawnOptions {
  python: string
  /** Full spawn command; defaults to `<python> -m talaria_sidecar` (a scripted replay sidecar for contract runs). */
  command?: string[]
  agentDir: string
  sidecarDir: string
  hermesHome: string
  /** The environment to spawn with; a getter is read at every (re)start so runtime `.env` edits reach a restarted child. */
  env?: Record<string, string> | (() => Record<string, string>)
  log?: (line: string) => void
  /** Restart backoff schedule in milliseconds; the last value repeats. */
  backoffMs?: number[]
  /** How long the handshake may take before the child is treated as hung and restarted. */
  handshakeTimeoutMs?: number
}

/** The narrow interface the rest of the server depends on; `FakeSidecar` implements it too. */
export interface SidecarLike {
  readonly status: SidecarStatus
  readonly describe: RuntimeDescribe | null
  call<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts?: CallOptions): Promise<SidecarResult<M>>
  close(): Promise<void>
  /** Kill the child so it restarts from the current environment; pending calls fail with `sidecar_unavailable`. */
  recycle(reason: string): void
}

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'incompatible' | 'restarting'

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onStream?: ((frame: StreamFrame) => void) | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/** The configured environment (credentials, proxies, CA bundles) flows through as it did in-process in Python; the sidecar identity keys win. */
export function sidecarSpawnEnv(opts: Pick<SidecarSpawnOptions, 'env' | 'hermesHome' | 'agentDir' | 'sidecarDir'>): Record<string, string> {
  const env = typeof opts.env === 'function' ? opts.env() : opts.env
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...env,
    HERMES_HOME: opts.hermesHome,
    TALARIA_SIDECAR_AGENT_DIR: opts.agentDir,
    PYTHONPATH: env?.PYTHONPATH ? `${opts.sidecarDir}${delimiter}${env.PYTHONPATH}` : opts.sidecarDir,
    PYTHONUNBUFFERED: '1',
  }
}

export class SidecarClient implements SidecarLike {
  status: SidecarStatus = 'stopped'
  describe: RuntimeDescribe | null = null
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private restartAttempt = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly log: (line: string) => void

  constructor(private readonly opts: SidecarSpawnOptions) {
    this.log = opts.log ?? ((line) => { process.stderr.write(line + '\n') })
  }

  /** Spawn and handshake. Resolves with the handshake payload; rejects only on spawn failure. */
  async start(): Promise<RuntimeDescribe> {
    if (this.closed) throw new SidecarError('sidecar client closed', { condition: 'sidecar_unavailable' })
    this.status = 'starting'
    const [command, ...args] = this.opts.command ?? [this.opts.python, '-m', 'talaria_sidecar']
    const child = spawn(command ?? this.opts.python, args, {
      cwd: this.opts.sidecarDir,
      env: sidecarSpawnEnv(this.opts),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    if (!child.stdout || !child.stderr) throw new SidecarError('sidecar stdio pipes unavailable', { condition: 'sidecar_unavailable' })
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => { this.onLine(line) })
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity })
    stderr.on('line', (line) => { this.log(`[sidecar] ${line}`) })
    child.on('exit', (code, signal) => { this.onExit(child, code, signal) })
    // A spawn failure (missing executable, interpreter mid-replacement) emits `error` and `close` but no `exit`:
    // recover through the same path so a restart is scheduled; `onExit` ignores a child it already retired.
    child.on('error', (error) => { this.log(`[sidecar] spawn error: ${error.message}`); this.onExit(child, null, null) })
    // A request or cancel written to a child that just died surfaces as EPIPE on stdin; the exit handler owns recovery.
    child.stdin?.on('error', (error: Error) => { this.log(`[sidecar] stdin write failed: ${error.message}`) })

    try {
      const describe = await this.rawCall('runtime.handshake', { rpc_version: SIDECAR_RPC_VERSION }, { timeoutMs: this.opts.handshakeTimeoutMs ?? 60_000 })
      this.describe = describe
      this.status = describe.compatible && !describe.stale ? 'ready' : 'incompatible'
      this.restartAttempt = 0
      return describe
    } catch (error) {
      // A decoded version mismatch is final: the sidecar exits 3 on its own and restarting cannot help.
      if (error instanceof SidecarError && error.condition === 'sidecar_rpc_version_mismatch') {
        this.status = 'incompatible'
        throw error
      }
      // `incompatible` is reserved for a decoded handshake that says so (or the version-mismatch exit). A handshake
      // that hangs, fails to parse, or dies is operational: kill a still-running child so its exit schedules a restart.
      if (this.child === child && !this.closed) {
        this.log(`[sidecar] handshake failed: ${(error as Error).message}; restarting`)
        this.status = 'restarting'
        child.kill('SIGKILL')
      }
      throw error
    }
  }

  private onLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.log(`[sidecar] non-JSON stdout line: ${line.slice(0, 200)}`)
      return
    }
    const incoming = RpcIncomingSchema.safeParse(parsed)
    if (!incoming.success) {
      this.log(`[sidecar] invalid message: ${line.slice(0, 200)}`)
      return
    }
    const message = incoming.data
    if ('method' in message) {
      if (message.method === 'stream') {
        const frame = message.params as { id: number; seq: number; event: string; data: unknown }
        this.pending.get(frame.id)?.onStream?.({ seq: frame.seq, event: frame.event, data: frame.data })
      }
      return
    }
    if (message.id === null) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (pending.timer) clearTimeout(pending.timer)
    if ('error' in message) pending.reject(SidecarError.fromRpc(message.error))
    else pending.resolve(message.result)
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    this.log(`[sidecar] exited code=${code} signal=${signal ?? ''}`)
    const error = new SidecarError('sidecar exited', { condition: 'sidecar_unavailable', data: { code, signal } })
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    if (this.closed) { this.status = 'stopped'; return }
    if (code === 3 || this.status === 'incompatible') {
      // Version mismatch: restarting cannot help.
      this.status = 'incompatible'
      return
    }
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    this.status = 'restarting'
    const schedule = this.opts.backoffMs ?? DEFAULT_BACKOFF
    const delay = schedule[Math.min(this.restartAttempt, schedule.length - 1)] ?? 30_000
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch((error: unknown) => { this.log(`[sidecar] restart failed: ${String(error)}`) })
    }, delay)
    this.restartTimer.unref()
  }

  /** Typed call; fails closed with `sidecar_unavailable` unless the sidecar is ready. */
  call<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts: CallOptions = {}): Promise<SidecarResult<M>> {
    if (this.status !== 'ready' && !method.startsWith('runtime.') && method !== 'rpc.methods') {
      const condition = this.status === 'incompatible' ? (this.describe?.stale ? 'agent_runtime_stale' : 'agent_incompatible') : 'sidecar_unavailable'
      return Promise.reject(new SidecarError(`sidecar not ready (${this.status})`, { condition }))
    }
    return this.rawCall(method, params, opts)
  }

  private async rawCall<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts: CallOptions = {}): Promise<SidecarResult<M>> {
    // A signal that already fired never reaches the sidecar: the abort listener below would otherwise be installed
    // after the fact and the call (e.g. a `chat.start` behind an earlier await) would run to completion uncancelled.
    if (opts.signal?.aborted) throw new SidecarError(`sidecar call ${method} cancelled before it was sent`, { condition: 'cancelled' })
    const stdin = this.child?.stdin
    if (!stdin?.writable) throw new SidecarError('sidecar process is not running', { condition: 'sidecar_unavailable' })
    const schema = SIDECAR_METHODS[method]
    const id = this.nextId++
    const request = { jsonrpc: '2.0' as const, id, method, params: schema.params.parse(params) }
    const raw = await new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject, onStream: opts.onStream }
      if (opts.timeoutMs !== 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          this.sendCancel(id)
          reject(new SidecarError(`sidecar call ${method} timed out`, { condition: 'sidecar_timeout' }))
        }, opts.timeoutMs ?? 120_000)
        pending.timer.unref()
      }
      this.pending.set(id, pending)
      opts.signal?.addEventListener('abort', () => { this.sendCancel(id) }, { once: true })
      stdin.write(JSON.stringify(request) + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          if (pending.timer) clearTimeout(pending.timer)
          reject(new SidecarError(`sidecar write failed: ${error.message}`, { condition: 'sidecar_unavailable' }))
        }
      })
    })
    return schema.result.parse(raw) as SidecarResult<M>
  }

  private sendCancel(id: number): void {
    const child = this.child
    if (!child?.stdin?.writable) return
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'rpc.cancel', params: { id } }) + '\n')
  }

  recycle(reason: string): void {
    const child = this.child
    if (!child || this.closed) return
    this.log(`[sidecar] recycling: ${reason}`)
    this.status = 'restarting'
    child.kill('SIGKILL')
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    if (!child) { this.status = 'stopped'; return }
    await new Promise<void>((resolve) => {
      const done = () => { resolve() }
      child.once('exit', done)
      child.stdin?.end()
      setTimeout(() => { child.kill('SIGKILL'); done() }, 5_000).unref()
    })
    this.status = 'stopped'
  }
}
