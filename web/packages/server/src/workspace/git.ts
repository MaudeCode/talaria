/**
 * Git helpers for the workspace panel (Python `api/workspace_git.py`).
 *
 * The browser only sends session ids and workspace-relative paths. This module
 * resolves the workspace server-side, scopes paths before they become Git
 * pathspecs, and keeps every Git subprocess shell-free, env-scrubbed, hardened
 * against repo-local config, and bounded by a timeout.
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isWithin, resolvePathLikePython } from './paths.js'
import { openAnchoredFd, rmtreeAnchored, safeResolveWs, unlinkAnchored } from './fs.js'
import { str } from '../util.js'

export const GIT_TIMEOUT_MS = 5_000
export const GIT_REMOTE_TIMEOUT_MS = 60_000
export const STATUS_FILE_LIMIT = 500
export const STATUS_CACHE_TTL_MS = 2_000
export const STATUS_CACHE_LIMIT = 32
export const DIFF_SIZE_LIMIT = 512 * 1024
export const COMMIT_MESSAGE_DIFF_LIMIT = 64 * 1024
export const WORKSPACE_GIT_DESTRUCTIVE_ENV = 'HERMES_WEBUI_WORKSPACE_GIT_DESTRUCTIVE'
export const WORKSPACE_BUSY_MESSAGE = 'A Git operation is running in this workspace.'
const GIT_ENV_SCRUB_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND']
const GIT_ENV_SCRUB_PREFIXES = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_']
const BRANCH_SWITCH_STASH_PREFIX = 'hermes-webui branch switch'
const GIT_HARDENED_CONFIG: [string, string][] = [
  ['core.fsmonitor', 'false'],
  ['core.sshCommand', 'ssh'],
  ['core.askPass', ''],
  ['credential.helper', ''],
  ['protocol.ext.allow', 'never'],
  ['core.gitProxy', ''],
  ['submodule.recurse', 'false'],
  ['fetch.recurseSubmodules', 'false'],
]
const GIT_DESTRUCTIVE_HARDENED_CONFIG: [string, string][] = [
  ['commit.gpgSign', 'false'],
  ['push.gpgSign', 'false'],
  ['gpg.program', ''],
  ['gpg.ssh.program', ''],
  ['gpg.x509.program', ''],
  ['core.alternateRefsCommand', ''],
]
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export class GitWorkspaceError extends Error {
  constructor(message: string, readonly code = 'git_failed') {
    super(message)
    this.name = 'GitWorkspaceError'
  }
}

export interface GitContext { workspace: string; repoRoot: string; workspacePrefix: string }
export interface GitFile {
  path: string; old_path: string | null; workspace_path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean
  ignored: boolean; conflict: boolean; additions: number; deletions: number; binary: boolean
}
export interface GitTotals { changed: number; staged: number; unstaged: number; untracked: number; conflicts: number }
export interface GitStatus {
  is_git: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; totals?: GitTotals; files?: GitFile[]; truncated?: boolean
  noise_filtering?: { filemode_only: number; crlf_only: number; active: boolean }
}
export interface GitRef { name: string; sha: string; updated: number; updated_relative: string; author: string; subject: string; upstream: string; ahead: number; behind: number }
export interface GitBranches { is_git: true; current: string; detached: boolean; head: string; local: GitRef[]; remote: GitRef[]; upstream: string; ahead: number; behind: number }
export interface GitDiff { path: string; kind: string; binary: boolean; too_large: boolean; additions: number; deletions: number; diff: string }

export interface GitRunnerDeps {
  env: Record<string, string | undefined>
  /** Generates commit messages from a prompt (sidecar `aux.complete`). */
  now?: () => number
  /** How long a mutation waits for the repo's previous one before answering `operation_in_progress`. */
  mutationLockTimeoutMs?: number
}

interface RunOptions {
  timeoutMs?: number
  check?: boolean
  env?: Record<string, string>
  destructive?: boolean
  forceDestructiveHardening?: boolean
  disableFilterAttributes?: boolean
  neutralizeFilterPrograms?: boolean
  neutralizeRemoteHelpers?: boolean
}

export interface GitResult { status: number; stdout: string; stderr: string }

