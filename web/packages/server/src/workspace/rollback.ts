/**
 * Filesystem checkpoint (rollback) API (Python `api/rollback.py`).
 *
 * Checkpoints live at `<hermes_home>/checkpoints/<hash>/<id>/` as shadow git
 * repositories created by the Agent's CheckpointManager.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, fchmodSync, fstatSync, lstatSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { openAnchoredCreateFd, openAnchoredFd, openAnchoredWriteFd, safeResolveWs } from './fs.js'
import { unifiedDiff } from '../text/diff.js'
import { str } from '../util.js'

const CHECKPOINT_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/
const S_IFMT = 0o170000
const S_IFREG = 0o100000

export interface RollbackDeps {
  hermesHome: () => string
  knownWorkspaces: () => string[]
}

export function validateCheckpointId(checkpoint: unknown): string {
  const cid = str(checkpoint).trim()
  if (!cid || cid === '.' || cid === '..' || !CHECKPOINT_ID_RE.test(cid)) throw new Error('checkpoint id must match [A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}')
  return cid
}

/** SHA-256 of the canonical workspace path, first 12 hex chars (matches the Agent's CheckpointManager). */
export function workspaceHash(workspace: string): string {
  let canonical = workspace
  try { canonical = realpathSync(workspace) } catch { canonical = workspace }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/** A git invocation that did not run to completion (timeout, missing binary): Python let these escape as 500s. */
export class RollbackInternalError extends Error {}

function git(args: string[], timeoutMs = 10_000): { status: number; stdout: Buffer } {
  const r = spawnSync('git', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') throw new RollbackInternalError(`Command '${JSON.stringify(['git', ...args]).replaceAll('"', "'").replaceAll(',', ', ')}' timed out after ${String(timeoutMs / 1000)} seconds`)
    throw new RollbackInternalError(r.error.message)
  }
  return { status: r.status ?? 1, stdout: r.stdout }
}

export class RollbackStore {
  constructor(readonly deps: RollbackDeps) {}

  private root(): string {
    return join(this.deps.hermesHome(), 'checkpoints')
  }

  /** `allowed` adds paths the caller already vouches for (a session's own workspace) to the configured list. */
  resolveWorkspace(workspace: unknown, allowed: string[] = []): string {
    if (!workspace || typeof workspace !== 'string') throw new Error('workspace is required')
    let resolved: string
    try {
      resolved = realpathSync(workspace)
    } catch {
      throw new Error(`Workspace does not exist: ${workspace}`)
    }
    let isDir = false
    try { isDir = statSync(resolved).isDirectory() } catch { isDir = false }
    if (!isDir) throw new Error(`Workspace does not exist: ${workspace}`)
    const known = new Set<string>()
    for (const p of [...this.deps.knownWorkspaces(), ...allowed]) {
      try { known.add(realpathSync(p)) } catch { known.add(p) }
    }
    if (!known.has(resolved)) throw new Error(`Workspace not in configured list: ${workspace}`)
    return resolved
  }

  private static entryModes(ckptDir: string): Map<string, number> {
    const result = git(['-C', ckptDir, 'ls-files', '-s'])
    if (result.status !== 0) throw new Error('Failed to list checkpoint files')
    const modes = new Map<string, number>()
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+(\S+)\t(.+)$/.exec(line) ?? /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line)
      if (!m) continue
      const mode = Number.parseInt(m[1] ?? '', 8)
      if (Number.isFinite(mode) && m[4]) modes.set(m[4], mode)
    }
    return modes
  }

  private static isRegular(modes: Map<string, number>, relPath: string): boolean {
    const mode = modes.get(relPath)
    return mode !== undefined && (mode & S_IFMT) === S_IFREG
  }

  private static readBlob(ckptDir: string, relPath: string): Buffer | null {
    const result = git(['-C', ckptDir, 'show', `HEAD:${relPath}`])
    return result.status === 0 ? result.stdout : null
  }

  private static readWorkspaceText(workspaceRoot: string, relPath: string): string | null {
    let target: string
    try {
      target = safeResolveWs(workspaceRoot, relPath)
    } catch {
      return null
    }
    try {
      if (!lstatSync(target).isFile()) return null
    } catch {
      return null
    }
    let fd: number
    try {
      fd = openAnchoredFd(workspaceRoot, target, { wantDir: false })
    } catch {
      return null
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return null
      const chunks: Buffer[] = []
      const buf = Buffer.alloc(1024 * 1024)
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null)
        if (n <= 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
      }
      return Buffer.concat(chunks).toString('utf8')
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  list(workspace: unknown, allowed: string[] = []): Record<string, unknown> {
    const resolved = this.resolveWorkspace(workspace, allowed)
    const ckptDir = join(this.root(), workspaceHash(resolved))
    const checkpoints: Record<string, unknown>[] = []
    let isDir = false
    try { isDir = statSync(ckptDir).isDirectory() } catch { isDir = false }
    if (!isDir) return { checkpoints: [], workspace: resolved, checkpoint_dir: ckptDir }
    const entries = readdirSync(ckptDir).map((name) => {
      const p = join(ckptDir, name)
      let mtime = 0
      let dir = false
      try {
        const st = statSync(p)
        dir = st.isDirectory()
        mtime = dir ? st.mtimeMs : 0
      } catch { dir = false }
      return { p, mtime, dir }
    }).sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries) {
      if (!entry.dir) continue
      const info = RollbackStore.inspect(entry.p)
      if (info) checkpoints.push(info)
    }
    return { checkpoints, workspace: resolved, checkpoint_dir: ckptDir }
  }

  private static inspect(ckptPath: string): Record<string, unknown> | null {
    try {
      if (!statSync(join(ckptPath, '.git')).isDirectory()) return null
    } catch {
      return null
    }
    const name = basename(ckptPath)
    const result = git(['-C', ckptPath, 'log', '--format=%H%n%s%n%aI', '-1'], 5_000)
    const text = result.stdout.toString('utf8').trim()
    if (result.status !== 0 || !text) return null
    const lines = text.split('\n')
    const commitHash = lines[0] ?? name
    const message = lines[1] ?? 'checkpoint'
    const dateStr = lines[2] ?? ''
    let dateDisplay = ''
    if (dateStr) {
      const d = new Date(dateStr)
      dateDisplay = Number.isNaN(d.getTime()) ? dateStr : formatLocalMinute(d, dateStr)
    }
    const files = git(['-C', ckptPath, 'ls-files'], 5_000).stdout.toString('utf8').trim()
    return { id: name, commit: commitHash.slice(0, 12), message, date: dateStr, date_display: dateDisplay, files: files ? files.split('\n').length : 0, path: ckptPath }
  }

  diff(workspace: unknown, checkpoint: unknown, allowed: string[] = []): Record<string, unknown> {
    const resolved = this.resolveWorkspace(workspace, allowed)
    const cid = validateCheckpointId(checkpoint)
    const ckptDir = join(this.root(), workspaceHash(resolved), cid)
    let isDir = false
    try { isDir = statSync(ckptDir).isDirectory() } catch { isDir = false }
    if (!isDir) throw new Error(`Checkpoint not found: ${cid}`)
    const modes = RollbackStore.entryModes(ckptDir)
    const filesChanged: { file: string; status: string }[] = []
    const diffLines: string[] = []
    for (const relPath of modes.keys()) {
      if (!RollbackStore.isRegular(modes, relPath)) continue
      const blob = RollbackStore.readBlob(ckptDir, relPath)
      if (blob === null) continue
      const ckptContent = blob.toString('utf8')
      const wsContent = RollbackStore.readWorkspaceText(resolved, relPath)
      if (wsContent === null) {
        filesChanged.push({ file: relPath, status: 'deleted' })
        const lines = splitLinesPy(ckptContent)
        diffLines.push(`--- a/${relPath}`, '+++ /dev/null', `@@ -1,${lines.length} +0,0 @@`)
        for (const line of lines) diffLines.push(`-${line}`)
      } else if (ckptContent !== wsContent) {
        const diff = unifiedDiff(splitKeepEnds(ckptContent), splitKeepEnds(wsContent), `a/${relPath}`, `b/${relPath}`)
        if (diff.length) {
          filesChanged.push({ file: relPath, status: 'modified' })
          // difflib keeps each line's own ending; drop it so the '\n' join below yields one line per diff line.
          diffLines.push(...diff.map((line) => line.replace(LINE_END, '')))
        }
      }
    }
    return { checkpoint: cid, workspace: resolved, diff: diffLines.length ? diffLines.join('\n') : '', files_changed: filesChanged, total_changes: filesChanged.length }
  }

  restore(workspace: unknown, checkpoint: unknown, allowed: string[] = []): Record<string, unknown> {
    const resolved = this.resolveWorkspace(workspace, allowed)
    const cid = validateCheckpointId(checkpoint)
    const ckptDir = join(this.root(), workspaceHash(resolved), cid)
    let isDir = false
    try { isDir = statSync(ckptDir).isDirectory() } catch { isDir = false }
    if (!isDir) throw new Error(`Checkpoint not found: ${cid}`)
    const modes = RollbackStore.entryModes(ckptDir)
    const restored: string[] = []
    const errors: { file: string; error: string }[] = []
    for (const [relPath, mode] of modes) {
      if ((mode & S_IFMT) !== S_IFREG) continue
      const content = RollbackStore.readBlob(ckptDir, relPath)
      if (content === null) continue
      try {
        const target = safeResolveWs(resolved, relPath)
        const fd = existsSync(target) ? openAnchoredWriteFd(resolved, target) : openAnchoredCreateFd(resolved, target)
        try {
          writeFully(fd, content)
          try { fchmodSync(fd, mode & 0o777) } catch { /* best effort */ }
        } finally {
          closeSync(fd)
        }
        restored.push(relPath)
      } catch (error) {
        errors.push({ file: relPath, error: (error as Error).message })
      }
    }
    return { ok: true, checkpoint: cid, workspace: resolved, files_restored: restored, files_restored_count: restored.length, errors }
  }
}

