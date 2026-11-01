/**
 * TAL-1563: bounded, durable saved-check replay jobs. The server owns admission, the reserved budget, ordering,
 * persistence, cancellation and restart reconciliation; the sidecar re-derives each consented fixture and sends one
 * capped provider call per run. A run is persisted `dispatched` before its call, so a restart turns it `unknown` and
 * nothing is ever resent. Job documents are private, additive state in the `skill-replays` document namespace.
 */
import { createHash } from 'node:crypto'
import type { SidecarResult, SkillReplayBudget, SkillReplayJob, SkillReplayPlan } from '@maudecode/talaria-web-contracts'
import { readDocument, updateDocument } from '../sessions/storage/document.js'
import type { DocumentBackend } from '../sessions/storage/backend.js'
import { SidecarError, type SidecarLike } from '../sidecar/client.js'
import { HttpFailure } from '../sessions/service.js'

const NAMESPACE = 'skill-replays'
export const DEFAULT_REPLAY_COST_USD = 0.5
const RETAINED_PER_SCOPE = 20
const LISTED = 10
/** The sidecar's own provider timeout is 120 s; the call gets room to report it. */
const CASE_TIMEOUT_MS = 180_000
/** The sidecar raises only these before its single request; any other failure may follow a sent call. */
const REFUSALS = new Set(['replay_refused', 'invalid_params'])

type Role = 'baseline' | 'candidate'
type Plan = SidecarResult<'skills.replay_plan'>
type CaseResult = SidecarResult<'skills.replay_case'>
type Run = SkillReplayJob['cases'][number]['baseline']
type StoredState = 'queued' | 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
interface StoredCase { id: string; case_id: string; title: string; mode: 'plan' | 'reply'; input_tokens_bound: number; baseline: Run; candidate: Run }
interface StoredJob {
  version: 1
  id: string
  owner: string
  profile: string
  profile_home: string
  skill: string
  fingerprint: string
  created_at: string
  updated_at: string
  state: StoredState
  reason: 'budget_exceeded' | null
  cancel_requested: boolean
  revisions: SkillReplayJob['revisions']
  route: SkillReplayJob['route']
  budget: SkillReplayBudget
  cases: StoredCase[]
}
export interface ReplayScope { owner: string; profile: string }
export interface ReplayStart { request_id: string; name: string; baseline: string; candidate: string; case_ids: string[]; route: { provider: string; model: string }; max_cost_usd: number }
export interface SkillReplayDeps { documents: DocumentBackend; sidecar: () => SidecarLike | null; now?: () => Date; log?: (line: string) => void }

const ROLES: Role[] = ['baseline', 'candidate']
const ACTIVE: ReadonlySet<StoredState> = new Set(['queued', 'running'])
const hash = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
const pending = (): Run => ({ status: 'pending', detail: null, result: null })

/** Every call is capped at its prompt bound plus the output cap, priced at most `max_price_per_million`; the sum of
 * those reservations over every call stays within `maxCost`. Null when the bounds leave no positive price. */
export function replayBudget(cases: readonly { input_tokens_bound: number }[], maxOutput: number, maxCost: number): SkillReplayBudget | null {
  const input = ROLES.length * cases.reduce((sum, row) => sum + row.input_tokens_bound, 0)
  const tokens = input + ROLES.length * cases.length * maxOutput
  const price = Math.floor((maxCost * 1e6 / tokens) * 1e6) / 1e6
  if (!cases.length || !(price > 0) || !(maxCost > 0) || maxCost > 5) return null
  return { max_cost_usd: maxCost, max_calls: ROLES.length * cases.length, max_output_tokens: maxOutput, max_input_tokens: input, max_price_per_million: price }
}

function exceedsReservation(result: CaseResult, bound: number, budget: SkillReplayBudget): boolean {
  const reserved = (bound + budget.max_output_tokens) * budget.max_price_per_million / 1e6
  return (result.output_tokens !== null && result.output_tokens > budget.max_output_tokens)
    || (result.input_tokens !== null && result.input_tokens > bound)
    || (result.cost_usd !== null && result.cost_usd > reserved * (1 + 1e-9) + 1e-12)
}

export class SkillReplayService {
  private readonly running = new Set<string>()
  private readonly admissions = new Map<string, Promise<unknown>>()
  private readonly now: () => Date

