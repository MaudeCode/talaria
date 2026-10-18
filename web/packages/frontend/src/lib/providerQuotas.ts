import type { fetchProviderQuotas } from '../api/endpoints'

/** Unknown membership may retain cached rows only within the same scope and credential generation. */
export function reconcileProviderQuotas(previous: Awaited<ReturnType<typeof fetchProviderQuotas>> | undefined, next: Awaited<ReturnType<typeof fetchProviderQuotas>>): Awaited<ReturnType<typeof fetchProviderQuotas>> {
  if (next.availability?.authoritative !== false || !previous?.availability || previous.scope_id !== next.scope_id || previous.availability.generation !== next.availability.generation) return next
  const ids = new Set(next.sources.map((s) => s.source_id))
  const availability = next.availability
  const status = availability.status === 'stale' ? 'stale' : 'unavailable'
  return { ...next, sources: [...next.sources, ...previous.sources.filter((s) => !ids.has(s.source_id)).map((s): (typeof next.sources)[number] => ({ ...s, status, unavailable_reason: availability.unavailable_reason, urgency: { remaining: status, pace: status } }))] }
}
