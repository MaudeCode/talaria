/**
 * Background-process completion drain (Python `api/background_process.py`):
 * the sidecar pops the Agent registry's completion queue; the server routes
 * each event to the owning WebUI session, emits a coalesced `bg_task_complete`
 * on the session channel and any live stream, and wakes the agent server-side
 * with a synthetic `[IMPORTANT: …]` turn (deferred while a turn is active,
 * redelivered at turn teardown with a bounded retry budget).
 */
import { randomUUID } from 'node:crypto'
import type { SidecarLike } from '../sidecar/client.js'
import type { SessionChannels, StreamRegistry } from './streams.js'
import type { SessionStore } from './store.js'
import type { Session } from './session.js'
import { str } from '../util.js'

type Dict = Record<string, unknown>
export const COMPLETION_POLL_MS = 1000
const EMIT_COALESCE_WINDOW_S = 1
const WAKEUP_RETRY_SECONDS = 30
const WAKEUP_RETRY_MAX_ATTEMPTS = 5
const WAKEUP_BATCH_MAX_CHARS = 24_000

export interface CompletionDrainDeps {
  sidecar: () => SidecarLike | null
  profileHome: (profile: string | null) => string
  activeProfile: () => string
  store: SessionStore
  channels: SessionChannels
  registry: StreamRegistry
  /** Start a server-side turn; `_status` 409 means a turn is already active. */
  startTurn: (session: Session, prompt: string) => { _status?: number; error?: string; stream_id?: string }
  now: () => number
  log: (line: string) => void
  pollMs?: number
}

interface Deferred { process_id: string; wakeup_prompt: string }

/** Python `format_wakeup_prompt` for plain completion events; async delegations use the sidecar formatter. */
export function formatWakeupPrompt(evt: Dict): string | null {
  const type = str(evt.type ?? 'completion')
  const sid = str(evt.session_id).trim()
  const cmd = str(evt.command).trim()
  const truncate = (text: unknown, limit: number): string => { const s = str(text); return s.length <= limit ? s : `${s.slice(0, limit)}\n…(truncated)` }
  if (['watch_overflow_tripped', 'watch_overflow_released', 'watch_disabled'].includes(type)) { const msg = str(evt.message).trim(); return msg ? `[IMPORTANT: ${msg}]` : null }
  if (type === 'watch_match') {
    let body = `[IMPORTANT: Background process ${sid} matched watch pattern "${str(evt.pattern ?? '?')}".\nCommand: ${cmd}\nMatched output:\n${truncate(evt.output, 4000)}`
    if (evt.suppressed) body += `\n(${str(evt.suppressed)} earlier matches were suppressed by rate limit)`
    return body + ']'
  }
  if (type !== 'completion') return null
  if (!(sid || cmd || 'exit_code' in evt || evt.output)) return null
  return `[IMPORTANT: Background process ${sid} completed (exit_code=${str(evt.exit_code ?? '?')}).\nCommand: ${cmd}\nOutput:\n${truncate(evt.output, 4000)}]`
}

export class CompletionDrain {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly seen = new Map<string, Set<string>>()
  private readonly pendingSessions = new Set<string>()
  private readonly deferred = new Map<string, Deferred[]>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()
  private readonly lastEmitAt = new Map<string, number>()
  private readonly pendingEmit = new Map<string, { payload: Dict; timer: NodeJS.Timeout }>()

  constructor(private readonly deps: CompletionDrainDeps) {}

