/**
 * The persisted WebUI session record (Python `api/models.Session`). The file
 * layout is preserved: metadata fields first in Python's order, then the
 * message count and scene index, then the transcript arrays, then any extra
 * keys the file carried.
 */
import { str } from '../util.js'
import { randomUUID } from 'node:crypto'
import { resolvePathLikePython } from '../workspace/paths.js'
import { turnOrigin } from './background-updates.js'

export type Message = Record<string, unknown>
export type ToolCall = Record<string, unknown>

/**
 * TAL-709: rows an earlier release appended from the Agent's in-place compaction copies. A row read from state.db that is
 * no turn's own repeats an earlier row's role, timestamp, and tool call: the same message, with pruned or tagged content.
 */
function withoutCompactionCopies(messages: Message[]): Message[] {
  const seen = new Map<string, string>()
  // A tool result is its call; any other row is the same message only with the same text (a compaction re-insert tags the
  // prompt with the workspace), so an edit that kept its timestamp stays.
  const sameAs = (m: Message): string => (m.tool_call_id ? '' : stripWorkspacePrefix(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)))
  return messages.filter((m) => {
    const key = m && typeof m === 'object' && m.timestamp !== null && m.timestamp !== undefined ? JSON.stringify([m.role, m.timestamp, m.tool_call_id ?? null]) : null
    if (key === null) return true
    if (seen.get(key) === sameAs(m) && m._state_db_row_id !== undefined && m._turn_id === undefined) return false
    if (!seen.has(key)) seen.set(key, sameAs(m))
    return true
  })
}

export const METADATA_FIELDS = [
  'session_id', 'title', 'workspace', 'created_workspace', 'model', 'model_provider', 'model_explicit_pick_signature', 'created_at', 'updated_at',
  'pinned', 'archived', 'project_id', 'profile',
  'input_tokens', 'output_tokens', 'estimated_cost',
  'cache_read_tokens', 'cache_write_tokens',
  'personality', 'active_stream_id',
  'pending_user_message', 'pending_attachments', 'pending_started_at', 'pending_user_source',
  'compression_anchor_visible_idx', 'compression_anchor_message_key',
  'compression_anchor_summary', 'pre_compression_snapshot',
  'context_engine', 'compression_anchor_engine', 'compression_anchor_mode',
  'compression_anchor_details', 'context_engine_state',
  'context_length', 'threshold_tokens', 'last_prompt_tokens',
  'post_compression_context_tokens_estimate',
  'compression_recovery', 'recommended_recovery_action',
  'compression_recovery_source_session_id', 'compression_recovery_action',
  'truncation_watermark',
  'truncation_boundary',
  'truncation_watermark_compressed',
  'state_db_seen_id',
  'state_db_seen_boundary',
  'state_db_seen_stamp',
  'state_db_lineage',
  'clear_generation',
  'intentional_shrink_generation',
  'gateway_routing', 'gateway_routing_history', 'llm_title_generated', 'manual_title',
  'parent_session_id',
  'worktree_path', 'worktree_branch', 'worktree_repo_root', 'worktree_created_at',
  'is_cli_session', 'source_tag', 'raw_source', 'session_source', 'source_label', 'read_only',
  'enabled_toolsets', 'composer_draft',
  'process_wakeup_pause',
  'share_token', 'share_created_at',
] as const

const PLACED = new Set(['message_count', 'anchor_scene_index', 'messages', 'tool_calls', 'anchor_activity_scenes', 'context_messages'])
const KNOWN = new Set<string>([...METADATA_FIELDS, ...PLACED])

const SAFE_SID_RE = /^[0-9A-Za-z_-]+$/
export function isSafeSessionId(sid: unknown): sid is string {
  return typeof sid === 'string' && sid.length > 0 && SAFE_SID_RE.test(sid)
}

export function newSessionId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