  constructor(private readonly deps: SkillReplayDeps) { this.now = deps.now ?? (() => new Date()) }

  /** Startup: any job a previous process left active is interrupted. Its sent call is unknown, its unsent calls skipped. */
  async initialize(): Promise<void> {
    for (const { key } of await this.deps.documents.list(NAMESPACE)) {
      await updateDocument(this.deps.documents, NAMESPACE, key, (value) => {
        const job = value as StoredJob | null
        if (!job || !ACTIVE.has(job.state) || this.running.has(job.id)) return { value, result: null, skip: true }
        return { value: this.close(job, 'interrupted', 'Talaria Web restarted before this call reported; it is not resent'), result: null }
      }).catch((error: unknown) => this.deps.log?.(`[webui] WARNING: skill replay ${key} could not be reconciled: ${String(error)}`))
    }
  }

  async plan(home: string, input: { name: string; baseline: string; candidate: string }, redact: (text: string) => string): Promise<SkillReplayPlan> {
    const plan = await this.sidecarPlan(home, input)
    return { ...plan, cases: plan.cases.map((row) => ({ ...row, title: redact(row.title) })), budget: plan.state === 'ready' ? replayBudget(plan.cases, plan.max_output_tokens, DEFAULT_REPLAY_COST_USD) : null }
  }

  async list(scope: ReplayScope, name: string, redact: (text: string) => string): Promise<{ jobs: SkillReplayJob[] }> {
    const jobs = (await this.scoped(scope)).filter((job) => job.skill === name)
    return { jobs: jobs.slice(0, LISTED).map((job) => this.view(job, redact)) }
  }

  /** Idempotent per (owner, profile, request_id); one replay at a time per owner and profile. */
  async start(scope: ReplayScope, home: string, input: ReplayStart, redact: (text: string) => string): Promise<SkillReplayJob> {
    const key = JSON.stringify([scope.owner, scope.profile])
    const admitted = (this.admissions.get(key) ?? Promise.resolve()).then(() => this.admit(scope, home, input))
    this.admissions.set(key, admitted.catch(() => undefined))
    const job = await admitted
    void this.run(job.id)
    return this.view(job, redact)
  }

  async cancel(scope: ReplayScope, id: string, redact: (text: string) => string): Promise<SkillReplayJob> {
    const job = await updateDocument(this.deps.documents, NAMESPACE, id, (value) => {
      const stored = value as StoredJob | null
      if (stored?.owner !== scope.owner || stored.profile !== scope.profile) throw new HttpFailure(404, 'Replay not found')
      if (!ACTIVE.has(stored.state) || stored.cancel_requested) return { value, result: stored, skip: true }
      const next = { ...stored, cancel_requested: true, updated_at: this.now().toISOString() }
      return { value: next, result: next }
    })
    // A queued job whose worker is gone (it never started) closes here; a running worker closes it after its call.
    if (!this.running.has(id)) void this.run(id)
    return this.view(job, redact)
  }

  private async admit(scope: ReplayScope, home: string, input: ReplayStart): Promise<StoredJob> {
    const id = hash('skill-replay', scope.owner, scope.profile, input.request_id)
    const fingerprint = hash(input.name, input.baseline, input.candidate, input.case_ids, input.route, input.max_cost_usd)
    const reused = (stored: StoredJob): StoredJob => {
      if (stored.fingerprint !== fingerprint) throw new HttpFailure(409, 'This request id already admitted a different replay', { condition: 'replay_request_reused' })
      return stored
    }
    const existing = (await readDocument(this.deps.documents, NAMESPACE, id))?.value as StoredJob | null | undefined
    if (existing) return reused(existing)
    if ((await this.scoped(scope)).some((job) => ACTIVE.has(job.state))) throw new HttpFailure(409, 'A replay is already running for this profile', { condition: 'replay_busy' })
    const plan = await this.sidecarPlan(home, input)
    const drift = (message: string): never => { throw new HttpFailure(409, message, { condition: 'replay_drift' }) }
    if (plan.state !== 'ready') drift('Replay is no longer available; review it again')
    const roles = Object.fromEntries(plan.revisions.map((row) => [row.role, row]))
    if (roles.baseline?.id !== input.baseline || roles.candidate?.id !== input.candidate) drift('Saved revisions changed; review the replay again')
    if (plan.route?.provider !== input.route.provider || plan.route.model !== input.route.model) drift('The provider route changed; review the replay again')
    const cases = input.case_ids.map((caseId) => plan.cases.find((row) => row.id === caseId))
    if (new Set(input.case_ids).size !== input.case_ids.length || cases.some((row) => !row)) drift('Saved cases changed; review the replay again')
    const selected = cases as Plan['cases']
    const budget = replayBudget(selected, plan.max_output_tokens, input.max_cost_usd) ?? drift('The budget cannot cover these cases')
    const at = this.now().toISOString()
    const job: StoredJob = {
      version: 1, id, owner: scope.owner, profile: scope.profile, profile_home: home, skill: input.name, fingerprint, created_at: at, updated_at: at,
      state: 'queued', reason: null, cancel_requested: false, revisions: [roles.baseline!, roles.candidate!], route: plan.route!, budget,
      cases: selected.map((row) => ({ ...row, baseline: pending(), candidate: pending() })),
    }
    const stored = await updateDocument(this.deps.documents, NAMESPACE, id, (value) => value ? { value, result: reused(value as StoredJob), skip: true } : { value: job, result: job })
    await this.prune(scope)
    return stored
  }

