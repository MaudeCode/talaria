/** Cron jobs across profiles through the sidecar `cron.*` namespace (Python `api/routes.py` cron section). */
import type { SidecarLike } from '../sidecar/client.js'
import type { Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { SidecarError } from '../sidecar/client.js'
import { str } from '../util.js'

export interface CronDeps {
  sidecar: () => SidecarLike | null
  profileHome: (name: string) => string
  profileNames: () => Promise<{ name: string; visible: boolean }[]>
  profilesMatch: (row: string, active: string) => boolean
  isolatedProfileMode: () => boolean
  log: (line: string) => void
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
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    try {
      const result = await this.sidecar().call(method, { profile_home: home, job_id: jobId, ...extra })
      return 'job' in result ? { ok: true, job: jobForApi(result.job) } : { ok: true, job_id: jobId }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'not_found') throw new HttpFailure(404, 'Job not found')
      throw new HttpFailure(400, str((error as Error).message))
    }
  }

  pause(home: string, jobId: string, reason: string | null): Promise<Dict> { return this.simple('cron.pause', home, jobId, { reason }) }
  resume(home: string, jobId: string): Promise<Dict> { return this.simple('cron.resume', home, jobId) }
  delete(home: string, jobId: string): Promise<Dict> { return this.simple('cron.delete', home, jobId) }

  /** Python `_handle_cron_run`: answer once the sidecar emits `started`; the run itself continues in the background. */
  async runNow(home: string, jobId: string): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    const sidecar = this.sidecar()
    let job: Dict | null
    try { job = (await sidecar.call('cron.get', { profile_home: home, job_id: jobId })).job } catch { job = null }
    if (!job) throw new HttpFailure(404, 'Job not found')
    const status = await sidecar.call('cron.status', { job_id: jobId })
    if ('job_id' in status && status.running) return { ok: false, job_id: jobId, status: 'already_running', elapsed: Math.round(status.elapsed * 10) / 10 }
    const profile = str(job.profile).trim()
    const executionHome = profile && (await this.availableProfileNames()).has(profile) ? this.deps.profileHome(profile) : null
    return new Promise((resolve) => {
      let answered = false
      const answer = (payload: Dict): void => { if (!answered) { answered = true; resolve(payload) } }
      sidecar.call('cron.run', { profile_home: home, job_id: jobId, execution_home: executionHome }, { timeoutMs: 0, onStream: (frame) => { if (frame.event === 'started') answer({ ok: true, job_id: jobId, status: 'running' }) } })
        .then((result) => { answer(result.status === 'already_running' ? { ok: false, job_id: jobId, status: 'already_running', elapsed: result.elapsed } : { ok: true, job_id: jobId, status: 'running' }) })
        .catch((error: unknown) => { this.deps.log(`[cron] manual run ${jobId} failed: ${str((error as Error).message)}`); answer({ ok: false, job_id: jobId, status: 'error' }) })
    })
  }

  async status(jobId: string): Promise<Dict> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return jobId ? { job_id: jobId, running: false, elapsed: 0 } : { running: {} }
    return sidecar.call('cron.status', jobId ? { job_id: jobId } : {})
  }

  async history(home: string, jobId: string, offset: string | undefined, limit: string | undefined): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    if (!validJobId(jobId)) throw new HttpFailure(400, 'invalid job_id')
    const o = Number.parseInt(offset ?? '0', 10)
    const l = Number.parseInt(limit ?? '50', 10)
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
