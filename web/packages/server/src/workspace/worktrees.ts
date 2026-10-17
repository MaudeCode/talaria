/** WebUI-managed Agent git worktrees (Python `api/worktrees.py`). */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, relative } from 'node:path'
import { GitRunner, GitWorkspaceError, porcelainStatusEntries, type GitResult } from './git.js'
import { resolvePathLikePython } from './paths.js'
import { pyOsError } from '../util.js'
import type { Session } from '../sessions/session.js'
import type { WorktreeStatus } from '@maudecode/talaria-web-contracts'

/** The `OSError`/`TimeoutExpired` text Python interpolated into `Failed to remove worktree: {exc}`. */
export class GitSpawnFailure extends Error {}

async function git(args: string[], cwd: string, timeoutMs = 2_000): Promise<GitResult | null> {
  try { return await gitOrThrow(args, cwd, timeoutMs) } catch (error) {
    if (error instanceof GitSpawnFailure || (error instanceof GitWorkspaceError && error.code === 'not_a_repo')) return null
    throw error
  }
}

async function gitOrThrow(args: string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  try {
    const runner = new GitRunner({ env: process.env })
    if (args[0] === 'status') return await runner.worktreeStatus(cwd, timeoutMs)
    return await runner.run(cwd, args, { timeoutMs })
  } catch (error) {
    if (!(error instanceof GitWorkspaceError) || !(error.cause instanceof Error)) throw error
    const cause = error.cause as NodeJS.ErrnoException
    throw new GitSpawnFailure(cause.code === 'ETIMEDOUT' ? `Command '${JSON.stringify(['git', ...args]).replaceAll('"', "'").replaceAll(',', ', ')}' timed out after ${String(timeoutMs / 1000)} seconds` : pyOsError(cause, 'git'))
  }
}

function resolvePath(path: unknown): string | null {
  if (!path || typeof path !== 'string') return null
  return resolvePathLikePython(path)
}

function isDir(path: string | null): boolean {
  if (!path) return false
  try { return statSync(path).isDirectory() } catch { return false }
}

function parseWorktreeListPorcelain(output: string): Set<string> {
  const paths = new Set<string>()
  for (const line of output.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const p = line.slice('worktree '.length).trim()
    if (p) paths.add(resolvePathLikePython(p))
  }
  return paths
}

async function worktreeListed(worktreePath: string, repoRoot: unknown): Promise<boolean> {
  const repo = resolvePath(repoRoot)
  const cwd = isDir(repo) ? repo : isDir(worktreePath) ? worktreePath : null
  if (!cwd) return false
  const result = await git(['worktree', 'list', '--porcelain'], cwd)
  if (result?.status !== 0) return false
  return parseWorktreeListPorcelain(result.stdout).has(worktreePath)
}

/**
 * Paths (git-status form) in the worktree that are the Agent's `.worktreeinclude` directory symlinks
 * (`_include_symlink_paths`): a symlink at a listed entry that resolves to that same entry in the main checkout.
 * A trailing-slash gitignore pattern never matches a symlink, so git reports each one as untracked.
 */
function includeSymlinkPaths(worktreePath: string, repoRoot: string | null): Set<string> {
  const paths = new Set<string>()
  if (!repoRoot) return paths
  let text: string
  try { text = readFileSync(join(repoRoot, '.worktreeinclude'), 'utf8').replace(/^\uFEFF/, '') } catch { return paths }
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const entry = posix.normalize(trimmed).replace(/\/+$/, '')
    if (isIncludeLink(worktreePath, repoRoot, entry)) paths.add(entry)
  }
  return paths
}

function isIncludeLink(worktreePath: string, repoRoot: string, entry: string, at = join(worktreePath, entry)): boolean {
  try {
    return lstatSync(at).isSymbolicLink() && realpathSync(at) === realpathSync(join(repoRoot, entry))
  } catch { return false } // unreadable or dangling: real state, still counts
}

/**
 * The include links an untracked git-status path covers, or null when it holds anything else. `--untracked-files=normal`
 * reports a nested link (`vendor/node_modules`) as its untracked parent (`vendor`), so a parent qualifies when it is a
 * real directory holding only include links and directories leading to them.
 */
function coveredIncludeLinks(worktreePath: string, path: string, include: Set<string>): string[] | null {
  if (include.has(path)) return [path]
  if (![...include].some((e) => e.startsWith(`${path}/`))) return null
  try {
    if (!lstatSync(join(worktreePath, path)).isDirectory()) return null
    const links: string[] = []
    for (const child of readdirSync(join(worktreePath, path))) {
      const covered = coveredIncludeLinks(worktreePath, `${path}/${child}`, include)
      if (!covered) return null
      links.push(...covered)
    }
    return links
  } catch { return null }
}

/**
 * Unlink an include link without a check-then-delete gap: move it to a private name first, then verify what was moved.
 * Anything else stays under that name and stops the removal.
 */
