/**
 * Transcript settlement after an Agent turn (the core of Python
 * `_merge_display_messages_after_agent_result`, `_message_identity`,
 * `_extract_tool_calls_from_messages`, `_build_partial_message`).
 */
import { str } from '../util.js'
import type { Message } from './session.js'

export const WORKSPACE_PREFIX_RE = /^\s*\[Workspace::v1:\s*(?:\\.|[^\]\\])+\]\s*/
const LEGACY_WORKSPACE_PREFIX_RE = /^\s*\[Workspace:[^\]]+\]\s*/
const TOOL_RESULT_SNIPPET_MAX = 4000
// Python `_TOOL_ARG_CONTENT_KEYS`: file bodies, commands, and patch text keep up to the content cap; incidental args cut at 120.
export const TOOL_ARG_CONTENT_KEYS = new Set(['command', 'cmd', 'script', 'code', 'patch', 'diff', 'old_string', 'new_string', 'content', 'path', 'file_path'])
export const TOOL_ARG_CONTENT_CAP = TOOL_RESULT_SNIPPET_MAX

export const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export function escapeWorkspacePrefixPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
}

export function workspaceContextPrefix(path: string): string {
  return `[Workspace::v1: ${escapeWorkspacePrefixPath(path)}]\n`
}

export function stripWorkspacePrefix(text: string, includeLegacy = false): string {
  const value = str(text)
  let stripped = value.replace(WORKSPACE_PREFIX_RE, '')
  if (includeLegacy && stripped === value) stripped = value.replace(LEGACY_WORKSPACE_PREFIX_RE, '')
  return stripped.trim()
}

/** Python `_message_text`: flatten string or multimodal content to text. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (isDict(part)) {
        if (part.type === 'text' || 'text' in part) return str(part.text)
        // Responses-style parts may carry their text under their own type name.
        if (part.type === 'output_text' || part.type === 'input_text') return str(part[part.type])
        return ''
      }
      return str(part)
    }).filter(Boolean).join('\n')
  }
  return str(content)
}

export function messageIdentity(msg: unknown): string | null {
  if (!isDict(msg)) return null
  const role = str(msg.role)
  let text = messageText(msg.content)
  if (role === 'user') text = stripWorkspacePrefix(text, true)
  if (!text && !msg.tool_call_id && !msg.tool_calls) {
    if (msg._partial) return JSON.stringify([role, '', '', `__partial__${str(msg.reasoning).split(/\s+/).join(' ').slice(0, 200)}`])
    return null
  }
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  return JSON.stringify([role, text.split(/\s+/).join(' ').trim().slice(0, 500), str(msg.tool_call_id), JSON.stringify(sortKeysDeep(toolCalls))])
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (isDict(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key])
    return out
  }
  return value
}

export function messagesHavePrefix(messages: unknown[], prefix: unknown[]): boolean {
  if (messages.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i += 1) if (messageIdentity(messages[i]) !== messageIdentity(prefix[i])) return false
  return true
}

export function isContextCompressionMarker(msg: unknown): boolean {
  if (!isDict(msg)) return false
  if (msg._context_compression_marker || msg._compression_marker || msg._compaction_marker) return true
  const text = messageText(msg.content)
  return str(msg.role) === 'user' && text.startsWith('[CONTEXT COMPACTION]')
}

const normalizeUserText = (text: string): string => stripWorkspacePrefix(text, true).split(/\s+/).join(' ').trim()

export function looksLikeCurrentUserTurn(msg: unknown, msgText: string): boolean {
  // A persisted steer is display-only: it is never the prompt that opened a turn.
  if (!isDict(msg) || str(msg.role) !== 'user' || isDict(msg._steer)) return false
  const candidate = normalizeUserText(messageText(msg.content))
  const target = normalizeUserText(msgText)
  if (!candidate || !target) return false
  return candidate === target || candidate.startsWith(`${target}\n`) || candidate.endsWith(target)
}

function stripReplayedPrefix(existing: unknown[], candidates: unknown[]): unknown[] {
  // Drop candidates that replay the tail of the existing transcript (Python `_strip_replayed_prefix`).
  let overlap = 0
  const maxOverlap = Math.min(existing.length, candidates.length)
  for (let n = maxOverlap; n > 0; n -= 1) {
    let match = true
    for (let i = 0; i < n; i += 1) {
      if (messageIdentity(existing[existing.length - n + i]) !== messageIdentity(candidates[i])) { match = false; break }
    }
    if (match) { overlap = n; break }
  }
  return candidates.slice(overlap)
}

export function findCurrentUserTurn(messages: unknown[], msgText: string): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (looksLikeCurrentUserTurn(messages[i], msgText)) return i
  return null
}

export interface MergeOptions { source?: string; activeTurnToken?: string | null; now?: number; turnId?: string }

/** Python `_merge_display_messages_after_agent_result` (append-only display merge). */
/** Python `_assistant_message_has_final_visible_text`: a non-error assistant row carrying visible answer text. */
function assistantHasFinalVisibleText(msg: Message): boolean {
  if (msg.role !== 'assistant' || msg._error) return false
  return messageText(msg.content).trim().length > 0
}

