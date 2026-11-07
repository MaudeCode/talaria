/**
 * Live stream fan-out (Python `api/config.py::StreamChannel`, `STREAMS`,
 * `ACTIVE_RUNS`, `STREAM_SESSION_OWNERS`) and the per-session channel used by
 * `/api/session/stream` (`api/background_process.py::SessionChannel`).
 */
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { TurnOrigin } from './background-updates.js'

/** A live frame; `redacted` records whether a tool frame was redacted when produced, so delivery can apply the current policy. */
export type StreamItem = [event: string, data: unknown, eventId: string | null, redacted?: boolean | undefined]

export interface StreamSubscriber {
  /** Bounded queue; on overflow the oldest frame is dropped (older frames stay recoverable through the journal). */
  queue: StreamItem[]
  wake: (() => void) | null
  closed: boolean
  /**
   * Frames the queue dropped since the writer last caught up: the first journaled id lost, whether a run frame without one
   * was lost, how many, and the newest copy of each dropped refetch signal (resent once the gap is recovered).
   */
  gap: { firstEventId: string | null; unjournaled: boolean; dropped: number; signals: Map<string, unknown> } | null
}

/** Unjournaled notifications that only ask the client to refetch a server record; the newest copy supersedes the rest. */
const REFETCH_SIGNALS = new Set(['bg_task_complete', 'process_complete'])

export interface SubscribeSnapshot {
  offline_buffered_events: number
  offline_dropped_events: number
  offline_first_event_id: string | null
  last_event_id: string | null
}

const OFFLINE_BUFFER_MAXLEN = 8192
const SUBSCRIBER_QUEUE_MAXSIZE = OFFLINE_BUFFER_MAXLEN

export class StreamChannel {
  private readonly toolProgress = new Map<string, StreamItem>()
  private readonly subscribers = new Set<StreamSubscriber>()
  private readonly offline: StreamItem[] = []
  private offlineDropped = 0
  lastEventId: string | null = null

