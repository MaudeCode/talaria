/**
 * Workspace file operations (Python `api/workspace.py` list/read/anchored
 * helpers). The anchored helpers walk the path one component at a time from
 * an open directory descriptor (Python `openat`): on Linux every component is
 * opened through `/proc/self/fd/<dirfd>/<name>` with `O_NOFOLLOW`, so a parent
 * swapped for a symlink mid-walk cannot redirect the next step. Where the
 * kernel offers no descriptor-relative open (macOS), each step instead makes
 * the verified directory the process working directory (checked by device and
 * inode against the descriptor we hold) and names the child with a bare
 * relative path, so the kernel resolves it against that directory's vnode and
 * a pathname swapped underneath us can never be followed. The sections are
 * synchronous, so nothing else in the process observes the temporary cwd.
 */
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmdirSync, statSync, unlinkSync, type Stats } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isWithin, resolvePathLikePython } from './paths.js'
import { isBlockedSystemPath } from './workspaces.js'

export const MAX_FILE_BYTES = 400_000

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0
// A FIFO planted where a file is expected would park the single-threaded server in open(2); regular files ignore the flag.
const O_NONBLOCK = constants.O_NONBLOCK ?? 0

export class PathTraversalError extends Error {}
export class NotFoundError extends Error {}

/** Python `safe_resolve_ws`: the resolved target must stay under the resolved root. */
export function safeResolveWs(root: string, requested: string): string {
  const rootResolved = resolvePathLikePython(root)
  const resolved = resolvePathLikePython(resolve(root, requested))
  if (!isWithin(resolved, rootResolved)) throw new PathTraversalError(`Path traversal blocked: ${requested}`)
  return resolved
}

/** Python `helpers.safe_resolve`: same rule, different error text. */
export function safeResolve(root: string, requested: string): string {
  if (requested.includes('\0')) throw new PathTraversalError('embedded null byte')
  const rootResolved = resolvePathLikePython(root)
  const resolved = resolvePathLikePython(resolve(root, requested))
  if (!isWithin(resolved, rootResolved)) throw new PathTraversalError(`path escapes root: ${requested}`)
  return resolved
}

function relParts(root: string, target: string): string[] {
  const rootResolved = resolvePathLikePython(root)
  if (!isWithin(target, rootResolved)) throw new PathTraversalError(`Path traversal blocked: ${target}`)
  const rel = relative(rootResolved, target)
  return rel ? rel.split(sep) : []
}

const DESCRIPTOR_PATHS = process.platform === 'linux' && existsSync('/proc/self/fd')

/** The pathname that names `name` relative to an open directory descriptor (Linux only). */
function fdPath(dirfd: number, name: string): string {
  return `/proc/self/fd/${String(dirfd)}/${name}`
}

