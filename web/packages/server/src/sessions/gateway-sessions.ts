/** One native-owner seam. Talaria observes its history and never settles it into a local Session. */
import type { StartupTiming } from '../startup-timing.js'
import { createHash, randomUUID } from 'node:crypto'
import { GatewayClarifyBatchSchema, GatewaySessionResultSchema, type ClarifyAnswers, type ClarifyStep, type ExecutionModes, type GatewayClarifyBatch, type GatewayCreateParams, type GatewaySessionParams, type GatewaySessionResult, type GatewaySnapshot, type OwnerAttachment, type ModelChange } from '@maudecode/talaria-web-contracts'
import type { SidecarLike } from '../sidecar/client.js'
import { redactNestedMessageContainers, publicToolFrame } from '../redact.js'
import { str } from '../util.js'
import { PendingPrompts } from './pending.js'
import { clarifyReply } from './pending.js'
import type { SessionService } from './service.js'
import { HttpFailure } from './service.js'
import type { StreamRegistry } from './streams.js'
import type { RunJournal, RunJournalWriter } from './journal.js'
import { SessionEventBus } from './events.js'
import { messageWindowForDisplay, messagesForLimitedPayload } from './window.js'
import { pendingUserRow } from './merge.js'
import { ReasoningTitleTracker, reasoningEventPayload } from './reasoning-titles.js'
import { CANONICAL_READ_ONLY_REASON, WEB_DIAGNOSTIC_REQUEST_PREFIX } from './state-db.js'

type Row = Record<string, unknown>
interface Target { sid: string; profile: string; home: string; key: string }
/** An owner clarify batch and the question ids the owner still waits on, from its last `clarify.lock` reply. */
type Batch = GatewayClarifyBatch & { remaining: string[] }
interface Watch { stream: string; controller: AbortController; snapshot: GatewaySnapshot; batch: Batch | null; restarting: boolean; worker?: Promise<void> }

const ownerStreamPrefix = (home: string): string => `owner-${createHash('sha256').update(home).digest('hex').slice(0, 16)}-`
const ownerStateId = (identity: string): string => `owner-${createHash('sha256').update(identity).digest('hex')}`
/** The scope remains verifiable after a server restart, before a journal lookup or stream subscription. */
export const gatewayStreamVisible = (stream: string, home: string): boolean => !stream.startsWith('owner-') || stream.startsWith(ownerStreamPrefix(home))

type Unavailable = NonNullable<ExecutionModes['modes'][number]['reason']>
/** The server's one classification of why an owner cannot start a diagnostic chat; clients word the code. */
function unavailableReason(result: GatewaySessionResult): Unavailable {
  if (result.state === 'stopped') return 'gateway_stopped'
  if (result.reason === 'served_profile_sessions_unavailable') return 'served_profile'
  if (result.state === 'incompatible') return 'agent_unsupported'
  return 'gateway_unavailable'
}

/** A preview can be absent in a valid native receipt; only original nonblank text can become a retry draft. */
function retryText(admission: GatewaySnapshot['pending'][number]): string | null {
  const text = admission.text
  return typeof text === 'string' && text.trim() ? text : null
}

/** Steering belongs to the current turn; it must never replace that turn's transcript anchor. */
const runningAdmission = (snapshot: GatewaySnapshot) => snapshot.pending.find((p) => p.status === 'started' && !p.steering)

