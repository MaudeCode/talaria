/**
 * LLM wiki status, browse, and page reads (Python `_llm_wiki_*` handlers). Only allowlisted pages are ever read: a
 * `*.md` file under one of the page sections whose resolved path stays inside that section, with no dot segment, and
 * a single link. Every read reopens the allowlisted real path with `O_NOFOLLOW` and requires the open file's
 * `(dev, ino)` to match the identity captured when the allowlist was built.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Stats } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parseDotenv } from '../cli/dotenv.js'
import { isDict, type Config, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { expandHome, isWithin, resolvePathLikePython } from '../workspace/paths.js'

export const WIKI_DOCS_URL = 'https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/research/research-llm-wiki'
const SECTIONS = ['entities', 'concepts', 'comparisons', 'queries']
/** Bounds a walk when `WIKI_PATH` points somewhere huge; real wikis hold a few thousand files. */
const MAX_FILES = 10_000
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
const FORBIDDEN_ROOTS = new Set(['/', '/etc', '/usr', '/var', '/opt', '/sys', '/proc'].map((p) => resolvePathLikePython(p)))
const TOGGLE_REASON = 'Hermes Agent exposes WIKI_PATH/wiki.path for location, but no stable on/off config flag is currently available.'
const O_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export interface WikiLocation { path: string; source: string; configured: boolean }
/** A listed page: its resolved real path and the `(dev, ino)` captured when the allowlist was built. */
export interface WikiEntry { target: string; dev: number; ino: number }

const sameFile = (st: Stats, entry: { dev: number; ino: number }): boolean => st.dev === entry.dev && st.ino === entry.ino
const isClean = (rel: string): boolean => rel !== '' && !rel.split(sep).some((part) => part.startsWith('.'))
const realpath = (path: string): string | null => { try { return realpathSync.native(path) } catch { return null } }
/** `stat` / `lstat` answering `undefined` for any failure (missing, unreadable, not a directory): such an entry is never listed or read. */
const stat = (path: string): Stats | undefined => { try { return statSync(path) } catch { return undefined } }
const lstat = (path: string): Stats | undefined => { try { return lstatSync(path) } catch { return undefined } }

/** Python `os.path.expandvars`: `$NAME` and `${NAME}` from `env`; unknown names stay as written. */
function expandVars(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$(\w+|\{[^}]*\})/g, (match, name: string) => env[name.startsWith('{') ? name.slice(1, -1) : name] ?? match)
}

/** A dotted config key, accepted flat (`'wiki.path': …`) or nested. */
function configValue(config: Config, dotted: string): string | null {
  let value: unknown = config[dotted]
  if (!value) {
    value = config
    for (const part of dotted.split('.')) value = isDict(value) ? value[part] : undefined
  }
  return value && (typeof value === 'string' || typeof value === 'number') ? String(value) : null
}

/**
 * Python `_llm_wiki_resolve_path`: `WIKI_PATH` from the env, then from `<profile home>/.env`, then config
 * `skills.config.wiki.path` or `wiki.path`, else `~/wiki`; env vars and `~` expanded.
 */
export function resolveWikiLocation(env: Record<string, string | undefined>, profileHome: string, config: Config, home: string): WikiLocation {
  let raw = env.WIKI_PATH || homeDotenvWikiPath(profileHome)
  let source = raw ? 'WIKI_PATH' : 'default'
  if (!raw) {
    raw = configValue(config, 'skills.config.wiki.path') ?? configValue(config, 'wiki.path')
    if (raw) source = 'skills.config.wiki.path'
  }
  return { path: expandHome(expandVars(raw || '~/wiki', env), home), source, configured: source !== 'default' }
}

function homeDotenvWikiPath(profileHome: string): string | null {
  try { return parseDotenv(readFileSync(join(profileHome, '.env'), 'utf8')).WIKI_PATH || null } catch { return null }
}

/** Python `datetime.fromtimestamp(ts, utc).isoformat()` with `Z`: microseconds only when nonzero. */
function isoSeconds(ms: number): string {
  const micros = Math.round(ms * 1000)
  const base = new Date(Math.floor(micros / 1000)).toISOString().slice(0, 19)
  const fraction = ((micros % 1_000_000) + 1_000_000) % 1_000_000
  return `${base}${fraction ? `.${String(fraction).padStart(6, '0')}` : ''}Z`
}

