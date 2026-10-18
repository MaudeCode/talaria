/**
 * One agent turn: admission, pending-state persistence, the sidecar
 * `chat.start` call, live frame relay into the journal and stream channel,
 * transcript settlement, cancel, steer, approvals, and clarify answers
 * (Python `api/routes.py::_start_chat_stream_for_session`,
 * `api/streaming.py::_run_agent_streaming`, `cancel_stream`).
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, readFileSync } from 'node:fs'
import { openAnchoredFd } from '../workspace/fs.js'
import { isWithin, resolvePathLikePython } from '../workspace/paths.js'
import type { SidecarLike } from '../sidecar/client.js'
import { runtimeFailureDetails, SidecarError } from '../sidecar/client.js'
import type { SessionStore } from './store.js'
import type { SessionService } from './service.js'
import type { StateDbRead } from './state-db.js'
import { HttpFailure, markSessionTitleGenerated } from './service.js'
import type { SessionEventBus } from './events.js'
import { StreamRegistry, SessionChannels, type StreamChannel } from './streams.js'
import { ChatUsageSchema, ConnectorOperationSnapshotSchema, type ProviderPhase, type RateLimitWait, type RunStatus, type ClarifyAnswers, type PendingSteer, type SessionGoal, type SessionNotice, type SidecarResult, type SteerWithdrawn, type SteerWithdrawRequest, type SteerSendNowResponse } from '@maudecode/talaria-web-contracts'
import { catalogNames, connectorOperation } from '../tools/connectors.js'
import { PendingPrompts, clarifyReply, isVaultPrompt, vaultReply } from './pending.js'
import type { JournalEventMeta } from './storage/backend.js'
import type { RunJournal, RunJournalWriter } from './journal.js'
import { COMPRESSION_RECOVERY_ACTION_START_FOCUSED, COMPRESSION_RECOVERY_TERMINAL_STATE, CONTEXT_USAGE_FIELDS, Session, contextUsage, forgetContextFigures, titleFrom, type Message } from './session.js'
import { anchorMessageKey, compressionReference, markerSummary, visibleMessagesForAnchor } from './compress.js'
import { buildActiveTurnToken, completedToolIndex, publicToolFrame, redactNestedMessageContainers, redactSessionData, redactString, withToolId } from '../redact.js'
import { dict, findPersonality, type Config, type PersonalityRow } from '../config/agent-config.js'
import { ReasoningTitleTracker, reasoningEventPayload } from './reasoning-titles.js'
import { messageWindowForDisplay, messagesForLimitedPayload, toolCallsForMessageWindow } from './window.js'
import { UNSETTLED_TODO_KEY, attachTodoState, parseTodoToolResult } from './todo.js'
import { SessionNotices } from './notices.js'
import { SessionGoals } from './goals.js'
import { hydrateAnchorActivityScenes, turnTerminalState, withTurnIds } from './anchor.js'
import { persistentStateChanges, persistentStateSnapshot } from './state-saved.js'
import { agentBuildParams, webuiEphemeralSystemPrompt, workspaceSystemMessage } from './turn-context.js'
import { agentSteerText, assistantReplyAddedAfterCurrentTurn, attachedFilesPrompt, buildPartialMessage, dedupeContext, checkpointTurnStart, extractToolCallsFromMessages, hasNativeImages, injectMaxIterationSummaryFallback, isDict, mergeDisplayMessagesAfterAgentResult, messageIdentity, messageText, pendingUserRow, sanitizeMessagesForApi, sessionLacksFinalAssistantAnswer, splitDisplayText, stateDbSeenId, joinReasoning, reasoningFieldsText, toolOutcome, withAttachmentObjects, newestSettledReply, withBodyExcerpts, withDisplayMedia, withMarkerKinds, withToolCallOutcomes, withoutMaxIterationSummaryRequest, withNativeImagesRestored, withoutNativeImages, withoutToolImages } from './merge.js'
import { mayBecomeSilentReply, turnOrigin, recordBackgroundReview, recordBackgroundUpdate, type BackgroundUpdate } from './background-updates.js'
import { countExchanges, fallbackTitleFromExchange, firstExchangeSnippets, isGenericFallbackTitle, latestExchangeSnippets, looksInvalidGeneratedTitle, looksLikeDefaultCliTitle, sanitizeGeneratedTitle, titleLanguageMismatch, titlePrompts } from './titles.js'
import { WORKSPACE_BUSY_MESSAGE } from '../workspace/git.js'
import { CHECKPOINT_STORE_BUSY_MESSAGE } from '../workspace/rollback.js'
import type { WorkspaceRegistry } from '../workspace/workspaces.js'
import { str } from '../util.js'
import { toolEditDiff } from './tool-display.js'
import { recordWakeupPause } from './wakeup-pause.js'
import { displayName } from '../providers/catalog.js'

export const CHAT_LOCK_WAIT_SECONDS = 2
const IMAGE_MODE_TIMEOUT_MS = 15_000
const TERMINAL_SSE_VISIBLE_MESSAGE_LIMIT = 80
/** TAL-397: streamed text reports the live meter at most this often (seconds); a counter change reports at once. */
const METERING_INTERVAL_S = 1
/** The Agent's content frames, which end a rate-limit wait (TAL-821) and a compression span (TAL-1006). A terminal frame ends the run, its wait, and its span. */
const CONTENT_EVENTS = new Set(['token', 'reasoning', 'interim_assistant', 'tool', 'tool_complete'])
/** How long a user's message waits for a stopped background turn to unwind before its own turn is admitted. */
const BACKGROUND_UNWIND_WAIT_MS = 30_000

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
  /** Per-session toolsets override; null makes the sidecar resolve the profile's configured toolsets. */
  toolsetsFor: (session: Session) => string[] | null
  attachmentDir: (sid: string) => string
  /** Terminal relay phase per stream (`completed`/`cancelled`/`failed`); Python `note_talaria_terminal`. */
  onTerminal?: (streamId: string, phase: string) => void
  /** Insights title sync (Python `sync_session_title`), gated on `sync_to_insights` by the runtime. */
  syncTitle?: (session: Session) => Promise<void>
  /** Insights usage sync (Python `sync_session_usage`) after a settled turn, gated on `sync_to_insights` by the runtime. */
  syncUsage?: (session: Session, model: string | null) => Promise<void>
  /** Whether the profile's deletion RPC is in flight (its home must not be entered by a new turn). */
  profileDeleting?: (profile: string | null) => boolean
  updateInProgress?: () => boolean
  /** Whether a Git mutation or worktree removal is changing this workspace; no run starts inside it meanwhile. */
  workspaceBusy?: (workspace: string) => boolean
  /** TAL-913: a checkpoint diff or restore holds the profile's checkpoint store, which a turn's capture would collide with. */
  checkpointStoreBusy?: (profile: string | null) => boolean
  /** Runs after the run is retired (Python teardown idle hook: deferred process wakeups). */
  onTurnEnd?: (sessionId: string) => void
  /** TAL-576: the profile's authoritative config file (`AgentConfig.path`); `<home>/config.yaml` when absent. */
  configPath?: (profileHome: string) => string
  /** The profile's config.yaml (turn budgets, reasoning effort, personality, delivery context); null when unavailable. */
  profileConfig?: (profile: string | null) => Promise<Config | null>
  /** TAL-901: the personalities the profile's Agent offers (`AgentConfig.agentPersonalities`); throws when it cannot list them. */
  personalities?: (profile: string | null) => Promise<PersonalityRow[]>
  /** TAL-821: a provider's name as the profile's model catalog lists it (`ProviderCatalog.providerLabel`). */
  providerLabel?: (profile: string | null, provider: string) => string
  /** `auto_title_refresh_every`: a generated title follows the latest exchange every N exchanges; 0 turns it off. */
  titleRefreshEvery?: () => number
  env?: Record<string, string | undefined>
  hermesHome?: string
  homeDisplay?: () => string
}

/**
 * A steer the Agent has not taken yet (TAL-424: owned by the server, shown to every client). `sending_now`: a Send now
 * put it back on the Agent's queue while tools yield; `can_redirect`: the Agent can deliver it now at all.
 */
interface SteerRecord { steer_id: string; session_id: string; stream_id: string; text: string; display_text: string; created_at: number; state: 'pending' | 'sending_now'; can_redirect: boolean }
/**
 * A steer the Agent took, with where it landed: after the last tool that had completed when it was consumed.
 * `redirected`: delivered by Send now as the Agent's own correction row, which becomes this steer's row.
 */
interface ConsumedSteer { steer_id: string; text: string; agent_text: string; submitted_at: number; consumed_at: number; after_tool_call_id: string | null; redirected?: boolean }
export type SteerWithdrawReason = SteerWithdrawRequest['reason']

export interface StartTurnOptions {
  /** The user's text: the transcript row, title, and `persist_user_message`. */
  msg: string
  /** What the model gets instead of `msg` (TAL-817: a prompt built-in's expansion); the Agent keeps it as the row's `api_content`. */
  prompt?: string
  attachments?: Record<string, unknown>[]
  workspace: string
  model: string | null
  modelProvider: string | null
  normalizedModel?: boolean
  source?: string
  goalRelated?: boolean
  /** Durable delegation identities acknowledged by this automatic turn. */
  completionKeys?: string[]
  backgroundUpdate?: BackgroundUpdate
  ephemeral?: boolean
  /** TAL-801: a spoken turn, which the Agent runs on the profile's `auxiliary.voice_chat` slot. */
  voiceTurn?: boolean
  /** TAL-818: the starting client renders `connect_card`; other turns keep the Agent's plain connect links. */
  connectCard?: boolean
  /** The starting client can answer the masked skill-secret variant. */
  skillSecret?: boolean
  /** The settled turn's answer: its last non-error assistant reply, or `` when it produced none. */
  onDone?: (answer: string) => void | Promise<void>
  /** Runs on every other end: an error, a cancel, or a writeback another stream took over (Python background runner: `complete_background(..., "(background task failed)")`). */
  onFailed?: (failure: TurnFailure) => void | Promise<void>
}

/** How a turn that did not complete ended: the `apperror` frame it sent, if any, and whether it was cancelled. */
export interface TurnFailure { apperror: Record<string, unknown> | null; cancelled: boolean }

export type AdmissionResult = StartTurnResponse & { _status?: number; error?: string; active_stream_id?: string | null; held?: boolean }

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

const COMPRESSION_EXHAUSTED: ErrorClassification = { label: 'Context compression exhausted', type: 'compression_exhausted', hint: 'The conversation context is too large to compress safely. Start a new conversation or retry with a narrower task.' }

type ChatUsage = SidecarResult<'chat.start'>['usage']
type UsageCounters = Pick<Session, 'input_tokens' | 'output_tokens' | 'estimated_cost' | 'cache_read_tokens' | 'cache_write_tokens'>

/** The Agent's session counters onto a session's: a zero or missing reading keeps the figure it already has. */
function applyAgentUsage(target: UsageCounters, usage: ChatUsage): void {
  if (usage.prompt_tokens > 0) target.input_tokens = usage.prompt_tokens
  if (usage.completion_tokens > 0) target.output_tokens = usage.completion_tokens
  if (usage.estimated_cost_usd !== null) target.estimated_cost = usage.estimated_cost_usd
  if (usage.cache_read_tokens > 0) target.cache_read_tokens = usage.cache_read_tokens
  if (usage.cache_write_tokens > 0) target.cache_write_tokens = usage.cache_write_tokens
}

/** TAL-397: the `metering` frame's counters, the same figures the session persists. */
const meteringUsage = (c: UsageCounters): Record<string, unknown> => ({
  input_tokens: c.input_tokens || 0, output_tokens: c.output_tokens || 0, estimated_cost: typeof c.estimated_cost === 'number' ? c.estimated_cost : null,
  cache_read_tokens: c.cache_read_tokens || 0, cache_write_tokens: c.cache_write_tokens || 0,
})

/** `compressionExhausted`: the Agent flagged the turn itself, so its wording does not matter. */
export function classifyProviderError(errStr: string, opts: { silentFailure?: boolean | undefined; condition?: string | undefined; compressionExhausted?: boolean | undefined } = {}): ErrorClassification {
  const lower = errStr.toLowerCase()
  if (opts.compressionExhausted) return COMPRESSION_EXHAUSTED
  // TAL-798: the Agent's local llama.cpp provider has no key to add; its server is off or still starting.
  if (opts.condition === 'local_runtime_unavailable') return { label: 'Local model server unavailable', type: 'local_runtime_unavailable', hint: 'The local model server is off or still starting. Turn it on in Hermes Agent, or pick another model.' }
  if (opts.condition === 'credential_missing') return { label: 'Authentication failed', type: 'auth_mismatch', hint: 'The selected model may not be supported by your configured provider or your API key is invalid. Run `hermes model` in your terminal to update credentials, then restart the WebUI.' }
  const cancelled = ['cancelled by user', 'canceled by user', 'user cancelled', 'user canceled', 'task cancelled', 'task canceled', 'cancellederror'].some((k) => lower.includes(k))
  if (cancelled) return { label: 'Task cancelled', type: 'cancelled', hint: '' }
  if (['interrupted by user', 'response interrupted', 'operation interrupted', 'operation was interrupted', 'operation aborted', 'request was aborted', 'aborterror'].some((k) => lower.includes(k))) {
    return { label: 'Response interrupted', type: 'interrupted', hint: 'The run stopped before a provider response completed. If you did not cancel it, try again.' }
  }
  const quota = ['insufficient_quota', 'insufficient credits', 'out of credits', 'credits exhausted', 'quota exceeded', 'usage limit', 'plan limit', 'billing', 'more credits', 'can only afford', 'fewer max_tokens', 'credit balance', 'exceeded your current quota', 'usage_limit_exceeded', 'reached the limit of messages', 'used up your usage'].some((k) => lower.includes(k))
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
  if (compressionExhausted) return COMPRESSION_EXHAUSTED
  if (opts.silentFailure) return { label: 'No response from provider', type: 'no_response', hint: 'The provider returned no content and no error. This often means a usage/rate limit was hit silently. Check provider status, switch providers via `hermes model`, or try again in a moment.' }
  return { label: 'Error', type: 'error', hint: '' }
}

/** Error classifications that are turn outcomes in their own right; every other one ends the turn as `error`. */
const CLASSIFIED_OUTCOMES = new Set(['no_response', 'compression_exhausted', 'interrupted', 'cancelled'])

