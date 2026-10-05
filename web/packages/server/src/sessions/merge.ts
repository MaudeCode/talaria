/**
 * Transcript settlement after an Agent turn (the core of Python
 * `_merge_display_messages_after_agent_result`, `_message_identity`,
 * `_extract_tool_calls_from_messages`, `_build_partial_message`).
 */
import { buildActiveTurnToken } from '../redact.js'
import { str } from '../util.js'
import { stripAttachedFilesMarker, type Message } from './session.js'
import type { MediaProjection } from '../workspace/media-refs.js'
import { decidedEditDiff, toolEditDiff, toolName } from './tool-display.js'

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
export function isReasoningBlock(part: Record<string, unknown>): boolean {
  return part.type === 'reasoning' || part.type === 'thinking'
}

/** The text of a structured reasoning or thinking content block. */
export function reasoningBlockText(part: Record<string, unknown>): string {
  return str(part.text || part.thinking || part.reasoning)
}

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (isDict(part)) {
        // Structured reasoning is never reply text; the scene reads it as reasoning.
        if (isReasoningBlock(part)) return ''
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

export function messageIdentity(msg: unknown, textLimit = 500): string | null {
  if (!isDict(msg)) return null
  const role = str(msg.role)
  let text = messageText(msg.content)
  if (role === 'user') {
    const typed = userPromptText(text)
    // An attachment-only prompt has no typed text; its whole attached-files line (never truncated) tells one such turn
    // from the next.
    const line = typed ? '' : stripWorkspacePrefix(text, true)
    if (line) return JSON.stringify([role, line, '', '[]'])
    text = typed
  }
  if (!text && !msg.tool_call_id && !msg.tool_calls) {
    if (msg._partial) return JSON.stringify([role, '', '', `__partial__${str(msg.reasoning).split(/\s+/).join(' ').slice(0, 200)}`])
    return null
  }
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  return JSON.stringify([role, text.split(/\s+/).join(' ').trim().slice(0, textLimit), str(msg.tool_call_id), JSON.stringify(sortKeysDeep(toolCalls))])
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

const PRESERVED_TASK_LIST_PREFIX = '[your active task list was preserved across context compression]'
const hasPrefix = (text: string, prefix: string): boolean => text.slice(0, prefix.length).toLowerCase() === prefix

export type MarkerKind = 'context_compaction' | 'preserved_task_list'

/**
 * TAL-305: the one rule for the marker rows the Agent writes around context compaction. A flagged row, or a user or
 * assistant row starting `[context compaction`, is a compaction summary; a user row starting with the preserved-task-list
 * line is that list. Both ignore case and leading whitespace; prose that merely mentions compaction is no marker.
 */
export function markerKind(msg: unknown): MarkerKind | null {
  if (!isDict(msg)) return null
  if (msg._context_compression_marker || msg._compression_marker || msg._compaction_marker) return 'context_compaction'
  const role = str(msg.role)
  const text = messageText(msg.content).trimStart()
  if (role === 'user' && hasPrefix(text, PRESERVED_TASK_LIST_PREFIX)) return 'preserved_task_list'
  if ((role === 'user' || role === 'assistant') && hasPrefix(text, '[context compaction')) return 'context_compaction'
  return null
}

export function isContextCompressionMarker(msg: unknown): boolean {
  return markerKind(msg) === 'context_compaction'
}

/**
 * TAL-305: stamps `_marker_kind` on marker rows, and `_marker_body` (the list without its marker line) on a preserved
 * task list, so clients render a marker card instead of a message. Returns copies; stored rows are untouched.
 */
export function withMarkerKinds<T>(messages: T[]): T[] {
  return messages.map((m) => {
    const kind = markerKind(m)
    if (!kind || !isDict(m)) return m
    if (kind === 'context_compaction') return { ...m, _marker_kind: kind }
    const body = messageText(m.content).trim().slice(PRESERVED_TASK_LIST_PREFIX.length).trim()
    return { ...m, _marker_kind: kind, _marker_body: body }
  })
}

/** A user prompt as the user typed it: without the workspace prefix and the attached-files line the server adds. */
const userPromptText = (text: string): string => stripWorkspacePrefix(stripAttachedFilesMarker(text), true)
const normalizeUserText = (text: string): string => userPromptText(text).split(/\s+/).join(' ').trim()

export function looksLikeCurrentUserTurn(msg: unknown, msgText: string): boolean {
  // A persisted steer is display-only: it is never the prompt that opened a turn.
  if (!isDict(msg) || str(msg.role) !== 'user' || isDict(msg._steer)) return false
  const candidate = normalizeUserText(messageText(msg.content))
  const target = normalizeUserText(msgText)
  // An attachment-only prompt (TAL-276) has no text: the Agent's row for it carries none either.
  if (!target) return !candidate
  if (!candidate) return false
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

/** `attachments`: the turn's files, which let an attachment-only prompt (no text to match) open its own user row (TAL-276). */
export interface MergeOptions { source?: string; activeTurnToken?: string | null; now?: number; turnId?: string; attachments?: unknown[] }

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
  const currentUserIn = candidates.some((m) => (currentUserKey !== null && messageIdentity(m) === currentUserKey) || looksLikeCurrentUserTurn(m, msgText))
  const alreadyCheckpointed = Boolean(opts.activeTurnToken) && merged.some((m) => isDict(m) && m.role === 'user' && m._active_turn_token === opts.activeTurnToken)
  const promptless = currentUserKey === null && Boolean(opts.attachments?.length)
  if ((currentUserKey !== null || promptless) && !currentUserIn && !alreadyCheckpointed && candidates.some((m) => isDict(m) && (m.role === 'assistant' || m.role === 'tool'))) {
    const user: Message = { role: 'user', content: msgText, timestamp: opts.now ?? Date.now() / 1000 }
    if (promptless) user.attachments = [...opts.attachments!]
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
    if (((key !== null && key === currentUserKey) || isCurrentUser) && last && ((currentUserKey !== null && messageIdentity(last) === currentUserKey) || looksLikeCurrentUserTurn(last, msgText))) {
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

/** An `error` that says something: non-blank text, `true`, or a non-empty object or list. */
function presentError(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return isDict(v) ? Object.keys(v).length > 0 : v === true
}

/** A tool result's display sections (TAL-315); clients label and render the fields present, in this order. */
export interface ToolResultView { text?: string; stdout?: string; stderr?: string; error?: string; exit_code?: number }

const RESULT_TEXT_KEYS = ['result', 'results', 'preview', 'content', 'text', 'message', 'summary', 'data', 'items']
const RESULT_VIEW_MAX_DEPTH = 8

const tryJson = (text: string): unknown => { try { return JSON.parse(text) as unknown } catch { return undefined } }
const prettyJson = (value: unknown): string => { try { return JSON.stringify(value, null, 2) } catch { return str(value) } }
/** Line breaks and tabs a JSON-encoded result left escaped (`\n`, `\\n`), as the characters they stand for. */
const unescapeResultText = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\\{1,2}r\\{1,2}n|\\{1,2}n/g, '\n').replace(/\\{1,2}t/g, '\t')

/** The JSON a result string holds: as written, else with its escaped quotes undone; nested JSON strings unwrap three levels. */
function resultJson(text: string): unknown {
  const trimmed = text.trim()
  let value = tryJson(trimmed)
  if (value === undefined && trimmed.includes('\\"')) value = tryJson(trimmed.replaceAll('\\"', '"'))
  for (let i = 0; i < 3 && typeof value === 'string'; i += 1) {
    const inner = tryJson(value.trim())
    if (inner === undefined) break
    value = inner
  }
  return value
}

/** A section's text: a string unescaped, a scalar as written, a structure as pretty JSON; `undefined` when blank. */
function sectionText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? unescapeResultText(value) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : value === null || value === undefined ? '' : prettyJson(value)
  return text.trim() || undefined
}

/** An exit code: an integer, or a string of one; anything else is dropped. */
function exitCodeOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? Math.trunc(value) : typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(n) ? n : undefined
}

/** A terminal result's sections; the exit code only when it is non-zero or nothing else would show. */
function terminalView(data: Record<string, unknown>): ToolResultView {
  const view: ToolResultView = {}
  const stdout = sectionText(data.output) ?? sectionText(data.stdout)
  const stderr = sectionText(data.stderr)
  const error = sectionText(data.error)
  if (stdout) view.stdout = stdout
  if (stderr) view.stderr = stderr
  if (error) view.error = error
  const exit = exitCodeOf(data.exit_code ?? data.exitCode)
  if (exit !== undefined && (exit !== 0 || !Object.keys(view).length)) view.exit_code = exit
  return view
}

/** Every item of a list is a text part (`text`, `content` or `message`): their texts, one per line. */
function textParts(items: unknown[]): string | undefined {
  const texts = items.map((item) => (isDict(item) ? sectionText(item.text) ?? sectionText(item.content) ?? sectionText(item.message) : undefined))
  return texts.length && texts.every(Boolean) ? texts.join('\n') : undefined
}

const isEmptyView = (view: ToolResultView): boolean => Object.keys(view).length === 0

function resultView(value: unknown, depth: number): ToolResultView {
  if (typeof value === 'string') {
    const parsed = depth < RESULT_VIEW_MAX_DEPTH ? resultJson(value) : undefined
    if (parsed !== undefined && typeof parsed !== 'string') {
      const view = resultView(parsed, depth + 1)
      if (!isEmptyView(view)) return view
    }
    // Top-level text that is not JSON shows exactly as written; strings inside JSON are unescaped.
    const text = depth === 0 && parsed === undefined ? value.trim() : sectionText(typeof parsed === 'string' ? parsed : value)
    return text ? { text } : {}
  }
  if (Array.isArray(value)) {
    const text = textParts(value) ?? sectionText(value)
    return text ? { text } : {}
  }
  if (!isDict(value)) {
    const text = sectionText(value)
    return text ? { text } : {}
  }
  if (depth >= RESULT_VIEW_MAX_DEPTH) return { text: prettyJson(value) }
  // A process result: its output streams, error and exit code.
  if (sectionText(value.output) ?? sectionText(value.stdout) ?? sectionText(value.stderr)) return terminalView(value)
  for (const key of RESULT_TEXT_KEYS) {
    const view = resultView(value[key], depth + 1)
    if (!isEmptyView(view)) return view
  }
  const terminal = terminalView(value)
  if (!isEmptyView(terminal)) return terminal
  return Object.keys(value).length ? { text: prettyJson(value) } : {}
}

/**
 * The server's one result view rule (TAL-315), ported from the iOS formatter so every client renders the same sections:
 * a JSON result (nested JSON strings unwrapped, escaped line breaks undone) with `output`/`stdout`/`stderr` maps to its
 * terminal sections; any other object shows the first readable `result`, `results`, `preview`, `content`, `text`,
 * `message`, `summary`, `data` or `items`, else its `error` and exit code, else pretty JSON. A list of text parts joins
 * by line; a scalar shows as text, and a result that is not JSON exactly as written. Each field is capped like the snippet
 * (`limit`; TAL-331's whole-result read passes `Infinity`).
 */
export function toolResultView(raw: unknown, limit = TOOL_RESULT_SNIPPET_MAX): ToolResultView {
  // Content parts read as their text; a list with no text (`[{ title }]`) is the result itself.
  const flat = Array.isArray(raw) ? messageText(raw) : raw
  const view = resultView(Array.isArray(raw) && !str(flat).trim() ? raw : flat, 0)
  return Object.fromEntries(Object.entries(view).map(([key, field]) => [key, typeof field === 'string' ? toolResultSnippet(field, limit) : field]))
}

/** A view the server already decided (a built scene row, or one stored with its scene): its known fields, capped. */
export function decidedResultView(value: Record<string, unknown>): ToolResultView {
  const view: ToolResultView = {}
  for (const key of ['text', 'stdout', 'stderr', 'error'] as const) {
    const field = value[key]
    if (typeof field === 'string' && field) view[key] = toolResultSnippet(field)
  }
  if (typeof value.exit_code === 'number' && Number.isSafeInteger(value.exit_code)) view.exit_code = value.exit_code
  return view
}

/**
 * The server's one tool outcome rule (TAL-313), for a live `raw_result` and a persisted tool-role content alike: a result
 * is an error when it parses to an object with a non-empty `error`, a non-zero numeric `exit_code` / `exitCode`, or
 * `success: false`. `result_text` is the result's display snippet; `result_view` its display sections (TAL-315).
 */
export function toolOutcome(raw: unknown): { is_error: boolean; result_text: string; result_view: ToolResultView } {
  const value = Array.isArray(raw) ? messageText(raw) : raw
  let data: unknown = value
  if (typeof value === 'string') { try { data = JSON.parse(value) } catch { data = null } }
  const exit = isDict(data) ? data.exit_code ?? data.exitCode : undefined
  const isError = isDict(data) && (presentError(data.error) || (typeof exit === 'number' && exit !== 0) || data.success === false)
  return { is_error: isError, result_text: toolResultSnippet(value), result_view: toolResultView(raw) }
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function nearestAssistantIdx(messages: unknown[], msgIdx: number): number {
  for (let i = msgIdx; i >= 0; i -= 1) if (isDict(messages[i]) && (messages[i] as Record<string, unknown>).role === 'assistant') return i
  return -1
}

/**
 * Python `_extract_tool_calls_from_messages`, plus each call's outcome (TAL-313): `is_error` by `toolOutcome` of its
 * result, and the `duration` the live stream recorded for its id (this turn's `liveToolCalls`, else an earlier turn's
 * entry in `recorded`, the session's previous list), `null` when none did.
 */
export function extractToolCallsFromMessages(messages: unknown[], liveToolCalls: Record<string, unknown>[] = [], recorded: unknown[] = []): Record<string, unknown>[] {
  // An id may repeat across responses: an earlier turn's duration belongs to the row that made the call, and this turn's
  // live durations, in order, to the latest calls with each id.
  const earlier = new Map<string, number | null>()
  for (const tc of recorded) if (isDict(tc) && str(tc.tid)) earlier.set(`${String(tc.assistant_msg_idx)}\0${str(tc.tid)}`, finiteOrNull(tc.duration))
  const liveDurations = new Map<string, (number | null)[]>()
  for (const tc of liveToolCalls) if (isDict(tc) && str(tc.tid)) liveDurations.set(str(tc.tid), [...(liveDurations.get(str(tc.tid)) ?? []), finiteOrNull(tc.duration)])
  const outcome = (raw: unknown) => ({ is_error: toolOutcome(raw).is_error })
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
          toolCalls.push({ name, snippet: toolResultSnippet(m.content), tid, assistant_msg_idx: pendingAsst.get(tid) ?? -1, args: truncateToolArgs(pendingArgs.get(tid) ?? {}), ...outcome(m.content) })
          seq.resolved = true
        }
      }
      toolSeq.push(seq)
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      // Anthropic-style results: `tool_result` blocks in a user row, each naming its call.
      for (const part of m.content) {
        const tid = isDict(part) && part.type === 'tool_result' ? str(part.tool_use_id) : ''
        const name = pendingNames.get(tid) ?? ''
        if (!tid || !name || name === 'tool' || !isDict(part)) continue
        const raw = part.content ?? ''
        const resolved = outcome(raw)
        toolCalls.push({ name, snippet: toolResultSnippet(raw), tid, assistant_msg_idx: pendingAsst.get(tid) ?? -1, args: truncateToolArgs(pendingArgs.get(tid) ?? {}), ...resolved, is_error: resolved.is_error || part.is_error === true })
      }
    }
  })
  const live = liveToolCalls.filter((tc) => isDict(tc) && str(tc.name) && tc.name !== 'clarify')
  if (live.length) {
    toolSeq.forEach((seq, i) => {
      if (seq.resolved || i >= live.length) return
      const tc = live[i]!
      toolCalls.push({ name: str(tc.name) || 'tool', snippet: toolResultSnippet(seq.raw), tid: str(tc.tid), assistant_msg_idx: nearestAssistantIdx(messages, seq.msgIdx), args: truncateToolArgs(tc.args ?? {}, 4), ...outcome(seq.raw) })
    })
  }
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const tc = toolCalls[i]!
    const tid = str(tc.tid)
    const live = liveDurations.get(tid)
    tc.duration = live?.length ? live.pop() ?? null : earlier.get(`${String(tc.assistant_msg_idx)}\0${tid}`) ?? null
  }
  return toolCalls
}

