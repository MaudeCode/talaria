/**
 * Server-sent event endpoints: the chat relay with journal replay, the
 * persistent per-session channel, the global session-list feed, the
 * per-session journal relay, and the approval/clarify prompt feeds
 * (Python `_handle_sse_stream`, `_handle_session_sse_stream`,
 * `_handle_session_events_stream`, `_handle_session_run_journal_stream_for_session`).
 */
import type { RequestContext } from '../http/context.js'
import { parseRunJournalEventId, SSE_RELAY_CLOSE_EVENTS, type JournalEvent } from '../sessions/journal.js'
import { nextItem, nextSessionItem, type StreamSubscriber } from '../sessions/streams.js'
import { nextPendingItem } from '../sessions/pending.js'
import type { Session } from '../sessions/session.js'
import { withSessionWireFlags } from '../sessions/list.js'
import type { GatewayWatcher } from '../sessions/gateway-watcher.js'
import { str } from '../util.js'
import { streamOwnerSessionId } from './session-visibility.js'
import { completedToolIndex, publicToolFrame, withToolId } from '../redact.js'

export const SSE_HEARTBEAT_INTERVAL_MS = 5_000
const SESSION_SSE_SENT_EVENT_ID_LIMIT = 4096

/** Python `promote_request_to_stream`: bounded concurrent SSE clients (503 `client_stream_limit`). */
export class StreamSlots {
  private readonly held = new Map<string, number>()

  constructor(private readonly limit: () => number) {}

  /** One budget per client identity (authenticated session, else the client address), as Python keyed `_client_stream_key`. */
  claim(key = ''): (() => void) | null {
    const current = this.held.get(key) ?? 0
    if (current >= this.limit()) return null
    this.held.set(key, current + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const now = (this.held.get(key) ?? 1) - 1
      if (now <= 0) this.held.delete(key)
      else this.held.set(key, now)
    }
  }

  get active(): number { let total = 0; for (const n of this.held.values()) total += n; return total }
}

/** Python `_stream_client_key`: the reconciled trusted-auth username (case-folded) when present, else the peer address. */
export function clientStreamKey(ctx: RequestContext): string {
  const username = str(ctx.trusted.reconciled?.username ?? ctx.trusted.info?.username).trim()
  if (username) return `identity:${username.toLowerCase()}`
  return `address:${ctx.peer || 'unknown'}`
}

/** Python served SSE on blocking sockets, so a slow reader stalled its own producer; Node buffers instead, and this bounds that buffer. */
export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export class SseWriter {
  private open = false
  private closed = false

  constructor(private readonly ctx: RequestContext, private readonly release: () => void, private readonly connectionClose: boolean) {
    ctx.res.on('close', () => { this.closed = true; release() })
  }

  get isClosed(): boolean { return this.closed || this.ctx.res.destroyed }

  start(): void {
    if (this.open) return
    this.open = true
    const headers: Record<string, string | string[]> = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...this.ctx.securityHeaders() }
    if (this.connectionClose) headers.Connection = 'close'
    if (this.ctx.pendingCookies.length) { headers['Set-Cookie'] = [...this.ctx.pendingCookies]; this.ctx.pendingCookies = [] }
    this.ctx.res.writeHead(200, headers)
    this.ctx.res.flushHeaders()
    this.ctx.markFinished(200)
  }

  event(event: string, data: unknown, eventId?: string | null): void {
    const body = JSON.stringify(data ?? {})
    this.write(`${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${body}\n\n`)
  }

  comment(text: string): void {
    this.write(`: ${text}\n\n`)
  }

  /** Slow consumers are bounded: past `SSE_MAX_BUFFERED_BYTES` of unsent data the connection is closed instead of growing the response buffer. */
  private write(chunk: string): void {
    if (this.isClosed) return
    if (this.ctx.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      this.ctx.deps.log(`[webui] WARNING: closing slow event-stream client (${String(this.ctx.res.writableLength)} bytes unsent)`)
      this.ctx.res.destroy()
      this.closed = true
      this.release()
      return
    }
    this.ctx.res.write(chunk)
  }

  end(): void {
    if (!this.isClosed) this.ctx.res.end()
    this.closed = true
    this.release()
  }
}

