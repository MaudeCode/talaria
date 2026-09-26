/**
 * One agent turn: admission, pending-state persistence, the sidecar
 * `chat.start` call, live frame relay into the journal and stream channel,
 * transcript settlement, cancel, steer, approvals, and clarify answers
 * (Python `api/routes.py::_start_chat_stream_for_session`,
 * `api/streaming.py::_run_agent_streaming`, `cancel_stream`).
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, readFileSync, rmSync } from 'node:fs'
import { openAnchoredFd } from '../workspace/fs.js'
import { isWithin, resolvePathLikePython } from '../workspace/paths.js'
import type { SidecarLike } from '../sidecar/client.js'
import { SidecarError } from '../sidecar/client.js'
import type { SessionStore } from './store.js'
import type { SessionService } from './service.js'
import { HttpFailure, markSessionTitleGenerated } from './service.js'
import type { SessionEventBus } from './events.js'
import { StreamRegistry, SessionChannels, type StreamChannel } from './streams.js'
import { PendingPrompts } from './pending.js'
import { RunJournal, type RunJournalWriter } from './journal.js'
import { Session, titleFrom, type Message } from './session.js'
import { buildActiveTurnToken, redactSessionData, redactString } from '../redact.js'
import { dict, type Config } from '../config/agent-config.js'
import { ReasoningTitleTracker, reasoningEventPayload } from './reasoning-titles.js'
import { messageWindowForDisplay, messagesForLimitedPayload, toolCallsForMessageWindow } from './window.js'
import { attachTodoState } from './todo.js'
import { withSessionWireFlags } from './list.js'
import { hydrateAnchorActivityScenes, withTurnIds } from './anchor.js'
import { persistentStateChanges, persistentStateSnapshot } from './state-saved.js'
import { maxIterationsFromConfig, maxTokensFromConfig, processWakeupMaxIterations, reasoningConfigFromConfig, webuiEphemeralSystemPrompt, workspaceSystemMessage } from './turn-context.js'
import { agentSteerText, assistantReplyAddedAfterCurrentTurn, buildPartialMessage, extractToolCallsFromMessages, injectMaxIterationSummaryFallback, isContextCompressionMarker, isDict, mergeDisplayMessagesAfterAgentResult, messageIdentity, messageText, sanitizeMessagesForApi, sessionLacksFinalAssistantAnswer, splitThinkingFromContent, stripXmlToolCalls, workspaceContextPrefix } from './merge.js'
import { fallbackTitleFromExchange, firstExchangeSnippets, isGenericFallbackTitle, latestExchangeSnippets, looksInvalidGeneratedTitle, sanitizeGeneratedTitle, titleLanguageMismatch, titlePrompts } from './titles.js'
import type { WorkspaceRegistry } from '../workspace/workspaces.js'
import { str } from '../util.js'

export const CHAT_LOCK_WAIT_SECONDS = 2
const IMAGE_MODE_TIMEOUT_MS = 15_000
const TERMINAL_SSE_VISIBLE_MESSAGE_LIMIT = 80

export interface TurnRunnerDeps {
  store: SessionStore
  service: () => SessionService
  events: SessionEventBus
  registry: StreamRegistry
  channels: SessionChannels
  pending: PendingPrompts
  journal: RunJournal
  sidecar: () => SidecarLike | null
  profileHome: (profile: string | null) => string
  workspaces: WorkspaceRegistry
  now: () => number
  log: (line: string) => void
  redactEnabled: () => boolean
  /** `webui.session_save_mode`: `deferred` (default) or `eager`. */
  saveMode: () => 'deferred' | 'eager'
  /** Per-session toolsets override or the profile's configured toolsets (null lets the Agent decide). */
  toolsetsFor: (session: Session) => string[] | null
  attachmentDir: (sid: string) => string
  agentName: () => string
  titleGenerationEnabled: () => boolean
  /** Terminal relay phase per stream (`completed`/`cancelled`/`failed`); Python `note_talaria_terminal`. */
  onTerminal?: (streamId: string, phase: string) => void
  /** Insights title sync (Python `sync_session_title`), gated on `sync_to_insights` by the runtime. */
  syncTitle?: (session: Session) => Promise<void>
  /** Whether the profile's deletion RPC is in flight (its home must not be entered by a new turn). */
  profileDeleting?: (profile: string | null) => boolean
  updateInProgress?: () => boolean
  /** Runs after the run is retired (Python teardown idle hook: deferred process wakeups). */
  onTurnEnd?: (sessionId: string) => void
  /** The profile's config.yaml (turn budgets, reasoning effort, personality, delivery context); null when unavailable. */
  profileConfig?: (profile: string | null) => Promise<Config | null>
  env?: Record<string, string | undefined>
  hermesHome?: string
  homeDisplay?: () => string
}

interface SteerRecord { steer_id: string; session_id: string; stream_id: string; text: string; display_text: string; created_at: number }
/** A steer the Agent took, with where it landed: after the last tool that had completed when it was consumed. */
interface ConsumedSteer { steer_id: string; text: string; agent_text: string; submitted_at: number; consumed_at: number; after_tool_call_id: string | null }

export interface StartTurnOptions {
  msg: string
  attachments?: Record<string, unknown>[]
  workspace: string
  model: string | null
  modelProvider: string | null
  normalizedModel?: boolean
  source?: string
  goalRelated?: boolean
  ephemeral?: boolean
  onDone?: (answer: string) => void
  /** Runs when the turn ends in an error or cancel (Python background runner: `complete_background(..., "(background task failed)")`). */
  onFailed?: () => void
}

export interface StartTurnResponse {
  stream_id?: string
  session_id?: string
  pending_started_at?: number | null
  turn_id?: string | null
  title?: string
  effective_model?: string
  effective_model_provider?: string
}

interface ErrorClassification { label: string; type: string; hint: string }

export function classifyProviderError(errStr: string, opts: { silentFailure?: boolean | undefined; condition?: string | undefined } = {}): ErrorClassification {
  const lower = errStr.toLowerCase()
  if (opts.condition === 'credential_missing') return { label: 'Authentication failed', type: 'auth_mismatch', hint: 'The selected model may not be supported by your configured provider or your API key is invalid. Run `hermes model` in your terminal to update credentials, then restart the WebUI.' }
  const cancelled = ['cancelled by user', 'canceled by user', 'user cancelled', 'user canceled', 'task cancelled', 'task canceled', 'cancellederror'].some((k) => lower.includes(k))
  if (cancelled) return { label: 'Task cancelled', type: 'cancelled', hint: cancelledTurnHint() }
  if (['interrupted by user', 'response interrupted', 'operation interrupted', 'operation was interrupted', 'operation aborted', 'request was aborted', 'aborterror'].some((k) => lower.includes(k))) {
    return { label: 'Response interrupted', type: 'interrupted', hint: 'The run stopped before a provider response completed. If you did not cancel it, try again.' }
  }
  const quota = ['insufficient_quota', 'insufficient credits', 'out of credits', 'credits exhausted', 'quota exceeded', 'usage limit', 'plan limit', 'billing'].some((k) => lower.includes(k))
  const poolEmpty = lower.includes('credential(s) exhausted') || lower.includes('credentials exhausted') || (lower.includes('credential') && lower.includes('exhausted'))
  const auth = !quota && !poolEmpty && (errStr.includes('401') || lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('invalid_api_key') || lower.includes('no cookie auth credentials'))
  const notFound = errStr.includes('404') || lower.includes('not found') || lower.includes('does not exist') || lower.includes('model_not_found') || lower.includes('invalid model') || lower.includes('does not match any known model') || lower.includes('unknown model')
  const rateLimit = !quota && (lower.includes('rate limit') || errStr.includes('429'))
  const compressionExhausted = lower.includes('compression_exhausted') || lower.includes('compression exhausted') || (lower.includes('context length exceeded') && lower.includes('cannot compress further'))
  if (poolEmpty) return { label: 'No usable credentials', type: 'credential_pool_empty', hint: 'The credential pool for this provider has no usable keys left (all entries exhausted or unconfigured). Add or refresh a key for this provider in your Hermes config / credential pool, or switch providers via `hermes model`.' }
  if (quota) return { label: 'Out of credits', type: 'quota_exhausted', hint: 'Your provider account is out of credits or usage. Top up, wait for the plan window to reset, or switch providers via `hermes model`.' }
  if (rateLimit) return { label: 'Rate limit reached', type: 'rate_limit', hint: 'Rate limit reached. The fallback model (if configured) was also exhausted. Try again in a moment.' }
  if (auth) return { label: 'Authentication failed', type: 'auth_mismatch', hint: 'The selected model may not be supported by your configured provider or your API key is invalid. Run `hermes model` in your terminal to update credentials, then restart the WebUI.' }
  if (notFound) return { label: 'Model not found', type: 'model_not_found', hint: 'The selected model was not found by the provider. Check the model ID in Settings or run `hermes model` to verify it exists for your provider.' }
  if (compressionExhausted) return { label: 'Context compression exhausted', type: 'compression_exhausted', hint: 'The conversation context is too large to compress safely. Start a new conversation or retry with a narrower task.' }
  if (opts.silentFailure) return { label: 'No response from provider', type: 'no_response', hint: 'The provider returned no content and no error. This often means a usage/rate limit was hit silently. Check provider status, switch providers via `hermes model`, or try again in a moment.' }
  return { label: 'Error', type: 'error', hint: '' }
}

export function cancelledTurnHint(agentName = 'Hermes'): string {
  return `${agentName} stopped this turn at your request. Send a new message to continue.`
}

export function providerErrorPayload(message: string, errType: string, hint = '', redact = true): Record<string, unknown> {
  const safe = redact ? redactString(message).trim() : message
  const payload: Record<string, unknown> = { message: safe || message, type: errType }
  if (hint) payload.hint = hint
  if (safe) payload.details = safe.length > 1200 ? `${safe.slice(0, 1197).trimEnd()}…` : safe
  return payload
}

