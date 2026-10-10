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

/** `scanPastConsecutiveUsers` keeps scanning past queued opening user rows to the first complete pair (manual regenerate, #7543). */
export function firstExchangeSnippets(messages: unknown[], opts: { scanPastConsecutiveUsers?: boolean } = {}): [string, string] {
  let user = ''
  let asst = ''
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const row = m as Record<string, unknown>
    if (row.role === 'user') {
      const candidate = stripThinkingMarkup(stripWorkspacePrefix(messageText(row.content), true))
      if (candidate && !user) user = candidate
      else if (user && candidate && !opts.scanPastConsecutiveUsers) break
    } else if (row.role === 'assistant' && user) {
      const candidate = messageText(row.content)
      if (row.tool_calls && (!candidate || isBadNewTitle(candidate))) continue
      if (candidate) asst = candidate
    }
    if (user && asst) break
  }
  return [user.slice(0, TITLE_CONTEXT_CHARS), asst.slice(0, TITLE_CONTEXT_CHARS)]
}

/** Python `_latest_exchange_snippets`: the last complete user+assistant pair, walking backwards. */
export function latestExchangeSnippets(messages: unknown[]): [string, string] {
  let user = ''
  let asst = ''
  for (const m of [...messages].reverse()) {
    if (!m || typeof m !== 'object') continue
    const row = m as Record<string, unknown>
    if (row.role === 'assistant' && !asst) {
      const candidate = messageText(row.content)
      if (row.tool_calls && (!candidate || isBadNewTitle(candidate))) continue
      if (candidate) asst = candidate
    } else if (row.role === 'user') {
      const candidate = stripThinkingMarkup(stripWorkspacePrefix(messageText(row.content), true))
      if (!candidate) { user = ''; asst = ''; break }
      if (!user) user = candidate
      if (user && asst) break
    }
  }
  return [user.slice(0, TITLE_CONTEXT_CHARS), asst.slice(0, TITLE_CONTEXT_CHARS)]
}

/** Python `_count_exchanges`: user rows with text. */
export function countExchanges(messages: unknown[]): number {
  return messages.filter((m) => m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user' && messageText((m as Record<string, unknown>).content).trim()).length
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

// ── language drift (Python `_title_language_mismatch`) ───────────────────────

const GERMAN_MARKERS = new Set(['warum', 'werden', 'wird', 'wurde', 'hier', 'nicht', 'mehr', 'alte', 'alten', 'bilder', 'angezeigt', 'prüfe', 'ich', 'und', 'oder', 'mit', 'für', 'von', 'zu', 'ist', 'sind', 'bitte', 'kannst'])
const ENGLISH_MARKERS = new Set(['old', 'image', 'display', 'issue', 'problem', 'discussion', 'conversation', 'session', 'title', 'fix', 'bug', 'attachment', 'attachments', 'context'])

function detectTitleLanguage(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!s) return ''
  const hits = (s.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g) ?? []).filter((tok) => GERMAN_MARKERS.has(tok)).length
  return /[äöüß]/.test(s) || hits >= 3 ? 'de' : ''
}

function scriptCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue
    const o = ch.codePointAt(0) ?? 0
    let bucket: string
    if ((o >= 0x41 && o <= 0x24f) || (o >= 0x1e00 && o <= 0x1eff)) bucket = 'latin'
    else if ((o >= 0x4e00 && o <= 0x9fff) || (o >= 0x3400 && o <= 0x4dbf) || (o >= 0x3040 && o <= 0x30ff) || (o >= 0xac00 && o <= 0xd7a3) || (o >= 0x1100 && o <= 0x11ff)) bucket = 'cjk'
    else if (o >= 0x400 && o <= 0x4ff) bucket = 'cyrillic'
    else if ((o >= 0x600 && o <= 0x6ff) || (o >= 0x750 && o <= 0x77f)) bucket = 'arabic'
    else if (o >= 0x590 && o <= 0x5ff) bucket = 'hebrew'
    else if (o >= 0x370 && o <= 0x3ff) bucket = 'greek'
    else if (o >= 0x900 && o <= 0x97f) bucket = 'devanagari'
    else continue
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  return counts
}

function dominantScript(text: string): string {
  const counts = scriptCounts(text)
  let total = 0
  let top = ''
  let topN = 0
  for (const [script, n] of counts) { total += n; if (n > topN) { top = script; topN = n } }
  if (total < 2) return ''
  return topN / total >= 0.6 ? top : ''
}

/** Reject titles whose script or language clearly diverges from the conversation start. */
export function titleLanguageMismatch(userText: string, title: string): boolean {
  const candidate = title.trim()
  if (!candidate) return false
  const userScript = dominantScript(userText)
  if (userScript) {
    const counts = scriptCounts(candidate)
    let total = 0
    for (const n of counts.values()) total += n
    if (total >= 2) for (const [script, n] of counts) if (script !== userScript && n >= 2 && n / total >= 0.35) return true
  }
  if (detectTitleLanguage(userText) !== 'de') return false
  const lower = candidate.toLowerCase()
  if (detectTitleLanguage(lower) === 'de') return false
  const hits = (lower.match(/[a-z]+/g) ?? []).filter((tok) => ENGLISH_MARKERS.has(tok)).length
  return hits >= 2
}

/** A source name without its trailing ` session` (`Tui Session` → `tui`). */
export function normalizeSourceName(value: unknown): string {
  let source = str(value).trim().toLowerCase()
  if (source.endsWith(' session')) source = source.slice(0, -' session'.length).trim()
  return source
}

/** A title the CLI row got by default (`Cli Session`, `Tui Session`, ...), which title generation may replace. */
export function looksLikeDefaultCliTitle(row: Record<string, unknown>): boolean {
  const title = str(row.title).trim().toLowerCase()
  if (!title || title === 'untitled' || title === 'cli' || title === 'cli session') return true
  const candidates = new Set([row.source, row.session_source, row.source_tag, row.raw_source, row.source_label].map(normalizeSourceName).filter(Boolean))
  candidates.add('cli')
  return [...candidates].some((c) => title === `${c} session`)
}
