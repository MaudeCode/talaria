import { useProviderQuotas } from '../../lib/useProviderQuotas'
import { memo, useRef, useState, type ReactNode } from 'react'
import { useDebounced } from '../../lib/useDebounced'
import { sameRowProps } from '../../lib/sameRowProps'
import type { z } from 'zod'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, ChevronRight, Download, KeyRound, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { post } from '../../api/client'
import { OkSchema, type ProviderSchema, type QuotaLevel } from '../../contracts'
import { IconButton } from '../../ui/Button'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { FieldRow, TextInput } from '../../ui/Field'
import { EmptyState, ErrorState, LoadingState, formatUsd } from '../../ui/States'
import { Mark, StatusDot } from '../../ui/Badge'
import { Figure, Row, RowList, SectionHeader, type FigureTone } from '../../ui/List'
import { Monogram } from '../../ui/Monogram'
import { HubPage } from '../../shell/AppShell'
import { useLocale } from '../../i18n/useLocale'
import { formatPercent } from '../../i18n/units'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { BarChart } from '../insights/BarChart'
import { quotaSourcePlan, type QuotaSource } from '../insights/QuotaMeter'
import { QuotaWindowMeter } from '../insights/ProviderQuotaRows'
import { SETTINGS_PAGE, SettingsGroup, SettingsStats, type SettingsStat } from './SettingsGroup'
import { useOpenRouterCostHistory } from './OpenRouterCost'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'
import { usePluginInstall } from './usePluginInstall'
import { QuotaThresholdsForm } from './QuotaThresholds'

const setProviderKey = (provider: string, api_key: string | null) => post('api/providers', { provider, api_key }, OkSchema, { retries: 0 })

export type Provider = z.infer<typeof ProviderSchema>

/** A server quota level as a figure's tone (§5); a healthy, stale or unavailable level keeps the plain figure. */
export const LEVEL_TONE: Partial<Record<QuotaLevel, FigureTone>> = { warning: 'warning', critical: 'error' }

/** The providers list, unfiltered; the list's Your providers group and a provider's own page share it. */
export const useProviders = (q = '') => {
  const reads = useRef(0)
  return useQuery({ queryKey: [...keys.providers, { q }], queryFn: () => { reads.current += 1; return api.fetchProviders(q) }, staleTime: 30_000, placeholderData: keepPreviousData, refetchInterval: (query) => {
    const interval = query.state.data?.providers.find((p) => p.id === 'nous')?.nous_account?.poll_after
    return interval && reads.current < 120 ? interval * 1000 : false
  } })
}

/** The writes a provider's row and its own page offer, each rereading the providers and models it changes. */
export function useProviderWrites({ onSaved }: { onSaved?: () => void } = {}) {
  const qc = useQueryClient()
  const onError = (e: unknown) => showErrorToast(e)
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.providers }); void qc.invalidateQueries({ queryKey: keys.models }) }
  const saveKey = useMutation({ mutationFn: ({ id, key }: { id: string; key: string | null }) => setProviderKey(id, key), onSuccess: (_r, v) => { showToast(v.key ? m.providers_key_saved() : m.providers_key_removed()); onSaved?.(); invalidate() }, onError })
  // The server also makes the model the default, so settings reread with the provider list.
  const saveHosted = useMutation({
    mutationFn: ({ id, base_url, model, api_key }: { id: string; name: string; base_url: string; model: string; api_key?: string }) => api.saveSelfHostedProvider({ provider: id, base_url, model, ...(api_key ? { api_key } : {}) }),
    onSuccess: (_r, v) => { showToast(m.providers_self_hosted_saved({ provider: v.name })); onSaved?.(); invalidate(); void qc.invalidateQueries({ queryKey: keys.settings }) },
    onError,
  })
  const refreshModels = useMutation({ mutationFn: (id: string) => api.refreshModels(id), onSuccess: () => { showToast(m.providers_models_refreshed()); invalidate() }, onError })
  return { invalidate, saveKey, saveHosted, refreshModels }
}