/**
 * TAL-313: every assistant row's tool calls as they leave the server, over the full `_turn_id`-stamped transcript (before
 * any window, so every window agrees). Anthropic `tool_use` parts join `tool_calls` in the OpenAI shape (content stays),
 * a call only the session-level list recorded joins the row at its `assistant_msg_idx`, a failed or cancelled turn's
 * partial snapshot shows the live calls it kept, and every call carries `done`
 * (answered, or outside the running turn), `is_error` (`toolOutcome` of its result, else the recorded value), `duration`
 * (recorded live, else `null`), `result` (the result snippet, else `null`) and `result_view` (its display sections, TAL-315,
 * else `null`). Returns copies; stored rows are untouched.
 */
export function withToolCallOutcomes<T>(messages: T[], sessionToolCalls: unknown[], activeTurnId: string | null): T[] {
  // Every identifier a stored call may carry (`ToolCallSchema`).
  const callId = (tc: unknown): string => (isDict(tc) ? toolCallId(tc) || str(tc.tool_call_id) : '')
  // Providers may reuse an id (`call_1` in every response), so a reply answers the latest earlier assistant row that
  // declared its id, and everything is keyed by that row's index and the id.
  const key = (row: number, id: string) => `${String(row)}\0${id}`
  const replies = new Map<string, { content: unknown; is_error: boolean }>()
  const declared = new Map<string, number>()
  const answer = (id: string, reply: { content: unknown; is_error: boolean }) => {
    const row = declared.get(id)
    if (id && row !== undefined) replies.set(key(row, id), reply)
  }
  messages.forEach((m, index) => {
    if (!isDict(m)) return
    if (m.role === 'tool') answer(str(m.tool_call_id) || str(m.tool_use_id), { content: m.content, is_error: false })
    else if (m.role === 'user' && Array.isArray(m.content)) {
      // Anthropic-style results: `tool_result` blocks in a user row, each naming its call.
      for (const part of m.content) if (isDict(part) && part.type === 'tool_result') answer(str(part.tool_use_id), { content: part.content ?? '', is_error: part.is_error === true })
    } else if (m.role === 'assistant') {
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) if (callId(tc)) declared.set(callId(tc), index)
      for (const part of Array.isArray(m.content) ? m.content : []) if (isDict(part) && part.type === 'tool_use' && str(part.id)) declared.set(str(part.id), index)
    }
  })
  // The session-level list's entries, by the assistant row that made each call.
  const recordedByRow = new Map<number, Record<string, unknown>[]>()
  for (const tc of sessionToolCalls) {
    const idx = isDict(tc) ? tc.assistant_msg_idx : undefined
    if (isDict(tc) && typeof idx === 'number') recordedByRow.set(idx, [...(recordedByRow.get(idx) ?? []), tc])
  }
  return messages.map((m, index) => {
    if (!isDict(m) || m.role !== 'assistant') return m
    const calls: unknown[] = Array.isArray(m.tool_calls) ? Array.from(m.tool_calls as unknown[]) : []
    const ids = new Set(calls.map(callId).filter(Boolean))
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (!isDict(part) || part.type !== 'tool_use' || !str(part.id) || ids.has(str(part.id))) continue
      ids.add(str(part.id))
      calls.push({ id: str(part.id), type: 'function', function: { name: str(part.name), arguments: JSON.stringify(part.input ?? {}) } })
    }
    // Calls known only from a record: the session-level list's, and the live calls a failed or cancelled turn's partial
    // snapshot kept (`_partial_tool_calls`).
    const records: Record<string, unknown>[] = []
    const rowRecords = recordedByRow.get(index) ?? []
    const recorded = new Map(rowRecords.filter((tc) => str(tc.tid)).map((tc) => [str(tc.tid), tc]))
    for (const tc of [...rowRecords, ...(Array.isArray(m._partial_tool_calls) ? m._partial_tool_calls as unknown[] : [])]) {
      if (!isDict(tc)) continue
      const tid = str(tc.tid)
      if (tid && ids.has(tid)) continue
      if (tid) ids.add(tid)
      records.push(tc)
    }
    if (!calls.length && !records.length) return m
    const running = Boolean(activeTurnId) && m._turn_id === activeTurnId
    const resolve = (id: string, name: unknown, rec: Record<string, unknown> | undefined, answered: boolean) => {
      const reply = id ? replies.get(key(index, id)) : undefined
      const outcome = reply ? { ...toolOutcome(reply.content), flagged: reply.is_error } : null
      // TAL-448: a file edit's change, from its full reply, else the one its live record decided.
      const editDiff = reply ? toolEditDiff(name, reply.content) : decidedEditDiff(rec?.edit_diff)
      return {
        ...(editDiff ? { edit_diff: editDiff } : {}),
        done: Boolean(reply) || answered || !running, is_error: outcome ? outcome.flagged || outcome.is_error : rec?.is_error === true,
        duration: finiteOrNull(rec?.duration), result: outcome ? outcome.result_text : typeof rec?.snippet === 'string' ? rec.snippet : null,
        result_view: outcome ? outcome.result_view : isDict(rec?.result_view) ? decidedResultView(rec.result_view) : typeof rec?.snippet === 'string' ? toolResultView(rec.snippet) : null,
      }
    }
    const projected = [
      ...calls.map((call) => (isDict(call) ? { ...call, ...resolve(callId(call), toolName(call), recorded.get(callId(call)), false) } : call)),
      ...records.map((tc) => ({
        ...(str(tc.tid) ? { id: str(tc.tid) } : {}), type: 'function', function: { name: str(tc.name), arguments: JSON.stringify(tc.args ?? {}) },
        // A session-level entry was answered; a live call says whether it completed.
        ...resolve(str(tc.tid), tc.name, tc, typeof tc.done === 'boolean' ? tc.done : true),
      })),
    ]
    return { ...m, tool_calls: projected }
  })
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

