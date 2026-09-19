/**
 * Pure helpers over the persisted cron job shape. The status rules are the
 * legacy Tasks panel's, ported verbatim so a job classifies the same way the
 * scheduler's own state machine reads it.
 */
import type { CronJob, CronRunUsageSchema, CronStatusSchema } from '../../contracts'
import type { z } from 'zod'

export type CronState = 'running' | 'needs_attention' | 'schedule_error' | 'paused' | 'off' | 'error' | 'active'

export function jobId(job: CronJob): string {
  return job.id ?? job.job_id ?? ''
}

export function scheduleText(job: CronJob): string {
  if (typeof job.schedule === 'string') return job.schedule
  return job.schedule_display ?? job.schedule?.display ?? job.schedule?.expr ?? ''
}

function isRecurring(job: CronJob): boolean {
  if (typeof job.schedule === 'object' && job.schedule) return job.schedule.kind === 'cron' || job.schedule.kind === 'interval'
  // Legacy string schedules carry no kind; an unlimited repeat record marks the job recurring (a one-shot has times: 1).
  return typeof job.schedule === 'string' && hasUnlimitedRepeat(job)
}

/** `repeat.times == null` means "forever" in the store; a missing record is not unlimited. */
function hasUnlimitedRepeat(job: CronJob): boolean {
  return !!job.repeat && typeof job.repeat === 'object' && job.repeat.times == null
}

/** Legacy `next_run` / `last_run` (epoch or ISO) fall back for the `*_at` timestamps of newer agents. */
export function nextRunAt(job: CronJob): string | number | null {
  return job.next_run_at ?? (typeof job.next_run === 'number' || typeof job.next_run === 'string' ? job.next_run : null)
}
export function lastRunAt(job: CronJob): string | number | null {
  return job.last_run_at ?? (typeof job.last_run === 'number' || typeof job.last_run === 'string' ? job.last_run : null)
}

export function cronState(job: CronJob, running = false): CronState {
  // Older agents report `paused` / `status` / `running` on the job instead of `state` / `last_status` / the status map; all stay supported.
  const errored = job.state === 'error' || job.last_status === 'error' || job.status === 'error'
  if (running || job.running) return 'running'
  if (isRecurring(job) && hasUnlimitedRepeat(job) && job.enabled === false && job.state === 'completed' && !nextRunAt(job)) return 'needs_attention'
  // A paused job keeps the last run's error and has no next run; that is not a schedule failure.
  if (job.state === 'paused' || job.paused) return 'paused'
  if (isRecurring(job) && !nextRunAt(job) && errored) return 'schedule_error'
  if (job.enabled === false) return 'off'
  if (errored) return 'error'
  return 'active'
}

export function needsAttention(state: CronState): boolean {
  return state === 'needs_attention' || state === 'schedule_error'
}

/** Schedule/status/error fields only: never the prompt, origin, or delivery targets. */
export function cronDiagnostics(job: CronJob): string {
  return JSON.stringify({
    id: job.id ?? null,
    name: job.name || null,
    schedule: job.schedule ?? null,
    schedule_display: job.schedule_display || null,
    enabled: job.enabled ?? null,
    state: job.state ?? null,
    next_run_at: job.next_run_at || null,
    last_run_at: job.last_run_at || null,
    last_status: job.last_status || null,
    last_error: job.last_error || null,
    last_delivery_error: job.last_delivery_error || null,
    repeat: job.repeat ?? null,
    deliver: job.deliver || null,
  }, null, 2)
}

export function contextFromList(job: CronJob): string[] {
  const raw = job.context_from
  const refs = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw.trim()] : []
  return refs.filter((ref) => ref.toLowerCase() !== 'self')
}

export function runningIds(status: z.infer<typeof CronStatusSchema> | undefined): Set<string> {
  return new Set(status && typeof status.running === 'object' ? Object.keys(status.running) : [])
}

const compact = (n: number | null | undefined): string => {
  const v = n ?? 0
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

export function usageStrip(usage: z.infer<typeof CronRunUsageSchema> | undefined): string {
  if (!usage) return ''
  const parts: string[] = []
  const input = compact(usage.input_tokens)
  const output = compact(usage.output_tokens)
  const total = compact(usage.total_tokens)
  if (input || output) parts.push(`${input || '0'} in · ${output || '0'} out`)
  else if (total) parts.push(`${total} tokens`)
  const cost = Number(usage.estimated_cost_usd)
  if (Number.isFinite(cost) && cost > 0) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`)
  if (usage.model) parts.push(usage.model)
  return parts.join(' · ')
}

/** Model ids from /api/models are `@provider:model` outside the default group; the store keeps the pair split. */
export function modelOptionValue(model: string | null | undefined, provider: string | null | undefined): string {
  if (!model) return ''
  return provider && !model.startsWith('@') ? `@${provider}:${model}` : model
}

/** The picker entry for a stored pair: exact id, else the bare id (default-group models carry no prefix), else the raw value. */
export function modelOptionFor(value: string, known: ReadonlySet<string>): string {
  if (!value || known.has(value)) return value
  const bare = /^@[^:]+:(.+)$/.exec(value)?.[1]
  return bare && known.has(bare) ? bare : value
}

export function splitModelOption(value: string, providerOf: (id: string) => string | null): { model: string | null; provider: string | null } {
  if (!value) return { model: null, provider: null }
  const provider = providerOf(value)
  if (provider && value.startsWith(`@${provider}:`)) return { model: value.slice(provider.length + 2), provider }
  const prefixed = /^@([^:]+):(.+)$/.exec(value)
  if (prefixed) return { model: prefixed[2] ?? null, provider: prefixed[1] ?? null }
  return { model: value, provider }
}

/** The agent's reply from a run file: everything after the `## Response` heading, else the whole text. */
export function runResponse(content: string): string {
  const idx = content.search(/^#{1,2} Response\s*$/m)
  if (idx < 0) return content.trim()
  const afterHeading = content.indexOf('\n', idx)
  return afterHeading < 0 ? '' : content.slice(afterHeading + 1).trim()
}
