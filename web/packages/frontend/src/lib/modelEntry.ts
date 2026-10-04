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