/** Where a provider's credential comes from, in words: the server's kind, else its own `key_source`. */
export function keySourceText(p: Provider): string | null {
  switch (p.key_source_kind) {
    case 'env': return m.providers_key_from_env()
    case 'config': return m.providers_key_from_config()
    case 'oauth': case 'plugin': return m.providers_signed_in()
    case 'pool': return m.provider_quota_credential_pool()
    case 'other': return p.key_source ?? null
    default: return p.base_url ?? null
  }
}

/**
 * A provider's state as a dot and its words (§7), from the server's fields: its sign-in error; a catalog the server could not
 * confirm (`availability.authoritative` false), whose last-known rows are not vouched for; not configured; else ready with
 * where its key comes from.
 */
export function ProviderStatus({ p, catalogUnavailable, extra }: { p: Provider; catalogUnavailable: boolean; extra?: string | null }) {
  if (p.auth_error) return <StatusDot state="error" title={p.auth_error}>{p.auth_error}</StatusDot>
  if (catalogUnavailable) return <StatusDot state="warning">{m.catalog_unavailable()}</StatusDot>
  if (!(p.configured ?? p.has_key)) return <StatusDot state="idle">{m.providers_not_configured()}</StatusDot>
  const words = [keySourceText(p) ?? m.providers_configured(), extra].filter(Boolean).join(' · ')
  return <StatusDot state="ok" title={words}>{words}</StatusDot>
}

/** TAL-2100, TAL-2135: Settings › Providers: the server's figures, the configured providers as blocks that open their own page, the providers to add, then the quota thresholds. */
export function ProvidersPage() {
  const { quotas, refresh } = useProviderQuotas()
  const locale = useLocale()
  const summary = quotas.data?.summary
  const stats: SettingsStat[] = summary ? [
    { id: 'connected', label: m.providers_stat_connected(), value: String(summary.connected) },
    ...(summary.lowest ? [{ id: 'lowest', label: m.providers_stat_lowest(), value: formatPercent(locale, summary.lowest.percent_remaining), mode: m.providers_figure_left(), tone: LEVEL_TONE[summary.lowest.level] }] : []),
    ...(summary.spend_month !== null ? [{ id: 'spend', label: m.providers_stat_spend(), value: formatUsd(summary.spend_month, locale, 2) }] : []),
    ...(summary.default_provider_name ? [{ id: 'default', label: m.providers_stat_default(), value: summary.default_provider_name, title: summary.default_provider_name }] : []),
  ] : []
  return (
    <HubPage title={m.settings_section_providers_title()} actions={<IconButton variant="ghost" tooltipSide="bottom" label={m.providers_quota_refresh()} onClick={() => { void refresh() }}><RefreshCw aria-hidden="true" /></IconButton>}>
      <div className={SETTINGS_PAGE} data-section="providers">
        {stats.length > 0 && <SettingsStats label={m.settings_section_providers_title()} stats={stats} />}
        <ProvidersSection />
        <QuotaThresholdsForm />
      </div>
    </HubPage>
  )
}

