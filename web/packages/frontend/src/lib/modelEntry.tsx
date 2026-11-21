import { useLocale } from '../i18n/useLocale'
import { m } from '../paraglide/messages.js'
import { isLocale } from '../paraglide/runtime.js'
import type { Models } from '@maudecode/talaria-web-contracts'

export type ModelEntry = Models['groups'][number]['models'][number]

/** The catalog entry with this `id`: a picker option value, or a server-sent `*_option_id` (TAL-301). */
export function catalogEntryById(catalog: Models | undefined, id: string | null | undefined): ModelEntry | undefined {
  if (!id) return undefined
  for (const g of catalog?.groups ?? []) {
    const hit = g.models.find((e) => e.id === id)
    if (hit) return hit
  }
  return undefined
}

/** The server's authority verdict stays visible in every catalog group label. */
export function catalogGroupLabel(group: Models['groups'][number]): string {
  const status = group.availability?.status
  return status === 'stale' ? `${group.provider} · ${m.catalog_last_confirmed()}` : status === 'unavailable' ? `${group.provider} · ${m.catalog_unavailable()}` : group.provider
}

/** Localized wording for the server's allowance verdict, shared by every model row. */
function allowanceLabel(allowance: ModelEntry['allowance'], locale?: string): string {
  if (!allowance) return ''
  const options = locale && isLocale(locale) ? { locale } : undefined
  const level = allowance.usage_level === 'free' ? m.plan_free({}, options) : allowance.usage_level === 'top_tier' ? m.plan_large({}, options) : null
  const state = { included: m.plan_included, free: null, blocked: m.plan_blocked, credits: m.plan_credits, unknown: m.plan_unknown }[allowance.state]
  return [level, state?.({}, options)].filter(Boolean).join(' · ')
}

/** Localized wording for the server's configured role (TAL-2258): Main, or Fallback N. */
function roleLabel(role: ModelEntry['configured_role'], locale?: string): string {
  if (!role) return ''
  const options = locale && isLocale(locale) ? { locale } : undefined
  return role.kind === 'main' ? m.model_role_main({}, options) : m.model_role_fallback({ position: String(role.position) }, options)
}

/** The row's secondary text: its configured role, then its allowance. */
function optionDetail(entry: ModelEntry, locale?: string): string {
  return [roleLabel(entry.configured_role, locale), allowanceLabel(entry.allowance, locale)].filter(Boolean).join(' · ')
}

export function modelOptionLabel(entry: ModelEntry, locale?: string): string {
  return [entry.label ?? entry.id, optionDetail(entry, locale)].filter(Boolean).join(' · ')
}

/** Shared noninteractive content for MenuRadioItem, Select options and model-choice buttons. */
export function ModelOptionContent({ entry }: { entry: ModelEntry }) {
  const locale = useLocale()
  const name = entry.label ?? entry.id
  const role = roleLabel(entry.configured_role, locale)
  const allowance = allowanceLabel(entry.allowance, locale)
  if (!role && !allowance) return <span className="min-w-0 truncate" title={name}>{name}</span>
  const tone = entry.allowance?.state === 'blocked' ? 'text-error' : entry.allowance?.state === 'credits' ? 'text-warning' : 'text-muted'
  return <span className="flex min-w-0 flex-1 items-center gap-1.5 pe-0.5" title={modelOptionLabel(entry, locale)}>
    <span className="min-w-0 flex-1 truncate">{name}</span>
    {' · '}
    <span className="max-w-[65%] shrink-0 whitespace-normal text-end text-xs leading-tight text-muted">{role}{role && allowance && ' · '}{allowance && <span className={tone}>{allowance}</span>}</span>
  </span>
}

/** Join the server's section membership to its rows; the server searches (TAL-2481). */
export function catalogModelSections(group: Models['groups'][number]) {
  const rows = group.models
  if (!group.sections) return [{ label: '', models: rows }]
  return group.sections.map((section) => ({ label: section.kind === 'recommended' ? m.plan_recommended() : m.plan_other(),
    models: section.model_ids.map((id) => rows.find((entry) => entry.id === id)).filter((entry): entry is ModelEntry => !!entry),
  })).filter((section) => section.models.length)
}
