/** Shared admission for interactive sends and explicitly started serial queues. */
import { MAX_CHAT_ATTACHMENTS, RPC_ERROR_CODES, type SidecarResult, type PromptQueueCard } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import type { StartupTiming } from '../startup-timing.js'
import { ensureAgentRuntimeCurrent, HttpFailure } from './service.js'
import type { Session } from './session.js'
import { compressionRecoveryPayload } from './session.js'
import { isGenericContinuationIntent, type StartTurnOptions, type TurnRunner } from './turn.js'
import { str } from '../util.js'
import { SidecarError } from '../sidecar/client.js'
import { unsupportedPromptMessage } from '../tools/commands.js'
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type QueueAdmissionFence = Pick<PromptQueueCard, 'project_id' | 'backend' | 'authority_epoch'> & { profile: string }

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

export function startPayload(response: Awaited<ReturnType<TurnRunner['start']>>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...response }
  Reflect.deleteProperty(payload, '_status')
  Reflect.deleteProperty(payload, 'error')
  Reflect.deleteProperty(payload, 'active_stream_id')
  return payload
}

export function requireField(body: Record<string, unknown>, ...fields: string[]): void {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '')
  if (missing.length) throw new HttpFailure(400, `Missing required field(s): ${missing.join(', ')}`)
}

function visibleOrRetag(deps: AppDeps, s: Session, requestedProfile: string): void {
  const active = deps.activeProfile()
  if (deps.profilesMatch(s.profile, active)) return
  const hasTurns = s.messages.length > 0 || s.context_messages.length > 0 || s.hasPendingPrompt
  if (requestedProfile && deps.profilesMatch(requestedProfile, active) && !hasTurns) {
    s.profile = requestedProfile
    return
  }
  throw new HttpFailure(404, 'Session not found')
}

/**
 * TAL-817: what the model gets for a typed Agent prompt built-in (`/plan`, `/initiate-setup`, …): the Agent's own expansion
 * of it for this session's profile, workspace and toolsets, while the transcript keeps the typed text; null when `msg` is
 * not one. One the Agent cannot expand is
 * refused with the catalog's message instead of reaching the model raw. Without a sidecar the turn reports that itself.
 */
export async function expandPromptBuiltin(deps: AppDeps, s: Session, msg: string, workspace: unknown): Promise<string | null> {
  const sidecar = deps.sidecar()
  if (!msg.startsWith('/') || !sidecar) return null
  // Only `/init` reads the workspace, and the sidecar refuses it without one; the turn reports a bad workspace itself.
  let cwd = ''
  try { cwd = (await deps.sessions.turnWorkspace(s, workspace)) } catch { cwd = '' }
  let expanded: SidecarResult<'commands.expand_prompt'>
  try {
    expanded = await sidecar.call('commands.expand_prompt', {
      profile_home: deps.profileHome(s.profile ?? deps.activeProfile()), command: msg, session_id: s.session_id, workspace: cwd,
      enabled_toolsets: s.enabled_toolsets,
    }, { timeoutMs: 120_000 })
  } catch (error) {
    if (!(error instanceof SidecarError)) throw error
    const invalid = error.condition === 'invalid_params' || error.code === RPC_ERROR_CODES.invalidParams
    throw new HttpFailure(invalid ? 400 : error.condition === 'sidecar_unavailable' ? 503 : 502, error.message)
  }
  if (expanded.name !== null && expanded.message === null) throw new HttpFailure(400, unsupportedPromptMessage(expanded.name))
  return expanded.message
}