export function ProvidersSection() {
  const [filter, setFilter] = useState('')
  const q = useDebounced(filter.trim(), 250)
  // Your providers stays put while the filter narrows the providers to add.
  const all = useProviders()
  const providers = useProviders(q)
  const { quotas } = useProviderQuotas()
  const cost = useOpenRouterCostHistory(all.data?.providers.some((p) => p.id === 'openrouter' && p.has_key === true && p.configured === true) === true)
  const [editing, setEditing] = useState<string | null>(null)
  const { saveKey, saveHosted, refreshModels, invalidate } = useProviderWrites({ onSaved: () => setEditing(null) })
  const install = usePluginInstall()
  if (providers.isPending || all.isPending) return <LoadingState />
  if (providers.isError && !providers.data) return <ErrorState error={providers.error} onRetry={() => { void providers.refetch() }} />
  const quotaNotice = quotas.data?.availability?.unavailable_reason ?? providers.data.availability?.unavailable_reason
  const catalogUnavailable = providers.data.availability?.authoritative === false
  const rows = (data: typeof providers.data | undefined) => new Map((data?.providers ?? []).map((p) => [p.id, p]))
  const yours = all.data?.groups?.find((g) => g.id === 'configured')?.provider_ids ?? []
  const byId = rows(all.data)
  const available = providers.data.groups?.find((g) => g.id === 'available')
  const availableRows = rows(providers.data)
  return (
    <div className="flex flex-col gap-7.5" data-group="providers">
      {providers.isError && <p role="alert" className="text-warning">{m.oauth_result_unavailable()}</p>}
      {quotaNotice && <p role="status" className="text-xs text-muted">{quotaNotice}</p>}
      {yours.length > 0 && (
        <SettingsGroup id="providers-configured" section="providers-configured" title={m.providers_group_yours()} detail={yours.length}>
          <RowList>
            {yours.map((id) => {
              const p = byId.get(id)
              return p && <ConfiguredProvider key={id} p={p} catalogUnavailable={all.data?.availability?.authoritative === false} sources={quotas.data?.sources?.filter((s) => s.provider_id === id) ?? []} cost={id === 'openrouter' && p.has_key ? cost.data : undefined} spend={quotas.data?.summary?.spend_month ?? null}
                onRefresh={refreshModels.mutate} refreshBusy={refreshModels.isPending} />
            })}
          </RowList>
        </SettingsGroup>
      )}
      <div className="flex flex-col gap-3">
        <TextInput type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.providers_filter()} aria-label={m.providers_filter()} />
        {providers.data.providers.length === 0 && <EmptyState compact>{q ? m.providers_filter_empty() : m.providers_empty()}</EmptyState>}
        {available && (
          <section className="flex flex-col gap-1" data-section="providers-available">
            <SectionHeader detail={available.provider_ids.length}>{m.providers_group_available()}</SectionHeader>
            <RowList>
              {available.provider_ids.map((id) => {
                const p = availableRows.get(id)
                if (!p) return null
                const hint = p.install_hint
                return <ProviderRow key={p.id} p={p} catalogUnavailable={catalogUnavailable}
                  editing={editing === p.id} onEdit={setEditing} onInvalidate={invalidate}
                  onRefresh={refreshModels.mutate} refreshBusy={refreshModels.isPending}
                  onSaveKey={saveKey.mutate} keySaving={saveKey.isPending} onSaveHosted={saveHosted.mutate} hostedSaving={saveHosted.isPending}
                  onInstall={install.request} installing={hint ? install.isInstalling(hint) : false} installBlocked={hint ? install.blocked(hint) : null} />
              })}
            </RowList>
          </section>
        )}
      </div>
      {install.consent}
    </div>
  )
}

type CostHistory = ReturnType<typeof useOpenRouterCostHistory>['data']

/**
 * TAL-2135: a configured provider as one block that opens its own page: monogram, name and Default mark, its state with the
 * key source and plan, one headline figure, then the headline window's meter (a quota) or the daily spend (OpenRouter).
 * The name is the link; it covers the block, so the block has no other control. Its context menu keeps Refresh models.
 */
