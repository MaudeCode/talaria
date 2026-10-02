/** Cron jobs across profiles through the sidecar `cron.*` namespace (Python `api/routes.py` cron section). */
import { join } from 'node:path'
import type { CronRecentCompletion } from '@maudecode/talaria-web-contracts'
import type { SidecarLike } from '../sidecar/client.js'
import type { Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { SidecarError } from '../sidecar/client.js'
import { latestCronSessionInfo } from '../sessions/state-db.js'
import { str } from '../util.js'

export interface CronDeps {
  sidecar: () => SidecarLike | null
  profileHome: (name: string) => string
  profileNames: () => Promise<{ name: string; visible: boolean }[]>
  profilesMatch: (row: string, active: string) => boolean
  isolatedProfileMode: () => boolean
  log: (line: string) => void
  /** Python `_publish_session_list_changed("cron_complete", profile=...)` once a manual run finishes. */
  publishSessionsChanged?: (reason: string, profile: string | null) => void
  /** Python `_RUNNING_CRON_JOBS`: job id → start time, read by the session list's `cron_running` stamp. */
  runningJobs?: Map<string, number>
}

const JOB_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/
const PASSTHROUGH_FIELDS = ['script', 'no_agent', 'context_from', 'reasoning_effort']

/** Python `_cron_job_for_api`. */
export function jobForApi(job: Dict): Dict {
  const payload: Dict = { ...job }
  if (!('profile' in payload)) payload.profile = null
  payload.toast_notifications = payload.toast_notifications !== false
  payload.monitor = str(payload.monitor_url) || str(payload.monitor_script) || ''
  payload.continuity = (Array.isArray(payload.context_from) ? payload.context_from : []).some((r) => str(r).trim().toLowerCase() === 'self')
  return payload
}

function monitorStorage(monitor: unknown): Dict {
  const value = str(monitor).trim()
  if (!value) return { monitor_script: '', monitor_url: '' }
  if (/^https?:\/\//i.test(value)) return { monitor_script: '', monitor_url: value }
  return { monitor_script: value, monitor_url: '' }
}

function continuityRefs(contextFrom: unknown, continuity: boolean): string[] {
  let refs: string[]
  if (contextFrom === null || contextFrom === undefined) refs = []
  else if (typeof contextFrom === 'string') refs = contextFrom.trim() ? [contextFrom.trim()] : []
  else if (Array.isArray(contextFrom)) refs = contextFrom.map((r) => str(r).trim()).filter(Boolean)
  else throw new HttpFailure(400, 'context_from must be a job ID string or a list of job ID strings')
  const hasSelf = refs.some((r) => r.toLowerCase() === 'self')
  if (continuity && !hasSelf) refs.push('self')
  else if (!continuity && hasSelf) refs = refs.filter((r) => r.toLowerCase() !== 'self')
  return refs
}

/** Python `_cron_job_field_updates`. */
export function jobFieldUpdates(body: Dict, currentContextFrom: unknown = null): Dict {
  const updates: Dict = {}
  for (const key of PASSTHROUGH_FIELDS) if (key in body) updates[key] = body[key]
  if ('monitor' in body) Object.assign(updates, monitorStorage(body.monitor))
  if ('continuity' in body) updates.context_from = continuityRefs('context_from' in updates ? updates.context_from : currentContextFrom, Boolean(body.continuity))
  return updates
}

export function validJobId(id: string): boolean {
  return JOB_ID_RE.test(id) && id !== '.' && id !== '..'
}

const PY_FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** Python `float(since)` with its ValueError mapped to 0: a malformed `since` means "from the epoch", never a 500. */
export function parseSince(raw: string | undefined): number {
  const t = (raw ?? '').trim()
  const n = PY_FLOAT_RE.test(t) ? Number(t) : 0
  return Number.isFinite(n) ? n : 0
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Python `_handle_cron_recent`'s `last_run_at` read (`datetime.fromisoformat` after `Z` → `+00:00`, or a number).
 * Only ISO-shaped strings count, so `Date.parse` leniency ("Jan 2 2026") never invents a completion; a time without
 * an offset is server-local, as in Python. Anything else is skipped.
 */
export function completedAtSeconds(value: unknown): number | null {
  if (typeof value === 'number') return value && Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const m = ISO_RE.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number]
  const ms = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3))
  if (mo < 1 || mo > 12 || d < 1 || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d || h > 23 || mi > 59 || sec > 59) return null
  const offset = m[8]
  if (offset === undefined) return new Date(y, mo - 1, d, h, mi, sec, ms).getTime() / 1000
  let offsetMinutes = 0
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '')
    offsetMinutes = (offset.startsWith('-') ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0))
  }
  return (Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMinutes * 60_000) / 1000
}

