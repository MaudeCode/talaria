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
import { resolvePathLikePython } from '../workspace/paths.js'
import type { SidecarLike } from '../sidecar/client.js'
import { SidecarError } from '../sidecar/client.js'
import type { SessionStore } from './store.js'
import type { SessionService } from './service.js'
import { HttpFailure } from './service.js'
import type { SessionEventBus } from './events.js'
import { StreamRegistry, SessionChannels, type StreamChannel } from './streams.js'
import { PendingPrompts } from './pending.js'
import { RunJournal, type RunJournalWriter } from './journal.js'
import { Session, titleFrom, type Message } from './session.js'
import { buildActiveTurnToken, redactSessionData, redactString } from '../redact.js'
import { buildPartialMessage, extractToolCallsFromMessages, isDict, mergeDisplayMessagesAfterAgentResult, messageIdentity, messageText, splitThinkingFromContent, stripXmlToolCalls, workspaceContextPrefix } from './merge.js'
import { fallbackTitleFromExchange, firstExchangeSnippets, isGenericFallbackTitle, latestExchangeSnippets, looksInvalidGeneratedTitle, sanitizeGeneratedTitle, titlePrompts } from './titles.js'
import type { WorkspaceRegistry } from '../workspace/workspaces.js'
import { str } from '../util.js'

export const CHAT_LOCK_WAIT_SECONDS = 2
const IMAGE_MODE_TIMEOUT_MS = 15_000
const TERMINAL_SSE_VISIBLE_MESSAGE_LIMIT = 80
const WEBUI_PROGRESS_PROMPT = `WebUI progress guidance:
- Match the normal Hermes messaging style, but do not let long tool-running WebUI turns appear silent.
- For long multi-step work that uses tools, emit brief user-visible progress updates as normal assistant content, not only as hidden reasoning.
- Before the first tool batch in a long task, say what you are about to inspect.
- After each meaningful batch of tool calls, say what you just confirmed and what you will check next before continuing with more tools.
- Do not run many independent tool batches back-to-back without visible assistant text between them when the task is still ongoing.
- Do not keep progress only in reasoning, thinking, or tool-result channels; those are not a substitute for visible interim updates.
- Each update should say what you are about to check, what you just confirmed, or why the next tool call is needed.
- Keep updates concise, factual, and in the user's language. One or two short sentences are enough.
- Do not reveal hidden reasoning, chain-of-thought, private scratchpads, secrets, raw logs, or long tool output.
- Password, API-key, token, and secret fields are automatically redacted by the system. Treat masked values as intentional redaction, not placeholder text or user input errors, and do not tell the user a stored credential is wrong based on a masked value alone.
- Final visible assistant replies must be clear, user-facing, and in the user's language, not private planning notes.
- Do not include terse planning fragments or scratchpad shorthand in visible assistant text. Avoid fragments like "Need script", "Need check logs", "Need inspect email", or "maybe invite"; either omit them or rewrite them as clear user-facing progress.
- For direct answers or very short tasks, skip progress updates and answer normally.`

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
  /** Runs after the run is retired (Python teardown idle hook: deferred process wakeups). */
  onTurnEnd?: (sessionId: string) => void
}

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
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

export class TurnRunner {
  readonly writers = new Map<string, RunJournalWriter>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly steers = new Map<string, Record<string, unknown>[]>()

  constructor(readonly deps: TurnRunnerDeps) {}

  private get registry(): StreamRegistry { return this.deps.registry }

  // ── admission ────────────────────────────────────────────────────────────

  /** Python `_start_chat_stream_for_session`: persist pending state, register the channel, launch the worker. */
  start(session: Session, opts: StartTurnOptions): StartTurnResponse & { _status?: number; error?: string; active_stream_id?: string | null } {
    const s = session
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
    if (this.deps.saveMode() === 'eager') this.checkpointUserMessage(s, opts.msg, attachments, s.pending_started_at, source)
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
    const response: StartTurnResponse = { stream_id: streamId, session_id: s.session_id, pending_started_at: s.pending_started_at, turn_id: null, title: s.title }
    if (opts.normalizedModel && opts.model) response.effective_model = opts.model
    if (opts.modelProvider) response.effective_model_provider = opts.modelProvider
    return response
  }

