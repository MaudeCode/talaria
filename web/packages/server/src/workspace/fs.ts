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
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, type Stats } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isWithin, resolvePathLikePython } from './paths.js'
import { isBlockedSystemPath } from './workspaces.js'

export const MAX_FILE_BYTES = 400_000

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0

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

/** Walk from the root to the parent of the leaf, one descriptor at a time. Caller closes the returned handle. */
function openAnchoredParent(root: string, target: string, opts: { createMissingDirs?: boolean } = {}): { dir: DirHandle; leaf: string } {
  const rootResolved = resolvePathLikePython(root)
  const parts = relParts(rootResolved, target)
  if (!parts.length) throw new PathTraversalError(`Invalid target: ${target}`)
  const leaf = parts[parts.length - 1] ?? ''
  if (!leaf || leaf === '.' || leaf === '..') throw new PathTraversalError(`Invalid target: ${target}`)
  let fd: number
  try { fd = openSync(rootResolved, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW) } catch { throw new NotFoundError(`Not found: ${target}`) }
  let dir = new DirHandle(fd, rootResolved)
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
    try { return openSync(rootResolved, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW) } catch { throw new NotFoundError(`Not found: ${target}`) }
  }
  const { dir, leaf } = openAnchoredParent(root, target)
  try {
    try { return dir.anchored(() => openSync(dir.child(leaf), constants.O_RDONLY | O_NOFOLLOW | (opts.wantDir ? O_DIRECTORY : 0))) } catch { throw new NotFoundError(`Not found: ${target}`) }
  } finally {
    dir.close()
  }
}

/** Exclusive create under the root, creating missing parents (Python `open_anchored_create_fd`). */
export function openAnchoredCreateFd(root: string, dest: string): number {
  const { dir, leaf } = openAnchoredParent(root, dest, { createMissingDirs: true })
  try {
    return dir.anchored(() => openSync(dir.child(leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644))
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
    return dir.anchored(() => openSync(dir.child(leaf), constants.O_WRONLY | constants.O_TRUNC | O_NOFOLLOW))
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
  } catch {
    throw new NotFoundError(`Not found: ${target}`)
  } finally {
    dir.close()
  }
}

export function rmtreeAnchored(root: string, target: string): void {
  const targetResolved = resolvePathLikePython(target)
  const { dir, leaf } = openAnchoredParent(root, targetResolved)
  try {
    dir.anchored(() => {
      const entry = lstatSync(dir.child(leaf))
      if (entry.isSymbolicLink()) throw new NotFoundError(`Not found: ${target}`)
      rmSync(dir.child(leaf), { recursive: true, force: false })
    })
  } catch (error) {
    if (error instanceof NotFoundError) throw error
    throw new NotFoundError(`Not found: ${target}`)
  } finally {
    dir.close()
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
  const fd = openAnchoredFd(workspace, target, { wantDir: true })
  closeSync(fd)
  const entries: DirEntry[] = []
  const dirents = readdirSync(target, { withFileTypes: true })
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
    const full = join(target, name)
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

/** Serialize bigint timestamps for JSON (Python emits ints; JS numbers lose precision above 2^53, so use strings there). */
export function serializeEntriesForBrowser(entries: DirEntry[]): Record<string, unknown>[] {
  return entries.map((e) => {
    const out: Record<string, unknown> = { ...e }
    out.mtime_ns = e.mtime_ns === null || e.mtime_ns === undefined ? null : e.mtime_ns <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(e.mtime_ns) : e.mtime_ns.toString()
    out.birthtime_ns = e.birthtime_ns === null || e.birthtime_ns === undefined ? null : e.birthtime_ns <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(e.birthtime_ns) : e.birthtime_ns.toString()
    return out
  })
}

/** Python `dir_signature`: sha256 of the bounded listing metadata. */
export function dirSignature(workspace: string, rel = '.', entries?: DirEntry[]): string {
  const list = entries ?? listDir(workspace, rel)
  const payload = list.map((e) => ({ name: e.name, path: e.path, type: e.type, is_dir: e.is_dir ?? null, size: e.size ?? null, mtime_ns: e.mtime_ns === undefined || e.mtime_ns === null ? null : e.mtime_ns.toString(), target: e.target ?? null, target_outside_workspace: e.target_outside_workspace ?? null }))
  return createHash('sha256').update(JSON.stringify(payload.map(sortKeysDeep)), 'utf8').digest('hex')
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeysDeep(obj[k])]))
  }
  return value
}

export interface FileContent { path: string; content: string; size: number; lines: number }

export class FileTooLargeError extends Error {}

/** Python `read_file_content` (office previews were dropped with TAL-245). */
export function readFileContent(workspace: string, rel: string): FileContent {
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