export function claimOrReject(ctx: RequestContext, connectionClose: boolean): SseWriter | null {
  const release = ctx.deps.streamSlots.claim(clientStreamKey(ctx))
  if (!release) {
    ctx.json({ error: 'Client SSE stream limit reached', condition: 'client_stream_limit' }, { status: 503, headers: { Connection: 'close' } })
    return null
  }
  return new SseWriter(ctx, release, connectionClose)
}

function sameRunSeq(eventId: string | null | undefined, streamId: string): number | null {
  const [runId, seq] = parseRunJournalEventId(eventId)
  return runId === streamId ? seq : null
}

/** Python `_chat_stream_resume_cursor` (journal cursors only; the runner adapter is not part of this backend). */
function resumeCursor(ctx: RequestContext, streamId: string): { afterSeq: number | null; requested: boolean } {
  const q = ctx.query
  const afterSeqRaw = q.get('after_seq')
  const afterEventId = (q.get('after_event_id') ?? '').trim()
  const explicit = (afterSeqRaw !== null && afterSeqRaw !== '') || Boolean(afterEventId) || Boolean(q.get('replay'))
  if (explicit) {
    const [runId, seq] = parseRunJournalEventId(afterEventId)
    if (runId) return { afterSeq: runId === streamId ? seq : null, requested: true }
    if (afterSeqRaw === null || afterSeqRaw === '') return { afterSeq: null, requested: true }
    const parsed = Number.parseInt(afterSeqRaw, 10)
    return { afterSeq: Number.isFinite(parsed) ? Math.max(0, parsed) : 0, requested: true }
  }
  const header = (ctx.header('last-event-id') ?? '').trim()
  if (!header) return { afterSeq: null, requested: false }
  const [runId, seq] = parseRunJournalEventId(header)
  if (runId && seq !== null) return { afterSeq: runId === streamId ? seq : null, requested: true }
  return { afterSeq: null, requested: true }
}

/**
 * A frame's payload as it may cross the SSE boundary: a tool frame produced unredacted (before this server redacted them,
 * or while redaction was off, then journaled or buffered for a late subscriber) is redacted under the current policy and
 * stamped on the way out.
 */
function publicFramePayload(ctx: RequestContext, event: string, payload: unknown, redacted: boolean | undefined): unknown {
  const tool = (event === 'tool' || event === 'tool_complete') && redacted !== true && payload && typeof payload === 'object' && !Array.isArray(payload)
  return tool ? publicToolFrame(payload as Record<string, unknown>, ctx.deps.sessions.deps.redactEnabled()) : payload
}

/** Journal rows written before the public tool `id`, keyed by run: each row's id, paired the way the live server pairs them. */
type LegacyToolIds = Map<string, Map<number, string>>

function legacyToolIds(ctx: RequestContext, entry: JournalEvent, cache: LegacyToolIds): Map<number, string> {
  let ids = cache.get(entry.run_id)
  if (ids) return ids
  ids = new Map()
  cache.set(entry.run_id, ids)
  const calls: { name: unknown; tid: string; id: string; done: boolean }[] = []
  for (const row of ctx.deps.journal.readRunEvents(entry.session_id, entry.run_id)) {
    if ((row.event !== 'tool' && row.event !== 'tool_complete') || !row.payload || typeof row.payload !== 'object') continue
    const data = row.payload as Record<string, unknown>
    const tid = str(data.tid)
    const call = row.event === 'tool' ? undefined : calls[completedToolIndex(calls, tid, data.name)]
    if (call) call.done = true
    const id = call?.id ?? (tid || `tool-${row.event_id}`)
    if (row.event === 'tool') calls.push({ name: data.name, tid, id, done: false })
    ids.set(row.seq, id)
  }
  return ids
}

