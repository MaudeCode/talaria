import { showReasoning } from '../config/agent-config.js'
import { reasoningProjection } from '../sessions/reasoning-display.js'
/**
 * Server-sent event endpoints: the chat relay with journal replay, the
 * persistent per-session channel, the global session-list feed, the
 * per-session journal relay, and the approval/clarify prompt feeds
 * (Python `_handle_sse_stream`, `_handle_session_sse_stream`,
 * `_handle_session_events_stream`, `_handle_session_run_journal_stream_for_session`).
 */
import type { RequestContext } from '../http/context.js'
import { parseRunJournalEventId, PromptReplayFilter, runRowsAfter, SSE_RELAY_CLOSE_EVENTS, type JournalEvent, type RunJournal } from '../sessions/journal.js'
import type { SessionJournalReplay } from '../sessions/storage/backend.js'
import { nextItem, nextSessionItem, type StreamSubscriber } from '../sessions/streams.js'
import { nextPendingItem } from '../sessions/pending.js'
import type { Session } from '../sessions/session.js'
import { withSessionWireFlags } from '../sessions/list.js'
import type { GatewayWatcher } from '../sessions/gateway-watcher.js'
import { str } from '../util.js'
import { streamOwnerSessionId, streamVisibleToRequest } from './session-visibility.js'
import { completedToolIndex, publicToolFrame, withToolId } from '../redact.js'

export const SSE_HEARTBEAT_INTERVAL_MS = 5_000
const SESSION_SSE_SENT_EVENT_ID_LIMIT = 4096

/** Shared keyed concurrency budget; SSE uses it for Python `promote_request_to_stream`. */
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

/**
 * Python served SSE on blocking sockets, so a slow reader stalled its own producer. Writes here are buffered by Node, and
 * every streaming loop awaits `ready()` before pulling its next frame, which restores that stall instead of disconnecting.
 */
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
    const config = this.ctx.deps.agentConfig.peek(this.ctx.deps.profileHome(this.ctx.deps.activeProfile()))
    const show = config !== null && showReasoning(config)
    if (event === 'reasoning' && !show) return
    const body = JSON.stringify(reasoningProjection(data ?? {}, show))
    this.write(`${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${body}\n\n`)
  }

  comment(text: string): void {
    this.write(`: ${text}\n\n`)
  }

  private write(chunk: string): void {
    if (this.isClosed) return
    this.ctx.res.write(chunk)
  }

  /**
   * Resolves once the socket has taken what was written, or the client left: true while it is still connected.
   * Replays await it per frame and page the journal (`iterRunEvents`), so a slow reader holds one page plus data near
   * the socket's high-water mark; frames the subscriber's bounded queue drops while this waits are backfilled from the
   * journal (`recoverDropped`).
   */
  async ready(): Promise<boolean> {
    const { res } = this.ctx
    if (!this.isClosed && res.writableNeedDrain) {
      await new Promise<void>((resolve) => {
        const done = (): void => { res.off('drain', done); res.off('close', done); resolve() }
        res.on('drain', done)
        res.on('close', done)
      })
    }
    return !this.isClosed
  }

  end(): void {
    if (!this.isClosed) this.ctx.res.end()
    this.closed = true
    this.release()
  }
}

export async function claimOrReject(ctx: RequestContext, connectionClose: boolean): Promise<SseWriter | null> {
  const release = ctx.deps.streamSlots.claim(clientStreamKey(ctx))
  if (!release) {
    await ctx.json({ error: 'Client SSE stream limit reached', condition: 'client_stream_limit' }, { status: 503, headers: { Connection: 'close' } })
    return null
  }
  const writer = new SseWriter(ctx, release, connectionClose)
  await ctx.deps.agentConfig.read(ctx.deps.profileHome(ctx.deps.activeProfile())).catch(() => undefined)
  return writer
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
  const tool = (event === 'tool' || event === 'tool_complete' || event === 'tool_progress') && redacted !== true && payload && typeof payload === 'object' && !Array.isArray(payload)
  return tool ? publicToolFrame(payload as Record<string, unknown>, ctx.deps.sessions.deps.redactEnabled()) : payload
}

