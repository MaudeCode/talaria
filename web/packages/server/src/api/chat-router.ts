/** Chat turn admission, control, approvals, clarify, goals, background tasks, and side questions. */
import { timingOutcome } from '../startup-timing.js'
import { GATEWAY_APPROVAL_RELAY_UNAVAILABLE } from '../sessions/turn.js'
import { implement } from '@orpc/server'
import { chatContract, type OwnerAttachment } from '@maudecode/talaria-web-contracts'
import { randomUUID } from 'node:crypto'
import { HttpError, type ApiContext } from './router.js'
import { requestSessionIdGuard, resolveStreamOwner, streamRunSummary, streamVisibleToRequest } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import type { Session } from '../sessions/session.js'
import { isSafeSessionId } from '../sessions/session.js'
import { messageText } from '../sessions/merge.js'
import { str } from '../util.js'
import { SidecarError } from '../sidecar/client.js'
import type { StartTurnOptions, TurnFailure } from '../sessions/turn.js'

import { startSessionChat, requireField, startPayload, expandPromptBuiltin } from '../sessions/admission.js'
export { normalizeChatAttachments } from '../sessions/admission.js'

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

/** A session this request's profile may see (TAL-372 background work never crosses owners). */
async function visibleSession(ctx: RequestContext, sid: string): Promise<Session> {
  if (!(await ctx.deps.sessions.sessionIdVisible(sid))) throw new HttpError(404, 'Session not found')
  return (await getSession(ctx, sid, true))
}

async function getSession(ctx: RequestContext, sid: string, metadataOnly = false): Promise<Session> {
  try {
    return (await ctx.deps.sessionStore.get(sid, { metadataOnly }))
  } catch {
    throw new HttpError(404, 'Session not found')
  }
}

/** `chat.start`; a `chat.steer` sent while a background turn runs starts the user's turn through it too (TAL-460). */
async function startChat(ctx: RequestContext, body: Record<string, unknown>, settle: Pick<StartTurnOptions, 'onDone' | 'onFailed'> = {}): Promise<Record<string, unknown>> {
  ctx.enterChatStart()
  const timing = ctx.startupTiming
  try {
    const response = await startSessionChat(ctx.deps, body, settle, timing ?? undefined)
    if (!response.stream_id) timing?.finish('noop')
    return response
  } catch (error) { timing?.finish(timingOutcome(error)); throw error }
}

/**
 * Legacy `POST /api/chat`: the `chat.start` admission, then the turn awaited to its end. A turn that was cancelled, or
 * failed after streaming text, answers `partial` with that text; any other failure answers with its error frame.
 */
async function syncChat(ctx: RequestContext, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (await ctx.deps.sessions.owner?.isOwned(str(body.session_id))) throw new HttpError(409, 'This owner requires the asynchronous chat stream', { code: 'owner_requires_streaming' })
  if ((await ctx.deps.sessions.isSubagentViewOnly(str(body.session_id)))) throw new HttpError(400, 'Subagent sessions are view-only and cannot be written from WebUI')
  if (!str(body.message).trim()) throw new HttpError(400, 'empty message')
  let outcome: { answer: string } | TurnFailure | null = null
  const started = await startChat(ctx, { session_id: body.session_id, message: body.message, workspace: body.workspace, model: body.model, ...('model_provider' in body ? { model_provider: body.model_provider } : {}) }, {
    onDone: (answer) => { outcome = { answer } },
    onFailed: (failure) => { outcome = failure },
  })
  const streamId = str(started.stream_id)
  if (streamId) await ctx.deps.turns.finished(streamId)
  const s = (await getSession(ctx, str(body.session_id)))
  const session = (await ctx.deps.turns.publicTerminalSession(s, streamId)) as never
  const ended = outcome as { answer: string } | TurnFailure | null
  // A `[SILENT]` control message starts no turn.
  if (!streamId || (ended && 'answer' in ended)) {
    const answer = ended && 'answer' in ended ? ended.answer : ''
    return { answer, status: 'done', session, result: { final_response: answer, completed: true, interrupted: false } }
  }
  const partial = s.messages.filter((m) => m._turn_id === streamId && m._partial).map((m) => messageText(m.content)).join('').trim()
  const cancelled = ended?.cancelled ?? false
  if (cancelled || (ended?.apperror && partial)) return { answer: partial, status: 'partial', session, result: { final_response: partial, completed: false, interrupted: cancelled } }
  if (ended?.apperror) {
    const { message, ...rest } = ended.apperror
    const type = str(rest.type)
    throw new HttpError(type === 'agent_runtime_stale' ? 409 : type === 'sidecar_unavailable' ? 503 : 500, str(message) || 'chat failed', rest)
  }
  // Python `_chat_writeback_timeout_response`: the turn ended but another stream owned the session at writeback.
  throw new HttpError(503, 'response persistence is uncertain', { code: 'chat_writeback_timeout', message: 'The response finished but could not be persisted because this session remained busy. Do not retry automatically; refresh the session first.', retryable: false, outcome_unknown: true })
}