function publicJournalPayload(ctx: RequestContext, entry: JournalEvent, legacy: LegacyToolIds): unknown {
  const { payload } = entry
  if ((entry.event !== 'tool' && entry.event !== 'tool_complete') || !payload || typeof payload !== 'object' || Array.isArray(payload) || 'id' in payload) return publicFramePayload(ctx, entry.event, payload, entry.redacted)
  // A journal written before the public `id` carries the Agent's call id as `tid`, or nothing when the Agent sent none; the id
  // joins the frame before the redaction pass, like a live frame's.
  const id = legacyToolIds(ctx, entry, legacy).get(entry.seq) ?? `tool-${entry.event_id}`
  return publicFramePayload(ctx, entry.event, withToolId(payload as Record<string, unknown>, id), entry.redacted)
}

function replayRunJournal(ctx: RequestContext, sse: SseWriter, streamId: string, afterSeq: number | null, opts: { maxSeq?: number | null; includeStale?: boolean } = {}): { found: boolean; terminal: boolean } {
  const summary = ctx.deps.journal.findRunSummary(streamId)
  if (!summary) return { found: false, terminal: false }
  let terminal = false
  const events = ctx.deps.journal.readRunEvents(summary.session_id, streamId, { afterSeq, maxSeq: opts.maxSeq ?? null })
  const legacy: LegacyToolIds = new Map()
  for (const entry of events) {
    sse.event(entry.event || 'message', publicJournalPayload(ctx, entry, legacy), entry.event_id)
    if (SSE_RELAY_CLOSE_EVENTS.has(entry.event)) terminal = true
  }
  if ((opts.includeStale ?? true) && !summary.terminal) {
    const stale = ctx.deps.journal.staleInterruptedEvent(summary.session_id, streamId, afterSeq, ctx.deps.auth.now())
    if (stale) sse.event(stale.event, stale.payload, stale.event_id)
  }
  return { found: true, terminal }
}

function journalCoversGap(ctx: RequestContext, streamId: string, afterSeq: number | null, cutoff: number | null): boolean {
  if (cutoff === null) return false
  const floor = afterSeq === null ? 0 : Math.max(0, afterSeq)
  if (floor >= cutoff) return true
  const summary = ctx.deps.journal.findRunSummary(streamId)
  if (!summary) return false
  const seqs = new Set<number>()
  for (const e of ctx.deps.journal.readRunEvents(summary.session_id, streamId, { afterSeq: floor, maxSeq: cutoff })) if (e.seq > floor && e.seq <= cutoff) seqs.add(e.seq)
  return seqs.size === cutoff - floor
}

async function drainStream(ctx: RequestContext, sse: SseWriter, sub: StreamSubscriber, streamId: string, replayCutoffSeq: number | null): Promise<void> {
  for (;;) {
    if (sse.isClosed) return
    const item = await nextItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
    if (sse.isClosed) return
    if (!item) { sse.comment('heartbeat'); continue }
    const [event, data, eventId, redacted] = item
    const seq = sameRunSeq(eventId, streamId)
    if (replayCutoffSeq !== null && seq !== null && seq <= replayCutoffSeq) {
      if (SSE_RELAY_CLOSE_EVENTS.has(event)) return
      continue
    }
    sse.event(event, publicFramePayload(ctx, event, data, redacted), eventId)
    if (SSE_RELAY_CLOSE_EVENTS.has(event)) return
  }
}