/** Python `_assistant_reply_added_after_current_turn`: only the just-finished turn counts, never replayed history. */
export function assistantReplyAddedAfterCurrentTurn(resultMessages: Message[], previousContext: Message[], msgText: string): boolean {
  let candidates: Message[]
  if (messagesHavePrefix(resultMessages, previousContext)) candidates = resultMessages.slice(previousContext.length)
  else {
    const idx = findCurrentUserTurn(resultMessages, msgText)
    candidates = idx === null ? resultMessages : resultMessages.slice(idx + 1)
  }
  return candidates.some((m) => assistantHasFinalVisibleText(m))
}

/** Python `_session_lacks_final_assistant_answer`: the transcript ends on tool activity instead of an answer. */
export function sessionLacksFinalAssistantAnswer(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg) continue
    if (msg._error) return false
    if (isContextCompressionMarker(msg) || isDict(msg._steer)) continue
    if (msg.role === 'tool') return true
    if (msg.role === 'assistant') {
      if (assistantHasFinalVisibleText(msg)) return false
      continue
    }
    if (msg.role === 'user') return true
  }
  return true
}

/**
 * Python `_maybe_inject_max_iteration_summary_fallback`: when the Agent exhausted its tool budget its closing
 * explanation can live only in `final_response`, so it is appended as the turn's assistant answer.
 */
export function injectMaxIterationSummaryFallback(messages: Message[], finalResponse: string): Message[] {
  if (!finalResponse.trim()) return messages
  if (!sessionLacksFinalAssistantAnswer(messages)) return messages
  return [...messages, { role: 'assistant', content: finalResponse, _max_iteration_summary_fallback: true }]
}

export function mergeDisplayMessagesAfterAgentResult(previousDisplay: Message[], previousContext: Message[], resultMessages: Message[], msgText: string, opts: MergeOptions = {}): Message[] {
  const display = previousDisplay.filter((m) => !isContextCompressionMarker(m))
  const seenPartial = new Set<string>()
  const dedupedRev: Message[] = []
  for (let i = display.length - 1; i >= 0; i -= 1) {
    const m = display[i]!
    if (isDict(m) && m._partial) {
      const key = messageIdentity(m)
      if (key !== null) {
        if (seenPartial.has(key)) continue
        seenPartial.add(key)
      }
    }
    dedupedRev.push(m)
  }
  const prev = dedupedRev.reverse()
  const context = previousContext.filter((m) => !isContextCompressionMarker(m))
  const result = resultMessages.filter((m) => isDict(m))
  if (!result.length) return prev
  let candidates: Message[]
  if (messagesHavePrefix(result, context)) {
    candidates = result.slice(context.length)
    const currentUserIn = candidates.some((m) => looksLikeCurrentUserTurn(m, msgText))
    const assistantOnly = candidates.length > 0 && candidates.every((m) => isContextCompressionMarker(m) || (isDict(m) && (m.role === 'assistant' || m.role === 'tool')))
    if (!(assistantOnly && !currentUserIn)) {
      candidates = stripReplayedPrefix(prev, candidates) as Message[]
      candidates = stripReplayedPrefix(context, candidates) as Message[]
    }
  } else {
    const idx = findCurrentUserTurn(result, msgText)
    const assistantOnly = result.every((m) => isContextCompressionMarker(m) || (isDict(m) && (m.role === 'assistant' || m.role === 'tool')))
    candidates = idx !== null ? result.slice(idx) : assistantOnly ? result : []
  }
  const merged: Message[] = [...prev]
  const seen = new Set(merged.map(messageIdentity).filter((k): k is string => k !== null))
  const currentUserKey = messageIdentity({ role: 'user', content: msgText })
  const currentUserIn = candidates.some((m) => messageIdentity(m) === currentUserKey || looksLikeCurrentUserTurn(m, msgText))
  const alreadyCheckpointed = Boolean(opts.activeTurnToken) && merged.some((m) => isDict(m) && m.role === 'user' && m._active_turn_token === opts.activeTurnToken)
  if (currentUserKey !== null && !currentUserIn && !alreadyCheckpointed && candidates.some((m) => isDict(m) && (m.role === 'assistant' || m.role === 'tool'))) {
    const user: Message = { role: 'user', content: msgText, timestamp: opts.now ?? Date.now() / 1000 }
    if (opts.activeTurnToken) user._active_turn_token = opts.activeTurnToken
    if (opts.turnId) user._turn_id = opts.turnId
    if (opts.source && opts.source !== 'webui') user._source = opts.source
    let insertAt = 0
    while (insertAt < candidates.length && isContextCompressionMarker(candidates[insertAt])) insertAt += 1
    candidates = [...candidates.slice(0, insertAt), user, ...candidates.slice(insertAt)]
  }
  for (const msg of candidates) {
    if (isContextCompressionMarker(msg)) continue
    const key = messageIdentity(msg)
    const isCurrentUser = looksLikeCurrentUserTurn(msg, msgText)
    const last = merged[merged.length - 1]
    if (((key !== null && key === currentUserKey) || isCurrentUser) && last && (messageIdentity(last) === currentUserKey || looksLikeCurrentUserTurn(last, msgText))) {
      if (isDict(msg) && msg.id !== undefined && isDict(last) && last.id === undefined) last.id = msg.id
      continue
    }
    if (key !== null && isDict(msg) && msg.role === 'assistant' && last && messageIdentity(last) === key) continue
    let display: Message = msg
    if (((key !== null && key === currentUserKey) || isCurrentUser) && isDict(msg) && msg.role === 'user') {
      display = { ...msg, content: msgText }
      if (opts.source && opts.source !== 'webui') display._source = opts.source
    }
    const row = structuredClone(display)
    if (opts.turnId) row._turn_id = opts.turnId
    merged.push(row)
    if (key !== null) seen.add(key)
  }
  return merged
}