const DSML = '(?:\\s*｜\\s*DSML\\s*[｜|]\\s*)?'

/** Markdown code (fenced blocks, an unclosed one running to the end, and inline spans): markup written there is literal. */
function codeRanges(text: string): [number, number][] {
  const code = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n {0,3}\1[^\n]*(?=\n|$)|(?![\s\S]))|(?![\s\S]))|(`+)(?!`)(?:[^\n]|\n(?!\n))*?(?<!`)\2(?!`)/gm
  return [...text.matchAll(code)].map((m) => [m.index, m.index + m[0].length])
}

const inCode = (code: [number, number][], at: number) => code.some(([from, to]) => at >= from && at < to)

/** `re` matches removed, except the ones that start inside Markdown code. */
function removeOutsideCode(text: string, re: RegExp): string {
  const code = codeRanges(text)
  return text.replace(re, (match: string, ...rest: unknown[]) => (inCode(code, rest.find((x): x is number => typeof x === 'number') ?? 0) ? match : ''))
}

/** Remove provider tool-call XML (`<function_calls>…`, DSML variants, `<tool_call>`), closed or cut off, that leaks into text. */
export function stripToolCallXml(text: string): string {
  const lo = text.toLowerCase()
  if (!lo.includes('function_calls') && !lo.includes('dsml') && !lo.includes('<tool_call')) return text
  return [
    new RegExp(`<${DSML}function_calls>[\\s\\S]*?<\\/${DSML}function_calls>`, 'gi'),
    new RegExp(`<${DSML}function_calls(?:>|$)[\\s\\S]*$`, 'i'),
    /<tool_call>[\s\S]*?<\/tool_call>/gi,
    /<tool_call>[\s\S]*$/i,
    /<\s*｜\s*DSML\s*[｜|]\s*/gi,
  ].reduce(removeOutsideCode, text).replace(/^\s+/, '').trimEnd()
}