/** Entries under `dir`, like `Path.rglob`: directory symlinks are not followed; dot directories (never listed) are skipped. */
function* walk(dir: string): Generator<{ path: string; name: string; dir: boolean }> {
  let names
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const d of names) {
    const path = join(dir, d.name)
    yield { path, name: d.name, dir: d.isDirectory() }
    if (d.isDirectory() && !d.name.startsWith('.')) yield* walk(path)
  }
}

/** Python `_llm_wiki_count_files`: regular files under `raw/` outside dot segments. */
function countRawFiles(root: string): number {
  const real = realpath(root)
  if (!real || FORBIDDEN_ROOTS.has(real) || !stat(real)?.isDirectory()) return 0
  let count = 0
  let seen = 0
  for (const item of walk(root)) {
    if (++seen > MAX_FILES) break
    if (!item.dir && !item.name.startsWith('.') && stat(item.path)?.isFile()) count++
  }
  return count
}

export class WikiPages {
  private readonly cache = new Map<string, { signature: string; expiresAt: number; files: string[] }>()

  constructor(private readonly opts: { now?: () => number; ttlMs?: number } = {}) {}

  /** Change signature over the section directories only: `(dev, ino, mtime_ns)` each, or missing. */
  private signature(root: string): string {
    return SECTIONS.map((s) => {
      try { const st = lstatSync(join(root, s), { bigint: true }); return `${s}:${String(st.dev)}:${String(st.ino)}:${String(st.mtimeNs)}` } catch { return `${s}:-` }
    }).join('|')
  }

  /** Python `_llm_wiki_page_files_uncached`. */
  pageFilesUncached(root: string): string[] {
    const pages: string[] = []
    const rootReal = realpath(root)
    if (!rootReal || FORBIDDEN_ROOTS.has(rootReal)) return pages
    let seen = 0
    for (const name of SECTIONS) {
      const section = join(root, name)
      const sectionReal = realpath(section)
      // A symlinked section must still resolve under the wiki root, so it cannot expose an outside tree.
      if (!sectionReal || !stat(sectionReal)?.isDirectory() || !isWithin(sectionReal, rootReal)) continue
      for (const item of walk(section)) {
        if (!item.name.endsWith('.md')) continue
        if (++seen > MAX_FILES) return pages
        if (!isClean(relative(section, item.path))) continue
        try {
          // A hard link at a clean page name can carry any inode, and the identity check at read time cannot tell it apart.
          if (!statSync(item.path).isFile() || lstatSync(item.path).nlink > 1) continue
          const itemReal = realpathSync.native(item.path)
          if (isWithin(itemReal, sectionReal) && isClean(relative(rootReal, itemReal))) pages.push(item.path)
        } catch { /* vanished */ }
      }
    }
    return pages
  }

  /**
   * Python `_llm_wiki_page_files`: the allowlisted page paths, cached 5 s per resolved root while no section's
   * `(dev, ino, mtime_ns)` changes. A page swapped inside a nested directory leaves the signature unchanged, so every
   * reader rechecks each cached path (`allowlistedEntries`). Trust boundary: a hard link created at a listed name
   * before the snapshot carries that page's identity; the wiki directory is operator-controlled, so that is accepted.
   */
  pageFiles(root: string): string[] {
    const key = realpath(root) ?? root
    const signature = this.signature(key)
    const now = (this.opts.now ?? Date.now)()
    const cached = this.cache.get(key)
    if (cached?.signature === signature && now < cached.expiresAt) return [...cached.files]
    const files = this.pageFilesUncached(key)
    this.cache.set(key, { signature, expiresAt: now + (this.opts.ttlMs ?? 5000), files })
    return [...files]
  }

  /** Python `_llm_wiki_allowlisted_entries`: listed relpaths (posix) mapped to their real path and identity, rechecked now. */
  allowlistedEntries(root: string): Map<string, WikiEntry> {
    const entries = new Map<string, WikiEntry>()
    const rootReal = realpath(root)
    if (!rootReal) return entries
    for (const listed of this.pageFiles(rootReal)) {
      try {
        const rel = relative(rootReal, listed)
        if (!isClean(rel) || rel.includes('\\')) continue
        const sectionReal = realpathSync.native(join(rootReal, rel.split(sep)[0] ?? ''))
        const target = realpathSync.native(listed)
        if (!isWithin(sectionReal, rootReal) || !isWithin(target, sectionReal) || !isClean(relative(rootReal, target))) continue
        const st = statSync(target)
        if (!st.isFile() || st.nlink > 1 || realpathSync.native(listed) !== target) continue
        entries.set(rel.split(sep).join('/'), { target, dev: st.dev, ino: st.ino })
      } catch { /* vanished */ }
    }
    return entries
  }