  start(): void {
    if (this.timer || this.stopped) return
    const tick = (): void => {
      if (this.stopped) return
      void this.drainOnce().catch((error: unknown) => { this.deps.log(`[webui] WARNING: bg_task_complete drain failed: ${(error as Error).message}`) }).finally(() => {
        if (this.stopped) return
        this.timer = setTimeout(tick, this.deps.pollMs ?? COMPLETION_POLL_MS)
        this.timer.unref()
      })
    }
    tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const t of this.retryTimers.values()) clearTimeout(t)
    for (const p of this.pendingEmit.values()) clearTimeout(p.timer)
  }

  /** One drain pass; returns the number of events routed. */
  async drainOnce(): Promise<number> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return 0
    const { events } = await sidecar.call('process.drain', { profile_home: this.deps.profileHome(this.deps.activeProfile()), max_events: 256 })
    let routed = 0
    const unrouted: Dict[] = []
    for (const evt of events) {
      try {
        if (await this.processOne(evt)) routed += 1
        else if (evt.type === 'async_delegation') unrouted.push(evt)
      } catch (error) {
        this.deps.log(`[webui] WARNING: bg_task_complete event handling failed: ${(error as Error).message}`)
      }
    }
    // Async delegation results stay durable: what this server does not own goes back to the registry queue.
    if (unrouted.length) { try { await sidecar.call('process.requeue', { events: unrouted }) } catch { /* best effort */ } }
    return routed
  }

  private resolveTarget(evt: Dict): string {
    const sessionKey = str(evt.session_key).trim()
    const origin = str(evt.origin_ui_session_id).trim()
    const live = (sid: string): string => { if (!sid) return ''; try { this.deps.store.get(sid, { metadataOnly: true, promote: false, cacheOnMiss: false }); return sid } catch { return '' } }
    const resolved = live(sessionKey)
    const owner = live(origin)
    if (!owner) return resolved
    if (resolved && resolved !== owner) this.deps.log(`[webui] ERROR: cross-session completion route BLOCKED: session_key resolved to ${resolved} but exact origin_ui_session_id is ${owner}; routing to the exact owner`)
    return owner
  }

  private hasActiveTurn(sid: string): boolean {
    for (const run of this.deps.registry.activeRuns.values()) if (run.session_id === sid) return true
    return false
  }

  private async wakeupPrompt(evt: Dict): Promise<string> {
    if (evt.type === 'async_delegation') {
      const sidecar = this.deps.sidecar()
      if (!sidecar) return ''
      try { return (await sidecar.call('process.format_notification', { event: evt })).text.trim() } catch { return '' }
    }
    return (formatWakeupPrompt(evt) ?? '').trim()
  }

  /** Python `_process_one`; returns false when the event has no owning WebUI session. */
  async processOne(evt: Dict): Promise<boolean> {
    const processId = str(evt.process_id).trim()
    const sid = this.resolveTarget(evt)
    if (!sid) return false
    if (evt.consumed === true) return true
    const seen = this.seen.get(sid) ?? new Set<string>()
    this.seen.set(sid, seen)
    if (processId && seen.has(processId)) return true
    if (processId) seen.add(processId)
    this.pendingSessions.add(sid)
    const prompt = await this.wakeupPrompt(evt)
    this.emitCoalesced(sid, this.buildPayload(evt, sid, prompt))
    if (!prompt) return true
    if (this.hasActiveTurn(sid)) this.recordDeferred(sid, processId, prompt)
    else await this.startWakeup(sid, [{ process_id: processId, wakeup_prompt: prompt }])
    return true
  }

  private buildPayload(evt: Dict, sid: string, prompt: string): Dict {
    const payload: Dict = { session_id: sid, task_id: str(evt.process_id), completed_at: this.deps.now(), event_id: randomUUID().replace(/-/g, '') }
    const first = prompt.split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^\[/, '').replace(/\]$/, '').trim()
    if (first) payload.summary = first.length <= 200 ? first : `${first.slice(0, 200)}\n…(truncated)`
    return payload
  }

  private emitNow(sid: string, payload: Dict): number {
    let emitted = 0
    for (const [streamId, channel] of this.deps.registry.streams) {
      if (this.deps.registry.activeRuns.get(streamId)?.session_id !== sid) continue
      channel.put(['bg_task_complete', { ...payload }, null])
      channel.put(['process_complete', { ...payload }, null])
      emitted += 2
    }
    emitted += this.deps.channels.emit(sid, 'bg_task_complete', { ...payload })
    emitted += this.deps.channels.emit(sid, 'process_complete', { ...payload })
    return emitted
  }

  /** Python `_emit_bg_task_complete_events_coalesced`: first emit immediately, bursts flush the latest payload after 1 s of quiet. */
  private emitCoalesced(sid: string, payload: Dict): void {
    const now = this.deps.now()
    const last = this.lastEmitAt.get(sid)
    const pending = this.pendingEmit.get(sid)
    if (last === undefined || now - last >= EMIT_COALESCE_WINDOW_S) {
      if (pending) { clearTimeout(pending.timer); this.pendingEmit.delete(sid) }
      this.lastEmitAt.set(sid, now)
      this.emitNow(sid, payload)
      return
    }
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      const entry = this.pendingEmit.get(sid)
      this.pendingEmit.delete(sid)
      if (!entry) return
      this.lastEmitAt.set(sid, this.deps.now())
      this.emitNow(sid, entry.payload)
    }, EMIT_COALESCE_WINDOW_S * 1000)
    timer.unref()
    this.pendingEmit.set(sid, { payload, timer })
  }

  recordDeferred(sid: string, processId: string, prompt: string): void {
    if (!sid || !prompt) return
    const entries = this.deferred.get(sid) ?? []
    if (processId && entries.some((e) => e.process_id === processId)) return
    entries.push({ process_id: processId, wakeup_prompt: prompt })
    this.deferred.set(sid, entries)
    this.pendingSessions.add(sid)
  }

  deferredCount(sid: string): number { return this.deferred.get(sid)?.length ?? 0 }

  private async markConsumed(processIds: string[]): Promise<void> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return
    for (const pid of processIds.filter(Boolean)) { try { await sidecar.call('process.mark_consumed', { process_id: pid }) } catch { /* best effort */ } }
  }

  private scheduleRetry(sid: string): void {
    const attempts = (this.retryAttempts.get(sid) ?? 0) + 1
    this.retryAttempts.set(sid, attempts)
    if (attempts > WAKEUP_RETRY_MAX_ATTEMPTS) { this.deps.log(`[webui] WARNING: server-side wakeup retry budget exhausted for session ${sid}; deferred entries wait for the next turn teardown`); return }
    const existing = this.retryTimers.get(sid)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => { this.retryTimers.delete(sid); void this.drainDeferred(sid) }, WAKEUP_RETRY_SECONDS * 1000)
    timer.unref()
    this.retryTimers.set(sid, timer)
  }

  /** Python `_start_server_side_wakeup_turn`: one batched turn; 409 re-defers, other failures re-defer with a timed retry. */
  private async startWakeup(sid: string, batched: Deferred[]): Promise<boolean> {
    const prompt = batched.length === 1 ? batched[0]!.wakeup_prompt : batched.map((e) => e.wakeup_prompt).join('\n\n')
    const redefer = (): void => { for (const e of batched) this.recordDeferred(sid, e.process_id, e.wakeup_prompt) }
    let session: Session
    try { session = this.deps.store.get(sid) } catch { redefer(); this.deps.log(`[webui] WARNING: server-side wakeup retained for session ${sid}: session unavailable`); return false }
    if (session.pre_compression_snapshot) { redefer(); this.deps.log(`[webui] WARNING: automatic wakeup retained: sealed snapshot ${sid} cannot own a turn`); return false }
    let resp: { _status?: number; error?: string; stream_id?: string }
    try { resp = this.deps.startTurn(session, prompt) } catch (error) { redefer(); this.scheduleRetry(sid); this.deps.log(`[webui] WARNING: server-side wakeup turn raised for session ${sid}: ${(error as Error).message}`); return false }
    const status = resp._status ?? (resp.stream_id ? 200 : 500)
    if (status === 409) { redefer(); return false }
    if (status >= 400) { redefer(); this.scheduleRetry(sid); this.deps.log(`[webui] WARNING: server-side wakeup failed for session ${sid}: status=${String(status)} err=${str(resp.error)}; re-deferred for redelivery`); return false }
    this.retryAttempts.delete(sid)
    await this.markConsumed(batched.map((e) => e.process_id))
    this.deps.log(`[webui] server-side wakeup turn started for session ${sid} (stream_id=${str(resp.stream_id)})`)
    return true
  }

  /** Python `drain_deferred_wakeups_for_session`: turn-teardown idle hook; only the last active stream's teardown fires. */
  async drainDeferred(sid: string): Promise<number> {
    if (!sid || this.hasActiveTurn(sid)) return 0
    const entries = this.deferred.get(sid)
    if (!entries?.length) return 0
    this.deferred.delete(sid)
    this.pendingSessions.delete(sid)
    const pending = entries.filter((e) => e.wakeup_prompt.trim())
    if (!pending.length) { this.retryAttempts.delete(sid); return 0 }
    const batch: Deferred[] = []
    let total = 0
    for (const entry of pending) {
      const size = entry.wakeup_prompt.length
      if (batch.length && total + size > WAKEUP_BATCH_MAX_CHARS) { this.recordDeferred(sid, entry.process_id, entry.wakeup_prompt); continue }
      batch.push(entry)
      total += size
    }
    return (await this.startWakeup(sid, batch)) ? 1 : 0
  }

  /** Reaper sweep: forget dedupe sets for sessions with nothing pending. */
  sweep(): void {
    for (const sid of this.seen.keys()) if (!this.pendingSessions.has(sid) && !this.deferred.has(sid)) this.seen.delete(sid)
  }
}
