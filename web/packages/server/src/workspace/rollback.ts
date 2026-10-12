/**
 * Workspace checkpoint (rollback) API. The Agent keeps every project's checkpoints as refs in one shared git store under
 * the profile home; listing, diffing and restoring go through its own `CheckpointManager` in the sidecar
 * (`checkpoints.*`, TAL-913), and this store maps the answers onto the route contract.
 */
import { realpathSync, statSync } from 'node:fs'
import { SidecarError, type SidecarLike } from '../sidecar/client.js'
import { GitWorkspaceError } from './git.js'
import { str } from '../util.js'

const CHECKPOINT_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/
export const CHECKPOINT_STORE_BUSY_MESSAGE = 'Checkpoints are being restored or compared. Retry when that finishes.'

export interface RollbackDeps {
  sidecar: () => SidecarLike | null
  profileHome: () => string
  knownWorkspaces: () => string[]
  /** Whether a run in the profile at this home is active: its turn may be capturing a checkpoint into the same store. */
  activeRunInProfile: (profileHome: string) => boolean
}

export interface CheckpointFile { file: string; status: 'modified' | 'added' | 'deleted' }

export function validateCheckpointId(checkpoint: unknown): string {
  const cid = str(checkpoint).trim()
  if (!cid || cid === '.' || cid === '..' || !CHECKPOINT_ID_RE.test(cid)) throw new Error('checkpoint id must match [A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}')
  return cid
}

export class RollbackStore {
  /** Profile homes whose checkpoint store a diff or restore is using, with the number of holders. */
  private readonly busyStores = new Map<string, number>()

  constructor(readonly deps: RollbackDeps) {}

  /** Whether a diff or restore is using the checkpoint store at `profileHome`; no turn in that profile starts meanwhile. */
  storeBusy(profileHome: string): boolean {
    return (this.busyStores.get(profileHome) ?? 0) > 0
  }

