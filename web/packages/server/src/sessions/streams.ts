/**
 * Live stream fan-out (Python `api/config.py::StreamChannel`, `STREAMS`,
 * `ACTIVE_RUNS`, `STREAM_SESSION_OWNERS`) and the per-session channel used by
 * `/api/session/stream` (`api/background_process.py::SessionChannel`).
 */

export type StreamItem = [event: string, data: unknown, eventId: string | null]

export interface StreamSubscriber {
  /** Bounded queue; on overflow the oldest frame is dropped (older frames stay recoverable through the journal). */
  queue: StreamItem[]
  wake: (() => void) | null
  closed: boolean
}

export interface SubscribeSnapshot {
  offline_buffered_events: number
  offline_dropped_events: number
  offline_first_event_id: string | null
  last_event_id: string | null
}

const OFFLINE_BUFFER_MAXLEN = 8192
const SUBSCRIBER_QUEUE_MAXSIZE = OFFLINE_BUFFER_MAXLEN

export class StreamChannel {
  private readonly subscribers = new Set<StreamSubscriber>()
  private readonly offline: StreamItem[] = []
  private offlineDropped = 0
  lastEventId: string | null = null

  subscribeWithSnapshot(): [StreamSubscriber, SubscribeSnapshot] {
    const sub: StreamSubscriber = { queue: [...this.offline], wake: null, closed: false }
    const first = this.offline[0]
    const snapshot: SubscribeSnapshot = { offline_buffered_events: this.offline.length, offline_dropped_events: this.offlineDropped, offline_first_event_id: first?.[2] ?? null, last_event_id: this.lastEventId }
    this.subscribers.add(sub)
    return [sub, snapshot]
  }

  unsubscribe(sub: StreamSubscriber): void {
    sub.closed = true
    this.subscribers.delete(sub)
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  put(item: StreamItem): void {
    if (item[2]) this.lastEventId = item[2]
    if (!this.subscribers.size) {
      if (this.offline.length >= OFFLINE_BUFFER_MAXLEN) {
        this.offline.shift()
        this.offlineDropped += 1
      }
      this.offline.push(item)
      return
    }
    this.offline.length = 0
    this.offlineDropped = 0
    for (const sub of this.subscribers) {
      if (sub.queue.length >= SUBSCRIBER_QUEUE_MAXSIZE) { sub.queue.shift(); this.subscriberDropped += 1 }
      sub.queue.push(item)
      sub.wake?.()
    }
  }

  /** Frames a slow subscriber lost to its bounded queue (Python `subscriber_dropped_events`). */
  subscriberDropped = 0

  diagnosticSnapshot(): Record<string, number> {
    return { subscriber_count: this.subscribers.size, offline_buffered_events: this.offline.length, offline_dropped_events: this.offlineDropped, subscriber_dropped_events: this.subscriberDropped }
  }
}

/** Wait for the next queued frame or a timeout; resolves `null` on timeout. */
export function nextItem(sub: StreamSubscriber, timeoutMs: number): Promise<StreamItem | null> {
  const ready = sub.queue.shift()
  if (ready) return Promise.resolve(ready)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sub.wake = null; resolve(null) }, timeoutMs)
    sub.wake = () => {
      clearTimeout(timer)
      sub.wake = null
      resolve(sub.queue.shift() ?? null)
    }
  })
}

export interface ActiveRun {
  stream_id: string
  session_id: string
  started_at: number
  phase: string
  workspace: string
  model: string | null
  provider: string | null
  ephemeral: boolean
  cancelled_at?: number
}

/** Process-wide stream registry: live channels, owners, active runs, cancel flags, partial buffers. */
/** How long a cancelling worker may hold its session before a new turn is admitted anyway. */
export const CANCEL_UNWIND_CEILING_S = 180

export class StreamRegistry {
  readonly streams = new Map<string, StreamChannel>()
  readonly owners = new Map<string, string>()
  readonly activeRuns = new Map<string, ActiveRun>()
  readonly cancelled = new Set<string>()
  readonly partialText = new Map<string, string[]>()
  readonly reasoningText = new Map<string, string[]>()
  readonly liveToolCalls = new Map<string, Record<string, unknown>[]>()
  readonly goalRelated = new Set<string>()
  /** Runs whose journal missed a frame (an append failed), so it cannot replay the run's whole output. */
  readonly degradedJournals = new Set<string>()
  readonly writebackOwners = new Map<string, string>()
  lastRunFinishedAt: number | null = null
  /** Live view used by the session service overlay (`STREAMS` keys). */
  readonly liveIds = new Set<string>()

