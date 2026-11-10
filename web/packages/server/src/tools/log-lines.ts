/** TAL-2139: the Logs page's line classifier. Pure: a log tail in, its classified and filtered entries, counts and matches out. */
import type { LogEntry, LogLevel, LogLevelFilter } from '@maudecode/talaria-web-contracts'

/** A leading timestamp as Hermes, Python logging and ISO 8601 write it, optionally in brackets: `2026-11-08 12:01:03,123`, `2026-11-08T12:01:03Z`, `12:01:03`. */
const TIMESTAMP = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]?(?:\s+|$)/
const TOKEN = /\b(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/i
const TOKEN_LEVEL: Record<string, LogLevel> = { critical: 'error', fatal: 'error', error: 'error', warning: 'warning', warn: 'warning', info: 'info', debug: 'debug', trace: 'debug' }
/** Only a token this close to the start of a line names its level; one further in is message text. */
const TOKEN_WINDOW = 80

export interface ClassifiedLog {
  entries: LogEntry[]
  counts: { error: number; warning: number; lines: number }
  count_tones: { error: 'error' | null; warning: 'warning' | null }
  matched: number
}

/** Drops the token (with brackets around it and a colon after it) and joins what is left with one space. */
function withoutToken(rest: string, index: number, length: number): string {
  let before = rest.slice(0, index)
  let after = rest.slice(index + length)
  if (before.endsWith('[') && after.startsWith(']')) { before = before.slice(0, -1); after = after.slice(1) }
  after = after.replace(/^:/, '').trimStart()
  before = before.trimEnd()
  return before && after ? `${before} ${after}` : before + after
}

/** One line's level, time and text. A line with no token and no timestamp (a traceback continuation) takes `previous`. */
export function classifyLine(line: string, previous: LogLevel | null): Omit<LogEntry, 'matches'> {
  const stamp = TIMESTAMP.exec(line)
  const rest = stamp ? line.slice(stamp[0].length) : line
  const offset = stamp ? stamp[0].length : 0
  const token = TOKEN.exec(rest)
  if (token && offset + token.index < TOKEN_WINDOW) {
    return { text: withoutToken(rest, token.index, token[0].length), level: TOKEN_LEVEL[token[0].toLowerCase()] ?? null, time: stamp?.[1] ?? null }
  }
  return { text: rest, level: stamp ? null : previous, time: stamp?.[1] ?? null }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Classifies a tail, counts it, then keeps the lines that contain `q` (case-insensitively) and reach `level`
 * (`warning` keeps warnings and errors). `counts` covers the whole tail; `matched` is what the filters keep.
 */
export function classifyLog(lines: readonly string[], filter: { q?: string | undefined; level?: LogLevelFilter | undefined } = {}): ClassifiedLog {
  const q = filter.q?.trim() ? filter.q : undefined
  const needle = q?.toLowerCase()
  const pattern = q ? new RegExp(escapeRegExp(q), 'gi') : null
  const counts = { error: 0, warning: 0, lines: lines.length }
  const entries: LogEntry[] = []
  let previous: LogLevel | null = null
  for (const line of lines) {
    const entry: LogEntry = classifyLine(line, previous)
    previous = entry.level
    if (entry.level === 'error') counts.error += 1
    else if (entry.level === 'warning') counts.warning += 1
    if (filter.level === 'error' && entry.level !== 'error') continue
    if (filter.level === 'warning' && entry.level !== 'error' && entry.level !== 'warning') continue
    if (needle !== undefined && !line.toLowerCase().includes(needle)) continue
    if (pattern) entry.matches = [...entry.text.matchAll(pattern)].map((hit) => [hit.index, hit.index + hit[0].length])
    entries.push(entry)
  }
  // Any error or warning in the tail marks its count; the page colours what is marked.
  const countTones = { error: counts.error > 0 ? 'error' as const : null, warning: counts.warning > 0 ? 'warning' as const : null }
  return { entries, counts, count_tones: countTones, matched: entries.length }
}