function unlinkIncludeLink(worktreePath: string, repoRoot: string, entry: string): { path: string; target: string } | null {
  const path = join(worktreePath, entry)
  if (!isIncludeLink(worktreePath, repoRoot, entry)) return null // replaced since the probe: git refuses it
  const moved = join(dirname(path), `.${basename(path)}.talaria-remove-${randomUUID()}`)
  try { renameSync(path, moved) } catch { return null } // already gone: git decides
  if (!isIncludeLink(worktreePath, repoRoot, entry, moved)) throw new Error(`Worktree changed during removal; ${path} was moved to ${moved}.`)
  const target = readlinkSync(moved)
  unlinkSync(moved)
  return { path, target }
}

/** `[dirty, untracked count, ignored include symlinks]`; the Agent's own include symlinks are not user state. */
async function statusPorcelain(worktreePath: string, repoRoot: string | null, strict: boolean): Promise<[boolean, number, string[]]> {
  const args = ['status', '--porcelain', '-z', '--untracked-files=normal']
  const result = strict ? await gitOrThrow(args, worktreePath, 2_000) : await git(args, worktreePath)
  if (result?.status !== 0) {
    if (strict) throw new Error('Worktree status could not be verified before removal')
    return [false, 0, []]
  }
  const entries = porcelainStatusEntries(result.stdout)
  const counted: string[] = []
  const links: string[] = []
  let include: Set<string> | undefined
  for (const [entry] of entries) {
    if (!entry) continue
    if (entry.startsWith('?? ')) {
      include ??= includeSymlinkPaths(worktreePath, repoRoot)
      const covered = coveredIncludeLinks(worktreePath, entry.slice(3).replace(/\/+$/, ''), include)
      if (covered) { links.push(...covered); continue }
    }
    counted.push(entry)
  }
  return [counted.length > 0, counted.filter((e) => e.startsWith('??')).length, links]
}

async function aheadBehind(worktreePath: string): Promise<{ ahead: number; behind: number; available: boolean; upstream: string | null }> {
  const payload = { ahead: 0, behind: 0, available: false, upstream: null as string | null }
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], worktreePath)
  if (upstream?.status !== 0) return payload
  const ref = upstream.stdout.trim()
  if (!ref) return payload
  payload.upstream = ref
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], worktreePath)
  if (counts?.status !== 0) return payload
  const parts = counts.stdout.trim().split(/\s+/)
  if (parts.length !== 2) return payload
  const a = Number.parseInt(parts[0] ?? '', 10)
  const b = Number.parseInt(parts[1] ?? '', 10)
  if (Number.isFinite(a) && Number.isFinite(b)) {
    payload.ahead = Math.max(0, a)
    payload.behind = Math.max(0, b)
    payload.available = true
  }
  return payload
}

export interface WorktreeLocks {
  lockedByStream: (session: Session) => boolean
  lockedByTerminal: (sessionId: string, worktreePath: string) => boolean
}

export async function worktreeStatusForSession(session: Session, locks: WorktreeLocks): Promise<WorktreeStatus> {
  return (await probeWorktree(session, locks)).status
}

async function probeWorktree(session: Session, locks: WorktreeLocks, strict = false, capturedPath?: string): Promise<{ status: WorktreeStatus; includeLinks: string[] }> {
  const worktreePath = capturedPath ?? resolvePath(session.worktree_path)
  if (!worktreePath) throw new Error('Session is not worktree-backed')
  const exists = isDir(worktreePath)
  const lockedByStream = locks.lockedByStream(session)
  const lockedByTerminal = locks.lockedByTerminal(session.session_id, worktreePath)
  const listed = await worktreeListed(worktreePath, session.worktree_repo_root)
  const [dirty, untracked, includeLinks] = exists ? await statusPorcelain(worktreePath, resolvePath(session.worktree_repo_root), strict) : [false, 0, []]
  const aheadBehindStatus = exists ? await aheadBehind(worktreePath) : { ahead: 0, behind: 0, available: false, upstream: null }
  const status: WorktreeStatus = {
    path: worktreePath, exists, dirty, untracked_count: untracked, ahead_behind: aheadBehindStatus,
    locked_by_stream: lockedByStream, locked_by_terminal: lockedByTerminal, listed,
    // `removeWorktreeForSession`'s gates: a missing directory is always removable, a lock blocks removal outright,
    // and uncommitted, untracked, or unpushed work needs `force`.
    removable: !exists || !(lockedByStream || lockedByTerminal),
    force_required: dirty || untracked > 0 || aheadBehindStatus.ahead > 0,
  }
  return { status, includeLinks }
}

