/**
 * Gateway session watcher (Python `api/gateway_watcher.py`): polls one
 * profile's `state.db` every 5 s, skips the projection while the O(1)
 * fingerprint is unchanged (with a 300 s parity pass), and pushes
 * `sessions_changed` snapshots to bounded subscriber queues. One watcher per
 * profile home, started lazily by the SSE routes.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cheapChangeFingerprintAsync, type Dict } from './state-db.js'
import { str } from '../util.js'
import type { CliSessionRead } from './cli-sessions.js'

export const GATEWAY_POLL_INTERVAL_S = 5
const PROJECTION_PARITY_INTERVAL_S = 300
const ERROR_LOG_INTERVAL_S = 60
const SUBSCRIBER_QUEUE_MAX = 10

export interface GatewaySessionsEvent { type: 'sessions_changed'; sessions: Dict[] }

export interface GatewaySubscriber {
  /** Resolves with the next event, or null when the watcher stopped or this subscriber was dropped as a slow consumer. */
  next: (signal?: AbortSignal) => Promise<GatewaySessionsEvent | null>
  /** True once `next` delivered the end (the watcher stopped or dropped this subscriber); a null from a wait that timed out leaves it false. */
  readonly ended: boolean
  close: () => void
}

interface Queue { items: (GatewaySessionsEvent | null)[]; wake: (() => void) | null; ended: boolean }

export function snapshotHash(sessions: Dict[]): string {
  const key = [...sessions].sort((a, b) => str(a.session_id).localeCompare(str(b.session_id))).map((s) => `${str(s.session_id)}:${str(s.updated_at ?? 0)}:${str(s.message_count ?? 0)}`).join('|')
  return createHash('md5').update(key).digest('hex')
}

/** Keep the gateway event's compact row shape while sharing the sidebar's projection. */
function agentSessionsFromRows(rows: Dict[]): Dict[] {
  return rows.map((row) => ({
    session_id: row.session_id, title: row.title || 'Agent Session', model: row.model || null,
    message_count: row.message_count,
    created_at: row.created_at, updated_at: row.updated_at, source: row.source_tag || 'cli',
    raw_source: row.raw_source ?? null, session_source: row.session_source ?? null, source_label: row.source_label ?? null,
  }))
}

interface GatewayWatcherDeps {
  rows: (profile: string) => Promise<CliSessionRead>
  now: () => number
  log: (line: string) => void
  pollIntervalMs?: number
}

export class GatewayWatcher {
  readonly stateDbPath: string
  private readonly subscribers = new Set<Queue>()
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopping = false
  private lastHash = ''
  private lastCheapFp = ''
  private lastFullProjectionAt: number | null = null
  private lastErrorLogAt = Number.NEGATIVE_INFINITY
  private polling: Promise<boolean> | null = null

  constructor(readonly profileName: string, readonly hermesHome: string, private readonly opts: GatewayWatcherDeps) {
    this.stateDbPath = join(hermesHome, 'state.db')
  }

