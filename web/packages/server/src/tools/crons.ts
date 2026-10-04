/** Cron jobs across profiles through the sidecar `cron.*` namespace (Python `api/routes.py` cron section). */
import { join } from 'node:path'
import type { CronRecentCompletion, CronContextSources, CronDerivedState } from '@maudecode/talaria-web-contracts'
import type { SidecarLike } from '../sidecar/client.js'
import { parseProviderQualifiedModel, type Dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { SidecarError } from '../sidecar/client.js'
import { latestCronSessionInfo } from '../sessions/state-db.js'
import { stripToolCallXml } from '../sessions/merge.js'
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
  /** TAL-301: the catalog entry id a job's stored `(model, provider)` selects in a profile home's picker catalog. */
  modelOptionFor?: (home: string, model: string | null, provider: string | null) => Promise<string | null>
  /** Python `_RUNNING_CRON_JOBS`: job id → start time, read by the session list's `cron_running` stamp. */
  runningJobs?: Map<string, number>
}

const JOB_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/
const PASSTHROUGH_FIELDS = ['script', 'no_agent', 'context_from', 'reasoning_effort']
interface StoredJob { home: string; profile: string; job: Dict; managed: boolean }

/** TAL-301: a picked catalog id (`@provider:model`) names its own provider, exactly as a chat request does; a bare id keeps the explicit one. */
function modelSelection(model: unknown, provider: unknown): [string | null, string | null] {
  const raw = str(model).trim()
  const explicit = str(provider).trim() || null
  if (!raw) return [null, explicit]
  return parseProviderQualifiedModel(raw) ?? [raw, explicit]
}

/** Python `_cron_job_for_api`, plus the derived status every client renders (TAL-296). */
export function jobForApi(job: Dict, running = false): Dict {
  const payload: Dict = { ...job }
  // TAL-301: a job stored with a provider-qualified id (older clients) still reads back as a bare model and its provider.
  const qualified = parseProviderQualifiedModel(job.model)
  if (qualified) [payload.model, payload.provider] = qualified
  if (!('profile' in payload)) payload.profile = null
  payload.toast_notifications = payload.toast_notifications !== false
  payload.monitor = str(payload.monitor_url) || str(payload.monitor_script) || ''
  payload.continuity = (Array.isArray(payload.context_from) ? payload.context_from : []).some((r) => str(r).trim().toLowerCase() === 'self')
  const state = cronDerivedState(job)
  payload.derived_state = state
  payload.needs_attention = state === 'needs_attention' || state === 'schedule_error'
  payload.resumable = payload.needs_attention || state === 'paused' || state === 'off'
  payload.running = running || job.running === true
  Object.assign(payload, scheduleText(job))
  return payload
}

/** TAL-298: the schedule's display text and the editor's prefill, in the scheduler's own vocabulary (not localized copy). */
function scheduleText(job: Dict): { schedule_display: string; schedule_input: string } {
  const schedule = job.schedule
  const legacy = typeof schedule === 'string' ? schedule : ''
  const s: Dict = typeof schedule === 'object' && schedule ? schedule as Dict : {}
  const minutes = typeof s.minutes === 'number' && s.minutes > 0 ? s.minutes : 0
  const runAt = str(s.run_at)
  let input = ''
  let built = ''
  if (s.kind === 'cron') input = built = str(s.expr)
  else if (s.kind === 'interval' && minutes) [input, built] = [`every ${minutes}m`, minutes % 60 ? `every ${minutes}m` : `every ${minutes / 60}h`]
  else if (s.kind === 'once' && runAt) [input, built] = [runAt, `once at ${runAt}`]
  const display = str(job.schedule_display) || str(s.display) || legacy || built
  return { schedule_display: display, schedule_input: input || legacy || display }
}

/** `repeat.times == null` means "forever" in the store; a missing record is not unlimited. */
function hasUnlimitedRepeat(job: Dict): boolean {
  return !!job.repeat && typeof job.repeat === 'object' && (job.repeat as Dict).times == null
}

function isRecurring(job: Dict): boolean {
  const schedule = job.schedule
  if (typeof schedule === 'object' && schedule) return (schedule as Dict).kind === 'cron' || (schedule as Dict).kind === 'interval'
  // Legacy string schedules carry no kind; an unlimited repeat record marks the job recurring (a one-shot has times: 1).
  return typeof schedule === 'string' && hasUnlimitedRepeat(job)
}