/**
 * Public tool ids for journal rows written before frames carried one, paired the way the live server pairs them. Each
 * run's journal is walked alongside the replay (its rows arrive in seq order), holding only the calls still open.
 */
class LegacyToolIds {
  private readonly runs = new Map<string, { rows: AsyncGenerator<JournalEvent>; open: { name: unknown; tid: string; id: string }[]; seq: number; id: string | null }>()

  constructor(private readonly journal: RunJournal) {}

  async idFor(entry: JournalEvent): Promise<string | null> {
    let run = this.runs.get(entry.run_id)
    if (!run) {
      run = { rows: this.journal.iterRunEvents(entry.session_id, entry.run_id), open: [], seq: 0, id: null }
      this.runs.set(entry.run_id, run)
    }
    while (run.seq < entry.seq) {
      const next = await run.rows.next()
      if (next.done) return null
      run.seq = next.value.seq
      run.id = pairLegacyTool(run.open, next.value)
    }
    return run.seq === entry.seq ? run.id : null
  }

  async close(): Promise<void> { for (const run of this.runs.values()) await run.rows.return(undefined) }
}

/** One row's tool id; a `tool` opens a call, a `tool_complete` closes the call it completes (done calls never match again). */
function pairLegacyTool(open: { name: unknown; tid: string; id: string }[], row: JournalEvent): string | null {
  if ((row.event !== 'tool' && row.event !== 'tool_complete') || !row.payload || typeof row.payload !== 'object') return null
  const data = row.payload as Record<string, unknown>
  const tid = str(data.tid)
  const own = tid || `tool-${row.event_id}`
  if (row.event === 'tool') { open.push({ name: data.name, tid, id: own }); return own }
  const index = completedToolIndex(open, tid, data.name)
  return index < 0 ? own : open.splice(index, 1)[0]!.id
}

async function publicJournalPayload(ctx: RequestContext, entry: JournalEvent, legacy: LegacyToolIds): Promise<unknown> {
  const { payload } = entry
  if ((entry.event !== 'tool' && entry.event !== 'tool_complete') || !payload || typeof payload !== 'object' || Array.isArray(payload) || 'id' in payload) return publicFramePayload(ctx, entry.event, payload, entry.redacted)
  // A journal written before the public `id` carries the Agent's call id as `tid`, or nothing when the Agent sent none; the id
  // joins the frame before the redaction pass, like a live frame's.
  const id = (await legacy.idFor(entry)) ?? `tool-${entry.event_id}`
  return publicFramePayload(ctx, entry.event, withToolId(payload as Record<string, unknown>, id), entry.redacted)
}

async function replayRunJournal(ctx: RequestContext, sse: SseWriter, streamId: string, afterSeq: number | null, opts: { maxSeq?: number | null; includeStale?: boolean } = {}): Promise<{ found: boolean; terminal: boolean }> {
  const summary = (await ctx.deps.journal.findRunSummary(streamId))
  if (!summary) return { found: false, terminal: false }
  let terminal = false
  const legacy = new LegacyToolIds(ctx.deps.journal)
  const maxSeq = opts.maxSeq ?? null
  const prompts = new PromptReplayFilter((prompt) => ctx.deps.journal.iterRunEvents(summary.session_id, streamId, { afterSeq: prompt.seq, maxSeq }), summary.terminal ? null : streamId)
  try {
    for await (const entry of ctx.deps.journal.iterRunEvents(summary.session_id, streamId, { afterSeq, maxSeq })) {
      if (!(await sse.ready())) return { found: true, terminal }
      if (!(await prompts.visible(entry))) continue
      sse.event(entry.event || 'message', (await publicJournalPayload(ctx, entry, legacy)), entry.event_id)
      if (SSE_RELAY_CLOSE_EVENTS.has(entry.event)) terminal = true
    }
  } finally {
    await legacy.close()
    await prompts.close()
  }
  if ((opts.includeStale ?? true) && !summary.terminal) {
    const stale = (await ctx.deps.journal.staleInterruptedEvent(summary.session_id, streamId, afterSeq, ctx.deps.auth.now()))
    if (stale) sse.event(stale.event, stale.payload, stale.event_id)
  }
  return { found: true, terminal }
}