/** Python `str.splitlines()`: also breaks on \v, \f, \x1c-\x1e, \x85, \u2028 and \u2029. */
export const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/
const LINE_END = new RegExp(`(?:${PY_LINE_BREAK.source})$`)
export function splitLinesPy(text: string): string[] {
  const lines = text.split(PY_LINE_BREAK)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Python `str.splitlines(keepends=True)`. */
export function splitKeepEnds(text: string): string[] {
  const out: string[] = []
  const re = /[^\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') break
    out.push(m[0])
    if (m.index + m[0].length >= text.length) break
  }
  return out
}

/** Python `datetime.strftime('%Y-%m-%d %H:%M')` on the parsed ISO timestamp (keeps its offset). */
function formatLocalMinute(d: Date, iso: string): string {
  const offset = /([+-]\d{2}):?(\d{2})$/.exec(iso)
  let shifted = d
  if (offset) {
    const minutes = Number.parseInt(offset[1] ?? '0', 10) * 60 + Math.sign(Number.parseInt(offset[1] ?? '0', 10) || 1) * Number.parseInt(offset[2] ?? '0', 10)
    shifted = new Date(d.getTime() + minutes * 60_000)
  } else if (iso.endsWith('Z')) shifted = d
  else return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

const pad = (n: number): string => String(n).padStart(2, '0')