/** The image formats a provider accepts inline; the MIME comes from the bytes, never from the client. */
/**
 * Python `_IMAGE_MAGIC` / `_is_valid_image`: the declared MIME must match the file's signature; BMP joins the binary
 * set, and SVG (text, no signature) is accepted on its declared type when the bytes read as an SVG document.
 */
export function sniffImageMime(bytes: Buffer, declared = ''): string | null {
  const mime = declared.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mime === 'image/svg+xml') return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8')) ? 'image/svg+xml' : null
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp'
  return null
}

const COMPRESSION_RECOVERY_TERMINAL_STATE = 'compression_exhausted'
const COMPRESSION_RECOVERY_ACTION_START_FOCUSED = 'start_focused_continuation'

/** Python `build_compression_recovery_payload` + `stamp_compression_exhausted_recovery`. */
export function stampCompressionExhaustedRecovery(s: Session, message: string, details: string): Record<string, unknown> {
  const positive = (v: unknown): number => { const n = Math.trunc(Number(v) || 0); return n > 0 ? n : 0 }
  const payload: Record<string, unknown> = {
    terminal_state: COMPRESSION_RECOVERY_TERMINAL_STATE,
    recommended_action: COMPRESSION_RECOVERY_ACTION_START_FOCUSED,
    source_session_id: s.session_id,
    created_at: Date.now() / 1000,
    title: 'Context compression exhausted',
    summary: 'This run could not safely shrink the conversation enough to continue in place. Start a focused continuation, then describe the next narrow task.',
    action_label: 'Start focused continuation',
    message: message.trim(),
    details: details.trim().slice(0, 1200),
    last_prompt_tokens: positive(s.last_prompt_tokens),
    threshold_tokens: positive(s.threshold_tokens),
    context_length: positive(s.context_length),
  }
  s.recommended_recovery_action = COMPRESSION_RECOVERY_ACTION_START_FOCUSED
  s.compression_recovery = payload
  return payload
}

/** Python `is_generic_continuation_intent`: short, content-free continuation requests (incl. CJK), punctuation-normalised. */
const GENERIC_CONTINUATION_INTENTS = new Set(['continue', 'continue please', 'go on', 'keep going', 'resume', 'proceed', 'carry on', '继续', '继续吧', '接着', '接着做', '继续做', '继续执行'])
export function isGenericContinuationIntent(text: string): boolean {
  // Python `[\W_]+` under re.UNICODE keeps CJK letters; JS `\w` is ASCII-only, so the Unicode classes are spelled out.
  const normalized = text.trim().toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!normalized) return false
  if (GENERIC_CONTINUATION_INTENTS.has(normalized)) return true
  const parts = normalized.split(' ')
  return parts.length > 0 && parts.length <= 2 && parts.every((p) => GENERIC_CONTINUATION_INTENTS.has(p))
}

/** Python `_explicit_text_signal`: `agent.image_input_mode: text` or a configured `auxiliary.vision` backend. */
export function explicitTextSignal(cfg: Config): boolean {
  const agent = dict(cfg.agent)
  if (str(agent.image_input_mode ?? 'auto').trim().toLowerCase() === 'text') return true
  const vision = dict(dict(cfg.auxiliary).vision)
  const provider = str(vision.provider).trim().toLowerCase()
  return !['', 'auto'].includes(provider) || Boolean(str(vision.model).trim()) || Boolean(str(vision.base_url).trim())
}

export const GATEWAY_APPROVAL_RELAY_UNAVAILABLE = 'Gateway approval could not be relayed because the active run is unavailable. Reopen the session or retry after it reconnects.'

/** Error classifications that are turn outcomes in their own right (not a generic failure). */
const CLASSIFIED_OUTCOMES = new Set(['no_response', 'compression_exhausted', 'interrupted', 'cancelled'])

export class TurnRunner {
  readonly writers = new Map<string, RunJournalWriter>()
  private readonly sessionPuts = new Map<string, (event: string, data: Record<string, unknown>) => void>()
  /** Per-session chain for sidecar YOLO mutation + local commit, so opposing toggles cannot interleave. */
  private readonly yoloChains = new Map<string, Promise<unknown>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly steers = new Map<string, SteerRecord[]>()
  private readonly consumedSteers = new Map<string, ConsumedSteer[]>()
  private readonly lastCompletedTool = new Map<string, string>()
  /** Streams whose run completed (`done` emitted) and only await title work; a late cancel is a no-op for these. */
  private readonly settledStreams = new Set<string>()

  constructor(readonly deps: TurnRunnerDeps) {}

  private get registry(): StreamRegistry { return this.deps.registry }

  // ── admission ────────────────────────────────────────────────────────────