/** Inline thinking openers: `<think>`/`<thinking>` in any case and with attributes (as the Agent's own split), and the channel forms. */
const THINK_OPEN = /<think(?:ing)?(?:\s[^>]*)?>|<\|channel\|>thought|<\|turn\|>thinking/gi

function thinkClose(open: string): RegExp {
  if (open.toLowerCase().startsWith('<|channel|>')) return /<channel\|>/gi
  if (open.toLowerCase().startsWith('<|turn|>')) return /<turn\|>/gi
  return /<\/think(?:ing)?\s*>/gi
}

/**
 * Split assistant text into its visible prose and its inline thinking: every `<think>`, `<thinking>`,
 * `<|channel|>thought` and `<|turn|>thinking` block anywhere in the text, an unterminated one running to the end.
 * A tag written inside Markdown code is prose. Tool-call XML leaves both halves; both come back trimmed.
 */
export function splitDisplayText(text: string): [string, string] {
  const code = codeRanges(text)
  let content = ''
  const reasoning: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    THINK_OPEN.lastIndex = cursor
    let open = THINK_OPEN.exec(text)
    while (open && inCode(code, open.index)) open = THINK_OPEN.exec(text)
    if (!open) { content += text.slice(cursor); break }
    content += text.slice(cursor, open.index)
    const body = open.index + open[0].length
    const closer = thinkClose(open[0])
    closer.lastIndex = body
    const close = closer.exec(text)
    reasoning.push(text.slice(body, close?.index))
    if (!close) break
    cursor = close.index + close[0].length
  }
  return [stripToolCallXml(content).replace(/^\s+/, '').trimEnd(), joinReasoning(reasoning)]
}