async function journalCoversGap(ctx: RequestContext, streamId: string, afterSeq: number | null, cutoff: number | null): Promise<boolean> {
  if (cutoff === null) return false
  const floor = afterSeq === null ? 0 : Math.max(0, afterSeq)
  if (floor >= cutoff) return true
  const summary = (await ctx.deps.journal.findRunSummary(streamId))
  if (!summary) return false
  const seqs = new Set<number>()
  for await (const e of ctx.deps.journal.iterRunEvents(summary.session_id, streamId, { afterSeq: floor, maxSeq: cutoff })) if (e.seq > floor && e.seq <= cutoff) seqs.add(e.seq)
  return seqs.size === cutoff - floor
}

/** The recovery frame for live frames that are gone: the client restores the last saved transcript. */
function interruptedFrame(sessionId: string, streamId: string, dropped: number, message: string): Record<string, unknown> {
  return { type: 'interrupted', terminal_state: 'interrupted', recovery_control: true, message, hint: 'The transcript was restored to the last saved state.', session_id: sessionId, stream_id: streamId, offline_dropped_events: dropped }
}

/**
 * Before sending the live frame `seq`, send what `sub`'s bounded queue dropped while its writer waited for a slow reader:
 * `backfill` gets the journal range (rows at or below `floor` were already sent), then the newest copy of each dropped
 * refetch signal follows. When the journal cannot cover the run frames, the interrupted recovery frame is sent instead and
 * this returns false, ending the stream.
 */
async function recoverDropped(ctx: RequestContext, sse: SseWriter, sub: StreamSubscriber, streamId: string, sessionId: string, seq: number | null, floor: number | null, backfill: (range: { afterSeq: number; maxSeq: number }) => Promise<void>): Promise<boolean> {
  const gap = sub.gap
  if (!gap) return true
  const journaled = gap.firstEventId !== null
  const from = sameRunSeq(gap.firstEventId, streamId)
  // Journaled drops are bounded by the next journaled frame after them; a frame dequeued before the drops leaves them open.
  if (!gap.unjournaled && journaled && (seq === null || (from !== null && seq < from))) return true
  sub.gap = null
  if (journaled || gap.unjournaled) {
    const afterSeq = Math.max((from ?? 1) - 1, floor ?? 0)
    if (gap.unjournaled || from === null || seq === null || !(await journalCoversGap(ctx, streamId, afterSeq, seq - 1))) {
      sse.event('apperror', interruptedFrame(sessionId, streamId, gap.dropped, 'The live stream fell behind a slow connection and the run journal cannot backfill the dropped frames.'))
      return false
    }
    await backfill({ afterSeq, maxSeq: seq - 1 })
  }
  for (const [event, data] of gap.signals) sse.event(event, data)
  return true
}

/**
 * The prompt policy for frames a subscriber starts with: a live channel buffers frames while no tab is attached, and a new
 * subscriber receives them (every journaled frame at or below the subscribe snapshot), so they are a replay too.
 */
function bufferedPrompts(ctx: RequestContext, sessionId: string, streamId: string, snapshotSeq: number | null): { visible: (event: string, payload: unknown, seq: number | null) => Promise<boolean>; close: () => Promise<void> } {
  const prompts = new PromptReplayFilter((prompt) => ctx.deps.journal.iterRunEvents(sessionId, streamId, { afterSeq: prompt.seq, maxSeq: snapshotSeq }))
  return {
    visible: async (event, payload, seq) => snapshotSeq === null || seq === null || seq > snapshotSeq || prompts.visible({ event, payload, seq, run_id: streamId }),
    close: () => prompts.close(),
  }
}