export async function handleChatStream(ctx: RequestContext): Promise<void> {
  const streamId = ctx.query.get('stream_id') ?? ''
  const owner = streamOwnerSessionId(ctx, streamId)
  if (owner && !ctx.deps.sessions.sessionIdVisible(owner)) { ctx.json({ error: 'Session not found' }, { status: 404 }); return }
  const cursor = resumeCursor(ctx, streamId)
  const channel = ctx.deps.registry.peek(streamId)
  if (!channel) {
    const summary = streamId ? ctx.deps.journal.findRunSummary(streamId) : null
    if (!summary) { ctx.json({ error: 'stream not found' }, { status: 404 }); return }
    let afterSeq = cursor.afterSeq
    if (afterSeq !== null && afterSeq > (summary.last_seq || 0)) afterSeq = 0
    const sse = claimOrReject(ctx, true)
    if (!sse) return
    sse.start()
    try { replayRunJournal(ctx, sse, streamId, afterSeq) } finally { sse.end() }
    return
  }
  const [sub, snapshot] = channel.subscribeWithSnapshot()
  const sse = claimOrReject(ctx, true)
  if (!sse) { channel.unsubscribe(sub); return }
  sse.start()
  try {
    let replayCutoffSeq: number | null = null
    if (cursor.requested) {
      let afterSeq = cursor.afterSeq ?? 0
      const snapshotCutoff = sameRunSeq(snapshot.last_event_id, streamId)
      const effectiveCutoff = snapshotCutoff ?? 0
      if (afterSeq > effectiveCutoff) afterSeq = 0
      let replayMaxSeq = snapshotCutoff
      const firstBuffered = sameRunSeq(snapshot.offline_first_event_id, streamId)
      if (firstBuffered !== null) replayMaxSeq = snapshotCutoff === null ? firstBuffered - 1 : Math.min(firstBuffered - 1, snapshotCutoff)
      const cursorCoversSnapshot = snapshotCutoff !== null && afterSeq >= snapshotCutoff
      const droppedGapRequired = snapshot.offline_dropped_events > 0 && !cursorCoversSnapshot && (firstBuffered === null || afterSeq < firstBuffered - 1)
      const gapRequired = droppedGapRequired || (replayMaxSeq !== null && replayMaxSeq > afterSeq)
      const covered = !gapRequired || journalCoversGap(ctx, streamId, afterSeq, replayMaxSeq)
      let replayed = false
      let terminalReplayed = false
      if (covered) {
        const result = replayRunJournal(ctx, sse, streamId, afterSeq, { maxSeq: replayMaxSeq, includeStale: false })
        replayed = result.found
        terminalReplayed = result.terminal
        if (replayed) replayCutoffSeq = replayMaxSeq
      }
      if (gapRequired && (!covered || !replayed)) {
        sse.event('apperror', { type: 'interrupted', terminal_state: 'interrupted', recovery_control: true, message: "The live stream's replay buffer overflowed while no tab was attached and the run journal cannot backfill the dropped frames.", hint: 'The transcript was restored to the last saved state.', session_id: owner ?? '', stream_id: streamId, offline_dropped_events: snapshot.offline_dropped_events || Math.max(0, (replayMaxSeq ?? 0) - afterSeq) })
        return
      }
      if (terminalReplayed) return
      if (afterSeq > 0 && (snapshotCutoff === null || afterSeq <= snapshotCutoff)) replayCutoffSeq = replayCutoffSeq === null ? afterSeq : Math.max(replayCutoffSeq, afterSeq)
    }
    await drainStream(ctx, sse, sub, streamId, replayCutoffSeq)
  } finally {
    channel.unsubscribe(sub)
    sse.end()
  }
}

