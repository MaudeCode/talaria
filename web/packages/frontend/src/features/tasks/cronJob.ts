/** Pure display helpers over the cron job view. The server derives each job's status (`derived_state`, TAL-296) and schedule text (`schedule_display` / `schedule_input`, TAL-298). */
import type { CronJob, CronRunUsageSchema, CronStatusSchema } from '../../contracts'
import type { z } from 'zod'

export type CronState = 'running' | NonNullable<CronJob['derived_state']> | 'unknown'

export function jobId(job: CronJob): string {
  return job.id ?? job.job_id ?? ''
}

/** Legacy `next_run` / `last_run` (epoch or ISO) fall back for the `*_at` timestamps of newer agents. */
export function nextRunAt(job: CronJob): string | number | null {
  return job.next_run_at ?? (typeof job.next_run === 'number' || typeof job.next_run === 'string' ? job.next_run : null)
}
export function lastRunAt(job: CronJob): string | number | null {
  return job.last_run_at ?? (typeof job.last_run === 'number' || typeof job.last_run === 'string' ? job.last_run : null)
}

/** A live run overlays the server's state; a server that omits it shows a neutral status. */
export function cronState(job: CronJob, running = false): CronState {
  if (running || job.running) return 'running'
  return job.derived_state ?? 'unknown'
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

/** The agent's reply from a run file: everything after the `## Response` heading, else the whole text. */
export function runResponse(content: string): string {
  const idx = content.search(/^#{1,2} Response\s*$/m)
  if (idx < 0) return content.trim()
  const afterHeading = content.indexOf('\n', idx)
  return afterHeading < 0 ? '' : content.slice(afterHeading + 1).trim()
}