  private async run(id: string): Promise<void> {
    if (this.running.has(id)) return
    this.running.add(id)
    try {
      for (;;) {
        const job = (await readDocument(this.deps.documents, NAMESPACE, id))?.value as StoredJob | null | undefined
        if (!job || !ACTIVE.has(job.state)) return
        const index = job.cases.findIndex((row) => ROLES.some((role) => row[role].status === 'pending'))
        if (job.cancel_requested || index < 0) {
          await this.edit(id, (stored) => this.close(stored, job.cancel_requested ? 'cancelled' : 'completed', 'Cancelled before this call was sent'))
          return
        }
        const role = ROLES.find((name) => job.cases[index]![name].status === 'pending')!
        const row = job.cases[index]!
        const sidecar = this.deps.sidecar()
        if (sidecar?.status !== 'ready') {
          await this.setRun(id, index, role, { status: 'refused', detail: 'The Agent runtime is unavailable; nothing was sent', result: null })
          continue
        }
        await this.setRun(id, index, role, { status: 'dispatched', detail: null, result: null })
        const revision = job.revisions.find((entry) => entry.role === role)!
        let outcome: Run
        try {
          const result = await sidecar.call('skills.replay_case', {
            profile_home: job.profile_home, name: job.skill, baseline: job.revisions[0].id, candidate: job.revisions[1].id, revision: revision.id, sha256: revision.sha256,
            fixture: row.id, route: job.route, max_input_tokens: row.input_tokens_bound, max_output_tokens: job.budget.max_output_tokens, max_price_per_million: job.budget.max_price_per_million,
          }, { timeoutMs: CASE_TIMEOUT_MS })
          outcome = { status: result.outcome, detail: result.error, result }
          if (exceedsReservation(result, row.input_tokens_bound, job.budget)) {
            await this.setRun(id, index, role, outcome)
            await this.edit(id, (stored) => ({ ...this.close(stored, 'failed', 'Stopped: a call reported usage beyond its reservation'), reason: 'budget_exceeded' }))
            return
          }
        } catch (error) {
          // The sidecar refuses drift, bounds and routes before its request; any other failure may follow a sent call.
          const refused = error instanceof SidecarError && (error.code === -32602 || REFUSALS.has(error.condition))
          outcome = refused ? { status: 'refused', detail: error.message.slice(0, 240), result: null } : { status: 'unknown', detail: 'This call\'s outcome is unknown; it is not resent', result: null }
        }
        await this.setRun(id, index, role, outcome)
      }
    } catch (error) {
      this.deps.log?.(`[webui] WARNING: skill replay ${id} stopped: ${String(error)}`)
    } finally {
      this.running.delete(id)
    }
  }

  private close(job: StoredJob, state: StoredState, detail: string): StoredJob {
    const settle = (run: Run): Run => run.status === 'pending' ? { status: 'skipped', detail, result: null }
      : run.status === 'dispatched' ? { status: 'unknown', detail, result: null } : run
    return { ...job, state, updated_at: this.now().toISOString(), cases: job.cases.map((row) => ({ ...row, baseline: settle(row.baseline), candidate: settle(row.candidate) })) }
  }

