/**
 * TAL-551: read-only Claude Code transcripts (Python `get_claude_code_sessions`). Each top-level `*.jsonl` in a
 * project directory under `~/.claude/projects` (or `HERMES_WEBUI_CLAUDE_PROJECTS_DIR`) is one imported session. The
 * scan skips symlinks, oversized files, malformed lines and unreadable files, and caches each parse on the file's stat
 * signature, so a sidebar refresh re-reads only transcripts that changed.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from './session.js'
import { str } from '../util.js'

export const CLAUDE_CODE_SOURCE = 'claude_code'
const MAX_FILES = 200
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_MESSAGES_PER_FILE = 1000
const MAX_CONTENT_CHARS = 200_000
const ROLES = new Set(['user', 'assistant', 'system', 'tool'])

type Row = Record<string, unknown>
interface Parsed { messages: Message[]; summaryTitle: string | null; firstTs: number | null; lastTs: number | null }

/** The projects directory: the env override (`~` expanded), else `<home>/.claude/projects`. */
export function claudeCodeProjectsDir(env: Record<string, string | undefined>, home: string): string {
  const override = (env.HERMES_WEBUI_CLAUDE_PROJECTS_DIR ?? '').trim()
  return override ? override.replace(/^~(?=$|\/)/, home) : join(home, '.claude', 'projects')
}

export function isClaudeCodeSessionId(sid: string): boolean {
  return sid.startsWith(`${CLAUDE_CODE_SOURCE}_`)
}

function sessionId(path: string): string {
  return `${CLAUDE_CODE_SOURCE}_${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 24)}`
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const n = Number(text)
  if (Number.isFinite(n)) return n
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : ms / 1000
}

function text(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content.slice(0, MAX_CONTENT_CHARS)
  if (Array.isArray(content)) {
    const parts: string[] = []
    let used = 0
    for (const item of content) {
      const raw: unknown = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as Row).text || (item as Row).content || '' : ''
      if (!raw) continue
      const remaining = MAX_CONTENT_CHARS - used
      if (remaining <= 0) break
      const part = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, remaining)
      parts.push(part)
      used += part.length
    }
    return parts.join('\n')
  }
  if (typeof content === 'object') return text((content as Row).text || (content as Row).content)
  return str(content).slice(0, MAX_CONTENT_CHARS)
}

const asDict = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)

/** Python `_parse_claude_code_jsonl`: user/assistant/system/tool rows with text, a summary title, and the time span. */
function parse(path: string): Parsed {
  const messages: Message[] = []
  let summaryTitle: string | null = null
  let firstTs: number | null = null
  let lastTs: number | null = null
  let body: string
  // Read through the handle that was checked: a transcript swapped for a symlink or grown past the cap is skipped.
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (fstatSync(fd).size > MAX_FILE_BYTES) return { messages, summaryTitle, firstTs, lastTs }
    body = readFileSync(fd, 'utf8')
  } catch {
    return { messages, summaryTitle, firstTs, lastTs }
  } finally {
    if (fd !== null) closeSync(fd)
  }
  for (const line of body.split('\n')) {
    if (messages.length >= MAX_MESSAGES_PER_FILE) break
    if (!line.trim()) continue
    let raw: Row | null
    try { raw = asDict(JSON.parse(line)) } catch { continue }
    if (!raw) continue
    if (!summaryTitle) {
      const summary = raw.summary || raw.title
      if (typeof summary === 'string' && summary.trim()) summaryTitle = summary.split(/\s+/).filter(Boolean).join(' ').slice(0, 80)
    }
    const records: unknown[] = Array.isArray(raw.messages) ? raw.messages : [asDict(raw.message) ?? raw]
    for (const record of records) {
      if (messages.length >= MAX_MESSAGES_PER_FILE) break
      const rec = asDict(record)
      if (!rec) continue
      const msg = asDict(rec.message) ?? rec
      let role = str(msg.role || rec.role || raw.role || raw.type).trim().toLowerCase()
      if (role === 'human') role = 'user'
      if (!ROLES.has(role)) continue
      const content = text('content' in msg ? msg.content : rec.content)
      if (!content.trim()) continue
      const ts = timestamp(msg.timestamp || rec.timestamp || raw.timestamp || raw.created_at)
      if (ts !== null) {
        firstTs = firstTs === null ? ts : Math.min(firstTs, ts)
        lastTs = lastTs === null ? ts : Math.max(lastTs, ts)
      }
      messages.push(ts === null ? { role, content } : { role, content, timestamp: ts })
    }
  }
  return { messages, summaryTitle, firstTs, lastTs }
}

