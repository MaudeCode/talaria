/**
 * TAL-551: read-only Claude Code transcripts (Python `get_claude_code_sessions`). Each top-level `*.jsonl` in a
 * project directory under `~/.claude/projects` (or `HERMES_WEBUI_CLAUDE_PROJECTS_DIR`) is one imported session. The
 * scan skips symlinks, oversized files, malformed lines and unreadable files, and caches each parse on the file's stat
 * signature, so a sidebar refresh re-reads only transcripts that changed. TAL-1735: the file list lasts `SCAN_TTL_MS`
 * unless a directory's signature changes, and a known id goes straight to its one file. All of it is async I/O.
 */
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Message } from './session.js'
import { singleFlightRead, str, type SingleFlightEntry } from '../util.js'

export const CLAUDE_CODE_SOURCE = 'claude_code'
const MAX_FILES = 200
const SCAN_TTL_MS = 5000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_MESSAGES_PER_FILE = 1000
const MAX_CONTENT_CHARS = 200_000
const ROLES = new Set(['user', 'assistant', 'system', 'tool'])

type Row = Record<string, unknown>
interface Parsed { messages: Message[]; summaryTitle: string | null; firstTs: number | null; lastTs: number | null }
interface Transcript { path: string; stamp: string; mtime: number }
/** One walk's answer. `dirs` holds the signature of the root and of each project directory, taken before reading it. */
interface Scan { files: Transcript[]; bySid: Map<string, Transcript>; dirs: Map<string, string | null> }

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

/**
 * One bounded read without following links: a transcript swapped for a symlink, or grown past the cap since the scan, is
 * skipped rather than read in full. `FileHandle.readFile` would hold the handle but not the cap.
 */
async function readTranscript(path: string): Promise<string> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    // One byte past the size it has now (at most the cap) shows whether it has outgrown the cap since.
    const buf = Buffer.alloc(Math.min((await handle.stat()).size, MAX_FILE_BYTES) + 1)
    let n = 0
    for (let got = -1; got !== 0 && n < buf.length;) { got = (await handle.read(buf, n, buf.length - n, n)).bytesRead; n += got }
    return n > MAX_FILE_BYTES ? '' : buf.toString('utf8', 0, n)
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Python `_parse_claude_code_jsonl`: user/assistant/system/tool rows with text, a summary title, and the time span. */
function parse(body: string): Parsed {
  const messages: Message[] = []
  let summaryTitle: string | null = null
  let firstTs: number | null = null
  let lastTs: number | null = null
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

/** Changes when a directory gains, loses or renames an entry, or is replaced. An append to a transcript leaves it alone. */
const dirStamp = (st: BigIntStats): string => `${st.dev.toString()}:${st.ino.toString()}:${st.mode.toString()}:${st.mtimeNs.toString()}:${st.ctimeNs.toString()}`
const dirStampAt = (path: string): Promise<string | null> => lstat(path, { bigint: true }).then(dirStamp, () => null)

/** A regular transcript within the cap, or null. */
async function transcriptAt(path: string): Promise<Transcript | null> {
  try {
    const st = await lstat(path, { bigint: true })
    if (!st.isFile() || st.size > BigInt(MAX_FILE_BYTES)) return null
    return { path, stamp: `${st.size.toString()}:${st.mtimeNs.toString()}:${st.ctimeNs.toString()}`, mtime: Number(st.mtimeMs) / 1000 }
  } catch { return null }
}

/** Python `_iter_claude_code_jsonl_files`: every regular `*.jsonl`, recording each directory's signature in `dirs`. */
async function discover(dir: string, dirs: Scan['dirs']): Promise<Transcript[]> {
  const out: Transcript[] = []
  dirs.set(dir, await dirStampAt(dir))
  let root: string
  let projects: string[]
  try {
    if ((await lstat(dir)).isSymbolicLink()) return out
    root = await realpath(dir)
    if (!(await stat(root)).isDirectory()) return out
    projects = (await readdir(root)).sort()
  } catch { return out }
  // One at a time: a project can hold thousands of files, and a parallel stat of them would queue ahead of all other fs work.
  for (const project of projects) {
    const projectDir = join(root, project)
    let names: string[]
    try {
      const st = await lstat(projectDir, { bigint: true })
      if (!st.isDirectory()) continue
      dirs.set(projectDir, dirStamp(st))
      names = (await readdir(projectDir)).sort()
    } catch { continue }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue
      const file = await transcriptAt(join(projectDir, name))
      if (file) out.push(file)
    }
  }
  return out
}