export function toolResultSnippet(raw: unknown, limit = TOOL_RESULT_SNIPPET_MAX): string {
  let text: string
  if (isDict(raw) || Array.isArray(raw)) {
    try { text = JSON.stringify(raw) } catch { text = str(raw) }
  } else text = str(raw)
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}

export function truncateToolArgs(args: unknown, limit = 6): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isDict(args)) return out
  for (const [k, v] of Object.entries(args).slice(0, limit)) {
    const s = str(v)
    const cap = TOOL_ARG_CONTENT_KEYS.has(k.toLowerCase()) ? TOOL_ARG_CONTENT_CAP : 120
    out[k] = s.length > cap ? `${s.slice(0, cap)}...` : s
  }
  return out
}

function nearestAssistantIdx(messages: unknown[], msgIdx: number): number {
  for (let i = msgIdx; i >= 0; i -= 1) if (isDict(messages[i]) && (messages[i] as Record<string, unknown>).role === 'assistant') return i
  return -1
}

/** Python `_extract_tool_calls_from_messages`. */
export function extractToolCallsFromMessages(messages: unknown[], liveToolCalls: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const toolCalls: Record<string, unknown>[] = []
  const pendingNames = new Map<string, string>()
  const pendingArgs = new Map<string, unknown>()
  const pendingAsst = new Map<string, number>()
  const toolSeq: { msgIdx: number; raw: unknown; resolved: boolean }[] = []
  messages.forEach((m, msgIdx) => {
    if (!isDict(m)) return
    if (m.role === 'assistant') {
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (isDict(part) && part.type === 'tool_use' && str(part.id)) {
            pendingNames.set(str(part.id), str(part.name))
            pendingArgs.set(str(part.id), part.input ?? {})
            pendingAsst.set(str(part.id), msgIdx)
          }
        }
      }
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isDict(tc)) continue
        const tid = str(tc.id) || str(tc.call_id)
        const fn = isDict(tc.function) ? tc.function : {}
        const name = str(fn.name)
        let args: unknown = {}
        try { args = JSON.parse(str(fn.arguments) || '{}') } catch { args = {} }
        if (tid && name) {
          pendingNames.set(tid, name)
          pendingArgs.set(tid, args)
          pendingAsst.set(tid, msgIdx)
        }
      }
    } else if (m.role === 'tool') {
      const tid = str(m.tool_call_id) || str(m.tool_use_id)
      const seq = { msgIdx, raw: m.content, resolved: false }
      if (tid) {
        const name = pendingNames.get(tid) ?? ''
        if (name && name !== 'tool') {
          toolCalls.push({ name, snippet: toolResultSnippet(m.content), tid, assistant_msg_idx: pendingAsst.get(tid) ?? -1, args: truncateToolArgs(pendingArgs.get(tid) ?? {}) })
          seq.resolved = true
        }
      }
      toolSeq.push(seq)
    }
  })
  const live = liveToolCalls.filter((tc) => isDict(tc) && str(tc.name) && tc.name !== 'clarify')
  if (live.length) {
    toolSeq.forEach((seq, i) => {
      if (seq.resolved || i >= live.length) return
      const tc = live[i]!
      toolCalls.push({ name: str(tc.name) || 'tool', snippet: toolResultSnippet(seq.raw), tid: str(tc.tid), assistant_msg_idx: nearestAssistantIdx(messages, seq.msgIdx), args: truncateToolArgs(tc.args ?? {}, 4) })
    })
  }
  return toolCalls
}