export function nowSeconds(): number {
  return Date.now() / 1000
}

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isList = (v: unknown): v is unknown[] => Array.isArray(v)
function parseNonNegativeInt(v: unknown): number | null {
  if (typeof v === 'boolean') return null
  const n = typeof v === 'number' ? Math.trunc(v) : typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? Number.parseInt(v, 10) : Number.NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

export interface SessionInit {
  session_id?: string | null
  title?: string
  workspace?: string
  created_workspace?: string | null
  model?: string | null
  model_provider?: string | null
  messages?: Message[] | null
  created_at?: number | null
  updated_at?: number | null
  tool_calls?: ToolCall[] | null
  pinned?: boolean
  archived?: boolean
  project_id?: string | null
  profile?: string | null
  [key: string]: unknown
}

export interface SessionDefaults {
  workspace: string
  model: string | null
  /** The profile's configured provider, applied to new sessions that request no model. */
  modelProvider?: string | null
}

/** Message timestamp helpers (Python `_message_timestamp`, `_is_empty_partial_activity_message`, `_last_message_timestamp`). */
export function messageTimestamp(message: unknown): number | null {
  if (!isDict(message)) return null
  const raw = message._ts ?? message.timestamp
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

export function isEmptyPartialActivityMessage(message: unknown): boolean {
  if (!isDict(message)) return false
  if (message.role !== 'assistant' || !message._partial) return false
  const content = message.content ?? ''
  if (typeof content === 'string') return !content.trim()
  if (Array.isArray(content)) {
    for (const part of content) {
      if (isDict(part)) {
        if (part.type === 'text' && str(part.text || part.content).trim()) return false
        continue
      }
      if (str(part).trim()) return false
    }
    return true
  }
  return !str(content).trim()
}

export function lastMessageTimestamp(messages: unknown, tailWindow = 8): number | null {
  if (!Array.isArray(messages)) return null
  const n = messages.length
  const start = Math.max(0, n - Math.max(1, tailWindow))
  const scan = (list: unknown[]): number | null => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i]
      if (isDict(message) && message.role === 'tool') continue
      if (isEmptyPartialActivityMessage(message)) continue
      const ts = messageTimestamp(message)
      if (ts) return ts
    }
    return null
  }
  return scan(messages.slice(start)) ?? scan(messages)
}

export function anchorSceneIndexFromRecords(records: unknown): Record<string, number> {
  if (!isDict(records)) return {}
  const index: Record<string, number> = {}
  for (const [key, value] of Object.entries(records)) {
    if (!key || !isDict(value)) continue
    const n = Number(value.updated_at ?? 0)
    index[key] = Number.isFinite(n) ? n : 0
  }
  return index
}

export function promptCacheHitPercent(cacheRead: unknown, prompt: unknown): number | null {
  const toInt = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? Math.trunc(n) : 0 }
  const read = toInt(cacheRead)
  const total = toInt(prompt)
  if (read <= 0 || total <= 0) return null
  return Math.min(100, Math.round((read / total) * 100))
}

export const CONTEXT_USAGE_FIELDS = ['context_used_tokens', 'context_window_tokens', 'context_usage_percent', 'context_threshold_percent'] as const
export type ContextUsage = Record<(typeof CONTEXT_USAGE_FIELDS)[number], number | null>

/**
 * TAL-299: the context ring's figures, computed once so every client shows the same value. The used side is the
 * post-compression estimate, else the last prompt; never the cumulative `input_tokens`. The window is the session's
 * `context_length`, else `windowFallback()` (the model catalog); there is no guessed default. Unknown stays null.
 */
export function contextUsage(fields: { post_compression_context_tokens_estimate?: unknown; last_prompt_tokens?: unknown; context_length?: unknown; threshold_tokens?: unknown }, windowFallback?: () => number | null): ContextUsage {
  const positive = (v: unknown): number | null => { const n = Math.trunc(Number(v ?? 0)); return Number.isFinite(n) && n > 0 ? n : null }
  const used = positive(fields.post_compression_context_tokens_estimate) ?? positive(fields.last_prompt_tokens)
  const window = positive(fields.context_length) ?? positive(windowFallback?.())
  const percent = (n: number | null): number | null => (n === null || window === null ? null : Math.min(100, Math.round((n / window) * 100)))
  return { context_used_tokens: used, context_window_tokens: window, context_usage_percent: percent(used), context_threshold_percent: percent(positive(fields.threshold_tokens)) }
}

/** A share's public app-relative URL (TAL-563); rows ship it so clients never rebuild it from the token. */
export const sharePath = (token: unknown): string | null => (typeof token === 'string' && token.trim() ? `/share/${encodeURIComponent(token.trim())}` : null)

