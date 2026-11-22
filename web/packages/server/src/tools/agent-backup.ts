/**
 * TAL-2661: the owner's full native Agent-home backup. The sidecar runs the Agent's own `hermes backup` (lock, SQLite
 * snapshots, owner-only atomic staging) into a private directory this module owns; the server streams the archive and
 * deletes it after `AGENT_BACKUP_RETENTION_S`, on discard, before the next backup, or at the next start.
 *
 * State owner: one in-memory job at a time. Its directory is released on every exit: success (after retention or
 * discard), failure, cancellation and a server restart (the start sweep).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { AgentBackupJob, AgentBackupStatus } from '@maudecode/talaria-web-contracts'
import type { SidecarLike } from '../sidecar/client.js'
import type { RequestContext } from '../http/context.js'
import { activeProfileName } from '../auth/gate.js'

export const AGENT_BACKUP_RETENTION_S = 3600
/** A backup still running after this long is stopped and reported as failed. */
const AGENT_BACKUP_TIMEOUT_MS = 2 * 3600_000

export class AgentBackupRunning extends Error {}

/**
 * Why this request may not back up the Agent home, or null. The native command archives the whole Agent root, so a
 * named profile or a server pinned to one profile is refused rather than given every profile. Owner authority is the
 * gate's (`OPERATOR_ONLY_PREFIXES`).
 */
export function agentBackupRefusal(ctx: RequestContext): AgentBackupStatus['unavailable_reason'] {
  if (ctx.deps.isolatedProfileMode()) return 'isolated_profile'
  if (!ctx.deps.isRootProfile(activeProfileName(ctx))) return 'named_profile'
  return ctx.deps.sidecar() ? null : 'agent_unavailable'
}

export function agentBackupStatus(ctx: RequestContext): AgentBackupStatus {
  const reason = agentBackupRefusal(ctx)
  const profile = activeProfileName(ctx)
  return {
    scope: 'agent_home', available: reason === null, unavailable_reason: reason, server: hostname(),
    profile: ctx.deps.isRootProfile(profile) ? profile : 'default', retention_seconds: AGENT_BACKUP_RETENTION_S,
    job: reason === 'named_profile' || reason === 'isolated_profile' ? null : ctx.deps.agentBackups.current(),
  }
}

interface Job extends AgentBackupJob { dir: string; path: string; abort: AbortController; expiry?: NodeJS.Timeout }

export interface AgentBackupDeps {
  /** The private root this module owns, under the Web state directory. */
  dir: string
  sidecar: () => SidecarLike | null
  log: (line: string) => void
  redact: (text: string) => string
  now?: () => number
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')

export class AgentBackups {
  private job: Job | null = null
  private readonly now: () => number

  constructor(private readonly deps: AgentBackupDeps) {
    this.now = deps.now ?? Date.now
    // Whatever a previous process left (a finished archive, a run cut off by a restart) has no owner any more.
    rmSync(deps.dir, { recursive: true, force: true })
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
  }

  current(): AgentBackupJob | null {
    const job = this.job
    if (job?.expires_at !== null && job?.expires_at !== undefined && job.expires_at * 1000 <= this.now()) this.release(job)
    return this.job ? view(this.job) : null
  }

  /** Start a backup of the root Agent home at `rootHome`; the run continues after the request that started it. */
  start(rootHome: string): AgentBackupJob {
    if (this.job?.state === 'running') throw new AgentBackupRunning('An Agent-home backup is already running.')
    if (this.job) this.release(this.job)
    const id = randomBytes(16).toString('hex')
    const dir = join(this.deps.dir, id)
    mkdirSync(dir, { mode: 0o700 })
    const startedMs = this.now()
    const fileName = `hermes-agent-home-${stamp(startedMs)}.zip`
    const job: Job = {
      id, state: 'running', phase: 'starting', completed: null, total: null, started_at: startedMs / 1000, finished_at: null, complete: null,
      file_name: null, size_bytes: null, download_url: null, expires_at: null, error: null, dir, path: join(dir, fileName), abort: new AbortController(),
    }
    this.job = job
    const started = view(job)
    void this.run(job, rootHome, fileName)
    return started
  }

  /** Cancel a running backup or delete a finished one; an unknown id changes nothing. */
  discard(id: string): void {
    const job = this.job
    if (job?.id !== id) return
    if (job.state === 'running') {
      job.abort.abort()
      Object.assign(job, { state: 'cancelled', phase: null, finished_at: this.now() / 1000 })
      rmSync(job.dir, { recursive: true, force: true })
      return
    }
    this.release(job)
  }

  /** The ready archive `id` names: its private directory and file. */
  archive(id: string): { dir: string; path: string; name: string } | null {
    this.current()
    const job = this.job
    return job?.id === id && job.state === 'ready' && job.file_name ? { dir: job.dir, path: job.path, name: job.file_name } : null
  }

  close(): void {
    if (this.job) this.release(this.job)
  }

  private release(job: Job): void {
    job.abort.abort()
    if (job.expiry) clearTimeout(job.expiry)
    rmSync(job.dir, { recursive: true, force: true })
    if (this.job === job) this.job = null
  }

  private async run(job: Job, rootHome: string, fileName: string): Promise<void> {
    const finish = (fields: Partial<AgentBackupJob>) => { if (job.state === 'running') Object.assign(job, { phase: null, finished_at: this.now() / 1000, ...fields }) }
    const fail = (error: string) => {
      finish({ state: 'failed', error: this.deps.redact(error) })
      rmSync(job.dir, { recursive: true, force: true })
    }
    const sidecar = this.deps.sidecar()
    if (!sidecar) { fail('Hermes Agent sidecar is not running.'); return }
    try {
      const result = await sidecar.call('backup.create', { profile_home: rootHome, scope: 'agent_home', output: job.path }, {
        signal: job.abort.signal, timeoutMs: AGENT_BACKUP_TIMEOUT_MS,
        onStream: (frame) => {
          if (job.state !== 'running' || frame.event !== 'progress') return
          const data = frame.data as { phase: 'scanning' | 'archiving'; completed?: number; total?: number }
          Object.assign(job, { phase: data.phase, completed: data.completed ?? null, total: data.total ?? null })
        },
      })
      if (job.state !== 'running') return
      if (result.status === 'completed' || result.status === 'incomplete') {
        finish({ state: 'ready', complete: result.status === 'completed', file_name: fileName, size_bytes: result.size_bytes ?? null,
          download_url: `api/agent-backup/download?id=${job.id}`, expires_at: this.now() / 1000 + AGENT_BACKUP_RETENTION_S })
        job.expiry = setTimeout(() => { if (this.job === job) this.release(job) }, AGENT_BACKUP_RETENTION_S * 1000)
        job.expiry.unref()
        return
      }
      fail(result.status === 'busy' ? 'Another Hermes backup is already running.' : result.status === 'cancelled' ? 'The backup was cancelled.' : result.reason ?? 'The Agent could not create the backup.')
    } catch (error) {
      if (job.state !== 'running') return
      this.deps.log(`[agent-backup] backup ${job.id} failed: ${(error as Error).message}`)
      fail((error as Error).message || 'The Agent could not create the backup.')
    }
  }
}

function view(job: Job): AgentBackupJob {
  const { dir: _dir, path: _path, abort: _abort, expiry: _expiry, ...fields } = job
  return fields
}
