import { m } from '../paraglide/messages.js'
import type { Models } from '@maudecode/talaria-web-contracts'

export type ModelEntry = Models['groups'][number]['models'][number]

/** The catalog entry with this `id`: a picker option value, or a server-sent `*_option_id` (TAL-301). */
export function catalogEntryById(catalog: Models | undefined, id: string | null | undefined): ModelEntry | undefined {
  if (!id) return undefined
  for (const g of catalog?.groups ?? []) {
    const hit = [...g.models, ...(g.extra_models ?? [])].find((e) => e.id === id)
    if (hit) return hit
  }
  return undefined
}

/** The server's authority verdict stays visible in every catalog group label. */
export function catalogGroupLabel(group: Models['groups'][number]): string {
  const status = group.availability?.status
  return status === 'stale' ? `${group.provider} · ${m.catalog_last_confirmed()}` : status === 'unavailable' ? `${group.provider} · ${m.catalog_unavailable()}` : group.provider
}