/** Native counters and the owner's compact turn-end usage share one existing Web usage shape. */
function ownerUsage(data: Row): Row {
  const fields: Record<string, string[]> = {
    input_tokens: ['prompt_tokens', 'prompt', 'input_tokens', 'input'], output_tokens: ['completion_tokens', 'completion', 'output_tokens', 'output'],
    cache_read_tokens: ['cache_read_tokens'], cache_write_tokens: ['cache_write_tokens'],
    estimated_cost: ['estimated_cost_usd'], last_prompt_tokens: ['last_prompt_tokens', 'context_used'],
    context_length: ['context_length', 'context_max'], cache_hit_percent: ['cache_hit_pct'], tps: ['tokens_per_s', 'avg_tps'],
  }
  const usage: Row = {}
  for (const [field, keys] of Object.entries(fields)) {
    const value = keys.map((key) => data[key]).find((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    if (value !== undefined) usage[field] = value
  }
  return usage
}

/** Translate only owner-confirmed outcomes; an unknown receipt never means applied. */
function modelChange(receipt: Row, selection: Row = {}): ModelChange {
  const payload = receipt.payload && typeof receipt.payload === 'object' ? receipt.payload as Row : selection
  const model = str(receipt.target_model) || str(payload.model) || str(receipt.model)
  const provider = Object.hasOwn(receipt, 'target_provider') ? receipt.target_provider : payload.provider
  const target = { ...(model ? { model } : {}), ...(provider === null || typeof provider === 'string' ? { provider } : {}) }
  if (receipt.operation !== 'model') return { state: 'refused', message: 'The owner did not confirm the model change' }
  if (receipt.status === 'deferred') return { state: 'deferred', ...target }
  if (receipt.status === 'confirmation_required' && typeof receipt.confirm === 'string' && receipt.confirm && model)
    return { state: 'confirmation_required', message: str(receipt.confirm_message), confirm: receipt.confirm, ...target }
  if (receipt.status === undefined && Number.isInteger(receipt.revision)) return { state: 'applied' }
  return { state: 'refused', message: str(receipt.reason || receipt.message) || 'The owner did not confirm the model change' }
}

export class GatewaySessions {
  private readonly watches = new Map<string, Watch>()
  private readonly modelChanges = new Map<string, { epoch: number; replay: string; change: ModelChange }>()

  private rememberModelChange(target: Target, snapshot: GatewaySnapshot, change: ModelChange): void {
    this.modelChanges.set(target.key, { epoch: snapshot.authority_epoch, replay: snapshot.replay_epoch, change })
  }

  private currentModelChange(target: Target, snapshot: GatewaySnapshot | null): ModelChange | undefined {
    const saved = this.modelChanges.get(target.key)
    if (!saved || !snapshot) return undefined
    if (saved.epoch === snapshot.authority_epoch && saved.replay === snapshot.replay_epoch) return saved.change
    this.modelChanges.delete(target.key)
    return undefined
  }
  constructor(private readonly deps: {
    service: SessionService; sidecar: () => SidecarLike | null; registry: StreamRegistry;
    journal: RunJournal; events: SessionEventBus; profileHome: (profile: string) => string;
    activeProfile: () => string; showReasoning: (home: string) => Promise<boolean>; redactEnabled: () => boolean; now: () => number; log: (line: string) => void;
  }) {}

  private async target(sid: string, profile = this.deps.activeProfile()): Promise<Target | null> {
    if (sid.length === 0 || sid !== sid.trim()) return null
    const owner = (await this.deps.service.stateDbSources([sid], profile))?.get(sid)
    if (typeof owner !== 'object') return null
    if (owner.reason) return null
    const home = this.deps.profileHome(profile)
    return { sid, profile, home, key: JSON.stringify([home, sid]) }
  }

  async isOwned(sid: string): Promise<boolean> { return (await this.target(sid)) !== null }

  private async createCall(params: GatewayCreateParams): Promise<GatewaySessionResult> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { state: 'unavailable', reason: 'sidecar_unavailable', snapshot: null, receipt: null }
    try {
      return await sidecar.call('gateway.create', params, { timeoutMs: 35_000 })
    } catch {
      return { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }
    }
  }

  /** TAL-1040: normal always runs; the bypass modes need an owner that freezes them before any Agent import. */
  async modes(profile: string): Promise<ExecutionModes> {
    const result = await this.createCall({ profile_home: this.deps.profileHome(profile), probe: true })
    const reason = result.state === 'attached' ? null : unavailableReason(result)
    // Owner chats take no file attachments (`submit` refuses them), so a fresh chat in either bypass mode cannot attach.
    return { modes: [{ mode: 'normal', available: true, reason: null, can_attach: true }, ...(['ignore_config', 'safe'] as const).map((mode) => ({ mode, available: reason === null, reason, can_attach: false }))] }
  }

  /**
   * TAL-1040: the owner mints a diagnostic chat, freezes its bypass in the creation receipt and runs each turn in a fresh
   * private worker. Talaria keeps no local Session and never falls back to an ordinary chat; no credential is sent.
   */
  async create(profile: string, creationId: string | null, params: Omit<GatewayCreateParams, 'profile_home' | 'probe' | 'request_id'>): Promise<string> {
    // The client's creation id survives a lost response, so a retry recovers the owner's committed session, never a second one.
    const result = await this.createCall({ ...params, profile_home: this.deps.profileHome(profile), request_id: WEB_DIAGNOSTIC_REQUEST_PREFIX + (creationId ?? randomUUID()) })
    if (result.state !== 'attached' || !result.snapshot) {
      throw new HttpFailure(409, 'The Agent cannot start a chat in this mode', { code: 'execution_mode_unavailable', reason: unavailableReason(result) })
    }
    return result.snapshot.session_id
  }

  private async call(target: Target, params: Omit<GatewaySessionParams, 'session_id' | 'profile_home'>): Promise<GatewaySessionResult> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { state: 'unavailable', reason: 'sidecar_unavailable', snapshot: null, receipt: null }
    const before = this.modelChanges.get(target.key)
    try {
      const result = await sidecar.call('gateway.session', { ...params, profile_home: target.home, session_id: target.sid }, { timeoutMs: params.action === 'mutate' ? 675_000 : 35_000 })
      if (params.action === 'mutate' && params.operation === 'model' && result.snapshot) {
        const change = modelChange(result.receipt ?? {}, params.payload)
        // The stream can resolve a deferred pick before its HTTP ACK returns. Keep the later observation.
        if (change.state !== 'deferred' || this.modelChanges.get(target.key) === before
            || !this.currentModelChange(target, result.snapshot)) this.rememberModelChange(target, result.snapshot, change)
      }
      const change = this.currentModelChange(target, result.snapshot)
      return { ...result, ...(change ? { model_change: change } : {}) }
    } catch {
      return { state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }
    }
  }

  private attachment(result: GatewaySessionResult): OwnerAttachment {
    const snapshot = result.snapshot
    const unknown = snapshot?.pending.some((p) => p.status === 'unknown') ?? false
    const restarting = result.restarting === true
    const value: OwnerAttachment = {
      state: result.state, reason: result.reason, restarting, can_submit: result.state === 'attached' && snapshot !== null && !unknown && !restarting,
      can_interrupt: result.state === 'attached' && snapshot?.running === true, can_attach: false,
      revision: snapshot?.revision ?? null, execution_generation: snapshot?.execution_generation ?? null,
      ...(result.model_change ? { model_change: result.model_change } : {}),
      active_admission: snapshot ? runningAdmission(snapshot) ?? null : null,
      admissions: (snapshot?.pending ?? []).filter((p) => p.status === 'queued' || p.status === 'unknown').map((p) => ({ ...p,
        actions: p.status === 'queued' ? ['cancel', ...(p.controls?.includes('steer') ? ['steer' as const] : []), ...(p.controls?.includes('replace') ? ['edit' as const] : [])]
          : p.execution_generation === null ? []
          : retryText(p) === null ? ['discard'] : ['retry', 'discard'],
      })),
    }
    return redactNestedMessageContainers(value, this.deps.redactEnabled()) as OwnerAttachment
  }

  private async view(base: Row, result: GatewaySessionResult, stream: string | null, target: Target, limit: number | null = 120, before: number | null = null, withMessages = true): Promise<Row> {
    const snapshot = result.snapshot
    const fields: Row = { ...base, owner_attachment: this.attachment({ ...result, model_change: this.currentModelChange(target, snapshot) }), composer_state_key: ownerStateId(target.key), active_stream_id: stream, is_streaming: Boolean(stream) }
    if (snapshot) {
      const nativeRows = [...snapshot.messages]
      const active = stream ? runningAdmission(snapshot) : null
      let start = active ? nativeRows.findIndex((m) => m.role === 'user' && m.message_id === active.admission_id) : -1
      if (active && stream && start < 0) {
        start = nativeRows.length
        nativeRows.push({ ...pendingUserRow(active.text ?? '', [], null, str(snapshot.info.source) || 'gateway', stream), message_id: active.admission_id })
      }
      const messages = start < 0 ? nativeRows : nativeRows.map((row, index) => index >= start ? { ...row, _turn_id: stream } : row)
      const projected = withMessages ? this.deps.service.foreignMessages(messages, base) : []
      const [rows, offset] = messageWindowForDisplay(projected, limit, before)
      const model = str(snapshot.info.model) || str(base.model) || null
      const provider = Object.hasOwn(snapshot.info, 'provider')
        ? str(snapshot.info.provider) || null : str(base.model_provider) || null
      Object.assign(fields, { messages: limit === null ? rows : messagesForLimitedPayload(rows), message_count: Math.max(snapshot.message_count, nativeRows.length), _messages_offset: offset, _messages_truncated: offset > 0,
        title: str(snapshot.info.title) || base.title, model: str(snapshot.info.model) || base.model,
        model_provider: provider, model_option_id: this.deps.service.deps.modelOptionFor?.(model, provider) ?? null,
        workspace: str(snapshot.info.cwd) || base.workspace, active_stream_id: stream, is_streaming: Boolean(stream), agent_running: snapshot.running,
        transcript_seq: stream ? { stream_id: stream, seq: 0 } : null,
      })
      fields.workspace_name = (await this.deps.service.workspaceNames([fields]))(fields)
    }
    return redactNestedMessageContainers(fields, this.deps.redactEnabled()) as Row
  }

  async project(base: Row, limit: number | null = 120, before: number | null = null, withMessages = true): Promise<Row> {
    // The wire's existing owner lock already classified ordinary sessions, including cached pages.
    if (base.read_only_reason !== CANONICAL_READ_ONLY_REASON) return base
    const target = await this.target(str(base.session_id), str(base.profile) || this.deps.activeProfile())
    if (!target) return base
    const result = await this.call(target, { action: 'snapshot' })
    let watch = this.watches.get(target.key)
    if (result.state !== 'attached') { watch?.controller.abort(); watch = undefined }
    if (result.snapshot && (result.snapshot.running || result.snapshot.pending.some((p) => p.status === 'queued' || p.status === 'started')) && !watch) watch = this.watch(target, base, result.snapshot)
    return this.view(base, result, watch?.stream ?? null, target, limit, before, withMessages)
  }

  /** Called before the direct-chat admission path, including for an already materialized foreign session. */
  async submit(sid: string, body: Row, timing?: StartupTiming): Promise<Row | null> {
    const target = await this.target(sid)
    if (!target) return null
    const text = str(body.message).trim()
    if (!text) throw new HttpFailure(400, 'message is required')
    // Native policy is frozen by its owner. Changing model/workspace travels through session.mutate,
    // never through a hidden per-turn override or the local Agent setup path.
    const closeSnapshot = timing?.begin('owner_snapshot')
    const before = await this.call(target, { action: 'snapshot' })
    closeSnapshot?.(before.state === 'unavailable' ? 'unknown' : before.state === 'attached' ? 'ok' : 'refused')
    if (!this.attachment(before).can_submit) throw new HttpFailure(before.state === 'attached' ? 409 : 403, 'The owning Agent is unavailable or needs an explicit recovery decision', { owner_attachment: this.attachment(before) })
    if (typeof body.submission_id !== 'string' || !body.submission_id || body.submission_id.length > 128) throw new HttpFailure(400, 'A stable submission_id is required for an owner chat')
    if (Array.isArray(body.attachments) && body.attachments.length) throw new HttpFailure(400, 'File attachments are unavailable through this owner connection', { code: 'owner_attachments_unavailable' })
    // Resolve display state before admission; a failed post-ACK read must never turn accepted work into a refusal.
    const base = await (timing ? timing.measure('owner_detail', () => this.deps.service.detail(sid, {})) : this.deps.service.detail(sid, {}))
    const closeSubmit = timing?.begin('owner_submit')
    const result = await this.call(target, { action: 'submit', request_id: body.submission_id, text })
    closeSubmit?.(result.receipt ? 'ok' : result.state === 'unavailable' ? 'unknown' : 'refused')
    if (!result.receipt || !('admission_id' in result.receipt)) throw new HttpFailure(409, 'The owner did not confirm this admission. Reconcile it before resending.', { owner_attachment: this.attachment(result), outcome_unknown: result.state === 'unavailable' })
    const snapshot = result.snapshot
    const watch = snapshot && (snapshot.running || snapshot.pending.some((p) => p.status === 'queued' || p.status === 'started')) ? this.watches.get(target.key) ?? this.watch(target, base, snapshot) : null
    this.deps.events.publish('owner_admission', { profile: target.profile, sessionId: sid })
    return { session_id: sid, ...(watch ? { stream_id: watch.stream, turn_id: watch.stream } : {}), owner_attachment: this.attachment(result), admission_id: result.receipt.admission_id, session: await this.view(base, result, watch?.stream ?? null, target) }
  }

  async action(sid: string, params: Omit<GatewaySessionParams, 'session_id' | 'profile_home'>): Promise<GatewaySessionResult> {
    const target = await this.target(sid)
    if (!target) throw new HttpFailure(403, 'This session has no canonical owner')
    if (params.action === 'mutate' && params.operation === 'workspace') {
      try { await this.deps.service.deps.workspaces.resolveTrusted(str(params.payload?.cwd), target.profile) }
      catch { throw new HttpFailure(400, 'The workspace must be trusted before selecting it') }
    }
    const result = await this.call(target, params)
    if (result.state !== 'attached' || !result.snapshot) throw new HttpFailure(409, 'The owning Agent refused the action', { owner_attachment: this.attachment(result) })
    this.deps.events.publish('owner_changed', { profile: target.profile, sessionId: sid })
    return result
  }

  /** The display preview is redacted; an explicit retry returns the original text for review, like direct-chat retry. */
  async retry(sid: string, admissionId: string, generation: number): Promise<string> {
    const target = await this.target(sid)
    if (!target) throw new HttpFailure(403, 'This session has no canonical owner')
    const current = await this.call(target, { action: 'snapshot' })
    const admission = current.snapshot?.pending.find((p) => p.admission_id === admissionId && p.status === 'unknown' && p.execution_generation === generation)
    if (!admission) throw new HttpFailure(409, 'The unknown admission is stale')
    const text = retryText(admission)
    if (text === null) throw new HttpFailure(409, 'The original input text is unavailable; inspect the owner before discarding this work')
    await this.action(sid, { action: 'discard', admission_id: admissionId, execution_generation: generation })
    return text
  }

  private prompts(snapshot: GatewaySnapshot | null, sid: string, batch: Batch | null): PendingPrompts {
    const pending = new PendingPrompts(new SessionEventBus(), this.deps.now)
    for (const prompt of snapshot?.prompts ?? []) {
      const data = { ...prompt, session_id: sid, request_id: prompt.prompt_id, timeout_seconds: 0, allowed_choices: prompt.choices, can_enable_yolo: false }
      if (prompt.kind === 'approval') pending.submitApproval(sid, { ...data, approval_id: prompt.prompt_id })
      else if (prompt.kind === 'clarify') pending.submitClarify(sid, { ...data, clarify_id: prompt.prompt_id })
    }
    // A fully locked batch waits only for the owner's withdrawal; nothing is left to ask.
    if (batch?.remaining.length) {
      const entry = pending.submitClarify(sid, { session_id: sid, clarify_id: batch.request_id, request_id: batch.request_id, timeout_seconds: 0, questions: batch.questions })
      for (const step of entry.steps as ClarifyStep[]) step.answered = !batch.remaining.includes(step.qid)
    }
    return pending
  }

  /** The batch the target's live watch received; the owner asks it once, of the viewers attached when it parks. */
  private batch(target: Target): Batch | null { return this.watches.get(target.key)?.batch ?? null }

  /** Locks each answer; the owner settles the batch on the lock that leaves nothing open. */
  private async lockBatch(target: Target, batch: Batch, answers: ClarifyAnswers): Promise<void> {
    for (const [qid, answer] of Object.entries(answers)) {
      const result = await this.call(target, { action: 'clarify_lock', request_id: batch.request_id, question_id: qid, answer: Array.isArray(answer) ? JSON.stringify(answer) : answer })
      if (result.state === 'attached' && result.lock?.status === 'ok') { batch.remaining = result.lock.remaining ?? []; continue }
      if (result.lock?.status === 'expired') batch.remaining = []
      // An unconfirmed lock keeps the card and its answers for a retry; an ended batch or a refusal is stale.
      throw new HttpFailure(result.state === 'unavailable' ? 503 : 409, 'The owning Agent did not accept this answer', { owner_attachment: this.attachment(result) })
    }
  }

  async pending(sid: string, kind: 'approval' | 'clarify'): Promise<{ pending: Row | null; pending_count: number }> {
    const target = await this.target(sid)
    if (!target) throw new HttpFailure(404, 'Session not found')
    const result = await this.call(target, { action: 'snapshot' })
    const pending = this.prompts(result.snapshot, sid, this.batch(target))
    const envelope = kind === 'approval' ? pending.approvalPending(sid) : pending.clarifyPending(sid)
    return { pending: envelope.pending ? redactNestedMessageContainers(envelope.pending, this.deps.redactEnabled()) as Row : null, pending_count: envelope.pending_count }
  }

  async respond(sid: string, kind: 'approval' | 'clarify', id: string, value: unknown): Promise<boolean> {
    const target = await this.target(sid)
    if (!target) return false
    const current = await this.call(target, { action: 'snapshot' })
    const batch = this.batch(target)
    const pending = this.prompts(current.snapshot, sid, batch)
    if (current.state !== 'attached') throw new HttpFailure(403, 'This canonical session is read-only while its owner is unavailable')
    if (kind === 'clarify' && batch?.remaining.length && batch.request_id === id) {
      const entry = pending.peekClarify(sid, id)
      const reply = entry && value !== null ? clarifyReply(entry, value as never) : null
      if (reply === null) throw new HttpFailure(400, 'Answer every question in the pending clarification')
      await this.lockBatch(target, batch, (JSON.parse(reply) as { answers: ClarifyAnswers }).answers)
      return true
    }
    const prompt = current.snapshot?.prompts.find((p) => p.kind === kind && p.prompt_id === id)
    if (!prompt) throw new HttpFailure(409, 'The owner prompt is stale')
    let text = ''
    if (kind === 'clarify') {
      const entry = pending.peekClarify(sid, id)
      const answer = entry && value !== null ? clarifyReply(entry, value as never) : null
      if (answer === null) throw new HttpFailure(400, 'Answer every question in the pending clarification')
      text = answer
    }
    await this.action(sid, { action: kind, prompt_id: id, execution_generation: Number(prompt.execution_generation), ...(kind === 'approval' ? { choice: str(value) as 'once' | 'session' | 'always' | 'deny' } : { text }) })
    if (kind === 'approval') pending.resolveApproval(sid, id)
    else pending.resolveClarify(sid, id)
    return true
  }

  async cancel(stream: string): Promise<boolean | null> {
    const found = [...this.watches.entries()].find(([, w]) => w.stream === stream)
    if (!found) return null
    const [key, watch] = found
    const [home, sid] = JSON.parse(key) as [string, string]
    // A request bound to another profile must never control this watch.
    if (this.deps.profileHome(this.deps.activeProfile()) !== home) throw new HttpFailure(404, 'Session not found')
    if (!watch.snapshot.running) return false
    await this.action(sid, { action: 'interrupt', execution_generation: watch.snapshot.execution_generation })
    return true
  }

  private watch(target: Target, base: Row, snapshot: GatewaySnapshot): Watch {
    const watch: Watch = { stream: `${ownerStreamPrefix(target.home)}${randomUUID()}`, controller: new AbortController(), snapshot, batch: null, restarting: false }
    this.watches.set(target.key, watch)
    const registry = this.deps.registry
    const channel = registry.create(watch.stream, target.sid)
    registry.registerActiveRun({ stream_id: watch.stream, session_id: target.sid, phase: 'running', started_at: this.deps.now(), workspace: str(base.workspace), model: str(base.model) || null, provider: null, ephemeral: false, origin: 'user' })
    let chain = Promise.resolve()
    let terminal = false
    let streamError: unknown = null
    let closeWriter: RunJournalWriter | null = null
    let activeAdmission = runningAdmission(snapshot)?.admission_id ?? snapshot.pending.find((p) => !p.steering)?.admission_id
    const worker = async () => {
      // Same persisted IDs can exist in separate homes. Native observation journals must not
      // join the sid-only direct-chat journal; the owner retains the canonical transcript.
      const journalSession = ownerStateId(target.key)
      const writer = await this.deps.journal.writer(journalSession, watch.stream)
      closeWriter = writer
      const showReasoning = await this.deps.showReasoning(target.home).catch(() => false)
      let usage: Row = {}
      let reasoning = ''
      let titles = new ReasoningTitleTracker()
      const resetProjection = () => { reasoning = ''; usage = {}; titles = new ReasoningTitleTracker() }
      const put = async (event: string, data: Row) => {
        const safe = event === 'tool' || event === 'tool_complete' ? publicToolFrame(data, this.deps.redactEnabled()) : redactNestedMessageContainers(data, this.deps.redactEnabled()) as Row
        const record = await writer.appendSseEvent(event, safe)
        channel.put([event, safe, record.event_id])
      }
      const meter = async (data: Row) => {
        usage = { ...usage, ...ownerUsage(data) }
        if (['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].every((key) => typeof usage[key] === 'number')) await put('metering', { session_id: target.sid, usage: { ...usage, estimated_cost: usage.estimated_cost ?? null }, tps: usage.tps ?? null, tps_available: usage.tps !== undefined, estimated: false })
      }
      const finish = async () => {
        // A model pick resolves at the owner's next claim boundary, after the turn becomes idle.
        if (terminal || this.currentModelChange(target, watch.snapshot)?.state === 'deferred') return
        terminal = true
        const current = await this.call(target, { action: 'snapshot' })
        const rawReceipt = activeAdmission ? (await this.call(target, { action: 'receipt', admission_id: activeAdmission })).receipt : null
        const receipt = rawReceipt && 'admission_id' in rawReceipt ? rawReceipt : null
        const cancelled = receipt?.outcome === 'interrupted' || receipt?.outcome === 'cancelled'
        const failed = current.state !== 'attached' || receipt?.status !== 'terminal' || receipt.outcome !== 'completed' && !cancelled
        await put(cancelled ? 'cancel' : failed ? 'apperror' : 'done', { session_id: target.sid,
          terminal_state: cancelled ? 'cancelled' : failed ? 'error' : 'completed',
          ...(failed ? { message: 'The owning Agent could not complete this turn', type: current.reason ?? 'owner_turn_failed' } : {}),
          ...(Object.keys(usage).length ? { usage } : {}),
          session: { ...await this.view(base, current, null, target), ...usage } })
        await put('stream_end', { session_id: target.sid })
        watch.controller.abort()
      }
      let pending = this.prompts(snapshot, target.sid, watch.batch)
      let ran = snapshot.running
      const prompts = async (snap: GatewaySnapshot) => {
        watch.snapshot = snap
        pending = this.prompts(snap, target.sid, watch.batch)
        const approval = pending.approvalPending(target.sid)
        if (approval.pending) await put('approval', { ...approval.pending, pending_count: approval.pending_count })
        const clarify = pending.clarifyHeadFrame(target.sid)
        if (clarify) await put('clarify', clarify)
      }
      await prompts(snapshot)
      const sidecar = this.deps.sidecar()
      if (!sidecar) throw new Error('sidecar_unavailable')
      if (watch.controller.signal.aborted) return
      const result = await sidecar.call('gateway.session', { profile_home: target.home, session_id: target.sid, action: 'watch', show_reasoning: showReasoning }, {
        signal: watch.controller.signal, timeoutMs: 0,
        onStream: (frame) => {
          chain = chain.then(async () => {
            if (terminal || streamError) return
            if (frame.event === 'restarting') {
              // The owner entered a restart's after-turn wait after this watch attached: clients stop sending.
              watch.restarting = true
              await put('session_snapshot', { session: await this.view(base, { state: 'attached', reason: null, snapshot: watch.snapshot, receipt: null, restarting: true }, watch.stream, target) })
              return
            }
            if (frame.event === 'clarify_batch') {
              const batch = GatewayClarifyBatchSchema.parse(frame.data)
              watch.batch = { ...batch, remaining: batch.questions.map((q) => q.qid) }
              await prompts(watch.snapshot)
              return
            }
            if (frame.event === 'snapshot') {
              const result = GatewaySessionResultSchema.parse(frame.data)
              if (!result.snapshot) return
              if (result.replay_gap || result.snapshot.execution_generation > watch.snapshot.execution_generation) resetProjection()
              await put('session_snapshot', { session: await this.view(base, result, watch.stream, target), replay_gap: result.replay_gap === true })
              await prompts(result.snapshot)
              if (!result.snapshot.running && !result.snapshot.pending.some((p) => p.status === 'queued' || p.status === 'started')) await finish()
              return
            }
            const event = frame.data as Row
            const data = (event.payload ?? {}) as Row
            const kind = str(event.type)
            if (kind === 'request.cancel') {
              // The owner withdraws a settled, timed-out or interrupted batch from every viewer.
              if (!watch.batch || watch.batch.request_id !== data.id) return
              watch.batch = null
              await prompts(watch.snapshot)
              if (!pending.clarifyHeadFrame(target.sid)) await put('clarify', { status: 'resolved', clarify_id: data.id })
              return
            }
            if (kind === 'session.updated') {
              // Idle owner mutations carry no execution stamp. The sidecar scopes their subscription and replay.
              if (event.session_id !== target.sid
                  || event.authority_epoch !== undefined && event.authority_epoch !== watch.snapshot.authority_epoch
                  || event.execution_generation !== undefined && event.execution_generation !== watch.snapshot.execution_generation) return
              if (data.operation !== 'model') return
              this.rememberModelChange(target, watch.snapshot, modelChange(data))
              const current = await this.call(target, { action: 'snapshot' })
              if (current.snapshot) watch.snapshot = current.snapshot
              await put('session_snapshot', { session: await this.view(base, current, watch.stream, target) })
              if (!watch.snapshot.running && !watch.snapshot.pending.some((p) => p.status === 'queued' || p.status === 'started')) await finish()
              return
            }
            if (kind === 'session.info') {
              if (data.authority_epoch !== watch.snapshot.authority_epoch) return
              if (Number(data.execution_generation) < watch.snapshot.execution_generation) return
              const firstClaim = !ran && data.running === true
              if (Number(data.execution_generation) > watch.snapshot.execution_generation) resetProjection()
              watch.snapshot = { ...watch.snapshot, ...data }
              const claimed = runningAdmission(watch.snapshot)
              if (firstClaim && claimed) activeAdmission = claimed.admission_id
              ran ||= data.running === true
              if (firstClaim) await put('session_snapshot', { session: await this.view(base, { state: 'attached', reason: null, snapshot: watch.snapshot, receipt: null, restarting: watch.restarting }, watch.stream, target) })
              if (data.running === false && (ran || !watch.snapshot.pending.some((p) => p.status === 'queued' || p.status === 'started'))) await finish()
              return
            }
            if (event.authority_epoch !== watch.snapshot.authority_epoch || event.execution_generation !== watch.snapshot.execution_generation) return
            if (kind === 'message.delta') {
              const stable = titles.stableSnapshot(reasoning)
              if (stable !== null) await put('reasoning', { text: '', titles: stable })
              await put('token', { text: str(data.text || data.delta || data.content) })
            }
            else if (kind === 'reasoning.delta' && showReasoning) {
              reasoning += str(data.text)
              await put('reasoning', titles.prepare(reasoningEventPayload(data.text, reasoning)))
            }
            else if (kind.startsWith('subagent.') && str(data.subagent_id)) {
              // Reuse the delegate activity row; each child keeps one identity through progress and completion.
              const complete = kind === 'subagent.complete'
              const preview = kind === 'subagent.thinking' && !showReasoning ? '' : str(data.summary || data.tool_preview || data.text)
              await put(complete ? 'tool_complete' : 'tool', { id: `owner-subagent-${str(data.subagent_id)}`, name: 'subagent_progress',
                args: { task: str(data.goal) }, preview: preview || null,
                ...(complete ? { is_error: data.status !== 'completed', duration: data.duration_seconds } : {}) })
            }
            else if (kind === 'session.usage') await meter(data)
            else if (kind === 'message.complete' && data.usage && typeof data.usage === 'object') await meter(data.usage as Row)
            else if (kind === 'tool.start') await put('tool', { ...data, id: data.tool_id || data.tool_call_id, name: data.name || data.tool_name })
            else if (kind === 'tool.complete') await put('tool_complete', { ...data, id: data.tool_id || data.tool_call_id, name: data.name || data.tool_name })
            else if (kind === 'approval.request' || kind === 'clarify.request') await prompts({ ...watch.snapshot, prompts: [...watch.snapshot.prompts.filter((p) => p.prompt_id !== data.prompt_id), { ...data, kind: kind.split('.')[0] }] })
            else if (kind === 'approval.settled' || kind === 'clarify.settled') {
              await prompts({ ...watch.snapshot, prompts: watch.snapshot.prompts.filter((p) => p.prompt_id !== data.prompt_id) })
              if (kind === 'approval.settled' && !pending.approvalPending(target.sid).pending) await put('approval_cleared', { pending_count: 0 })
              if (kind === 'clarify.settled' && !pending.clarifyHeadFrame(target.sid)) await put('clarify', { status: 'resolved', clarify_id: data.prompt_id })
            }

          }).catch((error: unknown) => { streamError = error; watch.controller.abort() })
        },
      })
      await chain
      if (streamError) throw streamError instanceof Error ? streamError : new Error('Owner stream projection failed')
      if (!terminal) {
        await put('apperror', { message: 'The owning Agent disconnected. Reopen the session before resending work.', type: result.reason ?? 'owner_unavailable', terminal_state: 'error' })
        await put('stream_end', { session_id: target.sid })
        watch.controller.abort()
      }
    }
    watch.worker = worker().catch((error: unknown) => {
      // Closing the sidecar after a terminal snapshot is expected; every other exit is observable.
      if (!terminal) channel.put(['apperror', { message: 'The owning Agent connection ended', type: 'owner_unavailable', terminal_state: 'error' }, null])
      this.deps.log(`[webui] owner observation ended: ${error instanceof Error ? error.name : 'error'}`)
    }).finally(async () => {
      watch.controller.abort()
      try { await closeWriter?.close() } catch { this.deps.log('[webui] owner observation journal could not close') }
      if (this.watches.get(target.key) === watch) this.watches.delete(target.key)
      registry.retire(watch.stream)
      this.deps.events.publish('owner_changed', { profile: target.profile, sessionId: target.sid })
    })
    return watch
  }

  async close(): Promise<void> {
    const watches = [...this.watches.values()]
    for (const watch of watches) watch.controller.abort()
    await Promise.allSettled(watches.flatMap((watch) => watch.worker ? [watch.worker] : []))
    this.modelChanges.clear()
  }
}