async function drainStream(ctx: RequestContext, sse: SseWriter, sub: StreamSubscriber, streamId: string, replayCutoffSeq: number | null, sessionId: string, snapshotSeq: number | null): Promise<void> {
  const buffered = bufferedPrompts(ctx, sessionId, streamId, snapshotSeq)
  try {
    for (;;) {
      if (!(await sse.ready())) return
      const item = await nextItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
      if (sse.isClosed) return
      if (!item) { sse.comment('heartbeat'); continue }
      const [event, data, eventId, redacted] = item
      const seq = sameRunSeq(eventId, streamId)
      if (!(await recoverDropped(ctx, sse, sub, streamId, sessionId, seq, replayCutoffSeq, async (gap) => { await replayRunJournal(ctx, sse, streamId, gap.afterSeq, { maxSeq: gap.maxSeq, includeStale: false }) }))) return
      if (replayCutoffSeq !== null && seq !== null && seq <= replayCutoffSeq) {
        if (SSE_RELAY_CLOSE_EVENTS.has(event)) return
        continue
      }
      if (!(await buffered.visible(event, data, seq))) continue
      sse.event(event, publicFramePayload(ctx, event, data, redacted), eventId)
      if (SSE_RELAY_CLOSE_EVENTS.has(event)) return
    }
  } finally {
    await buffered.close()
  }
}

export async function handleChatStream(ctx: RequestContext): Promise<void> {
  const streamId = ctx.query.get('stream_id') ?? ''
  const owner = (await streamOwnerSessionId(ctx, streamId))
  if (!(await streamVisibleToRequest(ctx, streamId))) { (await ctx.json({ error: 'Session not found' }, { status: 404 })); return }
  const cursor = resumeCursor(ctx, streamId)
  const channel = ctx.deps.registry.peek(streamId)
  if (!channel) {
    const summary = streamId ? (await ctx.deps.journal.findRunSummary(streamId)) : null
    if (!summary) { (await ctx.json({ error: 'stream not found' }, { status: 404 })); return }
    let afterSeq = cursor.afterSeq
    if (afterSeq !== null && afterSeq > (summary.last_seq || 0)) afterSeq = 0
    const sse = (await claimOrReject(ctx, true))
    if (!sse) return
    sse.start()
    try { await replayRunJournal(ctx, sse, streamId, afterSeq) } finally { sse.end() }
    return
  }
  const [sub, snapshot] = channel.subscribeWithSnapshot()
  const sse = (await claimOrReject(ctx, true))
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
      const covered = !gapRequired || (await journalCoversGap(ctx, streamId, afterSeq, replayMaxSeq))
      let replayed = false
      let terminalReplayed = false
      if (covered) {
        const result = await replayRunJournal(ctx, sse, streamId, afterSeq, { maxSeq: replayMaxSeq, includeStale: false })
        replayed = result.found
        terminalReplayed = result.terminal
        if (replayed) replayCutoffSeq = replayMaxSeq
      }
      if (gapRequired && (!covered || !replayed)) {
        sse.event('apperror', interruptedFrame(owner ?? '', streamId, snapshot.offline_dropped_events || Math.max(0, (replayMaxSeq ?? 0) - afterSeq), "The live stream's replay buffer overflowed while no tab was attached and the run journal cannot backfill the dropped frames."))
        return
      }
      if (terminalReplayed) return
      if (afterSeq > 0 && (snapshotCutoff === null || afterSeq <= snapshotCutoff)) replayCutoffSeq = replayCutoffSeq === null ? afterSeq : Math.max(replayCutoffSeq, afterSeq)
    }
    await drainStream(ctx, sse, sub, streamId, replayCutoffSeq, owner ?? '', sameRunSeq(snapshot.last_event_id, streamId))
  } finally {
    channel.unsubscribe(sub)
    sse.end()
  }
}