export const COMPRESSION_RECOVERY_TERMINAL_STATE = 'compression_exhausted'
export const COMPRESSION_RECOVERY_ACTION_START_FOCUSED = 'start_focused_continuation'

/** Python `compression_recovery_payload_for_session`: the session's live recovery payload, or null. */
export function compressionRecoveryPayload(s: Session): Record<string, unknown> | null {
  const recovery = s.compression_recovery
  if (recovery.terminal_state !== COMPRESSION_RECOVERY_TERMINAL_STATE) return null
  return str(recovery.recommended_action || s.recommended_recovery_action) === COMPRESSION_RECOVERY_ACTION_START_FOCUSED ? recovery : null
}

export const SIDEBAR_HEAVY_METADATA_FIELDS = ['compression_anchor_summary', 'compression_anchor_details', 'context_engine_state', 'compression_recovery', 'gateway_routing_history', 'composer_draft', 'process_wakeup_pause', 'share_token'] as const

export function stripSidebarHeavyMetadata(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of SIDEBAR_HEAVY_METADATA_FIELDS) Reflect.deleteProperty(row, key)
  return row
}

export class Session {
  session_id: string
  title: string
  profile: string | null
  workspace: string
  created_workspace: string
  model: string | null
  model_provider: string | null
  model_explicit_pick_signature: string | null
  messages: Message[]
  tool_calls: ToolCall[]
  created_at: number
  updated_at: number
  pinned: boolean
  archived: boolean
  project_id: string | null
  input_tokens: number
  output_tokens: number
  estimated_cost: unknown
  cache_read_tokens: number
  cache_write_tokens: number
  personality: unknown
  active_stream_id: string | null
  pending_user_message: string | null
  pending_attachments: unknown[]
  pending_started_at: number | null
  pending_user_source: string | null
  context_messages: Message[]
  compression_anchor_visible_idx: unknown
  compression_anchor_message_key: unknown
  compression_anchor_summary: unknown
  pre_compression_snapshot: boolean
  context_engine: unknown
  compression_anchor_engine: unknown
  compression_anchor_mode: unknown
  compression_anchor_details: Record<string, unknown>
  context_engine_state: Record<string, unknown>
  context_length: unknown
  threshold_tokens: unknown
  last_prompt_tokens: unknown
  post_compression_context_tokens_estimate: number | null
  compression_recovery: Record<string, unknown>
  recommended_recovery_action: unknown
  compression_recovery_source_session_id: string | null
  compression_recovery_action: string | null
  truncation_watermark: unknown
  truncation_boundary: unknown
  /** TAL-504: the watermark marks compressed rows (newer state.db rows are new), not a cut suffix. */
  truncation_watermark_compressed: boolean
  /** TAL-493: the highest Agent state.db message id a boundary or settled turn read; newer rows are continuations. */
  state_db_seen_id: number | null
  /** TAL-493: what `state_db_seen_id` was recorded under (boundary fields, its row); a change makes the marker stale. */
  state_db_seen_boundary: string | null
  /** TAL-493: `updated_at` while the marker is current; this version's saves carry it forward, an older release's do not. */
  state_db_seen_stamp: number | null
  /** TAL-529: the state.db sessions this session's Agent wrote through compression (this id first, the live tip last). */
  state_db_lineage: string[] | null
  clear_generation: unknown
  intentional_shrink_generation: unknown
  gateway_routing: Record<string, unknown> | null
  gateway_routing_history: unknown[]
  llm_title_generated: boolean
  manual_title: boolean
  parent_session_id: string | null
  worktree_path: string | null
  worktree_branch: string | null
  worktree_repo_root: string | null
  worktree_created_at: unknown
  is_cli_session: boolean
  source_tag: unknown
  raw_source: unknown
  session_source: unknown
  source_label: unknown
  read_only: boolean
  enabled_toolsets: string[] | null
  composer_draft: Record<string, unknown>
  anchor_activity_scenes: Record<string, unknown>
  process_wakeup_pause: unknown
  share_token: string | null
  share_created_at: number | null
  /** Persisted keys the model does not know (`user_id`, `chat_id`, `last_usage`, ...). */
  extra: Record<string, unknown>

