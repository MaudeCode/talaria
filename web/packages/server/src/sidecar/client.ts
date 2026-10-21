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
import { delimiter, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  RPC_ERROR_CODES, RpcIncomingSchema, SIDECAR_METHODS, SIDECAR_RPC_VERSION,
  type AgentRuntimeMetadata, type ChatReadiness, type RpcErrorObject, type RuntimeDescribe, type SidecarMethodName, type SidecarParams, type SidecarResult,
} from '@maudecode/talaria-web-contracts'

import { AGENT_IMPORT_ENV } from './env.js'

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
  /** Resolve at every start so PM generation replacement is observed on sidecar-only restarts. */
  python: string | (() => string | null)
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
  /** Observe future validated handshakes, including import-failed runtimes that recovery can repair. */
  onHandshake?: (listener: (runtime: RuntimeDescribe) => void) => () => void
  /** Run `gate` now when ready, then after every compatible handshake before the sidecar reports ready again. */
  addReadyGate?: (gate: ReadyGate) => Promise<void>
}

/** Work a (re)started sidecar finishes before any caller sees it ready; a failure is logged and readiness proceeds. */
export type ReadyGate = (call: SidecarLike['call']) => Promise<void>

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'incompatible' | 'restarting'

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onStream?: ((frame: StreamFrame) => void) | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
}

/** Normalize typed sidecar evidence once for health, preflight, and journalled turn errors. */
export function runtimeFailureDetails(condition: string, data: Record<string, unknown> = {}): AgentRuntimeMetadata & { condition: string; type: string; message?: string } {
  const details: AgentRuntimeMetadata & { condition: string; type: string; message?: string } = { condition, type: condition }
  if (condition !== 'agent_runtime_stale') return details
  const state = typeof data.agent_update_state === 'string' ? data.agent_update_state : undefined
  details.agent_runtime_reason = state === 'active' ? 'update_active'
    : state === 'incomplete' ? 'recovery_incomplete'
      : state === 'unverified' && data.agent_source_changed === true ? 'source_changed' : 'unknown'
  details.message = {
    update_active: 'Agent update is in progress',
    recovery_incomplete: 'Agent update recovery is incomplete',
    source_changed: 'Agent source changed; check the update outcome before restarting Talaria Web',
    unknown: 'Agent runtime is unavailable; check the Agent update outcome',
  }[details.agent_runtime_reason]
  if (state !== undefined) details.agent_update_state = state
  details.retryable = typeof data.retryable === 'boolean' ? data.retryable : true
  details.restart_scheduled = typeof data.restart_scheduled === 'boolean' ? data.restart_scheduled : false
  return details
}

/** Whether Agent operations (chat turns) can run on `sidecar`, and the failure condition when they cannot. */
export function chatReadiness(sidecar: Pick<SidecarLike, 'status' | 'describe'> | null): ChatReadiness {
  if (sidecar?.status === 'ready') return { available: true, condition: null }
  if (sidecar?.status === 'incompatible') return sidecar.describe?.stale
    ? { available: false, ...runtimeFailureDetails('agent_runtime_stale', { agent_update_state: sidecar.describe.update_state, agent_source_changed: sidecar.describe.agent_source_changed }), condition: 'agent_runtime_stale' }
    : { available: false, condition: 'agent_incompatible' }
  return { available: false, condition: 'sidecar_unavailable' }
}

const DEFAULT_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
// A ready gate holds readiness back, so a hung gate call gives way.
const READY_GATE_TIMEOUT_MS = 30_000

/** Web's own keys (login password, OIDC secret, release token) stay out of the sidecar and its tool processes; only these reach it. */
const SIDECAR_WEB_KEYS = new Set(['HERMES_WEBUI_AGENT_DIR', 'HERMES_WEBUI_PYTHON'])
const isWebOnlyKey = (key: string) =>
  (key.startsWith('HERMES_WEBUI_') || key.startsWith('TALARIA_')) && !SIDECAR_WEB_KEYS.has(key) && !key.startsWith('TALARIA_SIDECAR_')

