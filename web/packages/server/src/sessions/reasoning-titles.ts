/** Python `api/reasoning_titles.py`: a small, provider-neutral reasoning-title fallback for WebUI clients. */
import { redactString } from '../redact.js'
import { str } from '../util.js'

const BOLD_LINE = /^\s*\*\*(.+?)\*\*\s*$/
const COMMAND_LINE = /^(?:[$>]\s*|(?:\.{0,2}\/)|(?:sudo|env|git|cd|ls|cat|python|node|curl|wget|rg|grep|npm|npx|pnpm|yarn|bun|deno|make|cmake|docker|podman|kubectl|helm|terraform|ansible|xcodebuild|xcrun|swift|go|cargo|rustc|pip|pip3|pytest|bash|sh|zsh|fish|rm|cp|mv|chmod|chown|sed|awk)\b)/i
const TOOL_ARGUMENT_LINE = /^(?:--[\w-]+(?:\s|=)|[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+|(?:args?|arguments?|input|params?)\s*[:=]\s*[[{])/i
const MARKDOWN_PREFIX = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/
const SENSITIVE_TITLE = /\b(?:password|passwd|credentials?|secret|ssn)\b|authorization\s*:|private\s+tool\s+output|\b\d{3}-\d{2}-\d{4}\b/i

function cleanTitle(value: unknown, explicit = false): string {
  let title = str(value).split(/\s+/).filter(Boolean).join(' ').trim()
  if (!title || title.length > 400) return ''
  title = title.replace(MARKDOWN_PREFIX, '').trim()
  if (!title || ['```', '~~~', '<', '{', '['].some((p) => title.startsWith(p))) return ''
  if (SENSITIVE_TITLE.test(title) || redactString(title, true) !== title) return ''
  if (COMMAND_LINE.test(title) || TOOL_ARGUMENT_LINE.test(title)) return ''
  if (!explicit) {
    try { const parsed: unknown = JSON.parse(title); if (parsed && typeof parsed === 'object') return '' } catch { /* prose */ }
  }
  if (title.length <= 80) return title
  const head = title.slice(0, 80)
  const cut = head.lastIndexOf(' ')
  const shortened = (cut > 0 ? head.slice(0, cut) : head).replace(/[ ,.;:-]+$/, '')
  return shortened.length >= 24 ? shortened : ''
}

function uniqueTitles(values: unknown, explicit = false): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const title = cleanTitle(value, explicit)
    const key = title.toLowerCase()
    if (!title || seen.has(key)) continue
    seen.add(key)
    out.push(title)
    if (out.length === 8) break
  }
  return out
}

function reasoningLines(raw: string): [string, boolean][] {
  const lines: [string, boolean][] = []
  let fence: string | null = null
  for (const line of raw.split(/(?<=\r\n|\n|\r)/)) {
    if (!line) continue
    const stripped = line.replace(/^\s+/, '')
    const marker = stripped.startsWith('```') || stripped.startsWith('~~~') ? stripped.slice(0, 3) : ''
    if (marker) {
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      lines.push([line, false])
      continue
    }
    lines.push([line, fence === null])
  }
  return lines
}

/** Python `normalize_reasoning_titles`: an ordered title snapshot without guessing from partial prose. */
export function normalizeReasoningTitles(text: unknown, opts: { explicitTitles?: unknown; stable?: boolean } = {}): string[] {
  if (opts.explicitTitles !== undefined && opts.explicitTitles !== null) return uniqueTitles(opts.explicitTitles, true)
  const lines = reasoningLines(str(text))
  const bold: string[] = []
  for (const [line, safe] of lines) { if (!safe) continue; const m = BOLD_LINE.exec(line); if (m?.[1]) bold.push(m[1]) }
  const titles = uniqueTitles(bold)
  if (titles.length) return titles
  for (let i = 0; i < lines.length; i += 1) {
    const [line, safe] = lines[i]!
    if (!line.trim()) continue
    if (!safe) return []
    const complete = line.endsWith('\n') || line.endsWith('\r') || Boolean(opts.stable) || i < lines.length - 1
    if (!complete) return []
    const title = cleanTitle(line)
    return title ? [title] : []
  }
  return []
}

/** Python `reasoning_event_payload`. */
export function reasoningEventPayload(delta: unknown, cumulative: unknown, opts: { explicitTitles?: unknown; stable?: boolean } = {}): { text: string; titles?: string[] } {
  const payload: { text: string; titles?: string[] } = { text: str(delta) }
  const titles = normalizeReasoningTitles(opts.stable ? cumulative : delta, opts)
  if (titles.length || (opts.explicitTitles !== undefined && opts.explicitTitles !== null)) payload.titles = titles
  return payload
}

/**
 * Per-stream title bookkeeping (Python `_prepare_reasoning_titles` / `_remember_reasoning_titles` /
 * `_reset_reasoning_title_segment`): a new reasoning segment after titles were shown must clear them once.
 */
export class ReasoningTitleTracker {
  private lastSent: string[] = []
  private needClear = false

  prepare(payload: { text: string; titles?: string[] }): { text: string; titles?: string[] } {
    if (this.needClear && !('titles' in payload)) payload.titles = []
    if (payload.titles) { this.lastSent = [...payload.titles]; this.needClear = false }
    return payload
  }

  /** A content/tool boundary closed the reasoning segment: a stable snapshot (or a clear) may be due. */
  stableSnapshot(cumulative: string): string[] | null {
    const titles = normalizeReasoningTitles(cumulative, { stable: true })
    if (JSON.stringify(titles) !== JSON.stringify(this.lastSent) && (titles.length || this.needClear)) {
      this.lastSent = [...titles]
      this.needClear = false
      return titles
    }
    return null
  }

  resetSegment(): void {
    this.needClear = this.lastSent.length > 0
    this.lastSent = []
  }
}