  // Runtime-only state, never serialized.
  loadedMetadataOnly = false
  metadataMessageCount: number | null = null
  anchorSceneIndex: Record<string, number>
  sidecarLoadedSignature: string | null = null
  branchSourceReadonly = false
  /** Last path the store wrote or loaded this session from. */
  path = ''

  constructor(init: SessionInit, defaults: SessionDefaults) {
    const data = { ...init }
    const take = (key: string, fallback: unknown): unknown => {
      const v = data[key]
      Reflect.deleteProperty(data, key)
      return v === undefined ? fallback : v
    }
    this.session_id = str(take('session_id', null)) || newSessionId()
    this.title = str(take('title', 'Untitled') ?? 'Untitled') || 'Untitled'
    this.profile = (take('profile', null) as string | null) ?? null
    const workspace = take('workspace', defaults.workspace)
    this.workspace = resolvePathLikePython(str(workspace) || defaults.workspace)
    const createdWorkspace = take('created_workspace', null)
    this.created_workspace = createdWorkspace ? resolvePathLikePython(str(createdWorkspace)) : this.workspace
    const model = take('model', defaults.model)
    this.model = model === null || model === undefined ? null : str(model)
    const provider = take('model_provider', null)
    this.model_provider = provider ? str(provider).trim().toLowerCase() : null
    const sig = take('model_explicit_pick_signature', null)
    this.model_explicit_pick_signature = sig ? str(sig) : null
    const messages = take('messages', null)
    this.messages = isList(messages) ? withoutCompactionCopies(messages as Message[]) : []
    const toolCalls = take('tool_calls', null)
    this.tool_calls = isList(toolCalls) ? (toolCalls as ToolCall[]) : []
    const createdAt = take('created_at', null)
    this.created_at = typeof createdAt === 'number' && createdAt ? createdAt : nowSeconds()
    const updatedAt = take('updated_at', null)
    this.updated_at = typeof updatedAt === 'number' && updatedAt ? updatedAt : nowSeconds()
    this.pinned = Boolean(take('pinned', false))
    this.archived = Boolean(take('archived', false))
    const projectId = take('project_id', null)
    this.project_id = projectId ? str(projectId) : null
    this.input_tokens = Number(take('input_tokens', 0) ?? 0) || 0
    this.output_tokens = Number(take('output_tokens', 0) ?? 0) || 0
    this.estimated_cost = take('estimated_cost', null)
    this.cache_read_tokens = Number(take('cache_read_tokens', 0) ?? 0) || 0
    this.cache_write_tokens = Number(take('cache_write_tokens', 0) ?? 0) || 0
    this.personality = take('personality', null)
    const streamId = take('active_stream_id', null)
    this.active_stream_id = streamId ? str(streamId) : null
    const pending = take('pending_user_message', null)
    this.pending_user_message = pending === null || pending === undefined ? null : str(pending)
    const attachments = take('pending_attachments', null)
    this.pending_attachments = isList(attachments) ? attachments : []
    const startedAt = take('pending_started_at', null)
    this.pending_started_at = typeof startedAt === 'number' ? startedAt : null
    const pendingSource = take('pending_user_source', null)
    this.pending_user_source = pendingSource ? str(pendingSource) : null
    const context = take('context_messages', null)
    this.context_messages = isList(context) ? withoutCompactionCopies(context as Message[]) : []
    this.compression_anchor_visible_idx = take('compression_anchor_visible_idx', null)
    this.compression_anchor_message_key = take('compression_anchor_message_key', null)
    this.compression_anchor_summary = take('compression_anchor_summary', null)
    this.pre_compression_snapshot = Boolean(take('pre_compression_snapshot', false))
    this.context_engine = take('context_engine', null)
    this.compression_anchor_engine = take('compression_anchor_engine', null)
    this.compression_anchor_mode = take('compression_anchor_mode', null)
    const details = take('compression_anchor_details', null)
    this.compression_anchor_details = isDict(details) ? details : {}
    const engineState = take('context_engine_state', null)
    this.context_engine_state = isDict(engineState) ? engineState : {}
    this.context_length = take('context_length', null)
    this.threshold_tokens = take('threshold_tokens', null)
    this.last_prompt_tokens = take('last_prompt_tokens', null)
    const post = parseNonNegativeInt(take('post_compression_context_tokens_estimate', null))
    this.post_compression_context_tokens_estimate = post && post > 0 ? post : null
    const recovery = take('compression_recovery', null)
    this.compression_recovery = isDict(recovery) ? recovery : {}
    this.recommended_recovery_action = take('recommended_recovery_action', null)
    const recoverySource = take('compression_recovery_source_session_id', null)
    this.compression_recovery_source_session_id = recoverySource ? str(recoverySource).trim() : null
    const recoveryAction = take('compression_recovery_action', null)
    this.compression_recovery_action = recoveryAction ? str(recoveryAction).trim() : null
    this.truncation_watermark = take('truncation_watermark', null)
    this.truncation_boundary = take('truncation_boundary', null)
    this.truncation_watermark_compressed = take('truncation_watermark_compressed', false) === true
    const seenId = take('state_db_seen_id', null)
    this.state_db_seen_id = typeof seenId === 'number' && Number.isFinite(seenId) ? seenId : null
    const seenBoundary = take('state_db_seen_boundary', null)
    this.state_db_seen_boundary = typeof seenBoundary === 'string' ? seenBoundary : null
    const seenStamp = take('state_db_seen_stamp', null)
    this.state_db_seen_stamp = typeof seenStamp === 'number' && Number.isFinite(seenStamp) ? seenStamp : null
    const lineage = take('state_db_lineage', null)
    this.state_db_lineage = Array.isArray(lineage) && lineage.length > 1 && lineage.every((id) => typeof id === 'string' && id) ? lineage as string[] : null
    this.clear_generation = take('clear_generation', null)
    this.intentional_shrink_generation = take('intentional_shrink_generation', null)
    const routing = take('gateway_routing', null)
    this.gateway_routing = isDict(routing) ? routing : null
    const routingHistory = take('gateway_routing_history', null)
    this.gateway_routing_history = isList(routingHistory) ? routingHistory : []
    this.llm_title_generated = Boolean(take('llm_title_generated', false))
    this.manual_title = Boolean(take('manual_title', false))
    const parent = take('parent_session_id', null)
    this.parent_session_id = parent ? str(parent) : null
    const worktreePath = take('worktree_path', null)
    this.worktree_path = worktreePath ? resolvePathLikePython(str(worktreePath)) : null
    const worktreeBranch = take('worktree_branch', null)
    this.worktree_branch = worktreeBranch ? str(worktreeBranch) : null
    const worktreeRoot = take('worktree_repo_root', null)
    this.worktree_repo_root = worktreeRoot ? resolvePathLikePython(str(worktreeRoot)) : null
    this.worktree_created_at = take('worktree_created_at', null)
    this.is_cli_session = Boolean(take('is_cli_session', false))
    this.source_tag = take('source_tag', null)
    this.raw_source = take('raw_source', null)
    this.session_source = take('session_source', null)
    this.source_label = take('source_label', null)
    this.read_only = Boolean(take('read_only', false))
    const toolsets = take('enabled_toolsets', null)
    this.enabled_toolsets = isList(toolsets) ? (toolsets as string[]) : null
    const draft = take('composer_draft', null)
    this.composer_draft = isDict(draft) ? draft : {}
    const scenes = take('anchor_activity_scenes', null)
    this.anchor_activity_scenes = isDict(scenes) ? scenes : {}
    this.anchorSceneIndex = anchorSceneIndexFromRecords(this.anchor_activity_scenes)
    const pause = take('process_wakeup_pause', null)
    this.process_wakeup_pause = isDict(pause) ? pause : null
    const shareToken = take('share_token', null)
    this.share_token = shareToken ? str(shareToken) : null
    const shareCreated = take('share_created_at', null)
    this.share_created_at = typeof shareCreated === 'number' ? shareCreated : null
    // Runtime hints and already-placed keys are never persisted twice.
    Reflect.deleteProperty(data, 'message_count')
    Reflect.deleteProperty(data, 'anchor_scene_index')
    this.extra = {}
    for (const [k, v] of Object.entries(data)) if (!k.startsWith('_') && !KNOWN.has(k)) this.extra[k] = v
  }