function ConfiguredProvider({ p, catalogUnavailable, sources, cost, spend, onRefresh, refreshBusy }: { p: Provider; catalogUnavailable: boolean; sources: QuotaSource[]; cost: CostHistory; spend: number | null; onRefresh: (id: string) => void; refreshBusy: boolean }) {
  const locale = useLocale()
  const name = p.display_name ?? p.id
  // The account the server headlines for this provider (`provider_headline`).
  const source = sources.find((s) => s.provider_headline)
  const w = source?.headline_window_index == null ? undefined : source.windows?.[source.headline_window_index]
  const left = w?.remaining_percent ?? null
  const budget = cost?.monthly_budget ?? null
  const snapshots = cost?.snapshots ?? []
  // The newest day the server recorded, named by its own UTC date.
  const latest = snapshots.at(-1)
  const actions = [{ label: m.providers_refresh_models(), run: () => onRefresh(p.id), busy: refreshBusy, icon: RefreshCw }] satisfies RowAction[]
  const figure = w && left !== null
    ? <Figure value={formatPercent(locale, left)} mode={m.providers_figure_left_in({ window: w.label })} tone={LEVEL_TONE[w.display_level ?? 'healthy']} />
    : cost && spend !== null ? <Figure value={formatUsd(spend, locale, 2)} mode={budget === null ? undefined : m.providers_figure_of_budget({ budget: formatUsd(budget, locale, 0) })} /> : null
  return (
    <RowContextMenu label={m.providers_row_menu()} actions={actions} trigger={<Row className="relative gap-3" data-provider={p.id}>
      <div className="flex items-center gap-3">
        <Monogram name={name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <Link to="/settings/providers/$providerId" params={{ providerId: p.id }} state={{ providersList: true }} className="truncate text-sm font-semibold text-text outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-accent">{name}</Link>
            {p.is_active && <Mark>{m.providers_default()}</Mark>}
          </div>
          <div className="flex min-w-0"><ProviderStatus p={p} catalogUnavailable={catalogUnavailable} extra={quotaSourcePlan(source)} /></div>
        </div>
        {figure && <span className="shrink-0">{figure}</span>}
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
      </div>
      {source && w && <div className="flex flex-col gap-1.5"><QuotaWindowMeter window={w} source={source} mode="remaining" locale={locale} /></div>}
      {!w && cost?.has_enough_data && snapshots.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <BarChart compact id={`provider-spend-${p.id}`} title={m.providers_daily_spend({ n: cost.window_days ?? snapshots.length })} format={(v) => formatUsd(v, locale, 2)}
            rows={snapshots.map((s) => ({ label: s.date.slice(5), title: s.date, value: s.delta ?? 0, display: s.delta === null ? m.provider_cost_no_baseline() : formatUsd(s.delta, locale, 2) }))} />
          <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
            <span>{m.providers_daily_spend({ n: cost.window_days ?? snapshots.length })}</span>
            {latest?.delta != null && <span className="tabular-nums">{m.providers_day_spend({ day: new Date(`${latest.date}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }), amount: formatUsd(latest.delta, locale, 2) })}</span>}
          </div>
        </div>
      )}
    </Row>} />
  )
}

interface ProviderRowProps {
  p: Provider
  catalogUnavailable: boolean
  editing: boolean
  onEdit: (id: string | null) => void
  onInvalidate: () => void
  onRefresh: (id: string) => void
  refreshBusy: boolean
  onSaveKey: (value: { id: string; key: string | null }) => void
  keySaving: boolean
  onSaveHosted: (value: { id: string; name: string; base_url: string; model: string; api_key?: string }) => void
  hostedSaving: boolean
  onInstall: (name: string) => void
  installing: boolean
  installBlocked: ReactNode
}

// Memoized so typing in the filter renders only the rows entering the list (TAL-1405). Each filter answer is a new
// response (TAL-2127), so `p` compares by value.
/** A provider to add: one line with its state and its setup actions (§3 Grouping). */
const ProviderRow = memo(function ProviderRow({ p, catalogUnavailable, editing, onEdit, onInvalidate, onRefresh, refreshBusy, onSaveKey, keySaving, onSaveHosted, hostedSaving, onInstall, installing, installBlocked }: ProviderRowProps) {
  const hint = p.install_hint
  const name = p.display_name ?? p.id
  // One list for the visible controls and the right-click and long-press menu.
  const actions = [
    { label: m.providers_refresh_models(), run: () => onRefresh(p.id), busy: refreshBusy, icon: RefreshCw },
    ...(hint ? [{ label: m.providers_install_plugin(), run: () => onInstall(hint), busy: installing, icon: Download }] : []),
    ...(p.is_self_hosted ? [{ label: m.providers_self_hosted_setup(), run: () => onEdit(editing ? null : p.id), icon: Wrench }]
      : p.configurable !== false && !p.is_oauth ? [{ label: m.providers_key_set(), run: () => onEdit(editing ? null : p.id), icon: KeyRound }] : []),
    ...(p.removable === true ? [{ label: m.providers_key_remove(), run: () => onSaveKey({ id: p.id, key: null }), danger: true, icon: Trash2 }] : []),
  ] satisfies RowAction[]
  const configured = p.configured ?? p.has_key
  // TAL-2135: the state and at most one more fact.
  const status = [catalogUnavailable ? m.catalog_unavailable() : configured ? m.providers_configured() : m.providers_not_configured(), p.base_url].filter(Boolean).join(' · ')
  return (
    <RowContextMenu label={m.providers_row_menu()} actions={actions} trigger={<Row compact data-provider={p.id}>
      <div className="flex w-full flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <span className="font-medium text-text">{name}</span>
            <div className="flex min-w-0"><StatusDot state={catalogUnavailable ? 'warning' : configured ? 'ok' : 'idle'} title={status}>{status}</StatusDot></div>
            {p.auth_error && <div className="flex min-w-0"><StatusDot state="error" title={p.auth_error}>{p.auth_error}</StatusDot></div>}
          </div>
          <RowActionButtons actions={actions} />
        </div>
        {installBlocked}
        {p.id === 'nous' && <OAuthSignIn provider={p.id} label={name} signedIn={p.has_key === true} account={p.nous_account ?? null} accountError={p.nous_account_error ?? null} resultOnly compact idPrefix="providersNousOauth" onApproved={onInvalidate} />}
        {p.device_login && <OAuthSignIn provider={p.id} label={name} signedIn={p.has_key === true} idPrefix={`providerOauth-${p.id}`} onApproved={onInvalidate} />}
        {editing && p.is_self_hosted && <SelfHostedForm key={p.id} id={p.id} baseUrl={p.base_url ?? ''} saving={hostedSaving} onSubmit={(body) => onSaveHosted({ id: p.id, name, ...body })} />}
        {editing && !p.is_self_hosted && <ProviderKeyForm key={p.id} label={m.providers_key_label({ provider: name })} hasKey={p.has_key === true} saving={keySaving} onSubmit={(key) => onSaveKey({ id: p.id, key })} />}
      </div>
    </Row>} />
  )
}, sameRowProps<ProviderRowProps>('p'))

export function ProviderKeyForm({ label, hasKey, saving, onSubmit }: { label: string; hasKey: boolean; saving: boolean; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()) }} className="flex gap-2">
      <TextInput type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={hasKey ? m.providers_key_placeholder_replace() : m.providers_key_placeholder_new()} aria-label={label} />
      <IconButton type="submit" variant="default" label={m.save()} disabled={saving}><Check aria-hidden="true" /></IconButton>
    </form>
  )
}

// Self-hosted setup also needs an endpoint and model, unlike ProviderKeyForm.
export function SelfHostedForm({ id, baseUrl, saving, onSubmit }: { id: string; baseUrl: string; saving: boolean; onSubmit: (body: { base_url: string; model: string; api_key?: string }) => void }) {
  const [hosted, setHosted] = useState({ base_url: baseUrl, api_key: '', model: '' })
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ base_url: hosted.base_url.trim(), model: hosted.model.trim(), ...(hosted.api_key.trim() ? { api_key: hosted.api_key.trim() } : {}) }) }} className="flex flex-col">
      <FieldRow label={m.onboarding_base_url_label()} hint={m.onboarding_base_url_help()} htmlFor={`${id}-base-url`}>
        <TextInput id={`${id}-base-url`} type="url" required autoComplete="off" autoFocus value={hosted.base_url} onChange={(e) => setHosted({ ...hosted, base_url: e.target.value })} placeholder={m.onboarding_base_url_placeholder()} />
      </FieldRow>
      <FieldRow label={m.onboarding_api_key_label_optional()} hint={m.onboarding_api_key_help_keyless()} htmlFor={`${id}-api-key`}>
        <TextInput id={`${id}-api-key`} type="password" autoComplete="off" value={hosted.api_key} onChange={(e) => setHosted({ ...hosted, api_key: e.target.value })} placeholder={m.onboarding_api_key_placeholder_optional()} />
      </FieldRow>
      <FieldRow label={m.onboarding_model_label()} htmlFor={`${id}-model`}>
        <TextInput id={`${id}-model`} required autoComplete="off" value={hosted.model} onChange={(e) => setHosted({ ...hosted, model: e.target.value })} />
      </FieldRow>
      <div className="flex justify-end"><IconButton type="submit" variant="default" label={m.save()} disabled={saving}><Check aria-hidden="true" /></IconButton></div>
    </form>
  )
}
