/**
 * TAL-258: the handoff dock's summary (Python `_handle_handoff_summary` and its persistence helpers). The prompt, the
 * deterministic English/Chinese fallback, the truncation guard, and the display-only `handoff_summary` tool marker.
 */
import { str } from '../util.js'
import { isDict } from './merge.js'

type Message = Record<string, unknown>

/** The summary prompt the session's main model answers. */
export const HANDOFF_SYSTEM_PROMPT = [
  'You are summarizing an external-channel conversation so a Web UI reader can quickly catch up after switching contexts.',
  '',
  'Only use the latest messages, and never copy raw transcript lines.',
  'Do not output role labels (no “你:” / “assistant:” / “user:” / “assistant”).',
  'Use direct 2–5 bullet points in the conversation language.',
  'English: speak using “you”.',
  '中文: 使用“你”。',
  '',
  'Focus on:',
  '- Unfinished tasks or action items',
  '- Pending questions that need replies',
  '- Key decisions made',
  '- Open disagreements or TBD items',
  '',
  'If the conversation is purely casual with no actionable items, say so in one sentence.',
].join('\n')

/** Python `_extract_handoff_text`: a content-part list joins its text parts. */
export function handoffText(content: unknown): string {
  if (Array.isArray(content)) return content.filter(isDict).map((part) => str(part.text || part.content || '')).join(' ').trim()
  return str(content ?? '').trim()
}

// Code points, as Python counts and slices them.
const chars = (text: string): string[] => Array.from(text)
const isConversation = (m: Message): boolean => m.role === 'user' || m.role === 'assistant'
const isChinese = (messages: Message[]): boolean => messages.some((m) => /[一-鿿]/.test(handoffText(m.content)))

/** The transcript the model reads: each user/assistant message's text, capped at 1000 characters. */
export function handoffTranscript(messages: Message[]): string {
  return messages.flatMap((m) => {
    const text = chars(handoffText(m.content)).slice(0, 1000).join('').trim()
    return isConversation(m) && text ? [text] : []
  }).join('\n')
}

function snippet(raw: string, max = 82): string {
  const text = raw.split(/\s+/).filter(Boolean).join(' ')
  const cps = chars(text)
  return cps.length <= max ? text : `${cps.slice(0, max - 1).join('').trimEnd()}…`
}

/** Python `_fallback_handoff_summary`: the last user and assistant point, in the conversation's language. */
export function fallbackHandoffSummary(messages: Message[]): string {
  const chinese = isChinese(messages)
  const user: string[] = []
  const assistant: string[] = []
  for (const m of messages) {
    const text = snippet(handoffText(m.content))
    if (!isConversation(m) || !text) continue
    ;(m.role === 'user' ? user : assistant).push(text)
  }
  if (!user.length && !assistant.length) {
    return chinese ? '近期可读文本不足，无法生成更完整的交接摘要，请补充一条消息后重试。' : 'Not enough readable text to create a useful handoff summary; please send one more message and retry.'
  }
  const enough = user.length + assistant.length >= 2
  const bullets = chinese
    ? [...(user.length ? [`- 你刚讨论了：${user.at(-1)}。`] : []), ...(assistant.length ? [`- 助手已回复：${assistant.at(-1)}。`] : []), enough ? '- 当前对话存在尚未确认的后续动作。' : '- 当前信息偏少，建议补充关键点后再切换。']
    : [...(user.length ? [`- You asked: ${user.at(-1)}.`] : []), ...(assistant.length ? [`- The assistant responded: ${assistant.at(-1)}.`] : []), enough ? '- There is pending context to continue next.' : '- The conversation is still short; add one more turn before summarizing.']
  return bullets.join('\n')
}

/** Python `_summary_output_incomplete`: empty, ellipsized, or a last line that stops mid-sentence. */
export function summaryOutputIncomplete(raw: string): boolean {
  const text = raw.trim()
  if (!text || text.endsWith('...') || text.endsWith('…')) return true
  const last = text.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  if (!last) return true
  if (/[。！？；!?.；]$/.test(last)) return false
  if (chars(last).length >= 56 && !/\b(and|or|so|then|because|if|when|but|as)\b$/i.test(last)) return true
  return /\b(and|or|but|so|because|if|when)$/i.test(last)
}

/** Python `_agent_summary_incomplete`: the provider stopped on its token limit, or the text looks cut off. */
export function completionIncomplete(result: { text: string; finish_reason?: string | null }): boolean {
  const reason = str(result.finish_reason).trim().toLowerCase()
  return reason === 'length' || reason === 'max_tokens' || summaryOutputIncomplete(result.text)
}

interface HandoffPayload { session_id: string; summary: string; channel: unknown; rounds: unknown; fallback: boolean }

/** Python `_build_handoff_summary_tool_message`: an empty `tool_call_id` keeps the marker out of the model's history. */
export function handoffMarker(sid: string, summary: string, channel: string | null, rounds: number, fallback: boolean, now: number): Message {
  const content = JSON.stringify({ _handoff_summary_card: true, session_id: sid, summary: summary.trim(), channel: channel?.trim() || null, rounds, fallback, generated_at: now })
  return { role: 'tool', tool_call_id: '', name: 'handoff_summary', timestamp: now, _ts: now, content }
}

/** A marker's card payload (Python `_extract_handoff_summary_payload` / `_is_matching_handoff_summary_content`). */
export function handoffPayload(content: unknown): HandoffPayload | null {
  let payload: unknown = content
  if (typeof content === 'string') { try { payload = JSON.parse(content) } catch { return null } }
  if (!isDict(payload) || payload._handoff_summary_card !== true || payload.session_id === null || payload.session_id === undefined) return null
  return { session_id: str(payload.session_id), summary: str(payload.summary ?? ''), channel: payload.channel ?? null, rounds: payload.rounds ?? null, fallback: Boolean(payload.fallback) }
}

/** The tail dedupe: the same card regardless of when it was generated. */
export function sameHandoff(a: HandoffPayload | null, b: HandoffPayload | null): boolean {
  return a !== null && b !== null && a.session_id === b.session_id && a.summary === b.summary && a.channel === b.channel && a.rounds === b.rounds && a.fallback === b.fallback
}

/** A WebUI transcript row's card payload: only a `handoff_summary` tool row carries one. */
export function messageHandoffPayload(m: unknown): HandoffPayload | null {
  return isDict(m) && m.role === 'tool' && m.name === 'handoff_summary' ? handoffPayload(m.content) : null
}