  /** The on-disk document in Python's key order. */
  toDocument(): Record<string, unknown> {
    const meta: Record<string, unknown> = {}
    for (const key of METADATA_FIELDS) meta[key] = (this as unknown as Record<string, unknown>)[key] ?? null
    if (this.pre_compression_snapshot) {
      meta.active_stream_id = null
      meta.pending_user_message = null
      meta.pending_attachments = []
      meta.pending_started_at = null
      meta.pending_user_source = null
    }
    meta.message_count = this.messages.length
    meta.anchor_scene_index = anchorSceneIndexFromRecords(this.anchor_activity_scenes)
    this.anchorSceneIndex = { ...(meta.anchor_scene_index as Record<string, number>) }
    meta.messages = this.messages
    meta.tool_calls = this.tool_calls
    meta.anchor_activity_scenes = this.anchor_activity_scenes
    meta.context_messages = this.context_messages
    for (const [k, v] of Object.entries(this.extra)) if (!(k in meta)) meta[k] = v
    return meta
  }

  userMessageCount(): number {
    let n = 0
    for (const m of this.messages) if (isDict(m) && m.role === 'user') n += 1
    return n
  }

  /** A prompt is in flight: its text, or attachments alone (TAL-276). */
  get hasPendingPrompt(): boolean {
    return Boolean(this.pending_user_message) || this.pending_attachments.length > 0
  }