/** The configured environment (credentials, proxies, CA bundles) flows through as it did in-process in Python, minus Web-only keys; the sidecar identity keys win. */
export function sidecarSpawnEnv(opts: Pick<SidecarSpawnOptions, 'env' | 'hermesHome' | 'agentDir' | 'sidecarDir'>): Record<string, string> {
  const env = typeof opts.env === 'function' ? opts.env() : opts.env
  const home = env?.HOME ?? process.env.HOME ?? homedir()
  const state = (env?.HERMES_WEBUI_STATE_DIR ?? '').trim().replace(/^~(?=$|\/)/, home)
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !isWebOnlyKey(key))),
    ...AGENT_IMPORT_ENV,
    HERMES_HOME: opts.hermesHome,
    TALARIA_SIDECAR_WEB_STATE_DIR: resolve(state || resolve(opts.hermesHome, 'webui')),
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
  private runtimeStatusSequence = 0
  private readonly handshakeListeners = new Set<(runtime: RuntimeDescribe) => void>()
  private readonly readyGates = new Set<ReadyGate>()
  private readonly pending = new Map<number, Pending>()
  private restartAttempt = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly log: (line: string) => void

  constructor(private readonly opts: SidecarSpawnOptions) {
    this.log = opts.log ?? ((line) => { process.stderr.write(line + '\n') })
  }

  onHandshake(listener: (runtime: RuntimeDescribe) => void): () => void {
    this.handshakeListeners.add(listener)
    return () => { this.handshakeListeners.delete(listener) }
  }

  async addReadyGate(gate: ReadyGate): Promise<void> {
    this.readyGates.add(gate)
    if (this.status === 'ready') await this.runReadyGate(gate, (method, params, opts) => this.call(method, params, opts))
  }

  private async runReadyGate(gate: ReadyGate, call: SidecarLike['call']): Promise<void> {
    try { await gate(call) } catch (error) { this.log(`[sidecar] ready gate failed: ${String(error)}`) }
  }

  /** Every gate, on the raw channel: the status is not `ready` yet, so `call` would refuse Agent methods. */
  private async runReadyGates(): Promise<void> {
    for (const gate of [...this.readyGates]) await this.runReadyGate(gate, (method, params, opts) => this.rawCall(method, params, { timeoutMs: READY_GATE_TIMEOUT_MS, ...opts }))
  }

  /** Spawn and handshake. Resolves with the handshake payload; rejects only on spawn failure. */
  async start(): Promise<RuntimeDescribe> {
    if (this.closed) throw new SidecarError('sidecar client closed', { condition: 'sidecar_unavailable' })
    this.status = 'starting'
    this.describe = null
    const [command, ...args] = this.opts.command ?? [(typeof this.opts.python === 'function' ? this.opts.python() : this.opts.python) ?? '', '-m', 'talaria_sidecar']
    if (!command) {
      this.scheduleRestart()
      throw new SidecarError('Agent interpreter unavailable; retrying discovery', { condition: 'sidecar_unavailable' })
    }
    const child = spawn(command, args, {
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
      if (this.child !== child || this.closed) throw new SidecarError('sidecar handshake was superseded', { condition: 'sidecar_unavailable' })
      if (describe.rpc_version !== SIDECAR_RPC_VERSION) throw new SidecarError('sidecar RPC version mismatch', { condition: 'sidecar_rpc_version_mismatch' })
      if (describe.compatible && !describe.stale) {
        await this.runReadyGates()
        if (this.child !== child || this.closed) throw new SidecarError('sidecar handshake was superseded', { condition: 'sidecar_unavailable' })
      }
      this.describe = describe
      this.status = describe.compatible && !describe.stale ? 'ready' : 'incompatible'
      const tested = describe.agent_revision !== null ? describe.agent_revision === describe.pinned_revision : describe.agent_version === describe.pinned_version
      if (describe.compatible && !tested) this.log('[sidecar] This Agent version is not officially supported by Talaria and may cause issues.')
      this.restartAttempt = 0
      for (const listener of [...this.handshakeListeners]) {
        try { listener(describe) }
        catch (error) { this.log(`[sidecar] handshake observer failed: ${String(error)}`) }
      }
      return describe
    } catch (error) {
      // A decoded version mismatch is final: the sidecar exits 3 on its own and restarting cannot help.
      if (error instanceof SidecarError && error.condition === 'sidecar_rpc_version_mismatch') {
        this.status = 'incompatible'
        if (this.child === child) child.kill('SIGKILL')
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
    const importFailed = this.status === 'incompatible' && this.describe?.compatible === false && this.describe.import_error !== null && !this.describe.stale
    this.child = null
    this.describe = null
    this.log(`[sidecar] exited code=${code} signal=${signal ?? ''}`)
    const error = new SidecarError('sidecar exited', { condition: 'sidecar_unavailable', data: { code, signal } })
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    if (this.closed) { this.status = 'stopped'; return }
    if (code === 3 || (this.status === 'incompatible' && !importFailed)) {
      // Protocol mismatch or changed loaded runtime: restarting cannot help safely.
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

  /** Agent operations require readiness; config access needs only a valid, live RPC handshake. */
  call<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts: CallOptions = {}): Promise<SidecarResult<M>> {
    const configAccess = (method === 'config.get' || method === 'config.set') && this.status === 'incompatible' && this.describe?.rpc_version === SIDECAR_RPC_VERSION
    const { condition } = chatReadiness(this)
    if (condition !== null && !configAccess && !method.startsWith('runtime.') && method !== 'rpc.methods') {
      return Promise.reject(new SidecarError(`sidecar not ready (${this.status})`, { condition }))
    }
    const child = this.child
    const refreshStatus = method === 'runtime.status' && (this.status === 'ready' || this.status === 'incompatible')
    const statusSequence = method === 'runtime.status' ? ++this.runtimeStatusSequence : 0
    const current = () => refreshStatus && statusSequence === this.runtimeStatusSequence && this.child === child && !this.closed && !opts.signal?.aborted && (this.status === 'ready' || this.status === 'incompatible')
    return this.rawCall(method, params, opts).then(async (result) => {
      if (!current()) return result
      const describe = result as RuntimeDescribe
      const ready = describe.compatible && !describe.stale
      // A runtime recovered in place turns ready here without a new handshake, so its ready gates run first.
      if (ready && this.status !== 'ready') {
        await this.runReadyGates()
        if (!current()) return result
      }
      this.describe = describe
      this.status = ready ? 'ready' : 'incompatible'
      return result
    })
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
    this.handshakeListeners.clear()
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