/**
 * Reasoning parts as one display string: tool-call XML removed, blank-line joined, each part once. A part that is
 * whole paragraphs of another (a settled row's `reasoning` that already took in its `reasoning_content`) is dropped.
 */
export function joinReasoning(parts: string[]): string {
  const clean = parts.map((part) => stripToolCallXml(part).trim()).filter(Boolean)
  const within = (outer: string, inner: string) => `\n\n${outer}\n\n`.includes(`\n\n${inner}\n\n`)
  return clean.filter((p, i) => !clean.some((q, j) => j !== i && (q === p ? j < i : within(q, p)))).join('\n\n')
}

/** A message's reasoning fields as one string: `reasoning_content`, `reasoning` (text or a list of text parts), `thinking`. */
export function reasoningFieldsText(m: Record<string, unknown>): string {
  const listed = Array.isArray(m.reasoning) ? m.reasoning.map((part) => (isDict(part) ? reasoningBlockText(part) : str(part))) : [str(m.reasoning)]
  return joinReasoning([str(m.reasoning_content), ...listed, str(m.thinking)])
}

/**
 * The one display shape of an assistant row: `content` without inline thinking or tool-call XML (typed `thinking` /
 * `reasoning` parts leave a list), and every piece of reasoning in one `reasoning` string. `reasoning_content` and
 * `thinking` are not sent. Idempotent; other rows pass through. A copy: stored rows and model history are untouched.
 */
export function normalizeAssistantDisplay<T>(message: T): T {
  if (!isDict(message) || message.role !== 'assistant') return message
  const m: Record<string, unknown> = { ...message }
  delete m.reasoning_content
  delete m.thinking
  delete m.reasoning
  const parts = [reasoningFieldsText(message)]
  if (typeof m.content === 'string') {
    const [content, inline] = splitDisplayText(m.content)
    // Only text something was taken out of is rewritten: plain prose keeps its exact whitespace (an indented code block).
    if (content !== m.content.trim()) m.content = content
    parts.push(inline)
  } else if (Array.isArray(m.content)) {
    m.content = m.content.flatMap((part: unknown) => {
      if (!isDict(part)) return [part]
      if (isReasoningBlock(part)) { parts.push(reasoningBlockText(part)); return [] }
      if (typeof part.text !== 'string') return [part]
      const [text, inline] = splitDisplayText(part.text)
      parts.push(inline)
      return text === part.text.trim() ? [part] : text ? [{ ...part, text }] : []
    })
  }
  const reasoning = joinReasoning(parts)
  return (reasoning ? { ...m, reasoning } : m) as T
}

/**
 * Python `merge_session_messages_append_only`, bounded to its load-bearing rules: state.db rows never delete a local
 * row; rows that replay the sidecar (same role, timestamp, and content) are skipped; rows at or before the sidecar's
 * newest timestamp are already represented locally; a truncation watermark hides rows the user cut (0 blocks every
 * replay): rows at or before it, and, for a truncation cut, rows after it until the sidecar advances past it (TAL-504).
 * A compression watermark only covers the compressed rows. Rows past the sidecar tail (a conversation continued from the
 * CLI) are appended in state.db order.
 * TAL-493: once a boundary or settled turn recorded the highest state.db id it read (`stateDbSeenId`) and the rows carry
 * ids, identity replaces the timestamp rules: rows up to that id are covered, and every newer row not already in the
 * sidecar is appended, even one a writer stamped before the newest local row or the watermark but committed later.
 * ponytail: the Python identity memo (api_content sidecars, message ids, workspace-prefix normalisation) is not ported;
 * add it if a mixed WebUI/CLI transcript shows duplicated turns.
 */