  /** Sidebar/index row (Python `Session.compact`). */
  compact(opts: { includeRuntime?: boolean; activeStreamIds?: Set<string>; sidebarMetadataOnly?: boolean; contextLengthFor?: (model: string | null, provider: string | null) => number | null; modelOptionFor?: ((model: string | null, provider: string | null) => string | null) | undefined } = {}): Record<string, unknown> {
    const activeStreamIds = opts.activeStreamIds ?? new Set<string>()
    const hasPending = this.hasPendingPrompt
    let messageCount = this.metadataMessageCount ?? this.messages.length
    if (hasPending) messageCount = Math.max(messageCount, 1)
    let lastMessageAt: number = lastMessageTimestamp(this.messages) ?? this.updated_at
    if (hasPending && this.pending_started_at) lastMessageAt = this.pending_started_at
    const compact: Record<string, unknown> = {
      session_id: this.session_id,
      title: this.title,
      workspace: this.workspace,
      model: this.model,
      model_provider: this.model_provider,
      // TAL-301: the catalog entry the stored pair selects, on the payloads a model picker renders.
      ...(opts.modelOptionFor ? { model_option_id: opts.modelOptionFor(this.model, this.model_provider) } : {}),
      message_count: messageCount,
      created_at: this.created_at,
      updated_at: this.updated_at,
      last_message_at: lastMessageAt,
      pinned: this.pinned,
      archived: this.archived,
      project_id: this.project_id,
      profile: this.profile,
      input_tokens: this.input_tokens,
      output_tokens: this.output_tokens,
      estimated_cost: this.estimated_cost,
      cache_read_tokens: this.cache_read_tokens,
      cache_write_tokens: this.cache_write_tokens,
      cache_hit_percent: promptCacheHitPercent(this.cache_read_tokens, this.input_tokens),
      personality: this.personality,
      compression_anchor_summary: this.compression_anchor_summary,
      pre_compression_snapshot: this.pre_compression_snapshot,
      context_engine: this.context_engine,
      compression_anchor_engine: this.compression_anchor_engine,
      compression_anchor_mode: this.compression_anchor_mode,
      compression_anchor_details: this.compression_anchor_details,
      context_engine_state: this.context_engine_state,
      context_length: this.context_length,
      threshold_tokens: this.threshold_tokens,
      last_prompt_tokens: this.last_prompt_tokens,
      post_compression_context_tokens_estimate: this.post_compression_context_tokens_estimate,
      ...contextUsage(this, opts.contextLengthFor && (() => opts.contextLengthFor!(this.model, this.model_provider))),
      compression_recovery: this.compression_recovery,
      recommended_recovery_action: this.recommended_recovery_action,
      gateway_routing: this.gateway_routing,
      gateway_routing_history: this.gateway_routing_history,
      manual_title: this.manual_title,
    }
    if (this.parent_session_id) compact.parent_session_id = this.parent_session_id
    compact.created_workspace = this.created_workspace || this.workspace
    if (this.compression_recovery_source_session_id || this.compression_recovery_action) {
      compact.compression_recovery_source_session_id = this.compression_recovery_source_session_id
      compact.compression_recovery_action = this.compression_recovery_action
    }
    if (this.worktree_path) {
      compact.worktree_path = this.worktree_path
      compact.worktree_branch = this.worktree_branch
      compact.worktree_repo_root = this.worktree_repo_root
      compact.worktree_created_at = this.worktree_created_at
    }
    Object.assign(compact, {
      user_message_count: this.userMessageCount(),
      active_stream_id: this.active_stream_id,
      pending_user_message: this.pending_user_message,
      has_pending_user_message: hasPending,
      is_cli_session: this.is_cli_session,
      source_tag: this.source_tag,
      raw_source: this.raw_source,
      session_source: this.session_source,
      source_label: this.source_label,
      read_only: this.read_only,
      enabled_toolsets: this.enabled_toolsets,
      composer_draft: this.composer_draft,
      process_wakeup_pause: this.process_wakeup_pause ?? {},
      share_token: this.share_token,
      share_url: sharePath(this.share_token),
      share_created_at: this.share_created_at,
      is_streaming: opts.includeRuntime ? Boolean(this.active_stream_id && activeStreamIds.has(this.active_stream_id)) : false,
      active_turn_origin: this.active_stream_id ? turnOrigin(this.pending_user_source) : null,
    })
    if (opts.sidebarMetadataOnly) stripSidebarHeavyMetadata(compact)
    return compact
  }
}