  /** Python `_start_chat_stream_for_session`: persist pending state, register the channel, launch the worker. */
  start(session: Session, opts: StartTurnOptions): StartTurnResponse & { _status?: number; error?: string; active_stream_id?: string | null } {
    const s = session
    if (this.deps.updateInProgress?.()) return { error: 'Web is updating. Retry after it restarts.', _status: 503 }
    if (this.deps.profileDeleting?.(s.profile ?? null)) return { error: `Profile '${str(s.profile)}' is being deleted.`, _status: 409 }
    const locked = s.active_stream_id
    if (locked) {
      if (this.registry.liveIds.has(locked) || this.registry.activeRuns.has(locked)) return { error: 'session already has an active stream', active_stream_id: locked, _status: 409 }
      this.deps.service().clearStaleStreamState(s)
      if (s.active_stream_id) return { error: 'session already has an active stream', active_stream_id: s.active_stream_id, _status: 409 }
    } else {
      const blocking = this.registry.activeRunStreamForSession(s.session_id)
      if (blocking) return { error: 'session already has an active stream', active_stream_id: blocking, _status: 409 }
    }
    const streamId = randomUUID().replace(/-/g, '')
    const wasHiddenEmpty = !s.messages.length && !s.context_messages.length && !s.pending_user_message
    const attachments = opts.attachments ?? []
    const source = str(s.source_tag).toLowerCase() === 'fork' ? 'fork' : (opts.source ?? 'webui')
    s.workspace = opts.workspace
    s.model = opts.model
    s.model_provider = opts.modelProvider
    s.active_stream_id = streamId
    s.post_compression_context_tokens_estimate = null
    s.pending_user_message = opts.msg
    s.pending_attachments = attachments
    s.pending_started_at = this.deps.now()
    s.pending_user_source = source
    if (['', 'Untitled', 'New Chat'].includes(str(s.title).trim())) {
      const provisional = titleFrom([{ role: 'user', content: opts.msg }], s.title || 'Untitled')
      if (provisional && !['', 'Untitled', 'New Chat'].includes(provisional.trim())) s.title = provisional
    }
    if (this.deps.saveMode() === 'eager') this.checkpointUserMessage(s, opts.msg, attachments, s.pending_started_at, source, streamId)
    this.deps.store.save(s)
    this.registry.writebackOwners.set(s.session_id, streamId)
    if (wasHiddenEmpty) this.deps.events.publish('session_new', { profile: s.profile, sessionId: s.session_id })
    try { this.deps.workspaces.setLastWorkspace(opts.workspace, s.profile) } catch { /* best effort */ }
    const channel = this.registry.create(streamId, s.session_id)
    if (opts.goalRelated) this.registry.goalRelated.add(streamId)
    this.registry.registerActiveRun({ stream_id: streamId, session_id: s.session_id, started_at: this.deps.now(), phase: 'starting', workspace: opts.workspace, model: opts.model, provider: opts.modelProvider, ephemeral: Boolean(opts.ephemeral) })
    void this.run(s.session_id, streamId, channel, opts).catch((error: unknown) => {
      this.deps.log(`[webui] ERROR turn ${streamId} crashed\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    })
    const response: StartTurnResponse = { stream_id: streamId, session_id: s.session_id, pending_started_at: s.pending_started_at, turn_id: streamId, title: s.title }
    if (opts.normalizedModel && opts.model) response.effective_model = opts.model
    if (opts.modelProvider) response.effective_model_provider = opts.modelProvider
    return response
  }

  /** Python `_checkpoint_user_message_for_eager_session_save`. */
  private checkpointUserMessage(s: Session, msg: string, attachments: Record<string, unknown>[], startedAt: number | null, source: string, turnId: string): void {
    const latest = s.messages[s.messages.length - 1]
    if (latest?.role === 'user' && messageText(latest.content).split(/\s+/).join(' ') === msg.split(/\s+/).join(' ')) return
    const user: Message = { role: 'user', content: msg, _turn_id: turnId }
    const token = buildActiveTurnToken(s.active_stream_id, startedAt)
    if (token) user._active_turn_token = token
    if (source !== 'webui') user._source = source
    if (typeof startedAt === 'number' && startedAt > 0) user.timestamp = startedAt
    if (attachments.length) user.attachments = [...attachments]
    s.messages.push(user)
  }

  // ── worker ───────────────────────────────────────────────────────────────

  private async run(sessionId: string, streamId: string, channel: StreamChannel, opts: StartTurnOptions): Promise<void> {
    const { deps } = this
    let writer: RunJournalWriter | null = null
    try {
      writer = deps.journal.writer(sessionId, streamId)
      this.writers.set(streamId, writer)
    } catch (error) {
      deps.log(`[webui] WARNING: run journal degraded for stream ${streamId}: ${(error as Error).message}`)
    }
    const put = (event: string, data: Record<string, unknown>): void => {
      for (const steerEvent of this.takeSteerEventsBefore(streamId, event)) put(steerEvent[0], steerEvent[1])
      if (this.registry.cancelled.has(streamId) && !['cancel', 'apperror', 'steer_consumed', 'pending_steer_leftover'].includes(event)) return
      // `cancel()` already wrote the terminal row and closed the stream: the worker's unwind adds no second one.
      if (event === 'cancel' && !this.registry.streams.has(streamId)) {
        try { deps.onTerminal?.(streamId, 'cancelled') } catch { /* best effort */ }
        return
      }
      let eventId: string | null = null
      if (writer) {
        try {
          eventId = writer.appendSseEvent(event, data).event_id
        } catch (error) {
          deps.log(`[webui] WARNING: run journal append failed for ${streamId}/${event}: ${(error as Error).message}`)
        }
      }
      channel.put([event, data, eventId])
      if (event === 'done' || event === 'cancel' || event === 'apperror' || event === 'error') {
        try { deps.onTerminal?.(streamId, event === 'done' ? 'completed' : event === 'cancel' ? 'cancelled' : 'failed') } catch { /* best effort */ }
      }
    }
    this.sessionPuts.set(sessionId, put)
    const activeRun = this.registry.activeRuns.get(streamId)
    let s: Session
    try {
      s = deps.store.get(sessionId)
    } catch {
      put('apperror', { type: 'error', message: 'Session not found', session_id: sessionId })
      this.teardown(sessionId, streamId)
      return
    }
    const msgText = opts.msg
    const previousMessages = structuredClone(s.messages)
    // Python `reconciled_state_db_messages_for_session(prefer_context=True)`: the model history is the owner context
    // extended append-only with the Agent's state.db rows (a CLI continuation of this session reaches the model), except
    // for a compressed context whose anchor cannot be verified — that stays context-only.
    const localContext: Message[] = s.context_messages.length ? s.context_messages : s.messages.filter((m) => !m._error && !m._partial)
    const previousContext = structuredClone(localContext.some((m) => isContextCompressionMarker(m)) ? localContext : deps.service().mergedTranscript(s, localContext))
    // Python `_sanitize_messages_for_api`: the model never sees display-only rows or a replayed cancelled prompt.
    const apiHistory = sanitizeMessagesForApi(previousContext)
    const activeTurnToken = buildActiveTurnToken(streamId, s.pending_started_at)
    const sidecar = deps.sidecar()
    const partialText = this.registry.partialText.get(streamId) ?? []
    const reasoningText = this.registry.reasoningText.get(streamId) ?? []
    const liveToolCalls = this.registry.liveToolCalls.get(streamId) ?? []
    let tokenSent = false
    let firstTokenAt: number | null = null
    const titles = new ReasoningTitleTracker()
    let capturedTerminalError: string | null = null
    const controller = new AbortController()
    this.abortControllers.set(streamId, controller)
    const workspaceCtx = workspaceContextPrefix(opts.workspace)
    const userMessage = await this.buildUserMessage(workspaceCtx, msgText, opts.attachments ?? [], opts.workspace, sessionId, s, opts, controller.signal)
    if (activeRun) activeRun.phase = 'running'
    const settledAt = { value: false }
    let failed = false
    try {
      if (!sidecar) throw new SidecarError('The Agent sidecar is not running; chat is unavailable until it starts.', { condition: 'sidecar_unavailable' })
      // Python: budgets, reasoning config, personality and delivery context come from the profile's config.yaml; the
      // system message carries the frozen session workspace, the WebUI guidance rides as the ephemeral prompt.
      const cfg = (await deps.profileConfig?.(s.profile ?? null)) ?? {}
      // The sidecar's per-session YOLO state does not survive its restarts: push the local flag (either way) before
      // the turn so a stale sidecar-side enable cannot auto-approve a session the UI reports as guarded.
      await this.withYoloLock(sessionId, async () => { try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: deps.service().yolo(sessionId).yolo_enabled === true }) } catch { /* the approval path re-asserts it */ } })
      // Last yield before `chat.start`: a cancel that landed during the attachment, config or YOLO awaits must not
      // start an Agent turn (the client also refuses an already-aborted signal outright).
      if (this.registry.cancelled.has(streamId)) {
        this.finalizeCancelled(s, streamId, 'Task cancelled before start.', opts.ephemeral)
        put('cancel', this.cancelPayload('Cancelled before start'))
        return
      }
      const frozenWorkspace = str(s.created_workspace) || str(s.workspace)
      const turnContext = {
        system_message: workspaceSystemMessage(frozenWorkspace),
        ephemeral_system_prompt: webuiEphemeralSystemPrompt({ config: cfg, personality: str(s.personality) || null, sessionId, profile: s.profile ?? null, workspace: frozenWorkspace, hermesHome: deps.profileHome(s.profile), homeDisplay: deps.homeDisplay?.() ?? '~/.hermes' }),
        max_iterations: processWakeupMaxIterations(maxIterationsFromConfig(cfg), opts.source ?? 'webui', deps.env ?? {}),
        max_tokens: maxTokensFromConfig(cfg),
        reasoning_config: reasoningConfigFromConfig(cfg, opts.modelProvider ?? s.model_provider ?? null),
      }
      // Python `_public_prefill_context_status`: the session-recall prefill hook was dropped with TAL-245, so the
      // context frame always reports the not-configured shape.
      const persistentBefore = persistentStateSnapshot(deps.profileHome(s.profile))
      put('context_status', { session_id: sessionId, prefill: { status: 'not_configured', source: 'none', label: '', message_count: 0 } })
      const result = await sidecar.call('chat.start', {
        profile_home: deps.profileHome(s.profile), session_id: sessionId, stream_id: streamId, workspace: opts.workspace, model: opts.model ?? '', model_provider: opts.modelProvider,
        user_message: userMessage, ...turnContext, conversation_history: apiHistory, enabled_toolsets: deps.toolsetsFor(s),
      }, {
        signal: controller.signal,
        timeoutMs: 0,
        onStream: (frame) => {
          const data = isDict(frame.data) ? frame.data : {}
          switch (frame.event) {
            case 'token': {
              tokenSent = true
              firstTokenAt ??= deps.now()
              // Visible text closes the reasoning segment: a stable title snapshot (or a clear) goes out first.
              const stable = titles.stableSnapshot(reasoningText.join(''))
              if (stable !== null) put('reasoning', { text: '', titles: stable })
              partialText.push(str(data.text))
              put('token', { text: str(data.text) })
              return
            }
            case 'reasoning': {
              if (partialText.length && !reasoningText.length) titles.resetSegment()
              reasoningText.push(str(data.text))
              // Python `reasoning_event_payload`: bold or first-line titles ride on the delta they complete.
              put('reasoning', titles.prepare(reasoningEventPayload(str(data.text), reasoningText.join(''))))
              return
            }
            case 'steer_pending':
              for (const record of this.takeConsumedSteers(streamId, str(data.text), { keepLeftovers: true })) put('steer_consumed', record)
              this.saveConsumedSteers(sessionId, streamId)
              return
            case 'tool':
              liveToolCalls.push({ name: data.name, args: data.args ?? {}, tid: str(data.tid), done: false })
              put('tool', data)
              return
            case 'tool_complete':
              for (let i = liveToolCalls.length - 1; i >= 0; i -= 1) {
                const tc = liveToolCalls[i]!
                if (tc.done) continue
                if ((str(data.tid) && tc.tid === str(data.tid)) || (!tc.tid && tc.name === data.name)) { tc.done = true; tc.snippet = data.preview; break }
              }
              if (str(data.tid)) this.lastCompletedTool.set(streamId, str(data.tid))
              put('tool_complete', data)
              return
            // Python: the live chat frame carries the queue head plus depth, not the entry that just arrived.
            case 'approval': {
              deps.pending.submitApproval(sessionId, { ...data, session_id: sessionId })
              const { pending, pending_count } = deps.pending.approvalPending(sessionId)
              put('approval', { ...(pending ?? data), pending_count })
              return
            }
            case 'clarify': {
              deps.pending.submitClarify(sessionId, { ...data, session_id: sessionId, kind: 'clarify' })
              const head = deps.pending.clarifyHeadFrame(sessionId)
              if (head) put('clarify', head)
              return
            }
            case 'clarify_resolved': {
              const { head } = deps.pending.resolveClarify(sessionId, str(data.clarify_id))
              if (head) put('clarify', head)
              return
            }
            case 'status':
              if (data.kind === 'terminal_error' && !capturedTerminalError) capturedTerminalError = str(data.message)
              return
            default:
              put(frame.event, data)
          }
        },
      })
      settledAt.value = true
      if (this.registry.cancelled.has(streamId) || result.status === 'cancelled') {
        this.finalizeCancelled(s, streamId, 'Task cancelled.', opts.ephemeral)
        put('cancel', this.cancelFrame(sessionId))
        return
      }
      if (opts.ephemeral) {
        let answer = ''
        for (let i = result.messages.length - 1; i >= 0; i -= 1) {
          const m = result.messages[i]!
          if (m.role === 'assistant') { answer = str(m.content); break }
        }
        opts.onDone?.(answer)
        // Python `_ephemeral_session_payload`: only role and content leave the server for a btw turn.
        put('done', { session: { session_id: sessionId, messages: (result.messages).map((m) => ({ role: m.role, content: m.content })) }, usage: { input_tokens: 0, output_tokens: 0 }, ephemeral: true, answer })
        try { rmSync(deps.store.pathFor(sessionId), { force: true }) } catch { /* ignore */ }
        deps.store.sessions.delete(sessionId)
        return
      }
      // Writeback only while this stream still owns the session (Python `_stream_writeback_is_current`).
      let current: Session
      try { current = deps.store.get(sessionId) } catch { current = s }
      if (current.active_stream_id !== streamId) {
        deps.log(`[webui] Skipping stale stream writeback for session ${sessionId} stream ${streamId}; active_stream_id=${current.active_stream_id ?? ''}`)
        return
      }
      s = current
      // Python `_maybe_inject_max_iteration_summary_fallback`: an exhausted tool budget leaves the closing
      // explanation in `final_response` only, so it becomes the turn's assistant answer before anything else reads it.
      const resultMessages = result.tool_limit_reached ? injectMaxIterationSummaryFallback(result.messages, result.final_response) : (result.messages as Message[])
      // Python `_assistant_reply_added_after_current_turn`: replayed history never counts as this turn's answer (the
      // sidecar reports `completed` whenever a failed run still carries messages).
      // Python's second chance: a turn that emitted no new row still counts when the merged transcript it produced
      // ends on a final answer (the current user row or trailing tool activity makes it "lacking").
      const mergedForCheck = (): Message[] => mergeDisplayMessagesAfterAgentResult(previousMessages, previousContext, resultMessages, msgText, { source: opts.source ?? 'webui', activeTurnToken, now: deps.now(), turnId: streamId })
      const assistantAdded = assistantReplyAddedAfterCurrentTurn(resultMessages, previousContext, msgText) || !sessionLacksFinalAssistantAnswer(mergedForCheck())
      const lastErr = result.error ?? capturedTerminalError ?? ''
      // Python `_turn_transcript_lacks_final_assistant_answer`: a partial result with no final answer is a silent failure even if tokens streamed.
      const stalePartial = result.result_status === 'partial' && !assistantAdded
      if (result.status === 'error' || (!assistantAdded && !tokenSent) || stalePartial) {
        const classification = classifyProviderError(lastErr, { silentFailure: !lastErr })
        const errStr = lastErr || `${classification.label}.`
        const payload = providerErrorPayload(errStr, classification.type, classification.hint, deps.redactEnabled())
        // Settle the steers first so the persisted turn carries every consumed one; the Agent's pending text stays a leftover.
        const steerEvents = this.finalizeSteerEvents(streamId, str(result.pending_steer))
        this.persistError(s, streamId, classification.label, payload, activeTurnToken)
        payload.session = redactSessionData(this.terminalSessionPayload(s), deps.redactEnabled())
        payload.session_id = s.session_id
        payload.old_session_id = sessionId
        for (const [event, data] of steerEvents) put(event, data)
        put('apperror', payload)
        failed = true
        return
      }
      // ── settle the transcript ──
      // The Agent's last pending-steer text settles the remaining steers before the turn is written back.
      const steerEvents = this.finalizeSteerEvents(streamId, result.pending_steer)
      s.messages = mergeDisplayMessagesAfterAgentResult(previousMessages, previousContext, resultMessages, msgText, { source: opts.source ?? 'webui', activeTurnToken, now: deps.now(), turnId: streamId })
      s.context_messages = dedupeContext(resultMessages)
      for (const m of s.messages) {
        if (m.role !== 'assistant') continue
        if (typeof m.content === 'string') m.content = stripXmlToolCalls(m.content)
      }
      if (result.compressed) {
        s.compression_anchor_visible_idx = Math.max(0, previousMessages.length - 1)
        put('compressed', { session_id: sessionId, old_session_id: sessionId, new_session_id: sessionId, continuation_session_id: sessionId, message: 'Compression finished' })
      }
      const now = deps.now()
      for (const m of s.messages) m.timestamp ??= now
      if (['Untitled', 'New Chat', ''].includes(str(s.title))) s.title = titleFrom(s.messages, s.title)
      const usage = result.usage
      const prevInputTokens = s.input_tokens || 0
      const prevCacheReadTokens = s.cache_read_tokens || 0
      if (usage.prompt_tokens > 0) s.input_tokens = usage.prompt_tokens
      if (usage.completion_tokens > 0) s.output_tokens = usage.completion_tokens
      if (usage.estimated_cost_usd !== null) s.estimated_cost = usage.estimated_cost_usd
      if (usage.cache_read_tokens > 0) s.cache_read_tokens = usage.cache_read_tokens
      if (usage.cache_write_tokens > 0) s.cache_write_tokens = usage.cache_write_tokens
      if (typeof result.context.context_length === 'number') s.context_length = result.context.context_length
      if (typeof result.context.threshold_tokens === 'number') s.threshold_tokens = result.context.threshold_tokens
      if (typeof result.context.last_prompt_tokens === 'number') s.last_prompt_tokens = result.context.last_prompt_tokens
      s.tool_calls = extractToolCallsFromMessages(s.messages, liveToolCalls)
      s.active_stream_id = null
      s.pending_user_message = null
      s.pending_attachments = []
      s.pending_started_at = null
      s.pending_user_source = null
      const attachments = opts.attachments ?? []
      if (attachments.length) {
        const names = attachments.map((a) => str(a.name || a.filename)).filter(Boolean)
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          const m = s.messages[i]!
          if (m.role === 'user') {
            const content = messageText(m.content)
            const base = msgText.includes('\n\n[Attached files:') ? (msgText.split('\n\n[Attached files:')[0] ?? '').trim() : msgText
            if (content.includes(base.slice(0, 60)) || msgText.includes(content.slice(0, 60))) m.attachments = names
            break
          }
        }
      }
      const prevAssistants = previousMessages.filter((m) => m.role === 'assistant').length
      const reasoning = reasoningText.join('')
      let asstIdx = 0
      for (const m of s.messages) {
        if (m.role !== 'assistant') continue
        const turnIdx = asstIdx
        asstIdx += 1
        if (turnIdx < prevAssistants) continue
        const existing = str(m.reasoning)
        if (typeof m.content === 'string' && m.content) {
          const [content, merged] = splitThinkingFromContent(m.content, existing)
          m.content = content
          if (merged) m.reasoning = merged
        }
        if (turnIdx === prevAssistants && reasoning.trim() && !m.reasoning) m.reasoning = reasoning.trim()
      }
      const duration = Math.max(0, now - previousStartedAt(s, activeRun))
      for (let i = s.messages.length - 1; i >= 0; i -= 1) {
        const m = s.messages[i]!
        if (m.role === 'assistant') {
          m._turnDuration = Math.round(duration * 1000) / 1000
          if (usage.completion_tokens && duration > 0) m._turnTps = Math.round((usage.completion_tokens / duration) * 10) / 10
          if (result.model) m._usedModel = result.model
          // The live `done` frame says the tool budget ran out; the persisted row says so too, so a reload agrees.
          if (result.tool_limit_reached && m._turn_id === streamId) m._terminal_state = 'tool_limit_reached'
          break
        }
      }
      this.persistConsumedSteers(s, streamId, previousStartedAt(s, activeRun), now)
      deps.store.save(s)
      deps.pending.clearApprovals(sessionId)
      deps.pending.clearClarifies(sessionId)
      deps.events.publish('session_done', { profile: s.profile, sessionId: s.session_id })
      // Python `_persistent_state_changes`: toast memory/skill files the agent wrote during the turn.
      try {
        const changes = persistentStateChanges(persistentBefore, persistentStateSnapshot(deps.profileHome(s.profile)))
        if (changes.memory_saved) put('state_saved', { session_id: sessionId, kind: 'memory', action: 'saved' })
        for (const change of changes.skills) put('state_saved', { session_id: sessionId, kind: 'skill', action: change.action, name: change.name })
      } catch (error) {
        deps.log(`[webui] persistent state change detection failed for ${sessionId}: ${(error as Error).message}`)
      }
      // Python usage payload: session counters plus the per-turn timing and cache-hit figures the clients label with.
      const cacheHit = (cacheRead: number, prompt: number): number | null => (cacheRead > 0 && prompt > 0 ? Math.min(100, Math.round((cacheRead / prompt) * 100)) : null)
      const inputTokens = s.input_tokens || 0
      const cacheReadTokens = s.cache_read_tokens || 0
      const turnInput = Math.max(0, inputTokens - prevInputTokens)
      const turnCacheRead = Math.max(0, cacheReadTokens - prevCacheReadTokens)
      const doneUsage: Record<string, unknown> = {
        input_tokens: s.input_tokens, output_tokens: s.output_tokens, estimated_cost: s.estimated_cost, cache_read_tokens: s.cache_read_tokens, cache_write_tokens: s.cache_write_tokens,
        cache_hit_percent: cacheHit(cacheReadTokens, inputTokens), turn_cache_hit_percent: cacheHit(turnCacheRead, turnInput), duration_seconds: Math.round(duration * 1000) / 1000,
        context_length: s.context_length ?? 0, threshold_tokens: s.threshold_tokens ?? 0, last_prompt_tokens: s.last_prompt_tokens ?? 0,
      }
      if (usage.completion_tokens && duration > 0) doneUsage.tps = Math.round((usage.completion_tokens / duration) * 10) / 10
      if (firstTokenAt !== null) doneUsage.ttft_ms = Math.max(0, Math.round((firstTokenAt - previousStartedAt(s, activeRun)) * 1000))
      const usedModel = str(result.model) || str(opts.model) || str(s.model)
      if (usedModel) doneUsage.used_model = usedModel
      const donePayload: Record<string, unknown> = {
        session: redactSessionData(this.terminalSessionPayload(s), deps.redactEnabled()),
        usage: doneUsage,
      }
      if (result.tool_limit_reached) {
        donePayload.terminal_state = 'tool_limit_reached'
        donePayload.terminal_reason = 'max_iterations'
      }
      put('done', donePayload)
      for (const [event, payload] of steerEvents) put(event, payload)
      // The turn is over: release admission before the title work so a follow-up message is accepted while the
      // (up to two) title prompts run; the channel and journal stay open for the `title` events (Python retired the
      // worker before its daemon-thread title generation).
      this.registry.activeRuns.delete(streamId)
      this.settledStreams.add(streamId)
      await this.backgroundTitle(s, put)
      // Python: the last non-error assistant reply with content, else "(no answer produced)".
      if (opts.onDone) {
        let answer = ''
        for (let i = s.messages.length - 1; i >= 0; i -= 1) { const m = s.messages[i]!; if (m.role !== 'assistant' || m._error) continue; const text = messageText(m.content).trim(); if (text) { answer = text; break } }
        opts.onDone(answer || '(no answer produced)')
      }
    } catch (error) {
      if (settledAt.value && !(error instanceof SidecarError)) {
        deps.log(`[webui] ERROR settling turn ${streamId}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      }
      failed = true
      if (this.registry.cancelled.has(streamId)) {
        this.finalizeCancelled(s, streamId, 'Task cancelled.', opts.ephemeral)
        put('cancel', this.cancelFrame(sessionId))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const condition = error instanceof SidecarError ? error.condition : undefined
      const classification = classifyProviderError(message, { condition })
      const payload = providerErrorPayload(message, classification.type, classification.hint, deps.redactEnabled())
      if (condition === 'sidecar_unavailable' || condition === 'agent_runtime_stale') {
        payload.type = condition === 'agent_runtime_stale' ? 'agent_runtime_stale' : 'sidecar_unavailable'
        payload.condition = condition
      }
      try {
        let current: Session = s
        try { current = deps.store.get(sessionId) } catch { current = s }
        if (current.active_stream_id === streamId) {
          for (const [event, data] of this.takeSteerEventsBefore(streamId, 'apperror')) put(event, data)
          this.persistError(current, streamId, classification.label, payload, activeTurnToken)
          payload.session = redactSessionData(this.terminalSessionPayload(current), deps.redactEnabled())
        }
      } catch (persistError) {
        deps.log(`[webui] WARNING: failed to persist turn error for ${sessionId}: ${(persistError as Error).message}`)
      }
      payload.session_id = sessionId
      payload.old_session_id = sessionId
      put('apperror', payload)
    } finally {
      this.teardown(sessionId, streamId)
      // After persistence and teardown: a background route's failure cleanup deletes the hidden session, which must
      // not race the error writeback above (a re-saved session would resurface in the sidebar).
      if (failed) opts.onFailed?.()
    }
  }

  /**
   * Python `_build_user_message`: image attachments are embedded as native `image_url` parts only when the Agent's
   * resolved image mode for this model is `native` (text mode routes them through the Agent's vision tool path), and
   * only after the bytes are read through an anchored descriptor and sniffed as a real image format.
   */
  private async buildUserMessage(workspaceCtx: string, msgText: string, attachments: Record<string, unknown>[], workspace: string, sessionId: string, s: Session, opts: StartTurnOptions, signal: AbortSignal): Promise<string | Record<string, unknown>[]> {
    const text = workspaceCtx + msgText
    const candidates = attachments.filter((att) => str(att.path).trim() && str(att.mime).trim().startsWith('image/'))
    if (!candidates.length) return text
    const sidecar = this.deps.sidecar()
    if (!sidecar) return text
    // A cancel that landed before this point is final: never start the lookup or wait on it.
    if (signal.aborted) return text
    try {
      // A cancelled turn must not sit behind this lookup: the abort wins the race and `run()` then takes the cancelled path.
      const lookup = sidecar.call('text.image_mode', { profile_home: this.deps.profileHome(s.profile), provider: str(opts.modelProvider ?? s.model_provider), model: str(opts.model ?? s.model) }, { signal, timeoutMs: IMAGE_MODE_TIMEOUT_MS })
      const mode = await Promise.race([lookup, new Promise<never>((_, reject) => { if (signal.aborted) { reject(new Error('turn cancelled')); return } signal.addEventListener('abort', () => { reject(new Error('turn cancelled')) }, { once: true }) })])
      // Python `_resolve_image_input_mode`: a canonical "text" is honoured only with an explicit text signal or a model
      // KNOWN to be text-only; an unknown/custom model forwards natively and lets the Agent's retry guard downgrade.
      if (mode.mode !== 'native') {
        const cfg = (await this.deps.profileConfig?.(s.profile ?? null)) ?? {}
        if (explicitTextSignal(cfg) || mode.supports_vision === false) return text
      }
    } catch (error) {
      if (!signal.aborted) this.deps.log(`[webui] image mode lookup failed for ${sessionId}: ${(error as Error).message}`)
      return text
    }
    const parts: Record<string, unknown>[] = [{ type: 'text', text }]
    let images = 0
    const roots = [workspace, this.deps.attachmentDir(sessionId)].map((r) => resolvePathLikePython(r))
    for (const att of candidates) {
      const target = resolvePathLikePython(str(att.path).trim())
      const root = roots.find((r) => isWithin(target, r))
      if (!root) continue
      let fd: number
      try { fd = openAnchoredFd(root, target, { wantDir: false }) } catch { continue }
      try {
        const st = fstatSync(fd)
        // A hard link to a file outside the roots passes the pathname walk; refuse it on the inode like the share and media paths.
        if (!st.isFile() || st.nlink > 1 || st.size <= 0 || st.size > 20 * 1024 * 1024) continue
        const bytes = readFileSync(fd)
        const sniffed = sniffImageMime(bytes, str(att.mime))
        if (!sniffed) continue
        parts.push({ type: 'image_url', image_url: { url: `data:${sniffed};base64,${bytes.toString('base64')}` } })
        images += 1
      } catch { /* skip unreadable */ } finally { closeSync(fd) }
    }
    return images ? parts : text
  }

  /**
   * Python `_session_payload_with_terminal_window`: the same visible-message window contract as `GET /api/session?
   * msg_limit=` (renderable rows, limited payload shape, windowed tool calls, todo state) with the full count.
   */
  private terminalSessionPayload(s: Session): Record<string, unknown> {
    const payload = withSessionWireFlags(s.compact(), this.registry.liveIds)
    const scened = hydrateAnchorActivityScenes(withTurnIds(s.messages), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, clipToolResults: true })
    const [window, offset] = messageWindowForDisplay(scened, TERMINAL_SSE_VISIBLE_MESSAGE_LIMIT, null)
    const limited = messagesForLimitedPayload(window)
    payload.messages = limited
    payload.message_count = s.messages.length
    payload._messages_offset = offset
    payload._messages_truncated = offset > 0
    attachTodoState(payload, s.messages)
    payload.tool_calls = toolCallsForMessageWindow(s.tool_calls, offset, limited.length)
    return payload
  }

  /** Python `_materialize_pending_user_turn_before_error` + error message append + save. */
  private persistError(s: Session, streamId: string, label: string, payload: Record<string, unknown>, activeTurnToken: string | null): void {
    const startedAt = s.pending_started_at
    this.materializePendingUserTurn(s, activeTurnToken, streamId)
    const duration = typeof startedAt === 'number' && startedAt > 0 ? Math.max(0, this.deps.now() - startedAt) : null
    s.active_stream_id = null
    s.pending_user_message = null
    s.pending_attachments = []
    s.pending_started_at = null
    s.pending_user_source = null
    this.appendPartialSnapshot(s, streamId)
    const hint = str(payload.hint)
    const errorMessage: Message = { role: 'assistant', content: `**${label}:** ${str(payload.message) || label}${hint ? `\n\n*${hint}*` : ''}`, timestamp: Math.trunc(this.deps.now()), _error: true, _turn_id: streamId }
    if (duration !== null) errorMessage._turnDuration = Math.round(duration * 1000) / 1000
    // The classified outcome the live frame reported stays on the row, so the settled scene says the same.
    if (CLASSIFIED_OUTCOMES.has(str(payload.type))) errorMessage._terminal_state = str(payload.type)
    if (payload.type === 'compression_exhausted') {
      // Python `stamp_compression_exhausted_recovery`: durable recovery metadata on the session, the marker, and the frame.
      const recovery = stampCompressionExhaustedRecovery(s, str(payload.message) || label, str(payload.details))
      errorMessage._compressionRecovery = recovery
      payload.compression_recovery = recovery
      payload.recommended_recovery_action = recovery.recommended_action
    }
    if (payload.details) errorMessage.provider_details = payload.details
    if (payload.type === 'cancelled') errorMessage.provider_details_label = 'Cancellation details'
    else if (payload.type === 'interrupted') errorMessage.provider_details_label = 'Interruption details'
    s.messages.push(errorMessage)
    this.persistConsumedSteers(s, streamId, startedAt, this.deps.now())
    try { this.deps.store.save(s) } catch (error) { this.deps.log(`[webui] WARNING: failed to save error turn for ${s.session_id}: ${(error as Error).message}`) }
    this.deps.pending.clearApprovals(s.session_id)
    this.deps.pending.clearClarifies(s.session_id)
    this.deps.events.publish('session_error', { profile: s.profile, sessionId: s.session_id })
  }

  private materializePendingUserTurn(s: Session, activeTurnToken: string | null, turnId: string): boolean {
    const pendingText = str(s.pending_user_message)
    if (!pendingText) return false
    const recoveredTs = typeof s.pending_started_at === 'number' && s.pending_started_at > 0 ? s.pending_started_at : this.deps.now()
    const source = s.pending_user_source ?? 'webui'
    const attachments = [...s.pending_attachments]
    if (activeTurnToken) {
      for (let i = s.messages.length - 1; i >= 0; i -= 1) {
        const m = s.messages[i]!
        if (m.role === 'user' && m._active_turn_token === activeTurnToken) {
          if (!s.messages.slice(i + 1).some((later) => later.role === 'user' && !later._steer)) return false
          break
        }
      }
    }
    const last = s.messages[s.messages.length - 1]
    // Python `_synthesize_user_message_on_cancel`: a worker that already merged this prompt (same text, not older than the pending start) wins.
    if (last?.role === 'user' && messageText(last.content).trim() === pendingText.trim() && Math.trunc(Number(last.timestamp)) >= Math.trunc(recoveredTs)) return false
    const recovered: Message = { role: 'user', content: pendingText, timestamp: recoveredTs, _recovered: true, _turn_id: turnId }
    if (source !== 'webui') recovered._source = source
    if (attachments.length) recovered.attachments = attachments
    s.messages.push(recovered)
    if (s.context_messages.length) s.context_messages.push({ ...recovered })
    return true
  }

  private appendPartialSnapshot(s: Session, streamId: string): void {
    const partial = buildPartialMessage((this.registry.partialText.get(streamId) ?? []).join(''), (this.registry.reasoningText.get(streamId) ?? []).join(''), this.registry.liveToolCalls.get(streamId) ?? [], this.deps.now())
    if (!partial) return
    partial._turn_id = streamId
    const key = messageIdentity(partial)
    if (key !== null && s.messages.some((m) => m._partial && messageIdentity(m) === key)) return
    s.messages.push(partial)
  }

  private cancelPayload(message = 'Cancelled by user'): Record<string, unknown> {
    return { type: 'cancelled', message, hint: cancelledTurnHint(this.deps.agentName()) }
  }

  /** Python `_emit_cancel_event`: the terminal frame carries the settled session so tabs can render the partial without a reload. */
  private cancelFrame(sessionId: string): Record<string, unknown> {
    let snapshot: Record<string, unknown> | null = null
    try { snapshot = redactSessionData(this.terminalSessionPayload(this.deps.store.get(sessionId)), this.deps.redactEnabled()) } catch { snapshot = null }
    return { ...this.cancelPayload(), status: 'cancelled', session_id: sessionId, ...(snapshot ? { session: snapshot } : {}) }
  }

  /** Python `_finalize_cancelled_turn`/`_persist_cancelled_turn`: only while this stream still owns writeback. */
  private finalizeCancelled(s: Session, streamId: string, message: string, ephemeral: boolean | undefined): boolean {
    if (this.registry.writebackOwners.get(s.session_id) !== streamId) return false
    let current: Session = s
    try { current = this.deps.store.get(s.session_id) } catch { return false }
    if (current.active_stream_id !== null && current.active_stream_id !== streamId) return false
    if (ephemeral) {
      try { rmSync(this.deps.store.pathFor(current.session_id), { force: true }) } catch { /* ignore */ }
      this.deps.store.sessions.delete(current.session_id)
      return true
    }
    if (current.messages.some((m) => m._error && str(m.content).startsWith('**Task cancelled:**')) && current.active_stream_id === null && !current.pending_user_message) return true
    const startedAt = current.pending_started_at
    this.materializePendingUserTurn(current, buildActiveTurnToken(streamId, current.pending_started_at), streamId)
    current.active_stream_id = null
    current.pending_user_message = null
    current.pending_attachments = []
    current.pending_started_at = null
    current.pending_user_source = null
    this.appendPartialSnapshot(current, streamId)
    const text = message.trim().endsWith('.') ? message.trim() : `${message.trim()}.`
    current.messages.push({ role: 'assistant', content: `**Task cancelled:** ${text}\n\n*${cancelledTurnHint(this.deps.agentName())}*`, _error: true, provider_details: text, provider_details_label: 'Cancellation details', timestamp: Math.trunc(this.deps.now()), _turn_id: streamId })
    this.persistConsumedSteers(current, streamId, startedAt, this.deps.now())
    try { this.deps.store.save(current) } catch { return false }
    this.deps.pending.clearApprovals(current.session_id)
    this.deps.pending.clearClarifies(current.session_id)
    this.deps.events.publish('session_cancel', { profile: current.profile, sessionId: current.session_id })
    return true
  }

  /** Push a frame onto the session's live chat stream from outside the turn (Python gateway notify callbacks). */
  private emitToSession(sessionId: string, event: string, data: Record<string, unknown>): void {
    this.sessionPuts.get(sessionId)?.(event, data)
  }

  private teardown(sessionId: string, streamId: string): void {
    const writer = this.writers.get(streamId)
    if (writer) { try { writer.close() } catch { /* ignore */ } this.writers.delete(streamId) }
    this.abortControllers.delete(streamId)
    this.steers.delete(streamId)
    this.consumedSteers.delete(streamId)
    this.lastCompletedTool.delete(streamId)
    this.settledStreams.delete(streamId)
    this.registry.retire(streamId, this.deps.now())
    this.registry.forgetOwner(streamId)
    this.registry.clearWritebackOwnerIfOwned(sessionId, streamId)
    // Admission was released before the title work, so a successor turn may already own the session and have parked
    // its own prompts: only the stream that still owns the session clears them.
    const successor = this.registry.activeRunStreamForSession(sessionId)
    if (!successor || successor === streamId) {
      this.sessionPuts.delete(sessionId)
      this.deps.pending.clearApprovals(sessionId)
      this.deps.pending.clearClarifies(sessionId)
    }
    try { this.deps.onTurnEnd?.(sessionId) } catch { /* best effort */ }
  }

  /** Journal files with a live writer (retention must leave them alone). */
  activeJournalPaths(): Set<string> {
    return new Set([...this.writers.values()].map((w) => this.deps.journal.pathFor(w.sessionId, w.runId)))
  }

  // ── title ────────────────────────────────────────────────────────────────

  /** Python `_generate_llm_session_title_via_aux`: aux-route statuses (`llm_aux`, `llm_aux_retry`, `llm_*_aux`). */
  private async llmTitle(s: Session, userText: string, assistantText: string): Promise<{ title: string; status: string; rawPreview: string }> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { title: '', status: 'llm_error_aux', rawPreview: '' }
    const [qa, prompts] = titlePrompts(userText, assistantText)
    let status = 'llm_error_aux'
    for (const [idx, prompt] of prompts.entries()) {
      let raw = ''
      try {
        const result = await sidecar.call('aux.complete', { profile_home: this.deps.profileHome(s.profile), task: 'title_generation', messages: [{ role: 'system', content: prompt }, { role: 'user', content: qa }], max_tokens: 64 }, { timeoutMs: 15_000 })
        raw = str(result.text)
      } catch (error) {
        this.deps.log(`[webui] title generation failed for ${s.session_id}: ${(error as Error).message}`)
        status = 'llm_error_aux'
        continue
      }
      if (!raw) { status = 'llm_empty_aux'; continue }
      const title = sanitizeGeneratedTitle(raw)
      if (!title) return { title: '', status: 'llm_invalid_aux', rawPreview: raw.slice(0, 120) }
      if (titleLanguageMismatch(userText, title)) return { title: '', status: 'llm_language_mismatch_aux', rawPreview: raw.slice(0, 120) }
      return { title, status: idx === 0 ? 'llm_aux' : 'llm_aux_retry', rawPreview: '' }
    }
    return { title: '', status, rawPreview: '' }
  }

