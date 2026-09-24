import { str } from '../util.js'
/** Bounded transcript windows for display payloads (Python `api/message_window.py` and `_parse_msg_limit`). */
import { isEmptyPartialActivityMessage, type Message } from './session.js'

export const MAX_MSG_LIMIT = 500

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export function parseMsgLimit(raw: string | null | undefined): number | null {
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return null
  return Math.max(1, Math.min(value, MAX_MSG_LIMIT))
}

export function messageCountsAsRenderable(message: unknown): boolean {
  if (!isDict(message)) return false
  if (isEmptyPartialActivityMessage(message)) return false
  const role = str(message.role).trim().toLowerCase()
  return Boolean(role) && role !== 'tool'
}

function toolCallIdsInMessages(messages: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (!isDict(msg)) continue
    for (const key of ['tool_calls', '_partial_tool_calls']) {
      const calls = msg[key]
      if (!Array.isArray(calls)) continue
      for (const call of calls) {
        if (!isDict(call)) continue
        const cid = call.id ?? call.tool_call_id
        if (cid) ids.add(str(cid))
      }
    }
    if (Array.isArray(msg.content)) for (const part of msg.content) if (isDict(part) && part.type === 'tool_use' && part.id) ids.add(str(part.id))
  }
  return ids
}

function toolResultMatchesCallIds(message: unknown, callIds: Set<string>): boolean {
  if (!callIds.size || !isDict(message)) return false
  if (str(message.role).toLowerCase() !== 'tool') return false
  const tid = message.tool_call_id ?? message.tool_use_id ?? ''
  return Boolean(tid) && callIds.has(str(tid))
}

/** Visible-row-bounded window and its full-transcript offset. */
export function messageWindowForDisplay(messages: unknown[], msgLimit: number | null, msgBefore: number | null): [unknown[], number] {
  const beforeIdx = msgBefore === null ? messages.length : Math.max(0, Math.min(msgBefore, messages.length))
  const source = messages.slice(0, beforeIdx)
  if (!source.length) return [[], 0]
  if (!msgLimit) return [source, 0]
  const limit = Math.max(1, msgLimit)
  let endIdx = source.length
  let lastRenderable: number | null = null
  for (let idx = endIdx - 1; idx >= 0; idx -= 1) {
    if (messageCountsAsRenderable(source[idx])) { lastRenderable = idx; break }
  }
  if (lastRenderable === null) {
    const start = Math.max(0, endIdx - limit)
    return [source.slice(start, endIdx), start]
  }
  endIdx = lastRenderable + 1
  const windowIds = toolCallIdsInMessages(source.slice(0, lastRenderable + 1))
  while (endIdx < source.length && !messageCountsAsRenderable(source[endIdx])) {
    if (toolResultMatchesCallIds(source[endIdx], windowIds)) endIdx += 1
    else break
  }
  let startIdx = 0
  let renderable = 0
  for (let idx = lastRenderable; idx >= 0; idx -= 1) {
    if (!messageCountsAsRenderable(source[idx])) continue
    renderable += 1
    if (renderable >= limit) { startIdx = idx; break }
  }
  return [source.slice(startIdx, endIdx), startIdx]
}

/** Rebase session-level tool calls into a window. */
export function toolCallsForMessageWindow(toolCalls: unknown, startIdx: number, messageCount: number): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls) || messageCount <= 0) return []
  const endIdx = startIdx + messageCount
  const out: Record<string, unknown>[] = []
  for (const call of toolCalls) {
    if (!isDict(call)) continue
    const idx = call.assistant_msg_idx
    if (typeof idx !== 'number' || !Number.isInteger(idx)) continue
    if (startIdx <= idx && idx < endIdx) out.push({ ...call, assistant_msg_idx: idx - startIdx })
  }
  return out
}

const LIMITED_TOOL_CONTENT_MAX_CHARS = 4096
const LIMITED_TOOL_CONTENT_NOTICE = '\n\n[Tool output truncated in paginated session response; load the full transcript to inspect the complete result.]'

export function toolMessageForLimitedPayload(message: unknown): unknown {
  if (!isDict(message) || str(message.role).toLowerCase() !== 'tool') return message
  const content = message.content
  if (content === null || content === undefined || content === '') return message
  let text: string
  if (typeof content === 'string') text = content
  else {
    try { text = JSON.stringify(content) } catch { text = str(content) }
  }
  if (text.length <= LIMITED_TOOL_CONTENT_MAX_CHARS) return message
  const clipped: Record<string, unknown> = { ...message }
  const preview = text.slice(0, LIMITED_TOOL_CONTENT_MAX_CHARS) + LIMITED_TOOL_CONTENT_NOTICE
  if (typeof content === 'string') clipped.content = preview
  else if (Array.isArray(content)) clipped.content = [{ type: 'text', text: preview }]
  else if (isDict(content)) clipped.content = { _truncated: true, preview }
  else clipped.content = preview
  clipped._content_truncated = true
  clipped._content_original_chars = text.length
  return clipped
}

export function messagesForLimitedPayload(messages: unknown[]): Message[] {
  return messages.map((m) => toolMessageForLimitedPayload(m)) as Message[]
}
