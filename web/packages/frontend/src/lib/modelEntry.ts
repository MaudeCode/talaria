import type { Models } from '@maudecode/talaria-web-contracts'

export type ModelEntry = Models['groups'][number]['models'][number]

/**
 * TAL-301: the catalog entry a stored `(model, provider)` pair names. The server splits every id once and stamps
 * `bare_id`/`provider_id`, so this is plain equality; a just-picked id sent with its `provider_id` names itself.
 */
export function catalogEntryFor(catalog: Models | undefined, model: string | null | undefined, provider: string | null | undefined): ModelEntry | undefined {
  if (!model) return undefined
  for (const g of catalog?.groups ?? []) {
    for (const e of [...g.models, ...(g.extra_models ?? [])]) if ((e.bare_id === model || e.id === model) && (e.provider_id ?? null) === (provider ?? null)) return e
  }
  return undefined
}

/** The entry a picker option value (its `id`) belongs to. */
export function catalogEntryById(catalog: Models | undefined, id: string): ModelEntry | undefined {
  for (const g of catalog?.groups ?? []) {
    const hit = [...g.models, ...(g.extra_models ?? [])].find((e) => e.id === id)
    if (hit) return hit
  }
  return undefined
}