export interface GitSpawn { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

/**
 * Run `git` without blocking the event loop, resolving like `spawnSync`: the exit status (null when a signal ended it),
 * plus the `error` that prevented a normal run (`ETIMEDOUT` when the timeout killed it). Without `env` the child
 * inherits the server's environment.
 */
export function spawnGit(cwd: string, argv: string[], timeoutMs: number, env?: Record<string, string>): Promise<GitSpawn> {
  return new Promise((done) => {
    execFile('git', argv, { cwd, ...(env ? { env } : {}), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) done({ status: 0, stdout, stderr })
      else if (typeof error.code === 'number') done({ status: error.code, stdout, stderr })
      else if (error.code == null) done({ status: null, stdout, stderr, ...(error.killed ? { error: Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' }) } : {}) })
      else done({ status: null, stdout, stderr, error: error as NodeJS.ErrnoException })
    })
  })
}

type Stats = Map<string, [number, number, boolean]>

export function classifyGitError(message: string, args: string[] = []): string {
  const text = message.toLowerCase()
  const joined = args.join(' ').toLowerCase()
  if (text.includes('timed out')) return 'timeout'
  if (text.includes('not installed') || text.includes("no such file or directory: 'git'")) return 'missing_git'
  if (text.includes('not a git repository')) return 'not_a_repo'
  if (text.includes('outside the workspace') || text.includes('outside the git repository')) return 'path_outside_workspace'
  if (text.includes('authentication failed') || text.includes('permission denied') || text.includes('could not read username')) return 'auth_failed'
  if (text.includes('no upstream') || text.includes('no configured push destination') || text.includes('has no upstream branch')) return 'no_upstream'
  if (text.includes('non-fast-forward') || text.includes('fetch first') || (text.includes('rejected') && joined.includes('push'))) return 'non_fast_forward'
  if (text.includes('conflict') || text.includes('unmerged') || (text.includes('merge') && text.includes('needs'))) return 'conflict'
  if (text.includes('working tree') && (text.includes('clean') || text.includes('dirty'))) return 'dirty_worktree'
  if (text.includes('local changes') || text.includes('would be overwritten by checkout')) return 'dirty_worktree'
  if (text.includes('invalid reference') || text.includes('not a valid') || text.includes('unknown revision')) return 'invalid_ref'
  if (text.includes('hook')) return 'hook_failed'
  return 'git_failed'
}

/** Unified diff of `[]` → `lines` (Python `difflib.unified_diff` for an empty left side). */
function unifiedDiffFromEmpty(lines: string[], toFile: string): string[] {
  if (!lines.length) return []
  // `difflib` writes `+1` for a single-line range and `+1,N` otherwise.
  return [`--- /dev/null`, `+++ ${toFile}`, `@@ -0,0 +${lines.length === 1 ? '1' : `1,${String(lines.length)}`} @@`, ...lines.map((l) => `+${l}`)]
}

function diffStats(diff: string): [number, number] {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return [additions, deletions]
}

function splitLines(text: string): string[] {
  // Python `str.splitlines()`: no trailing empty element for a final newline.
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export class GitRunner {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly statusCache = new Map<string, { storedAt: number; repoRoot: string; fingerprint: string; payload: GitStatus }>()
  private readonly generations = new Map<string, number>()
  /** Workspaces a working-tree mutation or worktree removal is changing, with their hold counts. */
  private readonly busy = new Map<string, number>()

  constructor(readonly deps: GitRunnerDeps) {}

  /**
   * Hold `path` busy until `fn` settles. The hold is taken before `fn` runs, so checks `fn` makes synchronously (no run
   * active) and admission's `workspaceBusy` refusal leave no gap for a chat run or terminal to start in between.
   */
  async holdWorkspace<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = resolvePathLikePython(path)
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1)
    try {
      return await fn()
    } finally {
      const left = (this.busy.get(key) ?? 1) - 1
      if (left) this.busy.set(key, left)
      else this.busy.delete(key)
    }
  }

  /** Whether `path` overlaps a held workspace (the same directory, inside it, or containing it). */
  workspaceBusy(path: string): boolean {
    const ws = resolvePathLikePython(path)
    for (const held of this.busy.keys()) if (held === ws || isWithin(ws, held) || isWithin(held, ws)) return true
    return false
  }

  destructiveEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes((this.deps.env[WORKSPACE_GIT_DESTRUCTIVE_ENV] ?? '').trim().toLowerCase())
  }

  private cleanEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.deps.env)) if (v !== undefined) env[k] = v
    Object.assign(env, extra ?? {})
    for (const key of GIT_ENV_SCRUB_KEYS) Reflect.deleteProperty(env, key)
    for (const key of Object.keys(env)) if (GIT_ENV_SCRUB_PREFIXES.some((p) => key.startsWith(p))) Reflect.deleteProperty(env, key)
    env.GIT_TERMINAL_PROMPT = '0'
    return env
  }

  private now(): number {
    return this.deps.now ? this.deps.now() * 1000 : Date.now()
  }

  // ── subprocess ───────────────────────────────────────────────────────────

  private async configNamesForScope(scope: string, cwd: string, env: Record<string, string>, pattern: string, nameRe: RegExp, ignoreUnsupported = false): Promise<Set<string>> {
    const result = await spawnGit(cwd, ['config', '--includes', scope, '--name-only', '--get-regexp', pattern], GIT_TIMEOUT_MS, env)
    const names = new Set<string>()
    if (result.status !== 0 && result.status !== 1) {
      if (ignoreUnsupported) return names
      const message = (result.stderr || result.stdout || 'Git command failed').trim()
      throw new GitWorkspaceError(message, classifyGitError(message, ['config']))
    }
    for (const line of (result.stdout || '').split('\n')) {
      const m = nameRe.exec(line.trim())
      if (m?.[1]) names.add(m[1])
    }
    return names
  }

  private async namesLocalAndWorktree(cwd: string, env: Record<string, string>, pattern: string, nameRe: RegExp): Promise<Set<string>> {
    const names = await this.configNamesForScope('--local', cwd, env, pattern, nameRe)
    for (const n of await this.configNamesForScope('--worktree', cwd, env, pattern, nameRe, true)) names.add(n)
    return names
  }

  private async filterNames(cwd: string, env: Record<string, string>): Promise<Set<string>> {
    return await this.namesLocalAndWorktree(cwd, env, String.raw`^filter\..*\.(clean|smudge|process|required)$`, /^filter\.(.+)\.(clean|smudge|process|required)$/)
  }

  private async mergeDriverNames(cwd: string, env: Record<string, string>): Promise<Set<string>> {
    return await this.namesLocalAndWorktree(cwd, env, String.raw`^merge\..*\.driver$`, /^merge\.(.+)\.driver$/)
  }

  private async remoteHelperNames(cwd: string, env: Record<string, string>): Promise<Set<string>> {
    return await this.namesLocalAndWorktree(cwd, env, String.raw`^remote\..*\.(uploadpack|receivepack)$`, /^remote\.(.+)\.(uploadpack|receivepack)$/)
  }

  private static legal(name: string): boolean {
    return !name.includes('\n') && !name.includes('\0')
  }

  async hasRepoLocalFilters(cwd: string): Promise<boolean> {
    return (await this.filterNames(cwd, this.cleanEnv())).size > 0
  }

  async run(ctxOrCwd: GitContext | string, args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const cwd = typeof ctxOrCwd === 'string' ? ctxOrCwd : ctxOrCwd.repoRoot
    const runEnv = this.cleanEnv(opts.env)
    const effectiveDestructive = Boolean(opts.destructive) && this.destructiveEnabled()
    const hardenedDestructive = effectiveDestructive || Boolean(opts.forceDestructiveHardening)
    let attributesFile: string | null = null
    let hooksPath: string | null = null
    const extraConfigs: [string, string][] = []
    let argv = [...args]
    try {
      if (opts.disableFilterAttributes) {
        attributesFile = join(mkdtempSync(join(tmpdir(), 'hermes-webui-git-attrs-')), 'attributes')
        writeFileSync(attributesFile, '')
      }
      if (opts.disableFilterAttributes || opts.neutralizeFilterPrograms) {
        for (const name of [...await this.filterNames(cwd, runEnv)].sort()) {
          if (!GitRunner.legal(name)) continue
          extraConfigs.push([`filter.${name}.clean`, 'cat'], [`filter.${name}.smudge`, 'cat'], [`filter.${name}.process`, ''], [`filter.${name}.required`, 'false'])
        }
      }
      if (effectiveDestructive) {
        for (const name of [...await this.mergeDriverNames(cwd, runEnv)].sort()) {
          if (!GitRunner.legal(name)) continue
          extraConfigs.push([`merge.${name}.driver`, 'git merge-file "%A" "%O" "%B"'])
        }
      }
      if (effectiveDestructive || opts.neutralizeRemoteHelpers) {
        const names = [...await this.remoteHelperNames(cwd, runEnv)].sort()
        for (const name of names) {
          if (!GitRunner.legal(name)) continue
          extraConfigs.push([`remote.${name}.uploadpack`, 'git-upload-pack'], [`remote.${name}.receivepack`, 'git-receive-pack'])
        }
        if (names.length && argv.length) {
          const command = argv[0]
          if (command === 'fetch' || command === 'pull') argv = [command, '--upload-pack=git-upload-pack', ...argv.slice(1)]
          else if (command === 'push') argv = [command, '--receive-pack=git-receive-pack', ...argv.slice(1)]
        }
      }
      if (hardenedDestructive) hooksPath = mkdtempSync(join(tmpdir(), 'hermes-webui-git-hooks-'))
      if (extraConfigs.length) {
        runEnv.GIT_CONFIG_COUNT = String(extraConfigs.length)
        extraConfigs.forEach(([key, value], i) => {
          runEnv[`GIT_CONFIG_KEY_${i}`] = key
          runEnv[`GIT_CONFIG_VALUE_${i}`] = value
        })
      }
      const full: string[] = []
      for (const [key, value] of GIT_HARDENED_CONFIG) full.push('-c', `${key}=${value}`)
      if (hardenedDestructive) {
        for (const [key, value] of GIT_DESTRUCTIVE_HARDENED_CONFIG) full.push('-c', `${key}=${value}`)
        if (hooksPath) full.push('-c', `core.hooksPath=${hooksPath}`)
      }
      if (attributesFile) full.push('-c', `core.attributesFile=${attributesFile}`)
      full.push(...argv)
      const result = await spawnGit(cwd, full, opts.timeoutMs ?? GIT_TIMEOUT_MS, runEnv)
      if (result.error) {
        const err = result.error
        if (err.code === 'ETIMEDOUT') throw new GitWorkspaceError('Git command timed out', 'timeout')
        if (err.code === 'ENOENT') throw new GitWorkspaceError('Git is not installed or not available on PATH', 'missing_git')
        throw new GitWorkspaceError(err.message, classifyGitError(err.message, args))
      }
      const out: GitResult = { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
      if (opts.check && out.status !== 0) {
        const message = (out.stderr || out.stdout || 'Git command failed').trim()
        throw new GitWorkspaceError(message, classifyGitError(message, args))
      }
      return out
    } finally {
      if (attributesFile) rmSync(dirname(attributesFile), { recursive: true, force: true })
      if (hooksPath) rmSync(hooksPath, { recursive: true, force: true })
    }
  }

  // ── context and paths ────────────────────────────────────────────────────

  async resolveContext(workspace: string): Promise<GitContext | null> {
    const ws = resolvePathLikePython(workspace)
    // Python ran `git rev-parse` with `cwd=<workspace>`; a vanished directory raised `FileNotFoundError`, which `_run_git`
    // reported as `missing_git` — every route answered 400 rather than "not a repo".
    if (!existsSync(ws)) throw new GitWorkspaceError('Git is not installed or not available on PATH', 'missing_git')
    let result: GitResult
    try {
      result = await this.run(ws, ['rev-parse', '--show-toplevel'])
    } catch (error) {
      if (error instanceof GitWorkspaceError && (error.code === 'missing_git' || error.code === 'timeout')) throw error
      return null
    }
    if (result.status !== 0) return null
    const repoRoot = resolvePathLikePython(result.stdout.trim())
    if (ws !== repoRoot && !isWithin(ws, repoRoot)) return null
    const prefix = ws === repoRoot ? '' : relative(repoRoot, ws).split(sep).join('/')
    return { workspace: ws, repoRoot, workspacePrefix: prefix }
  }

  private static workspacePathspec(ctx: GitContext): string {
    return ctx.workspacePrefix || '.'
  }

  private static repoRel(ctx: GitContext, workspaceRel: string): string {
    let target: string
    try {
      target = safeResolveWs(ctx.workspace, workspaceRel || '.')
    } catch (error) {
      throw new GitWorkspaceError((error as Error).message, 'path_outside_workspace')
    }
    if (target !== ctx.repoRoot && !isWithin(target, ctx.repoRoot)) throw new GitWorkspaceError('Path is outside the Git repository', 'path_outside_workspace')
    if (ctx.workspacePrefix && target !== ctx.workspace && !isWithin(target, ctx.workspace)) throw new GitWorkspaceError('Path is outside the workspace', 'path_outside_workspace')
    const rel = relative(ctx.repoRoot, target).split(sep).join('/')
    return rel || '.'
  }

  private static workspaceRel(ctx: GitContext, repoRel: string): string | null {
    const normalized = repoRel.replace(/\\/g, '/')
    if (!ctx.workspacePrefix) return normalized
    const prefix = `${ctx.workspacePrefix.replace(/\/+$/, '')}/`
    if (normalized === ctx.workspacePrefix) return '.'
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
    return null
  }

  // ── mutation lock ────────────────────────────────────────────────────────

  /** `holdRepo` keeps runs and terminals out of the whole repository while a working-tree mutation runs. */
  private async withMutationLock<T>(ctx: GitContext, fn: () => Promise<T>, { holdRepo = true } = {}): Promise<T> {
    const key = ctx.repoRoot
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((r) => { release = r })
    const chained = previous.then(() => current)
    this.locks.set(key, chained)
    // Drop the entry once this link settles and nothing queued behind it, whether it ran or timed out waiting.
    void chained.then(() => { if (this.locks.get(key) === chained) this.locks.delete(key) })
    let timer: NodeJS.Timeout | undefined
    const acquired = await Promise.race([previous.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => { r(false) }, this.deps.mutationLockTimeoutMs ?? GIT_REMOTE_TIMEOUT_MS) })])
    clearTimeout(timer)
    if (!acquired) {
      release()
      throw new GitWorkspaceError('Another Git operation is still running', 'operation_in_progress')
    }
    try {
      return await (holdRepo ? this.holdWorkspace(ctx.repoRoot, fn) : fn())
    } finally {
      this.invalidateStatusCache(ctx.repoRoot)
      release()
    }
  }

  // ── status cache ─────────────────────────────────────────────────────────

  private static resolveGitDir(repoRoot: string): string {
    const dotGit = join(repoRoot, '.git')
    try {
      if (statSync(dotGit).isFile()) {
        const text = readFileSync(dotGit, 'utf8').trim()
        if (text.startsWith('gitdir:')) {
          const target = text.slice('gitdir:'.length).trim()
          return resolve(repoRoot, target)
        }
      }
    } catch { /* fall through */ }
    return dotGit
  }

  private statusFingerprint(repoRoot: string): string {
    const gitDir = GitRunner.resolveGitDir(repoRoot)
    const parts: string[] = [String(this.destructiveEnabled())]
    for (const name of ['index', 'HEAD']) {
      try {
        const st = statSync(join(gitDir, name), { bigint: true })
        parts.push(`${st.mtimeNs}:${st.size}:${st.ino}`)
      } catch {
        parts.push('null')
      }
    }
    return parts.join('|')
  }

  private cachedStatus(workspace: string): GitStatus | null {
    const entry = this.statusCache.get(workspace)
    if (!entry) return null
    if (this.now() - entry.storedAt >= STATUS_CACHE_TTL_MS || this.statusFingerprint(entry.repoRoot) !== entry.fingerprint) {
      this.statusCache.delete(workspace)
      return null
    }
    return structuredClone(entry.payload)
  }

  private storeStatus(ctx: GitContext, generation: number, fingerprint: string, payload: GitStatus): void {
    if ((this.generations.get(ctx.repoRoot) ?? 0) !== generation) return
    if (!this.statusCache.has(ctx.workspace) && this.statusCache.size >= STATUS_CACHE_LIMIT) {
      const oldest = this.statusCache.keys().next()
      if (!oldest.done) this.statusCache.delete(oldest.value)
    }
    this.statusCache.set(ctx.workspace, { storedAt: this.now(), repoRoot: ctx.repoRoot, fingerprint, payload: structuredClone(payload) })
  }

  invalidateStatusCache(repoRoot: string): void {
    this.generations.set(repoRoot, (this.generations.get(repoRoot) ?? 0) + 1)
    for (const [key, entry] of this.statusCache) if (entry.repoRoot === repoRoot) this.statusCache.delete(key)
  }

  // ── status ───────────────────────────────────────────────────────────────

  private static statusCode(xy: string, untracked: boolean, renamed: boolean): string {
    if (untracked) return '??'
    if (CONFLICT_CODES.has(xy)) return xy
    if (renamed) return 'R'
    for (const ch of xy) if ('MADRCUT'.includes(ch)) return ch
    return xy.replace(/^\.+|\.+$/g, '') || 'M'
  }

  private parseNumstat(text: string, ctx: GitContext): Stats {
    const stats: Stats = new Map()
    const tokens = text.split('\0')
    let i = 0
    while (i < tokens.length) {
      const record = tokens[i] ?? ''
      i += 1
      if (!record) continue
      const first = record.indexOf('\t')
      const second = first >= 0 ? record.indexOf('\t', first + 1) : -1
      if (first < 0 || second < 0) continue
      const rawAdd = record.slice(0, first)
      const rawDel = record.slice(first + 1, second)
      let rawPath = record.slice(second + 1)
      if (!rawPath) {
        if (i + 1 >= tokens.length) break
        rawPath = tokens[i + 1] ?? ''
        i += 2
      }
      const binary = rawAdd === '-' || rawDel === '-'
      const additions = binary ? 0 : Number.parseInt(rawAdd || '0', 10) || 0
      const deletions = binary ? 0 : Number.parseInt(rawDel || '0', 10) || 0
      const workspacePath = GitRunner.workspaceRel(ctx, rawPath)
      if (workspacePath === null) continue
      stats.set(workspacePath, [additions, deletions, binary])
    }
    return stats
  }

  private async collectNumstat(ctx: GitContext, cached: boolean): Promise<Stats | null> {
    const args = ['diff', '--numstat', '-z', '--no-textconv', '--ignore-cr-at-eol']
    if (cached) args.push('--cached')
    args.push('--', GitRunner.workspacePathspec(ctx))
    const result = await this.run(ctx, args, { disableFilterAttributes: this.destructiveEnabled(), neutralizeFilterPrograms: true })
    if (result.status !== 0) return null
    return this.parseNumstat(result.stdout, ctx)
  }

  /** An untracked file's bytes through the anchored walk (no symlinked component), or null when unreadable/too large. */
  private static readUntracked(workspace: string, path: string): { data: Buffer } | { tooLarge: true } | null {
    let fd: number
    // Python read an untracked symlink through its target; that is kept for links that stay inside the workspace, so
    // a link pointing outside can never pull foreign bytes into a diff.
    let source = path
    try {
      if (lstatSync(path).isSymbolicLink()) {
        const real = realpathSync(path)
        const root = realpathSync(workspace)
        if (real !== root && !isWithin(real, root)) return null
        source = real
      }
    } catch { return null }
    try { fd = openAnchoredFd(workspace, source, { wantDir: false }) } catch { return null }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return null
      if (st.size > DIFF_SIZE_LIMIT) return { tooLarge: true }
      return { data: readFileSync(fd) }
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  private static countUntrackedFile(workspace: string, path: string): [number, number, boolean] {
    const read = GitRunner.readUntracked(workspace, path)
    if (!read || 'tooLarge' in read) return [0, 0, false]
    const data = read.data
    if (data.includes(0)) return [0, 0, true]
    const text = data.toString('utf8')
    if (text.includes('�') && !data.equals(Buffer.from(text, 'utf8'))) return [0, 0, true]
    return [splitLines(text).length || (text ? 1 : 0), 0, false]
  }

  async status(workspace: string, opts: { useCache?: boolean } = {}): Promise<GitStatus> {
    const resolved = resolvePathLikePython(workspace)
    if (opts.useCache) {
      const cached = this.cachedStatus(resolved)
      if (cached) return cached
    }
    const ctx = await this.resolveContext(resolved)
    if (!ctx) return { is_git: false }
    const generation = this.generations.get(ctx.repoRoot) ?? 0
    const result = await this.run(ctx, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', GitRunner.workspacePathspec(ctx)], { check: true, disableFilterAttributes: this.destructiveEnabled(), neutralizeFilterPrograms: true })
    const stagedStats = await this.collectNumstat(ctx, true)
    const unstagedStats = await this.collectNumstat(ctx, false)
    const statSources: Stats[] = [stagedStats ?? new Map<string, [number, number, boolean]>(), unstagedStats ?? new Map<string, [number, number, boolean]>()]
    let branch = ''
    let upstream = ''
    let ahead = 0
    let behind = 0
    const files = new Map<string, GitFile>()
    const noise = { filemode_only: 0, crlf_only: 0 }
    const tokens = result.stdout.split('\0')
    let i = 0
    let truncated = false
    while (i < tokens.length) {
      const rec = tokens[i] ?? ''
      i += 1
      if (!rec) continue
      if (rec.startsWith('# ')) {
        const parts = rec.split(' ')
        const key = parts[1]
        const value = parts.slice(2).join(' ')
        if (key === 'branch.head') branch = value === '(detached)' ? '' : value
        else if (key === 'branch.upstream') upstream = value
        else if (key === 'branch.ab') {
          for (const bit of value.split(/\s+/)) {
            if (bit.startsWith('+') && /^\d+$/.test(bit.slice(1))) ahead = Number.parseInt(bit.slice(1), 10)
            else if (bit.startsWith('-') && /^\d+$/.test(bit.slice(1))) behind = Number.parseInt(bit.slice(1), 10)
          }
        }
        continue
      }
      let oldPath: string | null = null
      let renamed = false
      let modeHead = ''
      let modeIndex = ''
      let modeWorktree = ''
      let xy: string
      let repoPath: string
      let untracked: boolean
      if (rec.startsWith('? ')) {
        xy = '??'
        repoPath = rec.slice(2)
        untracked = true
      } else if (rec.startsWith('1 ')) {
        const parts = rec.split(' ')
        if (parts.length < 9) continue
        xy = parts[1] ?? ''
        modeHead = parts[3] ?? ''
        modeIndex = parts[4] ?? ''
        modeWorktree = parts[5] ?? ''
        repoPath = parts.slice(8).join(' ')
        untracked = false
      } else if (rec.startsWith('2 ')) {
        const parts = rec.split(' ')
        if (parts.length < 10) continue
        xy = parts[1] ?? ''
        modeHead = parts[3] ?? ''
        modeIndex = parts[4] ?? ''
        modeWorktree = parts[5] ?? ''
        repoPath = parts.slice(9).join(' ')
        if (i < tokens.length) {
          oldPath = tokens[i] ?? null
          i += 1
        }
        renamed = true
        untracked = false
      } else if (rec.startsWith('u ')) {
        const parts = rec.split(' ')
        if (parts.length < 11) continue
        xy = parts[1] ?? ''
        repoPath = parts.slice(10).join(' ')
        untracked = false
      } else continue

      const workspacePath = GitRunner.workspaceRel(ctx, repoPath)
      if (workspacePath === null) continue
      const oldWorkspacePath = oldPath ? GitRunner.workspaceRel(ctx, oldPath) : null
      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'
      const conflict = CONFLICT_CODES.has(xy) || rec.startsWith('u ')
      let additions = 0
      let deletions = 0
      let binary = false
      for (const source of statSources) {
        const entry = source.get(workspacePath)
        if (entry) {
          additions += entry[0]
          deletions += entry[1]
          binary = binary || entry[2]
        }
      }
      if (untracked) [additions, deletions, binary] = GitRunner.countUntrackedFile(ctx.workspace, join(ctx.workspace, workspacePath))
      let staged = x !== '.' && x !== '?' && !untracked
      let unstaged = y !== '.' && y !== ' ' && !untracked
      if (staged && stagedStats && !renamed) {
        staged = stagedStats.has(workspacePath) || (oldWorkspacePath !== null && stagedStats.has(oldWorkspacePath))
        if (!staged) noise.crlf_only += 1
      }
      if (unstaged && unstagedStats && !renamed) {
        unstaged = unstagedStats.has(workspacePath) || (oldWorkspacePath !== null && unstagedStats.has(oldWorkspacePath))
        if (!unstaged) noise.crlf_only += 1
      }
      if (!(staged || unstaged || untracked || conflict || renamed)) continue
      if (!(untracked || conflict || renamed || binary) && additions === 0 && deletions === 0) {
        const modeOnly = (staged && modeHead !== modeIndex) || (unstaged && modeIndex !== modeWorktree)
        noise[modeOnly ? 'filemode_only' : 'crlf_only'] += 1
        continue
      }
      files.set(workspacePath, {
        path: workspacePath, old_path: oldWorkspacePath, workspace_path: workspacePath, status: GitRunner.statusCode(xy, untracked, renamed),
        staged, unstaged, untracked, ignored: false, conflict, additions, deletions, binary,
      })
      if (files.size >= STATUS_FILE_LIMIT) {
        truncated = true
        break
      }
    }
    const fileList = [...files.values()].sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0))
    const totals: GitTotals = { changed: fileList.length, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
    for (const item of fileList) {
      if (item.staged) totals.staged += 1
      if (item.unstaged) totals.unstaged += 1
      if (item.untracked) totals.untracked += 1
      if (item.conflict) totals.conflicts += 1
    }
    if (!branch) branch = (await this.run(ctx, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    const payload: GitStatus = {
      is_git: true, branch: branch || 'HEAD', upstream, ahead, behind, totals, files: fileList, truncated,
      noise_filtering: { ...noise, active: noise.filemode_only > 0 || noise.crlf_only > 0 },
    }
    this.storeStatus(ctx, generation, this.statusFingerprint(ctx.repoRoot), payload)
    return payload
  }

  // ── branches ─────────────────────────────────────────────────────────────

  private async branchAheadBehind(ctx: GitContext, branch: string, upstream: string): Promise<[number, number]> {
    if (!upstream) return [0, 0]
    const result = await this.run(ctx, ['rev-list', '--left-right', '--count', `${branch}...${upstream}`])
    if (result.status !== 0) return [0, 0]
    const parts = result.stdout.trim().split(/\s+/)
    if (parts.length !== 2) return [0, 0]
    const a = Number.parseInt(parts[0] ?? '', 10)
    const b = Number.parseInt(parts[1] ?? '', 10)
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : [0, 0]
  }

  private async forEachRef(ctx: GitContext, refPrefix: string): Promise<GitRef[]> {
    const fmt = '%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:unix)%00%(committerdate:relative)%00%(authorname)%00%(subject)'
    const result = await this.run(ctx, ['for-each-ref', `--format=${fmt}`, refPrefix], { check: true })
    const refs: GitRef[] = []
    for (const line of result.stdout.split('\n')) {
      const [fullName = '', name = '', upstream = '', sha = '', updated = '', updatedRelative = '', author = '', subject = ''] = line.split('\0')
      if (!name || fullName.endsWith('/HEAD') || name.endsWith('/HEAD')) continue
      if (refPrefix === 'refs/remotes' && !name.includes('/')) continue
      const item: GitRef = { name, sha, updated: /^\d+$/.test(updated) ? Number.parseInt(updated, 10) : 0, updated_relative: updatedRelative, author, subject, upstream: '', ahead: 0, behind: 0 }
      if (upstream) {
        const [ahead, behind] = await this.branchAheadBehind(ctx, name, upstream)
        Object.assign(item, { upstream, ahead, behind })
      }
      refs.push(item)
    }
    return refs.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0))
  }

  async branches(workspace: string): Promise<GitBranches> {
    const ctx = await this.resolveContext(workspace)
    if (!ctx) throw new GitWorkspaceError('Workspace is not a Git repository', 'not_a_repo')
    const headName = (await this.run(ctx, ['branch', '--show-current'], { check: true })).stdout.trim()
    const headSha = (await this.run(ctx, ['rev-parse', '--short', 'HEAD'], { check: true })).stdout.trim()
    const status = await this.status(workspace)
    return {
      is_git: true, current: headName || headSha || 'HEAD', detached: !headName, head: headSha,
      local: await this.forEachRef(ctx, 'refs/heads'), remote: await this.forEachRef(ctx, 'refs/remotes'),
      upstream: status.upstream ?? '', ahead: status.ahead ?? 0, behind: status.behind ?? 0,
    }
  }

  // ── checkout ─────────────────────────────────────────────────────────────

  private async validateLocalBranch(ctx: GitContext, ref: string): Promise<string> {
    const r = ref.trim()
    if (!r) throw new GitWorkspaceError('Branch name is required', 'invalid_ref')
    await this.run(ctx, ['show-ref', '--verify', `refs/heads/${r}`], { check: true })
    return r
  }

  private async validateRemoteBranch(ctx: GitContext, ref: string): Promise<string> {
    const r = ref.trim()
    if (!r) throw new GitWorkspaceError('Remote branch name is required', 'invalid_ref')
    await this.run(ctx, ['show-ref', '--verify', `refs/remotes/${r}`], { check: true })
    return r
  }

  private async validateCheckoutStart(ctx: GitContext, ref: string): Promise<string> {
    const r = (ref || 'HEAD').trim() || 'HEAD'
    if ((await this.run(ctx, ['rev-parse', '--verify', `${r}^{commit}`])).status !== 0) throw new GitWorkspaceError('Invalid checkout reference', 'invalid_ref')
    return r
  }

  private async validateNewBranchName(ctx: GitContext, name: string): Promise<string> {
    const n = name.trim()
    if (!n) throw new GitWorkspaceError('New branch name is required', 'invalid_ref')
    if ((await this.run(ctx, ['check-ref-format', '--branch', n])).status !== 0) throw new GitWorkspaceError('Invalid branch name', 'invalid_ref')
    if ((await this.run(ctx, ['show-ref', '--verify', `refs/heads/${n}`])).status === 0) throw new GitWorkspaceError('A local branch with that name already exists', 'invalid_ref')
    return n
  }

  private async dirtyWorktree(ctx: GitContext): Promise<boolean> {
    return (await this.run(ctx, ['status', '--porcelain=v2', '--untracked-files=all'], { check: true, neutralizeFilterPrograms: true })).stdout.trim() !== ''
  }

  private async currentCheckoutLabel(ctx: GitContext): Promise<string> {
    const branch = (await this.run(ctx, ['branch', '--show-current'])).stdout.trim()
    if (branch) return branch
    return (await this.run(ctx, ['rev-parse', '--short', 'HEAD'], { check: true })).stdout.trim() || 'HEAD'
  }

  private static stashSubjectParts(subject: string): [string, string] | null {
    const s = subject.trim()
    if (!s.startsWith('On ') || !s.includes(': ')) return null
    const idx = s.indexOf(': ')
    const branch = s.slice(3, idx).trim()
    const message = s.slice(idx + 2).trim()
    if (!branch || !message.startsWith(BRANCH_SWITCH_STASH_PREFIX)) return null
    return [branch, message]
  }

  private async branchSwitchStashes(ctx: GitContext): Promise<{ ref: string; branch: string; message: string }[]> {
    const result = await this.run(ctx, ['stash', 'list', '--format=%gd%x00%gs'])
    if (result.status !== 0) return []
    const out: { ref: string; branch: string; message: string }[] = []
    for (const line of result.stdout.split('\n')) {
      const idx = line.indexOf('\0')
      if (idx < 0) continue
      const parts = GitRunner.stashSubjectParts(line.slice(idx + 1))
      if (!parts) continue
      out.push({ ref: line.slice(0, idx), branch: parts[0], message: parts[1] })
    }
    return out
  }

  private async restoreBranchSwitchStashLocked(ctx: GitContext, branch: string): Promise<Record<string, unknown>> {
    if (this.destructiveEnabled() && await this.hasRepoLocalFilters(ctx.repoRoot)) return { restore_blocked: true, restore_reason: 'Repository defines local filter programs' }
    if (await this.dirtyWorktree(ctx)) return {}
    for (const item of await this.branchSwitchStashes(ctx)) {
      if (item.branch !== branch) continue
      const result = await this.run(ctx, ['stash', 'pop', '--index', item.ref], { destructive: true, disableFilterAttributes: true })
      if (result.status === 0) return { restored_stash: item }
      return { restore_failed: true, restore_error: (result.stderr || result.stdout || 'Git stash restore failed').trim(), restore_stash: item }
    }
    return {}
  }

  private async validateCheckoutRequestLocked(ctx: GitContext, ref: string, mode: string, newBranch: string | null): Promise<void> {
    if (mode === 'local') {
      await this.validateLocalBranch(ctx, ref)
      return
    }
    if (mode === 'new' || mode === 'create') {
      await this.validateNewBranchName(ctx, newBranch || ref)
      await this.validateCheckoutStart(ctx, newBranch && ref && ref !== newBranch ? ref : 'HEAD')
      return
    }
    if (mode === 'remote') {
      const remoteRef = await this.validateRemoteBranch(ctx, ref)
      const branchName = (newBranch || remoteRef.split('/').slice(1).join('/')).trim()
      if ((await this.run(ctx, ['show-ref', '--verify', `refs/heads/${branchName}`])).status !== 0) await this.validateNewBranchName(ctx, branchName)
      return
    }
    if (mode === 'detached' || mode === 'detach') {
      await this.validateCheckoutStart(ctx, ref)
      return
    }
    throw new GitWorkspaceError('Unsupported checkout mode', 'invalid_ref')
  }

  private async performCheckoutLocked(ctx: GitContext, ref: string, mode: string, newBranch: string | null, track: boolean): Promise<GitResult> {
    if (this.destructiveEnabled() && await this.hasRepoLocalFilters(ctx.repoRoot)) {
      throw new GitWorkspaceError('Cannot checkout: repository defines local filter programs that would alter file content', 'filtered_path')
    }
    const destructive = { check: true, destructive: true, disableFilterAttributes: true } as const
    if (mode === 'local') return await this.run(ctx, ['switch', '--recurse-submodules=no', await this.validateLocalBranch(ctx, ref)], destructive)
    if (mode === 'new' || mode === 'create') {
      const branch = await this.validateNewBranchName(ctx, newBranch || ref)
      const startRef = await this.validateCheckoutStart(ctx, newBranch && ref && ref !== newBranch ? ref : 'HEAD')
      return await this.run(ctx, ['switch', '--recurse-submodules=no', '-c', branch, startRef], destructive)
    }
    if (mode === 'remote') {
      const remoteRef = await this.validateRemoteBranch(ctx, ref)
      const branchName = (newBranch || remoteRef.split('/').slice(1).join('/')).trim()
      if ((await this.run(ctx, ['show-ref', '--verify', `refs/heads/${branchName}`])).status === 0) {
        const result = await this.run(ctx, ['switch', '--recurse-submodules=no', branchName], destructive)
        if (track) await this.run(ctx, ['branch', '--set-upstream-to', remoteRef, branchName])
        return result
      }
      const branch = await this.validateNewBranchName(ctx, branchName)
      const args = ['switch', '--recurse-submodules=no', '-c', branch]
      if (track) args.push('--track')
      args.push(remoteRef)
      return await this.run(ctx, args, destructive)
    }
    if (mode === 'detached' || mode === 'detach') return await this.run(ctx, ['switch', '--recurse-submodules=no', '--detach', await this.validateCheckoutStart(ctx, ref)], destructive)
    throw new GitWorkspaceError('Unsupported checkout mode', 'invalid_ref')
  }

  private static remoteMessage(result: GitResult): string {
    return (result.stdout || result.stderr || '').trim()
  }

  async checkout(workspace: string, ref: string, mode: string, opts: { newBranch?: string | null; track?: boolean; dirtyMode?: string } = {}): Promise<Record<string, unknown>> {
    const ctx = await this.resolveContext(workspace)
    if (!ctx) throw new GitWorkspaceError('Workspace is not a Git repository', 'not_a_repo')
    const m = (mode || 'local').trim().toLowerCase()
    const dirtyMode = (opts.dirtyMode || 'block').trim().toLowerCase()
    if (dirtyMode !== 'block') throw new GitWorkspaceError('Only dirty_mode=block is supported for branch checkout', 'dirty_worktree')
    const result = await this.withMutationLock(ctx, async () => {
      await this.validateCheckoutRequestLocked(ctx, ref, m, opts.newBranch ?? null)
      if (await this.dirtyWorktree(ctx)) throw new GitWorkspaceError('Checkout blocked because the Git worktree has uncommitted changes', 'dirty_worktree')
      return await this.performCheckoutLocked(ctx, ref, m, opts.newBranch ?? null, Boolean(opts.track))
    })
    const status = await this.status(workspace)
    const branches = await this.branches(workspace)
    return { ok: true, message: GitRunner.remoteMessage(result), current_branch: branches.current, status, branches }
  }

  async stashAndCheckout(workspace: string, ref: string, mode: string, opts: { newBranch?: string | null; track?: boolean } = {}): Promise<Record<string, unknown>> {
    const ctx = await this.resolveContext(workspace)
    if (!ctx) throw new GitWorkspaceError('Workspace is not a Git repository', 'not_a_repo')
    const m = (mode || 'local').trim().toLowerCase()
    const targetLabel = (opts.newBranch || ref || 'HEAD').trim() || 'HEAD'
    const stashName = `${BRANCH_SWITCH_STASH_PREFIX} to ${targetLabel}`.trim()
    const outcome = await this.withMutationLock(ctx, async () => {
      await this.validateCheckoutRequestLocked(ctx, ref, m, opts.newBranch ?? null)
      if (this.destructiveEnabled() && await this.hasRepoLocalFilters(ctx.repoRoot)) {
        throw new GitWorkspaceError('Cannot stash: repository defines local filter programs that would alter file content', 'filtered_path')
      }
      let stashed = false
      if (await this.dirtyWorktree(ctx)) {
        const stashResult = await this.run(ctx, ['stash', 'push', '-u', '-m', stashName], { check: true, destructive: true, disableFilterAttributes: true })
        stashed = !GitRunner.remoteMessage(stashResult).includes('No local changes to save')
      }
      let result: GitResult
      try {
        result = await this.performCheckoutLocked(ctx, ref, m, opts.newBranch ?? null, Boolean(opts.track))
      } catch (error) {
        if (stashed) await this.run(ctx, ['stash', 'pop', '--index', 'stash@{0}'], { destructive: true, disableFilterAttributes: true })
        throw error
      }
      const restored = await this.restoreBranchSwitchStashLocked(ctx, await this.currentCheckoutLabel(ctx))
      return { result, stashed, restored }
    })
    const status = await this.status(workspace)
    const branches = await this.branches(workspace)
    const { restored } = outcome
    return {
      ok: true, message: GitRunner.remoteMessage(outcome.result), stash_name: outcome.stashed ? stashName : '', stashed: outcome.stashed,
      restored_stash: restored.restored_stash ?? null, restore_failed: Boolean(restored.restore_failed), restore_error: str(restored.restore_error),
      restore_stash: restored.restore_stash ?? null, current_branch: branches.current, status, branches,
    }
  }

  // ── diff ─────────────────────────────────────────────────────────────────

  private static syntheticUntrackedDiff(workspace: string, path: string, label: string): Omit<GitDiff, 'path' | 'kind'> {
    const read = GitRunner.readUntracked(workspace, path)
    if (!read) throw new GitWorkspaceError('Path is not a file')
    if ('tooLarge' in read) return { binary: false, too_large: true, diff: '', additions: 0, deletions: 0 }
    const data = read.data
    const text = data.toString('utf8')
    if (data.includes(0) || (text.includes('�') && !data.equals(Buffer.from(text, 'utf8')))) return { binary: true, too_large: false, diff: '', additions: 0, deletions: 0 }
    const diffLines = unifiedDiffFromEmpty(splitLines(text), `b/${label}`)
    let diff = diffLines.join('\n') + (diffLines.length ? '\n' : '')
    const tooLarge = Buffer.byteLength(diff, 'utf8') > DIFF_SIZE_LIMIT
    if (tooLarge) diff = diff.slice(0, DIFF_SIZE_LIMIT)
    const [additions, deletions] = diffStats(diff)
    return { binary: false, too_large: tooLarge, diff, additions, deletions }
  }

  async diff(workspace: string, path: string, kind = 'unstaged'): Promise<GitDiff> {
    const ctx = await this.resolveContext(workspace)
    if (!ctx) throw new GitWorkspaceError('Workspace is not a Git repository')
    if (kind !== 'unstaged' && kind !== 'staged') throw new GitWorkspaceError('kind must be staged or unstaged')
    const repoRel = GitRunner.repoRel(ctx, path)
    const workspaceRel = GitRunner.workspaceRel(ctx, repoRel) ?? path
    const status = await this.status(workspace)
    const fileState = (status.files ?? []).find((f) => f.path === workspaceRel)
    if (kind === 'unstaged' && fileState?.untracked) return { path: workspaceRel, kind, ...GitRunner.syntheticUntrackedDiff(ctx.workspace, join(ctx.workspace, workspaceRel), workspaceRel) }
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--unified=3']
    if (kind === 'staged') args.push('--cached')
    args.push('--', repoRel)
    let diff = (await this.run(ctx, args, { check: true, neutralizeFilterPrograms: true })).stdout
    const binary = diff.includes('Binary files ') || diff.includes('GIT binary patch')
    const tooLarge = Buffer.byteLength(diff, 'utf8') > DIFF_SIZE_LIMIT
    if (tooLarge) diff = diff.slice(0, DIFF_SIZE_LIMIT)
    const [additions, deletions] = diffStats(diff)
    return { path: workspaceRel, kind, binary, too_large: tooLarge, additions, deletions, diff: binary ? '' : diff }
  }

  // ── stage / unstage / discard ────────────────────────────────────────────

  private static cleanPaths(paths: Iterable<unknown>): string[] {
    const cleaned: string[] = []
    for (const p of paths) {
      const value = str(p).trim()
      if (value && !cleaned.includes(value)) cleaned.push(value)
    }
    if (!cleaned.length) throw new GitWorkspaceError('At least one path is required')
    return cleaned
  }

  private static pathspecs(ctx: GitContext, paths: Iterable<unknown>): string[] {
    return GitRunner.cleanPaths(paths).map((p) => GitRunner.repoRel(ctx, p))
  }

  private async blockFilteredDestructiveWrite(ctx: GitContext, message: string): Promise<void> {
    if (this.destructiveEnabled() && await this.hasRepoLocalFilters(ctx.repoRoot)) throw new GitWorkspaceError(message, 'filtered_path')
  }

  private async requireContext(workspace: string): Promise<GitContext> {
    const ctx = await this.resolveContext(workspace)
    if (!ctx) throw new GitWorkspaceError('Workspace is not a Git repository', 'not_a_repo')
    return ctx
  }

  async stage(workspace: string, paths: Iterable<unknown>): Promise<GitStatus> {
    const ctx = await this.requireContext(workspace)
    await this.withMutationLock(ctx, async () => {
      await this.blockFilteredDestructiveWrite(ctx, 'Repository uses local Git filters; stage may corrupt index content. Use the terminal to stage manually.')
      await this.run(ctx, ['add', '--', ...GitRunner.pathspecs(ctx, paths)], { check: true, destructive: true, disableFilterAttributes: true })
    })
    return await this.status(workspace)
  }

  async unstage(workspace: string, paths: Iterable<unknown>): Promise<GitStatus> {
    const ctx = await this.requireContext(workspace)
    const specs = GitRunner.pathspecs(ctx, paths)
    await this.withMutationLock(ctx, async () => {
      const result = await this.run(ctx, ['restore', '--staged', '--', ...specs], { destructive: true })
      if (result.status !== 0) await this.run(ctx, ['reset', 'HEAD', '--', ...specs], { check: true, destructive: true })
    })
    return await this.status(workspace)
  }

  async discard(workspace: string, paths: Iterable<unknown>, opts: { deleteUntracked?: boolean } = {}): Promise<GitStatus> {
    const ctx = await this.requireContext(workspace)
    await this.withMutationLock(ctx, async () => {
      await this.blockFilteredDestructiveWrite(ctx, 'Repository uses local Git filters; discard may corrupt working-tree content. Use the terminal to discard manually.')
      const status = await this.status(workspace)
      const byPath = new Map((status.files ?? []).map((f) => [f.path, f]))
      for (const path of GitRunner.cleanPaths(paths)) {
        const repoRel = GitRunner.repoRel(ctx, path)
        const workspaceRel = GitRunner.workspaceRel(ctx, repoRel) ?? path
        const state = byPath.get(workspaceRel) ?? byPath.get(`${workspaceRel.replace(/\/+$/, '')}/`)
        if (state?.conflict) throw new GitWorkspaceError('Conflicted files cannot be discarded from this panel', 'conflict')
        if (state?.untracked) {
          if (!opts.deleteUntracked) throw new GitWorkspaceError('Untracked files require delete_untracked=true')
          const target = safeResolveWs(ctx.workspace, workspaceRel)
          let isDir = false
          try { isDir = lstatSync(target).isDirectory() } catch { isDir = false }
          if (isDir) rmtreeAnchored(ctx.workspace, target)
          else {
            try {
              unlinkAnchored(ctx.workspace, target)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          }
          continue
        }
        await this.run(ctx, ['restore', '--worktree', '--', repoRel], { check: true, destructive: true, disableFilterAttributes: true })
      }
    })
    return await this.status(workspace)
  }

  // ── commit messages ──────────────────────────────────────────────────────

  private async stagedDiffText(ctx: GitContext): Promise<[string, boolean]> {
    const diff = (await this.run(ctx, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=3', '--', GitRunner.workspacePathspec(ctx)], { check: true, neutralizeFilterPrograms: true })).stdout
    return GitRunner.capDiff(diff)
  }

  private static capDiff(diff: string): [string, boolean] {
    const encoded = Buffer.from(diff, 'utf8')
    if (encoded.length <= COMMIT_MESSAGE_DIFF_LIMIT) return [diff, false]
    return [encoded.subarray(0, COMMIT_MESSAGE_DIFF_LIMIT).toString('utf8'), true]
  }

  private async selectedTempIndexEnv(ctx: GitContext, specs: string[]): Promise<[Record<string, string>, string]> {
    await this.blockFilteredDestructiveWrite(ctx, 'Repository uses local Git filters; selected commit staging may corrupt index content. Use the terminal to commit manually.')
    const dir = mkdtempSync(join(tmpdir(), 'hermes-webui-git-index-'))
    const indexPath = join(dir, 'index')
    const env = { GIT_INDEX_FILE: indexPath }
    try {
      const head = await this.run(ctx, ['rev-parse', '--verify', 'HEAD'], { env, destructive: true })
      if (head.status === 0) await this.run(ctx, ['read-tree', 'HEAD'], { check: true, env, destructive: true })
      else await this.run(ctx, ['read-tree', '--empty'], { check: true, env, destructive: true })
      await this.run(ctx, ['add', '-A', '--', ...specs], { check: true, env, destructive: true, disableFilterAttributes: true })
      return [env, dir]
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  private async selectedFiles(ctx: GitContext, paths: Iterable<unknown>): Promise<[string[], string[], GitFile[]]> {
    const requested = GitRunner.cleanPaths(paths)
    const requestedSpecs = requested.map((p) => GitRunner.repoRel(ctx, p))
    const workspacePaths = requestedSpecs.map((spec, i) => GitRunner.workspaceRel(ctx, spec) ?? requested[i] ?? spec)
    const status = await this.status(ctx.workspace)
    const byPath = new Map((status.files ?? []).map((f) => [f.path, f]))
    const specs: string[] = []
    const selected: GitFile[] = []
    workspacePaths.forEach((path, i) => {
      const state = byPath.get(path)
      if (!state) return
      if (state.conflict) throw new GitWorkspaceError('Resolve conflicts before committing selected files', 'conflict')
      if (state.staged || state.unstaged || state.untracked) {
        selected.push(state)
        for (const spec of [requestedSpecs[i] ?? '', state.old_path ? GitRunner.repoRel(ctx, state.old_path) : '']) if (spec && !specs.includes(spec)) specs.push(spec)
      }
    })
    if (selected.length !== workspacePaths.length) throw new GitWorkspaceError('Selected paths have no committable changes')
    return [specs, workspacePaths, selected]
  }

  private async selectedDiffText(ctx: GitContext, specs: string[]): Promise<[string, boolean]> {
    const [env, dir] = await this.selectedTempIndexEnv(ctx, specs)
    try {
      return GitRunner.capDiff((await this.run(ctx, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--unified=3', '--', ...specs], { check: true, env, destructive: true, disableFilterAttributes: true })).stdout)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private static fileLines(files: GitFile[], label: string): string[] {
    const lines = files.slice(0, 80).map((item) => `- ${item.status || 'M'} ${item.path} (${item.binary ? 'binary' : `+${item.additions || 0} -${item.deletions || 0}`})`)
    if (files.length > 80) lines.push(`- ... ${files.length - 80} more ${label} file(s)`)
    return lines
  }

  async selectedCommitMessagePrompt(workspace: string, paths: Iterable<unknown>): Promise<CommitMessagePrompt> {
    const ctx = await this.requireContext(workspace)
    const [specs, , selected] = await this.selectedFiles(ctx, paths)
    const [diff, truncated] = await this.selectedDiffText(ctx, specs)
    if (!diff.trim()) throw new GitWorkspaceError('No selected diff is available')
    const status = await this.status(workspace)
    const userPrompt = `Write a commit message for the selected Git diff below.\n\nBranch: ${status.branch || 'HEAD'}\nSelected files (${selected.length}):\n${GitRunner.fileLines(selected, 'selected').join('\n')}${truncated ? '\n\nDiff was truncated for size; summarize only what is visible.\n' : '\n'}\nSelected diff:\n\`\`\`diff\n${diff}\n\`\`\``
    return { system_prompt: COMMIT_MESSAGE_SYSTEM_PROMPT, user_prompt: userPrompt, truncated, status }
  }

  async stagedCommitMessagePrompt(workspace: string): Promise<CommitMessagePrompt> {
    const ctx = await this.resolveContext(workspace)
    if (!ctx) throw new GitWorkspaceError('Workspace is not a Git repository')
    const status = await this.status(workspace)
    if ((status.totals?.staged ?? 0) <= 0) throw new GitWorkspaceError('Stage changes before generating a commit message')
    const [diff, truncated] = await this.stagedDiffText(ctx)
    if (!diff.trim()) throw new GitWorkspaceError('No staged diff is available')
    const stagedFiles = (status.files ?? []).filter((f) => f.staged)
    const userPrompt = `Write a commit message for the staged Git diff below.\n\nBranch: ${status.branch || 'HEAD'}\nStaged files (${stagedFiles.length}):\n${GitRunner.fileLines(stagedFiles, 'staged').join('\n')}${truncated ? '\n\nDiff was truncated for size; summarize only what is visible.\n' : '\n'}\nStaged diff:\n\`\`\`diff\n${diff}\n\`\`\``
    return { system_prompt: COMMIT_MESSAGE_SYSTEM_PROMPT, user_prompt: userPrompt, truncated, status }
  }

  // ── commit / remote ──────────────────────────────────────────────────────

  async commit(workspace: string, message: string): Promise<Record<string, unknown>> {
    const msg = str(message).trim()
    if (!msg) throw new GitWorkspaceError('Commit message is required')
    const ctx = await this.requireContext(workspace)
    // The SHA is read under the lock so a later mutation's HEAD cannot be reported as this commit.
    const sha = await this.withMutationLock(ctx, async () => {
      await this.run(ctx, ['commit', '-m', msg], { timeoutMs: 10_000, check: true, destructive: true, disableFilterAttributes: true })
      return (await this.run(ctx, ['rev-parse', '--short', 'HEAD'], { check: true })).stdout.trim()
    })
    return { ok: true, commit: sha, status: await this.status(workspace) }
  }

  async commitSelected(workspace: string, message: string, paths: Iterable<unknown>): Promise<Record<string, unknown>> {
    const msg = str(message).trim()
    if (!msg) throw new GitWorkspaceError('Commit message is required')
    const ctx = await this.requireContext(workspace)
    const [workspacePaths, sha] = await this.withMutationLock(ctx, async () => {
      const [specs, wsPaths] = await this.selectedFiles(ctx, paths)
      const [env, dir] = await this.selectedTempIndexEnv(ctx, specs)
      try {
        const quiet = await this.run(ctx, ['diff', '--cached', '--quiet', '--no-textconv', '--', ...specs], { env, destructive: true, disableFilterAttributes: true })
        if (quiet.status === 0) throw new GitWorkspaceError('Selected paths have no committable changes')
        await this.run(ctx, ['commit', '-m', msg], { timeoutMs: 10_000, check: true, env, destructive: true, disableFilterAttributes: true })
        await this.run(ctx, ['reset', '-q', 'HEAD', '--', ...specs], { check: true, destructive: true })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      return [wsPaths, (await this.run(ctx, ['rev-parse', '--short', 'HEAD'], { check: true })).stdout.trim()] as const
    })
    return { ok: true, commit: sha, paths: workspacePaths, status: await this.status(workspace) }
  }

  private async branchName(ctx: GitContext): Promise<string> {
    const branch = (await this.run(ctx, ['branch', '--show-current'], { check: true })).stdout.trim()
    if (!branch) throw new GitWorkspaceError('Cannot push from a detached HEAD')
    return branch
  }

  async fetch(workspace: string): Promise<Record<string, unknown>> {
    const ctx = await this.requireContext(workspace)
    const result = await this.withMutationLock(ctx, async () => await this.run(ctx, ['fetch', '--prune', '--no-recurse-submodules'], {
      timeoutMs: GIT_REMOTE_TIMEOUT_MS, check: true, forceDestructiveHardening: true, disableFilterAttributes: this.destructiveEnabled(), neutralizeFilterPrograms: true, neutralizeRemoteHelpers: true,
    }), { holdRepo: false })
    return { ok: true, message: GitRunner.remoteMessage(result), status: await this.status(workspace) }
  }

  async pull(workspace: string): Promise<Record<string, unknown>> {
    const ctx = await this.requireContext(workspace)
    const result = await this.withMutationLock(ctx, async () => {
      await this.blockFilteredDestructiveWrite(ctx, 'Repository uses local Git filters; pull may corrupt working-tree content. Use the terminal to pull manually.')
      return await this.run(ctx, ['pull', '--ff-only', '--no-recurse-submodules'], { timeoutMs: GIT_REMOTE_TIMEOUT_MS, check: true, destructive: true, disableFilterAttributes: true, neutralizeFilterPrograms: true, neutralizeRemoteHelpers: true })
    })
    return { ok: true, message: GitRunner.remoteMessage(result), status: await this.status(workspace) }
  }

  async push(workspace: string): Promise<Record<string, unknown>> {
    const ctx = await this.requireContext(workspace)
    const result = await this.withMutationLock(ctx, async () => {
      const status = await this.status(workspace)
      const args = ['push']
      if (!status.upstream) {
        const branch = await this.branchName(ctx)
        const remotes = (await this.run(ctx, ['remote'], { check: true })).stdout.split(/\s+/).filter(Boolean)
        if (!remotes.includes('origin')) throw new GitWorkspaceError('No upstream branch or origin remote is configured', 'no_upstream')
        args.push('-u', 'origin', branch)
      }
      return await this.run(ctx, args, { timeoutMs: GIT_REMOTE_TIMEOUT_MS, check: true, destructive: true, disableFilterAttributes: true, neutralizeFilterPrograms: true, neutralizeRemoteHelpers: true })
    }, { holdRepo: false })
    return { ok: true, message: GitRunner.remoteMessage(result), status: await this.status(workspace) }
  }
}

export interface CommitMessagePrompt { system_prompt: string; user_prompt: string; truncated: boolean; status: GitStatus }

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `When writing commit messages, PR titles, or PR descriptions:

- Inspect the staged diff before suggesting a commit message.
- Do not use vague subjects like "update", "improve", "refine", "misc changes", "fix stuff", or "various changes".
- For large commits, write a concise subject plus a short body with 2-5 bullets summarizing the main areas changed.
- The subject should describe the actual user-facing result or bug fixed, not just broad implementation activity.
- Keep wording short, clear, and natural.
- Never mention AI, Cursor, Zed, agents, or similar tooling in commits, branch names, PR titles, or PR descriptions.
- Never add your own thoughts or questions into the commit message, the commit message is definitive in nature.

Return only the commit message text. Do not wrap it in Markdown fences.`

export function cleanGeneratedCommitMessage(message: unknown): string {
  let text = str(message).trim()
  if (text.startsWith('```')) {
    let lines = text.split('\n')
    if (lines[0]?.startsWith('```')) lines = lines.slice(1)
    if (lines.length && lines[lines.length - 1]?.trim() === '```') lines = lines.slice(0, -1)
    text = lines.join('\n').trim()
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim()
  return text
}

/** Ensure a git repository exists at `dir` (tests and the worktree helper). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
