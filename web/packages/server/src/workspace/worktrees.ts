/** WebUI-managed Agent git worktrees (Python `api/worktrees.py`). */
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolvePathLikePython } from './paths.js'
import type { Session } from '../sessions/session.js'

function git(args: string[], cwd: string, timeoutMs = 2_000): { status: number; stdout: string; stderr: string } | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  if (r.error) return null
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
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

function worktreeListed(worktreePath: string, repoRoot: unknown): boolean {
  const repo = resolvePath(repoRoot)
  const cwd = isDir(repo) ? repo : isDir(worktreePath) ? worktreePath : null
  if (!cwd) return false
  const result = git(['worktree', 'list', '--porcelain'], cwd)
  if (result?.status !== 0) return false
  return parseWorktreeListPorcelain(result.stdout).has(worktreePath)
}

function statusPorcelain(worktreePath: string): [boolean, number] {
  const result = git(['status', '--porcelain', '--untracked-files=normal'], worktreePath)
  if (result?.status !== 0) return [false, 0]
  const lines = result.stdout.split('\n').filter(Boolean)
  return [lines.length > 0, lines.filter((l) => l.startsWith('??')).length]
}

function aheadBehind(worktreePath: string): { ahead: number; behind: number; available: boolean; upstream: string | null } {
  const payload = { ahead: 0, behind: 0, available: false, upstream: null as string | null }
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], worktreePath)
  if (upstream?.status !== 0) return payload
  const ref = upstream.stdout.trim()
  if (!ref) return payload
  payload.upstream = ref
  const counts = git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], worktreePath)
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

export function worktreeStatusForSession(session: Session, locks: WorktreeLocks): Record<string, unknown> {
  const worktreePath = resolvePath(session.worktree_path)
  if (!worktreePath) throw new Error('Session is not worktree-backed')
  const exists = isDir(worktreePath)
  const status: Record<string, unknown> = {
    path: worktreePath, exists, dirty: false, untracked_count: 0,
    ahead_behind: { ahead: 0, behind: 0, available: false, upstream: null },
    locked_by_stream: locks.lockedByStream(session),
    locked_by_terminal: locks.lockedByTerminal(session.session_id, worktreePath),
    listed: worktreeListed(worktreePath, session.worktree_repo_root),
  }
  if (!exists) return status
  const [dirty, untracked] = statusPorcelain(worktreePath)
  status.dirty = dirty
  status.untracked_count = untracked
  status.ahead_behind = aheadBehind(worktreePath)
  return status
}

export function removeWorktreeForSession(session: Session, locks: WorktreeLocks, opts: { force?: boolean } = {}): Record<string, unknown> {
  const worktreePath = resolvePath(session.worktree_path)
  if (!worktreePath) throw new Error('Session is not worktree-backed')
  const status = worktreeStatusForSession(session, locks)
  if (!status.exists) return { ok: true, removed_path: worktreePath, warnings: ['Worktree directory no longer exists on disk.'] }
  const warnings: string[] = []
  const force = Boolean(opts.force)
  if (status.locked_by_stream) throw new Error('Worktree is locked by an active streaming session')
  if (status.locked_by_terminal) throw new Error('Worktree is locked by an active terminal session')
  if (status.dirty && !force) throw new Error('Worktree has uncommitted changes. Use force=true to override.')
  const untracked = Number(status.untracked_count) || 0
  if (untracked > 0) {
    if (force) warnings.push(`${untracked} untracked file(s) will be removed.`)
    else throw new Error(`Worktree has ${untracked} untracked file(s). Use force=true to override.`)
  }
  const ahead = (status.ahead_behind as { ahead?: number }).ahead ?? 0
  if (ahead > 0) {
    if (force) warnings.push(`${ahead} unpushed commit(s) will be removed.`)
    else throw new Error(`Worktree has ${ahead} unpushed commit(s). Use force=true to override.`)
  }
  const repoRoot = session.worktree_repo_root
  if (!repoRoot) throw new Error('Session missing worktree_repo_root')
  git(['worktree', 'unlock', worktreePath], repoRoot, 5_000)
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)
  const result = git(args, repoRoot, 10_000)
  if (!result) throw new Error('Failed to remove worktree: git is unavailable')
  if (result.status !== 0) {
    const stderr = result.stderr.trim().split('\n').pop() ?? ''
    throw new Error(`git worktree remove failed: ${stderr || result.stdout.trim()}`)
  }
  git(['worktree', 'prune'], repoRoot, 5_000)
  return { ok: true, removed_path: worktreePath, warnings: warnings.length ? warnings : null }
}

/** The enclosing repository root (git decides, so nested workspaces and linked worktrees both work). */
export function findGitRepoRoot(workspace: string): string {
  const ws = resolvePathLikePython(workspace)
  if (!isDir(ws)) throw new Error('Workspace path does not exist or is not a directory')
  const result = git(['rev-parse', '--show-toplevel'], ws, 5_000)
  if (result?.status !== 0 || !result.stdout.trim()) throw new Error('Workspace is not inside a git repository')
  return resolvePathLikePython(result.stdout.trim())
}