  create(streamId: string, sessionId: string): StreamChannel {
    const channel = new StreamChannel()
    this.streams.set(streamId, channel)
    this.liveIds.add(streamId)
    this.owners.set(streamId, sessionId)
    this.partialText.set(streamId, [])
    this.reasoningText.set(streamId, [])
    this.liveToolCalls.set(streamId, [])
    return channel
  }

  peek(streamId: string): StreamChannel | undefined {
    return this.streams.get(streamId)
  }

  ownerSessionId(streamId: string): string | null {
    return this.owners.get(streamId) ?? null
  }

  registerActiveRun(run: ActiveRun): void {
    this.activeRuns.set(run.stream_id, run)
  }

  /**
   * Python `_active_run_stream_for_session`: the live worker for a session, if any. A run that has been cancelling for
   * longer than `CANCEL_UNWIND_CEILING_S` with no live channel no longer blocks the session (Python's 180 s escape hatch
   * for an Agent thread that never returns from `interrupt()`).
   */
  activeRunStreamForSession(sessionId: string, now = Date.now() / 1000): string | null {
    for (const run of this.activeRuns.values()) {
      if (run.session_id !== sessionId) continue
      if (run.cancelled_at && !this.liveIds.has(run.stream_id) && now - run.cancelled_at >= CANCEL_UNWIND_CEILING_S) continue
      return run.stream_id
    }
    return null
  }

  /** Attachable run only (a cancelling worker no longer counts). */
  attachableRunForSession(sessionId: string): string | null {
    for (const run of this.activeRuns.values()) if (run.session_id === sessionId && run.phase !== 'cancelling' && !run.cancelled_at) return run.stream_id
    return null
  }

  retire(streamId: string, now = Date.now() / 1000): ActiveRun | undefined {
    const run = this.activeRuns.get(streamId)
    this.activeRuns.delete(streamId)
    this.lastRunFinishedAt = now
    this.streams.delete(streamId)
    this.liveIds.delete(streamId)
    this.cancelled.delete(streamId)
    this.partialText.delete(streamId)
    this.reasoningText.delete(streamId)
    this.liveToolCalls.delete(streamId)
    this.goalRelated.delete(streamId)
    this.degradedJournals.delete(streamId)
    return run
  }

  forgetOwner(streamId: string): void {
    this.owners.delete(streamId)
  }

  clearWritebackOwnerIfOwned(sessionId: string, streamId: string): void {
    if (this.writebackOwners.get(sessionId) === streamId) this.writebackOwners.delete(sessionId)
  }
}

export interface SessionChannelSubscriber { queue: [string, unknown][]; wake: (() => void) | null; closed: boolean }

/** Long-lived per-session channel that survives across turns. */
export class SessionChannels {
  private readonly channels = new Map<string, Set<SessionChannelSubscriber>>()

  subscribe(sessionId: string): SessionChannelSubscriber {
    const sub: SessionChannelSubscriber = { queue: [], wake: null, closed: false }
    let set = this.channels.get(sessionId)
    if (!set) {
      set = new Set()
      this.channels.set(sessionId, set)
    }
    set.add(sub)
    return sub
  }

  unsubscribe(sessionId: string, sub: SessionChannelSubscriber): void {
    sub.closed = true
    const set = this.channels.get(sessionId)
    if (!set) return
    set.delete(sub)
    if (!set.size) this.channels.delete(sessionId)
  }

  emit(sessionId: string, event: string, data: unknown): number {
    const set = this.channels.get(sessionId)
    if (!set) return 0
    let delivered = 0
    for (const sub of set) {
      if (sub.queue.length >= 64) continue
      sub.queue.push([event, data])
      sub.wake?.()
      delivered += 1
    }
    return delivered
  }

  subscriberCount(sessionId: string): number {
    return this.channels.get(sessionId)?.size ?? 0
  }
}

export function nextSessionItem(sub: SessionChannelSubscriber, timeoutMs: number): Promise<[string, unknown] | null> {
  const ready = sub.queue.shift()
  if (ready) return Promise.resolve(ready)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sub.wake = null; resolve(null) }, timeoutMs)
    sub.wake = () => {
      clearTimeout(timer)
      sub.wake = null
      resolve(sub.queue.shift() ?? null)
    }
  })
}