/** Python `title_from`: first user message, attachment marker stripped, 64 chars. */
export function titleFrom(messages: unknown[], fallback = 'Untitled'): string {
  for (const m of messages) {
    if (!isDict(m) || m.role !== 'user' || isDict(m._steer)) continue
    const c = m.content
    if (c === null || c === undefined) continue
    let text = Array.isArray(c) ? c.filter((p): p is Record<string, unknown> => isDict(p) && p.type === 'text').map((p) => str(p.text)).join(' ') : str(c)
    text = stripAttachedFilesMarker(text)
    if (text) return text.slice(0, 64)
  }
  return fallback
}

// Paths are escaped like the workspace prefix (`\\` and `\]`), so a `]` in a path stays inside the line.
const ATTACHED_FILES_RE = /\n\n\[Attached files: (?:\\.|[^\]\\])+\]$/
export function stripAttachedFilesMarker(text: string): string {
  return text.replace(ATTACHED_FILES_RE, '').trim()
}

export const WORKSPACE_PREFIX_RE = /^\s*\[Workspace::v1:\s*(?:\\.|[^\]\\])+\]\s*/
const LEGACY_WORKSPACE_PREFIX_RE = /^\s*\[Workspace:[^\]]+\]\s*/

export function stripWorkspacePrefix(text: string, includeLegacy = false): string {
  const value = str(text)
  let stripped = value.replace(WORKSPACE_PREFIX_RE, '')
  if (includeLegacy && stripped === value) stripped = value.replace(LEGACY_WORKSPACE_PREFIX_RE, '')
  return stripped.trim()
}

/** Python `_collapse_adjacent_duplicate_partials`. */
export function collapseAdjacentDuplicatePartials(messages: unknown): [unknown, boolean] {
  if (!Array.isArray(messages)) return [messages, false]
  const signature = (message: Record<string, unknown>): string => {
    const tools = Array.isArray(message._partial_tool_calls) ? message._partial_tool_calls : []
    const toolSig = tools.filter(isDict).map((t) => [str(t.name), JSON.stringify(sortKeys(t.args ?? {})), Boolean(t.done), Boolean(t.is_error), str(t.preview || t.snippet)])
    return JSON.stringify([str(message.content).trim(), str(message.reasoning).trim(), toolSig])
  }
  const collapsed: unknown[] = []
  let changed = false
  let previous: string | null = null
  for (const message of messages) {
    if (isDict(message) && message._partial) {
      const sig = signature(message)
      if (previous === sig) { changed = true; continue }
      previous = sig
    } else {
      previous = null
    }
    collapsed.push(message)
  }
  return [collapsed, changed]
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isDict(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]))
  return value
}