export const chatRouter = os.router({
  chat: {
    ownerAction: os.chat.ownerAction.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await ctx.deps.sessions.sessionIdVisible(input.session_id))) throw new HttpError(404, 'Session not found')
      const owner = ctx.deps.sessions.owner
      if (!owner) throw new HttpError(503, 'Native session controls are unavailable')
      let draft: string | undefined
      if (input.action === 'retry') {
        draft = await owner.retry(input.session_id, input.admission_id, input.execution_generation)
      } else await owner.action(input.session_id, input)
      const session = await ctx.deps.sessions.detail(input.session_id, {})
      const model_change = (session.owner_attachment as OwnerAttachment | undefined)?.model_change
      return { ok: true as const, session: session as never, ...(draft === undefined ? {} : { draft }), ...(model_change ? { model_change } : {}) }
    })),
    sync: os.chat.sync.handler(({ input, context: { ctx } }) => run(async () => (await syncChat(ctx, input as Record<string, unknown>)))),
    start: os.chat.start.handler(({ input, context: { ctx } }) => run(async () => (await startChat(ctx, input as Record<string, unknown>)))),
    steer: os.chat.steer.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = str(input.session_id).trim()
      const text = str(input.text).trim()
      const display = str(input.display_text).trim()
      let steerId = str(input.steer_id).trim()
      if (!sid) throw new HttpError(400, 'session_id required')
      if (!text) throw new HttpError(400, 'text required')
      if (steerId && !STEER_ID_RE.test(steerId)) throw new HttpError(400, 'steer_id must be 1-128 URL-safe characters')
      if (!steerId) steerId = `steer-${randomUUID()}`
      if (!(await ctx.deps.sessions.sessionIdVisible(sid))) throw new HttpError(404, 'Session not found')
      const active = ctx.deps.registry.activeRunStreamForSession(sid)
      if (active && ctx.deps.registry.activeRuns.get(active)?.origin === 'background') {
        const started = await startChat(ctx, { session_id: sid, message: text })
        return { accepted: true, fallback: null, stream_id: started.stream_id ? str(started.stream_id) : null, steer_id: steerId, started_turn: started }
      }
      // TAL-817: a prompt built-in steers with its expansion; the steer still shows as typed. A missing session is the steer's to report.
      let target: Session | null = null
      try { target = (await ctx.deps.sessionStore.get(sid, { metadataOnly: true })) } catch { target = null }
      const prompt = target ? await expandPromptBuiltin(ctx.deps, target, text, undefined) : null
      return (await ctx.deps.turns.steer(sid, prompt ?? text, display || (prompt === null ? '' : text), steerId)) as { accepted: boolean; fallback: string | null; stream_id: string | null; steer_id?: string }
    })),
    // TAL-424: Edit, Cancel and Send now on a pending steer; unknown or already-taken steers answer false.
    steerWithdraw: os.chat.steerWithdraw.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await ctx.deps.sessions.sessionIdVisible(input.session_id))) throw new HttpError(404, 'Session not found')
      return (await ctx.deps.turns.withdrawSteer(input.session_id, input.steer_id, input.reason))
    })),
    steerSendNow: os.chat.steerSendNow.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await ctx.deps.sessions.sessionIdVisible(input.session_id))) throw new HttpError(404, 'Session not found')
      return (await ctx.deps.turns.sendSteerNow(input.session_id, input.steer_id))
    })),
    cancel: os.chat.cancel.handler(({ input, context: { ctx } }) => run(async () => {
      const streamId = str(input.stream_id)
      if (!streamId) throw new HttpError(400, 'stream_id required')
      const resolved = await resolveStreamOwner(ctx, streamId)
      if (!(await streamVisibleToRequest(ctx, streamId, resolved))) throw new HttpError(404, 'Session not found')
      const sid = resolved.owner
      const { cancelled, withdrawn } = await ctx.deps.turns.cancel(streamId)
      const activity_phase = sid ? await ctx.deps.background.activityPhase(sid, ctx.deps.activeProfile(), cancelled ? { excludeStreamId: streamId, terminalPhase: 'cancelled' } : {}) : undefined
      return { ok: true, cancelled, stream_id: streamId, withdrawn_steers: withdrawn, ...(activity_phase ? { activity_phase } : {}) }
    })),
    streamStatus: os.chat.streamStatus.handler(({ input, context: { ctx } }) => run(async () => {
      const streamId = str(input.stream_id)
      const resolved = await resolveStreamOwner(ctx, streamId)
      if (!(await streamVisibleToRequest(ctx, streamId, resolved))) throw new HttpError(404, 'Session not found')
      const active = ctx.deps.registry.liveIds.has(streamId)
      const { owner } = resolved
      const payload: { active: boolean; stream_id: string; replay_available: boolean; journal?: Record<string, unknown>; activity_phase?: string | undefined; blocking_stream_id: string | null } = { active, stream_id: streamId, replay_available: false, blocking_stream_id: owner ? (await ctx.deps.sessions.activeRunBlocking(owner)) : null }
      const summary = await streamRunSummary(ctx, streamId, resolved)
      if (summary) {
        payload.replay_available = true
        const terminal = summary.terminal
        payload.journal = { session_id: summary.session_id, run_id: summary.run_id, last_seq: summary.last_seq, last_event_id: summary.last_event_id, last_event: summary.last_event, terminal, terminal_state: !active && !terminal ? 'lost-worker-bookkeeping' : summary.terminal_state }
      }
      const sid = owner ?? summary?.session_id
      if (sid) {
        try { payload.activity_phase = await ctx.deps.sessions.activityPhase(await ctx.deps.sessionStore.get(sid), active ? undefined : { excludeStreamId: streamId }) } catch { payload.activity_phase = 'stale' }
      }
      return payload
    })),
  },
  approval: {
    pending: os.approval.pending.handler(({ input, context: { ctx } }) => run(async () => (await ctx.deps.sessions.owner?.isOwned(str(input.session_id))) ? ctx.deps.sessions.owner!.pending(str(input.session_id), 'approval') : ctx.deps.pending.approvalPending(str(input.session_id)))),
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
    pending: os.clarify.pending.handler(({ input, context: { ctx } }) => run(async () => (await ctx.deps.sessions.owner?.isOwned(str(input.session_id))) ? ctx.deps.sessions.owner!.pending(str(input.session_id), 'clarify') : ctx.deps.pending.clarifyPending(str(input.session_id)))),
    respond: os.clarify.respond.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = str(input.session_id)
      if (!sid) throw new HttpError(400, 'session_id is required')
      // Both keyed answers and older clients' raw replies are shaped against the pending prompt; only a vault prompt
      // takes a decline (TAL-887).
      const reply = input.decline === true ? null : input.answers ?? str(input.response ?? input.answer ?? input.choice).trim()
      if (reply === '') throw new HttpError(400, 'response is required')
      const result = await ctx.deps.turns.respondClarify(sid, str(input.clarify_id), reply)
      if (result.stale) throw new HttpError(409, 'Clarification prompt expired or not found. The agent may have already proceeded.', { ok: false, stale: true })
      if (result.invalid) throw new HttpError(400, 'answers must answer every question of the pending clarification', { ok: false })
      if (!result.ok) throw new HttpError(503, result.error ?? 'clarify relay failed', { ok: false })
      // A vault answer is never echoed back.
      return result.response === undefined ? { ok: true } : { ok: true, response: result.response }
    })),
  },
  goal: os.goal.handler(({ input, context: { ctx } }) => run(async () => {
    const body = input as Record<string, unknown>
    requireField(body, 'session_id')
    const args = str(body.args || body.text)
    if (args.trim() === '[SILENT]') return { status: 'suppressed', reason: 'silent_control_message' }
    const sid = str(body.session_id)
    // Python: a delegated subagent child is view-only; its goal state is never mutated and no turn starts on it.
    if ((await ctx.deps.sessions.isSubagentViewOnly(sid))) throw new HttpError(400, 'Subagent sessions are view-only and cannot run /goal from WebUI')
    const s = (await getSession(ctx, sid))
    if ((await ctx.deps.sessions.isReadOnly(s)) || s.branchSourceReadonly) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
    const requestedProfile = str(body.profile).trim()
    if (requestedProfile && requestedProfile !== 'default' && !PROFILE_ID_RE.test(requestedProfile)) throw new HttpError(400, 'invalid profile')
    if (requestedProfile && !ctx.deps.profilesMatch(s.profile, requestedProfile) && !s.messages.length && !s.context_messages.length && !s.hasPendingPrompt) s.profile = requestedProfile
    let streamRunning = false
    if (s.active_stream_id) {
      streamRunning = ctx.deps.registry.liveIds.has(s.active_stream_id)
      if (!streamRunning) (await ctx.deps.sessions.clearStaleStreamState(s))
    }
    const sidecar = ctx.deps.sidecar()
    if (!sidecar) throw new HttpError(503, 'Goal controls need the Agent sidecar, which is not running.', { condition: 'sidecar_unavailable' })
    const profileHome = ctx.deps.sessions.deps.workspaces.deps.profileHome(s.profile ?? ctx.deps.activeProfile())
    // Python `_default_max_turns`: the profile's `goals.max_turns` (default 20) is the /goal turn budget.
    let defaultMaxTurns = 20
    try { const cfg = await ctx.deps.agentConfig.read(profileHome); const goals = cfg.goals; const raw = goals && typeof goals === 'object' && !Array.isArray(goals) ? (goals as Record<string, unknown>).max_turns : undefined; const n = Number.parseInt(str(raw ?? 20), 10); if (Number.isFinite(n)) defaultMaxTurns = Math.max(1, n || 20) } catch { defaultMaxTurns = 20 }
    const snapshot = await sidecar.call('goals.snapshot', { session_id: sid, profile_home: profileHome, default_max_turns: defaultMaxTurns })
    await ctx.deps.sessions.assertWritable(s)
    const payload = await sidecar.call('goals.command', { session_id: sid, profile_home: profileHome, args, stream_running: streamRunning, default_max_turns: defaultMaxTurns, workspace: str(s.workspace) || undefined }) as Record<string, unknown>
    // TAL-808: the session `goal` follows the command before the client reloads the session.
    await ctx.deps.turns.refreshGoal(s)
    if (payload.ok === false) {
      // Clients show the body's `error`, so the Agent's reason replaces the sidecar's code there.
      const reason = str(payload.message || payload.error || 'goal command failed')
      throw new HttpError(payload.error === 'agent_running' ? 409 : 400, reason, { ...payload, error: reason })
    }
    const kickoff = str(payload.kickoff_prompt).trim()
    if (kickoff) {
      const workspace = (await ctx.deps.sessions.turnWorkspace(s, body.workspace))
      const [model, provider, normalized] = ctx.deps.sessions.turnModel(s, body)
      const started = (await ctx.deps.turns.start(s, { msg: kickoff, attachments: [], workspace, model, modelProvider: provider, normalizedModel: normalized, source: 'webui', goalRelated: true }))
      if (started._status !== undefined && started._status >= 400) {
        try { await ctx.deps.sessions.assertWritable(s); await sidecar.call('goals.restore', { session_id: sid, profile_home: profileHome, snapshot: snapshot.snapshot }) } catch { /* best effort */ }
        await ctx.deps.turns.refreshGoal(s)
        throw new HttpError(started._status, started.error ?? 'goal kickoff failed', { ...payload, ok: false })
      }
      Object.assign(payload, startPayload(started))
    }
    return payload
  })),
  background: {
    start: os.background.start.handler(({ input, context: { ctx } }) => run(async () => {
      const body = input as Record<string, unknown>
      requireField(body, 'session_id', 'prompt')
      // A subagent child's profile/workspace/context must never seed a runnable background session.
      if ((await ctx.deps.sessions.isSubagentViewOnly(str(body.session_id)))) throw new HttpError(400, 'Subagent sessions are view-only and cannot run background tasks from WebUI')
      const parent = (await getSession(ctx, str(body.session_id)))
      if ((await ctx.deps.sessions.isReadOnly(parent)) || parent.branchSourceReadonly) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
      const prompt = str(body.prompt).trim()
      if (!prompt) throw new HttpError(400, 'prompt is required')
      const [model, modelProvider] = ctx.deps.sessions.turnModel(parent, {})
      const bg = (await ctx.deps.sessionStore.newSession({ workspace: parent.workspace, model, modelProvider, profile: parent.profile }))
      bg.title = `bg: ${prompt.slice(0, 60)}`
      await ctx.deps.sessionStore.save(bg)
      // Python: `uuid.uuid4().hex[:8]`; a failed run still completes the task so `/api/background/tasks` reports it,
      // and the hidden bg session file is removed afterwards.
      const taskId = randomUUID().replace(/-/g, '').slice(0, 8)
      // TAL-372: the parent session keeps the task's record and result, so every client and a restart see it.
      await ctx.deps.background.trackCommand(parent.session_id, taskId, prompt)
      const cleanup = async (): Promise<void> => { try { (await ctx.deps.sessionStore.delete(bg.session_id, { tombstone: false })) } catch { /* best effort */ } }
      const started = (await ctx.deps.turns.start(bg, {
        msg: prompt, attachments: [], workspace: parent.workspace, model, modelProvider, activityParentSessionId: parent.session_id, source: 'webui',
        // Python: the last non-error assistant reply with content, else "(no answer produced)".
        onDone: async (answer) => { (await ctx.deps.background.settleCommand(parent.session_id, taskId, 'completed', answer || '(no answer produced)')); (await cleanup()) },
        onFailed: async () => { (await ctx.deps.background.settleCommand(parent.session_id, taskId, 'failed', '(background task failed)')); (await cleanup()) },
      }))
      if (started._status !== undefined && started._status >= 400) {
        // Admission refused (profile deleting, session busy…): nothing runs, so the tracked task and hidden
        // session must not linger as "running".
        await ctx.deps.background.forgetCommand(parent.session_id, taskId)
        await cleanup()
        throw new HttpError(started._status, started.error ?? 'background start failed')
      }
      await ctx.deps.background.setCommandStream(parent.session_id, taskId, str(started.stream_id))
      return { ok: true as const, task_id: taskId, stream_id: str(started.stream_id), session_id: bg.session_id }
    })),
    tasks: os.background.tasks.handler(({ input, context: { ctx } }) => run(async () => {
      const s = (await visibleSession(ctx, input.session_id))
      const snapshot = await ctx.deps.background.snapshot(s.session_id, s.profile, { canStop: !(await ctx.deps.sessions.isReadOnly(s)) })
      return { session_id: s.session_id, ...snapshot, tasks: input.kind ? snapshot.tasks.filter((t) => t.kind === input.kind) : snapshot.tasks }
    })),
    result: os.background.result.handler(({ input, context: { ctx } }) => run(async () => {
      const s = (await visibleSession(ctx, input.session_id))
      const text = await ctx.deps.background.result(s.session_id, s.profile, input.task_id)
      if (text === null) throw new HttpError(404, 'No result for this background task')
      return { task_id: input.task_id, text }
    })),
    stop: os.background.stop.handler(({ input, context: { ctx } }) => run(async () => {
      const s = await visibleSession(ctx, input.session_id)
      await ctx.deps.sessions.assertWritable(s)
      try { return await ctx.deps.background.stop(s.session_id, s.profile, input.task_id) } catch (error) {
        if (!(error instanceof SidecarError)) throw error
        throw new HttpError(error.condition === 'sidecar_unavailable' ? 503 : 502, error.message)
      }
    })),
    dismiss: os.background.dismiss.handler(({ input, context: { ctx } }) => run(async () => {
      const s = (await visibleSession(ctx, input.session_id))
      const task = (await ctx.deps.background.dismiss(s.session_id, input.task_id))
      if (!task) throw new HttpError(404, 'Background task not found')
      return { ok: true as const, task }
    })),
    ack: os.background.ack.handler(({ input, context: { ctx } }) => run(async () => {
      const body = input as Record<string, unknown>
      requireField(body, 'session_id')
      const sid = str(body.session_id).trim()
      const s = (await getSession(ctx, sid, true))
      const pid = str(body.task_id || body.process_id).trim()
      if (str(body.process_id).trim()) ctx.extraResponseHeaders = { deprecation: 'true' }
      return { ok: true as const, session_id: s.session_id, task_id: pid, noop: true as const }
    })),
  },
  btw: os.btw.handler(({ input, context: { ctx } }) => run(async () => {
    const body = input as Record<string, unknown>
    requireField(body, 'session_id', 'question')
    const sid = str(body.session_id)
    if (!isSafeSessionId(sid)) throw new HttpError(404, 'Session not found')
    // Python: a subagent child's context must not be cloned into a runnable ephemeral session.
    if ((await ctx.deps.sessions.isSubagentViewOnly(sid))) throw new HttpError(400, 'Subagent sessions are view-only and cannot be used for /btw from WebUI')
    const s = (await getSession(ctx, sid))
    if ((await ctx.deps.sessions.isReadOnly(s)) || s.branchSourceReadonly) throw new HttpError(403, 'Read-only imported sessions cannot be continued from WebUI')
    const question = str(body.question).trim()
    if (!question) throw new HttpError(400, 'question is required')
    // TAL-518: a side question runs in its own hidden session, so the chat's running turn does not block it.
    const [model, modelProvider] = ctx.deps.sessions.turnModel(s, {})
    const ephemeral = (await ctx.deps.sessionStore.newSession({ workspace: s.workspace, model, modelProvider, profile: s.profile }))
    const context = await ctx.deps.sessions.sideQuestionContext(s)
    ephemeral.messages = structuredClone(s.messages)
    ephemeral.context_messages = context
    ephemeral.title = `btw: ${question.slice(0, 60)}`
    await ctx.deps.sessionStore.save(ephemeral)
    // TAL-512: a failed or refused btw turn must not leave its copy of the parent conversation behind.
    const cleanup = async (): Promise<void> => { try { (await ctx.deps.sessionStore.delete(ephemeral.session_id, { tombstone: false })) } catch { /* best effort */ } }
    const started = (await ctx.deps.turns.start(ephemeral, { msg: question, attachments: [], workspace: s.workspace, model, modelProvider, source: 'webui', ephemeral: true, onFailed: cleanup }))
    if (started._status !== undefined && started._status >= 400) {
      await cleanup()
      throw new HttpError(started._status, started.error ?? 'btw start failed')
    }
    return { stream_id: str(started.stream_id), session_id: ephemeral.session_id, parent_session_id: sid }
  })),
})