  /** Python `_checkpoint_user_message_for_eager_session_save`. */
  private checkpointUserMessage(s: Session, msg: string, attachments: Record<string, unknown>[], startedAt: number | null, source: string): void {
    const latest = s.messages[s.messages.length - 1]
    if (latest?.role === 'user' && messageText(latest.content).split(/\s+/).join(' ') === msg.split(/\s+/).join(' ')) return
    const user: Message = { role: 'user', content: msg }
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
    const previousContext = structuredClone(s.context_messages.length ? s.context_messages : s.messages.filter((m) => !m._error && !m._partial))
    const activeTurnToken = buildActiveTurnToken(streamId, s.pending_started_at)
    const sidecar = deps.sidecar()
    const partialText = this.registry.partialText.get(streamId) ?? []
    const reasoningText = this.registry.reasoningText.get(streamId) ?? []
    const liveToolCalls = this.registry.liveToolCalls.get(streamId) ?? []
    let tokenSent = false
    let capturedTerminalError: string | null = null
    const controller = new AbortController()
    this.abortControllers.set(streamId, controller)
    const workspaceCtx = workspaceContextPrefix(opts.workspace)
    const userMessage = await this.buildUserMessage(workspaceCtx, msgText, opts.attachments ?? [], opts.workspace, sessionId, s, opts, controller.signal)
    if (activeRun) activeRun.phase = 'running'
    const settledAt = { value: false }
    try {
      if (!sidecar) throw new SidecarError('The Agent sidecar is not running; chat is unavailable until it starts.', { condition: 'sidecar_unavailable' })
      if (this.registry.cancelled.has(streamId)) {
        this.finalizeCancelled(s, streamId, 'Task cancelled before start.', opts.ephemeral)
        put('cancel', this.cancelPayload('Cancelled before start'))
        return
      }
      const result = await sidecar.call('chat.start', {
        profile_home: deps.profileHome(s.profile), session_id: sessionId, stream_id: streamId, workspace: opts.workspace, model: opts.model ?? '', model_provider: opts.modelProvider,
        user_message: userMessage, system_message: WEBUI_PROGRESS_PROMPT, conversation_history: previousContext, enabled_toolsets: deps.toolsetsFor(s),
      }, {
        signal: controller.signal,
        timeoutMs: 0,
        onStream: (frame) => {
          const data = isDict(frame.data) ? frame.data : {}
          switch (frame.event) {
            case 'token':
              tokenSent = true
              partialText.push(str(data.text))
              put('token', { text: str(data.text) })
              return
            case 'reasoning':
              reasoningText.push(str(data.text))
              put('reasoning', { text: str(data.text) })
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
              put('tool_complete', data)
              return
            case 'approval': {
              const entry = deps.pending.submitApproval(sessionId, { ...data, session_id: sessionId })
              put('approval', { ...entry, pending_count: deps.pending.approvalPending(sessionId).pending_count })
              return
            }
            case 'clarify': {
              const entry = deps.pending.submitClarify(sessionId, { ...data, session_id: sessionId, kind: 'clarify' })
              put('clarify', { ...entry, pending_count: deps.pending.clarifyPending(sessionId).pending_count })
              return
            }
            case 'clarify_resolved':
              deps.pending.resolveClarify(sessionId, str(data.clarify_id))
              return
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
        put('stream_end', { session_id: sessionId })
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
      const resultMessages = result.messages as Message[]
      const assistantAdded = resultMessages.some((m) => m.role === 'assistant' && messageText(m.content).trim()) || Boolean(result.final_response.trim())
      const lastErr = result.error ?? capturedTerminalError ?? ''
      // Python `_turn_transcript_lacks_final_assistant_answer`: a partial result with no final answer is a silent failure even if tokens streamed.
      const stalePartial = result.result_status === 'partial' && !assistantAdded
      if (result.status === 'error' || (!assistantAdded && !tokenSent) || stalePartial) {
        const classification = classifyProviderError(lastErr, { silentFailure: !lastErr })
        const errStr = lastErr || `${classification.label}.`
        const payload = providerErrorPayload(errStr, classification.type, classification.hint, deps.redactEnabled())
        this.persistError(s, streamId, classification.label, payload, activeTurnToken)
        payload.session = redactSessionData(this.terminalSessionPayload(s), deps.redactEnabled())
        payload.session_id = s.session_id
        payload.old_session_id = sessionId
        put('apperror', payload)
        return
      }
      // ── settle the transcript ──
      s.messages = mergeDisplayMessagesAfterAgentResult(previousMessages, previousContext, resultMessages, msgText, { source: opts.source ?? 'webui', activeTurnToken, now: deps.now() })
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
          break
        }
      }
      deps.store.save(s)
      deps.pending.clearApprovals(sessionId)
      deps.pending.clearClarifies(sessionId)
      deps.events.publish('session_done', { profile: s.profile, sessionId: s.session_id })
      const donePayload: Record<string, unknown> = {
        session: redactSessionData(this.terminalSessionPayload(s), deps.redactEnabled()),
        usage: { input_tokens: s.input_tokens, output_tokens: s.output_tokens, estimated_cost: s.estimated_cost, cache_read_tokens: s.cache_read_tokens, cache_write_tokens: s.cache_write_tokens, context_length: s.context_length ?? 0, threshold_tokens: s.threshold_tokens ?? 0, last_prompt_tokens: s.last_prompt_tokens ?? 0 },
      }
      if (result.tool_limit_reached) {
        donePayload.terminal_state = 'tool_limit_reached'
        donePayload.terminal_reason = 'max_iterations'
      }
      put('done', donePayload)
      for (const record of this.takeConsumedSteers(streamId, result.pending_steer)) put('steer_consumed', record)
      await this.backgroundTitle(s, put)
      if (opts.onDone) opts.onDone(result.final_response)
    } catch (error) {
      if (settledAt.value && !(error instanceof SidecarError)) {
        deps.log(`[webui] ERROR settling turn ${streamId}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      }
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
    try {
      // A cancelled turn must not sit behind this lookup: the abort wins the race and `run()` then takes the cancelled path.
      const lookup = sidecar.call('text.image_mode', { profile_home: this.deps.profileHome(s.profile), provider: str(opts.modelProvider ?? s.model_provider), model: str(opts.model ?? s.model) }, { signal, timeoutMs: IMAGE_MODE_TIMEOUT_MS })
      const mode = await Promise.race([lookup, new Promise<never>((_, reject) => { signal.addEventListener('abort', () => { reject(new Error('turn cancelled')) }, { once: true }) })])
      if (mode.mode !== 'native') return text
    } catch (error) {
      if (!signal.aborted) this.deps.log(`[webui] image mode lookup failed for ${sessionId}: ${(error as Error).message}`)
      return text
    }
    const parts: Record<string, unknown>[] = [{ type: 'text', text }]
    let images = 0
    const roots = [workspace, this.deps.attachmentDir(sessionId)].map((r) => resolvePathLikePython(r))
    for (const att of candidates) {
      const target = resolvePathLikePython(str(att.path).trim())
      const root = roots.find((r) => target === r || target.startsWith(`${r}/`))
      if (!root) continue
      let fd: number
      try { fd = openAnchoredFd(root, target, { wantDir: false }) } catch { continue }
      try {
        const size = fstatSync(fd).size
        if (size <= 0 || size > 20 * 1024 * 1024) continue
        const bytes = readFileSync(fd)
        const sniffed = sniffImageMime(bytes)
        if (!sniffed) continue
        parts.push({ type: 'image_url', image_url: { url: `data:${sniffed};base64,${bytes.toString('base64')}` } })
        images += 1
      } catch { /* skip unreadable */ } finally { closeSync(fd) }
    }
    return images ? parts : text
  }

  private terminalSessionPayload(s: Session): Record<string, unknown> {
    const payload = s.compact({ includeRuntime: true, activeStreamIds: this.registry.liveIds })
    const total = s.messages.length
    const offset = Math.max(0, total - TERMINAL_SSE_VISIBLE_MESSAGE_LIMIT)
    payload.messages = s.messages.slice(offset)
    payload.tool_calls = s.tool_calls
    payload._messages_truncated = offset > 0
    payload._messages_offset = offset
    return payload
  }

  /** Python `_materialize_pending_user_turn_before_error` + error message append + save. */
  private persistError(s: Session, streamId: string, label: string, payload: Record<string, unknown>, activeTurnToken: string | null): void {
    const startedAt = s.pending_started_at
    this.materializePendingUserTurn(s, activeTurnToken)
    const duration = typeof startedAt === 'number' && startedAt > 0 ? Math.max(0, this.deps.now() - startedAt) : null
    s.active_stream_id = null
    s.pending_user_message = null
    s.pending_attachments = []
    s.pending_started_at = null
    s.pending_user_source = null
    this.appendPartialSnapshot(s, streamId)
    const hint = str(payload.hint)
    const errorMessage: Message = { role: 'assistant', content: `**${label}:** ${str(payload.message) || label}${hint ? `\n\n*${hint}*` : ''}`, timestamp: Math.trunc(this.deps.now()), _error: true }
    if (duration !== null) errorMessage._turnDuration = Math.round(duration * 1000) / 1000
    if (payload.details) errorMessage.provider_details = payload.details
    if (payload.type === 'cancelled') errorMessage.provider_details_label = 'Cancellation details'
    else if (payload.type === 'interrupted') errorMessage.provider_details_label = 'Interruption details'
    s.messages.push(errorMessage)
    try { this.deps.store.save(s) } catch (error) { this.deps.log(`[webui] WARNING: failed to save error turn for ${s.session_id}: ${(error as Error).message}`) }
    this.deps.pending.clearApprovals(s.session_id)
    this.deps.pending.clearClarifies(s.session_id)
    this.deps.events.publish('session_error', { profile: s.profile, sessionId: s.session_id })
  }

  private materializePendingUserTurn(s: Session, activeTurnToken: string | null): boolean {
    const pendingText = str(s.pending_user_message)
    if (!pendingText) return false
    const recoveredTs = typeof s.pending_started_at === 'number' && s.pending_started_at > 0 ? s.pending_started_at : this.deps.now()
    const source = s.pending_user_source ?? 'webui'
    const attachments = [...s.pending_attachments]
    if (activeTurnToken) {
      for (let i = s.messages.length - 1; i >= 0; i -= 1) {
        const m = s.messages[i]!
        if (m.role === 'user' && m._active_turn_token === activeTurnToken) {
          if (!s.messages.slice(i + 1).some((later) => later.role === 'user')) return false
          break
        }
      }
    }
    const last = s.messages[s.messages.length - 1]
    // Python `_synthesize_user_message_on_cancel`: a worker that already merged this prompt (same text, not older than the pending start) wins.
    if (last?.role === 'user' && messageText(last.content).trim() === pendingText.trim() && Math.trunc(Number(last.timestamp)) >= Math.trunc(recoveredTs)) return false
    const recovered: Message = { role: 'user', content: pendingText, timestamp: recoveredTs, _recovered: true }
    if (source !== 'webui') recovered._source = source
    if (attachments.length) recovered.attachments = attachments
    s.messages.push(recovered)
    if (s.context_messages.length) s.context_messages.push({ ...recovered })
    return true
  }

  private appendPartialSnapshot(s: Session, streamId: string): void {
    const partial = buildPartialMessage((this.registry.partialText.get(streamId) ?? []).join(''), (this.registry.reasoningText.get(streamId) ?? []).join(''), this.registry.liveToolCalls.get(streamId) ?? [], this.deps.now())
    if (!partial) return
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
    this.materializePendingUserTurn(current, buildActiveTurnToken(streamId, current.pending_started_at))
    current.active_stream_id = null
    current.pending_user_message = null
    current.pending_attachments = []
    current.pending_started_at = null
    current.pending_user_source = null
    this.appendPartialSnapshot(current, streamId)
    const text = message.trim().endsWith('.') ? message.trim() : `${message.trim()}.`
    current.messages.push({ role: 'assistant', content: `**Task cancelled:** ${text}\n\n*${cancelledTurnHint(this.deps.agentName())}*`, _error: true, provider_details: text, provider_details_label: 'Cancellation details', timestamp: Math.trunc(this.deps.now()) })
    try { this.deps.store.save(current) } catch { return false }
    this.deps.pending.clearApprovals(current.session_id)
    this.deps.pending.clearClarifies(current.session_id)
    this.deps.events.publish('session_cancel', { profile: current.profile, sessionId: current.session_id })
    return true
  }

  private teardown(sessionId: string, streamId: string): void {
    const writer = this.writers.get(streamId)
    if (writer) { try { writer.close() } catch { /* ignore */ } this.writers.delete(streamId) }
    this.abortControllers.delete(streamId)
    this.steers.delete(streamId)
    this.registry.retire(streamId, this.deps.now())
    this.registry.forgetOwner(streamId)
    this.registry.clearWritebackOwnerIfOwned(sessionId, streamId)
    this.deps.pending.clearApprovals(sessionId)
    this.deps.pending.clearClarifies(sessionId)
    try { this.deps.onTurnEnd?.(sessionId) } catch { /* best effort */ }
  }

  /** Journal files with a live writer (retention must leave them alone). */
  activeJournalPaths(): Set<string> {
    return new Set([...this.writers.values()].map((w) => this.deps.journal.pathFor(w.sessionId, w.runId)))
  }

  // ── title ────────────────────────────────────────────────────────────────

  /** Python `generate_session_title_for_session`: on-demand title from the persisted transcript; never touches `llm_title_generated`. */
  async generateTitle(s: Session, opts: { preferLatest?: boolean } = {}): Promise<{ title: string | null; status: string; rawPreview: string }> {
    const [userText, assistantText] = opts.preferLatest ? latestExchangeSnippets(s.messages) : firstExchangeSnippets(s.messages, { scanPastConsecutiveUsers: true })
    if (!userText) return { title: null, status: 'empty_user_message', rawPreview: '' }
    if (!this.deps.titleGenerationEnabled()) return { title: null, status: 'title_generation_disabled', rawPreview: '' }
    let next = ''
    let llmStatus = 'llm_error'
    let rawPreview = ''
    const sidecar = this.deps.sidecar()
    if (sidecar && assistantText) {
      const [qa, prompts] = titlePrompts(userText, assistantText)
      for (const prompt of prompts) {
        try {
          const result = await sidecar.call('aux.complete', { profile_home: this.deps.profileHome(s.profile), task: 'title_generation', messages: [{ role: 'system', content: prompt }, { role: 'user', content: qa }], max_tokens: 64 }, { timeoutMs: 15_000 })
          rawPreview = str(result.text)
          next = sanitizeGeneratedTitle(result.text)
          llmStatus = next ? 'ok' : 'llm_invalid'
          if (next) break
        } catch (error) {
          this.deps.log(`[webui] title generation failed for ${s.session_id}: ${(error as Error).message}`)
          llmStatus = 'llm_error'
          break
        }
      }
    } else if (!assistantText) llmStatus = 'empty_assistant_message'
    if (next) return { title: next, status: llmStatus, rawPreview }
    const fallback = fallbackTitleFromExchange(userText, assistantText)
    if (fallback && !isGenericFallbackTitle(fallback)) return { title: fallback, status: `local_summary:${llmStatus}`, rawPreview }
    return { title: null, status: llmStatus || 'empty_title', rawPreview }
  }

  private async backgroundTitle(s: Session, put: (event: string, data: Record<string, unknown>) => void): Promise<void> {
    const sessionId = s.session_id
    const placeholder = str(s.title).trim()
    const invalidExisting = looksInvalidGeneratedTitle(s.title)
    const eligible = ['Untitled', 'New Chat', ''].includes(placeholder) || placeholder === titleFrom(s.messages, '') || invalidExisting
    const [userText, assistantText] = firstExchangeSnippets(s.messages)
    const status = (status: string, reason: string, title = ''): void => { put('title_status', { session_id: sessionId, status, reason, title }) }
    try {
      if (!eligible || (s.llm_title_generated && !invalidExisting) || !userText || !assistantText) {
        if (userText && assistantText && s.llm_title_generated && !invalidExisting) status('skipped', 'already_generated', placeholder)
        return
      }
      if (s.manual_title) { status('skipped', 'manual_title', placeholder); return }
      if (!this.deps.titleGenerationEnabled()) { status('skipped', 'title_generation_disabled', placeholder); return }
      let next = ''
      let source = 'llm'
      const sidecar = this.deps.sidecar()
      if (sidecar) {
        const [qa, prompts] = titlePrompts(userText, assistantText)
        for (const prompt of prompts) {
          try {
            const result = await sidecar.call('aux.complete', { profile_home: this.deps.profileHome(s.profile), task: 'title_generation', messages: [{ role: 'system', content: prompt }, { role: 'user', content: qa }], max_tokens: 64 }, { timeoutMs: 15_000 })
            next = sanitizeGeneratedTitle(result.text)
            if (next) break
          } catch (error) {
            this.deps.log(`[webui] title generation failed for ${sessionId}: ${(error as Error).message}`)
            source = 'llm_error'
            break
          }
          source = 'llm_invalid'
        }
      } else source = 'llm_error'
      if (!next) {
        const fallback = fallbackTitleFromExchange(userText, assistantText)
        if (fallback && !isGenericFallbackTitle(fallback)) { next = fallback; source = 'fallback' }
      }
      let current: Session = s
      try { current = this.deps.store.get(sessionId) } catch { current = s }
      if (!next || current.manual_title) { status('skipped', next ? 'manual_title' : source, str(current.title)); return }
      if (next !== str(current.title).trim()) {
        current.title = next
        current.llm_title_generated = true
        this.deps.store.save(current, { touchUpdatedAt: false })
        this.deps.events.publish('title', { profile: current.profile, sessionId })
      }
      status(source, source === 'fallback' ? 'local_summary' : 'ok', next)
      put('title', { session_id: sessionId, title: next })
    } finally {
      put('stream_end', { session_id: sessionId })
    }
  }

  // ── cancel / steer ───────────────────────────────────────────────────────

  /** Python `cancel_stream`: persist the partial, mark cancelled, interrupt the Agent, release admission. */
  cancel(streamId: string): boolean {
    const channel = this.registry.peek(streamId)
    const run = this.registry.activeRuns.get(streamId)
    if (!channel && !run) return false
    const sessionId = this.registry.ownerSessionId(streamId) ?? run?.session_id ?? null
    this.registry.cancelled.add(streamId)
    if (run) { run.phase = 'cancelling'; run.cancelled_at = this.deps.now() }
    const sidecar = this.deps.sidecar()
    if (sidecar) sidecar.call('chat.interrupt', { stream_id: streamId }).catch(() => undefined)
    this.abortControllers.get(streamId)?.abort()
    if (sessionId) {
      let current: Session | null = null
      try { current = this.deps.store.get(sessionId) } catch { current = null }
      if (current?.active_stream_id === streamId) {
        this.finalizeCancelled(current, streamId, 'Task cancelled.', run?.ephemeral)
      }
    }
    if (channel) {
      const payload = sessionId ? this.cancelFrame(sessionId) : this.cancelPayload()
      let eventId: string | null = null
      const writer = this.writers.get(streamId)
      if (writer) { try { eventId = writer.appendSseEvent('cancel', payload).event_id } catch { eventId = null } }
      channel.put(['cancel', payload, eventId])
      this.registry.streams.delete(streamId)
      this.registry.liveIds.delete(streamId)
    }
    return true
  }

  async steer(sessionId: string, text: string, displayText: string, steerId: string): Promise<Record<string, unknown>> {
    let s: Session | null = null
    try { s = this.deps.store.get(sessionId, { metadataOnly: true }) } catch { s = null }
    const activeStreamId = s?.active_stream_id ?? null
    if (!s) return { accepted: false, fallback: 'session_not_found', stream_id: null }
    if (!activeStreamId) return { accepted: false, fallback: 'not_running', stream_id: null }
    if (!this.registry.liveIds.has(activeStreamId)) return { accepted: false, fallback: 'stream_dead', stream_id: null }
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { accepted: false, fallback: 'no_cached_agent', stream_id: null }
    let result: { accepted: boolean; fallback?: string | null | undefined }
    try {
      result = await sidecar.call('chat.steer', { stream_id: activeStreamId, text })
    } catch {
      return { accepted: false, fallback: 'steer_error', stream_id: activeStreamId }
    }
    if (result.accepted) {
      const records = this.steers.get(activeStreamId) ?? []
      records.push({ steer_id: steerId, session_id: sessionId, stream_id: activeStreamId, text, display_text: displayText || text, created_at: this.deps.now() })
      this.steers.set(activeStreamId, records)
    }
    return { accepted: result.accepted, fallback: result.accepted ? null : (result.fallback ?? 'not_running'), stream_id: activeStreamId, steer_id: steerId }
  }

  private takeSteerEventsBefore(streamId: string, event: string): [string, Record<string, unknown>][] {
    if (event !== 'done' && event !== 'cancel' && event !== 'apperror') return []
    return []
  }

  private takeConsumedSteers(streamId: string, leftover: string): Record<string, unknown>[] {
    const records = this.steers.get(streamId) ?? []
    this.steers.delete(streamId)
    const consumed: Record<string, unknown>[] = []
    for (const record of records) {
      const text = str(record.text)
      if (leftover.includes(text)) continue
      consumed.push({ session_id: record.session_id, steer_id: record.steer_id, text: record.display_text, consumed_at: this.deps.now() })
    }
    return consumed
  }

  // ── approvals / clarify ──────────────────────────────────────────────────

  async respondApproval(sessionId: string, choice: string, approvalId: string, enableYolo: boolean): Promise<Record<string, unknown>> {
    const { entry, found } = this.deps.pending.resolveApproval(sessionId, approvalId)
    const sidecar = this.deps.sidecar()
    let s: Session | null = null
    try { s = this.deps.store.get(sessionId, { metadataOnly: true }) } catch { s = null }
    const profileHome = this.deps.profileHome(s?.profile ?? null)
    let resolved = Boolean(entry)
    if (sidecar && (entry || !approvalId)) {
      try {
        const result = await sidecar.call('approval.respond', { profile_home: profileHome, session_id: sessionId, choice: choice as 'once' | 'session' | 'always' | 'deny', request_id: entry ? str(entry.request_id) || null : null })
        resolved = resolved || result.ok
      } catch (error) {
        this.deps.log(`[webui] approval relay failed for ${sessionId}: ${(error as Error).message}`)
      }
    }
    let yoloEnabled: boolean | undefined
    if (enableYolo) {
      this.deps.service().setYolo(sessionId, true)
      yoloEnabled = true
      if (sidecar) { try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: true }) } catch { /* best effort */ } }
      this.deps.pending.clearApprovals(sessionId)
    }
    if (!found && !this.deps.pending.hasPendingApproval(sessionId)) return { ok: true, choice, stale_cleared: true, ...(enableYolo ? { yolo_enabled: yoloEnabled } : {}) }
    return { ok: resolved || !approvalId, choice, ...(enableYolo && (resolved || !approvalId) ? { yolo_enabled: yoloEnabled } : {}) }
  }

  async respondClarify(sessionId: string, clarifyId: string, response: string): Promise<boolean> {
    const entry = this.deps.pending.resolveClarify(sessionId, clarifyId)
    if (!entry) return false
    const sidecar = this.deps.sidecar()
    if (!sidecar) return false
    try {
      const result = await sidecar.call('clarify.respond', { session_id: sessionId, clarify_id: str(entry.clarify_id), response })
      return result.ok
    } catch {
      return false
    }
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