  isAlive(): boolean { return this.running }
  hasSubscribers(): boolean { return this.subscribers.size > 0 }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopping = false
    const tick = (): void => {
      if (this.stopping) return
      // The next tick is armed only once this poll settles, so the timer never stacks polls.
      void this.pollOnce().catch((error: unknown) => { this.warnFailure('poll loop raised', error) }).then(() => {
        if (this.stopping || this.timer !== null) return
        this.timer = setTimeout(() => { this.timer = null; tick() }, this.opts.pollIntervalMs ?? GATEWAY_POLL_INTERVAL_S * 1000)
        this.timer.unref()
      })
    }
    tick()
  }

  stop(): void {
    this.stopping = true
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const q of this.subscribers) this.push(q, null)
  }

  subscribe(): GatewaySubscriber {
    const q: Queue = { items: [], wake: null, ended: false }
    this.subscribers.add(q)
    // Stop-race safety: a subscriber attached after stop() still receives the sentinel so its SSE loop ends and reconnects.
    if (this.stopping) q.items.push(null)
    return {
      next: (signal) => new Promise((resolve) => {
        const deliver = (): void => {
          const item = q.items.shift() ?? null
          if (item === null) q.ended = true
          resolve(item)
        }
        if (q.items.length) { deliver(); return }
        if (signal?.aborted) { resolve(null); return }
        const onAbort = (): void => { q.wake = null; resolve(null) }
        signal?.addEventListener('abort', onAbort, { once: true })
        q.wake = () => { signal?.removeEventListener('abort', onAbort); deliver() }
      }),
      get ended() { return q.ended },
      close: () => { this.subscribers.delete(q) },
    }
  }

  private push(q: Queue, event: GatewaySessionsEvent | null): void {
    q.items.push(event)
    const wake = q.wake
    q.wake = null
    wake?.()
  }

  private notify(sessions: Dict[]): void {
    for (const q of [...this.subscribers]) {
      if (q.items.length >= SUBSCRIBER_QUEUE_MAX) {
        // Slow consumer: drop it with a sentinel so the browser's EventSource reconnects.
        this.subscribers.delete(q)
        q.items.length = 0
        this.push(q, null)
        continue
      }
      this.push(q, { type: 'sessions_changed', sessions })
    }
  }

  private warnFailure(reason: string, error: unknown): void {
    const now = this.opts.now()
    if (now - this.lastErrorLogAt >= ERROR_LOG_INTERVAL_S) {
      this.lastErrorLogAt = now
      this.opts.log(`[webui] WARNING: Gateway watcher ${reason} for ${this.stateDbPath}; the session sidebar will not update until it recovers: ${(error as Error).message}`)
    }
  }

  /** One change-detection pass; returns true when the projection ran. A call while a pass is in flight skips (false). */
  pollOnce(now = this.opts.now()): Promise<boolean> {
    if (this.polling) return Promise.resolve(false)
    const pass = this.poll(now).finally(() => { this.polling = null })
    this.polling = pass
    return pass
  }

  private async poll(now: number): Promise<boolean> {
    const exists = existsSync(this.stateDbPath)
    // Never publish an empty first snapshot before the Agent has created state.db.
    if (!exists && this.lastFullProjectionAt === null && !this.lastHash) return false
    const cheapFp = exists ? await cheapChangeFingerprintAsync(this.stateDbPath, (reason, error) => { this.warnFailure(reason, error) }) : ''
    const parityDue = this.lastFullProjectionAt === null || now - this.lastFullProjectionAt >= PROJECTION_PARITY_INTERVAL_S
    if (cheapFp !== null && cheapFp === this.lastCheapFp && !parityDue) return false
    let read: CliSessionRead
    try {
      read = await this.opts.rows(this.profileName)
      if (read.storage.state === 'corrupt' || read.storage.state === 'unavailable') throw new Error(read.storage.reason ?? read.storage.state)
    } catch (error) {
      this.warnFailure('session projection failed', error)
      return false
    }
    const sessions = agentSessionsFromRows(read.rows)
    // A watcher stopped mid-pass has already sent its subscribers the end sentinel.
    if (this.stopping) return false
    const hash = snapshotHash(sessions)
    if (cheapFp !== null) this.lastCheapFp = cheapFp
    this.lastFullProjectionAt = now
    if (hash !== this.lastHash) {
      this.lastHash = hash
      this.notify(sessions)
    }
    return true
  }
}

/** Python module-level watcher registry keyed by profile home. */
export class GatewayWatcherRegistry {
  private readonly watchers = new Map<string, GatewayWatcher>()
  constructor(private readonly deps: GatewayWatcherDeps & { profileHome: (profile: string) => string }) {}

  get(profile: string): GatewayWatcher {
    const home = this.deps.profileHome(profile)
    let watcher = this.watchers.get(home)
    if (!watcher?.isAlive()) {
      watcher?.stop()
      watcher = new GatewayWatcher(profile, home, this.deps)
      watcher.start()
      this.watchers.set(home, watcher)
    }
    return watcher
  }

  /** Python `restart_watcher_for_profile`: swap atomically; idle watchers for other homes are reaped. */
  restartForProfile(profile: string): GatewayWatcher {
    const home = this.deps.profileHome(profile)
    const fresh = new GatewayWatcher(profile, home, this.deps)
    fresh.start()
    const existing = this.watchers.get(home)
    const stale: GatewayWatcher[] = existing ? [existing] : [...this.watchers.entries()].filter(([k, w]) => k !== home && !w.hasSubscribers()).map(([k, w]) => { this.watchers.delete(k); return w })
    this.watchers.set(home, fresh)
    for (const w of stale) w.stop()
    return fresh
  }

  stopAll(): void {
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
  }
}
