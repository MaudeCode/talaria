import { ModelOptionContent } from '../../lib/modelEntry'
import { useProviderQuotas } from '../../lib/useProviderQuotas'
import { memo, useRef, useState, type ReactNode } from 'react'
import { useDebounced } from '../../lib/useDebounced'
import { sameRowProps } from '../../lib/sameRowProps'
import type { z } from 'zod'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useDefaultModelChoice, useSetDefaultModel } from '../../app/queries'
import { post } from '../../api/client'
import { OkSchema, type ProviderSchema } from '../../contracts'
import { Button, IconButton } from '../../ui/Button'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { FieldRow, TextInput } from '../../ui/Field'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { Badge } from '../../ui/Badge'
import { Row, RowList, SectionHeader } from '../../ui/List'
import { quotaSourcePlan, type QuotaSource } from '../insights/QuotaMeter'
import { useSettingField } from './useSettingField'
import { OpenRouterCost } from './OpenRouterCost'
import { ProviderQuotaPace } from './ProviderQuotaPace'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'
import { usePluginInstall } from './usePluginInstall'
import { QuotaThresholdsForm } from './QuotaThresholds'

const setProviderKey = (provider: string, api_key: string | null) => post('api/providers', { provider, api_key }, OkSchema, { retries: 0 })


/** TAL-2100: Settings > Providers, one row per provider the Agent knows, then the quota thresholds. TAL-2077: configured providers first, then the rest, under one name filter. */
export function ProvidersPage() {
  return (
    <div className="flex flex-col gap-7" data-section="providers">
      <ProvidersSection />
      <QuotaThresholdsForm />
    </div>
  )
}

export function ProvidersSection() {
  const qc = useQueryClient()
  const reads = useRef(0)
  const [filter, setFilter] = useState('')
  const q = useDebounced(filter.trim(), 250)
  const providers = useQuery({ queryKey: [...keys.providers, { q }], queryFn: () => { reads.current += 1; return api.fetchProviders(q) }, staleTime: 30_000, placeholderData: keepPreviousData, refetchInterval: (query) => {
    const interval = query.state.data?.providers.find((p) => p.id === 'nous')?.nous_account?.poll_after
    return interval && reads.current < 120 ? interval * 1000 : false
  } })
  const { quotas, refresh: refreshQuotas } = useProviderQuotas()
  const { str } = useSettingField(['default_model'])
  const setDefault = useSetDefaultModel()
  const chosenModel = useDefaultModelChoice()?.model
  const [editing, setEditing] = useState<string | null>(null)
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.providers }); void qc.invalidateQueries({ queryKey: keys.models }) }
  const toastError = (e: unknown) => showErrorToast(e)
  const saveKey = useMutation({ mutationFn: ({ id, key }: { id: string; key: string | null }) => setProviderKey(id, key), onSuccess: (_r, v) => { showToast(v.key ? m.providers_key_saved() : m.providers_key_removed()); setEditing(null); invalidate() }, onError: toastError })
  // The server also makes the model the default, so settings reread with the provider list.
  const saveHosted = useMutation({
    mutationFn: ({ id, base_url, model, api_key }: { id: string; name: string; base_url: string; model: string; api_key?: string }) => api.saveSelfHostedProvider({ provider: id, base_url, model, ...(api_key ? { api_key } : {}) }),
    onSuccess: (_r, v) => { showToast(m.providers_self_hosted_saved({ provider: v.name })); setEditing(null); invalidate(); void qc.invalidateQueries({ queryKey: keys.settings }) },
    onError: toastError,
  })
  const install = usePluginInstall()
  const refreshModels = useMutation({ mutationFn: (id: string) => api.refreshModels(id), onSuccess: () => { showToast(m.providers_models_refreshed()); invalidate() }, onError: toastError })
  if (providers.isPending) return <LoadingState />
  if (providers.isError && !providers.data) return <ErrorState error={providers.error} onRetry={() => { void providers.refetch() }} />
  const active = providers.data.active_provider
  const defaultModel = chosenModel ?? str('default_model')
  const quotaNotice = quotas.data?.availability?.unavailable_reason ?? providers.data.availability?.unavailable_reason
  const rows = new Map(providers.data.providers.map((p) => [p.id, p]))
  const titles = { configured: m.providers_group_configured(), available: m.providers_group_available() }
  const catalogUnavailable = providers.data.availability?.authoritative === false
  return (
    <div className="flex flex-col gap-3" data-group="providers">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{m.providers_active()}: <strong className="text-text">{active ?? '—'}</strong></span>
        <Button onClick={() => { void refreshQuotas() }}>{m.providers_quota_refresh()}</Button>
      </div>
      {providers.isError && <p role="alert" className="text-warning">{m.oauth_result_unavailable()}</p>}
      {quotaNotice && <p role="status" className="text-xs text-muted">{quotaNotice}</p>}
      <TextInput type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.providers_filter()} aria-label={m.providers_filter()} />
      {providers.data.providers.length === 0 && <EmptyState>{q ? m.providers_filter_empty() : m.providers_empty()}</EmptyState>}
      {providers.data.groups?.map(({ id: name, provider_ids }) => (
        <section key={name} className="flex flex-col gap-1" data-section={`providers-${name}`}>
          <SectionHeader detail={provider_ids.length}>{titles[name]}</SectionHeader>
          <RowList>
            {provider_ids.map((id) => {
              const p = rows.get(id)
              if (!p) return null
              const hint = p.install_hint
              return <ProviderRow key={p.id} p={p} compact={name === 'available'} quotaSources={quotas.data?.sources} quotaNotice={quotaNotice} catalogUnavailable={catalogUnavailable} defaultModel={defaultModel}
                editing={editing === p.id} onEdit={setEditing} onInvalidate={invalidate} onSetDefault={setDefault.mutate}
                onRefresh={refreshModels.mutate} refreshBusy={refreshModels.isPending} refreshing={refreshModels.isPending && refreshModels.variables === p.id}
                onSaveKey={saveKey.mutate} keySaving={saveKey.isPending} onSaveHosted={saveHosted.mutate} hostedSaving={saveHosted.isPending}
                onInstall={install.request} installing={hint ? install.isInstalling(hint) : false} installBlocked={hint ? install.blocked(hint) : null} />
            })}
          </RowList>
        </section>
      ))}
      {install.consent}
    </div>
  )
}