  /** Python `generate_session_title_for_session`: on-demand title from the persisted transcript; never touches `llm_title_generated`. */
  async generateTitle(s: Session, opts: { preferLatest?: boolean } = {}): Promise<{ title: string | null; status: string; rawPreview: string }> {
    const [userText, assistantText] = opts.preferLatest ? latestExchangeSnippets(s.messages) : firstExchangeSnippets(s.messages, { scanPastConsecutiveUsers: true })
    if (!userText) return { title: null, status: 'empty_user_message', rawPreview: '' }
    if (!this.deps.titleGenerationEnabled()) return { title: null, status: 'title_generation_disabled', rawPreview: '' }
    let next = ''
    let llmStatus = 'empty_assistant_message'
    let rawPreview = ''
    if (assistantText) ({ title: next, status: llmStatus, rawPreview } = await this.llmTitle(s, userText, assistantText))
    if (next) return { title: next, status: llmStatus, rawPreview }
    const fallback = fallbackTitleFromExchange(userText, assistantText)
    if (fallback && !isGenericFallbackTitle(fallback)) return { title: fallback, status: `local_summary:${llmStatus}`, rawPreview }
    return { title: null, status: llmStatus || 'empty_title', rawPreview }
  }

  /** Python `_run_background_title_update` (spawned only when `_background_title_generation_inputs` is eligible). */
  private async backgroundTitle(s: Session, put: (event: string, data: Record<string, unknown>) => void): Promise<void> {
    const sessionId = s.session_id
    const placeholder = str(s.title).trim()
    const invalidExisting = looksInvalidGeneratedTitle(s.title)
    const eligible = ['Untitled', 'New Chat', ''].includes(placeholder) || placeholder === titleFrom(s.messages, '') || invalidExisting
    const [userText, assistantText] = firstExchangeSnippets(s.messages)
    // Python `_put_title_status`: empty reason/title/raw_preview keys are omitted.
    const status = (status: string, reason = '', title = '', rawPreview = ''): void => {
      put('title_status', { session_id: sessionId, status, ...(reason ? { reason } : {}), ...(title ? { title } : {}), ...(rawPreview ? { raw_preview: rawPreview } : {}) })
    }
    try {
      if (!eligible || (s.llm_title_generated && !invalidExisting) || !userText || !assistantText) return
      if (s.manual_title) { status('skipped', 'manual_title', placeholder); return }
      if (!this.deps.titleGenerationEnabled()) { status('skipped', 'title_generation_disabled', placeholder); return }
      const generated = await this.llmTitle(s, userText, assistantText)
      const { status: llmStatus, rawPreview } = generated
      let next = generated.title
      let source = llmStatus
      if (!next) {
        const fallback = fallbackTitleFromExchange(userText, assistantText)
        if (fallback && !isGenericFallbackTitle(fallback)) { next = fallback; source = 'fallback' }
      }
      const fallbackReason = source === 'fallback' && llmStatus ? `local_summary:${llmStatus}` : 'local_summary'
      let current: Session = s
      try { current = this.deps.store.get(sessionId) } catch { current = s }
      let effective = str(current.title).trim()
      let wrote = false
      if (next) {
        const stillAuto = effective === placeholder || ['Untitled', 'New Chat', ''].includes(effective) || effective === titleFrom(current.messages, '') || looksInvalidGeneratedTitle(current.title)
        if (current.manual_title || !stillAuto) { status('skipped', 'manual_title', effective); return }
        if (next !== effective) {
          current.title = next
          markSessionTitleGenerated(current)
          this.deps.store.save(current, { touchUpdatedAt: false })
          // Python `sync_session_title` after generation: the state.db row follows when `sync_to_insights` is on.
          await this.deps.syncTitle?.(current)
          this.deps.events.publish('title', { profile: current.profile, sessionId })
          effective = next
          wrote = true
        }
      }
      if (wrote) {
        status(source, source === 'fallback' ? fallbackReason : llmStatus, effective, rawPreview)
        put('title', { session_id: sessionId, title: effective })
      } else status('skipped', source || 'unchanged', effective, rawPreview)
    } finally {
      put('stream_end', { session_id: sessionId })
    }
  }