  /** The single open used for every wiki read: no symlink at the final component, and a FIFO cannot block. */
  openNoFollow(path: string): number {
    return openSync(path, O_READ)
  }

  /** Open `path` and require the open file to be `identity`; `null` when it changed or vanished. */
  private openVerified(path: string, identity: { dev: number; ino: number }): number | null {
    let fd: number
    try { fd = this.openNoFollow(path) } catch { return null }
    try { if (sameFile(fstatSync(fd), identity)) return fd } catch { /* closed below */ }
    closeSync(fd)
    return null
  }

  /** Lines from an open file (UTF-8 with replacement), at most `maxLines`, reading at most `MAX_PAGE_BYTES`. */
  private *lines(fd: number, maxLines: number): Generator<string> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const buf = Buffer.alloc(64 * 1024)
    let pending = ''
    let read = 0
    let emitted = 0
    for (;;) {
      const n = read < MAX_PAGE_BYTES ? readSync(fd, buf, 0, Math.min(buf.length, MAX_PAGE_BYTES - read), null) : 0
      read += n
      pending += n ? decoder.decode(buf.subarray(0, n), { stream: true }) : decoder.decode()
      let nl
      while ((nl = pending.indexOf('\n')) >= 0) {
        if (emitted++ >= maxLines) return
        yield pending.slice(0, nl + 1)
        pending = pending.slice(nl + 1)
      }
      if (!n) {
        if (pending && emitted < maxLines) yield pending
        return
      }
    }
  }

  /** A top-level status file (`SCHEMA.md`, `index.md`, `log.md`), opened only while it is a regular file inside the wiki. */
  private openStatusFile(root: string, name: string): number | null {
    const path = join(root, name)
    const real = realpath(path)
    const rootReal = realpath(root)
    if (!real || !rootReal || !isWithin(real, rootReal)) return null
    const entry = lstat(path)
    return entry?.isFile() ? this.openVerified(path, entry) : null
  }

  private statusFileMtime(root: string, name: string): number | undefined {
    const fd = this.openStatusFile(root, name)
    if (fd === null) return undefined
    try { return fstatSync(fd).mtimeMs } finally { closeSync(fd) }
  }

  /**
   * Python `_llm_wiki_last_writer`: `updated_by` / `writer` / `author` from the newest page's frontmatter (200 lines),
   * else the first `## [date] action |` heading in `log.md` (5,000 lines) as `ai-agent (<action>)`, else `ai-agent`.
   */
  lastWriter(root: string, pages: WikiEntry[]): string {
    const rootReal = realpath(root) ?? root
    let latest: WikiEntry | null = null
    let latestMtime = -1
    for (const page of pages) {
      const real = realpath(page.target)
      const st = real && isWithin(real, rootReal) ? stat(page.target) : undefined
      if (st && sameFile(st, page) && st.mtimeMs > latestMtime) { latest = page; latestMtime = st.mtimeMs }
    }
    const fd = latest ? this.openVerified(latest.target, latest) : null
    if (fd !== null) {
      try {
        const lines = this.lines(fd, 201)
        const first = lines.next()
        if (!first.done && first.value.trim() === '---') {
          for (const line of lines) {
            const stripped = line.trim()
            if (stripped === '---') break
            const key = ['updated_by', 'writer', 'author'].find((k) => stripped.toLowerCase().startsWith(`${k}:`))
            const value = key ? stripped.slice(stripped.indexOf(':') + 1).trim() : ''
            if (value) return value
          }
        }
      } catch { /* unreadable */ } finally { closeSync(fd) }
    }
    const logFd = this.openStatusFile(root, 'log.md')
    if (logFd !== null) {
      try {
        for (const line of this.lines(logFd, 5000)) {
          const stripped = line.trim()
          if (!stripped.startsWith('## [') || !stripped.includes('|')) continue
          const tail = stripped.includes(']') ? stripped.slice(stripped.indexOf(']') + 1).trim() : ''
          return `ai-agent (${tail ? (tail.split(/\s+/)[0] ?? 'update') : 'update'})`
        }
      } catch { /* unreadable */ } finally { closeSync(logFd) }
    }
    return 'ai-agent'
  }

  /** Python `_build_llm_wiki_status`: always answers, never with page bodies or the wiki path. */
  status(location: WikiLocation): Dict {
    const base: Dict = { available: false, enabled: false, status: 'missing', entry_count: 0, page_count: 0, raw_source_count: 0, last_updated: null, last_writer: 'ai-agent', path_configured: location.configured, path_source: location.source, toggle_available: false, toggle_reason: TOGGLE_REASON, docs_url: WIKI_DOCS_URL }
    try {
      const root = location.path
      const rootStat = stat(root)
      if (!rootStat) return base
      if (!rootStat.isDirectory()) return { ...base, status: 'not_directory' }
      const verified: { entry: WikiEntry; st: Stats }[] = []
      for (const entry of this.allowlistedEntries(root).values()) {
        const st = stat(entry.target)
        if (st && sameFile(st, entry)) verified.push({ entry, st })
      }
      const mtimes = [...['SCHEMA.md', 'index.md', 'log.md'].map((n) => this.statusFileMtime(root, n)), ...verified.map((v) => v.st.mtimeMs)].filter((m): m is number => m !== undefined)
      const latest = mtimes.length ? Math.max(...mtimes) : 0
      return {
        ...base, available: true, enabled: true, status: verified.length ? 'ready' : 'empty', entry_count: verified.length, page_count: verified.length,
        raw_source_count: countRawFiles(join(root, 'raw')), last_updated: latest ? isoSeconds(latest) : null, last_writer: this.lastWriter(root, verified.map((v) => v.entry)),
      }
    } catch (error) {
      return { ...base, path_configured: false, path_source: 'unknown', toggle_reason: 'Unable to inspect LLM Wiki status safely.', status: 'error', error: error instanceof Error ? error.constructor.name : 'Error' }
    }
  }

  /** `GET /api/wiki/browse`: listed pages sorted case-insensitively, skipping any whose identity changed. */
  browse(location: WikiLocation): { pages: Dict[] } {
    if (!stat(location.path)?.isDirectory()) throw new HttpFailure(404, 'Wiki not configured or directory not found')
    const pages: Dict[] = []
    const key = (rel: string): string => rel.toLowerCase()
    for (const [rel, entry] of [...this.allowlistedEntries(location.path)].sort(([a], [b]) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))) {
      const st = stat(entry.target)
      if (st && sameFile(st, entry)) pages.push({ name: basename(rel), path: rel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
    }
    return { pages }
  }

  /** `GET /api/wiki/page`: one canonical, allowlisted relpath, read through the identity-checked open, cut at 2 MiB. */
  page(location: WikiLocation, path: string): { content: string; path: string } {
    const root = location.path
    if (!path) throw new HttpFailure(400, 'Wiki not configured or path not provided')
    const parts = path.split('/')
    // A `..` or empty or `.` segment is refused; `v1..v2.md` is a legitimate name.
    if (path.includes('\\') || isAbsolute(path) || parts.some((p) => p === '..' || p === '' || p === '.')) throw new HttpFailure(400, 'Invalid path')
    const resolved = resolvePathLikePython(join(root, path))
    if (!isWithin(resolved, resolvePathLikePython(root))) throw new HttpFailure(400, 'Invalid path')
    const entry = this.allowlistedEntries(resolvePathLikePython(root)).get(path)
    if (entry?.target !== resolved) throw new HttpFailure(404, 'Page not found')
    let fd: number
    try { fd = this.openNoFollow(entry.target) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new HttpFailure(404, code === 'ENOENT' || code === 'EISDIR' ? 'Page not found' : 'Could not read page')
    }
    try {
      if (!sameFile(fstatSync(fd), entry)) throw new HttpFailure(404, 'Page not found')
      const buf = Buffer.alloc(MAX_PAGE_BYTES)
      let total = 0
      for (let n = 1; n > 0 && total < buf.length; total += n) n = readSync(fd, buf, total, buf.length - total, null)
      return { content: buf.subarray(0, total).toString('utf8'), path }
    } catch (error) {
      if (error instanceof HttpFailure) throw error
      throw new HttpFailure(404, 'Could not read page')
    } finally {
      closeSync(fd)
    }
  }
}

/** The process-wide allowlist cache shared by the wiki routes. */
export const wikiPages = new WikiPages()