  /**
   * Run `fn` with the profile's checkpoint store to itself. The Agent keeps one store per profile and its store lock does
   * not wait, so a turn capturing a checkpoint anywhere in the profile meanwhile would skip it. Refused while a run in the
   * profile is active; the check and the hold happen in the same tick, and turn admission refuses while the hold lasts.
   */
  private async exclusive<T>(fn: (profileHome: string) => Promise<T>): Promise<T> {
    const home = this.deps.profileHome()
    if (this.deps.activeRunInProfile(home)) throw new GitWorkspaceError('A session run is active in this profile. Wait for it to finish before comparing or restoring checkpoints.', 'active_stream')
    this.busyStores.set(home, (this.busyStores.get(home) ?? 0) + 1)
    try {
      return await fn(home)
    } finally {
      const left = (this.busyStores.get(home) ?? 1) - 1
      if (left > 0) this.busyStores.set(home, left)
      else this.busyStores.delete(home)
    }
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

  private sidecar(): SidecarLike {
    const sidecar = this.deps.sidecar()
    if (!sidecar) throw new SidecarError('Hermes Agent sidecar is unavailable', { condition: 'sidecar_unavailable' })
    return sidecar
  }

  async list(workspace: unknown, allowed: string[] = []): Promise<Record<string, unknown>> {
    const resolved = this.resolveWorkspace(workspace, allowed)
    const { checkpoints, store } = await this.sidecar().call('checkpoints.list', { profile_home: this.deps.profileHome(), workspace: resolved })
    return {
      checkpoints: checkpoints.map((c) => ({ id: c.hash, commit: c.short_hash, message: c.reason, date: c.timestamp, date_display: formatLocalMinute(c.timestamp), files: c.files_changed, path: store })),
      workspace: resolved,
      checkpoint_dir: store,
    }
  }

  async diff(workspace: unknown, checkpoint: unknown, allowed: string[] = []): Promise<Record<string, unknown>> {
    const resolved = this.resolveWorkspace(workspace, allowed)
    const cid = validateCheckpointId(checkpoint)
    const sidecar = this.sidecar()
    const { diff } = await this.exclusive((home) => sidecar.call('checkpoints.diff', { profile_home: home, workspace: resolved, checkpoint: cid }))
    const filesChanged = checkpointDiffFiles(diff)
    return { checkpoint: cid, workspace: resolved, diff: diff.trimEnd(), files_changed: filesChanged, total_changes: filesChanged.length }
  }

  /** The Agent snapshots the workspace first, then checks the checkpoint out over it; a file added since is left in place. */
  async restore(workspace: unknown, checkpoint: unknown, allowed: string[] = []): Promise<Record<string, unknown>> {
    const resolved = this.resolveWorkspace(workspace, allowed)
    const cid = validateCheckpointId(checkpoint)
    const sidecar = this.sidecar()
    const rewritten = await this.exclusive(async (home) => {
      const target = { profile_home: home, workspace: resolved, checkpoint: cid }
      const files = checkpointDiffFiles((await sidecar.call('checkpoints.diff', target)).diff).filter((f) => f.status !== 'added').map((f) => f.file)
      await sidecar.call('checkpoints.restore', target)
      return files
    })
    return { ok: true, checkpoint: cid, workspace: resolved, files_restored: rewritten, files_restored_count: rewritten.length, errors: [] }
  }
}

/**
 * The files a checkpoint diff touches, in order. The diff is `git diff <checkpoint> --cached` in the Agent's store, so
 * `a/` is the checkpoint and `b/` the workspace: a file only in the workspace is `added`, one only in the checkpoint is
 * `deleted`, and a rename is both. Paths with unusual bytes arrive C-quoted (`core.quotePath`).
 */
export function checkpointDiffFiles(diff: string): CheckpointFile[] {
  const files: CheckpointFile[] = []
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const lines = section.split('\n')
    const header = lines[0] ?? ''
    if (!header.startsWith('diff --git ')) continue
    let from: string | null = null
    let to: string | null = null
    let renameFrom: string | null = null
    let renameTo: string | null = null
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) break
      if (line.startsWith('rename from ')) renameFrom = gitPath(line.slice(12))
      else if (line.startsWith('rename to ')) renameTo = gitPath(line.slice(10))
      else if (line.startsWith('--- ')) from = line === '--- /dev/null' ? '' : stripPrefix(gitPath(line.slice(4)), 'a/')
      else if (line.startsWith('+++ ')) to = line === '+++ /dev/null' ? '' : stripPrefix(gitPath(line.slice(4)), 'b/')
      else if (line.startsWith('new file mode')) from = ''
      else if (line.startsWith('deleted file mode')) to = ''
    }
    if (renameFrom !== null && renameTo !== null) {
      files.push({ file: renameFrom, status: 'deleted' }, { file: renameTo, status: 'added' })
      continue
    }
    // A binary or mode-only change has no `---`/`+++` lines: the header names the one path twice.
    const same = headerPath(header.slice('diff --git '.length))
    from ??= same
    to ??= same
    if (from === '' && to) files.push({ file: to, status: 'added' })
    else if (to === '' && from) files.push({ file: from, status: 'deleted' })
    else if (to) files.push({ file: to, status: 'modified' })
  }
  return files
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** `a/<p> b/<p>`, each side C-quoted when needed: the path both sides name, or null when they differ. */
function headerPath(rest: string): string | null {
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest)
    const a = gitPath(rest.slice(0, end + 1))
    const b = gitPath(rest.slice(end + 2))
    return a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2) ? a.slice(2) : null
  }
  const half = (rest.length - 1) / 2
  const a = rest.slice(0, half)
  const b = rest.slice(half + 1)
  return Number.isInteger(half) && a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2) ? a.slice(2) : null
}

function quotedEnd(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1
    else if (text[i] === '"') return i
  }
  return text.length - 1
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/** Git's C-quoted path (`"caf\303\251.txt"`) as text; an unquoted path is returned as is. */
function gitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  const bytes: number[] = []
  const body = raw.slice(1, -1)
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? ''
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = body[i + 1] ?? ''
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1))
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8))
      i += 3
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Python `datetime.strftime('%Y-%m-%d %H:%M')` on the parsed ISO timestamp (keeps its offset). */
function formatLocalMinute(iso: string): string {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return iso
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