class DirHandle {
  constructor(readonly fd: number, readonly path: string) {}
  /** The pathname that names `name` inside this directory; only valid inside `anchored()`. */
  child(name: string): string {
    return DESCRIPTOR_PATHS ? fdPath(this.fd, name) : name
  }
  /** Pathname fallback: the directory at our pathname must still be the one our descriptor holds. */
  assertIdentity(): void {
    if (DESCRIPTOR_PATHS) return
    let current: Stats
    try { current = statSync(this.path) } catch { throw new NotFoundError(`Not found: ${this.path}`) }
    if (!sameFile(current, fstatSync(this.fd))) throw new NotFoundError(`Not found: ${this.path}`)
  }
  /**
   * Run `op` with `child()` pathnames resolving against this descriptor. On the descriptor platform they already
   * do; on the fallback the process cwd becomes this directory for the duration, verified by identity so a
   * swapped pathname fails closed before any child is touched.
   */
  anchored<T>(op: () => T): T {
    if (DESCRIPTOR_PATHS) return op()
    const previous = process.cwd()
    try { process.chdir(this.path) } catch { throw new NotFoundError(`Not found: ${this.path}`) }
    try {
      const here = openSync('.', constants.O_RDONLY | O_DIRECTORY)
      try {
        if (!sameFile(fstatSync(here), fstatSync(this.fd))) throw new NotFoundError(`Not found: ${this.path}`)
      } finally {
        closeSync(here)
      }
      return op()
    } finally {
      process.chdir(previous)
    }
  }
  close(): void { try { closeSync(this.fd) } catch { /* already closed */ } }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/** Open `name` inside `dir` as a directory, refusing symlinks. */
function openChildDir(dir: DirHandle, name: string, opts: { createMissing?: boolean } = {}): DirHandle {
  const fd = dir.anchored(() => {
    const target = dir.child(name)
    try {
      return openSync(target, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && opts.createMissing) {
        mkdirSync(target, { mode: 0o755 })
        return openSync(target, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      }
      throw new NotFoundError(`Not found: ${join(dir.path, name)}`)
    }
  })
  return new DirHandle(fd, join(dir.path, name))
}

/** A root whose pathname the caller validated earlier (escape grants): opening it must still yield that inode. */
let pinnedRoot: { path: string; dev: number; ino: number } | null = null

/** Run `fn` with every anchored open of `root` refused unless the root is still the inode `id`. */
export function withPinnedRoot<T>(root: string, id: { dev: number; ino: number }, fn: () => T): T {
  const previous = pinnedRoot
  pinnedRoot = { path: root, dev: id.dev, ino: id.ino }
  try {
    return fn()
  } finally {
    pinnedRoot = previous
  }
}

function openRoot(root: string, rootResolved: string, target: string): number {
  let fd: number
  try { fd = openSync(rootResolved, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW) } catch { throw new NotFoundError(`Not found: ${target}`) }
  if (pinnedRoot?.path === root) {
    const st = fstatSync(fd)
    if (st.dev !== pinnedRoot.dev || st.ino !== pinnedRoot.ino) {
      closeSync(fd)
      throw new NotFoundError(`Not found: ${target}`)
    }
  }
  return fd
}

/** Walk from the root to the parent of the leaf, one descriptor at a time. Caller closes the returned handle. */
function openAnchoredParent(root: string, target: string, opts: { createMissingDirs?: boolean } = {}): { dir: DirHandle; leaf: string } {
  const rootResolved = resolvePathLikePython(root)
  const parts = relParts(rootResolved, target)
  if (!parts.length) throw new PathTraversalError(`Invalid target: ${target}`)
  const leaf = parts[parts.length - 1] ?? ''
  if (!leaf || leaf === '.' || leaf === '..') throw new PathTraversalError(`Invalid target: ${target}`)
  let dir = new DirHandle(openRoot(root, rootResolved, target), rootResolved)
  try {
    for (const part of parts.slice(0, -1)) {
      if (!part || part === '.' || part === '..') throw new PathTraversalError(`Path traversal blocked: ${target}`)
      const next = openChildDir(dir, part, { createMissing: opts.createMissingDirs ?? false })
      dir.close()
      dir = next
    }
  } catch (error) {
    dir.close()
    throw error
  }
  return { dir, leaf }
}

/** Open `target` for reading with the anchored walk (Python `open_anchored_fd`). Caller closes the fd. */
export function openAnchoredFd(root: string, target: string, opts: { wantDir: boolean }): number {
  const rootResolved = resolvePathLikePython(root)
  if (relParts(rootResolved, target).length === 0) {
    if (!opts.wantDir) throw new NotFoundError(`Not found: ${target}`)
    return openRoot(root, rootResolved, target)
  }
  const { dir, leaf } = openAnchoredParent(root, target)
  try {
    try { return dir.anchored(() => openSync(dir.child(leaf), constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (opts.wantDir ? O_DIRECTORY : 0))) } catch { throw new NotFoundError(`Not found: ${target}`) }
  } finally {
    dir.close()
  }
}

/** Exclusive create under the root, creating missing parents (Python `open_anchored_create_fd`). */
export function openAnchoredCreateFd(root: string, dest: string): number {
  const { dir, leaf } = openAnchoredParent(root, dest, { createMissingDirs: true })
  try {
    return dir.anchored(() => openSync(dir.child(leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o644))
  } catch (error) {
    if (error instanceof NotFoundError) throw error
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsError(dest)
    throw new NotFoundError(`Not found: ${dest}`)
  } finally {
    dir.close()
  }
}

export class FileExistsError extends Error {}

export function makeAnchoredDir(root: string, dest: string): void {
  const rootResolved = resolvePathLikePython(root)
  const destResolved = resolvePathLikePython(dest)
  if (destResolved === rootResolved) return
  const { dir, leaf } = openAnchoredParent(rootResolved, destResolved, { createMissingDirs: true })
  try {
    const last = openChildDir(dir, leaf, { createMissing: true })
    last.close()
  } finally {
    dir.close()
  }
}

export function openAnchoredWriteFd(root: string, target: string): number {
  const targetResolved = resolvePathLikePython(target)
  const { dir, leaf } = openAnchoredParent(root, targetResolved)
  try {
    return dir.anchored(() => {
      const fd = openSync(dir.child(leaf), constants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK)
      // Truncate only once the descriptor is known to be a regular file (never a FIFO or device).
      if (!fstatSync(fd).isFile()) { closeSync(fd); throw new NotFoundError(`Not a file: ${target}`) }
      ftruncateSync(fd, 0)
      return fd
    })
  } catch {
    throw new NotFoundError(`Not found: ${target}`)
  } finally {
    dir.close()
  }
}

export function unlinkAnchored(root: string, target: string): void {
  const targetResolved = resolvePathLikePython(target)
  const { dir, leaf } = openAnchoredParent(root, targetResolved)
  try {
    dir.anchored(() => { unlinkSync(dir.child(leaf)) })
  } catch (error) {
    // The errno survives on the wrapped error so a caller can tell a benign race (`ENOENT`) from a refusal.
    throw Object.assign(new NotFoundError(`Not found: ${target}`), { code: (error as NodeJS.ErrnoException).code })
  } finally {
    dir.close()
  }
}

/** Remove an empty directory through the anchored walk; a non-empty or symlinked target is left alone (throws). */
export function rmdirAnchored(root: string, target: string): void {
  const targetResolved = resolvePathLikePython(target)
  const { dir, leaf } = openAnchoredParent(root, targetResolved)
  try {
    dir.anchored(() => { rmdirSync(dir.child(leaf)) })
  } finally {
    dir.close()
  }
}

/**
 * Remove a directory tree through the anchored walk (Python `shutil.rmtree(dir_fd=...)`): every directory is
 * opened from its parent's descriptor with `O_NOFOLLOW` and emptied through its own, so an entry swapped for a
 * symlink mid-walk is unlinked as a link and never followed.
 */
export function rmtreeAnchored(root: string, target: string): void {
  const targetResolved = resolvePathLikePython(target)
  const { dir, leaf } = openAnchoredParent(root, targetResolved)
  try {
    // The leaf itself must still be a real directory; a symlinked or non-directory leaf is refused, not unlinked.
    const sub = openChildDir(dir, leaf)
    try { emptyAnchoredDir(sub) } finally { sub.close() }
    dir.anchored(() => { rmdirSync(dir.child(leaf)) })
  } catch (error) {
    if (error instanceof NotFoundError) throw error
    throw new NotFoundError(`Not found: ${target}`)
  } finally {
    dir.close()
  }
}

/**
 * Remove every entry of `dir` through its descriptor (Python `_rmtree_safe_fd`). Each subdirectory is opened
 * `O_NOFOLLOW` and must still be the inode listed, so one swapped for another directory fails closed and one swapped
 * for a symlink fails the open and is unlinked as a link. Subdirectories are emptied outside the anchored section
 * so the cwd fallback never nests.
 */
function emptyAnchoredDir(dir: DirHandle): void {
  const subdirs = dir.anchored(() => {
    const found: { name: string; listed: Stats }[] = []
    for (const name of readdirSync(dir.child('.'))) {
      const listed = lstatSync(dir.child(name))
      if (listed.isDirectory()) found.push({ name, listed })
      else unlinkSync(dir.child(name))
    }
    return found
  })
  for (const { name, listed } of subdirs) {
    let sub: DirHandle
    try {
      sub = openChildDir(dir, name)
    } catch {
      dir.anchored(() => { unlinkSync(dir.child(name)) })
      continue
    }
    try {
      if (!sameFile(fstatSync(sub.fd), listed)) throw new NotFoundError(`Not found: ${sub.path}`)
      emptyAnchoredDir(sub)
    } finally {
      sub.close()
    }
    dir.anchored(() => { rmdirSync(dir.child(name)) })
  }
}

export function renameAnchored(root: string, source: string, dest: string): void {
  const rootResolved = resolvePathLikePython(root)
  const sourceResolved = resolvePathLikePython(source)
  const destParent = resolvePathLikePython(dirname(dest))
  if (!isWithin(destParent, rootResolved)) throw new PathTraversalError(`Path traversal blocked: ${dest}`)
  const leaf = basename(dest)
  if (!leaf || leaf === '.' || leaf === '..') throw new PathTraversalError(`Invalid destination: ${dest}`)
  const from = openAnchoredParent(rootResolved, sourceResolved)
  try {
    if (destParent === resolvePathLikePython(dirname(sourceResolved))) {
      // Same directory: both names resolve against the one anchored descriptor.
      from.dir.anchored(() => {
        assertAbsent(from.dir.child(leaf), leaf)
        renameSync(from.dir.child(from.leaf), from.dir.child(leaf))
      })
      return
    }
    const to = destParent === rootResolved ? new DirHandle(openSync(rootResolved, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW), rootResolved) : (() => { const p = openAnchoredParent(rootResolved, destParent); const h = openChildDir(p.dir, p.leaf); p.dir.close(); return h })()
    try {
      to.anchored(() => { assertAbsent(to.child(leaf), leaf) })
      if (DESCRIPTOR_PATHS) {
        from.dir.anchored(() => { renameSync(from.dir.child(from.leaf), to.child(leaf)) })
        return
      }
      // Without renameat only one side of a rename can be cwd-anchored, so the entry hops through the root: the
      // root's own pathname has no workspace-controlled component, and the hop name is fresh, so each step names
      // one anchored side and one path nobody inside the workspace can redirect.
      const hop = join(rootResolved, `.talaria-move-${randomBytes(8).toString('hex')}`)
      from.dir.anchored(() => { renameSync(from.dir.child(from.leaf), hop) })
      try {
        to.anchored(() => { assertAbsent(to.child(leaf), leaf); renameSync(hop, to.child(leaf)) })
      } catch (error) {
        try { from.dir.anchored(() => { renameSync(hop, from.dir.child(from.leaf)) }) } catch { /* the entry stays at the hop path */ }
        throw error
      }
    } finally {
      to.close()
    }
  } finally {
    from.dir.close()
  }
}

function assertAbsent(path: string, leaf: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new FileExistsError(leaf)
}

/**
 * Run `fn` against the directory `target` through its held descriptor: `child(name)` names an entry (and
 * `child('.')` the directory itself) so enumeration and per-entry metadata never resolve `target`'s pathname
 * again (Python listed through the `openat` descriptor for the same reason).
 */
export function withAnchoredDir<T>(root: string, target: string, fn: (child: (name: string) => string) => T): T {
  const dir = new DirHandle(openAnchoredFd(root, target, { wantDir: true }), target)
  try {
    return dir.anchored(() => fn((name) => (name === '.' ? (DESCRIPTOR_PATHS ? `/proc/self/fd/${String(dir.fd)}` : '.') : dir.child(name))))
  } finally {
    dir.close()
  }
}

export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file' | 'symlink'
  is_dir?: boolean
  target?: string
  size?: number | null
  mtime_ns?: bigint | null
  birthtime_ns?: bigint | null
  workspace_sort_rank: number
  target_outside_workspace?: boolean
}

function birthtimeNs(st: import('node:fs').BigIntStats | null): bigint | null {
  if (!st) return null
  return st.birthtimeNs > 0n ? st.birthtimeNs : null
}

/** Python `list_dir`: bounded, sorted (symlinks, dirs, files), symlink-aware listing. */
export function listDir(workspace: string, rel = '.'): DirEntry[] {
  const target = safeResolveWs(workspace, rel)
  let st
  try {
    st = statSync(target)
  } catch {
    throw new NotFoundError(`Not a directory: ${rel}`)
  }
  if (!st.isDirectory()) throw new NotFoundError(`Not a directory: ${rel}`)
  const wsResolved = resolvePathLikePython(workspace)
  return withAnchoredDir(workspace, target, (child) => listAnchored(target, rel, wsResolved, child))
}

function listAnchored(target: string, rel: string, wsResolved: string, child: (name: string) => string): DirEntry[] {
  const entries: DirEntry[] = []
  const dirents = readdirSync(child('.'), { withFileTypes: true })
  const sortKey = (d: import('node:fs').Dirent) => [!d.isSymbolicLink(), d.isFile(), d.name.toLowerCase()] as const
  dirents.sort((a, b) => {
    const [la, fa, na] = sortKey(a)
    const [lb, fb, nb] = sortKey(b)
    if (la !== lb) return la ? 1 : -1
    if (fa !== fb) return fa ? 1 : -1
    return na < nb ? -1 : na > nb ? 1 : 0
  })
  for (const de of dirents) {
    if (entries.length >= 200) break
    const name = de.name
    const full = child(name)
    let lst: import('node:fs').BigIntStats | null = null
    try {
      lst = lstatSync(full, { bigint: true })
    } catch {
      lst = null
    }
    if (de.isSymbolicLink()) {
      let rawLink: string
      try {
        rawLink = readlinkSync(full)
      } catch {
        continue
      }
      try {
        statSync(full)
      } catch {
        continue
      }
      let linkTarget: string
      try {
        linkTarget = resolvePathLikePython(resolve(target, rawLink))
      } catch {
        continue
      }
      if (linkTarget === target || linkTarget === wsResolved) continue
      if (isWithin(target, linkTarget)) continue
      const outside = !isWithin(linkTarget, wsResolved)
      if (isBlockedSystemPath(linkTarget)) continue
      const displayPath = rel && rel !== '.' ? `${rel}/${name}` : name
      if (outside) {
        entries.push({ name, path: displayPath, type: 'symlink', is_dir: false, workspace_sort_rank: 0, target_outside_workspace: true, mtime_ns: lst?.mtimeNs ?? null, birthtime_ns: birthtimeNs(lst) })
      } else {
        let isDirectory = false
        let size: number | null | undefined
        try {
          const ts = statSync(linkTarget)
          isDirectory = ts.isDirectory()
          if (!isDirectory) size = ts.size
        } catch {
          size = null
        }
        const entry: DirEntry = { name, path: displayPath, type: 'symlink', target: linkTarget, is_dir: isDirectory, workspace_sort_rank: 0, target_outside_workspace: false, mtime_ns: lst?.mtimeNs ?? null, birthtime_ns: birthtimeNs(lst) }
        if (!isDirectory) entry.size = size ?? null
        entries.push(entry)
      }
      continue
    }
    const entryPath = rel && rel !== '.' ? `${rel}/${name}` : name
    const isFile = lst ? lst.isFile() : false
    const isDirectory = lst ? lst.isDirectory() : false
    entries.push({
      name,
      path: entryPath,
      type: isDirectory ? 'dir' : 'file',
      size: isFile && lst ? Number(lst.size) : null,
      mtime_ns: lst?.mtimeNs ?? null,
      birthtime_ns: birthtimeNs(lst),
      workspace_sort_rank: lst ? (isFile ? 2 : 1) : 1,
    })
  }
  return entries
}

/** Python `_browser_timestamp_ns`: nanosecond timestamps are always decimal strings on the wire. */
export function serializeEntriesForBrowser(entries: DirEntry[]): Record<string, unknown>[] {
  return entries.map((e) => {
    const out: Record<string, unknown> = { ...e }
    out.mtime_ns = e.mtime_ns === null || e.mtime_ns === undefined ? null : e.mtime_ns.toString()
    out.birthtime_ns = e.birthtime_ns === null || e.birthtime_ns === undefined ? null : e.birthtime_ns.toString()
    return out
  })
}

/**
 * Python `dir_signature`: sha256 of `json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`
 * with `mtime_ns` as a bare integer, so a listing hashes identically across the Python and TypeScript servers.
 */
export function dirSignature(workspace: string, rel = '.', entries?: DirEntry[]): string {
  const list = entries ?? listDir(workspace, rel)
  const payload = list.map((e) => ({ name: e.name, path: e.path, type: e.type, is_dir: e.is_dir ?? null, size: e.size ?? null, mtime_ns: e.mtime_ns === undefined || e.mtime_ns === null ? null : `\u0000int:${e.mtime_ns.toString()}\u0000`, target: e.target ?? null, target_outside_workspace: e.target_outside_workspace ?? null }))
  // A NUL sentinel cannot survive JSON.stringify unescaped in a real name, so only the integer placeholders are unquoted.
  const raw = JSON.stringify(payload.map(sortKeysDeep)).replaceAll(/"\\u0000int:(\d+)\\u0000"/g, '$1')
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeysDeep(obj[k])]))
  }
  return value
}