/** Python `_build_partial_message`. */
export function buildPartialMessage(contentText: string, reasoningText: string, toolCalls: unknown[], now = Date.now() / 1000): Message | null {
  let stripped = ''
  const partial = contentText.trim()
  if (partial) {
    stripped = partial.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
    stripped = stripped.replace(/<think(?:ing)?\b[^>]*>[\s\S]*/i, '').trim()
  }
  const hasReasoning = Boolean(reasoningText.trim())
  const hasTools = toolCalls.length > 0
  if (!stripped && !hasReasoning && !hasTools) return null
  const msg: Message = { role: 'assistant', content: stripped, _partial: true, timestamp: Math.trunc(now) }
  if (hasReasoning) msg.reasoning = reasoningText.trim()
  if (hasTools) msg._partial_tool_calls = [...toolCalls]
  return msg
}

export function stripXmlToolCalls(text: string): string {
  return text.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '').replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trimEnd()
}

/** Split inline `<think>` blocks out of assistant content (Python `_split_thinking_from_content`, reduced). */
export function splitThinkingFromContent(content: string, existingReasoning = ''): [string, string] {
  const parts: string[] = []
  const cleaned = content.replace(/<think(?:ing)?\b[^>]*>([\s\S]*?)<\/think(?:ing)?>/gi, (_m, inner: string) => { parts.push(inner.trim()); return '' })
  const reasoning = [existingReasoning.trim(), ...parts].filter(Boolean).join('\n\n')
  return [cleaned.replace(/^\s+/, '').trimEnd(), reasoning]
}

/**
 * Python `merge_session_messages_append_only`, bounded to its load-bearing rules: state.db rows never delete a local
 * row; rows that replay the sidecar (same role, timestamp, and content) are skipped; rows at or before the sidecar's
 * newest timestamp are already represented locally; a truncation watermark hides rows the user cut (0 blocks every
 * replay). Rows past the sidecar tail (a conversation continued from the CLI) are appended in state.db order.
 * ponytail: the Python identity memo (api_content sidecars, message ids, workspace-prefix normalisation) is not ported;
 * add it if a mixed WebUI/CLI transcript shows duplicated turns.
 */
export function mergeSessionMessagesAppendOnly(sidecar: Message[], state: Message[], opts: { truncationWatermark?: unknown } = {}): Message[] {
  const watermark = Number(opts.truncationWatermark)
  const hasWatermark = opts.truncationWatermark !== null && opts.truncationWatermark !== undefined && Number.isFinite(watermark)
  if (!state.length) return sidecar
  const ts = (m: Message): number | null => { const n = Number(m.timestamp); return Number.isFinite(n) ? n : null }
  const key = (m: Message): string => `${String(m.role)}\0${String(ts(m) ?? '')}\0${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)}`
  if (!sidecar.length) {
    if (!hasWatermark) { const seen = new Set<string>(); return state.filter((m) => { const k = key(m); if (seen.has(k)) return false; seen.add(k); return true }) }
    if (watermark === 0) return []
    return state.filter((m) => { const t = ts(m); return t !== null && t > watermark })
  }
  const seen = new Set(sidecar.map(key))
  let maxSidecar: number | null = null
  for (const m of sidecar) { const t = ts(m); if (t !== null && (maxSidecar === null || t > maxSidecar)) maxSidecar = t }
  const merged = [...sidecar]
  for (const m of state) {
    const k = key(m)
    if (seen.has(k)) continue
    const t = ts(m)
    if (maxSidecar !== null && t !== null && t <= maxSidecar) continue
    if (hasWatermark && t !== null && t <= watermark) continue
    seen.add(k)
    merged.push(m)
  }
  return merged
}