  // ── cancel / steer ───────────────────────────────────────────────────────

  /** Python `cancel_stream`: persist the partial, mark cancelled, interrupt the Agent, release admission. */
  async cancel(streamId: string): Promise<boolean> {
    const channel = this.registry.peek(streamId)
    const run = this.registry.activeRuns.get(streamId)
    if (!channel && !run) return false
    // Python popped the run before its title work: a cancel that lands after `done` (while the title prompts still run)
    // is not a cancellation, so it neither journals a `cancel` frame nor marks the completed run interrupted.
    if (!run && this.settledStreams.has(streamId)) return false
    const sessionId = this.registry.ownerSessionId(streamId) ?? run?.session_id ?? null
    this.registry.cancelled.add(streamId)
    if (run) { run.phase = 'cancelling'; run.cancelled_at = this.deps.now() }
    // Python `_finalize_webui_steers` drained the Agent's pending steer text at cancel time: the interrupt reply
    // carries it so queued steers settle as consumed / leftover before the terminal row.
    let leftover = ''
    const sidecar = this.deps.sidecar()
    if (sidecar) {
      try { leftover = str((await sidecar.call('chat.interrupt', { stream_id: streamId }, { timeoutMs: 5_000 })).pending_steer) } catch { leftover = '' }
    }
    // Settle the steers first so the persisted cancel carries every consumed one.
    const steerEvents = (this.steers.get(streamId) ?? []).length ? this.finalizeSteerEvents(streamId, leftover) : []
    if (sessionId) {
      let current: Session | null = null
      try { current = this.deps.store.get(sessionId) } catch { current = null }
      if (current?.active_stream_id === streamId) {
        this.finalizeCancelled(current, streamId, 'Task cancelled.', run?.ephemeral)
      }
    }
    // The worker may already have written its terminal row while the interrupt was in flight; the stream is then
    // gone from the registry and this path must not add a second one.
    if (channel && this.registry.streams.has(streamId)) {
      const writer = this.writers.get(streamId) ?? null
      const emit = (event: string, data: Record<string, unknown>): void => {
        let eventId: string | null = null
        if (writer) { try { eventId = writer.appendSseEvent(event, data).event_id } catch { eventId = null } }
        channel.put([event, data, eventId])
      }
      for (const [event, data] of steerEvents) emit(event, data)
      emit('cancel', sessionId ? this.cancelFrame(sessionId) : this.cancelPayload())
      this.registry.streams.delete(streamId)
      this.registry.liveIds.delete(streamId)
    }
    this.abortControllers.get(streamId)?.abort()
    return true
  }