function title(parsed: Parsed): string {
  if (parsed.summaryTitle) return parsed.summaryTitle
  for (const m of parsed.messages) {
    if (m.role !== 'user') continue
    const t = str(m.content).split(/\s+/).filter(Boolean).join(' ')
    if (t) return t.slice(0, 80)
  }
  return 'Claude Code Session'
}

export class ClaudeCodeSessionSource {
  private cache = new Map<string, { stamp: string; parsed: Parsed }>()
  constructor(private readonly dir: () => string) {}

  /** Python `_iter_claude_code_jsonl_files`: at most 200 regular `*.jsonl` files, sorted by project then file name. */
  private files(): { path: string; stamp: string; mtime: number }[] {
    const out: { path: string; stamp: string; mtime: number }[] = []
    let root: string
    try {
      if (lstatSync(this.dir()).isSymbolicLink()) return out
      root = realpathSync(this.dir())
      if (!statSync(root).isDirectory()) return out
    } catch { return out }
    let projects: string[]
    try { projects = readdirSync(root).sort() } catch { return out }
    for (const project of projects) {
      const projectDir = join(root, project)
      let names: string[]
      try {
        if (!lstatSync(projectDir).isDirectory()) continue
        names = readdirSync(projectDir).sort()
      } catch { continue }
      for (const name of names) {
        if (out.length >= MAX_FILES) return out
        if (!name.toLowerCase().endsWith('.jsonl')) continue
        const path = join(projectDir, name)
        try {
          const st = lstatSync(path, { bigint: true })
          if (!st.isFile() || st.size > BigInt(MAX_FILE_BYTES)) continue
          out.push({ path, stamp: `${st.size.toString()}:${st.mtimeNs.toString()}:${st.ctimeNs.toString()}`, mtime: Number(st.mtimeMs) / 1000 })
        } catch { continue }
      }
    }
    return out
  }

  private parsed(file: { path: string; stamp: string }): Parsed {
    const hit = this.cache.get(file.path)
    if (hit?.stamp === file.stamp) return hit.parsed
    const parsed = parse(file.path)
    this.cache.set(file.path, { stamp: file.stamp, parsed })
    return parsed
  }

  /** The sidebar rows, newest first: read-only external-agent sessions that belong to no Hermes profile. */
  rows(workspace: string): Row[] {
    const files = this.files()
    // Drop cache entries for transcripts that left the scan, so the cache stays bounded by it.
    const live = new Set(files.map((f) => f.path))
    for (const path of this.cache.keys()) if (!live.has(path)) this.cache.delete(path)
    const rows: Row[] = []
    for (const file of files) {
      const parsed = this.parsed(file)
      if (!parsed.messages.length) continue
      const fallback = !parsed.firstTs && !parsed.lastTs ? file.mtime : null
      const createdAt = parsed.firstTs || parsed.lastTs || fallback
      const updatedAt = parsed.lastTs || parsed.firstTs || fallback
      rows.push({
        session_id: sessionId(file.path), title: title(parsed), workspace, model: 'claude-code', message_count: parsed.messages.length,
        created_at: createdAt, updated_at: updatedAt, last_message_at: updatedAt, pinned: false, archived: false, project_id: null, profile: null,
        source_tag: CLAUDE_CODE_SOURCE, raw_source: CLAUDE_CODE_SOURCE, session_source: 'external_agent', source_label: 'Claude Code',
        is_cli_session: true, read_only: true,
      })
    }
    return rows.sort((a, b) => Number(b.last_message_at ?? 0) - Number(a.last_message_at ?? 0))
  }

  /** One transcript's messages, or none when no scanned file has this id. */
  messages(sid: string): Message[] {
    if (!isClaudeCodeSessionId(sid)) return []
    const file = this.files().find((f) => sessionId(f.path) === sid)
    return file ? [...this.parsed(file).messages] : []
  }
}