function toolCallId(tc: unknown): string {
  if (!isDict(tc)) return ''
  return str(tc.id) || str(tc.call_id)
}

const API_SAFE_MSG_KEYS = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'refusal', 'reasoning_content'])
const OOB_USER_MESSAGE_BLOCK_RE = /\[OUT-OF-BAND\s+USER\s+MESSAGE(?:\s*(?:—|-)\s*[\s\S]*?)?\]\s*?[\s\S]*?\[\/OUT-OF-BAND\s+USER\s+MESSAGE\]/gi

/** Python `_is_reasoning_only_assistant_message`: a display-only Thinking card with no visible reply. */
function isReasoningOnlyAssistant(msg: Message): boolean {
  if (msg.role !== 'assistant' || (Array.isArray(msg.tool_calls) && msg.tool_calls.length)) return false
  if (messageText(msg.content).trim()) return false
  if (str(msg.reasoning ?? msg.reasoning_content).trim()) return true
  return Array.isArray(msg.content) && msg.content.length > 0 && msg.content.every((part) => part && typeof part === 'object' && ['reasoning', 'thinking'].includes(String((part as { type?: unknown }).type)))
}

function stripOobBlocks(content: unknown): unknown {
  if (typeof content === 'string') return content.replaceAll(OOB_USER_MESSAGE_BLOCK_RE, '')
  if (Array.isArray(content)) return content.map(stripOobBlocks)
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' || Array.isArray(v) || (v && typeof v === 'object') ? stripOobBlocks(v) : v]))
  return content
}

/**
 * Python `_sanitize_messages_for_api`: the model-facing history. Drops display-only rows (`_error`, empty `_partial`,
 * reasoning-only assistants), orphaned tool rows and unanswered tool calls, keeps only API-safe keys, strips consumed
 * out-of-band blocks, and keeps a cancelled (`_recovered`) user prompt only where it separates two assistant turns —
 * otherwise the neighbours fuse cleanly or the prompt is stale, and replaying it would answer it again.
 */
export function sanitizeMessagesForApi(messages: Message[]): Message[] {
  const validToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue
    for (const tc of msg.tool_calls) { const id = toolCallId(tc); if (id) validToolCallIds.add(id) }
  }
  const clean: Message[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (isReasoningOnlyAssistant(msg)) continue
    // The Agent already received a steer mid-turn; its persisted row is display-only.
    if (msg._error || isDict(msg._steer)) continue
    if (msg._partial && !messageText(msg.content).trim()) continue
    const recovered = Boolean(msg._recovered) && msg.role === 'user'
    if (msg.role === 'tool') { const tid = str(msg.tool_call_id); if (!tid || !validToolCallIds.has(tid)) continue }
    const sanitized = Object.fromEntries(Object.entries(msg).filter(([k]) => API_SAFE_MSG_KEYS.has(k)))
    if (Array.isArray(sanitized.tool_calls) && !sanitized.tool_calls.length) Reflect.deleteProperty(sanitized, 'tool_calls')
    if (recovered) sanitized._recovered = true
    if ('content' in sanitized) sanitized.content = stripOobBlocks(sanitized.content)
    if (sanitized.role) clean.push(sanitized)
  }
  const answered = new Set(clean.filter((m) => m.role === 'tool').map((m) => str(m.tool_call_id)).filter(Boolean))
  const filtered: Message[] = []
  for (let msg of clean) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const kept = msg.tool_calls.filter((tc) => answered.has(toolCallId(tc)))
      if (!kept.length) {
        msg = Object.fromEntries(Object.entries(msg).filter(([k]) => k !== 'tool_calls'))
        if (!messageText(msg.content).trim()) continue
      } else msg = { ...msg, tool_calls: kept }
    }
    filtered.push(msg)
  }
  const final: Message[] = []
  for (let i = 0; i < filtered.length; i += 1) {
    let msg = filtered[i]!
    if (msg._recovered && msg.role === 'user') {
      const prevRole = final.length ? final[final.length - 1]!.role : null
      const nextRole = filtered[i + 1]?.role ?? null
      if (!(prevRole === 'assistant' && nextRole === 'assistant')) continue
      msg = Object.fromEntries(Object.entries(msg).filter(([k]) => k !== '_recovered'))
    }
    final.push(msg)
  }
  return final
}