export function mergeSessionMessagesAppendOnly(sidecar: Message[], state: Message[], opts: { truncationWatermark?: unknown; compressedWatermark?: boolean; stateDbSeenId?: number | null } = {}): Message[] {
  const watermark = Number(opts.truncationWatermark)
  const hasWatermark = opts.truncationWatermark !== null && opts.truncationWatermark !== undefined && Number.isFinite(watermark)
  if (!state.length) return sidecar
  const ts = (m: Message): number | null => { const n = Number(m.timestamp); return Number.isFinite(n) ? n : null }
  const key = (m: Message): string => `${String(m.role)}\0${String(ts(m) ?? '')}\0${typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)}`
  const seenId = opts.stateDbSeenId
  if (typeof seenId === 'number' && Number.isFinite(seenId) && state.some((m) => stateDbRowId(m) !== null)) {
    // Each local row stands for at most one new state.db row: a persisted copy by its id, any other by its key.
    const localIds = new Set(sidecar.map(stateDbRowId))
    const localKeys = new Map<string, number>()
    for (const m of sidecar) if (stateDbRowId(m) === null) localKeys.set(key(m), (localKeys.get(key(m)) ?? 0) + 1)
    const merged = [...sidecar]
    for (const m of state) {
      const id = stateDbRowId(m)
      if (id !== null && localIds.has(id)) continue
      // In state.db order, so a covered row matches its own local copy before a newer duplicate can.
      const left = localKeys.get(key(m)) ?? 0
      if (left > 0) { localKeys.set(key(m), left - 1); continue }
      if (id === null || id <= seenId) continue
      merged.push(m)
    }
    return merged
  }
  if (!sidecar.length) {
    if (!hasWatermark) { const seen = new Set<string>(); return state.filter((m) => { const k = key(m); if (seen.has(k)) return false; seen.add(k); return true }) }
    if (watermark === 0) return []
    return state.filter((m) => { const t = ts(m); return t !== null && (opts.compressedWatermark === true ? t > watermark : t <= watermark) })
  }
  const seen = new Set(sidecar.map(key))
  let maxSidecar: number | null = null
  for (const m of sidecar) { const t = ts(m); if (t !== null && (maxSidecar === null || t > maxSidecar)) maxSidecar = t }
  // Until a new turn lands in the sidecar, every state.db row past the watermark is the deleted suffix.
  const advanced = !hasWatermark || opts.compressedWatermark === true || (maxSidecar !== null && maxSidecar > watermark)
  const merged = [...sidecar]
  for (const m of state) {
    const k = key(m)
    if (seen.has(k)) continue
    const t = ts(m)
    if (maxSidecar !== null && t !== null && t <= maxSidecar) continue
    if (hasWatermark && t !== null && (t <= watermark || !advanced)) continue
    seen.add(k)
    merged.push(m)
  }
  return merged
}

