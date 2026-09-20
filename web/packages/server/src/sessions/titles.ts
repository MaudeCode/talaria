/** Session title generation after the first exchange (Python `api/streaming.py` title helpers, reduced to the aux path). */
import { messageText, stripWorkspacePrefix } from './merge.js'
import { str } from '../util.js'

export const GENERATED_TITLE_MAX_CHARS = 50
const TITLE_CONTEXT_CHARS = 2000

export function stripThinkingMarkup(text: string): string {
  return text.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/<think(?:ing)?\b[^>]*>[\s\S]*/i, '').trim()
}

export function looksInvalidGeneratedTitle(text: unknown): boolean {
  const s = str(text)
  if (!s.trim()) return true
  return /<think>|<\|channel\|>thought|<\|turn\|>thinking/i.test(s) || /^\s*(the|ther)\s+user\s+/i.test(s) || /^\s*user\s+\w+\s+/i.test(s)
    || /\b(they|user)\s+want(s)?\s+me\s+to\b/i.test(s) || /^\s*(i|we)\s+(should|need to|will|can)\b/i.test(s) || /^\s*let me\b/i.test(s) || /^\s*here(?:'s| is) (?:a |my )?(?:thinking|thought)/i.test(s)
}

export function isBadNewTitle(text: unknown): boolean {
  if (looksInvalidGeneratedTitle(text)) return true
  const s = str(text).trim()
  const token = s.replace(/[\s.!?]+$/, '')
  if (/^(?:pong|ping|yes|no|yep|nope|hi|hello|hey|thanks|thank you|sure|k|kk|cool|nice|lol|ok|okay|done)$/i.test(token)) return true
  return /^\s*(ok|okay|done|all set|complete|completed|finished)\b[\s.!?]*$/i.test(s)
}

export function sanitizeGeneratedTitle(text: unknown): string {
  let s = stripThinkingMarkup(str(text))
  s = s.replace(/^\s*(?:[*_`~]+\s*)?(?:session\s+title|title)\s*:\s*(?:[*_`~]+\s*)?/i, '')
  s = s.replace(/^\s*title\s*:\s*/i, '')
  s = s.replace(/^[\s"'`*_~]+|[\s"'`*_~]+$/g, '')
  s = s.split(/\s+/).join(' ').trim()
  if (isBadNewTitle(s)) return ''
  return s.slice(0, GENERATED_TITLE_MAX_CHARS)
}

export function firstExchangeSnippets(messages: unknown[]): [string, string] {
  let user = ''
  let asst = ''
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const row = m as Record<string, unknown>
    if (row.role === 'user') {
      const candidate = stripThinkingMarkup(stripWorkspacePrefix(messageText(row.content), true))
      if (candidate && !user) user = candidate
      else if (user && candidate) break
    } else if (row.role === 'assistant' && user) {
      const candidate = messageText(row.content)
      if (row.tool_calls && (!candidate || isBadNewTitle(candidate))) continue
      if (candidate) asst = candidate
    }
    if (user && asst) break
  }
  return [user.slice(0, TITLE_CONTEXT_CHARS), asst.slice(0, TITLE_CONTEXT_CHARS)]
}

export function titlePrompts(userText: string, assistantText: string): [string, string[]] {
  const userContext = userText.slice(0, TITLE_CONTEXT_CHARS)
  let qa = `User request:\n${userContext}`
  const assistantContext = assistantText.trim()
  const budget = TITLE_CONTEXT_CHARS - userContext.length
  if (assistantContext && budget > 0) qa += `\n\nAssistant context (use only to clarify vague references or concrete terminology):\n${assistantContext.slice(0, budget)}`
  const prompts = [
    'Generate a title that will help the user recognize this conversation weeks later.\nBefore answering, silently identify:\n- Subject: What system, feature, question, or problem is this really about?\n- Outcome: What does the user want to understand or change?\n- Incidental instructions: What only describes how the work should be performed?\nTitle the subject and desired outcome. Discard incidental instructions.\n'
      + `Return only the title, using 3-8 words and no more than ${String(GENERATED_TITLE_MAX_CHARS)} characters.\nUse a compact noun phrase or clear action phrase.\nPrefer the user's explicit goal.\nUse assistant context only to resolve vague references or identify concrete terminology.\nDo not turn one assistant finding into the conversation's subject.\nCapture the umbrella goal when several symptoms or steps are listed.\nIgnore models, tools, agents, output formats, plans, tests, commits, and workflow status unless they are the actual topic.\nFor research, name the question domain rather than the research process.\nPreserve useful identifiers such as ticket numbers.\nDo not claim completion or copy and truncate the user's message.\nDo not use markdown, quotes, labels, or trailing punctuation.`,
    `Rewrite the user request as a durable conversation title.\nIdentify the real subject and desired outcome, ignoring incidental workflow instructions.\nPrefer the user's explicit goal; use assistant context only to clarify concrete terminology.\nReturn only a 3-8 word title of no more than ${String(GENERATED_TITLE_MAX_CHARS)} characters.\nDo not use markdown, labels, completion status, or meta commentary.`,
  ]
  return [qa, prompts]
}

const STOP_EN = new Set(['the', 'this', 'that', 'with', 'from', 'into', 'just', 'reply', 'please', 'need', 'needs', 'want', 'wants', 'user', 'assistant', 'could', 'would', 'should', 'about', 'there', 'here', 'test', 'testing', 'title', 'summary'])

/** Python `_fallback_title_from_exchange` (keyword rules kept, named-topic branch reduced). */
export function fallbackTitleFromExchange(userText: string, assistantText: string): string | null {
  const user = stripWorkspacePrefix(userText.trim()).split(/\s+/).join(' ').trim()
  if (!user) return null
  const asst = stripThinkingMarkup(assistantText).split(/\s+/).join(' ').trim()
  const combined = `${user} ${asst}`.trim().toLowerCase()
  const combinedRaw = `${user} ${asst}`.trim()
  const named = /"([^"\n]{2,24})"/.exec(combinedRaw)?.[1] ?? /“([^”\n]{2,24})”/.exec(combinedRaw)?.[1] ?? ''
  const timeish = ['time', 'schedule', 'efficiency', 'manage', 'fitness', 'singing', 'calligraphy'].some((k) => combined.includes(k))
  const aiish = ['hermes', 'codex', 'ai'].some((k) => combined.includes(k))
  if (named.trim()) {
    const topic = named.trim()
    if (!/[A-Za-z]/.test(topic)) return timeish ? 'Time management discussion' : aiish ? 'AI productivity discussion' : 'Conversation topic'
    if (timeish) return `${topic} time management`
    if (aiish) return `${topic} AI productivity`
    return `${topic} discussion`
  }
  if (['title', 'session title'].some((k) => combined.includes(k)) && ['summary', 'summar', 'short title'].some((k) => combined.includes(k))) {
    return ['test', 'ok', 'reply ok'].some((k) => combined.includes(k)) ? 'Session title auto-summary test' : 'Session title auto-summary'
  }
  if (['clarify', 'clarification'].some((k) => combined.includes(k)) && ['dialog', 'card'].some((k) => combined.includes(k))) return 'Clarify dialog card'
  if (['issue', 'github', 'pr'].some((k) => combined.includes(k)) && ['triage', 'bug', 'review'].some((k) => combined.includes(k))) return 'GitHub Issue Triage'
  const head = (user.split(/[.!?\n]/)[0] ?? '').trim()
  if (!head) return null
  const tokens = head.match(/[A-Za-z0-9À-ÖØ-öø-ÿ][A-Za-z0-9À-ÖØ-öø-ÿ_./+-]*/g) ?? []
  if (!tokens.length) return 'Conversation topic'
  const picked: string[] = []
  for (const tok of tokens) {
    const lower = tok.toLowerCase()
    if (STOP_EN.has(lower) || lower.length < 3) continue
    if (!picked.includes(tok)) picked.push(tok)
    if (picked.length >= 4) break
  }
  return picked.length ? picked.join(' ').slice(0, GENERATED_TITLE_MAX_CHARS) : 'Conversation topic'
}

export const isGenericFallbackTitle = (title: string): boolean => title.trim().toLowerCase() === 'conversation topic'