  async steer(sessionId: string, text: string, displayText: string, steerId: string): Promise<Record<string, unknown>> {
    let s: Session | null = null
    try { s = this.deps.store.get(sessionId, { metadataOnly: true }) } catch { s = null }
    const activeStreamId = s?.active_stream_id ?? null
    // Python: an unknown session has no live worker and no cached agent, so the lookup order yields `no_cached_agent`
    // (200) before `session_not_found` is ever reachable. A known idle session keeps its cached agent → `not_running`.
    if (!s) return { accepted: false, fallback: 'no_cached_agent', stream_id: null }
    if (!activeStreamId) return { accepted: false, fallback: 'not_running', stream_id: null }
    if (!this.registry.liveIds.has(activeStreamId)) return { accepted: false, fallback: 'stream_dead', stream_id: null }
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { accepted: false, fallback: 'no_cached_agent', stream_id: null }
    // Register provisionally before the RPC: the Agent may apply the steer and finish the turn before the steer
    // reply arrives, and the turn's finalisation must then already see the record. A rejection removes it again.
    const record: SteerRecord = { steer_id: steerId, session_id: sessionId, stream_id: activeStreamId, text, display_text: displayText || text, created_at: this.deps.now() }
    const records = this.steers.get(activeStreamId) ?? []
    records.push(record)
    this.steers.set(activeStreamId, records)
    const withdraw = (): void => {
      const current = this.steers.get(activeStreamId)
      if (!current) return
      const index = current.indexOf(record)
      if (index >= 0) current.splice(index, 1)
      if (!current.length) this.steers.delete(activeStreamId)
    }
    let result: { accepted: boolean; fallback?: string | null | undefined }
    try {
      result = await sidecar.call('chat.steer', { stream_id: activeStreamId, text })
    } catch {
      withdraw()
      return { accepted: false, fallback: 'steer_error', stream_id: activeStreamId }
    }
    // An accepted steer whose turn finalised while the reply was in flight was already reported by that finalisation.
    if (!result.accepted) withdraw()
    return { accepted: result.accepted, fallback: result.accepted ? null : (result.fallback ?? 'not_running'), stream_id: activeStreamId, steer_id: steerId }
  }