/** `/api/session/stream`: the persistent per-session channel. */
export async function handleSessionStream(ctx: RequestContext): Promise<void> {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) { (await ctx.json({ error: 'session_id is required' }, { status: 400 })); return }
  if (!(await ctx.deps.sessions.sessionIdVisible(sid))) { (await ctx.json({ error: 'Session not found' }, { status: 404 })); return }
  const knownRaw = ctx.query.get('known_count') ?? ''
  const knownCount = knownRaw !== '' && /^-?\d+$/.test(knownRaw) ? Number.parseInt(knownRaw, 10) : null
  const sse = (await claimOrReject(ctx, false))
  if (!sse) return
  const profile = ctx.deps.activeProfile()
  const sub = ctx.deps.channels.subscribe(sid, profile)
  const controller = new AbortController()
  const abort = () => { controller.abort(); sub.wake?.() }
  ctx.res.once('close', abort)
  let releaseObservation: () => void = () => undefined
  let nativeEnded = false
  const observationEnded = () => { nativeEnded = true; sub.wake?.() }
  try {
    sse.start()
    sse.event('initial', { session_id: sid })
    // Attachment can wait on a native RPC; the HTTP owner must keep draining and heartbeating meanwhile.
    void ctx.deps.sessions.owner?.observe(sid, profile, controller.signal).then((acquired) => {
      if (controller.signal.aborted) { acquired?.release(); return }
      if (!acquired) return
      releaseObservation = acquired.release
      void acquired.ended.then(observationEnded, observationEnded)
    }).catch(observationEnded)
    if (sse.isClosed) return
    const recover = ctx.deps.registry.attachableRunForSession(sid)
    if (recover) {
      let pendingStartedAt: number | null = null
      try { pendingStartedAt = (await ctx.deps.sessionStore.get(sid, { metadataOnly: true })).pending_started_at } catch { pendingStartedAt = null }
      sse.event('server_turn_started', { session_id: sid, stream_id: recover, turn_id: recover, pending_started_at: pendingStartedAt, source: 'subscribe_recovery', recovered: true })
    } else if (knownCount !== null) {
      let persisted: number | null = null
      try {
        const s = (await ctx.deps.sessionStore.get(sid, { metadataOnly: true }))
        persisted = s.metadataMessageCount ?? (s.messages.length || null)
      } catch { persisted = null }
      if (persisted !== null && persisted > knownCount) sse.event('session-updated', { session_id: sid, message_count: persisted, known_count: knownCount, source: 'subscribe_recovery' })
    }
    for (;;) {
      if (!(await sse.ready())) return
      if (nativeEnded) return
      const item = await nextSessionItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
      if (sse.isClosed || nativeEnded || controller.signal.aborted) return
      if (!item) { sse.comment('keepalive'); continue }
      sse.event(item[0], item[1])
    }
  } finally {
    ctx.res.removeListener('close', abort)
    controller.abort()
    releaseObservation()
    ctx.deps.channels.unsubscribe(sid, sub)
    sse.end()
  }
}

/** Python `_gateway_sse_probe_payload`: status of the optional gateway stream only, never of `/api/session/stream`. */
export async function gatewayProbePayload(ctx: RequestContext, watcher: GatewayWatcher | null): Promise<[Record<string, unknown>, number]> {
  const enabled = Boolean((await ctx.deps.settings.load()).show_cli_sessions)
  const alive = watcher?.isAlive() ?? false
  const payload: Record<string, unknown> = { enabled, fallback_poll_ms: 30000, ok: enabled && alive, watcher_running: alive, scope: 'gateway_sessions', session_stream_available: true, session_stream_path: '/api/session/stream' }
  if (!enabled) { payload.error = 'agent sessions not enabled'; return [payload, 404] }
  if (!alive) { payload.error = 'watcher not started'; return [payload, 503] }
  return [payload, 200]
}