export async function startSessionChat(deps: AppDeps, body: Record<string, unknown>, settle: Pick<StartTurnOptions, 'onDone' | 'onFailed'> = {}, timing?: StartupTiming, fence?: QueueAdmissionFence): Promise<Record<string, unknown>> {
  const measure = <T>(name: Parameters<NonNullable<typeof timing>['measure']>[0], fn: () => Promise<T> | T): Promise<T> => timing ? timing.measure(name, fn) : Promise.resolve(fn())
  requireField(body, 'session_id')
  timing?.identify(str(body.session_id))
  if (str(body.message).trim() === '[SILENT]') return { status: 'suppressed', reason: 'silent_control_message' }
  if (body.regenerate === true) throw new HttpFailure(409, 'Regeneration is not supported by this backend.', { code: 'unsupported_regeneration_backend' })
  const sid = str(body.session_id)
  // Python `_agent_runtime_barrier_response`: a stale local Agent checkout is refused with a typed 409 before any
  // session state is materialised, claimed, or mutated.
  await measure('runtime_barrier', () => ensureAgentRuntimeCurrent(deps.sidecar()))
  const owner = deps.sessions.owner
  if (owner && (await measure('owner_routing', () => owner.isOwned(sid)))) {
    if (!(await deps.sessions.sessionIdVisible(sid))) throw new HttpFailure(404, 'Session not found')
    if (fence?.backend === 'direct') throw new HttpFailure(409, 'Queue target authority changed')
    const response = (await owner.submit(sid, body, timing, fence))!
    timing?.finish('ok')
    return response
  }
  if (fence?.backend === 'owner') throw new HttpFailure(409, 'Queue target authority changed')
  // Admission reads the cached catalog snapshot; it never waits for a refresh.
  timing?.begin('catalog_wait')
  timing?.end('catalog_wait', 'noop')
  const closeLoad = timing?.begin('session_load')
  let s: Session
  try {
    s = (await deps.sessionStore.get(sid))
  } catch {
    // Python `_claim_or_synthesize_cli_session` on the POST path: a claimable foreign (CLI/TUI/Desktop) session is
    // materialised as a WebUI sidecar before its first turn; an owned foreign store answers 403, nothing → 404.
    const synth = (await deps.sessions.claimOrSynthesizeCliSession(sid))
    if (!synth.session) throw new HttpFailure(404, 'Session not found')
    if (synth.reason === 'not_claimable') throw new HttpFailure(403, 'session is read-only in its foreign store; cannot be claimed writeable in WebUI')
    await deps.sessionStore.save(synth.session)
    s = (await deps.sessionStore.get(sid))
  }
  closeLoad?.()
  const closeOwnership = timing?.begin('ownership_checks')
  // Python `_get_or_materialize_session` raised PermissionError for both: a read-only import and a delegated
  // subagent child (by sidecar tag or state.db row), which chat start answered with the same 403.
  if ((await deps.sessions.isReadOnly(s)) || s.branchSourceReadonly || (await deps.sessions.isSubagentViewOnly(sid))) throw new HttpFailure(403, 'Read-only imported sessions cannot be continued from WebUI')
  const requestedProfile = str(body.profile).trim()
  if (requestedProfile && requestedProfile !== 'default' && !PROFILE_ID_RE.test(requestedProfile)) throw new HttpFailure(400, 'invalid profile')
  visibleOrRetag(deps, s, requestedProfile)
  closeOwnership?.()
  const msg = str(body.message).trim()
  const attachments = normalizeChatAttachments(body.attachments).slice(0, MAX_CHAT_ATTACHMENTS)
  // TAL-276: an attached file alone makes a turn; one with neither text nor a file path is refused.
  if (!msg && !attachments.some((att) => str(att.path))) throw new HttpFailure(400, 'message is required')
  const prompt = await measure('prompt_preparation', () => expandPromptBuiltin(deps, s, msg, body.workspace))
  // TAL-460: the user's message never joins a background turn; that turn stops quietly and this one takes its place.
  const yielded = fence ? false : await measure('background_yield', () => deps.turns.yieldBackgroundTurn(sid))
  if (prompt !== null || yielded) {
    s = (await deps.sessionStore.get(sid))
    visibleOrRetag(deps, s, requestedProfile)
  }
  // Python `compression_recovery_payload_for_session` + `is_generic_continuation_intent`.
  if (compressionRecoveryPayload(s) && !attachments.length && isGenericContinuationIntent(msg)) {
    throw new HttpFailure(409, 'This session exhausted context compression. Start a focused continuation, then describe the next narrow task.', { type: 'compression_recovery_required', compression_recovery: s.compression_recovery, session_id: s.session_id })
  }
  const workspace = await measure('workspace_preparation', () => deps.sessions.turnWorkspace(s, body.workspace))
  const [model, provider, normalized] = deps.sessions.turnModel(s, body)
  if (body.moa_config) throw new HttpFailure(503, 'MoA overrides need the Agent command registry (checkpoint 7).')
  const admissionCheck = fence ? (target: Session) => {
    if (!deps.profilesMatch(target.profile, fence.profile) || target.project_id !== fence.project_id || target.archived) throw new HttpFailure(409, 'Queue target profile or project changed')
  } : undefined
  const response = (await deps.turns.start(s, { timing, admissionCheck, msg, ...(prompt === null ? {} : { prompt }), attachments, workspace, model, modelProvider: provider, normalizedModel: normalized, source: 'webui', voiceTurn: body.voice_turn === true, connectCard: body.connect_card === true, skillSecret: body.skill_secret === true, ...settle }))
  if (response._status !== undefined && response._status >= 400) throw new HttpFailure(response._status, response.error ?? 'chat start failed', response.active_stream_id ? { active_stream_id: response.active_stream_id } : {})
  return startPayload(response)
}