  subscribeWithSnapshot(): [StreamSubscriber, SubscribeSnapshot] {
    const sub: StreamSubscriber = { queue: [...this.offline, ...this.toolProgress.values()], wake: null, closed: false, gap: null }
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

  /** A complete snapshot supersedes every queued frame, including a stalled reader's gap. */
  replace(item: StreamItem): void {
    this.offline.length = 0
    this.offlineDropped = 0
    this.toolProgress.clear()
    this.lastEventId = item[2]
    for (const sub of this.subscribers) { sub.queue.length = 0; sub.gap = null }
    this.put(item)
  }

  put(item: StreamItem): void {
    const data = item[1] as { id?: string; progress?: unknown } | null
    if (item[0] === 'tool_progress' && data?.id) {
      if (data.progress === null) this.toolProgress.delete(data.id)
      else this.toolProgress.set(data.id, item)
    }
    else if (item[0] === 'tool_complete' && data?.id) this.toolProgress.delete(data.id)
    else if (['done', 'cancel', 'apperror', 'error', 'stream_end'].includes(item[0])) this.toolProgress.clear()
    if (item[2]) this.lastEventId = item[2]
    if (!this.subscribers.size) {
      if (item[0] === 'tool_progress') return
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
      if (sub.queue.length >= SUBSCRIBER_QUEUE_MAXSIZE) {
        const lost = sub.queue.shift()!
        sub.gap ??= { firstEventId: null, unjournaled: false, dropped: 0, signals: new Map() }
        sub.gap.dropped += 1
        if (lost[2]) sub.gap.firstEventId ??= lost[2]
        else if (REFETCH_SIGNALS.has(lost[0])) sub.gap.signals.set(lost[0], lost[1])
        else if (lost[0] !== 'tool_progress') sub.gap.unjournaled = true
        this.subscriberDropped += 1
      }
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
  /** The hidden worker's activity belongs to its parent, while its turn persists and settles normally. */
  activity_parent_session_id?: string
  /** Admission owns the session while its pending snapshot is being committed; no channel exists yet. */
  admitting?: boolean
  /** TAL-460: `background` for a wakeup turn, which a user's message replaces instead of joining. */
  origin?: TurnOrigin
  cancelled_at?: number
}

/** Process-wide stream registry: live channels, owners, active runs, cancel flags, partial buffers. */
/** How long a cancelling worker may hold its session before a new turn is admitted anyway. */
export const CANCEL_UNWIND_CEILING_S = 180

export class StreamRegistry {
  constructor(readonly visible: (streamId: string) => boolean = () => true) {}
  readonly streams = new Map<string, StreamChannel>()
  readonly owners = new Map<string, string>()
  readonly activeRuns = new Map<string, ActiveRun>()
  readonly cancelled = new Set<string>()
  /** The run's streamed text and reasoning so far, appended per delta. */
  readonly liveText = new Map<string, { text: string; reasoning: string }>()
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
    this.liveText.set(streamId, { text: '', reasoning: '' })
    this.liveToolCalls.set(streamId, [])
    return channel
  }

  peek(streamId: string): StreamChannel | undefined {
    return this.streams.get(streamId)
  }

  ownerSessionId(streamId: string): string | null {
    if (!this.visible(streamId)) return null
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
      if (!this.visible(run.stream_id)) continue
      if (run.session_id !== sessionId) continue
      if (run.cancelled_at && !this.liveIds.has(run.stream_id) && now - run.cancelled_at >= CANCEL_UNWIND_CEILING_S) continue
      return run.stream_id
    }
    return null
  }

  /** Attachable run only (a cancelling worker no longer counts). */
  attachableRunForSession(sessionId: string): string | null {
    for (const run of this.activeRuns.values()) if (this.visible(run.stream_id) && run.session_id === sessionId && !run.admitting && run.phase !== 'cancelling' && !run.cancelled_at) return run.stream_id
    return null
  }

  retire(streamId: string, now = Date.now() / 1000): ActiveRun | undefined {
    const run = this.activeRuns.get(streamId)
    this.activeRuns.delete(streamId)
    this.lastRunFinishedAt = now
    this.streams.delete(streamId)
    this.liveIds.delete(streamId)
    this.cancelled.delete(streamId)
    this.liveText.delete(streamId)
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

/** A channel frame; `cursor` is its SSE `id:`, which also names its replay position. */
export type SessionChannelItem = [event: string, data: unknown, cursor: string]

export interface SessionChannelSubscriber {
  queue: SessionChannelItem[]
  wake: (() => void) | null
  closed: boolean
  channelKey: string
  /** The `initial` frame's cursor: the resume position when replay frames follow it, else the channel's head. */
  initialCursor: string
}

interface SessionChannel {
  /** Names this incarnation, so a cursor from an earlier one (or an earlier server) cannot match. */
  token: string
  seq: number
  /** The newest frames, with consecutive sequences ending at `seq`. */
  history: SessionChannelItem[]
  subscribers: Set<SessionChannelSubscriber>
  reap: NodeJS.Timeout | null
}

const SESSION_CHANNEL_HISTORY_MAX = 32
const SESSION_CHANNEL_QUEUE_MAX = 64
const SESSION_CHANNEL_GRACE_MS = 60_000
const SESSION_CHANNEL_CURSOR = /^session-channel:([0-9a-f]+)@(\d+)$/

const cursorAt = (channel: SessionChannel, seq: number): string => `session-channel:${channel.token}@${String(seq)}`

/** The sequence `cursor` resumes after, or null for a malformed, foreign, future or evicted one, which replays nothing. */
function resumeSeq(channel: SessionChannel, cursor: string | null | undefined): number | null {
  const match = SESSION_CHANNEL_CURSOR.exec((cursor ?? '').trim())
  if (match?.[1] !== channel.token) return null
  const seq = Number(match[2])
  return Number.isSafeInteger(seq) && seq <= channel.seq && seq >= channel.seq - channel.history.length ? seq : null
}

/** Long-lived per-session channel that survives across turns, and across a client's reconnect for a bounded grace. */
export class SessionChannels {
  private readonly channels = new Map<string, SessionChannel>()

  constructor(private readonly activeProfile: () => string = () => 'default', private readonly profileIdentity: (profile: string) => string = (profile) => profile) {}

  private key(sessionId: string, profile = this.activeProfile()): string { return JSON.stringify([this.profileIdentity(profile), sessionId]) }

  subscribe(sessionId: string, profile = this.activeProfile(), lastEventId?: string | null): SessionChannelSubscriber {
    const channelKey = this.key(sessionId, profile)
    let channel = this.channels.get(channelKey)
    if (!channel) {
      channel = { token: randomBytes(8).toString('hex'), seq: 0, history: [], subscribers: new Set(), reap: null }
      this.channels.set(channelKey, channel)
    }
    if (channel.reap) { clearTimeout(channel.reap); channel.reap = null }
    const resumed = resumeSeq(channel, lastEventId)
    const queue = resumed === null ? [] : channel.history.slice(channel.history.length - (channel.seq - resumed))
    const sub: SessionChannelSubscriber = { queue, wake: null, closed: false, channelKey, initialCursor: cursorAt(channel, resumed ?? channel.seq) }
    channel.subscribers.add(sub)
    return sub
  }

  unsubscribe(sessionId: string, sub: SessionChannelSubscriber): void {
    sub.closed = true
    const channel = this.channels.get(sub.channelKey)
    sub.wake?.()
    if (!channel) return
    channel.subscribers.delete(sub)
    if (channel.subscribers.size || channel.reap) return
    channel.reap = setTimeout(() => { this.channels.delete(sub.channelKey) }, SESSION_CHANNEL_GRACE_MS)
    channel.reap.unref()
  }

  /** History append and subscriber enqueue are one synchronous step, so delivery order cannot differ from history order. */
  emit(sessionId: string, event: string, data: unknown, profile = this.activeProfile()): number {
    const channel = this.channels.get(this.key(sessionId, profile))
    if (!channel) return 0
    channel.seq += 1
    const item: SessionChannelItem = [event, data, cursorAt(channel, channel.seq)]
    channel.history.push(item)
    if (channel.history.length > SESSION_CHANNEL_HISTORY_MAX) channel.history.shift()
    let delivered = 0
    for (const sub of channel.subscribers) {
      // These are refetch signals for server records: a stalled subscriber keeps the newest 64, never refusing the latest.
      const newest = sub.queue.at(-1)
      if (event === 'session-updated' && newest?.[0] === event && isDeepStrictEqual(newest[1], data)) {
        sub.queue[sub.queue.length - 1] = item
      } else {
        if (sub.queue.length >= SESSION_CHANNEL_QUEUE_MAX) sub.queue.shift()
        sub.queue.push(item)
      }
      sub.wake?.()
      delivered += 1
    }
    return delivered
  }

  subscriberCount(sessionId: string): number {
    return this.channels.get(this.key(sessionId))?.subscribers.size ?? 0
  }
}

export function nextSessionItem(sub: SessionChannelSubscriber, timeoutMs: number): Promise<SessionChannelItem | null> {
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