type Provider = z.infer<typeof ProviderSchema>
interface ProviderRowProps {
  p: Provider
  /** The Available group's one-line row (§3 Grouping). */
  compact: boolean
  quotaSources: QuotaSource[] | undefined
  quotaNotice: string | null | undefined
  catalogUnavailable: boolean
  defaultModel: string | undefined
  editing: boolean
  onEdit: (id: string | null) => void
  onInvalidate: () => void
  onSetDefault: (choice: { model: string; provider: string }) => void
  onRefresh: (id: string) => void
  refreshBusy: boolean
  refreshing: boolean
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
const ProviderRow = memo(function ProviderRow({ p, compact, quotaSources, quotaNotice, catalogUnavailable, defaultModel, editing, onEdit, onInvalidate, onSetDefault, onRefresh, refreshBusy, refreshing, onSaveKey, keySaving, onSaveHosted, hostedSaving, onInstall, installing, installBlocked }: ProviderRowProps) {
  const sources = quotaSources?.filter((s) => s.provider_id === p.id) ?? []
  const quota = sources[0]
  const plan = quotaSourcePlan(quota)
  const hint = p.install_hint
  const name = p.display_name ?? p.id
  // One list for the visible controls and the right-click and long-press menu.
  const refresh: RowAction = { label: m.providers_refresh_models(), run: () => onRefresh(p.id), busy: refreshBusy }
  const actions: RowAction[] = [
    ...(hint ? [{ label: m.providers_install_plugin(), run: () => onInstall(hint), busy: installing }] : []),
    ...(p.is_self_hosted ? [{ label: m.providers_self_hosted_setup(), run: () => onEdit(editing ? null : p.id) }]
      : p.configurable !== false && !p.is_oauth ? [{ label: m.providers_key_set(), run: () => onEdit(editing ? null : p.id) }] : []),
    ...(p.removable === true ? [{ label: m.providers_key_remove(), run: () => onSaveKey({ id: p.id, key: null }), danger: true }] : []),
  ]
  const status = <>
    {catalogUnavailable ? m.catalog_unavailable() : (p.configured ?? p.has_key) ? m.providers_configured() : m.providers_not_configured()}{p.key_source_kind ? ` · ${p.key_source_kind === 'other' ? p.key_source : p.key_source_kind}` : ''}{p.base_url ? ` · ${p.base_url}` : ''}{p.models_total !== undefined ? ` · ${m.providers_models_count({ n: p.models_total })}` : ''}
    {!quotaNotice && quota?.message ? ` · ${quota.message}` : ''}
  </>
  return (
    <RowContextMenu label={m.providers_row_menu()} actions={[refresh, ...actions]} trigger={<Row compact={compact} data-provider={p.id}>
      <div className={cn('flex w-full flex-col', compact ? 'gap-2' : 'gap-4')}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={compact ? 'font-medium text-text' : 'text-sm font-semibold text-text'}>{name}</span>
              {plan && <Badge tone="border-border text-muted">{plan}</Badge>}
              {p.is_active && <Badge tone="border-accent text-accent-text">{m.provider_quota_active_provider()}</Badge>}
              {compact && <span className="text-muted">{status}</span>}
            </div>
            {!compact && <div className="text-[11px] text-muted">{status}</div>}
            {p.auth_error && <div className="text-[11px] text-error">{p.auth_error}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <IconButton label={refresh.label} disabled={refresh.busy} onClick={refresh.run}>
              <RefreshCw size={14} aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
            </IconButton>
            {actions.map(({ label, run, busy, danger }) => <Button key={label} {...(danger ? { variant: 'ghost-danger' as const } : {})} {...(busy ? { 'aria-busy': true, disabled: true } : {})} onClick={run}>{label}</Button>)}
          </div>
        </div>
        {installBlocked}
        {p.id === 'nous' && <OAuthSignIn provider={p.id} label={name} signedIn={p.has_key === true} account={p.nous_account ?? null} accountError={p.nous_account_error ?? null} resultOnly compact idPrefix="providersNousOauth" onApproved={onInvalidate} />}
        {p.device_login && <OAuthSignIn provider={p.id} label={name} signedIn={p.has_key === true} idPrefix={`providerOauth-${p.id}`} onApproved={onInvalidate} />}
        {editing && p.is_self_hosted && <SelfHostedForm key={p.id} id={p.id} baseUrl={p.base_url ?? ''} saving={hostedSaving} onSubmit={(body) => onSaveHosted({ id: p.id, name, ...body })} />}
        {editing && !p.is_self_hosted && <ProviderKeyForm key={p.id} label={`${name} API key`} hasKey={p.has_key === true} saving={keySaving} onSubmit={(key) => onSaveKey({ id: p.id, key })} />}
        {sources.map((s) => <ProviderQuotaPace key={s.source_id} source={s} showAccount={sources.length > 1} />)}
        {p.id === 'openrouter' && p.has_key && <OpenRouterCost />}
        {p.models && p.models.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted">{m.providers_models_count({ n: p.models.length })}</summary>
            <ul className="mt-1 flex flex-wrap gap-1">
              {p.models.map((mm) => (
                <li key={mm.id}>
                  <button type="button" onClick={() => onSetDefault({ model: mm.id, provider: p.id })} className={cn('rounded-full border px-2 py-0.5 text-[11px]', mm.id === defaultModel ? 'border-accent bg-accent-bg text-accent-text' : 'border-border text-muted hover:text-text')} title={m.providers_set_default()}><ModelOptionContent entry={mm} /></button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Row>} />
  )
}, sameRowProps<ProviderRowProps>('p'))

function ProviderKeyForm({ label, hasKey, saving, onSubmit }: { label: string; hasKey: boolean; saving: boolean; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()) }} className="flex gap-2">
      <TextInput type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={hasKey ? m.providers_key_placeholder_replace() : m.providers_key_placeholder_new()} aria-label={label} />
      <Button type="submit" variant="primary" disabled={saving}>{m.save()}</Button>
    </form>
  )
}

// Self-hosted setup also needs an endpoint and model, unlike ProviderKeyForm.
function SelfHostedForm({ id, baseUrl, saving, onSubmit }: { id: string; baseUrl: string; saving: boolean; onSubmit: (body: { base_url: string; model: string; api_key?: string }) => void }) {
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
      <Button type="submit" variant="primary" className="self-end" disabled={saving}>{m.save()}</Button>
    </form>
  )
}
