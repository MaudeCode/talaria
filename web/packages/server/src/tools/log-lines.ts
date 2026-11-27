/** TAL-2139: the Logs page's line classifier. Pure: a log tail in, its classified and filtered entries, counts and matches out. */
import type { LogEntry, LogLevel, LogLevelFilter } from '@maudecode/talaria-web-contracts'

/** A leading timestamp as Hermes, Python logging and ISO 8601 write it, optionally in brackets: `2026-11-08 12:01:03,123`, `2026-11-08T12:01:03Z`, `12:01:03`. */
const TIMESTAMP = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]?(?:\s+|$)/
/** A `[tag]` that opens a record of its own, as this server writes (`[webui]`, `[updates]`): it starts a line, not a continuation. */
const RECORD_TAG = /^(\[[A-Za-z][\w.:-]*\])(?:\s+|$)/
const TOKEN_LEVEL: Record<string, LogLevel> = { critical: 'error', fatal: 'error', error: 'error', warning: 'warning', warn: 'warning', info: 'info', debug: 'debug', trace: 'debug' }
const LEVEL_WORDS = Object.keys(TOKEN_LEVEL).join('|')
const LEVEL_HEADER = new RegExp(String.raw`^(?:\[(${LEVEL_WORDS})\]|(${LEVEL_WORDS}))(?=[:\s]|$):?\s*`, 'i')
/** Hermes verbose logs use `time - logger - LEVEL [optional session] - message`. */
const VERBOSE_HEADER = new RegExp(String.raw`^- ([\w.:-]+) - (${LEVEL_WORDS})( \[[^\]\r\n]+\])? - `, 'i')
/** The most search highlights one answer carries; lines past it still match, unmarked, so a one-letter query over a large log stays small. */
export const MAX_MATCHES = 2000

export interface ClassifiedLog {
  entries: LogEntry[]
  counts: { error: number; warning: number; lines: number }
  count_tones: { error: 'error' | null; warning: 'warning' | null }
  matched: number
}

/** Only a recognized header sets severity. Untimed, untagged continuations inherit it. */
export function classifyLine(line: string, previous: LogLevel | null): Omit<LogEntry, 'matches'> {
  const stamp = TIMESTAMP.exec(line)
  const time = stamp?.[1] ?? null
  const rest = stamp ? line.slice(stamp[0].length) : line
  // A leading `[ERROR]` is itself a level, even if the message starts with another level word.
  const leading = LEVEL_HEADER.exec(rest)
  const tag = leading ? null : RECORD_TAG.exec(rest)
  const afterTag = tag ? rest.slice(tag[0].length) : rest
  const token = leading ?? (tag && LEVEL_HEADER.exec(afterTag))
  if (token) {
    const message = afterTag.slice(token[0].length)
    const text = tag ? [tag[1], message].filter(Boolean).join(' ') : message
    return { text, level: TOKEN_LEVEL[(token[1] ?? token[2] ?? '').toLowerCase()] ?? null, time }
  }
  const verbose = stamp ? VERBOSE_HEADER.exec(rest) : null
  if (verbose) {
    const text = `${verbose[1]}${verbose[3] ?? ''}: ${rest.slice(verbose[0].length)}`
    return { text, level: TOKEN_LEVEL[verbose[2]?.toLowerCase() ?? ''] ?? null, time }
  }
  return { text: rest, level: stamp || tag ? null : previous, time }
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
  let budget = MAX_MATCHES
  for (const line of lines) {
    const entry: LogEntry = classifyLine(line, previous)
    previous = entry.level
    if (entry.level === 'error') counts.error += 1
    else if (entry.level === 'warning') counts.warning += 1
    if (filter.level === 'error' && entry.level !== 'error') continue
    if (filter.level === 'warning' && entry.level !== 'error' && entry.level !== 'warning') continue
    if (needle !== undefined && !line.toLowerCase().includes(needle)) continue
    if (pattern) {
      entry.matches = []
      for (const hit of entry.text.matchAll(pattern)) {
        if (budget === 0) break
        entry.matches.push([hit.index, hit.index + hit[0].length])
        budget -= 1
      }
    }
    entries.push(entry)
  }
  // Any error or warning in the tail marks its count; the page colours what is marked.
  const countTones = { error: counts.error > 0 ? 'error' as const : null, warning: counts.warning > 0 ? 'warning' as const : null }
  return { entries, counts, count_tones: countTones, matched: entries.length }
}