  /** Python `_webui_steer_events_before` for terminal frames: cancel/apperror flush consumed steers and leftovers first. */
  private takeSteerEventsBefore(streamId: string, event: string): [string, Record<string, unknown>][] {
    if (event !== 'cancel' && event !== 'apperror') return []
    if (!(this.steers.get(streamId) ?? []).length) return []
    return this.finalizeSteerEvents(streamId, '')
  }

  /** Python `_pending_webui_steer_suffix_start`: the pending text is the newline-joined tail of the records; earlier ones are consumed. */
  private static pendingSteerSuffixStart(records: SteerRecord[], pendingText: string): number | null {
    if (!pendingText) return records.length
    for (let start = 0; start <= records.length; start += 1) {
      const suffix = records.slice(start).map((r) => r.text).join('\n')
      if (suffix && (pendingText === suffix || pendingText.endsWith(`\n${suffix}`))) return start
    }
    return null
  }

  private consumedSteerPayload(record: SteerRecord): Record<string, unknown> {
    const consumedAt = this.deps.now()
    const afterToolCallId = this.lastCompletedTool.get(record.stream_id) ?? null
    const consumed = this.consumedSteers.get(record.stream_id) ?? []
    if (!consumed.some((c) => c.steer_id === record.steer_id)) {
      consumed.push({ steer_id: record.steer_id, text: record.display_text || record.text, agent_text: record.text, submitted_at: record.created_at, consumed_at: consumedAt, after_tool_call_id: afterToolCallId })
      this.consumedSteers.set(record.stream_id, consumed)
    }
    return { ...record, agent_text: record.text, text: record.display_text || record.text, consumed_at: consumedAt, after_tool_call_id: afterToolCallId }
  }

  /**
   * Consumed steers become display-only `_steer` user rows at their causal place in the turn: after the tool results of
   * the call that had completed when the Agent took them (else right after the turn's prompt), in consumption order,
   * each with the phase it ended. Returns where the last phase starts. Replaces the turn's earlier placement, so the
   * mid-turn save and the terminal one agree. Leftover steers are not persisted.
   */
  private placeConsumedSteers(s: Session, streamId: string, startedAt: number | null): number | null {
    const steers = this.consumedSteers.get(streamId) ?? []
    if (!steers.length) return null
    s.messages = s.messages.filter((m) => !(m._steer && m._turn_id === streamId))
    let boundary = typeof startedAt === 'number' && startedAt > 0 ? startedAt : steers[0]!.submitted_at
    for (const steer of steers) {
      const row: Message = {
        role: 'user', content: steer.text, timestamp: steer.consumed_at, _turn_id: streamId,
        _steer: { steer_id: steer.steer_id, submitted_at: steer.submitted_at, consumed_at: steer.consumed_at, phase_duration: roundDuration(steer.consumed_at - boundary) },
      }
      // An Agent that records the steer it delivered does so at its exact place: that row becomes the steer, not a copy.
      const agentRows = s.messages.flatMap((m, i) => (m._turn_id === streamId && agentSteerText(m) !== null ? [i] : []))
      const agentRow = agentRows.find((i) => agentSteerText(s.messages[i]!) === steer.agent_text.trim()) ?? agentRows[0]
      if (agentRow === undefined) s.messages.splice(steerInsertIndex(s.messages, streamId, steer.after_tool_call_id), 0, row)
      else s.messages[agentRow] = row
      boundary = steer.consumed_at
    }
    return boundary
  }

  /** A steer is saved as it enters the stream, so a reload mid-turn already has it; the terminal save re-places it. */
  private saveConsumedSteers(sessionId: string, streamId: string): void {
    let s: Session
    try { s = this.deps.store.get(sessionId) } catch { return }
    if (s.active_stream_id !== streamId || this.placeConsumedSteers(s, streamId, s.pending_started_at) === null) return
    try { this.deps.store.save(s, { touchUpdatedAt: false }) } catch (error) {
      this.deps.log(`[webui] WARNING: failed to save consumed steer for ${sessionId}: ${(error as Error).message}`)
    }
  }

  /** Terminal placement: the turn's rows are final now, and its last reply carries the final phase. */
  private persistConsumedSteers(s: Session, streamId: string, startedAt: number | null, endedAt: number): void {
    const boundary = this.placeConsumedSteers(s, streamId, startedAt)
    this.consumedSteers.delete(streamId)
    if (boundary === null) return
    const last = s.messages.findLast((m) => m.role === 'assistant' && m._turn_id === streamId)
    if (last) last._final_phase_duration = roundDuration(endedAt - boundary)
  }