/** Older agents report `paused` / `status` / `next_run` instead of `state` / `last_status` / `next_run_at`; all stay supported. */
function cronDerivedState(job: Dict): CronDerivedState {
  const errored = job.state === 'error' || completionOutcome(job.last_status) === 'failed' || job.status === 'error'
  const nextRun = job.next_run_at ?? (typeof job.next_run === 'number' || typeof job.next_run === 'string' ? job.next_run : null)
  if (isRecurring(job) && hasUnlimitedRepeat(job) && job.enabled === false && job.state === 'completed' && !nextRun) return 'needs_attention'
  // A paused job keeps the last run's error and has no next run; that is not a schedule failure.
  if (job.state === 'paused' || job.paused) return 'paused'
  if (isRecurring(job) && !nextRun && errored) return 'schedule_error'
  if (job.enabled === false) return 'off'
  if (errored) return 'error'
  return 'active'
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
    if (this.deps.isolatedProfileMode()) return names
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

  private async profileForHome(home: string): Promise<string> {
    const names = this.deps.isolatedProfileMode() ? (await this.deps.profileNames()).map((row) => row.name) : await this.availableProfileNames()
    for (const profile of names) if (this.deps.profileHome(profile) === home) return profile
    throw new HttpFailure(403, 'Unknown cron profile home')
  }

  /** The physical store owns execution. Additive owner_profile metadata lets the creator manage a new job there. */
  private async storedJobs(active: string): Promise<StoredJob[]> {
    // ponytail: scan visible stores per request; add an index only if profile/job counts make this expensive.
    const rows: StoredJob[] = []
    const seen = new Set<string>()
    for (const profile of await this.profileNames(active)) {
      const home = this.deps.profileHome(profile)
      if (seen.has(home)) continue
      seen.add(home)
      const local = this.deps.profilesMatch(profile, active)
      let jobs: Dict[]
      try { jobs = (await this.sidecar().call('cron.list', { profile_home: home })).jobs }
      catch (error) { if (local) throw error; continue }
      for (const job of jobs) {
        const creator = str(job.owner_profile).trim()
        rows.push({ home, profile, job, managed: local || Boolean(creator && this.deps.profilesMatch(creator, active)) })
      }
    }
    return rows
  }

  /** `pickerHome` is the profile whose `/api/models` catalog the requesting client shows. */
  private async view(row: StoredJob, pickerHome: string): Promise<Dict> {
    const payload: Dict = { ...jobForApi(row.job, this.deps.runningJobs?.has(str(row.job.id)) ?? false), profile: str(row.job.profile).trim() || row.profile, owner_profile: row.profile, read_only: !row.managed }
    payload.model_option_id = (await this.deps.modelOptionFor?.(pickerHome, str(payload.model) || null, str(payload.provider) || null)) ?? null
    return payload
  }

  private requireExecutionStore(row: StoredJob): void {
    const profile = str(row.job.profile).trim()
    if (profile && !this.deps.profilesMatch(profile, row.profile)) throw new HttpFailure(409, 'This legacy task must be recreated in its execution profile before it can run or resume')
  }

  private async validateContext(home: string, fields: Dict): Promise<void> {
    const refs = continuityRefs(fields.context_from, false)
    if (!refs.length) return
    const ids = new Set((await this.sidecar().call('cron.list', { profile_home: home })).jobs.map((job) => job.id))
    if (refs.some((ref) => !ids.has(str(ref)))) throw new HttpFailure(400, 'Context jobs must belong to the execution profile')
  }

  private async resolveStore(home: string, ref: string): Promise<StoredJob> {
    const active = await this.profileForHome(home)
    const allRows = await this.storedJobs(active)
    const rows = allRows.filter((row) => row.managed)
    const exact = rows.filter((row) => row.job.id === ref)
    const matches = exact.length ? exact : rows.filter((row) => row.job.name === ref)
    if (!matches.length) throw new HttpFailure(404, 'Job not found')
    if (matches.length !== 1) throw new HttpFailure(409, 'Ambiguous cron job reference')
    const match = matches[0]!
    if (allRows.filter((row) => row.home === match.home && row.job.id === match.job.id).length !== 1) throw new HttpFailure(409, 'Ambiguous cron job reference')
    return match
  }

  async contextSources(home: string, input: { profile?: string | undefined; editing_job_id?: string | undefined; exclude_job_id?: string | undefined; selected_refs?: string[] | undefined }): Promise<CronContextSources> {
    const active = await this.profileForHome(home)
    const editing = input.editing_job_id ? await this.resolveStore(home, input.editing_job_id) : null
    const profile = await this.normalizeProfile(input.profile)
    if (profile && !(await this.profileNames(active)).some((name) => this.deps.profilesMatch(name, profile))) throw new HttpFailure(403, 'Execution profile is not accessible')
    const executionHome = profile ? this.deps.profileHome(profile) : editing?.home ?? home
    const rows = await this.storedJobs(active)
    const inStore = rows.filter((row) => row.home === executionHome)
    const excludeId = editing ? str(editing.job.id) : input.exclude_job_id
    const counts = new Map<string, number>()
    for (const row of inStore) counts.set(str(row.job.id), (counts.get(str(row.job.id)) ?? 0) + 1)
    const sources: CronContextSources['sources'] = []
    const included = new Set<string>()
    for (const row of inStore) {
      const id = str(row.job.id).trim()
      if (!row.managed || !id || id === excludeId || counts.get(id) !== 1) continue
      sources.push({ job_id: id, label: str(row.job.name).trim() || id, selectable: true })
      included.add(id)
    }
    for (const raw of input.selected_refs ?? []) {
      const id = raw.trim()
      if (!id || id.toLowerCase() === 'self' || included.has(id)) continue
      const owned = rows.find((row) => row.managed && row.job.id === id)
      sources.push({ job_id: id, label: str(owned?.job.name).trim() || id, selectable: false })
      included.add(id)
    }
    return { profile: profile ?? editing?.profile ?? active, sources }
  }

  /** Python `/api/crons`: the active profile's rows plus foreign rows (hidden unless `all_profiles`). */
  async list(active: string, allProfiles: boolean): Promise<Dict> {
    const activeJobs: Dict[] = []
    const otherJobs: Dict[] = []
    const pickerHome = this.deps.profileHome(active)
    try { for (const row of await this.storedJobs(active)) (row.managed ? activeJobs : otherJobs).push(await this.view(row, pickerHome)) }
    catch (error) { if (error instanceof SidecarError && error.condition === 'cron_unavailable') return { jobs: [], cron_unavailable: true }; throw error }
    const all = allProfiles && !this.deps.isolatedProfileMode()
    return { jobs: all ? [...activeJobs, ...otherJobs] : activeJobs, all_profiles: all, active_profile: active, other_profile_count: all ? 0 : otherJobs.length }
  }

  /**
   * Python `/api/crons/recent`: each active-profile job's latest completion after `since`, newest first (ties by
   * `job_id`), with the server's `outcome` and the newest cron session for that job. One row per job, not a run archive.
   */
  async recent(home: string, rawSince: string | undefined): Promise<{ completions: CronRecentCompletion[]; since: number }> {
    const since = parseSince(rawSince)
    let rows: StoredJob[]
    try {
      rows = (await this.storedJobs(await this.profileForHome(home))).filter((row) => row.managed)
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'cron_unavailable') return { completions: [], since }
      throw error
    }
    const completions: CronRecentCompletion[] = []
    for (const { job } of rows) {
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
    for (const storeHome of new Set(rows.map((row) => row.home))) {
      const ids = rows.filter((row) => row.home === storeHome).map((row) => str(row.job.id))
      const sessions = latestCronSessionInfo(join(storeHome, 'state.db'), ids, completions.filter((c) => ids.includes(c.job_id)).map((c) => c.job_id))
      for (const completion of completions) {
        if (!ids.includes(completion.job_id)) continue
        const info = sessions.get(completion.job_id)
        if (!info) continue
        completion.session_id = info.session_id
        if (info.message_count !== null) completion.message_count = info.message_count
      }
    }
    return { completions, since }
  }

  async create(home: string, body: Dict): Promise<Dict> {
    if (!('schedule' in body) || body.schedule === null || body.schedule === undefined) throw new HttpFailure(400, 'Missing required field(s): schedule')
    if (!body.prompt && !body.script && !body.skills) throw new HttpFailure(400, 'Missing required field(s): prompt')
    const profile = await this.normalizeProfile(body.profile)
    const active = await this.profileForHome(home)
    if (profile && !(await this.profileNames(active)).some((name) => this.deps.profilesMatch(name, profile))) throw new HttpFailure(403, 'Execution profile is not accessible')
    const executionHome = profile ? this.deps.profileHome(profile) : home
    const [model, provider] = modelSelection(body.model, body.provider)
    const job: Dict = { prompt: body.prompt ?? '', schedule: body.schedule, name: body.name ?? null, deliver: body.deliver ?? 'local', skills: body.skills ?? [], model, provider, ...jobFieldUpdates(body) }
    if (body.repeat !== null && body.repeat !== undefined) job.repeat = body.repeat
    if (profile !== null) job.profile = profile
    if (body.toast_notifications === false) job.toast_notifications = false
    job.owner_profile = active
    await this.validateContext(executionHome, job)
    try {
      const result = await this.sidecar().call('cron.create', { profile_home: executionHome, job, execution_home: profile ? executionHome : null })
      return { ok: true, job: await this.view({ home: executionHome, profile: profile ?? active, job: result.job, managed: true }, home) }
    } catch (error) {
      throw new HttpFailure(400, str((error as Error).message))
    }
  }

  async update(home: string, body: Dict): Promise<Dict> {
    const jobId = str(body.job_id)
    if (!jobId) throw new HttpFailure(400, 'Missing required field(s): job_id')
    const store = await this.resolveStore(home, jobId)
    const storedId = str(store.job.id)
    const pickerHome = home
    home = store.home
    const updates: Dict = {}
    for (const [k, v] of Object.entries(body)) {
      if (k === 'job_id' || k === 'id' || k === 'owner_profile') continue
      if (k === 'profile') {
        const profile = await this.normalizeProfile(v)
        if (profile && !this.deps.profilesMatch(profile, store.profile)) throw new HttpFailure(400, 'To change the execution profile, duplicate the task in that profile and delete the old task')
        updates.profile = profile
      }
      else if (k === 'model' || k === 'provider' || k === 'monitor' || k === 'continuity' || k === 'repeat') continue
      else if (v !== null && v !== undefined) updates[k] = v
    }
    if ('model' in body) {
      const [model, provider] = modelSelection(body.model, body.provider)
      updates.model = model
      if (provider !== null || 'provider' in body) updates.provider = provider
    } else if ('provider' in body) updates.provider = str(body.provider).trim() || null
    let currentContextFrom: unknown = null
    if ('continuity' in body && !('context_from' in body)) {
      try { currentContextFrom = (await this.sidecar().call('cron.get', { profile_home: home, job_id: storedId })).job?.context_from ?? null } catch { currentContextFrom = null }
    }
    Object.assign(updates, jobFieldUpdates(body, currentContextFrom))
    await this.validateContext(home, updates)
    try {
      const result = await this.sidecar().call('cron.update', { profile_home: home, job_id: storedId, updates })
      return { ok: true, job: await this.view({ ...store, job: result.job }, pickerHome) }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'not_found') throw new HttpFailure(404, 'Job not found')
      throw new HttpFailure(400, str((error as Error).message))
    }
  }

  private async simple(method: 'cron.pause' | 'cron.resume' | 'cron.delete', home: string, jobId: string, extra: Dict = {}): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, method === 'cron.delete' ? 'Missing required field(s): job_id' : 'job_id required')
    const store = await this.resolveStore(home, jobId)
    if (method === 'cron.resume') this.requireExecutionStore(store)
    try {
      const result = await this.sidecar().call(method, { profile_home: store.home, job_id: str(store.job.id), ...extra })
      // Python returned the raw `pause_job`/`resume_job` record and `{ok, job_id}` for delete.
      return 'job' in result ? { ok: true, job: await this.view({ ...store, job: result.job }, home) } : { ok: true, job_id: jobId }
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
      const store = await this.resolveStore(home, jobId)
      if (store.job.id !== jobId) throw new HttpFailure(404, 'Job not found')
      this.requireExecutionStore(store)
      home = store.home
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
    home = (await this.resolveStore(home, jobId)).home
    return this.sidecar().call('cron.history', { profile_home: home, job_id: jobId, offset: Math.max(0, o), limit: Math.max(1, Math.min(500, l)) })
  }

  async runDetail(home: string, jobId: string, filename: string): Promise<Dict> {
    if (!jobId || !filename) throw new HttpFailure(400, 'job_id and filename required')
    if (!validJobId(jobId)) throw new HttpFailure(400, 'invalid job_id')
    if (filename.includes('/') || filename.includes('\\') || filename === '..') throw new HttpFailure(400, 'invalid filename')
    home = (await this.resolveStore(home, jobId)).home
    try {
      const detail = await this.sidecar().call('cron.run_detail', { profile_home: home, job_id: jobId, filename })
      // Leaked tool-call XML is removed from the run's text, as from a transcript reply (TAL-302).
      return { ...detail, content: stripToolCallXml(detail.content), snippet: stripToolCallXml(detail.snippet) }
    } catch (error) {
      if (error instanceof SidecarError && error.condition === 'not_found') throw new HttpFailure(404, 'run not found')
      throw error
    }
  }

  async output(home: string, jobId: string, limit: string | undefined): Promise<Dict> {
    if (!jobId) throw new HttpFailure(400, 'job_id required')
    if (!JOB_ID_RE.test(jobId)) throw new HttpFailure(400, 'invalid job_id')
    const l = Number.parseInt(limit ?? '5', 10)
    home = (await this.resolveStore(home, jobId)).home
    return this.sidecar().call('cron.output', { profile_home: home, job_id: jobId, limit: Number.isFinite(l) ? Math.max(1, Math.min(500, l)) : 5 })
  }

  async deliveryOptions(): Promise<{ platforms: { value: string; label: string }[] }> {
    const sidecar = this.deps.sidecar()
    const fallback = { platforms: [{ value: 'local', label: 'Local (save output only)' }, { value: 'origin', label: 'Origin (reply to creator)' }] }
    if (!sidecar) return fallback
    try { return await sidecar.call('cron.delivery_options', {}) } catch { return fallback }
  }
}