/** The Agent's `messages.id` a state.db row was read with, or null for a database without the column. */
function stateDbRowId(m: Message): number | null {
  const id = m._state_db_row_id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/** TAL-493: the `state_db_seen_id` after reading `rows`: their highest id, or null when they carry none. */
export function stateDbSeenId(rows: Message[]): number | null {
  let max: number | null = null
  for (const m of rows) { const id = stateDbRowId(m); if (id !== null && (max === null || id > max)) max = id }
  return max
}

/**
 * TAL-316: the merged transcript without the running turn's output, which the run journal replays from its start. The turn
 * begins at its checkpointed prompt, else at its first stamped row or the first state.db row appended past the sidecar
 * (`localCount`) at or after its start. The turn's prompt and the server's consumed-steer rows stay; everything else of the
 * turn goes, so the transcript holds nothing the journal delivers after sequence 0.
 */
export function withoutRunningTurnOutput(rows: Message[], turn: { localCount: number; turnId: string; startedAt: number; activeTurnToken: string }): Message[] {
  const checkpointed = rows.findIndex((m) => m.role === 'user' && m._active_turn_token === turn.activeTurnToken)
  const first = checkpointed >= 0 ? checkpointed : rows.findIndex((m, i) => m._turn_id === turn.turnId || (i >= turn.localCount && Number(m.timestamp) >= turn.startedAt))
  if (first < 0) return rows
  let prompt = false
  return rows.filter((m, i) => {
    if (i < first) return true
    if (m._steer && m._turn_id === turn.turnId) return true
    if (prompt || m.role !== 'user' || m._steer || agentSteerText(m) !== null) return false
    prompt = true
    return true
  })
}

/**
 * TAL-277: the Python server stored attachments as bare filenames. Ship each as a filename-only object; it gets no `path`,
 * so clients never build a file URL from an untrusted name. Anything else passes through for output validation to judge.
 */
export function attachmentObjects(items: unknown[]): unknown[] {
  return items.map((a) => (typeof a === 'string' ? { name: a, filename: a } : a))
}

/** `attachmentObjects` over every message's attachments. Returns copies; stored rows are untouched. */
export function withAttachmentObjects<T>(messages: T[]): T[] {
  return messages.map((m) => (isDict(m) && Array.isArray(m.attachments) && m.attachments.some((a) => typeof a === 'string') ? { ...m, attachments: attachmentObjects(m.attachments) } : m))
}

/** A scene's prose rows with `display_text` and `media` where `project` rewrites their text; the same array when none does. */
export function withSceneRowMedia(rows: unknown, project: (text: string) => MediaProjection | null): unknown {
  if (!Array.isArray(rows)) return rows
  let changed = false
  const out = (rows as unknown[]).map((row) => {
    if (!isDict(row) || row.role !== 'prose' || typeof row.text !== 'string') return row
    const projected = project(row.text)
    if (!projected) return row
    changed = true
    return { ...row, display_text: projected.text, media: projected.media }
  })
  return changed ? out : rows
}

/**
 * TAL-186: assistant rows with `_display_content` and `_media`, and their scenes with `final_answer_display` /
 * `final_answer_media` and prose rows' `display_text` / `media`, wherever `project` rewrites media references in the
 * text. Runs after scene hydration and before body excerpts, which are cut from the display text. Returns copies.
 */
export function withDisplayMedia<T>(messages: T[], project: (text: string) => MediaProjection | null): T[] {
  return messages.map((m) => {
    if (!isDict(m) || m.role !== 'assistant') return m
    let out: Record<string, unknown> = m
    const projected = project(messageText(m.content))
    if (projected) out = { ...out, _display_content: projected.text, _media: projected.media }
    const scene = m._anchor_activity_scene
    if (isDict(scene)) {
      const final = typeof scene.final_answer === 'string' ? project(scene.final_answer) : null
      const rows = withSceneRowMedia(scene.activity_rows, project)
      if (final || rows !== scene.activity_rows) {
        out = { ...out, _anchor_activity_scene: { ...scene, activity_rows: rows, ...(final ? { final_answer_display: final.text, final_answer_media: final.media } : {}) } }
      }
    }
    return out as T
  })
}

/** TAL-456: a settled user or assistant body longer than this ships a collapsed excerpt for clients to render. */
export const BODY_EXCERPT_LIMIT = 3000

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The first `BODY_EXCERPT_LIMIT` characters, never splitting a grapheme, cut back to a line break (else a space) in the second half. */
function bodyExcerpt(text: string): string {
  let end = 0
  for (const { segment } of graphemes.segment(text.slice(0, BODY_EXCERPT_LIMIT + 16))) {
    if (end + segment.length > BODY_EXCERPT_LIMIT) break
    end += segment.length
  }
  const head = text.slice(0, end)
  const floor = BODY_EXCERPT_LIMIT / 2
  const lineBreak = head.lastIndexOf('\n')
  const space = head.lastIndexOf(' ')
  const cut = lineBreak >= floor ? lineBreak : space >= floor ? space : end
  return head.slice(0, cut).trimEnd()
}

/**
 * TAL-456: stamps `_display_excerpt` and `_display_truncated` on settled user and assistant rows whose display text is longer than
 * `BODY_EXCERPT_LIMIT`, and `final_answer_excerpt` on a settled scene whose final answer is, so clients render a bounded
 * excerpt instead of laying out the whole body. Full text stays for copy and edit; the running turn's rows are left alone.
 * Runs after scene hydration. Returns copies; stored rows are untouched.
 */
export function withBodyExcerpts<T>(messages: T[], activeTurnId: string | null): T[] {
  return messages.map((m) => {
    if (!isDict(m) || (m.role !== 'user' && m.role !== 'assistant')) return m
    if (activeTurnId && m._turn_id === activeTurnId) return m
    let out: Record<string, unknown> = m
    const text = typeof m._display_content === 'string' ? m._display_content : messageText(m.content)
    if (text.length > BODY_EXCERPT_LIMIT) out = { ...out, _display_excerpt: bodyExcerpt(text), _display_truncated: true }
    const scene = m._anchor_activity_scene
    const finalAnswer = isDict(scene) ? (typeof scene.final_answer_display === 'string' ? scene.final_answer_display : scene.final_answer) : null
    if (isDict(scene) && typeof finalAnswer === 'string' && finalAnswer.length > BODY_EXCERPT_LIMIT) {
      out = { ...out, _anchor_activity_scene: { ...scene, final_answer_excerpt: bodyExcerpt(finalAnswer) } }
    }
    return out as T
  })
}

/** The running turn's prompt as eager save checkpoints it (Python `_checkpoint_user_message_for_eager_session_save`). */
export function pendingUserRow(msg: string, attachments: unknown[], startedAt: number | null, source: string, turnId: string): Message {
  const user: Message = { role: 'user', content: msg, _turn_id: turnId }
  const token = buildActiveTurnToken(turnId, startedAt)
  if (token) user._active_turn_token = token
  if (source !== 'webui') user._source = source
  if (typeof startedAt === 'number' && startedAt > 0) user.timestamp = startedAt
  if (attachments.length) user.attachments = [...attachments]
  return user
}

/**
 * TAL-368: the merged transcript with the running turn's prompt, which deferred save keeps out of the sidecar until
 * settlement. A prompt already persisted for the turn (its checkpoint, a row stamped with its id, or a state.db prompt past
 * the sidecar at or after its start) stays the only one, carrying the turn's identity and pending attachments; otherwise
 * `prompt` opens the turn. Turn identity, never text, decides, so a repeated prompt stays a turn of its own. Read-only:
 * settlement writes the canonical row.
 */
export function withPendingUserTurn(rows: Message[], turn: { localCount: number; turnId: string; startedAt: number; activeTurnToken: string; prompt: Message }): Message[] {
  const inTurn = (m: Message, i: number): boolean => m._turn_id === turn.turnId || (i >= turn.localCount && Number(m.timestamp) >= turn.startedAt)
  const persisted = rows.findIndex((m, i) => m.role === 'user' && !m._steer && agentSteerText(m) === null && (m._active_turn_token === turn.activeTurnToken || inTurn(m, i)))
  if (persisted >= 0) {
    const row = rows[persisted]!
    if (row._active_turn_token === turn.activeTurnToken) return rows
    // A state.db prompt has neither the turn's identity nor its attachments, and its text is the Agent's (workspace
    // prefix and all): take them from the pending turn, as settlement will.
    const { content, _turn_id, _active_turn_token, _source, attachments } = turn.prompt
    const stamped: Message = { ...row, content, _turn_id, _active_turn_token }
    if (_source !== undefined) stamped._source = _source
    if (!row.attachments && attachments) stamped.attachments = attachments
    return rows.map((m, i) => (i === persisted ? stamped : m))
  }
  const first = rows.findIndex(inTurn)
  const at = first < 0 ? rows.length : first
  return [...rows.slice(0, at), turn.prompt, ...rows.slice(at)]
}

/**
 * TAL-364: where a checkpoint's current-turn prompt sits, or null when it has none. The Agent's rows start with the
 * `historyLength` rows it was sent, so the prompt comes after them; a repeated prompt matching an earlier turn does not
 * count. A compressed checkpoint is shorter than that history, so there the last matching row stands.
 */
export function checkpointTurnStart(checkpoint: unknown[], msgText: string, historyLength: number): number | null {
  const at = findCurrentUserTurn(checkpoint, msgText)
  if (at === null) return null
  return at >= historyLength || checkpoint.some((m) => isContextCompressionMarker(m)) ? at : null
}

/**
 * TAL-364: the model context a stopped turn leaves. The Agent's checkpoint (its canonical transcript at the stop
 * boundary) when it holds this turn's prompt, else the turn's starting context plus that prompt; then the prose that
 * streamed past the last assistant row the Agent committed. A completed tool result gets the Agent's own closing row, so
 * the next prompt never follows a tool row. Reasoning never enters. Null when nothing the model can use was captured:
 * the prompt then stays a recovered row the next request does not replay.
 */
export function stoppedTurnContext(previousContext: Message[], checkpoint: unknown[] | null, prompt: string | Record<string, unknown>[], msgText: string, streamedText: string, historyLength: number): Message[] | null {
  const agentRows = (checkpoint ?? []).filter((m): m is Message => isDict(m))
  const at = checkpointTurnStart(agentRows, msgText, historyLength)
  const rows: Message[] = at === null ? [...structuredClone(previousContext), { role: 'user', content: prompt }] : structuredClone(agentRows)
  let unsettled = messageText(buildPartialMessage(streamedText, '', [])?.content)
  for (const m of rows.slice((at ?? previousContext.length) + 1)) {
    const text = m.role === 'assistant' ? messageText(m.content).trim() : ''
    if (text && unsettled.includes(text)) unsettled = unsettled.replace(text, '').trim()
  }
  // A tool result is a `tool` row or an Anthropic-style user row of `tool_result` blocks. A steer the Agent applied is
  // neither a prompt nor a result: the boundary goes after it, and it never makes the turn look unanswered.
  const toolResult = (m: Message | undefined): boolean => m?.role === 'tool' || (m?.role === 'user' && Array.isArray(m.content) && m.content.some((part) => isDict(part) && part.type === 'tool_result'))
  const tail = (): Message | undefined => sanitizeMessagesForApi(rows.filter((m) => agentSteerText(m) === null)).at(-1)
  if (toolResult(tail())) rows.push({ role: 'assistant', content: unsettled || 'Operation interrupted.' })
  else if (unsettled) rows.push({ role: 'assistant', content: unsettled })
  return tail()?.role === 'user' ? null : rows
}

function toolCallId(tc: unknown): string {
  if (!isDict(tc)) return ''
  return str(tc.id) || str(tc.call_id)
}

const API_SAFE_MSG_KEYS = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'tool_use_id', 'name', 'refusal', 'reasoning_content'])
const OOB_USER_MESSAGE_BLOCK_RE = /\[OUT-OF-BAND\s+USER\s+MESSAGE(?:\s*(?:—|-)\s*[\s\S]*?)?\]\s*?[\s\S]*?\[\/OUT-OF-BAND\s+USER\s+MESSAGE\]/gi
const OOB_DELIVERY_RE = /^\s*\[OUT-OF-BAND\s+USER\s+MESSAGE[^\]]*\]\s*([\s\S]*?)\s*\[\/OUT-OF-BAND\s+USER\s+MESSAGE\]\s*$/i