/** A text read carries `content`/`lines`; a stat-only read and a binary file carry only the size. */
export interface FileContent { path: string; size: number; content?: string; lines?: number; binary?: true }

export class FileTooLargeError extends Error {}

/** Python `read_file_content` (office previews were dropped with TAL-245). */
export function readFileContent(workspace: string, rel: string, opts: { statOnly?: boolean } = {}): FileContent {
  const target = safeResolveWs(workspace, rel)
  let st
  try {
    st = statSync(target)
  } catch {
    throw new NotFoundError(`Not a file: ${rel}`)
  }
  if (!st.isFile()) throw new NotFoundError(`Not a file: ${rel}`)
  const fd = openAnchoredFd(workspace, target, { wantDir: false })
  try {
    const fst = fstatSync(fd)
    if (!fst.isFile()) throw new NotFoundError(`Not a file: ${rel}`)
    if (opts.statOnly) return { path: rel, size: fst.size }
    if (fst.size > MAX_FILE_BYTES) throw new FileTooLargeError(`File too large (${fst.size} bytes, max ${MAX_FILE_BYTES})`)
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1)
    let total = 0
    for (;;) {
      const n = readFd(fd, buf, total)
      if (n <= 0 || total >= buf.length) break
      total += n
    }
    const raw = buf.subarray(0, total)
    const content = raw.toString('utf8')
    if (raw.includes(0) || (content.includes('\uFFFD') && !raw.equals(Buffer.from(content, 'utf8')))) return { path: rel, size: raw.length, binary: true }
    return { path: rel, content, size: raw.length, lines: (content.match(/\n/g)?.length ?? 0) + 1 }
  } finally {
    closeSync(fd)
  }
}

function readFd(fd: number, buf: Buffer, offset: number): number {
  return readSyncCompat(fd, buf, offset, buf.length - offset)
}

import { readSync } from 'node:fs'
function readSyncCompat(fd: number, buf: Buffer, offset: number, length: number): number {
  return readSync(fd, buf, offset, length, null)
}
