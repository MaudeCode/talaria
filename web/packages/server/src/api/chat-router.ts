/** Chat turn admission, control, approvals, clarify, goals, background tasks, and side questions. */
import { GATEWAY_APPROVAL_RELAY_UNAVAILABLE, isGenericContinuationIntent } from '../sessions/turn.js'
import { SidecarError } from '../sidecar/client.js'
import { implement } from '@orpc/server'
import { chatContract } from '@maudecode/talaria-web-contracts'
import { randomUUID } from 'node:crypto'
import { HttpError, type ApiContext } from './router.js'
import { requestSessionIdGuard, streamVisibleToRequest } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import type { Session } from '../sessions/session.js'
import { isSafeSessionId } from '../sessions/session.js'
import { str } from '../util.js'
import type { TurnRunner } from '../sessions/turn.js'

const os = implement(chatContract).$context<ApiContext>().use(requestSessionIdGuard)
const STEER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Handler boundary: contract outputs are pinned loose objects (index signatures), so the concrete return type is erased here like the `as never` casts elsewhere. */
async function run<T>(fn: () => Promise<T> | T): Promise<never> {
  try {
    return (await fn()) as never
  } catch (error) {
    if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
    if (error instanceof SessionNotFound) throw new HttpError(404, 'Session not found')
    throw error
  }
}

function getSession(ctx: RequestContext, sid: string, metadataOnly = false): Session {
  try {
    return ctx.deps.sessionStore.get(sid, { metadataOnly })
  } catch {
    throw new HttpError(404, 'Session not found')
  }
}

/** Python `_normalize_chat_attachments`. */
export function normalizeChatAttachments(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return []
  const out: Record<string, unknown>[] = []
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const row = item as Record<string, unknown>
      const name = str(row.name || row.filename).trim()
      const path = str(row.path).trim()
      const att: Record<string, unknown> = { name: name || path, path, mime: str(row.mime).trim() }
      if (typeof row.size === 'number' && Number.isInteger(row.size)) att.size = row.size
      if (typeof row.is_image === 'boolean') att.is_image = row.is_image
      out.push(att)
    } else {
      const value = str(item).trim()
      if (value) out.push({ name: value, path: '', mime: '' })
    }
  }
  return out
}

function startPayload(response: ReturnType<TurnRunner['start']>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...response }
  Reflect.deleteProperty(payload, '_status')
  Reflect.deleteProperty(payload, 'error')
  Reflect.deleteProperty(payload, 'active_stream_id')
  return payload
}