/** `/api/session/stream`: the persistent per-session channel. */
export async function handleSessionStream(ctx: RequestContext): Promise<void> {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) { ctx.json({ error: 'session_id is required' }, { status: 400 }); return }
  if (!ctx.deps.sessions.sessionIdVisible(sid)) { ctx.json({ error: 'Session not found' }, { status: 404 }); return }
  const knownRaw = ctx.query.get('known_count') ?? ''
  const knownCount = knownRaw !== '' && /^-?\d+$/.test(knownRaw) ? Number.parseInt(knownRaw, 10) : null
  const sub = ctx.deps.channels.subscribe(sid)
  const sse = claimOrReject(ctx, false)
  if (!sse) { ctx.deps.channels.unsubscribe(sid, sub); return }
  try {
    sse.start()
    sse.event('initial', { session_id: sid })
    const recover = ctx.deps.registry.attachableRunForSession(sid)
    if (recover) {
      let pendingStartedAt: number | null = null
      try { pendingStartedAt = ctx.deps.sessionStore.get(sid, { metadataOnly: true }).pending_started_at } catch { pendingStartedAt = null }
      sse.event('server_turn_started', { session_id: sid, stream_id: recover, turn_id: recover, pending_started_at: pendingStartedAt, source: 'subscribe_recovery', recovered: true })
    } else if (knownCount !== null) {
      let persisted: number | null = null
      try {
        const s = ctx.deps.sessionStore.get(sid, { metadataOnly: true })
        persisted = s.metadataMessageCount ?? (s.messages.length || null)
      } catch { persisted = null }
      if (persisted !== null && persisted > knownCount) sse.event('session-updated', { session_id: sid, message_count: persisted, known_count: knownCount, source: 'subscribe_recovery' })
    }
    for (;;) {
      if (sse.isClosed) return
      const item = await nextSessionItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
      if (sse.isClosed) return
      if (!item) { sse.comment('keepalive'); continue }
      sse.event(item[0], item[1])
    }
  } finally {
    ctx.deps.channels.unsubscribe(sid, sub)
    sse.end()
  }
}

/** Python `_gateway_sse_probe_payload`: status of the optional gateway stream only, never of `/api/session/stream`. */
export function gatewayProbePayload(ctx: RequestContext, watcher: GatewayWatcher | null): [Record<string, unknown>, number] {
  const enabled = Boolean(ctx.deps.settings.load().show_cli_sessions)
  const alive = watcher?.isAlive() ?? false
  const payload: Record<string, unknown> = { enabled, fallback_poll_ms: 30000, ok: enabled && alive, watcher_running: alive, scope: 'gateway_sessions', session_stream_available: true, session_stream_path: '/api/session/stream' }
  if (!enabled) { payload.error = 'agent sessions not enabled'; return [payload, 404] }
  if (!alive) { payload.error = 'watcher not started'; return [payload, 503] }
  return [payload, 200]
}

const truthyQuery = (value: string | null): boolean => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
const MERGED_SIDEBAR_DRAIN_MS = 250

function initialGatewaySessions(ctx: RequestContext): Record<string, unknown>[] {
  return ctx.deps.cliSessions.load(ctx.deps.activeProfile(), {})
}

/** Wait for the next session event, or null after `waitMs` / request abort. */
async function nextWithin<T>(next: (signal: AbortSignal) => Promise<T | null>, waitMs: number, abort: AbortSignal): Promise<T | null> {
  const timer = new AbortController()
  const timeout = setTimeout(() => { timer.abort() }, waitMs)
  const onAbort = (): void => { timer.abort() }
  abort.addEventListener('abort', onAbort, { once: true })
  try {
    return await next(timer.signal)
  } finally {
    clearTimeout(timeout)
    abort.removeEventListener('abort', onAbort)
  }
}

