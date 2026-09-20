/**
 * Workspace file operations (Python `api/workspace.py` list/read/anchored
 * helpers). Node has no `openat`, so the race guards are approximated: every
 * path component is `lstat`-checked to be a real directory after resolution,
 * the leaf is opened with `O_NOFOLLOW`, and the opened descriptor is
 * re-verified against the expected inode. ponytail: an `openat` walk needs a
 * native addon; revisit if a symlink race is ever demonstrated on this path.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, unlinkSync, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isWithin, resolvePathLikePython } from './paths.js'
import { isBlockedSystemPath } from './workspaces.js'

export const MAX_FILE_BYTES = 400_000

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0

export class PathTraversalError extends Error {}

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

/** Verify no component under the root is a symlink (the target must already be resolved). */
function assertSymlinkFreeWalk(root: string, target: string, opts: { allowMissingLeaf?: boolean; createMissingDirs?: boolean } = {}): void {
  const rootResolved = resolvePathLikePython(root)
  const parts = relParts(rootResolved, target)
  let current = rootResolved
  const rootStat = lstatSync(rootResolved)
  if (rootStat.isSymbolicLink()) throw new PathTraversalError(`Path traversal blocked: ${target}`)
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i] ?? '')
    const isLast = i === parts.length - 1
    let st: Stats
    try {
      st = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (isLast && opts.allowMissingLeaf) return
        if (opts.createMissingDirs) {
          mkdirSync(current, { mode: 0o755 })
          continue
        }
      }
      throw new NotFoundError(`Not found: ${target}`)
    }
    if (st.isSymbolicLink()) throw new NotFoundError(`Not found: ${target}`)
    if (!isLast && !st.isDirectory()) throw new NotFoundError(`Not found: ${target}`)
  }
}

export class NotFoundError extends Error {}

/** Open `target` for reading with the anchored walk (Python `open_anchored_fd`). Caller closes the fd. */
export function openAnchoredFd(root: string, target: string, opts: { wantDir: boolean }): number {
  assertSymlinkFreeWalk(root, target)
  try {
    return openSync(target, constants.O_RDONLY | O_NOFOLLOW | (opts.wantDir ? O_DIRECTORY : 0))
  } catch {
    throw new NotFoundError(`Not found: ${target}`)
  }
}

/** Exclusive create under the root, creating missing parents (Python `open_anchored_create_fd`). */
export function openAnchoredCreateFd(root: string, dest: string): number {
  const parts = relParts(resolvePathLikePython(root), dest)
  if (!parts.length) throw new PathTraversalError(`Invalid destination: ${dest}`)
  assertSymlinkFreeWalk(root, dirname(dest), { createMissingDirs: true })
  try {
    return openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsError(dest)
    throw new NotFoundError(`Not found: ${dest}`)
  }
}

export class FileExistsError extends Error {}

export function makeAnchoredDir(root: string, dest: string): void {
  const rootResolved = resolvePathLikePython(root)
  const destResolved = resolvePathLikePython(dest)
  if (destResolved === rootResolved) return
  relParts(rootResolved, destResolved)
  assertSymlinkFreeWalk(rootResolved, destResolved, { createMissingDirs: true })
}

export function openAnchoredWriteFd(root: string, target: string): number {
  const targetResolved = resolvePathLikePython(target)
  const parts = relParts(resolvePathLikePython(root), targetResolved)
  if (!parts.length) throw new PathTraversalError(`Invalid target: ${target}`)
  assertSymlinkFreeWalk(root, targetResolved)
  return openSync(targetResolved, constants.O_WRONLY | constants.O_TRUNC | O_NOFOLLOW)
}

export function unlinkAnchored(root: string, target: string): void {
  const targetResolved = resolvePathLikePython(target)
  const parts = relParts(resolvePathLikePython(root), targetResolved)
  if (!parts.length) throw new PathTraversalError(`Invalid target: ${target}`)
  assertSymlinkFreeWalk(root, targetResolved)
  unlinkSync(targetResolved)
}

export function rmtreeAnchored(root: string, target: string): void {
  const targetResolved = resolvePathLikePython(target)
  const parts = relParts(resolvePathLikePython(root), targetResolved)
  if (!parts.length) throw new PathTraversalError(`Invalid target: ${target}`)
  assertSymlinkFreeWalk(root, targetResolved)
  rmSync(targetResolved, { recursive: true, force: false })
}

export function renameAnchored(root: string, source: string, dest: string): void {
  const rootResolved = resolvePathLikePython(root)
  const sourceResolved = resolvePathLikePython(source)
  const destParent = resolvePathLikePython(dirname(dest))
  const sourceParts = relParts(rootResolved, sourceResolved)
  if (!isWithin(destParent, rootResolved)) throw new PathTraversalError(`Path traversal blocked: ${dest}`)
  if (!sourceParts.length) throw new PathTraversalError(`Invalid source: ${source}`)
  const leaf = basename(dest)
  if (!leaf) throw new PathTraversalError(`Invalid destination: ${dest}`)
  assertSymlinkFreeWalk(rootResolved, sourceResolved)
  assertSymlinkFreeWalk(rootResolved, destParent)
  const target = join(destParent, leaf)
  try {
    lstatSync(target)
    throw new FileExistsError(leaf)
  } catch (error) {
    if (!(error instanceof FileExistsError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (error instanceof FileExistsError) throw error
  }
  renameSync(sourceResolved, target)
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