function removalWarnings(status: WorktreeStatus, force: boolean): string[] {
  const warnings: string[] = []
  if (status.locked_by_stream) throw new Error('Worktree is locked by an active streaming session')
  if (status.locked_by_terminal) throw new Error('Worktree is locked by an active terminal session')
  if (status.dirty && !force) throw new Error('Worktree has uncommitted changes. Use force=true to override.')
  const untracked = status.untracked_count
  if (untracked > 0) {
    if (force) warnings.push(`${untracked} untracked file(s) will be removed.`)
    else throw new Error(`Worktree has ${untracked} untracked file(s). Use force=true to override.`)
  }
  const ahead = status.ahead_behind.ahead
  if (ahead > 0) {
    if (force) warnings.push(`${ahead} unpushed commit(s) will be removed.`)
    else throw new Error(`Worktree has ${ahead} unpushed commit(s). Use force=true to override.`)
  }
  return warnings
}

export async function removeWorktreeForSession(session: Session, locks: WorktreeLocks, opts: { force?: boolean } = {}): Promise<Record<string, unknown>> {
  const worktreePath = resolvePath(session.worktree_path)
  if (!worktreePath) throw new Error('Session is not worktree-backed')
  const { status, includeLinks } = await probeWorktree(session, locks)
  if (!status.exists) return { ok: true, removed_path: worktreePath, warnings: ['Worktree directory no longer exists on disk.'] }
  const force = Boolean(opts.force)
  const warnings = removalWarnings(status, force)
  const repoRoot = session.worktree_repo_root
  if (!repoRoot) throw new Error('Session missing worktree_repo_root')
  // A stream or terminal may have started while the Git probes above were awaited.
  if (locks.lockedByStream(session)) throw new Error('Worktree is locked by an active streaming session')
  if (locks.lockedByTerminal(session.session_id, worktreePath)) throw new Error('Worktree is locked by an active terminal session')
  await git(['worktree', 'unlock', worktreePath], repoRoot, 5_000)
  // Remove only the Agent's include links, never their targets, before the final probe of the captured directory.
  const resolvedRoot = resolvePath(repoRoot)
  // A worktree that survives a failed removal gets them back.
  const unlinked: { path: string; target: string }[] = []
  let currentPath = worktreePath
  let privateParent: string | undefined
  const runRemoval = async (args: string[]): Promise<void> => {
    let result: GitResult
    try { result = await gitOrThrow(args, repoRoot, 10_000) } catch (error) {
      throw new Error(`Failed to remove worktree: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result.status !== 0) {
      const stderr = result.stderr.trim().split('\n').pop() ?? ''
      throw new Error(`git worktree remove failed: ${stderr || result.stdout.trim()}`)
    }
  }
  try {
    if (!force && resolvedRoot) {
      for (const link of includeLinks) {
        const removed = unlinkIncludeLink(worktreePath, resolvedRoot, link)
        if (removed) unlinked.push(removed)
      }
    }
    if (!force) {
      // Capture the directory before the last safe probe. Git's normal remove would run status against live config.
      privateParent = mkdtempSync(join(dirname(worktreePath), '.talaria-worktree-remove-'))
      writeFileSync(join(privateParent, 'recovery.json'), JSON.stringify({ original_path: worktreePath, repo_root: resolvedRoot }), { mode: 0o600, flush: true })
      const moved = join(privateParent, 'tree')
      try { await runRemoval(['worktree', 'move', worktreePath, moved]) } finally {
        if (isDir(moved)) currentPath = moved
      }
      try { removalWarnings((await probeWorktree(session, locks, true, currentPath)).status, false) } catch (error) {
        throw new Error(`git worktree remove failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await runRemoval(['worktree', 'remove', '--force', currentPath])
    if (currentPath !== worktreePath) {
      try { lstatSync(worktreePath); warnings.push('The original worktree path was recreated during removal and was left untouched.') } catch { /* no replacement */ }
    }
  } catch (error) {
    let failure = error
    if (currentPath !== worktreePath && isDir(currentPath)) {
      try {
        try { lstatSync(worktreePath); throw new Error('The original path is occupied') } catch (occupied) {
          if ((occupied as NodeJS.ErrnoException).code !== 'ENOENT') throw occupied
        }
        renameSync(currentPath, worktreePath)
        currentPath = worktreePath
        await runRemoval(['worktree', 'repair', worktreePath])
      } catch (restore) {
        failure = new Error(`${error instanceof Error ? error.message : String(error)}. Worktree retained at ${currentPath}; restoring its original location failed: ${restore instanceof Error ? restore.message : String(restore)}`)
      }
    }
    for (const { path, target } of unlinked) try { symlinkSync(target, join(currentPath, relative(worktreePath, path))) } catch { /* something else took its place */ }
    throw failure
  } finally {
    if (privateParent) {
      try { lstatSync(join(privateParent, 'tree')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try { unlinkSync(join(privateParent, 'recovery.json')) } catch { /* already gone or not ours to unlink */ }
          try { rmdirSync(privateParent) } catch { /* best effort after the capture is gone */ }
        }
      }
    }
  }
  await git(['worktree', 'prune'], repoRoot, 5_000)
  return { ok: true, removed_path: worktreePath, warnings: warnings.length ? warnings : null }
}