/** The Agent's own record of a steer it delivered (`display_kind: 'steer'`, an out-of-band block): its text, else null. */
export function agentSteerText(m: Message): string | null {
  if (m.role !== 'user' || isDict(m._steer)) return null
  const content = messageText(m.content)
  const inner = OOB_DELIVERY_RE.exec(content)?.[1]
  if (inner !== undefined) return inner.trim()
  return m.display_kind === 'steer' ? content.trim() : null
}

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
  // Calls are OpenAI `tool_calls` or Anthropic-style `tool_use` content blocks; results name them by `tool_call_id`,
  // `tool_use_id`, or a user row's `tool_result` blocks.
  const toolUseIds = (msg: Message): string[] => (Array.isArray(msg.content) ? msg.content.flatMap((part) => (isDict(part) && part.type === 'tool_use' && str(part.id) ? [str(part.id)] : [])) : [])
  const validToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) { const id = toolCallId(tc); if (id) validToolCallIds.add(id) }
    for (const id of toolUseIds(msg)) validToolCallIds.add(id)
  }
  const clean: Message[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (isReasoningOnlyAssistant(msg)) continue
    // The Agent already received a steer mid-turn; its persisted row is display-only.
    if (msg._error || isDict(msg._steer)) continue
    if (msg._partial && !messageText(msg.content).trim()) continue
    const recovered = Boolean(msg._recovered) && msg.role === 'user'
    if (msg.role === 'tool') { const tid = str(msg.tool_call_id) || str(msg.tool_use_id); if (!tid || !validToolCallIds.has(tid)) continue }
    const sanitized = Object.fromEntries(Object.entries(msg).filter(([k]) => API_SAFE_MSG_KEYS.has(k)))
    if (Array.isArray(sanitized.tool_calls) && !sanitized.tool_calls.length) Reflect.deleteProperty(sanitized, 'tool_calls')
    if (recovered) sanitized._recovered = true
    if ('content' in sanitized) sanitized.content = stripOobBlocks(sanitized.content)
    if (sanitized.role) clean.push(sanitized)
  }
  const answered = new Set(clean.flatMap((m) => {
    if (m.role === 'tool') return [str(m.tool_call_id) || str(m.tool_use_id)]
    if (m.role === 'user' && Array.isArray(m.content)) return m.content.flatMap((part) => (isDict(part) && part.type === 'tool_result' ? [str(part.tool_use_id)] : []))
    return []
  }).filter(Boolean))
  const filtered: Message[] = []
  for (let msg of clean) {
    if (msg.role === 'assistant' && toolUseIds(msg).length && Array.isArray(msg.content)) {
      const parts = msg.content.filter((part) => !(isDict(part) && part.type === 'tool_use' && !answered.has(str(part.id))))
      if (!parts.length) continue
      msg = { ...msg, content: parts }
      // Reasoning left behind by a dropped call is not an answer either.
      if (isReasoningOnlyAssistant(msg)) continue
    }
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
