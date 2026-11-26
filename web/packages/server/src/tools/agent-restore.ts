import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { AGENT_RESTORE_UPLOAD_LIMIT, AgentRestoreJobSchema, AgentRestoreOutcomeSchema, type AgentRestoreJob, type AgentRestoreStatus } from '@maudecode/talaria-web-contracts'
import { HttpError } from '../api/router.js'
import { atomicWriteSecretJson, writeFullyAsync } from '../fs/atomic.js'
import type { RequestContext } from '../http/context.js'
import type { SidecarLike } from '../sidecar/client.js'
import { agentBackupRefusal } from './agent-backup.js'

const INCOMING = 'incoming.zip'
const RECOVERY = 'recovery.zip'
const OWNER_ONLY = 'Only the root profile can restore the Agent home.'

export function assertAgentRestoreScope(ctx: RequestContext): void {
  const reason = agentBackupRefusal(ctx)
  if (reason === 'named_profile' || reason === 'isolated_profile') throw new HttpError(403, OWNER_ONLY)
}

/** The durable receipt owns the only staged archive and the most recent recovery snapshot. */
export class AgentRestores {
  private job: AgentRestoreJob | null = null
  private uploading = false

  private readonly dir: string

  constructor(private readonly stateDir: string, private readonly sidecar: () => SidecarLike | null, private readonly workActive: () => boolean) {
    // Hermes excludes .cache trees from native backups, including the upload and private staging.
    const dir = this.dir = join(stateDir, '.cache', 'agent-restores')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      this.job = AgentRestoreJobSchema.parse(JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.job?.state === 'running') this.save({ ...this.job, state: this.nativeOutcome(this.job.id) })
    for (const entry of readdirSync(dir)) {
      if (/^[a-f0-9]{32}$/.test(entry) && entry !== this.job?.id) rmSync(join(dir, entry), { recursive: true, force: true })
    }
  }

  blocksNewWork(): boolean { return this.job?.state === 'running' }

  async status(): Promise<AgentRestoreStatus> {
    const available = await this.available()
    let job = this.job
    if (job?.state === 'unknown') {
      const outcome = this.nativeOutcome(job.id)
      if (outcome !== 'unknown') {
        job = { ...job, state: outcome }
        this.save(job)
        rmSync(join(this.dir, job.id, INCOMING), { force: true })
      }
    }
    return { available, can_upload: available && !this.uploading && job?.state !== 'running',
      server: hostname(), profile: 'default',
      job: job && { ...job, recovery_url: this.archive(job.id) ? `api/agent-backup/recovery?id=${job.id}` : null,
        can_confirm: available && !this.uploading && job.state === 'staged' } }
  }

  async stage(body: AsyncIterable<Buffer>, fileName: string): Promise<AgentRestoreStatus> {
    if (!await this.available()) throw new HttpError(409, 'Agent-home restore is unavailable.')
    if (this.uploading || this.job?.state === 'running') throw new HttpError(409, 'Another restore is in progress.')
    this.uploading = true
    const id = randomBytes(16).toString('hex')
    const folder = join(this.dir, id)
    try {
      mkdirSync(folder, { mode: 0o700 })
      const file = await open(join(folder, INCOMING), 'wx', 0o600)
      try {
        let bytes = 0
        for await (const chunk of body) {
          bytes += chunk.length
          if (bytes > AGENT_RESTORE_UPLOAD_LIMIT) throw new HttpError(413, 'Restore archive is too large.')
          await writeFullyAsync(file, chunk)
        }
        if (!bytes) throw new HttpError(400, 'Restore archive is empty.')
        await file.sync()
      } finally {
        await file.close()
      }
      const previous = this.job
      this.save({ id, file_name: fileName, state: 'staged', can_confirm: false, recovery_url: null })
      if (previous) rmSync(join(this.dir, previous.id), { recursive: true, force: true })
    } catch (error) {
      if (this.job?.id !== id) rmSync(folder, { recursive: true, force: true })
      throw error
    } finally {
      this.uploading = false
    }
    return this.status()
  }

  async confirm(id: string, home: string): Promise<AgentRestoreStatus> {
    const job = this.job
    if (!job || job.id !== id) throw new HttpError(404, 'Restore archive is no longer staged.')
    if (job.state !== 'staged') return this.status()
    if (this.uploading) throw new HttpError(409, 'Another restore archive is uploading.')
    const sidecar = this.sidecar()
    if (!sidecar) throw new HttpError(409, 'Agent-home restore is unavailable.')
    if (this.workActive()) throw new HttpError(409, 'Finish active Web work before restoring the Agent home.')
    this.save({ ...job, state: 'running' })
    void this.run(sidecar, job, home)
    return this.status()
  }

  archive(id: string): { dir: string; path: string; name: string } | null {
    if (!this.job || this.job.id !== id || !['restored', 'partial', 'unknown'].includes(this.job.state)) return null
    const dir = join(this.dir, id)
    const path = join(dir, RECOVERY)
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) return null
    } catch { return null }
    return { dir, path, name: 'hermes-pre-restore-backup.zip' }
  }

  private async available(): Promise<boolean> {
    try {
      return (await this.sidecar()?.call('backup.restore_available', {}, { timeoutMs: 5000 }))?.available === true
    } catch { return false }
  }

  private nativeOutcome(id: string): AgentRestoreJob['state'] {
    try {
      const result = JSON.parse(readFileSync(join(this.dir, id, 'result.json'), 'utf8')) as { status?: unknown }
      return AgentRestoreOutcomeSchema.parse(result.status)
    } catch { return 'unknown' }
  }

  private save(job: AgentRestoreJob): void {
    atomicWriteSecretJson(join(this.dir, 'receipt.json'), job)
    this.job = job
  }

  private async run(sidecar: SidecarLike, job: AgentRestoreJob, home: string): Promise<void> {
    const dir = join(this.dir, job.id)
    const input = join(dir, INCOMING)
    let state: AgentRestoreJob['state'] = 'unknown'
    try {
      const result = await sidecar.call('backup.restore', { profile_home: home, scope: 'agent_home', input, output: join(dir, RECOVERY), state_dir: this.stateDir }, { timeoutMs: 2 * 3600_000 })
      state = result.status
    } catch { /* Lost reply: only an explicit native outcome can settle the action. */ }
    try {
      this.save({ ...job, state })
      if (state !== 'unknown') rmSync(input, { force: true })
    } catch {
      // A receipt left running on disk reconciles to unknown at restart.
      this.job = { ...job, state: 'unknown' }
    }
  }
}