  /**
   * Python `_take_consumed_webui_steers` (live, `keepLeftovers`) and `_finalize_webui_steers` (terminal): records the
   * Agent no longer holds pending are consumed; at the end the still-pending tail is reported as leftovers.
   */
  private takeConsumedSteers(streamId: string, pendingText: string, opts: { keepLeftovers?: boolean } = {}): Record<string, unknown>[] {
    const records = this.steers.get(streamId) ?? []
    const start = TurnRunner.pendingSteerSuffixStart(records, pendingText)
    if (opts.keepLeftovers) {
      if (start === null || start <= 0) return []
      const consumed = records.splice(0, start)
      return consumed.map((r) => this.consumedSteerPayload(r))
    }
    this.steers.delete(streamId)
    if (start === null) return []
    return records.slice(0, start).map((r) => this.consumedSteerPayload(r))
  }

  /** Terminal steer bookkeeping for cancel/error paths: consumed records first, then `pending_steer_leftover` for the rest. */
  private finalizeSteerEvents(streamId: string, leftoverText: string): [string, Record<string, unknown>][] {
    const records = this.steers.get(streamId) ?? []
    this.steers.delete(streamId)
    const start = TurnRunner.pendingSteerSuffixStart(records, leftoverText)
    if (start === null) return leftoverText ? [['pending_steer_leftover', { stream_id: streamId, text: leftoverText }]] : []
    const events: [string, Record<string, unknown>][] = records.slice(0, start).map((r) => ['steer_consumed', this.consumedSteerPayload(r)])
    const leftovers = records.slice(start)
    for (const r of leftovers) events.push(['pending_steer_leftover', { ...r, leftover_at: this.deps.now() }])
    const matched = leftovers.map((r) => r.text).join('\n')
    const unmatched = matched ? leftoverText.slice(0, leftoverText.length - matched.length).replace(/\n+$/, '') : leftoverText
    if (unmatched) events.push(['pending_steer_leftover', { stream_id: streamId, text: unmatched }])
    return events
  }

  // ── approvals / clarify ──────────────────────────────────────────────────

  async respondApproval(sessionId: string, choice: string, approvalId: string, enableYolo: boolean): Promise<Record<string, unknown>> {
    // Python `_enable_session_yolo_and_release_pending`: a stale card id while another approval is parked
    // must not commit YOLO for the whole session — fail closed with the relay envelope instead.
    if (enableYolo && approvalId && !this.deps.pending.hasApprovalId(sessionId, approvalId) && this.deps.pending.hasPendingApproval(sessionId)) {
      return { ok: false, choice, relayed: false, code: 'gateway_run_unavailable', error: GATEWAY_APPROVAL_RELAY_UNAVAILABLE, yolo_enabled: this.deps.service().yolo(sessionId).yolo_enabled === true, _status: 409 }
    }
    // The mirrored prompt stays queued until the sidecar acknowledges the answer: a relay failure leaves it
    // answerable (503) instead of hiding a prompt the Agent is still blocked on.
    const { entry, found } = this.deps.pending.peekApproval(sessionId, approvalId)
    const sidecar = this.deps.sidecar()
    const relayFailure = (message: string): Record<string, unknown> => ({ ok: false, choice, error: `The Agent sidecar did not accept the approval (${message}); retry in a moment.`, _status: 503 })
    let s: Session | null = null
    try { s = this.deps.store.get(sessionId, { metadataOnly: true }) } catch { s = null }
    const profileHome = this.deps.profileHome(s?.profile ?? null)
    let resolved = false
    if (entry) {
      if (!sidecar) return relayFailure('not running')
      try {
        const result = await sidecar.call('approval.respond', { profile_home: profileHome, session_id: sessionId, choice: choice as 'once' | 'session' | 'always' | 'deny', request_id: entry ? str(entry.request_id) || null : null })
        resolved = result.ok
      } catch (error) {
        this.deps.log(`[webui] approval relay failed for ${sessionId}: ${(error as Error).message}`)
        return relayFailure(str((error as Error).message))
      }
      if (resolved && entry) this.deps.pending.resolveApproval(sessionId, str(entry.approval_id))
    }
    let yoloEnabled: boolean | undefined
    if (enableYolo) {
      // The local flag is authoritative (it is re-pushed to the sidecar at every turn start); a running sidecar must
      // still confirm now so parked Agent waiters are released before YOLO is reported as on.
      const failure = await this.withYoloLock(sessionId, async (): Promise<Record<string, unknown> | null> => {
        if (sidecar) { try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: true }) } catch (error) { return relayFailure(str((error as Error).message)) } }
        this.deps.service().setYolo(sessionId, true)
        return null
      })
      if (failure) return failure
      yoloEnabled = true
      this.deps.pending.clearApprovals(sessionId)
    }
    if (!found && !this.deps.pending.hasPendingApproval(sessionId)) return { ok: true, choice, stale_cleared: true, ...(enableYolo ? { yolo_enabled: yoloEnabled } : {}) }
    return { ok: resolved || !approvalId, choice, ...(enableYolo && (resolved || !approvalId) ? { yolo_enabled: yoloEnabled } : {}) }
  }

  private withYoloLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.yoloChains.get(sessionId) ?? Promise.resolve()).then(fn)
    const settled = run.catch(() => undefined).then(() => { if (this.yoloChains.get(sessionId) === settled) this.yoloChains.delete(sessionId) })
    this.yoloChains.set(sessionId, settled)
    return run
  }

  /** Python `set_session_yolo_enabled(False)`: the sidecar must drop its per-session YOLO state before the local flag clears. */
  disableYolo(sessionId: string): Promise<Record<string, unknown>> {
    return this.withYoloLock(sessionId, async () => {
      const sidecar = this.deps.sidecar()
      if (sidecar) {
        try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: false }) } catch (error) {
          return { ok: false, error: `The Agent sidecar did not disable YOLO (${str((error as Error).message)}); retry in a moment.`, yolo_enabled: this.deps.service().yolo(sessionId).yolo_enabled === true, _status: 503 }
        }
      }
      return this.deps.service().setYolo(sessionId, false)
    })
  }

  /** `stale` when no such prompt is queued; `ok:false` without `stale` when the sidecar did not acknowledge (prompt retained). */
  async respondClarify(sessionId: string, clarifyId: string, response: string): Promise<{ ok: boolean; stale?: boolean; error?: string }> {
    const entry = this.deps.pending.peekClarify(sessionId, clarifyId)
    if (!entry) return { ok: false, stale: true }
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { ok: false, error: 'The Agent sidecar is not running; retry in a moment.' }
    let ok = false
    try {
      ok = (await sidecar.call('clarify.respond', { session_id: sessionId, clarify_id: str(entry.clarify_id), response })).ok
    } catch (error) {
      return { ok: false, error: `The Agent sidecar did not accept the answer (${str((error as Error).message)}); retry in a moment.` }
    }
    if (!ok) return { ok: false, stale: true }
    const { head } = this.deps.pending.resolveClarify(sessionId, str(entry.clarify_id))
    if (head) this.emitToSession(sessionId, 'clarify', head)
    return { ok: true }
  }
}

function previousStartedAt(s: Session, run: { started_at: number } | undefined): number {
  return typeof s.pending_started_at === 'number' && s.pending_started_at > 0 ? s.pending_started_at : (run?.started_at ?? Date.now() / 1000)
}

function dedupeContext(messages: Message[]): Message[] {
  const out: Message[] = []
  let lastKey: string | null = null
  for (const m of messages) {
    const key = messageIdentity(m)
    if (key !== null && key === lastKey && m.role === 'assistant') continue
    out.push(m)
    lastKey = key
  }
  return out
}


export { HttpFailure }

/** Where a consumed steer goes: past the tool results of the call it followed, else past the turn's prompt. */
function roundDuration(seconds: number): number {
  return Math.round(Math.max(0, seconds) * 1000) / 1000
}

function steerInsertIndex(messages: Message[], turnId: string, afterToolCallId: string | null): number {
  // OpenAI-style `tool_calls` and Anthropic-style `tool_use` content blocks both name the call a steer followed.
  const callIds = (m: Message) => [
    ...(Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => str((tc as Record<string, unknown>).id) || str((tc as Record<string, unknown>).call_id) || str((tc as Record<string, unknown>).tool_call_id)),
    ...(Array.isArray(m.content) ? m.content : []).flatMap((part) => (isDict(part) && part.type === 'tool_use' ? [str(part.id)] : [])),
  ]
  // The steer followed that call's result: right after its row (a `tool` row, or a user row of `tool_result` blocks), even
  // when the same assistant message made later calls; steers already placed there keep their consumption order.
  const answers = (m: Message) => (m.role === 'tool' && (str(m.tool_call_id) || str(m.tool_use_id)) === afterToolCallId)
    || (m.role === 'user' && Array.isArray(m.content) && m.content.some((part) => isDict(part) && part.type === 'tool_result' && str(part.tool_use_id) === afterToolCallId))
  const result = afterToolCallId ? messages.findIndex((m) => m._turn_id === turnId && answers(m)) : -1
  if (result !== -1) {
    let i = result + 1
    while (i < messages.length && messages[i]!._turn_id === turnId && messages[i]!._steer) i += 1
    return i
  }
  let at = afterToolCallId ? messages.findIndex((m) => m._turn_id === turnId && m.role === 'assistant' && callIds(m).includes(afterToolCallId)) : -1
  if (at === -1) at = messages.findIndex((m) => m._turn_id === turnId && m.role === 'user' && !m._steer)
  if (at === -1) return messages.length
  let i = at + 1
  while (i < messages.length && messages[i]!._turn_id === turnId && (messages[i]!.role === 'tool' || messages[i]!._steer)) i += 1
  return i
}
