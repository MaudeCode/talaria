/** Bounded, payload-free chat startup diagnostics. All offsets use this process's monotonic clock. */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

export const startupTimingScope = new AsyncLocalStorage<StartupTiming | undefined>()

export type TimingOutcome = 'ok' | 'noop' | 'cache_hit' | 'timeout' | 'refused' | 'cancelled' | 'unknown' | 'error'
export type StartupSpan = 'request_guards' | 'runtime_barrier' | 'owner_routing' | 'catalog_wait' | 'session_load' | 'ownership_checks' | 'prompt_preparation' | 'background_yield' | 'workspace_preparation' | 'admission' | 'admission_checks' | 'admission_persistence' | 'workspace_persistence' | 'worker_preparation' | 'sidecar_dispatch' | 'sidecar_call' | 'owner_snapshot' | 'owner_detail' | 'owner_submit'
type Observation = 'request_receipt' | 'acknowledgement' | 'first_run_status' | 'first_sidecar_output' | 'first_visible_token' | 'first_visible_reasoning' | 'first_visible_tool' | 'first_visible_interim'
type Stage = 'acknowledgement' | 'dispatch' | 'first_visible' | 'terminal'
interface Span { start_ms: number; duration_ms: number | null; outcome: TimingOutcome | null }

export function timingOutcome(error: unknown): TimingOutcome {
  const e = error as { condition?: unknown; status?: unknown; extra?: { outcome_unknown?: unknown } } | null
  if (e?.extra?.outcome_unknown === true) return 'unknown'
  if (e?.condition === 'cancelled') return 'cancelled'
  if (e?.condition === 'sidecar_timeout' || e?.condition === 'timeout') return 'timeout'
  if (e?.condition === 'sidecar_unavailable') return 'unknown'
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) return 'refused'
  return 'error'
}

export function timingKey(value: string): string { return createHash('sha256').update(value).digest('hex') }

export class StartupTiming {
  readonly traceId = randomUUID()
  private readonly origin: number
  private readonly spans = new Map<StartupSpan, Span>()
  private readonly observations: Partial<Record<Observation, number>> = {}
  private readonly emitted = new Set<Stage>()
  private readonly stateDbReads = new Map<string, { count: number; queue_wait_ms: number; execution_ms: number }>()
  private sessionKey: string | undefined
  private streamKey: string | undefined
  rpcId: number | undefined
  private ended = false
  private outcome: TimingOutcome = 'ok'

  constructor(private readonly log: (line: string) => void, private readonly now: () => number = () => performance.now()) {
    this.origin = now()
  }

  identify(session: string, stream?: string): void {
    this.sessionKey = timingKey(session)
    if (stream) this.streamKey = timingKey(stream)
  }

  begin(name: StartupSpan): (outcome?: TimingOutcome) => void {
    if (this.ended || this.spans.has(name)) return () => { /* Already recorded. */ }
    const span: Span = { start_ms: this.elapsed(), duration_ms: null, outcome: null }
    this.spans.set(name, span)
    return (outcome = 'ok') => {
      this.end(name, outcome)
    }
  }

  end(name: StartupSpan, outcome: TimingOutcome = 'ok'): void {
    const span = this.spans.get(name)
    if (span?.duration_ms !== null) return
    span.duration_ms = Math.max(0, this.elapsed() - span.start_ms)
    span.outcome = outcome
  }

  async measure<T>(name: StartupSpan, fn: () => T | Promise<T>): Promise<T> {
    const close = this.begin(name)
    try { const value = await fn(); close(); return value }
    catch (error) { close(timingOutcome(error)); throw error }
  }

  observe(name: Observation): boolean {
    if ((this.ended && name !== 'acknowledgement') || this.observations[name] !== undefined) return false
    this.observations[name] = this.elapsed()
    return true
  }

  frame(event: string, data: Record<string, unknown>): void {
    if (event === 'run_status' && data.status) this.observe('first_run_status')
    const name = event === 'token' && typeof data.text === 'string' && data.text.trim() ? 'first_visible_token'
      : event === 'reasoning' && typeof data.text === 'string' && data.text.trim() ? 'first_visible_reasoning'
        : event === 'tool' ? 'first_visible_tool' : event === 'interim_assistant' ? 'first_visible_interim' : null
    if (name && this.observe(name)) this.emit('first_visible')
    if (event === 'cancel') this.outcome = 'cancelled'
    else if ((event === 'apperror' || event === 'error') && this.outcome === 'ok') this.outcome = 'error'
  }

  fail(error: unknown): void { this.outcome = timingOutcome(error) }

  /** Aggregate only dispatcher-owned operation names and durations, never ids, paths or query payloads. */
  workerRead(lane: string, operation: string, timing: { queue_wait_ms: number; execution_ms: number }): void {
    if (this.ended) return
    const key = `${lane}.${operation}`
    const total = this.stateDbReads.get(key) ?? { count: 0, queue_wait_ms: 0, execution_ms: 0 }
    total.count += 1
    total.queue_wait_ms += timing.queue_wait_ms
    total.execution_ms += timing.execution_ms
    this.stateDbReads.set(key, total)
  }

  snapshot() {
    return { spans: Object.fromEntries([...this.spans].map(([name, span]) => [name, { ...span }])), observations: { ...this.observations }, state_db_reads: Object.fromEntries([...this.stateDbReads].map(([key, value]) => [key, { ...value }])) }
  }

  finish(outcome = this.outcome): void {
    if (this.ended) return
    // A cancelled/refused worker may leave setup before its normal dispatch boundary.
    for (const span of this.spans.values()) if (span.duration_ms === null) {
      span.duration_ms = Math.max(0, this.elapsed() - span.start_ms)
      span.outcome = outcome
    }
    this.emit('terminal', outcome)
    this.ended = true
  }

  emit(stage: Stage, outcome: TimingOutcome = 'ok'): void {
    if (this.emitted.has(stage)) return
    this.emitted.add(stage)
    try {
      this.log(`[webui] ${JSON.stringify({ event: 'chat_start_timing', version: 1, process: 'server', trace_id: this.traceId, session_key: this.sessionKey, stream_key: this.streamKey, rpc_id: this.rpcId, stage, outcome, elapsed_ms: this.elapsed(), ...this.snapshot(), provider_boundaries: { first_call: 'unavailable', first_chunk: 'unavailable' } })}`)
    } catch { /* Diagnostics must never affect execution. */ }
  }

  private elapsed(): number { return Math.max(0, this.now() - this.origin) }
}