export function providerErrorPayload(message: string, errType: string, hint = '', redact = true): Record<string, unknown> {
  const safe = redact ? redactString(message).trim() : message
  const payload: Record<string, unknown> = { message: safe || message, type: errType, terminal_state: CLASSIFIED_OUTCOMES.has(errType) ? errType : 'error' }
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

/**
 * Python `_aux_title_generation_enabled`: `auxiliary.title_generation.enabled` with the Agent's
 * `is_truthy_value(default=True)` semantics. Missing/null enables; a string enables only as 1/true/yes/on.
 */
export function titleGenerationEnabled(cfg: Config): boolean {
  const value = dict(dict(cfg.auxiliary).title_generation).enabled
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  // Python `bool()`: empty containers are false; any other number than zero (NaN included) is true.
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  if (typeof value === 'number') return value !== 0
  return Boolean(value)
}

/** Python `_explicit_text_signal`: `agent.image_input_mode: text` or a configured `auxiliary.vision` backend. */
const isImageAttachment = (att: Record<string, unknown>): boolean => Boolean(str(att.path).trim()) && str(att.mime).trim().startsWith('image/')

export function explicitTextSignal(cfg: Config): boolean {
  const agent = dict(cfg.agent)
  if (str(agent.image_input_mode ?? 'auto').trim().toLowerCase() === 'text') return true
  const vision = dict(dict(cfg.auxiliary).vision)
  const provider = str(vision.provider).trim().toLowerCase()
  return !['', 'auto'].includes(provider) || Boolean(str(vision.model).trim()) || Boolean(str(vision.base_url).trim())
}

export const GATEWAY_APPROVAL_RELAY_UNAVAILABLE = 'Gateway approval could not be relayed because the active run is unavailable. Reopen the session or retry after it reconnects.'

export class TurnRunner {
  readonly writers = new Map<string, RunJournalWriter>()
  private readonly sessionPuts = new Map<string, (event: string, data: Record<string, unknown>) => Promise<void>>()
  /** Per-session chain for sidecar YOLO mutation + local commit, so opposing toggles cannot interleave. */
  private readonly yoloChains = new Map<string, Promise<unknown>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly steers = new Map<string, SteerRecord[]>()
  private readonly consumedSteers = new Map<string, ConsumedSteer[]>()
  /** Per stream: steer, withdraw and Send now run one at a time, so each sees the queue the Agent holds. */
  private readonly steerChains = new Map<string, Promise<unknown>>()
  /** Streams whose Agent steer queue a withdraw or Send now is rewriting right now, and the pending text seen meanwhile. */
  private readonly steerRewrites = new Map<string, Promise<unknown>>()
  private readonly deferredPendingSteer = new Map<string, string>()
  private readonly lastCompletedTool = new Map<string, string>()
  /** TAL-397: each running turn's live counters, once the Agent reported any; an error or cancel persists them too. */
  private readonly liveUsage = new Map<string, UsageCounters>()
  /** TAL-397: each running turn's latest todo list, which an error or cancel keeps on the session. */
  private readonly liveTodos = new Map<string, Record<string, unknown>>()
  /** The current presentation, scoped to its owning stream and released on every terminal path. */
  private readonly runStatuses = new Map<string, RunStatus>()
  /** TAL-1006: each live stream's open compression span, by its start (epoch seconds). */
  private readonly compressionSpans = new Map<string, number>()
  /** Streams whose run completed (`done` emitted) and only await title work; a late cancel is a no-op for these. */
  private readonly settledStreams = new Set<string>()
  /** The last adaptive title refresh per session; a successor turn's refresh runs after it (TAL-589). */
  private readonly titleRefreshes = new Map<string, Promise<void>>()
  /**
   * TAL-364: what a Stop needs to write the turn's model context: its starting context, the prompt the Agent got, and
   * whether a settlement already used a canonical checkpoint (which marks the stop boundary; later work never replaces it).
   */
  /** TAL-364: a Stop's in-flight `chat.interrupt` reply (null when it failed), so a worker that settles first can use its checkpoint. */
  private readonly interrupts = new Map<string, Promise<{ pending_steer?: string | undefined; checkpoint?: Record<string, unknown>[] | undefined } | null>>()
  private readonly stopContexts = new Map<string, { previousContext: Message[]; historyLength: number; prompt: string | Record<string, unknown>[]; msgText: string; checkpointed: boolean; stateDbStartId: number | null; stateDbStartGeneration: string | null }>()
  /** Each turn's worker, so a stopped background turn can be awaited before the user's turn takes the session. */
  private readonly workers = new Map<string, Promise<void>>()
  /** TAL-899: sessions whose user pressed Stop; no automatic turn starts in them until the user's next turn is admitted. */
  private readonly stopHeld = new Set<string>()
  private readonly notices = new SessionNotices(() => this.deps.now())
  private readonly goals = new SessionGoals(() => this.deps.now())

  constructor(readonly deps: TurnRunnerDeps) {}

  private get registry(): StreamRegistry { return this.deps.registry }

  // ── admission ────────────────────────────────────────────────────────────

  /** TAL-899: whether a Stop holds the session's automatic turns (session `automatic_turns_held`). */
  async automaticTurnsHeld(sessionId: string): Promise<boolean> {
    if (this.stopHeld.has(sessionId)) return true
    try { return (await this.deps.store.get(sessionId, { metadataOnly: true })).automatic_turns_stop_held } catch { return false }
  }

  /** TAL-803: the Agent's active notices for the session (session `notices`). */
  sessionNotices(sessionId: string): SessionNotice[] {
    const redact = this.deps.redactEnabled()
    return this.notices.list(sessionId).map((n) => ({ ...n, text: redactString(n.text, redact) }))
  }

  /** TAL-808: the session's standing goal (session `goal`). */
  sessionGoal(sessionId: string): SessionGoal | null {
    const goal = this.goals.view(sessionId)
    if (!goal) return null
    const redact = this.deps.redactEnabled()
    return { ...goal, text: redactString(goal.text, redact), reason: goal.reason === null ? null : redactString(goal.reason, redact) }
  }

  /**
   * TAL-808: reads the session's goal from the Agent and, when its view changed, sends `session_goal` on `put` (else the
   * session's live stream) and `sessions_changed`, which reloads the session for a client between turns.
   */
  async refreshGoal(s: Pick<Session, 'session_id' | 'profile'>, put: (event: string, data: Record<string, unknown>) => Promise<void> = async (event, data) => { (await this.emitToSession(s.session_id, event, data)) }): Promise<void> {
    if (!(await this.readGoal(s))) return
    await put('session_goal', { session_id: s.session_id, goal: this.sessionGoal(s.session_id) })
    this.deps.events.publish('goal', { profile: s.profile, sessionId: s.session_id })
  }

  /** TAL-808: a session's first detail after a restart reads its goal before answering, so it tells no one else. */
  async loadGoal(sessionId: string): Promise<void> {
    if (this.goals.has(sessionId)) return
    let s: Session
    try { s = (await this.deps.store.get(sessionId, { metadataOnly: true })) } catch { return }
    await this.readGoal(s)
  }

  /** The Agent's `goals.get` into the cache, and a re-read when a timed park ends; whether the view changed. A failed read keeps the last one. */
  private async readGoal(s: Pick<Session, 'session_id' | 'profile'>): Promise<boolean> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return false
    let status: SidecarResult<'goals.get'>
    try {
      // Short: a session's first load waits on it.
      status = await sidecar.call('goals.get', { session_id: s.session_id, profile_home: this.deps.profileHome(s.profile) }, { timeoutMs: 3_000 })
    } catch (error) {
      this.deps.log(`[webui] WARNING: goal read failed for ${s.session_id}: ${(error as Error).message}`)
      return false
    }
    const changed = this.goals.set(s.session_id, status)
    this.goals.rereadAfterPark(s.session_id, () => { void this.refreshGoal({ session_id: s.session_id, profile: s.profile }) })
    return changed
  }

  /** Hygiene sweep: a deleted session's hold, notices and goal go with it (TAL-899, TAL-803, TAL-808). */
  async sweep(): Promise<void> {
    const exists = async (sid: string): Promise<boolean> => (await this.deps.store.exists(sid))
    for (const sid of this.stopHeld) if (!(await exists(sid))) this.stopHeld.delete(sid)
    await this.notices.sweep(exists)
    await this.goals.sweep(exists)
  }

  /**
   * Admit automatic turns through the same workspace recovery and model resolution as user turns. After the user's Stop
   * none starts (TAL-899): the answer is a `held` 409, and the caller keeps its work for the user's next turn.
   */
  async startServerTurn(session: Session, opts: Pick<StartTurnOptions, 'msg' | 'source' | 'goalRelated' | 'completionKeys' | 'backgroundUpdate'>): Promise<AdmissionResult> {
    if ((await this.automaticTurnsHeld(session.session_id))) return { _status: 409, error: 'automatic turns are held after Stop', held: true }
    try {
      const service = this.deps.service()
      const workspace = (await service.turnWorkspace(session))
      const [model, modelProvider, normalizedModel] = service.turnModel(session)
      return (await this.admit(session, { ...opts, workspace, model, modelProvider, normalizedModel }))
    } catch (error) {
      if (error instanceof HttpFailure) return { _status: error.status, error: error.message }
      throw error
    }
  }

  /** A user's turn; admitting it releases the hold a Stop put on automatic turns (TAL-899). */
  async start(session: Session, opts: StartTurnOptions): Promise<AdmissionResult> {
    const response = (await this.admit(session, opts, true))
    if (response._status === undefined) this.stopHeld.delete(session.session_id)
    return response
  }

  /** Python `_start_chat_stream_for_session`: persist pending state, register the channel, launch the worker. */
  private async admit(session: Session, opts: StartTurnOptions, releaseStopHold = false): Promise<AdmissionResult> {
    const s = session
    const readOnly = (await this.deps.service().readOnlyReason(s))
    if (readOnly) return { error: readOnly, _status: 403 }
    if (this.deps.updateInProgress?.()) return { error: 'Web is updating. Retry after it restarts.', _status: 503 }
    if (this.deps.profileDeleting?.(s.profile ?? null)) return { error: `Profile '${str(s.profile)}' is being deleted.`, _status: 409 }
    if (this.deps.workspaceBusy?.(opts.workspace)) return { error: WORKSPACE_BUSY_MESSAGE, _status: 409 }
    if (this.deps.checkpointStoreBusy?.(s.profile ?? null)) return { error: CHECKPOINT_STORE_BUSY_MESSAGE, _status: 409 }
    const locked = s.active_stream_id
    if (locked) {
      if (this.registry.liveIds.has(locked) || this.registry.activeRuns.has(locked)) return { error: 'session already has an active stream', active_stream_id: locked, _status: 409 }
      await this.deps.service().clearStaleStreamState(s)
      if (s.active_stream_id) return { error: 'session already has an active stream', active_stream_id: s.active_stream_id, _status: 409 }
    } else {
      const blocking = this.registry.activeRunStreamForSession(s.session_id)
      if (blocking) return { error: 'session already has an active stream', active_stream_id: blocking, _status: 409 }
    }
    const accepted = isDict(s.extra.completion_acceptances) ? s.extra.completion_acceptances : {}
    if (opts.completionKeys?.length && opts.completionKeys.every((key) => typeof accepted[key] === 'string' && accepted[key])) {
      return { stream_id: str(accepted[opts.completionKeys[0]!]), session_id: s.session_id }
    }
    const streamId = randomUUID().replace(/-/g, '')
    const wasHiddenEmpty = !s.messages.length && !s.context_messages.length && !s.hasPendingPrompt
    const attachments = opts.attachments ?? []
    // A background wakeup stays one in a forked session too (TAL-460).
    const source = opts.source !== 'process_wakeup' && str(s.source_tag).toLowerCase() === 'fork' ? 'fork' : (opts.source ?? 'webui')
    // TAL-1005: the context figures the last turn reported hold for a turn on the same model only, and are judged before
    // admission clears the post-compression estimate. A `/btw` clone is thrown away after one answer, so it is never due.
    const sameRuntime = str(s.model) === str(opts.model) && str(s.model_provider) === str(opts.modelProvider)
    const compactionDue = !opts.ephemeral && sameRuntime && this.deps.service().compactionDue(s)
    if (!sameRuntime) forgetContextFigures(s)
    s.workspace = opts.workspace
    s.model = opts.model
    s.model_provider = opts.modelProvider
    s.active_stream_id = streamId
    s.post_compression_context_tokens_estimate = null
    s.pending_user_message = opts.msg
    s.pending_attachments = attachments
    s.pending_started_at = this.deps.now()
    s.pending_user_source = source
    // TAL-927: reasoning one provider issued can fail on another (hermes-agent#122831), so a provider switch moves the
    // boundary its carriers replay from.
    if (s.reasoning_replay_provider !== str(opts.modelProvider)) {
      s.reasoning_replay_provider = str(opts.modelProvider)
      s.reasoning_replay_from = s.pending_started_at
    }
    if (['', 'Untitled', 'New Chat'].includes(str(s.title).trim())) {
      const provisional = titleFrom([{ role: 'user', content: opts.msg }], s.title || 'Untitled')
      if (provisional && !['', 'Untitled', 'New Chat'].includes(provisional.trim())) s.title = provisional
    }
    if (this.deps.saveMode() === 'eager') this.checkpointUserMessage(s, opts.msg, attachments, s.pending_started_at, source, streamId)
    const previousStopHold = s.automatic_turns_stop_held
    if (releaseStopHold) s.automatic_turns_stop_held = false
    const previousAcceptances = s.extra.completion_acceptances
    if (opts.completionKeys?.length) s.extra.completion_acceptances = { ...accepted, ...Object.fromEntries(opts.completionKeys.map((key) => [key, streamId])) }
    const previousUpdates = s.extra.background_updates
    if (opts.backgroundUpdate) recordBackgroundUpdate(s, streamId, opts.backgroundUpdate)
    const admission = { stream_id: streamId, session_id: s.session_id, started_at: this.deps.now(), phase: 'starting', workspace: opts.workspace, model: opts.model, provider: opts.modelProvider, ephemeral: Boolean(opts.ephemeral), origin: turnOrigin(source), admitting: true }
    this.registry.registerActiveRun(admission)
    try { (await this.deps.store.save(s)) } catch (error) {
      this.registry.activeRuns.delete(streamId)
      s.extra.background_updates = previousUpdates
      s.extra.completion_acceptances = previousAcceptances
      s.automatic_turns_stop_held = previousStopHold
      throw error
    }
    this.registry.writebackOwners.set(s.session_id, streamId)
    // A new chat appears in the list; every turn tells open clients a run started (TAL-434).
    this.deps.events.publish(wasHiddenEmpty ? 'session_new' : 'turn_started', { profile: s.profile, sessionId: s.session_id })
    try { (await this.deps.workspaces.setLastWorkspace(opts.workspace, s.profile)) } catch { /* best effort */ }
    const channel = this.registry.create(streamId, s.session_id)
    admission.admitting = false
    if (opts.goalRelated) this.registry.goalRelated.add(streamId)
    const worker = this.run(s.session_id, streamId, channel, opts, compactionDue).catch((error: unknown) => {
      this.deps.log(`[webui] ERROR turn ${streamId} crashed\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }).finally(() => { this.workers.delete(streamId) })
    this.workers.set(streamId, worker)
    const response: StartTurnResponse = { stream_id: streamId, session_id: s.session_id, pending_started_at: s.pending_started_at, turn_id: streamId, title: s.title }
    if (opts.normalizedModel && opts.model) response.effective_model = opts.model
    if (opts.modelProvider) response.effective_model_provider = opts.modelProvider
    return response
  }

  /** Resolves once the stream's worker has ended (settled, failed, or torn down); it never rejects. */
  finished(streamId: string): Promise<void> {
    return this.workers.get(streamId) ?? Promise.resolve()
  }

  /** Python `_checkpoint_user_message_for_eager_session_save`. */
  private checkpointUserMessage(s: Session, msg: string, attachments: Record<string, unknown>[], startedAt: number | null, source: string, turnId: string): void {
    const latest = s.messages[s.messages.length - 1]
    if (latest?.role === 'user' && messageText(latest.content).split(/\s+/).join(' ') === msg.split(/\s+/).join(' ')) return
    s.messages.push(pendingUserRow(msg, attachments, startedAt, source, turnId))
  }

  // ── worker ───────────────────────────────────────────────────────────────

  private async run(sessionId: string, streamId: string, channel: StreamChannel, opts: StartTurnOptions, compactionDue: boolean): Promise<void> {
    const { deps } = this
    let writer: RunJournalWriter | null = null
    try {
      writer = (await deps.journal.writer(sessionId, streamId))
      this.writers.set(streamId, writer)
    } catch (error) {
      deps.log(`[webui] WARNING: run journal degraded for stream ${streamId}: ${(error as Error).message}`)
    }
    const failure: TurnFailure = { apperror: null, cancelled: false }
    let waitDetail: RateLimitWait | null = null
    let providerPhase: ProviderPhase | null = null
    let statusEnded = false
    // TAL-1006: the open compression span closes on the Agent's end of it, else on the next content frame.
    const closeCompression = async (createdAt?: number): Promise<void> => {
      if (!this.compressionSpans.has(streamId)) return
      await put('compressed', { session_id: sessionId, message: 'Compression finished' }, createdAt === undefined ? {} : { createdAt })
    }
    const put = async (event: string, data: Record<string, unknown>, meta: JournalEventMeta = {}): Promise<void> => {
      if (this.registry.cancelled.has(streamId) && !['cancel', 'apperror', 'steer_consumed', 'steer_withdrawn', 'run_status'].includes(event)) return
      const terminal = ['done', 'cancel', 'apperror', 'error', 'stream_end'].includes(event)
      if (terminal) statusEnded = true
      if (CONTENT_EVENTS.has(event) || terminal) providerPhase = null
      if (event === 'rate_limit_wait') waitDetail = data.wait as RateLimitWait | null
      // Both pre-turn compaction and Agent callbacks publish through this boundary.
      if (event === 'compressing' && !statusEnded) {
        const startedAt = this.compressionSpans.get(streamId) ?? meta.createdAt ?? deps.now()
        this.compressionSpans.set(streamId, startedAt)
        data = { ...data, started_at: startedAt }
      } else if (event === 'compressed') this.compressionSpans.delete(streamId)
      if (CONTENT_EVENTS.has(event)) {
        if (waitDetail) {
          await put('rate_limit_wait', { session_id: sessionId, wait: null }, meta.createdAt === undefined ? {} : { createdAt: meta.createdAt })
        }
        await closeCompression(meta.createdAt)
      }
      const status: RunStatus | null = event === 'run_status' ? data.status as RunStatus | null : statusEnded ? null : this.compressionSpans.has(streamId) ? { phase: 'compressing' }
        : waitDetail ? { phase: 'rate_limit_wait', wait: waitDetail } : providerPhase ?? { phase: 'working' }
      if (JSON.stringify(this.runStatuses.get(streamId) ?? null) !== JSON.stringify(status)) {
        if (status) this.runStatuses.set(streamId, status)
        else this.runStatuses.delete(streamId)
        await put('run_status', { session_id: sessionId, status }, meta)
      }
      // The sidecar phase is private; only the selected status crosses the client boundary.
      if (event === 'provider_phase') return
      if (event === 'apperror') failure.apperror = data
      else if (event === 'cancel') failure.cancelled = true
      for (const steerEvent of this.takeSteerEventsBefore(streamId, event)) (await put(steerEvent[0], steerEvent[1]))
      if (this.registry.cancelled.has(streamId) && !['cancel', 'apperror', 'steer_consumed', 'steer_withdrawn', 'run_status'].includes(event)) return
      // `cancel()` already wrote the terminal row and closed the stream: the worker's unwind adds no second one.
      if (event === 'cancel' && !this.registry.streams.has(streamId)) {
        try { deps.onTerminal?.(streamId, 'cancelled') } catch { /* best effort */ }
        return
      }
      let eventId: string | null = null
      if (writer) {
        try {
          eventId = (await writer.appendSseEvent(event, data, meta)).event_id
        } catch (error) {
          this.registry.degradedJournals.add(streamId)
          deps.log(`[webui] WARNING: run journal append failed for ${streamId}/${event}: ${(error as Error).message}`)
        }
      }
      channel.put([event, data, eventId, meta.redacted])
      if (event === 'done' || event === 'cancel' || event === 'apperror' || event === 'error') {
        // Relay's phase follows the turn outcome, so a background Live Activity ends as the app would end it.
        const state = str(data.terminal_state)
        const phase = state === 'completed' || state === 'tool_limit_reached' ? 'completed' : event === 'cancel' || state === 'cancelled' ? 'cancelled' : 'failed'
        try { deps.onTerminal?.(streamId, phase) } catch { /* best effort */ }
      }
    }
    this.sessionPuts.set(sessionId, put)
    const activeRun = this.registry.activeRuns.get(streamId)
    let s: Session
    try {
      s = (await deps.store.get(sessionId))
    } catch {
      await put('apperror', { type: 'error', terminal_state: 'error', message: 'Session not found', session_id: sessionId })
      await this.teardown(sessionId, streamId)
      return
    }
    const msgText = opts.msg
    const history = (): { previousMessages: Message[]; previousContext: Message[]; apiHistory: Message[] } => {
      // TAL-493: one state.db read builds the history and marks where this turn's own rows begin.
      const startRead = deps.service().beginStateDbTurn(s)
      const previousMessages = structuredClone(s.messages)
      // TAL-578: an eager save already put this turn's prompt in the transcript; `user_message` carries it, so the history
      // leaves it out.
      const previousContext = structuredClone(deps.service().modelContext(s, startRead.rows)).filter((m) => m._turn_id !== streamId)
      // Python `_sanitize_messages_for_agent`: the model never sees display-only rows or a replayed cancelled prompt, and
      // the Agent gets back the exact bytes it sent (TAL-541).
      const apiHistory = sanitizeMessagesForApi(previousContext, { preserveApiContent: true, issuedReasoningSince: s.reasoning_replay_from })
      this.stopContexts.set(streamId, { previousContext, historyLength: apiHistory.length, prompt: msgText, msgText, checkpointed: false, stateDbStartId: startRead.ok ? stateDbSeenId(startRead.rows) ?? 0 : null, stateDbStartGeneration: startRead.generation })
      return { previousMessages, previousContext, apiHistory }
    }
    // Before the first await: a Stop can land at any point after admission.
    let { previousMessages, previousContext, apiHistory } = history()
    const controller = new AbortController()
    this.abortControllers.set(streamId, controller)
    // TAL-1005: an over-threshold session compacts in its joinable compression job before the turn reads its history, so
    // a Stop ends only this wait and a resend joins the same job. The turn then reads the compacted session afresh.
    const compacted = await deps.service().ensureCompacted(sessionId, { turn: streamId, signal: controller.signal, due: compactionDue, onWait: async () => { (await put('compressing', { session_id: sessionId, message: 'Compressing context' })) } })
    if (compacted) {
      try { s = (await deps.store.get(sessionId)) } catch { /* the cancel or error path below reports a deleted session */ }
      ;({ previousMessages, previousContext, apiHistory } = history())
      await put('compressed', this.compressedFrame(s))
    }
    const activeTurnToken = buildActiveTurnToken(streamId, s.pending_started_at)
    const sidecar = deps.sidecar()
    const partialText = this.registry.partialText.get(streamId) ?? []
    const reasoningText = this.registry.reasoningText.get(streamId) ?? []
    const liveToolCalls = this.registry.liveToolCalls.get(streamId) ?? []
    // Each call's public `id`: the Agent's call id, else one minted here that its completion inherits through the pairing.
    const toolIds = new WeakMap<Record<string, unknown>, string>()
    let mintedToolIds = 0
    const mintToolId = (): string => `tool-${streamId}-${String(++mintedToolIds)}`
    // When the server received each call's start frame: its completion's `duration` is measured from it.
    const toolStartedAt = new WeakMap<Record<string, unknown>, number>()
    let tokenSent = false
    let firstTokenAt: number | null = null
    // TAL-397: the live meter. Counters start from the session's and follow the Agent's; the rate counts text deltas.
    const liveUsage: UsageCounters = { input_tokens: s.input_tokens, output_tokens: s.output_tokens, estimated_cost: s.estimated_cost, cache_read_tokens: s.cache_read_tokens, cache_write_tokens: s.cache_write_tokens }
    const meter = { deltas: 0, first: 0, last: 0, sentAt: null as number | null }
    const putMetering = async (force: boolean, now = deps.now()): Promise<void> => {
      if (!force && meter.sentAt !== null && now - meter.sentAt < METERING_INTERVAL_S) return
      meter.sentAt = now
      const tps = meter.deltas && meter.last > meter.first ? Math.round((meter.deltas / (meter.last - meter.first)) * 10) / 10 : null
      await put('metering', { session_id: sessionId, usage: meteringUsage(liveUsage), tps, tps_available: tps !== null, estimated: false })
    }
    const meterDelta = async (now = deps.now()): Promise<void> => {
      if (!meter.deltas) meter.first = now
      meter.last = now
      meter.deltas += 1
      await putMetering(false, now)
    }
    // TAL-460: a background turn's text is held back while it could still be a silence marker, so one never flashes by.
    // ponytail: checks the turn's whole text, so a marker after earlier prose streams until the settled row hides it;
    // check the last text segment instead if that shows up.
    const holdSilence = turnOrigin(opts.source) === 'background'
    let heldText = ''
    const titles = new ReasoningTitleTracker()
    let capturedTerminalError: string | null = null
    const attachments = opts.attachments ?? []
    // TAL-545: one image mode decides both this turn's upload and the replayed history, which a text-mode turn sends
    // without native images; only a turn with an image on either side asks for it.
    const imageMode = attachments.some(isImageAttachment) || hasNativeImages(apiHistory) ? await this.imageInputMode(sessionId, s, opts, controller.signal) : null
    const userMessage = this.buildUserMessage(opts.prompt ?? msgText, attachments, opts.workspace, sessionId, imageMode)
    const conversationHistory = imageMode === 'text' ? withoutNativeImages(apiHistory) : apiHistory
    // The prompt the Agent actually gets, native image parts included.
    const stop = this.stopContexts.get(streamId)
    if (stop) stop.prompt = userMessage
    if (activeRun) activeRun.phase = 'running'
    const settledAt = { value: false }
    let succeeded = false
    let ownershipRefused = false
    let agentDispatched = false
    let streamWrites: Promise<void> = Promise.resolve()
    let streamWriteError: Error | undefined
    // TAL-424: steers an errored turn ended without taking, sent as one follow-up turn once this one is torn down.
    let followUp: string[] = []
    try {
      if (!sidecar) throw new SidecarError('The Agent sidecar is not running; chat is unavailable until it starts.', { condition: 'sidecar_unavailable' })
      // Python: budgets, reasoning config, personality and delivery context come from the profile's config.yaml; the
      // system message carries the frozen session workspace, the WebUI guidance rides as the ephemeral prompt with this
      // turn's workspace (TAL-710: never a tag on the user's message, which the Agent can persist from memory).
      const cfg = (await deps.profileConfig?.(s.profile ?? null)) ?? {}
      const personality = str(s.personality)
      // A selected personality never silently drops: an unknown catalog fails the turn (an absent name is the Agent's no-overlay).
      const personalities = personality && deps.personalities
        ? await deps.personalities(s.profile ?? null).catch((error: unknown) => { throw new SidecarError(`The session's personality "${personality}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`, { condition: 'sidecar_error' }) })
        : []
      // The sidecar's per-session YOLO state does not survive its restarts: push the local flag (either way) before
      // the turn so a stale sidecar-side enable cannot auto-approve a session the UI reports as guarded.
      await this.withYoloLock(sessionId, async () => { try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: deps.service().yolo(sessionId).yolo_enabled === true }) } catch { /* the approval path re-asserts it */ } })
      // Last yield before `chat.start`: a cancel that landed during the attachment, config or YOLO awaits must not
      // start an Agent turn (the client also refuses an already-aborted signal outright).
      if (this.registry.cancelled.has(streamId)) {
        await this.finalizeCancelled(s, streamId, opts.ephemeral)
        await put('cancel', (await this.cancelFrame(sessionId)))
        return
      }
      const turnContext = {
        system_message: workspaceSystemMessage(str(s.created_workspace) || str(s.workspace)),
        ephemeral_system_prompt: webuiEphemeralSystemPrompt({ config: cfg, personalityPrompt: findPersonality(personalities, personality)?.prompt ?? null, sessionId, profile: s.profile ?? null, workspace: opts.workspace, hermesHome: deps.profileHome(s.profile), homeDisplay: deps.homeDisplay?.() ?? '~/.hermes', background: turnOrigin(opts.source) === 'background' }),
        ...agentBuildParams(cfg, opts.source ?? 'webui', opts.modelProvider ?? s.model_provider ?? null, deps.env ?? {}),
      }
      // Python `_public_prefill_context_status`: the session-recall prefill hook was dropped with TAL-245, so the
      // context frame always reports the not-configured shape.
      const persistentBefore = persistentStateSnapshot(deps.profileHome(s.profile))
      await put('context_status', { session_id: sessionId, prefill: { status: 'not_configured', source: 'none', label: '', message_count: 0 } })
      // Setup awaits can outlive a gateway adoption; no await separates this read from dispatch.
      deps.service().assertWritable(s)
      agentDispatched = true
      const result = await sidecar.call('chat.start', {
        profile_home: deps.profileHome(s.profile), session_id: sessionId, stream_id: streamId, ...this.agentWorkspace(s, opts.workspace), model: opts.model ?? '', model_provider: opts.modelProvider,
        user_message: userMessage, ...turnContext, conversation_history: conversationHistory, enabled_toolsets: deps.toolsetsFor(s), ...(msgText ? { persist_user_message: msgText } : {}), ...(opts.ephemeral ? { ephemeral: true } : {}),
        ...(opts.voiceTurn ? { voice_turn: true } : {}),
        ...(opts.connectCard ? { connect_card: true } : {}),
        ...(opts.skillSecret ? { skill_secret: true } : {}),
      }, {
        signal: controller.signal,
        timeoutMs: 0,
        onStream: (frame) => {
          const receivedAt = deps.now()
          streamWrites = streamWrites.then(async () => {
            const publish = put
            const emitFrame = (event: string, data: Record<string, unknown>, meta: JournalEventMeta = {}) => publish(event, data, { ...meta, createdAt: receivedAt })
            const data = isDict(frame.data) ? frame.data : {}
            switch (frame.event) {
              case 'token': {
                tokenSent = true
                firstTokenAt ??= receivedAt
                // Visible text closes the reasoning segment: a stable title snapshot (or a clear) goes out first.
                const stable = titles.stableSnapshot(reasoningText.join(''))
                if (stable !== null) (await emitFrame('reasoning', { text: '', titles: stable }))
                partialText.push(str(data.text))
                if (holdSilence && mayBecomeSilentReply(partialText.join(''))) { heldText += str(data.text); (await meterDelta(receivedAt)); return }
                await emitFrame('token', { text: heldText + str(data.text) })
                heldText = ''
                await meterDelta(receivedAt)
                return
              }
              case 'reasoning': {
                if (partialText.length && !reasoningText.length) titles.resetSegment()
                reasoningText.push(str(data.text))
                // Python `reasoning_event_payload`: bold or first-line titles ride on the delta they complete.
                await emitFrame('reasoning', titles.prepare(reasoningEventPayload(str(data.text), reasoningText.join(''))))
                await meterDelta(receivedAt)
                return
              }
              case 'usage': {
                const usage = ChatUsageSchema.safeParse(data)
                if (usage.success) { applyAgentUsage(liveUsage, usage.data); this.liveUsage.set(streamId, liveUsage) }
                await putMetering(true, receivedAt)
                return
              }
              case 'steer_pending': {
                // TAL-424: while a withdraw or Send now rewrites the Agent's queue its pending text is ambiguous; it settles after.
                if (this.steerRewrites.has(streamId)) { this.deferredPendingSteer.set(streamId, str(data.text)); return }
                // Capture the causal position before the next frame; only persistence is asynchronous.
                const saving = this.settleConsumedSteers(sessionId, streamId, str(data.text))
                await saving
                return
              }
              case 'tool': {
                const call = { name: data.name, args: data.args ?? {}, tid: str(data.tid), done: false }
                liveToolCalls.push(call)
                toolIds.set(call, call.tid || mintToolId())
                toolStartedAt.set(call, receivedAt)
                const redacted = deps.redactEnabled()
                await emitFrame('tool', publicToolFrame(withToolId(data, toolIds.get(call)!), redacted), { redacted })
                return
              }
              case 'tool_complete': {
                // TAL-313: the server decides failure from the sidecar's raw result, which never leaves the server; TAL-315: so
                // are its display sections, which keep the stderr and exit code the flat preview drops.
                const { raw_result: rawResult, todo_result: todoResult, result_diff: resultDiff, display_metadata: displayMetadata, ...complete } = data
                const outcome = toolOutcome(rawResult)
                complete.is_error = outcome.is_error
                if (rawResult !== undefined) complete.result_view = outcome.result_view
                // TAL-448: a file edit's change, counted over the whole diff the sidecar forwards; redacted with the frame. TAL-909:
                // else the diff in the metadata the Agent persisted on the result row, which a reload reads the same way.
                const editDiff = toolEditDiff(data.name, { diff: resultDiff }, displayMetadata)
                if (editDiff) complete.edit_diff = editDiff
                const tc = liveToolCalls[completedToolIndex(liveToolCalls, str(data.tid), data.name)]
                if (tc) {
                  const startedAt = toolStartedAt.get(tc)
                  if (startedAt !== undefined) complete.duration = Math.round(Math.max(0, receivedAt - startedAt) * 1000) / 1000
                  // TAL-315: the decided view too, so a failed or cancelled turn's snapshot keeps the sections shown live.
                  Object.assign(tc, { done: true, snippet: data.preview, is_error: complete.is_error, duration: complete.duration ?? null, ...(complete.result_view ? { result_view: complete.result_view } : {}), ...(editDiff ? { edit_diff: editDiff } : {}) })
                }
                const id = (tc && toolIds.get(tc)) || str(data.tid) || mintToolId()
                this.lastCompletedTool.set(streamId, id)
                const redacted = deps.redactEnabled()
                await emitFrame('tool_complete', publicToolFrame(withToolId(complete, id), redacted), { redacted })
                // TAL-397: the todo tool's result is the session's new list; the settled session derives the same one.
                // TAL-889: the sidecar attaches `todo_result` only to the Agent's todo tool, so no name check here.
                const todos = parseTodoToolResult(todoResult)
                if (todos) {
                  todos.ts = receivedAt
                  this.liveTodos.set(streamId, todos)
                  await emitFrame('todo_state', redactNestedMessageContainers({ ...todos, session_id: sessionId, stream_id: streamId, source: 'live' }, redacted) as Record<string, unknown>)
                }
                return
              }
              // Python: the live chat frame carries the queue head plus depth, not the entry that just arrived.
              case 'approval': {
                deps.pending.submitApproval(sessionId, { ...data, session_id: sessionId })
                const { pending, pending_count } = deps.pending.approvalPending(sessionId)
                await emitFrame('approval', { ...(pending ?? data), pending_count })
                return
              }
              // TAL-514: the Agent stopped waiting on an approval (answer, timeout, or interrupt); withdraw its copy.
              case 'approval_resolved': {
                if (!str(data.approval_id)) return
                deps.pending.resolveApproval(sessionId, str(data.approval_id))
                await emitFrame(...this.approvalHeadFrame(sessionId))
                return
              }
              case 'clarify': {
                deps.pending.submitClarify(sessionId, { ...data, session_id: sessionId })
                const head = deps.pending.clarifyHeadFrame(sessionId)
                if (head) (await emitFrame('clarify', head))
                return
              }
              case 'clarify_resolved': {
                const { head } = deps.pending.resolveClarify(sessionId, str(data.clarify_id))
                if (head) (await emitFrame('clarify', head))
                return
              }
              case 'provider_phase': {
                const phase = data.phase as Record<string, unknown> | null
                if (phase !== null && phase?.phase !== 'prompt_reading') return
                const percent = phase?.progress_percent
                providerPhase = phase === null ? null : { phase: 'prompt_reading', progress_percent: typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null }
                await put('provider_phase', {}, { createdAt: receivedAt })
                return
              }
              // TAL-821: the Agent sits out a provider's rate limit (`until`, epoch seconds: its reset, else the Agent's retry).
              case 'rate_limit_wait': {
                const until = typeof data.until === 'number' ? data.until : null
                if (until === null && !waitDetail) return
                const provider = str(data.provider) || null
                await emitFrame('rate_limit_wait', { session_id: sessionId, wait: until === null ? null : { provider, provider_label: provider && (deps.providerLabel?.(s.profile ?? null, provider) ?? displayName(provider)), until, until_kind: data.until_kind === 'reset' ? 'reset' : 'retry' } })
                return
              }
              // TAL-818: a `manage_connections` card opened; clients poll and answer the operation by its `op_id`.
              case 'connection': {
                const snapshot = ConnectorOperationSnapshotSchema.safeParse(data)
                if (snapshot.success) (await emitFrame('connect_card', connectorOperation(snapshot.data, catalogNames(deps.profileHome(s.profile)))))
                return
              }
              case 'compressing':
                await emitFrame('compressing', data)
                return
              case 'compression_finished':
                await closeCompression(receivedAt)
                return
              case 'status':
                if (data.kind === 'terminal_error' && !capturedTerminalError) capturedTerminalError = str(data.message)
                return
              // TAL-803: the session's notice list changed; every client replaces its copy.
              case 'notice': {
                const notice = this.notices.add(sessionId, data)
                if (!notice) return
                await emitFrame('notices', { session_id: sessionId, notices: this.sessionNotices(sessionId) })
                // ponytail: the expiry reaches a client only while a turn streams; an idle tab drops it on its next session load.
                if (notice.expires_at !== null) {
                  const expiresAt = notice.expires_at
                  const emitAfterExpiry = async (): Promise<void> => {
                    // Timers can run before the wall clock expires the notice. Let SessionNotices decide, then retry.
                    if (this.notices.list(sessionId).includes(notice)) setTimeout(() => { void emitAfterExpiry().catch((error: unknown) => { deps.log(`[webui] notice expiry failed: ${String(error)}`) }) }, Math.max(1, Math.ceil((expiresAt - deps.now()) * 1000))).unref()
                    else (await this.emitToSession(sessionId, 'notices', { session_id: sessionId, notices: this.sessionNotices(sessionId) }))
                  }
                  await emitAfterExpiry()
                }
                return
              }
              case 'notice_clear':
              case 'notices_reset':
                if (frame.event === 'notice_clear' ? this.notices.clear(sessionId, str(data.key)) : this.notices.reset(sessionId)) (await emitFrame('notices', { session_id: sessionId, notices: this.sessionNotices(sessionId) }))
                return
              default:
                await emitFrame(frame.event, data)
            }
          }).catch((error: unknown) => { streamWriteError = error instanceof Error ? error : new Error(String(error)) })
        },
      })
      await streamWrites
      if (streamWriteError !== undefined) throw streamWriteError
      settledAt.value = true
      // TAL-545: every transcript the Agent hands back settles with the history's images, not the request's projection.
      const withImages = <T extends Record<string, unknown>>(rows: T[]): T[] => withNativeImagesRestored(rows, conversationHistory, apiHistory)
      result.messages = withImages(result.messages)
      if (result.context_messages) result.context_messages = withImages(result.context_messages)
      if (this.registry.cancelled.has(streamId) || result.status === 'cancelled') {
        // The Stop's pre-interrupt snapshot is the boundary, even when its reply lands after this result (the sidecar
        // answers each request on its own thread); without one, the Agent's interrupted result is its canonical transcript.
        const interrupted = await this.interrupts.get(streamId)
        applyAgentUsage(liveUsage, result.usage)
        this.liveUsage.set(streamId, liveUsage)
        await this.finalizeCancelled(s, streamId, opts.ephemeral, interrupted?.checkpoint ? withImages(interrupted.checkpoint) : result.messages)
        await put('cancel', (await this.cancelFrame(sessionId)))
        return
      }
      // Writeback only while this stream still owns the session (Python `_stream_writeback_is_current`).
      let current: Session
      try { current = (await deps.store.get(sessionId)) } catch { current = s }
      if (current.active_stream_id !== streamId) {
        deps.log(`[webui] Skipping stale stream writeback for session ${sessionId} stream ${streamId}; active_stream_id=${current.active_stream_id ?? ''}`)
        return
      }
      s = current
      // Python `_maybe_inject_max_iteration_summary_fallback`: an exhausted tool budget leaves the closing
      // explanation in `final_response` only, so it becomes the turn's assistant answer before anything else reads it.
      const withFallback = (rows: Message[]): Message[] => (result.tool_limit_reached ? injectMaxIterationSummaryFallback(rows, result.final_response) : rows)
      const withoutRequest = (rows: Message[]): Message[] => (result.tool_limit_reached ? withoutMaxIterationSummaryRequest(rows, result.max_iterations_summary_request, msgText) : rows)
      const agentRows = withFallback(result.messages)
      const resultMessages = withoutRequest(agentRows)
      // Python `_assistant_reply_added_after_current_turn`: replayed history never counts as this turn's answer (the
      // sidecar reports `completed` whenever a failed run still carries messages).
      // Python's second chance: a turn that emitted no new row still counts when the merged transcript it produced
      // ends on a final answer (the current user row or trailing tool activity makes it "lacking").
      const mergedForCheck = (): Message[] => mergeDisplayMessagesAfterAgentResult(previousMessages, previousContext, resultMessages, msgText, { source: opts.source ?? 'webui', activeTurnToken, now: deps.now(), turnId: streamId, attachments: opts.attachments ?? [] })
      // TAL-512: a btw answer must be a reply this turn added: everything before it is the parent's replayed history.
      const assistantAdded = assistantReplyAddedAfterCurrentTurn(resultMessages, previousContext, msgText) || (!opts.ephemeral && !sessionLacksFinalAssistantAnswer(mergedForCheck()))
      const lastErr = result.error ?? capturedTerminalError ?? ''
      // Python `_agent_result_terminal_failure`: the Agent's failed, partial, or compression-exhausted result ends the turn
      // even after text streamed; only a partial with no error text and a final answer still completes.
      const agentFailed = result.failed || result.compression_exhausted || (result.partial && (Boolean(lastErr) || !assistantAdded))
      if (result.status === 'error' || agentFailed || (!assistantAdded && (!tokenSent || opts.ephemeral))) {
        const classification = classifyProviderError(lastErr, { silentFailure: !lastErr, compressionExhausted: result.compression_exhausted })
        const errStr = lastErr || `${classification.label}.`
        const payload = providerErrorPayload(errStr, classification.type, classification.hint, deps.redactEnabled())
        // Settle the steers first so the persisted turn carries every consumed one; the Agent's pending text is sent next.
        // A withdraw or Send now still in flight finishes first, so the settlement sees the queue it left.
        await this.steerRewrites.get(streamId)
        const { events: steerEvents, leftovers } = this.finalizeSteers(streamId, str(result.pending_steer), 'followup')
        followUp = leftovers
        await this.persistError(s, streamId, classification.label, payload, activeTurnToken, resultMessages, result.provider)
        // TAL-512: a btw error carries no session: its journaled frame must not keep a copy of the parent conversation.
        if (!opts.ephemeral) payload.session = (await this.publicTerminalSession(s))
        payload.session_id = s.session_id
        payload.old_session_id = sessionId
        for (const [event, data] of steerEvents) (await put(event, data))
        await put('apperror', payload)
        return
      }
      // TAL-512: a btw turn passes the failure check above first, so its last assistant row is this turn's reply.
      if (opts.ephemeral) {
        let answer = ''
        for (let i = resultMessages.length - 1; i >= 0; i -= 1) {
          const m = resultMessages[i]!
          if (m.role === 'assistant') { answer = str(m.content); break }
        }
        succeeded = true
        await opts.onDone?.(answer)
        // Python `_ephemeral_session_payload`: only role and content leave the server for a btw turn.
        await put('done', { session: { session_id: sessionId, messages: resultMessages.map((m) => ({ role: m.role, content: m.content })) }, usage: { input_tokens: 0, output_tokens: 0 }, ephemeral: true, answer, terminal_state: answer.trim() ? 'completed' : 'no_response' })
        try { await deps.store.delete(sessionId, { tombstone: false }) } catch { /* ignore */ }
        deps.store.sessions.delete(sessionId)
        return
      }
      // ── settle the transcript ──
      // TAL-539: after a mid-turn compression the model context is the sidecar's pruned copy, settled like the transcript.
      const pruned = result.compressed ? result.context_messages ?? null : null
      const context = withoutToolImages(pruned ? withoutRequest(withFallback(pruned)) : resultMessages)
      let estimate = result.compressed ? result.post_compression_context_tokens_estimate ?? null : null
      // The sidecar estimated its own rows; a tool-limit settlement or stripped screenshots (TAL-544) that changed them move
      // the estimate by the difference.
      if (pruned && estimate !== null && context !== pruned) {
        try {
          const [before, after] = await Promise.all([pruned, context].map((messages) => sidecar.call('models.estimate_tokens', { messages })))
          estimate = Math.max(1, estimate + after!.tokens - before!.tokens)
        } catch { estimate = null }
      }
      // The Agent's last pending-steer text settles the remaining steers before the turn is written back.
      await this.steerRewrites.get(streamId)
      const { events: steerEvents, leftovers } = this.finalizeSteers(streamId, result.pending_steer, 'followup')
      s.messages = withoutToolImages(mergeDisplayMessagesAfterAgentResult(previousMessages, previousContext, resultMessages, msgText, { source: opts.source ?? 'webui', activeTurnToken, now: deps.now(), turnId: streamId, attachments: opts.attachments ?? [] }))
      s.context_messages = dedupeContext(context)
      // The settled turn's own figures: a compaction it waited on (TAL-1005) installed an estimate its prompt now supersedes.
      s.post_compression_context_tokens_estimate = result.compressed ? estimate : null
      if (result.compressed) {
        // TAL-540: the anchor is the last visible row before this turn (never its eager checkpoint); the merged transcript
        // holds no compaction marker, so the summary is the model context's newest one.
        const before = visibleMessagesForAnchor(previousMessages.filter((m) => m._turn_id !== streamId))
        const after = visibleMessagesForAnchor(s.messages)
        const anchorIdx = before.length ? before.length - 1 : after.length ? 0 : null
        s.compression_anchor_visible_idx = anchorIdx
        s.compression_anchor_message_key = anchorMessageKey(anchorIdx !== null && anchorIdx < after.length ? after[anchorIdx] : after.at(-1))
        s.compression_anchor_summary = markerSummary(s.context_messages)
      }
      const now = deps.now()
      for (const m of s.messages) m.timestamp ??= now
      if (['Untitled', 'New Chat', ''].includes(str(s.title))) s.title = titleFrom(s.messages, s.title)
      const usage = result.usage
      const prevInputTokens = s.input_tokens || 0
      const prevCacheReadTokens = s.cache_read_tokens || 0
      applyAgentUsage(s, usage)
      if (typeof result.context.context_length === 'number') s.context_length = result.context.context_length
      if (typeof result.context.threshold_tokens === 'number') s.threshold_tokens = result.context.threshold_tokens
      if (typeof result.context.last_prompt_tokens === 'number') s.last_prompt_tokens = result.context.last_prompt_tokens
      s.next_turn_threshold_tokens = result.context.next_turn_threshold_tokens ?? null
      if (result.compressed) (await put('compressed', this.compressedFrame(s)))
      s.tool_calls = extractToolCallsFromMessages(s.messages, liveToolCalls, s.tool_calls)
      this.clearPendingTurn(s)
      // TAL-576: a turn that ran means the provider has usable credentials again.
      s.process_wakeup_pause = null
      const attachments = opts.attachments ?? []
      if (attachments.length) {
        for (let i = s.messages.length - 1; i >= 0; i -= 1) {
          const m = s.messages[i]!
          if (m.role === 'user') {
            const content = messageText(m.content)
            const base = msgText.includes('\n\n[Attached files:') ? (msgText.split('\n\n[Attached files:')[0] ?? '').trim() : msgText
            // An attachment-only prompt has no text to match: only this turn's own row takes its files.
            if (msgText ? content.includes(base.slice(0, 60)) || msgText.includes(content.slice(0, 60)) : m._turn_id === streamId) m.attachments = [...attachments]
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
        // The settled row keeps its own fields: only its prose and its inline thinking (into `reasoning`) are rewritten.
        if (typeof m.content === 'string' && m.content) {
          const [content, inline] = splitDisplayText(m.content)
          m.content = content
          if (inline) m.reasoning = joinReasoning([reasoningFieldsText({ reasoning: m.reasoning }), inline])
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
      // TAL-493: the rows this turn's Agent wrote to state.db are now in the transcript, so the merge must not replay them
      // (all of them, the dropped summary request too).
      this.settleStateDb(s, streamId, agentRows, { previousContext })
      recordBackgroundReview(s, streamId)
      await deps.store.save(s)
      deps.pending.clearApprovals(sessionId)
      deps.pending.clearClarifies(sessionId)
      deps.events.publish('session_done', { profile: s.profile, sessionId: s.session_id })
      // Python `_persistent_state_changes`: toast memory/skill files the agent wrote during the turn.
      try {
        const changes = persistentStateChanges(persistentBefore, persistentStateSnapshot(deps.profileHome(s.profile)))
        if (changes.memory_saved) (await put('state_saved', { session_id: sessionId, kind: 'memory', action: 'saved' }))
        for (const change of changes.skills) (await put('state_saved', { session_id: sessionId, kind: 'skill', action: change.action, name: change.name }))
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
      const doneSession = (await this.publicTerminalSession(s))
      // TAL-299: the ring's figures match the terminal session's (and a detail reload's).
      for (const key of CONTEXT_USAGE_FIELDS) doneUsage[key] = doneSession[key]
      if (usage.completion_tokens && duration > 0) doneUsage.tps = Math.round((usage.completion_tokens / duration) * 10) / 10
      if (firstTokenAt !== null) doneUsage.ttft_ms = Math.max(0, Math.round((firstTokenAt - previousStartedAt(s, activeRun)) * 1000))
      const usedModel = str(result.model) || str(opts.model) || str(s.model)
      if (usedModel) doneUsage.used_model = usedModel
      const donePayload: Record<string, unknown> = {
        session: doneSession,
        usage: doneUsage,
        terminal_state: turnTerminalState(s.messages, streamId),
      }
      if (result.tool_limit_reached) donePayload.terminal_reason = 'max_iterations'
      // TAL-397: the live meter ends on the persisted counters and turn rate.
      await put('metering', { session_id: sessionId, usage: meteringUsage(s), tps: doneUsage.tps ?? null, tps_available: doneUsage.tps !== undefined, estimated: false })
      await put('done', donePayload)
      for (const [event, payload] of steerEvents) (await put(event, payload))
      // The turn is over: release admission before the title work so a follow-up message is accepted while the
      // (up to two) title prompts run; the channel and journal stay open for the `title` events (Python retired the
      // worker before its daemon-thread title generation).
      this.registry.activeRuns.delete(streamId)
      this.settledStreams.add(streamId)
      // TAL-1005: a turn that settled at or above the next turn's threshold starts the compaction now, so the next message
      // usually finds the session compacted; a follow-up turn admitted meanwhile joins it.
      void deps.service().ensureCompacted(sessionId)
      await this.startSteerFollowUp(sessionId, leftovers)
      // Before the title work, so a generated title's own state.db sync lands after this one's provisional title.
      await deps.syncUsage?.(s, usedModel || null)
      // Title work and the goal judge run side by side; `stream_end` follows both, so their frames reach the stream.
      const work = await Promise.allSettled([this.backgroundTitle(s, put), this.continueGoal(s, streamId, put)])
      await put('stream_end', { session_id: sessionId })
      for (const r of work) if (r.status === 'rejected') throw r.reason
      succeeded = true
      await opts.onDone?.(lastAnswer(s.messages))
    } catch (error) {
      await streamWrites
      const readOnly = !agentDispatched ? (await deps.service().readOnlyReason(s)) : null
      if (readOnly) {
        ownershipRefused = true
        if (this.registry.writebackOwners.get(sessionId) === streamId && s.active_stream_id === streamId) {
          // Cancellation persists the prompt and a Stop row; an unstarted, refused turn must add neither.
          s.messages = s.messages.filter((m) => !(m.role === 'user' && m._turn_id === streamId))
          this.clearPendingTurn(s)
          if (isDict(s.extra.completion_acceptances)) s.extra.completion_acceptances = Object.fromEntries(Object.entries(s.extra.completion_acceptances).filter(([, value]) => value !== streamId))
          await deps.store.save(s, { touchUpdatedAt: false })
        }
        await put('apperror', { type: 'error', terminal_state: 'error', message: readOnly, session_id: sessionId, session: (await this.publicTerminalSession(s)) })
        return
      }
      if (settledAt.value && !(error instanceof SidecarError)) {
        deps.log(`[webui] ERROR settling turn ${streamId}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      }
      if (this.registry.cancelled.has(streamId)) {
        await this.finalizeCancelled(s, streamId, opts.ephemeral)
        await put('cancel', (await this.cancelFrame(sessionId)))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const condition = error instanceof SidecarError ? error.condition : undefined
      const runtime = error instanceof SidecarError && ['sidecar_unavailable', 'agent_runtime_stale', 'agent_incompatible'].includes(error.condition)
        ? runtimeFailureDetails(error.condition, error.data) : null
      const classification = runtime ? { label: 'Error', type: runtime.type, hint: '' } : classifyProviderError(message, { condition })
      const payload = providerErrorPayload(runtime?.message ?? message, classification.type, classification.hint, deps.redactEnabled())
      if (runtime) Object.assign(payload, runtime)
      try {
        let current: Session = s
        try { current = (await deps.store.get(sessionId)) } catch { current = s }
        if (current.active_stream_id === streamId) {
          for (const [event, data] of this.takeSteerEventsBefore(streamId, 'apperror')) (await put(event, data))
          await this.persistError(current, streamId, classification.label, payload, activeTurnToken)
          if (!opts.ephemeral) payload.session = (await this.publicTerminalSession(current))
        }
      } catch (persistError) {
        deps.log(`[webui] WARNING: failed to persist turn error for ${sessionId}: ${(persistError as Error).message}`)
      }
      payload.session_id = sessionId
      payload.old_session_id = sessionId
      await put('apperror', payload)
    } finally {
      await this.teardown(sessionId, streamId)
      // After persistence and teardown: a background route's failure cleanup deletes the hidden session, which must
      // not race the error writeback above (a re-saved session would resurface in the sidebar).
      if (!succeeded) await opts.onFailed?.(failure)
      // TAL-1005: a Stop or an error after the turn ran on a compaction's result left that job's estimate under a context
      // its prompt and work may have grown; the idle trigger judges the context measured again.
      if (!succeeded && !ownershipRefused && !opts.ephemeral) void deps.service().remeasureContext(sessionId).then((measured) => { if (measured) void deps.service().ensureCompacted(sessionId) })
      await this.startSteerFollowUp(sessionId, followUp)
    }
  }

  /**
   * Python `_resolve_image_input_mode`: the Agent's image mode for this turn's model under its profile config, or null
   * when it is unknown (no sidecar, a cancel, a failed lookup). A canonical "text" is honoured only with an explicit
   * text signal or a model KNOWN to be text-only; an unknown/custom model forwards natively and lets the Agent's retry
   * guard downgrade.
   */
  private async imageInputMode(sessionId: string, s: Session, opts: StartTurnOptions, signal: AbortSignal): Promise<'native' | 'text' | null> {
    const sidecar = this.deps.sidecar()
    // A cancel that landed before this point is final: never start the lookup or wait on it.
    if (!sidecar || signal.aborted) return null
    // The session's provider before the Agent canonicalizes it, so a `custom:<name>` override entry still matches.
    const provider = str(opts.modelProvider ?? s.model_provider)
    try {
      // A cancelled turn must not sit behind this lookup: the abort wins the race and `run()` then takes the cancelled path.
      const lookup = sidecar.call('text.image_mode', { profile_home: this.deps.profileHome(s.profile), provider, model: str(opts.model ?? s.model), requested_provider: provider }, { signal, timeoutMs: IMAGE_MODE_TIMEOUT_MS })
      const mode = await Promise.race([lookup, new Promise<never>((_, reject) => { if (signal.aborted) { reject(new Error('turn cancelled')); return } signal.addEventListener('abort', () => { reject(new Error('turn cancelled')) }, { once: true }) })])
      if (mode.mode === 'native') return 'native'
      const cfg = (await this.deps.profileConfig?.(s.profile ?? null)) ?? {}
      return explicitTextSignal(cfg) || mode.supports_vision === false ? 'text' : 'native'
    } catch (error) {
      if (!signal.aborted) this.deps.log(`[webui] image mode lookup failed for ${sessionId}: ${(error as Error).message}`)
      return null
    }
  }

  /**
   * Python `_build_user_message`: image attachments are embedded as native `image_url` parts only when the turn's
   * image mode is `native` (text mode routes them through the Agent's vision tool path), and only after the bytes are
   * read through an anchored descriptor and sniffed as a real image format. Every attached file is also named by path
   * after the text (TAL-276), so an attachment-only turn still gives the model a request and its transcript row a
   * distinct identity.
   */
  private buildUserMessage(msgText: string, attachments: Record<string, unknown>[], workspace: string, sessionId: string, imageMode: 'native' | 'text' | null): string | Record<string, unknown>[] {
    const withFiles = (): string => attachedFilesPrompt(msgText, attachments)
    const candidates = attachments.filter(isImageAttachment)
    if (!candidates.length || imageMode !== 'native') return withFiles()
    const parts: Record<string, unknown>[] = []
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
    return images ? [{ type: 'text', text: withFiles() }, ...parts] : withFiles()
  }

  /** The settled session as a terminal frame carries it: the display window, redacted. */
  async publicTerminalSession(s: Session): Promise<Record<string, unknown>> {
    return redactSessionData((await this.terminalSessionPayload(s)), this.deps.redactEnabled())
  }

  /**
   * Python `_session_payload_with_terminal_window`: the same visible-message window contract as `GET /api/session?
   * msg_limit=` (renderable rows, limited payload shape, windowed tool calls, todo state) with the full count.
   */
  private async terminalSessionPayload(s: Session): Promise<Record<string, unknown>> {
    const payload = (await this.deps.service().wireRow(s))
    payload.automatic_turns_held = (await this.automaticTurnsHeld(s.session_id))
    payload.notices = this.sessionNotices(s.session_id)
    payload.goal = this.sessionGoal(s.session_id)
    const service = this.deps.service()
    const scened = (await service.backgroundLinked(s, hydrateAnchorActivityScenes(withToolCallOutcomes((await service.backgroundUpdates(s, withMarkerKinds(withTurnIds(withAttachmentObjects(s.messages)), s))), s.tool_calls, s.active_stream_id), s.anchor_activity_scenes, { activeTurnId: s.active_stream_id, clipToolResults: true })))
    const [window, offset] = messageWindowForDisplay(scened, TERMINAL_SSE_VISIBLE_MESSAGE_LIMIT, null)
    const limited = messagesForLimitedPayload(withBodyExcerpts(withDisplayMedia(window, (await service.mediaProjector(s))), s.active_stream_id, newestSettledReply(scened, s.active_stream_id), offset))
    payload.messages = limited
    payload.message_count = s.messages.length
    payload._messages_offset = offset
    payload._messages_truncated = offset > 0
    attachTodoState(payload, s.messages, s.extra[UNSETTLED_TODO_KEY])
    payload.tool_calls = toolCallsForMessageWindow(s.tool_calls, offset, limited.length)
    payload.compression_reference = compressionReference(s, scened)
    return payload
  }

  /** TAL-540, Python `_live_usage_snapshot`: a finished compression's frame, with the counters and the ring's post-compression figures, so clients update before `done`. */
  private compressedFrame(s: Session): Record<string, unknown> {
    const usage = {
      ...meteringUsage(s), context_length: s.context_length ?? 0, threshold_tokens: s.threshold_tokens ?? 0, last_prompt_tokens: s.last_prompt_tokens ?? 0,
      post_compression_context_tokens_estimate: s.post_compression_context_tokens_estimate, ...contextUsage(s, () => this.deps.service().deps.contextLengthFor(s.model, s.model_provider)),
    }
    const sid = s.session_id
    return { session_id: sid, old_session_id: sid, new_session_id: sid, continuation_session_id: sid, message: 'Compression finished', usage }
  }

  /** Release only the pending admission metadata; transcript settlement belongs to the caller. */
  private clearPendingTurn(s: Session): void {
    s.active_stream_id = null
    s.pending_user_message = null
    s.pending_attachments = []
    s.pending_started_at = null
    s.pending_user_source = null
  }

  /** Python `_materialize_pending_user_turn_before_error` + error message append + save. */
  /** `runtimeProvider`: the provider the Agent resolved for the turn, when it reported one. */
  private async persistError(s: Session, streamId: string, label: string, payload: Record<string, unknown>, activeTurnToken: string | null, agentRows: Message[] = [], runtimeProvider = ''): Promise<void> {
    const startedAt = s.pending_started_at
    // TAL-576: an automatic wakeup with no usable credentials pauses the next ones instead of failing each.
    if (s.pending_user_source === 'process_wakeup' && payload.type === 'credential_pool_empty') {
      // A profile whose home now escapes the profiles root (`profileHome` throws) records no pause; the error still persists.
      let home: string | null = null
      try { home = this.deps.profileHome(s.profile) } catch { home = null }
      if (home !== null) recordWakeupPause(s, home, this.deps.now(), runtimeProvider, this.deps.configPath?.(home))
    }
    this.materializePendingUserTurn(s, activeTurnToken, streamId)
    const duration = typeof startedAt === 'number' && startedAt > 0 ? Math.max(0, this.deps.now() - startedAt) : null
    this.clearPendingTurn(s)
    this.appendPartialSnapshot(s, streamId)
    const hint = str(payload.hint)
    const errorMessage: Message = { role: 'assistant', content: `**${label}:** ${str(payload.message) || label}${hint ? `\n\n*${hint}*` : ''}`, timestamp: Math.trunc(this.deps.now()), _error: true, _turn_id: streamId }
    if (duration !== null) errorMessage._turnDuration = Math.round(duration * 1000) / 1000
    // The outcome the live frame reported stays on the row, so the settled scene says the same.
    errorMessage._terminal_state = str(payload.terminal_state) || 'error'
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
    this.keepLiveState(s, streamId)
    this.persistConsumedSteers(s, streamId, startedAt, this.deps.now())
    // TAL-921: the next prompt remembers the turn's work; an exhausted compression's work would only overflow again. One
    // read builds the context and settles, so a row committed in between is never covered without reaching either.
    const read = this.deps.service().stateDbRead(s)
    const context = payload.type === 'compression_exhausted' ? null : this.unsettledContext(streamId, agentRows, read)
    if (context) s.context_messages = context
    this.settleStateDb(s, streamId, agentRows, { read })
    try { (await this.deps.store.save(s)) } catch (error) { this.deps.log(`[webui] WARNING: failed to save error turn for ${s.session_id}: ${(error as Error).message}`) }
    // The kept live counters are the session's usage now, so the insights row follows them (the runtime logs failures).
    void this.deps.syncUsage?.(s, str(s.model) || null)
    this.deps.pending.clearApprovals(s.session_id)
    this.deps.pending.clearClarifies(s.session_id)
    this.deps.events.publish('session_error', { profile: s.profile, sessionId: s.session_id })
  }

  /** Every terminal path carries the same starting read's id and generation into settlement. */
  private settleStateDb(s: Session, streamId: string, agentRows: Message[] | null, opts: { previousContext?: Message[]; read?: StateDbRead } = {}): void {
    const stop = this.stopContexts.get(streamId)
    const service = this.deps.service()
    service.settleStateDb(s, { turnId: streamId, previousContext: stop?.previousContext ?? opts.previousContext ?? [], agentRows, startId: stop?.stateDbStartId ?? null, startGeneration: stop?.stateDbStartGeneration ?? null, read: opts.read ?? service.stateDbRead(s) })
  }

  /**
   * TAL-921: the model context a turn that ends without its settled result leaves: the work its Agent reported, else the
   * rows it committed past its starting read in `read`, the read its settlement uses.
   */
  private unsettledContext(streamId: string, agentRows: Message[] | null, read: StateDbRead): Message[] | null {
    const stop = this.stopContexts.get(streamId)
    if (!stop) return null
    const after = stop.stateDbStartGeneration !== null && read.generation !== null && stop.stateDbStartGeneration !== read.generation ? -1 : stop.stateDbStartId
    const stateRows = after === null ? [] : read.rows.filter((m) => typeof m._state_db_row_id === 'number' && m._state_db_row_id > after)
    return this.deps.service().unsettledTurnContext({ ...stop, streamedText: (this.registry.partialText.get(streamId) ?? []).join(''), agentRows, stateRows })
  }

  private materializePendingUserTurn(s: Session, activeTurnToken: string | null, turnId: string): boolean {
    const pendingText = str(s.pending_user_message)
    if (!s.hasPendingPrompt) return false
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

  /**
   * Python `_emit_cancel_event`: the terminal frame carries the settled session so tabs can render the partial without a
   * reload. TAL-364: no copy — clients show their one localized status for the `cancelled` outcome.
   */
  private async cancelFrame(sessionId: string | null): Promise<Record<string, unknown>> {
    let snapshot: Record<string, unknown> | null = null
    if (sessionId) try { snapshot = (await this.publicTerminalSession((await this.deps.store.get(sessionId)))) } catch { snapshot = null }
    return { type: 'cancelled', status: 'cancelled', terminal_state: 'cancelled', ...(sessionId ? { session_id: sessionId } : {}), ...(snapshot ? { session: snapshot } : {}) }
  }

  /**
   * Python `_finalize_cancelled_turn`/`_persist_cancelled_turn`: only while this stream still owns writeback. TAL-364: the
   * turn's model context keeps what the Agent had captured (`checkpoint`, its canonical transcript) and the prose that
   * streamed, so the next request continues from it; the terminal row carries the outcome and no copy.
   */
  private async finalizeCancelled(s: Session, streamId: string, ephemeral: boolean | undefined, checkpoint: unknown[] | null = null): Promise<boolean> {
    if (this.registry.writebackOwners.get(s.session_id) !== streamId) return false
    let current: Session = s
    try { current = (await this.deps.store.get(s.session_id)) } catch { return false }
    if (current.active_stream_id !== null && current.active_stream_id !== streamId) return false
    if (ephemeral) {
      try { await this.deps.store.delete(current.session_id, { tombstone: false }) } catch { /* ignore */ }
      this.deps.store.sessions.delete(current.session_id)
      return true
    }
    // TAL-460: a background turn stops quietly: its prompt and model context are kept, but no partial and no Stop row,
    // and its first settlement is final.
    const quiet = this.registry.activeRuns.get(streamId)?.origin === 'background'
    if (quiet && current.active_stream_id === null) {
      // TAL-493: rows its worker committed while unwinding are covered by what it reports; others are kept.
      if (checkpoint) {
        this.settleStateDb(current, streamId, checkpoint as Message[])
        try { (await this.deps.store.save(current)) } catch { return false }
      }
      return true
    }
    const stop = this.stopContexts.get(streamId)
    const canonical = stop !== undefined && checkpoint !== null && checkpointTurnStart(checkpoint, stop.msgText, stop.historyLength) !== null
    // TAL-921: one state.db read builds the context and settles the turn.
    const settle = (read: StateDbRead): Message[] | null => {
      if (!stop) return null
      if (canonical) stop.checkpointed = true
      return this.unsettledContext(streamId, checkpoint as Message[] | null, read)
    }
    if (current.messages.some((m) => isCancelMarker(m)) && current.active_stream_id === null && !current.pending_user_message) {
      // The worker's canonical result can arrive after cancel() settled without a checkpoint (the interrupt reply failed
      // or timed out): it replaces this stream's context and never adds a second Stop row. A settlement that already had
      // one keeps it, so work the Agent finished after the Stop stays out.
      const ownStop = current.messages.some((m) => isCancelMarker(m) && m._turn_id === streamId)
      // TAL-493: the worker's rows committed after the first settlement are covered by what it reports; others are kept.
      if (ownStop && checkpoint) {
        const read = this.deps.service().stateDbRead(current)
        const late = canonical && !stop.checkpointed ? settle(read) : null
        if (late) current.context_messages = dedupeContext(late)
        this.settleStateDb(current, streamId, checkpoint as Message[], { read })
        try { (await this.deps.store.save(current)) } catch { return false }
      }
      return true
    }
    const startedAt = current.pending_started_at
    this.materializePendingUserTurn(current, buildActiveTurnToken(streamId, current.pending_started_at), streamId)
    const read = this.deps.service().stateDbRead(current)
    const context = settle(read)
    if (context) current.context_messages = dedupeContext(context)
    this.clearPendingTurn(current)
    if (!quiet) {
      this.appendPartialSnapshot(current, streamId)
      current.messages.push({ role: 'assistant', content: '', _error: true, _terminal_state: 'cancelled', timestamp: Math.trunc(this.deps.now()), _turn_id: streamId })
    }
    this.keepLiveState(current, streamId)
    this.persistConsumedSteers(current, streamId, startedAt, this.deps.now())
    this.settleStateDb(current, streamId, checkpoint as Message[] | null, { read })
    try { (await this.deps.store.save(current)) } catch { return false }
    void this.deps.syncUsage?.(current, str(current.model) || null)
    this.deps.pending.clearApprovals(current.session_id)
    this.deps.pending.clearClarifies(current.session_id)
    this.deps.events.publish('session_cancel', { profile: current.profile, sessionId: current.session_id })
    return true
  }

  /** Push a frame onto the session's live chat stream from outside the turn (Python gateway notify callbacks). */
  private async emitToSession(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    await this.sessionPuts.get(sessionId)?.(event, data)
  }

  /** TAL-397: a turn that ends without its result keeps what the live stream already showed: counters and todo list. */
  private keepLiveState(s: Session, streamId: string): void {
    const usage = this.liveUsage.get(streamId)
    if (usage) Object.assign(s, usage)
    const todos = this.liveTodos.get(streamId)
    if (todos) s.extra[UNSETTLED_TODO_KEY] = todos
  }

  private async teardown(sessionId: string, streamId: string): Promise<void> {
    this.runStatuses.delete(streamId)
    this.liveUsage.delete(streamId)
    this.compressionSpans.delete(streamId)
    this.liveTodos.delete(streamId)
    const writer = this.writers.get(streamId)
    if (writer) { try { (await writer.close()) } catch { /* ignore */ } this.writers.delete(streamId) }
    this.abortControllers.delete(streamId)
    this.interrupts.delete(streamId)
    this.stopContexts.delete(streamId)
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


  // ── title ────────────────────────────────────────────────────────────────

  /** Python `_generate_llm_session_title_via_aux`: aux-route statuses (`llm_aux`, `llm_aux_retry`, `llm_*_aux`). */
  private async llmTitle(s: Session, userText: string, assistantText: string): Promise<{ title: string; status: string; rawPreview: string }> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { title: '', status: 'llm_error_aux', rawPreview: '' }
    const service = this.deps.service()
    await service.deps.warmSessionModelRepair?.(s.profile)
    const [model, provider] = service.turnModel(s)
    const [qa, prompts] = titlePrompts(userText, assistantText)
    let status = 'llm_error_aux'
    for (const [idx, prompt] of prompts.entries()) {
      if ((await this.deps.service().isReadOnly(s))) return { title: '', status: 'read_only', rawPreview: '' }
      let raw = ''
      try {
        const result = await sidecar.call('aux.complete', {
          profile_home: this.deps.profileHome(s.profile), task: 'title_generation',
          messages: [{ role: 'system', content: prompt }, { role: 'user', content: qa }], max_tokens: 64,
          main_runtime: { model: model ?? '', provider }, main_fallback: true,
        })
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

  /**
   * TAL-902: `/refine [focus]` starts the Agent's memory/skill review of the chat's model context on its agent
   * (`chat.refine`, the agent a turn would build); no turn starts. Without a chat, while a turn runs, or before anything
   * was said it answers with the Agent's wording instead.
   */
  async refine(s: Session | null, focus: string): Promise<string> {
    if (!s) return 'Nothing to refine yet — send a message first.'
    if (s.active_stream_id) return 'Agent is running — wait for the turn to finish, then /refine.'
    const messages = sanitizeMessagesForApi(this.deps.service().modelContext(s), { preserveApiContent: true, issuedReasoningSince: s.reasoning_replay_from })
    if (!messages.length) return 'Nothing to refine yet — the conversation is empty.'
    // Like a turn: no agent is built in a profile whose home is going away.
    if (this.deps.profileDeleting?.(s.profile ?? null)) throw new HttpFailure(409, `Profile '${str(s.profile)}' is being deleted.`)
    const sidecar = this.deps.sidecar()
    if (!sidecar) throw new SidecarError('The Agent sidecar is not running; /refine is unavailable until it starts.', { condition: 'sidecar_unavailable' })
    const [model, provider] = this.deps.service().turnModel(s)
    const cfg = (await this.deps.profileConfig?.(s.profile ?? null)) ?? {}
    this.deps.service().assertWritable(s)
    return (await sidecar.call('chat.refine', {
      profile_home: this.deps.profileHome(s.profile), session_id: s.session_id, messages, focus, model: model ?? '', model_provider: provider,
      enabled_toolsets: this.deps.toolsetsFor(s), ...agentBuildParams(cfg, 'webui', provider, this.deps.env ?? {}),
      ...this.agentWorkspace(s, (await this.deps.service().turnWorkspace(s))),
    }, { timeoutMs: 120_000 })).output
  }

  /**
   * TAL-903: the workspace a session's agent is built at, and whether it is a host path (the profile's terminal runs
   * locally). Only then does the Agent anchor AGENTS.md discovery and its memory provider there; `chat.start` and
   * `chat.refine` send the same pair, so the agent `/refine` builds is the one the next turn reuses.
   */
  private agentWorkspace(s: Session, workspace: string): { workspace: string; workspace_local: boolean } {
    return { workspace, workspace_local: this.deps.workspaces.profileSupportsLocalIo(s.profile) }
  }

  /**
   * Python `generate_session_title_for_session`: on-demand title from the persisted transcript; never touches
   * `llm_title_generated`. An explicit regenerate runs even with `auxiliary.title_generation.enabled` off (TAL-531).
   */
  async generateTitle(s: Session, opts: { preferLatest?: boolean } = {}): Promise<{ title: string | null; status: string; rawPreview: string }> {
    const [userText, assistantText] = opts.preferLatest ? latestExchangeSnippets(s.messages) : firstExchangeSnippets(s.messages, { scanPastConsecutiveUsers: true })
    if (!userText) return { title: null, status: 'empty_user_message', rawPreview: '' }
    let next = ''
    let llmStatus = 'empty_assistant_message'
    let rawPreview = ''
    if (assistantText) ({ title: next, status: llmStatus, rawPreview } = await this.llmTitle(s, userText, assistantText))
    this.deps.service().assertWritable(s)
    if (next) return { title: next, status: llmStatus, rawPreview }
    const fallback = fallbackTitleFromExchange(userText, assistantText)
    if (fallback && !isGenericFallbackTitle(fallback)) return { title: fallback, status: `local_summary:${llmStatus}`, rawPreview }
    return { title: null, status: llmStatus || 'empty_title', rawPreview }
  }

  /**
   * TAL-591 (Python `_queue_generated_title_for_imported_session`): a CLI session a mutation claims while it still
   * carries its default title gets the background title job at once instead of after its first WebUI turn.
   */
  async titleClaimed(s: Session): Promise<void> {
    if (!looksLikeDefaultCliTitle({ title: s.title, source_tag: s.source_tag, raw_source: s.raw_source, session_source: s.session_source, source_label: s.source_label })) return
    await this.backgroundTitle(s, () => Promise.resolve()).catch((error: unknown) => { this.deps.log(`[webui] imported session title failed for ${s.session_id}: ${(error as Error).message}`) })
  }

  /** Python `_run_background_title_update` (spawned only when `_background_title_generation_inputs` is eligible). */
  private async backgroundTitle(s: Session, put: (event: string, data: Record<string, unknown>) => Promise<void>): Promise<void> {
    const sessionId = s.session_id
    const placeholder = str(s.title).trim()
    const invalidExisting = looksInvalidGeneratedTitle(s.title)
    // A claimed CLI session still carrying its default `<Source> Session` title is retitled like a new chat (TAL-256).
    const defaultTitle = (session: Session): boolean => looksLikeDefaultCliTitle({ title: session.title, source_tag: session.source_tag, raw_source: session.raw_source, session_source: session.session_source, source_label: session.source_label })
    const eligible = ['Untitled', 'New Chat', ''].includes(placeholder) || placeholder === titleFrom(s.messages, '') || invalidExisting || defaultTitle(s)
    const [userText, assistantText] = firstExchangeSnippets(s.messages)
    // Python `_put_title_status`: empty reason/title/raw_preview keys are omitted.
    const status = async (status: string, reason = '', title = '', rawPreview = ''): Promise<void> => {
      await put('title_status', { session_id: sessionId, status, ...(reason ? { reason } : {}), ...(title ? { title } : {}), ...(rawPreview ? { raw_preview: rawPreview } : {}) })
    }
    // Python ran the adaptive refresh only when the first-title job was not eligible.
    if (!eligible || (s.llm_title_generated && !invalidExisting) || !userText || !assistantText) { await this.refreshTitle(s, put, status); return }
    if (s.manual_title) { (await status('skipped', 'manual_title', placeholder)); return }
    // A missing config.yaml reads as `{}` (enabled); an unreadable one cannot confirm the user has not opted out.
    const cfg = await this.deps.profileConfig?.(s.profile ?? null)
    if (!cfg) { (await status('skipped', 'config_unavailable', placeholder)); return }
    if (!titleGenerationEnabled(cfg)) { (await status('skipped', 'title_generation_disabled', placeholder)); return }
    const generated = await this.llmTitle(s, userText, assistantText)
    const { status: llmStatus, rawPreview } = generated
    if (llmStatus === 'read_only') { (await status('skipped', 'read_only', placeholder)); return }
    let next = generated.title
    let source = llmStatus
    if (!next) {
      const fallback = fallbackTitleFromExchange(userText, assistantText)
      if (fallback && !isGenericFallbackTitle(fallback)) { next = fallback; source = 'fallback' }
    }
    const fallbackReason = source === 'fallback' && llmStatus ? `local_summary:${llmStatus}` : 'local_summary'
    let current: Session = s
    try { current = (await this.deps.store.get(sessionId)) } catch {
      // A session deleted while the title prompt ran stays deleted.
      if ((await this.deps.store.wasDeleted(sessionId))) return
      current = s
    }
    if ((await this.deps.service().isReadOnly(current))) { (await status('skipped', 'read_only', str(current.title).trim())); return }
    let effective = str(current.title).trim()
    let wrote = false
    if (next) {
      const stillAuto = effective === placeholder || ['Untitled', 'New Chat', ''].includes(effective) || effective === titleFrom(current.messages, '') || looksInvalidGeneratedTitle(current.title) || defaultTitle(current)
      if (current.manual_title || !stillAuto) { (await status('skipped', 'manual_title', effective)); return }
      if (next !== effective) {
        current.title = next
        markSessionTitleGenerated(current)
        await this.deps.store.save(current, { touchUpdatedAt: false })
        // Python `sync_session_title` after generation: the state.db row follows when `sync_to_insights` is on.
        await this.deps.syncTitle?.(current)
        this.deps.events.publish('title', { profile: current.profile, sessionId })
        effective = next
        wrote = true
      }
    }
    if (wrote) {
      await status(source, source === 'fallback' ? fallbackReason : llmStatus, effective, rawPreview)
      await put('title', { session_id: sessionId, title: effective })
    } else (await status('skipped', source || 'unchanged', effective, rawPreview))
  }

  /**
   * Python `_maybe_schedule_title_refresh` + `_run_background_title_refresh`: every N exchanges a generated title is
   * regenerated from the latest exchange; a manual title is never touched.
   */
  private async refreshTitle(s: Session, put: (event: string, data: Record<string, unknown>) => Promise<void>, status: (status: string, reason?: string, title?: string, rawPreview?: string) => Promise<void>): Promise<void> {
    const every = this.deps.titleRefreshEvery?.() ?? 0
    const exchanges = countExchanges(s.messages)
    if (every <= 0 || exchanges <= 0 || exchanges % every !== 0) return
    const [userText, assistantText] = latestExchangeSnippets(s.messages)
    if (!userText || !assistantText) return
    // Admission is released before title work, so an earlier turn's refresh may still be running: refreshes apply in
    // turn order and each reads the title its predecessor wrote.
    const sessionId = s.session_id
    const run = (this.titleRefreshes.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(async () => { await this.applyTitleRefresh(sessionId, s, userText, assistantText, put, status); })
    this.titleRefreshes.set(sessionId, run)
    try { await run } finally { if (this.titleRefreshes.get(sessionId) === run) this.titleRefreshes.delete(sessionId) }
  }

  private async applyTitleRefresh(sessionId: string, s: Session, userText: string, assistantText: string, put: (event: string, data: Record<string, unknown>) => Promise<void>, status: (status: string, reason?: string, title?: string, rawPreview?: string) => Promise<void>): Promise<void> {
    const read = async (): Promise<Session> => { try { return (await this.deps.store.get(sessionId)) } catch { return s } }
    const latest = (await read())
    const placeholder = str(latest.title).trim()
    if (['Untitled', 'New Chat', ''].includes(placeholder) || latest.manual_title || !latest.llm_title_generated) return
    const cfg = await this.deps.profileConfig?.(latest.profile ?? null)
    if (!cfg || !titleGenerationEnabled(cfg)) { (await status('refresh_skipped', cfg ? 'title_generation_disabled' : 'config_unavailable', placeholder)); return }
    const { title: next, status: llmStatus, rawPreview } = await this.llmTitle(latest, userText, assistantText)
    if (!next) { (await status('refresh_skipped', llmStatus || 'empty', placeholder, rawPreview)); return }
    const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalize(next) === normalize(placeholder)) { (await status('refresh_skipped', 'same_title', placeholder, rawPreview)); return }
    const current = (await read())
    // The user may have renamed the session while the title prompt ran.
    if (current.manual_title || str(current.title).trim() !== placeholder) { (await status('skipped', 'manual_title', str(current.title).trim())); return }
    if ((await this.deps.service().isReadOnly(current))) { (await status('refresh_skipped', 'read_only', str(current.title).trim())); return }
    current.title = next
    markSessionTitleGenerated(current)
    await this.deps.store.save(current, { touchUpdatedAt: false })
    await this.deps.syncTitle?.(current)
    this.deps.events.publish('title', { profile: current.profile, sessionId })
    await status('refreshed', llmStatus, next, rawPreview)
    await put('title', { session_id: sessionId, title: next })
  }

  // ── cancel / steer ───────────────────────────────────────────────────────

  /**
   * Python `cancel_stream`: persist the partial, mark cancelled, interrupt the Agent, release admission. `withdrawn` is the
   * `steer_withdrawn` (stopped) this Stop emitted, for the cancel response (TAL-426).
   */
  async cancel(streamId: string): Promise<{ cancelled: boolean; withdrawn: SteerWithdrawn[] }> {
    const ownerCancelled = await this.deps.service().owner?.cancel(streamId)
    if (ownerCancelled !== null && ownerCancelled !== undefined) return { cancelled: ownerCancelled, withdrawn: [] }
    // TAL-899: the user's Stop holds automatic turns, even one that lands after `done`, unless a newer turn already
    // took the session: a late or retried Stop for a turn the user followed holds nothing.
    const owner = this.registry.ownerSessionId(streamId) ?? this.registry.activeRuns.get(streamId)?.session_id
    if (owner && this.registry.writebackOwners.get(owner) === streamId) {
      this.stopHeld.add(owner)
      try {
        const session = (await this.deps.store.get(owner))
        session.automatic_turns_stop_held = true
        await this.deps.store.save(session, { touchUpdatedAt: false })
      } catch (error) {
        this.deps.log(`[webui] WARNING: failed to persist Stop hold for session ${owner}; interrupting with the in-memory hold: ${(error as Error).message}`)
      }
    }
    return (await this.stop(streamId))
  }

  private async stop(streamId: string): Promise<{ cancelled: boolean; withdrawn: SteerWithdrawn[] }> {
    const channel = this.registry.peek(streamId)
    const run = this.registry.activeRuns.get(streamId)
    if (!channel && !run) return { cancelled: false, withdrawn: [] }
    // Python popped the run before its title work: a cancel that lands after `done` (while the title prompts still run)
    // is not a cancellation, so it neither journals a `cancel` frame nor marks the completed run interrupted.
    if (!run && this.settledStreams.has(streamId)) return { cancelled: false, withdrawn: [] }
    const sessionId = this.registry.ownerSessionId(streamId) ?? run?.session_id ?? null
    this.registry.cancelled.add(streamId)
    if (run) { run.phase = 'cancelling'; run.cancelled_at = this.deps.now() }
    // Python `_finalize_webui_steers` drained the Agent's pending steer text at cancel time: the interrupt reply
    // carries it so queued steers settle as consumed / leftover before the terminal row.
    // A duplicate Stop (another tab, a retried request) shares the first interrupt: its snapshot is the boundary, and a
    // later interrupt finds the run already unwinding.
    let interrupt = this.interrupts.get(streamId)
    if (!interrupt) {
      const sidecar = this.deps.sidecar()
      interrupt = sidecar ? sidecar.call('chat.interrupt', { stream_id: streamId }, { timeoutMs: 5_000 }).catch(() => null) : Promise.resolve(null)
      this.interrupts.set(streamId, interrupt)
    }
    const reply = await interrupt
    const leftover = str(reply?.pending_steer)
    const checkpoint = reply?.checkpoint ?? null
    // Settle the steers first so the persisted cancel carries every consumed one.
    // TAL-424: a Stop withdraws the steers the Agent never took, with their text, and starts nothing after.
    await this.steerRewrites.get(streamId)
    const steerEvents = (this.steers.get(streamId) ?? []).length ? this.finalizeSteers(streamId, leftover, 'stopped').events : []
    if (sessionId) {
      let current: Session | null = null
      try { current = (await this.deps.store.get(sessionId)) } catch { current = null }
      if (current?.active_stream_id === streamId) {
        await this.finalizeCancelled(current, streamId, run?.ephemeral, checkpoint)
      }
    }
    // The worker may already have written its terminal row while the interrupt was in flight; the stream is then
    // gone from the registry and this path must not add a second one.
    if (channel && this.registry.streams.has(streamId)) {
      const writer = this.writers.get(streamId) ?? null
      const emit = async (event: string, data: Record<string, unknown>): Promise<void> => {
        let eventId: string | null = null
        if (writer) { try { eventId = (await writer.appendSseEvent(event, data)).event_id } catch { eventId = null } }
        channel.put([event, data, eventId])
      }
      for (const [event, data] of steerEvents) (await emit(event, data))
      this.runStatuses.delete(streamId)
      await emit('run_status', { session_id: sessionId, status: null })
      await emit('cancel', (await this.cancelFrame(sessionId)))
      this.registry.streams.delete(streamId)
      this.registry.liveIds.delete(streamId)
    }
    this.abortControllers.get(streamId)?.abort()
    const withdrawn = steerEvents.filter(([event]) => event === 'steer_withdrawn').map(([, data]) => data as SteerWithdrawn)
    return { cancelled: true, withdrawn }
  }

  /**
   * TAL-460: a user's message never joins a background turn. That turn stops quietly (`finalizeCancelled`) and its worker
   * unwinds before the user's turn is admitted, so two Agent runs never share the session. True when one was stopped.
   */
  async yieldBackgroundTurn(sessionId: string): Promise<boolean> {
    const streamId = this.registry.activeRunStreamForSession(sessionId)
    if (!streamId || this.registry.activeRuns.get(streamId)?.origin !== 'background') return false
    await this.stop(streamId)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([this.workers.get(streamId), new Promise((resolve) => { timer = setTimeout(resolve, BACKGROUND_UNWIND_WAIT_MS) })])
    clearTimeout(timer)
    return true
  }

  async steer(sessionId: string, text: string, displayText: string, steerId: string): Promise<Record<string, unknown>> {
    let s: Session | null = null
    try { s = (await this.deps.store.get(sessionId, { metadataOnly: true })) } catch { s = null }
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
    return this.withSteerChain(activeStreamId, sessionId, () => this.steerInto(sidecar, sessionId, activeStreamId, text, displayText, steerId))
  }

  private async steerInto(sidecar: SidecarLike, sessionId: string, activeStreamId: string, text: string, displayText: string, steerId: string): Promise<Record<string, unknown>> {
    const record: SteerRecord = { steer_id: steerId, session_id: sessionId, stream_id: activeStreamId, text, display_text: displayText || text, created_at: this.deps.now(), state: 'pending', can_redirect: false }
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
    let result: { accepted: boolean; fallback?: string | null | undefined; can_redirect?: boolean | undefined }
    try {
      result = await sidecar.call('chat.steer', { stream_id: activeStreamId, text })
    } catch {
      withdraw()
      return { accepted: false, fallback: 'steer_error', stream_id: activeStreamId }
    }
    // An accepted steer whose turn finalised while the reply was in flight was already reported by that finalisation.
    if (!result.accepted) withdraw()
    else {
      record.can_redirect = result.can_redirect === true
      // TAL-424: every client shows it until the Agent takes it (unless it already did while the reply was in flight).
      if (this.steers.get(activeStreamId)?.includes(record)) (await this.emitToSession(sessionId, 'steer_pending', this.pendingSteerView(record)))
    }
    return { accepted: result.accepted, fallback: result.accepted ? null : (result.fallback ?? 'not_running'), stream_id: activeStreamId, steer_id: steerId }
  }

  /** Python `_webui_steer_events_before` for terminal frames: cancel/apperror flush consumed steers and leftovers first. */
  private takeSteerEventsBefore(streamId: string, event: string): [string, Record<string, unknown>][] {
    if (event !== 'cancel' && event !== 'apperror') return []
    if (!(this.steers.get(streamId) ?? []).length) return []
    return this.finalizeSteers(streamId, '', 'stopped').events
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

  private consumedSteerPayload(record: SteerRecord, opts: { redirected?: boolean } = {}): Record<string, unknown> {
    const consumedAt = this.deps.now()
    const afterToolCallId = this.lastCompletedTool.get(record.stream_id) ?? null
    const consumed = this.consumedSteers.get(record.stream_id) ?? []
    if (!consumed.some((c) => c.steer_id === record.steer_id)) {
      consumed.push({ steer_id: record.steer_id, text: record.display_text || record.text, agent_text: record.text, submitted_at: record.created_at, consumed_at: consumedAt, after_tool_call_id: afterToolCallId, ...(opts.redirected ? { redirected: true } : {}) })
      this.consumedSteers.set(record.stream_id, consumed)
    }
    return { steer_id: record.steer_id, session_id: record.session_id, stream_id: record.stream_id, display_text: record.display_text, created_at: record.created_at, agent_text: record.text, text: record.display_text || record.text, consumed_at: consumedAt, after_tool_call_id: afterToolCallId }
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
      let agentRow = agentRows.find((i) => agentSteerText(s.messages[i]!) === steer.agent_text.trim()) ?? agentRows[0]
      // A Send now redirect is recorded as a plain user row of the turn: that row becomes the steer too.
      if (steer.redirected) {
        const prompt = s.messages.findIndex((m) => m._turn_id === streamId && m.role === 'user' && !m._steer)
        const own = s.messages.findIndex((m, i) => i > prompt && m._turn_id === streamId && m.role === 'user' && !m._steer && messageText(m.content).trim() === steer.agent_text.trim())
        // Never another steer's row: without its own correction row (the Agent joins two redirects) it gets a new one.
        agentRow = own >= 0 ? own : undefined
      }
      if (agentRow === undefined) s.messages.splice(steerInsertIndex(s.messages, streamId, steer.after_tool_call_id), 0, row)
      else s.messages[agentRow] = row
      boundary = steer.consumed_at
    }
    return boundary
  }

  /** A steer is saved as it enters the stream, so a reload mid-turn already has it; the terminal save re-places it. */
  private async saveConsumedSteers(sessionId: string, streamId: string): Promise<void> {
    let s: Session
    try { s = (await this.deps.store.get(sessionId)) } catch { return }
    if (s.active_stream_id !== streamId || this.placeConsumedSteers(s, streamId, s.pending_started_at) === null) return
    try { (await this.deps.store.save(s, { touchUpdatedAt: false })) } catch (error) {
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

  /**
   * Terminal steer bookkeeping: the records the Agent no longer holds are consumed; the rest it never took are either
   * `stopped` (withdrawn with their text for the composer) or returned as one `followup` turn's texts (TAL-424).
   */
  private finalizeSteers(streamId: string, leftoverText: string, mode: 'stopped' | 'followup'): { events: [string, Record<string, unknown>][]; leftovers: string[] } {
    const records = this.steers.get(streamId) ?? []
    this.steers.delete(streamId)
    // Text that ends with none of these steers is another surface's: the Agent took every one of them.
    const start = TurnRunner.pendingSteerSuffixStart(records, leftoverText) ?? records.length
    const consumed = records.slice(0, start)
    const left = records.slice(start)
    const matched = left.map((r) => r.text).join('\n')
    const unmatched = matched ? leftoverText.slice(0, leftoverText.length - matched.length).replace(/\n+$/, '') : leftoverText
    const events: [string, Record<string, unknown>][] = consumed.map((r) => ['steer_consumed', this.consumedSteerPayload(r)])
    for (const r of left) events.push(['steer_withdrawn', { steer_id: r.steer_id, reason: mode, text: r.display_text }])
    if (mode === 'followup') return { events, leftovers: [...(unmatched ? [unmatched] : []), ...left.map((r) => r.text)] }
    if (unmatched) events.push(['steer_withdrawn', { steer_id: null, reason: 'stopped', text: unmatched }])
    return { events, leftovers: [] }
  }

  /**
   * TAL-424: the steers a finished turn never took go on as one follow-up turn, sent once by the server for every client.
   * Should another turn already hold the session, they steer into that one instead, so no text is lost.
   */
  private async startSteerFollowUp(sessionId: string, texts: string[]): Promise<void> {
    if (!texts.length) return
    let s: Session
    try { s = (await this.deps.store.get(sessionId)) } catch { return }
    const msg = texts.join('\n')
    const started = (await this.startServerTurn(s, { msg }))
    if (!started._status || started._status < 400) return
    if (started._status === 409 && started.active_stream_id) {
      void this.steer(sessionId, msg, msg, `steer-${randomUUID()}`).then((r) => {
        if (r.accepted !== true) this.deps.log(`[webui] WARNING: steer follow-up for ${sessionId} was not accepted (${str(r.fallback)}); text: ${msg.slice(0, 200)}`)
      })
      return
    }
    this.deps.log(`[webui] WARNING: steer follow-up for ${sessionId} not started (${String(started._status)}): ${str(started.error)}`)
  }

  /**
   * TAL-396 (Agent gateway `_post_turn_goal_continuation`): after every turn settles, the Agent's GoalManager judges it
   * while a goal is active and the server starts the continuation turn it asks for. Any turn counts, so a resumed or
   * persisted goal picks up from the next user message. A user turn that took the session meanwhile runs first and is
   * judged next. A stopped or failed turn never gets here, so the run ends there.
   */
  private async continueGoal(s: Session, streamId: string, put: (event: string, data: Record<string, unknown>) => Promise<void>): Promise<void> {
    const sidecar = this.deps.sidecar()
    const lastResponse = lastAnswer(s.messages)
    // The Agent never drives a goal from an empty reply.
    if (!sidecar || !lastResponse) return
    const sessionId = s.session_id
    // Only a known goal turn shows progress up front; any other turn shows nothing unless a goal turns out to be active.
    const goalTurn = this.registry.goalRelated.has(streamId)
    if (goalTurn) (await put('goal', { session_id: sessionId, state: 'evaluating', message: 'Evaluating goal progress…', message_key: 'goal_evaluating_progress' }))
    let decision: SidecarResult<'goals.evaluate'>
    try {
      // The workspace the turn ran in, unrecovered: the Agent pauses the goal rather than run its gates anywhere else.
      this.deps.service().assertWritable(s)
      decision = await sidecar.call('goals.evaluate', { session_id: sessionId, profile_home: this.deps.profileHome(s.profile), last_response: lastResponse, user_initiated: true, workspace: str(s.workspace) || undefined })
    } catch (error) {
      this.deps.log(`[webui] WARNING: goal evaluation failed for ${sessionId}: ${(error as Error).message}`)
      if (goalTurn) (await put('goal', { session_id: sessionId, state: 'idle', decision: 'error', message: '' }))
      return
    }
    // The judgement moved the goal on (turns, park, pause, done); an inactive one only matters if a goal still shows.
    if (decision.verdict !== 'inactive' || this.goals.view(sessionId)) await this.refreshGoal(s, put)
    if (!goalTurn && decision.verdict === 'inactive') return
    const prompt = str(decision.continuation_prompt).trim()
    const proceed = decision.should_continue && Boolean(prompt)
    const status = { message: decision.message, message_key: decision.message_key, message_args: decision.message_args ?? [], decision: decision.verdict }
    if (!proceed) { (await put('goal', { session_id: sessionId, state: 'idle', ...status })); return }
    let current: Session
    try { current = (await this.deps.store.get(sessionId)) } catch { return }
    const started = (await this.startServerTurn(current, { msg: prompt, goalRelated: true }))
    // TAL-899: a Stop, even one after the answer, holds the continuation; the user's next turn is judged instead.
    if (started.held) { (await put('goal', { session_id: sessionId, state: 'idle', decision: 'held', message: '' })); return }
    await put('goal', { session_id: sessionId, state: 'continuing', ...status })
    if (started._status === 409 && started.active_stream_id) { this.registry.goalRelated.add(started.active_stream_id); return }
    if (started._status !== undefined && started._status >= 400) {
      this.deps.log(`[webui] WARNING: goal continuation for ${sessionId} not started (${String(started._status)}): ${str(started.error)}`)
      await put('goal', { session_id: sessionId, state: 'idle', decision: 'error', message: '' })
      return
    }
    await put('goal_continue', { session_id: sessionId, state: 'continuing', continuation_prompt: prompt, text: prompt, stream_id: str(started.stream_id), ...status })
  }

  /** The Agent's pending steer text settles which steers it has taken: those become `steer_consumed` and their rows. */
  private async settleConsumedSteers(sessionId: string, streamId: string, pendingText: string): Promise<void> {
    for (const record of this.takeConsumedSteers(streamId, pendingText, { keepLeftovers: true })) (await this.emitToSession(sessionId, 'steer_consumed', record))
    await this.saveConsumedSteers(sessionId, streamId)
  }

  /** What every client shows for a pending steer; the server decides which actions it offers. */
  private pendingSteerView(r: SteerRecord): PendingSteer {
    const open = r.state === 'pending'
    return { steer_id: r.steer_id, text: r.display_text, submitted_at: r.created_at, state: r.state, actions: { edit: open, cancel: open, send_now: open && r.can_redirect } }
  }

  runStatus(streamId: string): RunStatus | null {
    return this.runStatuses.get(streamId) ?? null
  }

  /** TAL-1006: the start (epoch seconds) of the stream's open compression span, else null. */
  compressionStartedAt(streamId: string): number | null {
    return this.compressionSpans.get(streamId) ?? null
  }

  /** TAL-424: the active stream's pending steers, oldest first (session detail `pending_steers`). */
  pendingSteers(streamId: string): PendingSteer[] {
    return (this.steers.get(streamId) ?? []).map((r) => this.pendingSteerView(r))
  }

  private withSteerChain<T>(streamId: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.steerChains.get(streamId) ?? Promise.resolve()).then(async () => {
      await this.deps.service().getForMutation(sessionId)
      return fn()
    })
    const settled = run.catch(() => undefined).then(() => { if (this.steerChains.get(streamId) === settled) this.steerChains.delete(streamId) })
    this.steerChains.set(streamId, settled)
    return run
  }

  /**
   * A withdraw or Send now on one pending steer of the session's active stream. `rewrite` asks the sidecar to change the
   * Agent's queue and says whether it did; pending text the Agent reported meanwhile is settled after, unless the queue
   * changed (the next report then reflects it).
   */
  private async rewriteSteer<T>(sessionId: string, steerId: string, fallback: (reason: 'not_running' | 'taken' | 'failed') => T, rewrite: (sidecar: SidecarLike, streamId: string, records: SteerRecord[], index: number) => Promise<{ result: T; changed: boolean }>): Promise<T> {
    let s: Session | null = null
    try { s = (await this.deps.store.get(sessionId, { metadataOnly: true })) } catch { s = null }
    const streamId = s?.active_stream_id
    const sidecar = this.deps.sidecar()
    if (!streamId || !sidecar) return fallback('not_running')
    return this.withSteerChain(streamId, sessionId, async () => {
      const records = this.steers.get(streamId) ?? []
      const index = records.findIndex((r) => r.steer_id === steerId)
      if (index < 0 || records[index]!.state !== 'pending') return fallback('taken')
      // In flight before the sidecar call, so a pending-text report racing its reply is deferred too.
      let finished: () => void = () => undefined
      this.steerRewrites.set(streamId, new Promise<void>((resolve) => { finished = resolve }))
      let outcome: { result: T; changed: boolean } = { result: fallback('failed'), changed: false }
      try { outcome = await rewrite(sidecar, streamId, records, index) } catch { outcome = { result: fallback('failed'), changed: false } } finally {
        this.steerRewrites.delete(streamId)
        finished()
        const deferred = this.deferredPendingSteer.get(streamId)
        this.deferredPendingSteer.delete(streamId)
        if (deferred !== undefined && !outcome.changed) (await this.settleConsumedSteers(sessionId, streamId, deferred))
      }
      return outcome.result
    })
  }

  private dropSteer(streamId: string, record: SteerRecord): void {
    const records = this.steers.get(streamId)
    const index = records?.indexOf(record) ?? -1
    if (records && index >= 0) records.splice(index, 1)
  }

  /**
   * TAL-424 Edit and Cancel: take a pending steer back before the Agent takes it. `withdrawn: false` (and nothing
   * emitted) when it is unknown, already taken or being sent; a taken one then settles as consumed.
   */
  async withdrawSteer(sessionId: string, steerId: string, reason: SteerWithdrawReason): Promise<{ withdrawn: boolean; text?: string }> {
    return (await this.rewriteSteer<{ withdrawn: boolean; text?: string }>(sessionId, steerId, () => ({ withdrawn: false }), async (sidecar, streamId, records, index) => {
      const record = records[index]!
      const reply = await sidecar.call('chat.steer_withdraw', { stream_id: streamId, pending: records.map((r) => r.text), index })
      if (!reply.withdrawn) return { result: { withdrawn: false }, changed: false }
      this.dropSteer(streamId, record)
      await this.emitToSession(sessionId, 'steer_withdrawn', { steer_id: record.steer_id, reason, text: record.display_text })
      return { result: { withdrawn: true, text: record.display_text }, changed: true }
    }))
  }

  /**
   * TAL-424 Send now: deliver a pending steer with the Agent's redirect. A model request restarts with it (consumed at
   * once); during tools it goes last on the Agent's queue and stays `sending_now` until taken; with nothing live it
   * stays pending.
   */
  async sendSteerNow(sessionId: string, steerId: string): Promise<SteerSendNowResponse> {
    return (await this.rewriteSteer<SteerSendNowResponse>(sessionId, steerId, (outcome) => ({ redirected: false, outcome }), async (sidecar, streamId, records, index) => {
      const record = records[index]!
      if (!record.can_redirect) return { result: { redirected: false, outcome: 'failed' }, changed: false }
      const reply = await sidecar.call('chat.steer_now', { stream_id: streamId, pending: records.map((r) => r.text), index })
      if (!reply.withdrawn) return { result: { redirected: false, outcome: reply.reason === 'not_running' ? 'not_running' : 'taken' }, changed: false }
      if (!reply.redirected) {
        // The Agent's queue changed meanwhile, so it went back last: clients follow the new order.
        if (reply.requeued === 'last') { this.dropSteer(streamId, record); records.push(record); (await this.emitToSession(sessionId, 'steer_pending', this.pendingSteerView(record))) }
        return { result: { redirected: false, outcome: 'next_step' }, changed: true }
      }
      this.dropSteer(streamId, record)
      if (reply.delivery === 'steer') {
        record.state = 'sending_now'
        records.push(record)
        await this.emitToSession(sessionId, 'steer_pending', this.pendingSteerView(record))
      } else {
        await this.emitToSession(sessionId, 'steer_consumed', this.consumedSteerPayload(record, { redirected: true }))
        await this.saveConsumedSteers(sessionId, streamId)
      }
      return { result: { redirected: true, outcome: 'delivered' }, changed: true }
    }))
  }

  // ── approvals / clarify ──────────────────────────────────────────────────

  async respondApproval(sessionId: string, choice: string, approvalId: string, enableYolo: boolean): Promise<Record<string, unknown>> {
    if (this.deps.service().owner?.isOwned(sessionId)) {
      if (enableYolo) throw new HttpFailure(403, 'Change approval policy through the owning Agent')
      await this.deps.service().owner!.respond(sessionId, 'approval', approvalId, choice)
      return { ok: true, choice }
    }
    sessionId = (await this.deps.service().idForMutation(sessionId))
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
    try { s = (await this.deps.store.get(sessionId, { metadataOnly: true })) } catch { s = null }
    const profileHome = this.deps.profileHome(s?.profile ?? null)
    let resolved = false
    let withdrawn = false
    if (entry?._injected === true) resolved = Boolean(this.deps.pending.resolveApproval(sessionId, str(entry.approval_id)).entry)
    else if (entry) {
      if (!sidecar) return relayFailure('not running')
      try {
        const result = await sidecar.call('approval.respond', { profile_home: profileHome, session_id: sessionId, choice: choice as 'once' | 'session' | 'always' | 'deny', request_id: entry ? str(entry.request_id) || null : null })
        resolved = result.ok
      } catch (error) {
        this.deps.log(`[webui] approval relay failed for ${sessionId}: ${(error as Error).message}`)
        return relayFailure(str((error as Error).message))
      }
      if (resolved) this.deps.pending.resolveApproval(sessionId, str(entry.approval_id))
      else {
        // TAL-514: a rejected answer can mean the Agent already stopped waiting on this card; drop what it no longer holds.
        await this.reconcileApprovals(sessionId, sidecar)
        withdrawn = !this.deps.pending.hasApprovalId(sessionId, str(entry.approval_id))
      }
    }
    let yoloEnabled: boolean | undefined
    if (enableYolo) {
      // The local flag is authoritative (it is re-pushed to the sidecar at every turn start); a running sidecar must
      // still confirm now so parked Agent waiters are released before YOLO is reported as on.
      const failure = await this.withYoloLock(sessionId, async (): Promise<Record<string, unknown> | null> => {
        if (sidecar) { try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: true }) } catch (error) { return relayFailure(str((error as Error).message)) } }
        await this.deps.service().setYolo(sessionId, true)
        return null
      })
      if (failure) return failure
      yoloEnabled = true
      this.deps.pending.clearApprovals(sessionId)
    }
    if (withdrawn) return { ok: true, choice, stale_cleared: true, pending_count: this.deps.pending.approvalPending(sessionId).pending_count, ...(enableYolo ? { yolo_enabled: yoloEnabled } : {}) }
    if (!found && !this.deps.pending.hasPendingApproval(sessionId)) return { ok: true, choice, stale_cleared: true, ...(enableYolo ? { yolo_enabled: yoloEnabled } : {}) }
    return { ok: resolved || !approvalId, choice, ...(enableYolo && (resolved || !approvalId) ? { yolo_enabled: yoloEnabled } : {}) }
  }

  /** The live chat frame after approvals were withdrawn: the new queue head, or `approval_cleared` once none is left. */
  private approvalHeadFrame(sessionId: string): [string, Record<string, unknown>] {
    const { pending, pending_count } = this.deps.pending.approvalPending(sessionId)
    return pending ? ['approval', { ...pending, pending_count }] : ['approval_cleared', { session_id: sessionId, pending_count: 0 }]
  }

  /**
   * Drop mirrored approvals the Agent no longer holds; a failed read keeps them (the card stays answerable). Only
   * entries queued before the read are candidates: one the Agent parks meanwhile can be missing from its snapshot.
   */
  private async reconcileApprovals(sessionId: string, sidecar: SidecarLike): Promise<void> {
    const before = this.deps.pending.approvalRequestIds(sessionId)
    let live: Set<string>
    try {
      live = new Set((await sidecar.call('approval.pending', { session_id: sessionId })).pending.map((p) => str(p.request_id)))
    } catch (error) {
      this.deps.log(`[webui] approval reconcile failed for ${sessionId}: ${(error as Error).message}`)
      return
    }
    if (this.deps.pending.dropApprovals(sessionId, new Set(before.filter((id) => !live.has(id)))).length) (await this.emitToSession(sessionId, ...this.approvalHeadFrame(sessionId)))
  }

  private withYoloLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.yoloChains.get(sessionId) ?? Promise.resolve()).then(async () => {
      sessionId = (await this.deps.service().idForMutation(sessionId))
      return fn()
    })
    const settled = run.catch(() => undefined).then(() => { if (this.yoloChains.get(sessionId) === settled) this.yoloChains.delete(sessionId) })
    this.yoloChains.set(sessionId, settled)
    return run
  }

  /** Python `set_session_yolo_enabled(False)`: the sidecar must drop its per-session YOLO state before the local flag clears. */
  async disableYolo(sessionId: string): Promise<Record<string, unknown>> {
    sessionId = (await this.deps.service().idForMutation(sessionId))
    return this.withYoloLock(sessionId, async () => {
      const sidecar = this.deps.sidecar()
      if (sidecar) {
        try { await sidecar.call('approval.set_yolo', { session_id: sessionId, enabled: false }) } catch (error) {
          return { ok: false, error: `The Agent sidecar did not disable YOLO (${str((error as Error).message)}); retry in a moment.`, yolo_enabled: this.deps.service().yolo(sessionId).yolo_enabled === true, _status: 503 }
        }
      }
      return (await this.deps.service().setYolo(sessionId, false))
    })
  }

  /**
   * `reply` is the raw Agent reply or keyed step answers the server shapes for the prompt. `stale` when no such
   * prompt is queued; `invalid` when the answers do not fit its steps; `ok:false` without either when the sidecar
   * did not acknowledge (prompt retained).
   */
  async respondClarify(sessionId: string, clarifyId: string, reply: string | ClarifyAnswers | null): Promise<{ ok: boolean; response?: string; stale?: boolean; invalid?: boolean; error?: string }> {
    if (this.deps.service().owner?.isOwned(sessionId)) {
      await this.deps.service().owner!.respond(sessionId, 'clarify', clarifyId, reply)
      return { ok: true }
    }
    sessionId = (await this.deps.service().idForMutation(sessionId))
    const entry = this.deps.pending.peekClarify(sessionId, clarifyId)
    if (!entry) return { ok: false, stale: true }
    // TAL-887: a password-manager answer goes to the Agent and nowhere else; `null` (a decline) is its empty reply.
    const vault = isVaultPrompt(entry)
    if (vault && typeof reply === 'string') return { ok: false, invalid: true }
    const response = vault ? vaultReply(entry, reply as ClarifyAnswers | null) : reply === null ? null : clarifyReply(entry, reply)
    if (response === null) return { ok: false, invalid: true }
    // A test-hook prompt has no parked Agent waiter: it is answered here.
    if (entry._injected === true) {
      this.deps.pending.resolveClarify(sessionId, str(entry.clarify_id))
      return vault ? { ok: true } : { ok: true, response }
    }
    const sidecar = this.deps.sidecar()
    if (!sidecar) return { ok: false, error: 'The Agent sidecar is not running; retry in a moment.' }
    let ok = false
    try {
      ok = (await sidecar.call('clarify.respond', { session_id: sessionId, clarify_id: str(entry.clarify_id), response })).ok
    } catch (error) {
      if (vault) return { ok: false, error: 'The Agent sidecar did not accept the secure answer; retry in a moment.' }
      return { ok: false, error: `The Agent sidecar did not accept the answer (${str((error as Error).message)}); retry in a moment.` }
    }
    if (!ok) return { ok: false, stale: true }
    const { head } = this.deps.pending.resolveClarify(sessionId, str(entry.clarify_id))
    if (head) (await this.emitToSession(sessionId, 'clarify', head))
    return vault ? { ok: true } : { ok: true, response }
  }
}

/** The turn's answer: the last non-error assistant reply with content. */
function lastAnswer(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role !== 'assistant' || m._error) continue
    const text = messageText(m.content).trim()
    if (text) return text
  }
  return ''
}

function previousStartedAt(s: Session, run: { started_at: number } | undefined): number {
  return typeof s.pending_started_at === 'number' && s.pending_started_at > 0 ? s.pending_started_at : (run?.started_at ?? Date.now() / 1000)
}

/** A persisted Stop row: TAL-364 marks its outcome; older rows carry only their English copy. */
function isCancelMarker(m: Message): boolean {
  return m._error === true && (m._terminal_state === 'cancelled' || str(m.content).startsWith('**Task cancelled:**'))
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
