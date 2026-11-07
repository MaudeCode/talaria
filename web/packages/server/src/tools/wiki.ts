/**
 * LLM wiki status, browse, and page reads (Python `_llm_wiki_*` handlers). Only allowlisted pages are ever read: a
 * `*.md` file under one of the page sections whose resolved path stays inside that section, with no dot segment, and
 * a single link. Every read reopens the allowlisted real path with `O_NOFOLLOW` and requires the open file's
 * `(dev, ino)` to match the identity captured when the page was last verified.
 */
import { constants, readFileSync, type Stats } from 'node:fs'
import { lstat as fsLstat, open, readdir, realpath as fsRealpath, stat as fsStat, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parseDotenv } from '../cli/dotenv.js'
import { isDict, type Config, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { expandHome, isWithin, resolvePathLikePython } from '../workspace/paths.js'
import { readHandleUpTo } from '../workspace/fs.js'

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
const realpath = async (path: string): Promise<string | null> => { try { return await fsRealpath(path) } catch { return null } }
/** `stat` / `lstat` answering `undefined` for any failure (missing, unreadable, not a directory): such an entry is never listed or read. */
const stat = async (path: string): Promise<Stats | undefined> => { try { return await fsStat(path) } catch { return undefined } }
const lstat = async (path: string): Promise<Stats | undefined> => { try { return await fsLstat(path) } catch { return undefined } }

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

/**
 * Entries under `dir`, like `Path.rglob`: directory symlinks are not followed; dot directories (never listed) are
 * skipped. Every entry spends one unit of `budget`, so a huge tree cannot hold the event loop.
 */
async function* walk(dir: string, budget: { left: number }): AsyncGenerator<{ path: string; name: string; dir: boolean }> {
  let names
  try { names = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const d of names) {
    if (budget.left-- <= 0) return
    const path = join(dir, d.name)
    yield { path, name: d.name, dir: d.isDirectory() }
    if (d.isDirectory() && !d.name.startsWith('.')) yield* walk(path, budget)
  }
}

/** Python `_llm_wiki_count_files`: regular files under `raw/` outside dot segments. */
async function countRawFiles(real: string): Promise<number> {
  let count = 0
  for await (const item of walk(real, { left: MAX_FILES })) {
    if (!item.dir && !item.name.startsWith('.') && (await stat(item.path))?.isFile()) count++
  }
  return count
}

/** `(dev, ino, mtime_ns)` of each directory, or missing. */
async function directorySignature(paths: string[]): Promise<string> {
  return (await Promise.all(paths.map(async (path) => {
    try { const st = await fsLstat(path, { bigint: true }); return `${basename(path)}:${String(st.dev)}:${String(st.ino)}:${String(st.mtimeNs)}` } catch { return `${basename(path)}:-` }
  }))).join('|')
}

/**
 * The recheck of one listed page, against the section's real path from the snapshot: its identity is taken before its
 * path resolves, so a parent swapped at any point fails either the containment here or the identity check at the open.
 */
async function verifiedEntry(rootReal: string, listed: string, sectionReal: string): Promise<WikiEntry | null> {
  const rel = relative(rootReal, listed)
  if (!isClean(rel) || rel.includes('\\')) return null
  const st = await stat(listed)
  const target = st && await realpath(listed)
  if (!st || !target || !isWithin(target, sectionReal) || !isClean(relative(rootReal, target))) return null
  return st.isFile() && st.nlink <= 1 ? { target, dev: st.dev, ino: st.ino } : null
}

interface Cached<T> { signature: string; expiresAt: number; value: T }

export class WikiPages {
  /** Per resolved root: each listed page mapped to its section's real path. */
  private readonly pages = new Map<string, Cached<ReadonlyMap<string, string>>>()
  private readonly rawCounts = new Map<string, Cached<number>>()

  constructor(private readonly opts: { now?: () => number; ttlMs?: number; maxFiles?: number } = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private async cached<T>(cache: Map<string, Cached<T>>, key: string, signature: string, build: () => Promise<T>): Promise<T> {
    const now = this.now()
    const hit = cache.get(key)
    if (hit?.signature === signature && now < hit.expiresAt) return hit.value
    const value = await build()
    cache.set(key, { signature, expiresAt: now + (this.opts.ttlMs ?? 5000), value })
    return value
  }

  /** Python `_llm_wiki_page_files_uncached`. */
  async pageFilesUncached(root: string): Promise<ReadonlyMap<string, string>> {
    const pages = new Map<string, string>()
    const rootReal = await realpath(root)
    if (!rootReal || FORBIDDEN_ROOTS.has(rootReal)) return pages
    const budget = { left: this.opts.maxFiles ?? MAX_FILES }
    for (const name of SECTIONS) {
      const section = join(root, name)
      const sectionReal = await realpath(section)
      // A symlinked section must still resolve under the wiki root, so it cannot expose an outside tree.
      if (!sectionReal || !(await stat(sectionReal))?.isDirectory() || !isWithin(sectionReal, rootReal)) continue
      for await (const item of walk(section, budget)) {
        if (!item.name.endsWith('.md') || !isClean(relative(section, item.path))) continue
        // A hard link at a clean page name can carry any inode, and the identity check at read time cannot tell it apart.
        const [st, link, itemReal] = await Promise.all([stat(item.path), lstat(item.path), realpath(item.path)])
        if (st?.isFile() && link && link.nlink <= 1 && itemReal && isWithin(itemReal, sectionReal) && isClean(relative(rootReal, itemReal))) pages.set(item.path, sectionReal)
      }
    }
    return pages
  }

  /**
   * Python `_llm_wiki_page_files`: the allowlisted page paths, cached 5 s per resolved root while no section's
   * `(dev, ino, mtime_ns)` changes. A page swapped inside a nested directory leaves the signature unchanged, so every
   * reader rechecks each cached path (`verifiedEntry`). Trust boundary: a hard link created at a listed name
   * before the snapshot carries that page's identity; the wiki directory is operator-controlled, so that is accepted.
   */
  async pageFiles(root: string): Promise<ReadonlyMap<string, string>> {
    const key = await realpath(root) ?? root
    return this.cached(this.pages, key, await directorySignature(SECTIONS.map((s) => join(key, s))), () => this.pageFilesUncached(key))
  }

  /** Python `_llm_wiki_allowlisted_entries`: listed relpaths (posix) mapped to their real path and identity, rechecked now. */
  async allowlistedEntries(root: string): Promise<Map<string, WikiEntry>> {
    const entries = new Map<string, WikiEntry>()
    const rootReal = await realpath(root)
    if (!rootReal) return entries
    for (const [listed, sectionReal] of await this.pageFiles(rootReal)) {
      const entry = await verifiedEntry(rootReal, listed, sectionReal)
      if (entry) entries.set(relative(rootReal, listed).split(sep).join('/'), entry)
    }
    return entries
  }

  /** Python `_llm_wiki_count_files` over the cached signature of `raw/`: a nested change waits for the expiry, as the page list's does. */
  private async rawFileCount(root: string): Promise<number> {
    const real = await realpath(root)
    if (!real || FORBIDDEN_ROOTS.has(real) || !(await stat(real))?.isDirectory()) return 0
    return this.cached(this.rawCounts, real, await directorySignature([real]), () => countRawFiles(real))
  }

  /** The single open used for every wiki read: no symlink at the final component, and a FIFO cannot block. */
  openNoFollow(path: string): Promise<FileHandle> {
    return open(path, O_READ)
  }

  /** Open `path` and require the open file to be `identity`; `null` when it changed or vanished. */
  private async openVerified(path: string, identity: { dev: number; ino: number }): Promise<FileHandle | null> {
    let handle: FileHandle
    try { handle = await this.openNoFollow(path) } catch { return null }
    try { if (sameFile(await handle.stat(), identity)) return handle } catch { /* closed below */ }
    await handle.close()
    return null
  }

  /** Lines from an open file (UTF-8 with replacement), at most `maxLines`, reading at most `MAX_PAGE_BYTES`. */
  private async *lines(handle: FileHandle, maxLines: number): AsyncGenerator<string> {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    const buf = Buffer.alloc(64 * 1024)
    let pending = ''
    let read = 0
    let emitted = 0
    for (;;) {
      const n = read < MAX_PAGE_BYTES ? (await handle.read(buf, 0, Math.min(buf.length, MAX_PAGE_BYTES - read), null)).bytesRead : 0
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
  private async openStatusFile(root: string, name: string): Promise<FileHandle | null> {
    const path = join(root, name)
    const real = await realpath(path)
    const rootReal = await realpath(root)
    if (!real || !rootReal || !isWithin(real, rootReal)) return null
    const entry = await lstat(path)
    return entry?.isFile() ? this.openVerified(path, entry) : null
  }

  private async statusFileMtime(root: string, name: string): Promise<number | undefined> {
    const handle = await this.openStatusFile(root, name)
    if (handle === null) return undefined
    try { return (await handle.stat()).mtimeMs } finally { await handle.close() }
  }

  /**
   * Python `_llm_wiki_last_writer`: `updated_by` / `writer` / `author` from the newest page's frontmatter (200 lines),
   * else the first `## [date] action |` heading in `log.md` (5,000 lines) as `ai-agent (<action>)`, else `ai-agent`.
   */
  async lastWriter(root: string, pages: WikiEntry[]): Promise<string> {
    const rootReal = await realpath(root) ?? root
    let latest: WikiEntry | null = null
    let latestMtime = -1
    for (const page of pages) {
      const real = await realpath(page.target)
      const st = real && isWithin(real, rootReal) ? await stat(page.target) : undefined
      if (st && sameFile(st, page) && st.mtimeMs > latestMtime) { latest = page; latestMtime = st.mtimeMs }
    }
    const handle = latest ? await this.openVerified(latest.target, latest) : null
    if (handle !== null) {
      try {
        const lines = this.lines(handle, 201)
        const first = await lines.next()
        if (!first.done && first.value.trim() === '---') {
          for await (const line of lines) {
            const stripped = line.trim()
            if (stripped === '---') break
            const key = ['updated_by', 'writer', 'author'].find((k) => stripped.toLowerCase().startsWith(`${k}:`))
            const value = key ? stripped.slice(stripped.indexOf(':') + 1).trim() : ''
            if (value) return value
          }
        }
      } catch { /* unreadable */ } finally { await handle.close() }
    }
    const logHandle = await this.openStatusFile(root, 'log.md')
    if (logHandle !== null) {
      try {
        for await (const line of this.lines(logHandle, 5000)) {
          const stripped = line.trim()
          if (!stripped.startsWith('## [') || !stripped.includes('|')) continue
          const tail = stripped.includes(']') ? stripped.slice(stripped.indexOf(']') + 1).trim() : ''
          return `ai-agent (${tail ? (tail.split(/\s+/)[0] ?? 'update') : 'update'})`
        }
      } catch { /* unreadable */ } finally { await logHandle.close() }
    }
    return 'ai-agent'
  }

  /** Python `_build_llm_wiki_status`: always answers, never with page bodies or the wiki path. */
  async status(location: WikiLocation): Promise<Dict> {
    const base: Dict = { available: false, enabled: false, status: 'missing', entry_count: 0, page_count: 0, raw_source_count: 0, last_updated: null, last_writer: 'ai-agent', path_configured: location.configured, path_source: location.source, toggle_available: false, toggle_reason: TOGGLE_REASON, docs_url: WIKI_DOCS_URL }
    try {
      const root = location.path
      const rootStat = await stat(root)
      if (!rootStat) return base
      if (!rootStat.isDirectory()) return { ...base, status: 'not_directory' }
      const verified: { entry: WikiEntry; st: Stats }[] = []
      for (const entry of (await this.allowlistedEntries(root)).values()) {
        const st = await stat(entry.target)
        if (st && sameFile(st, entry)) verified.push({ entry, st })
      }
      const mtimes = [...await Promise.all(['SCHEMA.md', 'index.md', 'log.md'].map((n) => this.statusFileMtime(root, n))), ...verified.map((v) => v.st.mtimeMs)].filter((m): m is number => m !== undefined)
      const latest = mtimes.length ? Math.max(...mtimes) : 0
      return {
        ...base, available: true, enabled: true, status: verified.length ? 'ready' : 'empty', entry_count: verified.length, page_count: verified.length,
        raw_source_count: await this.rawFileCount(join(root, 'raw')), last_updated: latest ? isoSeconds(latest) : null, last_writer: await this.lastWriter(root, verified.map((v) => v.entry)),
      }
    } catch (error) {
      return { ...base, path_configured: false, path_source: 'unknown', toggle_reason: 'Unable to inspect LLM Wiki status safely.', status: 'error', error: error instanceof Error ? error.constructor.name : 'Error' }
    }
  }

  /** `GET /api/wiki/browse`: listed pages sorted case-insensitively, skipping any whose identity changed. */
  async browse(location: WikiLocation): Promise<{ pages: Dict[] }> {
    if (!(await stat(location.path))?.isDirectory()) throw new HttpFailure(404, 'Wiki not configured or directory not found')
    const pages: Dict[] = []
    const key = (rel: string): string => rel.toLowerCase()
    for (const [rel, entry] of [...await this.allowlistedEntries(location.path)].sort(([a], [b]) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))) {
      const st = await stat(entry.target)
      if (st && sameFile(st, entry)) pages.push({ name: basename(rel), path: rel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
    }
    return { pages }
  }

  /**
   * `GET /api/wiki/page`: one canonical, listed relpath, read through the identity-checked open, cut at 2 MiB. A listing
   * inside its TTL needs no section signature: only the requested page is verified, and that is what admits the read.
   */
  async page(location: WikiLocation, path: string): Promise<{ content: string; path: string }> {
    const root = location.path
    if (!path) throw new HttpFailure(400, 'Wiki not configured or path not provided')
    const parts = path.split('/')
    // A `..` or empty or `.` segment is refused; `v1..v2.md` is a legitimate name.
    if (path.includes('\\') || isAbsolute(path) || parts.some((p) => p === '..' || p === '' || p === '.')) throw new HttpFailure(400, 'Invalid path')
    const rootReal = await realpath(root)
    if (!rootReal) throw new HttpFailure(404, 'Page not found')
    const listed = join(rootReal, path)
    const warm = this.pages.get(rootReal)
    const sectionReal = (warm && this.now() < warm.expiresAt ? warm.value.get(listed) : undefined) ?? (await this.pageFiles(rootReal)).get(listed)
    const entry = sectionReal ? await verifiedEntry(rootReal, listed, sectionReal) : null
    if (!entry) {
      const resolved = await realpath(listed)
      if (resolved && !isWithin(resolved, rootReal)) throw new HttpFailure(400, 'Invalid path')
      throw new HttpFailure(404, 'Page not found')
    }
    let handle: FileHandle
    try { handle = await this.openNoFollow(entry.target) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new HttpFailure(404, code === 'ENOENT' || code === 'EISDIR' ? 'Page not found' : 'Could not read page')
    }
    try {
      if (!sameFile(await handle.stat(), entry)) throw new HttpFailure(404, 'Page not found')
      return { content: (await readHandleUpTo(handle, MAX_PAGE_BYTES)).toString('utf8'), path }
    } catch (error) {
      if (error instanceof HttpFailure) throw error
      throw new HttpFailure(404, 'Could not read page')
    } finally {
      await handle.close()
    }
  }
}

/** The process-wide allowlist cache shared by the wiki routes. */
export const wikiPages = new WikiPages()