const truthyQuery = (value: string | null): boolean => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
const MERGED_SIDEBAR_DRAIN_MS = 250

function initialGatewaySessions(ctx: RequestContext): Promise<Record<string, unknown>[]> {
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
    gatewayStatus = (await gatewayProbePayload(ctx, watcher))[0]
  }
  const sub = ctx.deps.events.subscribe()
  const sse = (await claimOrReject(ctx, false))
  if (!sse) { sub.close(); return }
  const abort = new AbortController()
  ctx.res.on('close', () => { abort.abort() })
  const gatewaySub = wantGateway && gatewayStatus?.ok === true && watcher ? watcher.subscribe() : null
  try {
    sse.start()
    sse.event('initial', { stream: 'sessions' })
    if (wantGateway && gatewayStatus) sse.event('gateway_status', gatewayStatus)
    if (gatewaySub) sse.event('sessions_changed', { type: 'sessions_changed', sessions: await initialGatewaySessions(ctx), stream: 'gateway' })
    let lastWrite = Date.now()
    for (;;) {
      if (!(await sse.ready())) return
      // ponytail: 250 ms alternating drain instead of a fan-in; the watcher polls on a multi-second cadence.
      if (gatewaySub) {
        for (;;) {
          const pending = await nextWithin((signal) => gatewaySub.next(signal), 0, abort.signal)
          if (pending === null) {
            // The watcher stopped (a profile switch swapped it) or dropped this slow subscriber: end the response so
            // EventSource reconnects both halves.
            if (gatewaySub.ended || !watcher?.isAlive() || abort.signal.aborted) return
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
      // A global invalidation may span profiles; playback instructions never cross the bound request profile.
      const web_audio = event.web_audio?.filter((completion) => ctx.deps.profilesMatch(completion.profile, ctx.deps.activeProfile()))
      sse.event(event.type, { ...event, web_audio, stream: 'sessions' })
      lastWrite = Date.now()
    }
  } finally {
    sub.close()
    gatewaySub?.close()
    sse.end()
  }
}

/**
 * `/api/sessions/gateway/stream`: the gateway feed alone (`?probe=1` answers its status as JSON). Long-lived, so no
 * `Connection: close`: browsers treat it as the end of the EventSource and reconnect in a tight loop (#3103).
 */
export async function handleGatewayStream(ctx: RequestContext): Promise<void> {
  const watcher = ctx.deps.gatewayWatchers.get(ctx.deps.activeProfile())
  const [probe, status] = (await gatewayProbePayload(ctx, watcher))
  if (truthyQuery(ctx.query.get('probe'))) { (await ctx.json(probe, { status })); return }
  if (status !== 200 || !watcher) { (await ctx.json({ error: probe.error }, { status })); return }
  const sse = (await claimOrReject(ctx, false))
  if (!sse) return
  const sub = watcher.subscribe()
  const abort = new AbortController()
  ctx.res.on('close', () => { abort.abort() })
  try {
    sse.start()
    sse.event('sessions_changed', { sessions: await initialGatewaySessions(ctx) })
    for (;;) {
      if (!(await sse.ready())) return
      const event = await nextWithin((signal) => sub.next(signal), SSE_HEARTBEAT_INTERVAL_MS, abort.signal)
      if (sse.isClosed) return
      if (event) { sse.event(event.type, event); continue }
      // The watcher stopped (a profile switch swapped it) or dropped this slow subscriber: end the response so
      // EventSource reconnects.
      if (sub.ended || !watcher.isAlive()) return
      sse.comment('keepalive')
    }
  } finally {
    sub.close()
    sse.end()
  }
}

/** `/api/sessions/{sid}/events`: per-session journal relay with snapshot fallback. */
export async function handleSessionJournalStream(ctx: RequestContext, sessionId: string): Promise<void> {
  if (!(await ctx.deps.sessions.sessionIdVisible(sessionId))) { (await ctx.json({ error: 'Session not found' }, { status: 404 })); return }
  let session: Session
  try { session = (await ctx.deps.sessionStore.get(sessionId, { metadataOnly: true })) } catch { (await ctx.json({ error: 'Session not found' }, { status: 404 })); return }
  const resumeEventId = (ctx.header('last-event-id') ?? '').trim() || (ctx.query.get('after_event_id') ?? '').trim() || null
  let idleFingerprint = (await ctx.deps.journal.sessionJournalFingerprint(sessionId))
  const sse = (await claimOrReject(ctx, false))
  if (!sse) return
  sse.start()
  const sent = new Set<string>()
  const sentOrder: string[] = []
  const note = (id: string): void => { sent.add(id); sentOrder.push(id); while (sentOrder.length > SESSION_SSE_SENT_EVENT_ID_LIMIT) sent.delete(sentOrder.shift()!) }
  const emitReplay = async (events: Iterable<JournalEvent> | AsyncIterable<JournalEvent>, streamId: string | null, cutoff: number | null, prompts: PromptReplayFilter): Promise<void> => {
    const legacy = new LegacyToolIds(ctx.deps.journal)
    try {
      for await (const entry of events) {
        if (!(await sse.ready())) return
        const seq = streamId ? sameRunSeq(entry.event_id, streamId) : null
        if (cutoff !== null && seq !== null && seq > cutoff) continue
        if (entry.event_id && sent.has(entry.event_id)) continue
        if (!(await prompts.visible(entry))) continue
        sse.event(entry.event || 'message', (await publicJournalPayload(ctx, entry, legacy)), entry.event_id)
        if (entry.event_id) note(entry.event_id)
      }
    } finally {
      await legacy.close()
      await prompts.close()
    }
  }
  const snapshot = async (activeStreamId: string | null): Promise<void> => {
    let fresh = session
    try { fresh = (await ctx.deps.sessionStore.get(sessionId, { metadataOnly: true })) } catch { fresh = session }
    sse.event('session_snapshot', { session: withSessionWireFlags({ activity_phase: await ctx.deps.sessions.activityPhase(fresh), ...fresh.compact({ contextLengthFor: ctx.deps.sessions.deps.contextLengthFor, modelOptionFor: ctx.deps.sessions.deps.modelOptionFor }), run_status: ctx.deps.sessions.currentRunStatus(sessionId, activeStreamId), read_only: (await ctx.deps.sessions.isReadOnly(fresh)) }, new Set(activeStreamId ? [activeStreamId] : [])) })
  }
  const attach = (): { sub: StreamSubscriber | null; streamId: string | null; snapshot: { last_event_id: string | null } } => {
    const streamId = ctx.deps.registry.activeRunStreamForSession(sessionId)
    const channel = streamId ? ctx.deps.registry.peek(streamId) : undefined
    if (!streamId || !channel) return { sub: null, streamId, snapshot: { last_event_id: null } }
    const [sub, snap] = channel.subscribeWithSnapshot()
    return { sub, streamId, snapshot: snap }
  }
  let attached = attach()
  let buffered: ReturnType<typeof bufferedPrompts> | null = null
  try {
    let replay: SessionJournalReplay | null = null
    if (resumeEventId) {
      replay = (await ctx.deps.journal.readSessionRunEvents(sessionId, resumeEventId))
      if (replay.status !== 'ok') (await snapshot(attached.streamId))
    }
    if (!attached.sub) {
      if (replay?.status === 'ok') { const { events } = replay; await emitReplay(events, attached.streamId, null, new PromptReplayFilter((prompt) => runRowsAfter(prompt, events))) }
      for (;;) {
        if (!(await sse.ready())) return
        attached = attach()
        if (attached.sub) break
        const fp = (await ctx.deps.journal.sessionJournalFingerprint(sessionId))
        if (fp !== idleFingerprint) { idleFingerprint = fp; (await snapshot(attached.streamId)) }
        sse.comment('keepalive')
        await new Promise((r) => setTimeout(r, SSE_HEARTBEAT_INTERVAL_MS))
      }
    }
    const sub = attached.sub
    const streamId = attached.streamId!
    let cutoff: number | null = null
    if (replay?.status === 'ok') {
      cutoff = sameRunSeq(attached.snapshot.last_event_id, streamId)
      const tail = await replay.readActiveTail?.(streamId)
      if (tail?.status === 'ok') {
        // Settlement evidence comes from the rows this replay already holds, never another journal read.
        const { events } = replay
        await emitReplay(events, streamId, cutoff, new PromptReplayFilter((prompt) => runRowsAfter(prompt, events, tail.events)))
        await emitReplay(tail.events, streamId, cutoff, new PromptReplayFilter((prompt) => runRowsAfter(prompt, tail.events)))
      }
      else (await snapshot(streamId))
    }
    replay = null
    buffered = bufferedPrompts(ctx, sessionId, streamId, sameRunSeq(attached.snapshot.last_event_id, streamId))
    for (;;) {
      if (!(await sse.ready())) return
      const item = await nextItem(sub, SSE_HEARTBEAT_INTERVAL_MS)
      if (sse.isClosed) return
      if (!item) { sse.comment('keepalive'); continue }
      const [event, data, eventId, redacted] = item
      const seq = sameRunSeq(eventId, streamId)
      if (!(await recoverDropped(ctx, sse, sub, streamId, sessionId, seq, cutoff, async (gap) => { await emitReplay(ctx.deps.journal.iterRunEvents(sessionId, streamId, gap), streamId, null, new PromptReplayFilter((prompt) => ctx.deps.journal.iterRunEvents(sessionId, streamId, { afterSeq: prompt.seq, maxSeq: gap.maxSeq }), streamId)); }))) return
      const terminal = SSE_RELAY_CLOSE_EVENTS.has(event)
      const alreadySent = (cutoff !== null && seq !== null && seq <= cutoff) || (eventId !== null && sent.has(eventId))
      if (alreadySent) { if (terminal) return; continue }
      if (!(await buffered.visible(event, data, seq))) continue
      sse.event(event, publicFramePayload(ctx, event, data, redacted), eventId)
      if (eventId) note(eventId)
      if (terminal) return
    }
  } finally {
    await buffered?.close()
    if (attached.sub && attached.streamId) ctx.deps.registry.peek(attached.streamId)?.unsubscribe(attached.sub)
    sse.end()
  }
}

async function promptStream(ctx: RequestContext, kind: 'approval' | 'clarify'): Promise<void> {
  const sid = ctx.query.get('session_id') ?? ''
  if (!sid) { (await ctx.json({ error: 'session_id is required' }, { status: 400 })); return }
  const [sub, initial] = kind === 'approval' ? ctx.deps.pending.subscribeApprovals(sid) : ctx.deps.pending.subscribeClarifies(sid)
  const release = (): void => { if (kind === 'approval') ctx.deps.pending.unsubscribeApprovals(sid, sub); else ctx.deps.pending.unsubscribeClarifies(sid, sub) }
  const sse = (await claimOrReject(ctx, true))
  if (!sse) { release(); return }
  try {
    sse.start()
    sse.event('initial', initial)
    for (;;) {
      if (!(await sse.ready())) return
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

export const handleApprovalStream = async (ctx: RequestContext): Promise<void> => { await promptStream(ctx, 'approval'); }
export const handleClarifyStream = async (ctx: RequestContext): Promise<void> => { await promptStream(ctx, 'clarify'); }

export function sessionEventsPathSessionId(path: string): string | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'sessions' || parts[3] !== 'events') return null
  const sid = str(parts[2]).trim()
  return sid || null
}