function row(file: Transcript, parsed: Parsed, workspace: string): Row | null {
  if (!parsed.messages.length) return null
  const fallback = !parsed.firstTs && !parsed.lastTs ? file.mtime : null
  const createdAt = parsed.firstTs || parsed.lastTs || fallback
  const updatedAt = parsed.lastTs || parsed.firstTs || fallback
  return {
    session_id: sessionId(file.path), title: title(parsed), workspace, model: 'claude-code', message_count: parsed.messages.length,
    created_at: createdAt, updated_at: updatedAt, last_message_at: updatedAt, pinned: false, archived: false, project_id: null, profile: null,
    source_tag: CLAUDE_CODE_SOURCE, raw_source: CLAUDE_CODE_SOURCE, session_source: 'external_agent', source_label: 'Claude Code',
    is_cli_session: true, read_only: true,
  }
}

export class ClaudeCodeSessionSource {
  private cache = new Map<string, { stamp: string; parsed: Promise<Parsed> }>()
  private scans = new Map<string, SingleFlightEntry<Scan>>()
  constructor(private readonly dir: () => string) {}

  /** The cached listing while it is young and no directory's signature moved, else a new walk. Concurrent callers share one. */
  private async scan(): Promise<Scan> {
    const dir = this.dir()
    const now = (): number => performance.now()
    const held = this.scans.get(dir)
    if (held && held.until > now()) {
      const { dirs } = await held.read
      for (const [path, stamp] of dirs) {
        if (await dirStampAt(path) === stamp) continue
        if (this.scans.get(dir) === held) this.scans.delete(dir)
        break
      }
    }
    return singleFlightRead(this.scans, dir, SCAN_TTL_MS, now, () => this.walk(dir))
  }

  private async walk(dir: string): Promise<Scan> {
    const dirs: Scan['dirs'] = new Map()
    // The cap keeps the newest transcripts, so a new conversation is never crowded out by older ones.
    const files = (await discover(dir, dirs)).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES)
    // Drop cache entries for transcripts that left the scan, so the cache stays bounded by it.
    const live = new Set(files.map((f) => f.path))
    for (const path of this.cache.keys()) if (!live.has(path)) this.cache.delete(path)
    return { files, bySid: new Map(files.map((f) => [sessionId(f.path), f])), dirs }
  }

  private parsed(file: Transcript): Promise<Parsed> {
    const hit = this.cache.get(file.path)
    if (hit?.stamp === file.stamp) return hit.parsed
    const parsed = readTranscript(file.path).then(parse)
    this.cache.set(file.path, { stamp: file.stamp, parsed })
    return parsed
  }

  /**
   * The transcript an id names, restamped from its own file so an open sees the latest. A known id walks nothing, however
   * old the listing; an unknown one (a deep link after a restart) goes through the cached scan. The listing's entry is
   * updated in place, so the next list reuses this parse rather than re-reading under the older stamp.
   */
  private async locate(sid: string): Promise<Transcript | null> {
    if (!isClaudeCodeSessionId(sid)) return null
    const known = (await this.scans.get(this.dir())?.read)?.bySid.get(sid) ?? (await this.scan()).bySid.get(sid)
    if (!known) return null
    // The walk refuses a symlinked root or project directory, and this path was realpath'd when listed: it resolves to
    // itself unless an ancestor has since been swapped for a link. `O_NOFOLLOW` covers only the final name.
    const parent = dirname(known.path)
    const fresh = await realpath(parent).catch(() => null) === parent ? await transcriptAt(known.path) : null
    return fresh && Object.assign(known, fresh)
  }

  /** The sidebar rows, newest first: read-only external-agent sessions that belong to no Hermes profile. */
  async rows(workspace: string): Promise<Row[]> {
    const rows: Row[] = []
    for (const file of (await this.scan()).files) {
      const built = row(file, await this.parsed(file), workspace)
      if (built) rows.push(built)
    }
    return rows.sort((a, b) => Number(b.last_message_at ?? 0) - Number(a.last_message_at ?? 0))
  }

  /** One id's sidebar row, or null when no scanned file has this id. */
  async row(sid: string, workspace: string): Promise<Row | null> {
    const file = await this.locate(sid)
    return file && row(file, await this.parsed(file), workspace)
  }

  /** One transcript's messages, or none when no scanned file has this id. */
  async messages(sid: string): Promise<Message[]> {
    const file = await this.locate(sid)
    return file ? [...(await this.parsed(file)).messages] : []
  }
}