  private setRun(id: string, index: number, role: Role, run: Run): Promise<StoredJob> {
    return this.edit(id, (job) => ({ ...job, state: 'running', updated_at: this.now().toISOString(), cases: job.cases.map((row, i) => i === index ? { ...row, [role]: run } : row) }))
  }

  private edit(id: string, change: (job: StoredJob) => StoredJob): Promise<StoredJob> {
    return updateDocument(this.deps.documents, NAMESPACE, id, (value) => {
      const next = change(value as StoredJob)
      return { value: next, result: next }
    })
  }

  private async scoped(scope: ReplayScope): Promise<StoredJob[]> {
    const jobs: StoredJob[] = []
    for (const { key } of await this.deps.documents.list(NAMESPACE)) {
      const job = (await readDocument(this.deps.documents, NAMESPACE, key).catch(() => null))?.value as StoredJob | null | undefined
      if (job?.version === 1 && job.owner === scope.owner && job.profile === scope.profile) jobs.push(job)
    }
    return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
  }

  private async prune(scope: ReplayScope): Promise<void> {
    for (const job of (await this.scoped(scope)).filter((row) => !ACTIVE.has(row.state)).slice(RETAINED_PER_SCOPE)) await this.deps.documents.delete(NAMESPACE, job.id)
  }

  private async sidecarPlan(home: string, input: { name: string; baseline: string; candidate: string }): Promise<Plan> {
    const unavailable: Plan = { state: 'unavailable', reason: 'backend_unavailable', revisions: [], cases: [], unavailable_cases: 0, route: null, max_output_tokens: 1 }
    const sidecar = this.deps.sidecar()
    if (sidecar?.status !== 'ready') return unavailable
    try { return await sidecar.call('skills.replay_plan', { profile_home: home, name: input.name, baseline: input.baseline, candidate: input.candidate }) }
    catch (error) {
      if (error instanceof SidecarError && error.code === -32601) return unavailable
      if (error instanceof SidecarError && error.code === -32602) throw new HttpFailure(400, error.message)
      throw error
    }
  }

  private view(job: StoredJob, redact: (text: string) => string): SkillReplayJob {
    const cancelling = ACTIVE.has(job.state) && job.cancel_requested
    const shown = (run: Run): Run => ({
      status: run.status, detail: run.detail === null ? null : redact(run.detail),
      result: run.result && { ...run.result, error: run.result.error === null ? null : redact(run.result.error), content: redact(run.result.content),
        tool_calls: run.result.tool_calls.map((call) => ({ name: call.name, arguments: redact(call.arguments) })) },
    })
    const runs = job.cases.flatMap((row) => ROLES.map((role) => ({ role, run: row[role] })))
    const reported = runs.filter(({ run }) => run.result?.cost_usd != null)
    return {
      id: job.id, skill: job.skill, state: cancelling ? 'cancelling' : job.state, reason: job.reason, active: ACTIVE.has(job.state), can_cancel: ACTIVE.has(job.state) && !job.cancel_requested,
      created_at: job.created_at, updated_at: job.updated_at, revisions: job.revisions, route: job.route, budget: job.budget,
      reported_cost_usd: reported.reduce((sum, { run }) => sum + run.result!.cost_usd!, 0),
      unreported_calls: runs.filter(({ run }) => (run.status === 'completed' || run.status === 'error' || run.status === 'unknown') && run.result?.cost_usd == null).length,
      cases: job.cases.map((row) => ({ id: row.id, case_id: row.case_id, title: redact(row.title), mode: row.mode, baseline: shown(row.baseline), candidate: shown(row.candidate) })),
      summary: ROLES.map((role) => {
        const own = runs.filter((entry) => entry.role === role).map(({ run }) => run)
        const count = (test: (run: Run) => boolean): number => own.filter(test).length
        return { role, passed: count((run) => run.status === 'completed' && run.result?.passed === true), failed: count((run) => run.status === 'completed' && run.result?.passed === false),
          error: count((run) => run.status === 'error'), unknown: count((run) => run.status === 'unknown'), refused: count((run) => run.status === 'refused'),
          skipped: count((run) => run.status === 'skipped'), pending: count((run) => run.status === 'pending' || run.status === 'dispatched') }
      }),
    }
  }
}