/** `/api/sessions/events`: global session-list invalidation; `?gateway=1` merges the watcher feed with a `stream` discriminator. */
export async function handleSessionEvents(ctx: RequestContext): Promise<void> {
  const wantGateway = truthyQuery(ctx.query.get('gateway'))
  let watcher: GatewayWatcher | null = null
  let gatewayStatus: Record<string, unknown> | null = null
  if (wantGateway) {
    watcher = ctx.deps.gatewayWatchers.get(ctx.deps.activeProfile())
    gatewayStatus = gatewayProbePayload(ctx, watcher)[0]
  }
  const sub = ctx.deps.events.subscribe()
  const sse = claimOrReject(ctx, false)
  if (!sse) { sub.close(); return }
  const abort = new AbortController()
  ctx.res.on('close', () => { abort.abort() })
  const gatewaySub = wantGateway && gatewayStatus?.ok === true && watcher ? watcher.subscribe() : null
  try {
    sse.start()
    if (wantGateway && gatewayStatus) sse.event('gateway_status', gatewayStatus)
    if (gatewaySub) sse.event('sessions_changed', { type: 'sessions_changed', sessions: initialGatewaySessions(ctx), stream: 'gateway' })
    let lastWrite = Date.now()
    for (;;) {
      if (sse.isClosed) return
      // ponytail: 250 ms alternating drain instead of a fan-in; the watcher polls on a multi-second cadence.
      if (gatewaySub) {
        for (;;) {
          const pending = await nextWithin((signal) => gatewaySub.next(signal), 0, abort.signal)
          if (pending === null) {
            // The watcher stopped (a profile switch swapped it): end the response so EventSource reconnects both halves.
            if (!watcher?.isAlive() || abort.signal.aborted) return
            break
          }
          sse.event(pending.type, { ...pending, stream: 'gateway' })
          lastWrite = Date.now()
        }
      }
      const event = await nextWithin((signal) => sub.next(signal), gatewaySub ? MERGED_SIDEBAR_DRAIN_MS : SSE_HEARTBEAT_INTERVAL_MS, abort.signal)
      if (sse.isClosed) return
      if (!event) {
        if (Date.now() - lastWrite < SSE_HEARTBEAT_INTERVAL_MS) continue
        sse.comment('keepalive')
        lastWrite = Date.now()
        continue
      }
      sse.event(event.type, { ...event, stream: 'sessions' })
      lastWrite = Date.now()
    }
  } finally {
    sub.close()
    gatewaySub?.close()
    sse.end()
  }
}