/** The one place a job's `last_status` becomes the success/failure the clients render. */
export function completionOutcome(status: unknown): CronRecentCompletion['outcome'] {
  const s = str(status).trim().toLowerCase()
  if (s === 'error' || s === 'failed') return 'failed'
  if (s === 'ok' || s === 'success' || s === 'completed') return 'succeeded'
  return 'unknown'
}

export class CronService {
  constructor(private readonly deps: CronDeps) {}

  private sidecar(): SidecarLike {
    const s = this.deps.sidecar()
    if (!s) throw new HttpFailure(503, 'Hermes Agent sidecar is not running; cron jobs are unavailable')
    return s
  }

  private async profileNames(active: string): Promise<string[]> {
    const names: string[] = []
    const seen = new Set<string>()
    const add = (raw: string): void => { const n = raw.trim(); if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n) } }
    add(active)
    for (const row of await this.deps.profileNames()) if (row.visible || this.deps.profilesMatch(row.name, active)) add(row.name)
    return names
  }

  async availableProfileNames(): Promise<Set<string>> {
    const names = new Set(['default'])
    try { for (const row of await this.deps.profileNames()) if (row.name.trim()) names.add(row.name.trim()) } catch { /* sidecar down: default only */ }
    return names
  }

  async normalizeProfile(value: unknown): Promise<string | null> {
    if (value === null || value === undefined) return null
    const profile = str(value).trim()
    if (!profile) return null
    if (!(await this.availableProfileNames()).has(profile)) throw new HttpFailure(400, `Unknown profile: ${profile}`)
    return profile
  }

  /** Python `/api/crons`: the active profile's rows plus foreign rows (hidden unless `all_profiles`). */
  async list(active: string, allProfiles: boolean): Promise<Dict> {
    const sidecar = this.sidecar()
    const activeJobs: Dict[] = []
    const otherJobs: Dict[] = []
    const seenHomes = new Set<string>()
    for (const owner of await this.profileNames(active)) {
      const home = this.deps.profileHome(owner)
      if (seenHomes.has(home)) continue
      seenHomes.add(home)
      const isActive = this.deps.profilesMatch(owner, active)
      let jobs: Dict[]
      try {
        jobs = (await sidecar.call('cron.list', { profile_home: home })).jobs.map((j) => jobForApi(j))
      } catch (error) {
        if (!isActive) continue
        if (error instanceof SidecarError && error.condition === 'cron_unavailable') return { jobs: [], cron_unavailable: true }
        throw error
      }
      for (const job of jobs) (isActive ? activeJobs : otherJobs).push({ ...job, owner_profile: owner, read_only: !isActive })
    }
    const all = allProfiles && !this.deps.isolatedProfileMode()
    return { jobs: all ? [...activeJobs, ...otherJobs] : activeJobs, all_profiles: all, active_profile: active, other_profile_count: all ? 0 : otherJobs.length }
  }

  /**
   * Python `/api/crons/recent`: each active-profile job's latest completion after `since`, newest first (ties by
   * `job_id`), with the server's `outcome` and the newest cron session for that job. One row per job, not a run archive.
   */
  async recent(home: string, rawSince: string | undefined): Promise<{ completions: CronRecentCompletion[]; since: number }> {
    const since = parseSince(rawSince)
    let jobs: Dict[]
    try {
      jobs = (await this.sidecar().call('cron.list', { profile_home: home })).jobs
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'cron_unavailable') return { completions: [], since }
      throw error
    }
    const completions: CronRecentCompletion[] = []
    for (const job of jobs) {
      const jobId = str(job.id).trim()
      const completedAt = completedAtSeconds(job.last_run_at)
      if (!jobId || completedAt === null || completedAt <= since) continue
      const status = 'last_status' in job ? (job.last_status === null ? null : str(job.last_status)) : 'unknown'
      completions.push({
        job_id: jobId,
        name: 'name' in job ? (job.name === null ? null : str(job.name)) : 'Unknown',
        status,
        outcome: completionOutcome(status),
        completed_at: completedAt,
        toast_notifications: job.toast_notifications !== false,
        session_id: '',
      })
    }
    completions.sort((a, b) => b.completed_at - a.completed_at || (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0))
    const sessions = latestCronSessionInfo(join(home, 'state.db'), jobs.map((job) => str(job.id)), completions.map((c) => c.job_id))
    for (const completion of completions) {
      const info = sessions.get(completion.job_id)
      if (!info) continue
      completion.session_id = info.session_id
      if (info.message_count !== null) completion.message_count = info.message_count
    }
    return { completions, since }
  }

  async create(home: string, body: Dict): Promise<Dict> {
    if (!('schedule' in body) || body.schedule === null || body.schedule === undefined) throw new HttpFailure(400, 'Missing required field(s): schedule')
    if (!body.prompt && !body.script && !body.skills) throw new HttpFailure(400, 'Missing required field(s): prompt')
    const profile = await this.normalizeProfile(body.profile)
    const job: Dict = { prompt: body.prompt ?? '', schedule: body.schedule, name: body.name ?? null, deliver: body.deliver ?? 'local', skills: body.skills ?? [], model: body.model ?? null, provider: body.provider ?? null, ...jobFieldUpdates(body) }
    if (body.repeat !== null && body.repeat !== undefined) job.repeat = body.repeat
    if (profile !== null) job.profile = profile
    if (body.toast_notifications === false) job.toast_notifications = false
    try {
      const result = await this.sidecar().call('cron.create', { profile_home: home, job, execution_home: profile ? this.deps.profileHome(profile) : null })
      return { ok: true, job: jobForApi(result.job) }
    } catch (error) {
      throw new HttpFailure(400, str((error as Error).message))
    }
  }

  async update(home: string, body: Dict): Promise<Dict> {
    const jobId = str(body.job_id)
    if (!jobId) throw new HttpFailure(400, 'Missing required field(s): job_id')
    const updates: Dict = {}
    for (const [k, v] of Object.entries(body)) {
      if (k === 'job_id') continue
      if (k === 'profile') updates.profile = await this.normalizeProfile(v)
      else if (k === 'model' || k === 'provider') updates[k] = v ? v : null
      else if (k === 'monitor' || k === 'continuity' || k === 'repeat') continue
      else if (v !== null && v !== undefined) updates[k] = v
    }
    let currentContextFrom: unknown = null
    if ('continuity' in body && !('context_from' in body)) {
      try { currentContextFrom = (await this.sidecar().call('cron.get', { profile_home: home, job_id: jobId })).job?.context_from ?? null } catch { currentContextFrom = null }
    }
    Object.assign(updates, jobFieldUpdates(body, currentContextFrom))
    try {
      const result = await this.sidecar().call('cron.update', { profile_home: home, job_id: jobId, updates })
      return { ok: true, job: jobForApi(result.job) }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'not_found') throw new HttpFailure(404, 'Job not found')
      throw new HttpFailure(400, str((error as Error).message))
    }
  }

  private async simple(method: 'cron.pause' | 'cron.resume' | 'cron.delete', home: string, jobId: string, extra: Dict = {}): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, method === 'cron.delete' ? 'Missing required field(s): job_id' : 'job_id required')
    try {
      const result = await this.sidecar().call(method, { profile_home: home, job_id: jobId, ...extra })
      // Python returned the raw `pause_job`/`resume_job` record and `{ok, job_id}` for delete.
      return 'job' in result ? { ok: true, job: result.job } : { ok: true, job_id: jobId }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'not_found') throw new HttpFailure(404, 'Job not found')
      // Python had no handler for `resume_job`'s ValueError (expired one-shot): it surfaced as a 500.
      if (error instanceof SidecarError && error.condition === 'cron_resume_failed') throw new HttpFailure(500, str(error.message))
      throw new HttpFailure(400, str((error as Error).message))
    }
  }

  pause(home: string, jobId: string, reason: string | null): Promise<Dict> { return this.simple('cron.pause', home, jobId, { reason }) }
  resume(home: string, jobId: string): Promise<Dict> { return this.simple('cron.resume', home, jobId) }
  delete(home: string, jobId: string): Promise<Dict> { return this.simple('cron.delete', home, jobId) }

  /** Python `_handle_cron_run`: answer once the sidecar emits `started`; the run itself continues in the background. */
  async runNow(home: string, jobId: string): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    const running = this.deps.runningJobs
    const existing = running?.get(jobId)
    if (existing !== undefined) return { ok: false, job_id: jobId, status: 'already_running', elapsed: Math.max(0, Date.now() / 1000 - existing) }
    // Own admission before any await so update/restart cannot race validation or dispatch.
    running?.set(jobId, Date.now() / 1000)
    try {
      const sidecar = this.sidecar()
      let job: Dict | null
      try { job = (await sidecar.call('cron.get', { profile_home: home, job_id: jobId })).job } catch { job = null }
      if (!job) throw new HttpFailure(404, 'Job not found')
      const status = await sidecar.call('cron.status', { job_id: jobId })
      if ('job_id' in status && status.running) {
        running?.delete(jobId)
        return { ok: false, job_id: jobId, status: 'already_running', elapsed: Math.round(status.elapsed * 10) / 10 }
      }
      const profile = str(job.profile).trim()
      const known = (await this.availableProfileNames()).has(profile)
      const executionHome = profile && known ? this.deps.profileHome(profile) : null
      // Python `_event_profile_for_cron_job`: browsers refresh the job's profile when it is a known one.
      const eventProfile = profile && known ? profile : null
      let started = false
      const done = (): void => { running?.delete(jobId); if (started) this.deps.publishSessionsChanged?.('cron_complete', eventProfile) }
      return await new Promise((resolve, reject) => {
        let answered = false
        const answer = (payload: Dict): void => { if (!answered) { answered = true; resolve(payload) } }
        sidecar.call('cron.run', { profile_home: home, job_id: jobId, execution_home: executionHome }, { timeoutMs: 0, onStream: (frame) => { if (frame.event === 'started') { started = true; running?.set(jobId, Date.now() / 1000); answer({ ok: true, job_id: jobId, status: 'running' }) } } })
          .then((result) => { answer(result.status === 'already_running' ? { ok: false, job_id: jobId, status: 'already_running', elapsed: result.elapsed } : { ok: true, job_id: jobId, status: 'running' }); done() })
          .catch((error: unknown) => {
            this.deps.log(`[cron] manual run ${jobId} failed: ${str((error as Error).message)}`)
            done()
            if (started) return
            // Python only ever answered 200 for `running`/`already_running`; a run that never started is the error it was.
            if (!answered) { answered = true; reject(error instanceof HttpFailure ? error : new HttpFailure(error instanceof SidecarError && error.condition === 'sidecar_unavailable' ? 503 : 500, str((error as Error).message))) }
          })
      })
    } catch (error) {
      running?.delete(jobId)
      throw error
    }
  }

  async status(jobId: string): Promise<Dict> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return jobId ? { job_id: jobId, running: false, elapsed: 0 } : { running: {} }
    return sidecar.call('cron.status', jobId ? { job_id: jobId } : {})
  }

  async history(home: string, jobId: string, offset: string | undefined, limit: string | undefined): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    if (!validJobId(jobId)) throw new HttpFailure(400, 'invalid job_id')
    // Python `int()`: a blank query value is absent (parse_qs drops it); "5abc" / "1.5" are rejected.
    const pyInt = (raw: string | undefined, fallback: number): number => { const t = (raw ?? '').trim(); if (!t) return fallback; if (!/^[+-]?\d+$/.test(t)) return Number.NaN; return Number.parseInt(t, 10) }
    const o = pyInt(offset, 0)
    const l = pyInt(limit, 50)
    if (!Number.isFinite(o) || !Number.isFinite(l)) throw new HttpFailure(400, 'offset and limit must be integers')
    return this.sidecar().call('cron.history', { profile_home: home, job_id: jobId, offset: Math.max(0, o), limit: Math.max(1, Math.min(500, l)) })
  }

  async runDetail(home: string, jobId: string, filename: string): Promise<Dict> {
    if (!jobId || !filename) throw new HttpFailure(400, 'job_id and filename required')
    if (!validJobId(jobId)) throw new HttpFailure(400, 'invalid job_id')
    if (filename.includes('/') || filename.includes('\\') || filename === '..') throw new HttpFailure(400, 'invalid filename')
    try {
      return await this.sidecar().call('cron.run_detail', { profile_home: home, job_id: jobId, filename })
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'not_found') throw new HttpFailure(404, 'run not found')
      throw error
    }
  }

  async output(home: string, jobId: string, limit: string | undefined): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    if (!JOB_ID_RE.test(jobId)) throw new HttpFailure(400, 'invalid job_id')
    const l = Number.parseInt(limit ?? '5', 10)
    return this.sidecar().call('cron.output', { profile_home: home, job_id: jobId, limit: Number.isFinite(l) ? Math.max(1, Math.min(500, l)) : 5 })
  }

  async deliveryOptions(): Promise<{ platforms: { value: string; label: string }[] }> {
    const sidecar = this.deps.sidecar()
    const fallback = { platforms: [{ value: 'local', label: 'Local (save output only)' }, { value: 'origin', label: 'Origin (reply to creator)' }] }
    if (!sidecar) return fallback
    try { return await sidecar.call('cron.delivery_options', {}) } catch { return fallback }
  }
}