function requireField(body: Record<string, unknown>, ...fields: string[]): void {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '')
  if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`)
}

function visibleOrRetag(ctx: RequestContext, s: Session, requestedProfile: string): void {
  const active = ctx.deps.activeProfile()
  if (ctx.deps.profilesMatch(s.profile, active)) return
  const hasTurns = s.messages.length > 0 || s.context_messages.length > 0 || s.hasPendingPrompt
  if (requestedProfile && ctx.deps.profilesMatch(requestedProfile, active) && !hasTurns) {
    s.profile = requestedProfile
    return
  }
  throw new HttpError(404, 'Session not found')
}

function resolveWorkspace(ctx: RequestContext, s: Session, requested: unknown): string {
  const ws = ctx.deps.workspaces
  if (requested !== undefined && requested !== null && requested !== '') {
    try { return ws.resolveTrusted(str(requested), s.profile) } catch (error) { throw new HttpError(400, (error as Error).message) }
  }
  try {
    const [workspace, recovered] = ws.resolveImplicitWithRecovery(s.workspace, (p) => ws.lastWorkspace(p), s.profile)
    if (recovered) s.workspace = workspace
    return workspace
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
}

function modelState(ctx: RequestContext, s: Session, body: Record<string, unknown>): [string | null, string | null, boolean] {
  const requestedModel = str(body.model) || s.model
  const requestedProvider = 'model_provider' in body ? (body.model_provider as string | null) : s.model_provider
  const [model, provider] = ctx.deps.sessions.deps.modelStateFromRequest(requestedModel, requestedProvider, s.model_provider)
  return [model, provider, model !== requestedModel]
}

/** `chat.start`; a `chat.steer` sent while a background turn runs starts the user's turn through it too (TAL-460). */
async function startChat(ctx: RequestContext, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  requireField(body, 'session_id')
  if (str(body.message).trim() === '[SILENT]') return { status: 'suppressed', reason: 'silent_control_message' }
  if (body.regenerate === true) throw new HttpError(409, 'Regeneration is not supported by this backend.', { code: 'unsupported_regeneration_backend' })
  const sid = str(body.session_id)
  // Python `_agent_runtime_barrier_response`: a stale local Agent checkout is refused with a typed 409 before any
  // session state is materialised, claimed, or mutated.
  const sidecarNow = ctx.deps.sidecar()
  if (sidecarNow) {
    try {
      await sidecarNow.call('runtime.ensure_current', {})
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'agent_runtime_stale') {
        throw new HttpError(409, error.message, { type: 'agent_runtime_stale', retryable: true, restart_scheduled: false, ...(error.data.agent_update_state !== undefined ? { agent_update_state: error.data.agent_update_state } : {}) })
      }
    }
  }
  let s: Session
  try {
    s = ctx.deps.sessionStore.get(sid)
  } catch {
    // Python `_claim_or_synthesize_cli_session` on the POST path: a claimable foreign (CLI/TUI/Desktop) session is
    // materialised as a WebUI sidecar before its first turn; an owned foreign store answers 403, nothing → 404.
    const synth = ctx.deps.sessions.claimOrSynthesizeCliSession(sid)
    if (!synth.session) throw new HttpError(404, 'Session not found')
    if (synth.reason === 'not_claimable') throw new HttpError(403, 'session is read-only in its foreign store; cannot be claimed writeable in WebUI')
    ctx.deps.sessionStore.save(synth.session)
    s = ctx.deps.sessionStore.get(sid)
  }
  // Python `_get_or_materialize_session` raised PermissionError for both: a read-only import and a delegated
  // subagent child (by sidecar tag or state.db row), which chat start answered with the same 403.
  if (ctx.deps.sessions.isReadOnly(s) || s.branchSourceReadonly || ctx.deps.sessions.isSubagentViewOnly(sid)) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
  const requestedProfile = str(body.profile).trim()
  if (requestedProfile && requestedProfile !== 'default' && !PROFILE_ID_RE.test(requestedProfile)) throw new HttpError(400, 'invalid profile')
  visibleOrRetag(ctx, s, requestedProfile)
  const msg = str(body.message).trim()
  const attachments = normalizeChatAttachments(body.attachments).slice(0, 20)
  // TAL-276: an attached file alone makes a turn; one with neither text nor a file path is refused.
  if (!msg && !attachments.some((att) => str(att.path))) throw new HttpError(400, 'message is required')
  // TAL-460: the user's message never joins a background turn; that turn stops quietly and this one takes its place.
  if (await ctx.deps.turns.yieldBackgroundTurn(sid)) s = ctx.deps.sessionStore.get(sid)
  // Python `compression_recovery_payload_for_session` + `is_generic_continuation_intent`.
  const recovery = s.compression_recovery
  const recoveryLive = recovery.terminal_state === 'compression_exhausted' && str(recovery.recommended_action || s.recommended_recovery_action) === 'start_focused_continuation'
  if (recoveryLive && !attachments.length && isGenericContinuationIntent(msg)) {
    throw new HttpError(409, 'This session exhausted context compression. Start a focused continuation, then describe the next narrow task.', { type: 'compression_recovery_required', compression_recovery: s.compression_recovery, session_id: s.session_id })
  }
  const workspace = resolveWorkspace(ctx, s, body.workspace)
  const [model, provider, normalized] = modelState(ctx, s, body)
  if (body.moa_config) throw new HttpError(503, 'MoA overrides need the Agent command registry (checkpoint 7).')
  const response = ctx.deps.turns.start(s, { msg, attachments, workspace, model, modelProvider: provider, normalizedModel: normalized, source: 'webui' })
  if (response._status !== undefined && response._status >= 400) throw new HttpError(response._status, response.error ?? 'chat start failed', response.active_stream_id ? { active_stream_id: response.active_stream_id } : {})
  return startPayload(response)
}

export const chatRouter = os.router({
  chat: {
    start: os.chat.start.handler(({ input, context: { ctx } }) => run(() => startChat(ctx, input as Record<string, unknown>))),
    steer: os.chat.steer.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = str(input.session_id).trim()
      const text = str(input.text).trim()
      const display = str(input.display_text).trim()
      let steerId = str(input.steer_id).trim()
      if (!sid) throw new HttpError(400, 'session_id required')
      if (!text) throw new HttpError(400, 'text required')
      if (steerId && !STEER_ID_RE.test(steerId)) throw new HttpError(400, 'steer_id must be 1-128 URL-safe characters')
      if (!steerId) steerId = `steer-${randomUUID()}`
      if (!ctx.deps.sessions.sessionIdVisible(sid)) throw new HttpError(404, 'Session not found')
      const active = ctx.deps.registry.activeRunStreamForSession(sid)
      if (active && ctx.deps.registry.activeRuns.get(active)?.origin === 'background') {
        const started = await startChat(ctx, { session_id: sid, message: text })
        return { accepted: true, fallback: null, stream_id: started.stream_id ? str(started.stream_id) : null, steer_id: steerId, started_turn: started }
      }
      return ctx.deps.turns.steer(sid, text, display, steerId) as Promise<{ accepted: boolean; fallback: string | null; stream_id: string | null; steer_id?: string }>
    })),
    // TAL-424: Edit, Cancel and Send now on a pending steer; unknown or already-taken steers answer false.
    steerWithdraw: os.chat.steerWithdraw.handler(({ input, context: { ctx } }) => run(async () => {
      if (!ctx.deps.sessions.sessionIdVisible(input.session_id)) throw new HttpError(404, 'Session not found')
      return ctx.deps.turns.withdrawSteer(input.session_id, input.steer_id, input.reason)
    })),
    steerSendNow: os.chat.steerSendNow.handler(({ input, context: { ctx } }) => run(async () => {
      if (!ctx.deps.sessions.sessionIdVisible(input.session_id)) throw new HttpError(404, 'Session not found')
      return ctx.deps.turns.sendSteerNow(input.session_id, input.steer_id)
    })),
    cancel: os.chat.cancel.handler(({ input, context: { ctx } }) => run(async () => {
      const streamId = str(input.stream_id)
      if (!streamId) throw new HttpError(400, 'stream_id required')
      if (!streamVisibleToRequest(ctx, streamId)) throw new HttpError(404, 'Session not found')
      const { cancelled, withdrawn } = await ctx.deps.turns.cancel(streamId)
      return { ok: true, cancelled, stream_id: streamId, withdrawn_steers: withdrawn }
    })),
    streamStatus: os.chat.streamStatus.handler(({ input, context: { ctx } }) => run(() => {
      const streamId = str(input.stream_id)
      if (!streamVisibleToRequest(ctx, streamId)) throw new HttpError(404, 'Session not found')
      const active = ctx.deps.registry.liveIds.has(streamId)
      const payload: { active: boolean; stream_id: string; replay_available: boolean; journal?: Record<string, unknown> } = { active, stream_id: streamId, replay_available: false }
      const summary = streamId ? ctx.deps.journal.findRunSummary(streamId) : null
      if (summary) {
        payload.replay_available = true
        const terminal = summary.terminal
        payload.journal = { session_id: summary.session_id, run_id: summary.run_id, last_seq: summary.last_seq, last_event_id: summary.last_event_id, last_event: summary.last_event, terminal, terminal_state: !active && !terminal ? 'lost-worker-bookkeeping' : summary.terminal_state }
      }
      return payload
    })),
  },
  approval: {
    pending: os.approval.pending.handler(({ input, context: { ctx } }) => run(() => ctx.deps.pending.approvalPending(str(input.session_id)))),
    respond: os.approval.respond.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = str(input.session_id)
      if (!sid) throw new HttpError(400, 'session_id is required')
      const choice = str(input.choice) || 'deny'
      if (!['once', 'session', 'always', 'deny'].includes(choice)) throw new HttpError(400, `Invalid choice: ${choice}`)
      const enableYolo = input.yolo === true
      // Python `_gateway_approval_failure` envelope; the TS backend has no run mirrors, so any exact-owner relay is unavailable.
      if (str(input.run_id).trim() || str(input.mirror_token).trim()) throw new HttpError(409, GATEWAY_APPROVAL_RELAY_UNAVAILABLE, { ok: false, choice, relayed: false, code: 'gateway_run_unavailable', ...(enableYolo ? { yolo_enabled: ctx.deps.sessions.yolo(sid).yolo_enabled === true } : {}) })
      const result = await ctx.deps.turns.respondApproval(sid, choice, str(input.approval_id), enableYolo)
      if (typeof result._status === 'number' && result._status >= 400) { const { _status, error, ...rest } = result; throw new HttpError(_status, str(error), rest) }
      return result as { ok: boolean; choice?: string; yolo_enabled?: boolean; stale_cleared?: boolean }
    })),
  },
  clarify: {
    pending: os.clarify.pending.handler(({ input, context: { ctx } }) => run(() => ctx.deps.pending.clarifyPending(str(input.session_id)))),
    respond: os.clarify.respond.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = str(input.session_id)
      if (!sid) throw new HttpError(400, 'session_id is required')
      // Keyed step answers are shaped by the server; a raw `response` is relayed as-is for older clients.
      const reply = input.answers ?? str(input.response ?? input.answer ?? input.choice).trim()
      if (!reply) throw new HttpError(400, 'response is required')
      const result = await ctx.deps.turns.respondClarify(sid, str(input.clarify_id), reply)
      if (result.stale) throw new HttpError(409, 'Clarification prompt expired or not found. The agent may have already proceeded.', { ok: false, stale: true })
      if (result.invalid) throw new HttpError(400, 'answers must answer every question of the pending clarification', { ok: false })
      if (!result.ok) throw new HttpError(503, result.error ?? 'clarify relay failed', { ok: false })
      return { ok: true, response: str(result.response) }
    })),
  },
  goal: os.goal.handler(({ input, context: { ctx } }) => run(async () => {
    const body = input as Record<string, unknown>
    requireField(body, 'session_id')
    const args = str(body.args || body.text)
    if (args.trim() === '[SILENT]') return { status: 'suppressed', reason: 'silent_control_message' }
    const sid = str(body.session_id)
    // Python: a delegated subagent child is view-only; its goal state is never mutated and no turn starts on it.
    if (ctx.deps.sessions.isSubagentViewOnly(sid)) throw new HttpError(400, 'Subagent sessions are view-only and cannot run /goal from WebUI')
    const s = getSession(ctx, sid)
    if (ctx.deps.sessions.isReadOnly(s) || s.branchSourceReadonly) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
    const requestedProfile = str(body.profile).trim()
    if (requestedProfile && requestedProfile !== 'default' && !PROFILE_ID_RE.test(requestedProfile)) throw new HttpError(400, 'invalid profile')
    if (requestedProfile && !ctx.deps.profilesMatch(s.profile, requestedProfile) && !s.messages.length && !s.context_messages.length && !s.hasPendingPrompt) s.profile = requestedProfile
    let streamRunning = false
    if (s.active_stream_id) {
      streamRunning = ctx.deps.registry.liveIds.has(s.active_stream_id)
      if (!streamRunning) ctx.deps.sessions.clearStaleStreamState(s)
    }
    const sidecar = ctx.deps.sidecar()
    if (!sidecar) throw new HttpError(503, 'Goal controls need the Agent sidecar, which is not running.', { condition: 'sidecar_unavailable' })
    const profileHome = ctx.deps.sessions.deps.workspaces.deps.profileHome(s.profile ?? ctx.deps.activeProfile())
    // Python `_default_max_turns`: the profile's `goals.max_turns` (default 20) is the /goal turn budget.
    let defaultMaxTurns = 20
    try { const cfg = await ctx.deps.agentConfig.read(profileHome); const goals = cfg.goals; const raw = goals && typeof goals === 'object' && !Array.isArray(goals) ? (goals as Record<string, unknown>).max_turns : undefined; const n = Number.parseInt(str(raw ?? 20), 10); if (Number.isFinite(n)) defaultMaxTurns = Math.max(1, n || 20) } catch { defaultMaxTurns = 20 }
    const snapshot = await sidecar.call('goals.snapshot', { session_id: sid, profile_home: profileHome, default_max_turns: defaultMaxTurns })
    const payload = await sidecar.call('goals.command', { session_id: sid, profile_home: profileHome, args, stream_running: streamRunning, default_max_turns: defaultMaxTurns }) as Record<string, unknown>
    if (payload.ok === false) throw new HttpError(payload.error === 'agent_running' ? 409 : 400, str(payload.message || payload.error || 'goal command failed'), payload)
    const kickoff = str(payload.kickoff_prompt).trim()
    if (kickoff) {
      const workspace = resolveWorkspace(ctx, s, body.workspace)
      const [model, provider, normalized] = modelState(ctx, s, body)
      const started = ctx.deps.turns.start(s, { msg: kickoff, attachments: [], workspace, model, modelProvider: provider, normalizedModel: normalized, source: 'webui', goalRelated: true })
      if (started._status !== undefined && started._status >= 400) {
        try { await sidecar.call('goals.restore', { session_id: sid, profile_home: profileHome, snapshot: snapshot.snapshot }) } catch { /* best effort */ }
        throw new HttpError(started._status, started.error ?? 'goal kickoff failed', { ...payload, ok: false })
      }
      Object.assign(payload, startPayload(started))
    }
    return payload
  })),
  background: {
    start: os.background.start.handler(({ input, context: { ctx } }) => run(() => {
      const body = input as Record<string, unknown>
      requireField(body, 'session_id', 'prompt')
      // A subagent child's profile/workspace/context must never seed a runnable background session.
      if (ctx.deps.sessions.isSubagentViewOnly(str(body.session_id))) throw new HttpError(400, 'Subagent sessions are view-only and cannot run background tasks from WebUI')
      const parent = getSession(ctx, str(body.session_id))
      if (ctx.deps.sessions.isReadOnly(parent) || parent.branchSourceReadonly) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
      const prompt = str(body.prompt).trim()
      if (!prompt) throw new HttpError(400, 'prompt is required')
      const bg = ctx.deps.sessionStore.newSession({ workspace: parent.workspace, model: parent.model, modelProvider: parent.model_provider, profile: parent.profile })
      bg.title = `bg: ${prompt.slice(0, 60)}`
      ctx.deps.sessionStore.save(bg)
      // Python: `uuid.uuid4().hex[:8]`; a failed run still completes the task so `/api/background/status` can report it,
      // and the hidden bg session file is removed afterwards.
      const taskId = randomUUID().replace(/-/g, '').slice(0, 8)
      ctx.deps.background.track(parent.session_id, { task_id: taskId, bg_session_id: bg.session_id, prompt })
      const cleanup = (): void => { try { ctx.deps.sessionStore.deleteFiles(bg.session_id, { tombstone: false }) } catch { /* best effort */ } }
      const started = ctx.deps.turns.start(bg, {
        msg: prompt, attachments: [], workspace: parent.workspace, model: parent.model, modelProvider: parent.model_provider, source: 'webui',
        onDone: (answer) => { ctx.deps.background.complete(parent.session_id, taskId, answer); cleanup() },
        onFailed: () => { ctx.deps.background.complete(parent.session_id, taskId, '(background task failed)'); cleanup() },
      })
      if (started._status !== undefined && started._status >= 400) {
        // Admission refused (profile deleting, session busy…): nothing runs, so the tracked task and hidden
        // session must not linger as "running".
        ctx.deps.background.forget(parent.session_id, taskId)
        cleanup()
        throw new HttpError(started._status, started.error ?? 'background start failed')
      }
      ctx.deps.background.setStream(parent.session_id, taskId, str(started.stream_id))
      return { ok: true as const, task_id: taskId, stream_id: str(started.stream_id), session_id: bg.session_id }
    })),
    status: os.background.status.handler(({ input, context: { ctx } }) => run(() => {
      const sid = str(input.session_id)
      if (!sid) throw new HttpError(400, 'Missing session_id')
      return { results: ctx.deps.background.results(sid) }
    })),
    ack: os.background.ack.handler(({ input, context: { ctx } }) => run(() => {
      const body = input as Record<string, unknown>
      requireField(body, 'session_id')
      const sid = str(body.session_id).trim()
      const s = getSession(ctx, sid, true)
      const pid = str(body.task_id || body.process_id).trim()
      if (str(body.process_id).trim()) ctx.extraResponseHeaders = { deprecation: 'true' }
      return { ok: true as const, session_id: s.session_id, task_id: pid, noop: true as const }
    })),
  },
  btw: os.btw.handler(({ input, context: { ctx } }) => run(() => {
    const body = input as Record<string, unknown>
    requireField(body, 'session_id', 'question')
    const sid = str(body.session_id)
    if (!isSafeSessionId(sid)) throw new HttpError(404, 'Session not found')
    // Python: a subagent child's context must not be cloned into a runnable ephemeral session.
    if (ctx.deps.sessions.isSubagentViewOnly(sid)) throw new HttpError(400, 'Subagent sessions are view-only and cannot be used for /btw from WebUI')
    const s = getSession(ctx, sid)
    if (ctx.deps.sessions.isReadOnly(s) || s.branchSourceReadonly) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
    const question = str(body.question).trim()
    if (!question) throw new HttpError(400, 'question is required')
    if (s.active_stream_id && ctx.deps.registry.liveIds.has(s.active_stream_id)) throw new HttpError(409, 'session already has an active stream')
    const ephemeral = ctx.deps.sessionStore.newSession({ workspace: s.workspace, model: s.model, modelProvider: s.model_provider, profile: s.profile })
    ephemeral.messages = structuredClone(s.messages)
    ephemeral.context_messages = structuredClone(s.context_messages)
    ephemeral.title = `btw: ${question.slice(0, 60)}`
    ctx.deps.sessionStore.save(ephemeral)
    const started = ctx.deps.turns.start(ephemeral, { msg: question, attachments: [], workspace: s.workspace, model: s.model, modelProvider: s.model_provider, source: 'webui', ephemeral: true })
    if (started._status !== undefined && started._status >= 400) throw new HttpError(started._status, started.error ?? 'btw start failed')
    return { stream_id: str(started.stream_id), session_id: ephemeral.session_id, parent_session_id: sid }
  })),
})

/** Python `api/background.py`: parent-scoped background task tracking. */
export class BackgroundTasks {
  private readonly tasks = new Map<string, Record<string, unknown>[]>()

  constructor(private readonly now: () => number = () => Date.now() / 1000) {}

  track(parent: string, task: { task_id: string; bg_session_id: string; prompt: string }): void {
    const list = this.tasks.get(parent) ?? []
    list.push({ ...task, stream_id: null, status: 'running', started_at: this.now(), answer: null, completed_at: null })
    this.tasks.set(parent, list)
  }

  /** Drop a task that never started (admission refused) so status never reports it. */
  forget(parent: string, taskId: string): void {
    const rest = (this.tasks.get(parent) ?? []).filter((t) => t.task_id !== taskId)
    if (rest.length) this.tasks.set(parent, rest)
    else this.tasks.delete(parent)
  }

  setStream(parent: string, taskId: string, streamId: string): void {
    for (const t of this.tasks.get(parent) ?? []) if (t.task_id === taskId) t.stream_id = streamId
  }

  complete(parent: string, taskId: string, answer: string): void {
    for (const t of this.tasks.get(parent) ?? []) {
      if (t.task_id === taskId && t.status === 'running') {
        t.status = 'done'
        t.answer = answer
        t.completed_at = this.now()
        break
      }
    }
  }

  results(parent: string): Record<string, unknown>[] {
    const list = this.tasks.get(parent) ?? []
    const done = list.filter((t) => t.status === 'done')
    const running = list.filter((t) => t.status !== 'done')
    if (running.length) this.tasks.set(parent, running)
    else this.tasks.delete(parent)
    return done.map((t) => ({ task_id: t.task_id, prompt: t.prompt, answer: t.answer, completed_at: t.completed_at }))
  }
}