/** `/api/sessions/{sid}/events`: per-session journal relay with snapshot fallback. */
export async function handleSessionJournalStream(ctx: RequestContext, sessionId: string): Promise<void> {
  if (!ctx.deps.sessions.sessionIdVisible(sessionId)) { ctx.json({ error: 'Session not found' }, { status: 404 }); return }
  let session: Session
  try { session = ctx.deps.sessionStore.get(sessionId, { metadataOnly: true }) } catch { ctx.json({ error: 'Session not found' }, { status: 404 }); return }
  const resumeEventId = (ctx.header('last-event-id') ?? '').trim() || (ctx.query.get('after_event_id') ?? '').trim() || null
  let idleFingerprint = ctx.deps.journal.sessionJournalFingerprint(sessionId)
  const sse = claimOrReject(ctx, false)
  if (!sse) return
  sse.start()
  const sent = new Set<string>()
  const sentOrder: string[] = []
  const note = (id: string): void => { sent.add(id); sentOrder.push(id); while (sentOrder.length > SESSION_SSE_SENT_EVENT_ID_LIMIT) sent.delete(sentOrder.shift()!) }
  const emitReplay = (events: JournalEvent[], streamId: string | null, cutoff: number | null): void => {
    const legacy: LegacyToolIds = new Map()
    for (const entry of events) {
      const seq = streamId ? sameRunSeq(entry.event_id, streamId) : null
      if (cutoff !== null && seq !== null && seq > cutoff) continue
      if (entry.event_id && sent.has(entry.event_id)) continue
      sse.event(entry.event || 'message', publicJournalPayload(ctx, entry, legacy), entry.event_id)
      if (entry.event_id) note(entry.event_id)
    }
  }
  const snapshot = (activeStreamId: string | null): void => {
    let fresh = session
    try { fresh = ctx.deps.sessionStore.get(sessionId, { metadataOnly: true }) } catch { fresh = session }
    sse.event('session_snapshot', { session: withSessionWireFlags({ ...fresh.compact({ contextLengthFor: ctx.deps.sessions.deps.contextLengthFor }), read_only: ctx.deps.sessions.isReadOnly(fresh) }, new Set(activeStreamId ? [activeStreamId] : [])) })
  }
  const attach = (): { sub: StreamSubscriber | null; streamId: string | null; snapshot: { last_event_id: string | null } } => {
    const streamId = ctx.deps.registry.activeRunStreamForSession(sessionId)
    const channel = streamId ? ctx.deps.registry.peek(streamId) : undefined
    if (!streamId || !channel) return { sub: null, streamId, snapshot: { last_event_id: null } }
    const [sub, snap] = channel.subscribeWithSnapshot()
    return { sub, streamId, snapshot: snap }
  }
  let attached = attach()
  try {
    let replayOk = false
    let replayEvents: JournalEvent[] = []
    if (resumeEventId) {
      const replay = ctx.deps.journal.readSessionRunEvents(sessionId, resumeEventId)
      if (replay.status !== 'ok') snapshot(attached.streamId)
      else { replayOk = true; replayEvents = replay.events }
    }
    if (!attached.sub) {
      if (replayOk) emitReplay(replayEvents, attached.streamId, null)
      for (;;) {
        if (sse.isClosed) return
        attached = attach()
        if (attached.sub) break
        const fp = ctx.deps.journal.sessionJournalFingerprint(sessionId)
        if (fp !== idleFingerprint) { idleFingerprint = fp; snapshot(attached.streamId) }
        sse.comment('keepalive')
        await new Promise((r) => setTimeout(r, SSE_HEARTBEAT_INTERVAL_MS))
      }
    }
    const sub = attached.sub
    const streamId = attached.streamId!
    let cutoff: number | null = null
    if (replayOk) {
      cutoff = sameRunSeq(attached.snapshot.last_event_id, streamId)
      const reconciled = ctx.deps.journal.readSessionRunEvents(sessionId, resumeEventId)
      if (reconciled.status === 'ok') emitReplay(reconciled.events, streamId, cutoff)
      else snapshot(streamId)
    }
    for (;;) {
      if (sse.isClosed) return
      const item = await nextItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
      if (sse.isClosed) return
      if (!item) { sse.comment('keepalive'); continue }
      const [event, data, eventId, redacted] = item
      const seq = sameRunSeq(eventId, streamId)
      const terminal = SSE_RELAY_CLOSE_EVENTS.has(event)
      const alreadySent = (cutoff !== null && seq !== null && seq <= cutoff) || (eventId !== null && sent.has(eventId))
      if (alreadySent) { if (terminal) return; continue }
      sse.event(event, publicFramePayload(ctx, event, data, redacted), eventId)
      if (eventId) note(eventId)
      if (terminal) return
    }
  } finally {
    if (attached.sub && attached.streamId) ctx.deps.registry.peek(attached.streamId)?.unsubscribe(attached.sub)
    sse.end()
  }
}

async function promptStream(ctx: RequestContext, kind: 'approval' | 'clarify'): Promise<void> {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) { ctx.json({ error: 'session_id is required' }, { status: 400 }); return }
  const [sub, initial] = kind === 'approval' ? ctx.deps.pending.subscribeApprovals(sid) : ctx.deps.pending.subscribeClarifies(sid)
  const release = (): void => { if (kind === 'approval') ctx.deps.pending.unsubscribeApprovals(sid, sub); else ctx.deps.pending.unsubscribeClarifies(sid, sub) }
  const sse = claimOrReject(ctx, true)
  if (!sse) { release(); return }
  try {
    sse.start()
    sse.event('initial', initial)
    for (;;) {
      if (sse.isClosed) return
      const item = await nextPendingItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
      if (sse.isClosed) return
      if (!item) { sse.comment('keepalive'); continue }
      sse.event(kind, item)
    }
  } finally {
    release()
    sse.end()
  }
}

export const handleApprovalStream = (ctx: RequestContext): Promise<void> => promptStream(ctx, 'approval')
export const handleClarifyStream = (ctx: RequestContext): Promise<void> => promptStream(ctx, 'clarify')

export function sessionEventsPathSessionId(path: string): string | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'sessions' || parts[3] !== 'events') return null
  const sid = str(parts[2]).trim()
  return sid || null
}
