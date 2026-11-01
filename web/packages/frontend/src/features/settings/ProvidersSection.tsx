import { ModelOptionContent } from '../../lib/modelEntry'
import { useProviderQuotas } from '../../lib/useProviderQuotas'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useDefaultModelChoice, useSetDefaultModel } from '../../app/queries'
import { post } from '../../api/client'
import { OkSchema } from '../../contracts'
import { Button, IconButton } from '../../ui/Button'
import { FieldRow, TextInput } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'
import { OpenRouterCost } from './OpenRouterCost'
import { ProviderQuotaPace } from './ProviderQuotaPace'
import { QuotaThresholdsForm } from './QuotaThresholds'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'

const setProviderKey = (provider: string, api_key: string | null) => post('api/providers', { provider, api_key }, OkSchema, { retries: 0 })

export function ProvidersSection() {
  const qc = useQueryClient()
  const reads = useRef(0)
  const providers = useQuery({ queryKey: keys.providers, queryFn: () => { reads.current += 1; return api.fetchProviders() }, staleTime: 30_000, refetchInterval: (query) => {
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
  const refreshModels = useMutation({ mutationFn: (id: string) => api.refreshModels(id), onSuccess: () => { showToast(m.providers_models_refreshed()); invalidate() }, onError: toastError })
  if (providers.isPending) return <LoadingState />
  if (providers.isError && !providers.data) return <ErrorState error={providers.error} onRetry={() => { void providers.refetch() }} />
  const active = providers.data.active_provider
  const defaultModel = chosenModel ?? str('default_model')
  const quotaNotice = quotas.data?.availability?.unavailable_reason ?? providers.data.availability?.unavailable_reason
  return (
    <div className="flex flex-col gap-3" data-section="providers">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{m.providers_active()}: <strong className="text-text">{active ?? '—'}</strong></span>
        <Button onClick={() => { void refreshQuotas() }}>{m.providers_quota_refresh()}</Button>
      </div>
      {providers.isError && <p role="alert" className="text-warning">{m.oauth_result_unavailable()}</p>}
      {quotaNotice && <p role="status" className="text-xs text-muted">{quotaNotice}</p>}
      <QuotaThresholdsForm />
      <ul className="flex flex-col gap-2">
        {providers.data.providers.map((p) => {
          const sources = quotas.data?.sources.filter((s) => s.provider_id === p.id) ?? []
          const quota = sources[0]
          const isEditing = editing === p.id
          return (
            <li key={p.id} className={cn('rounded-lg border border-border bg-surface p-3', p.is_active && 'border-accent-bg-strong')} data-provider={p.id}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 basis-48">
                  <div className="text-sm font-medium text-text">{p.display_name ?? p.id}</div>
                  <div className="text-[11px] text-muted">
                    {providers.data.availability?.authoritative === false ? m.catalog_unavailable() : (p.configured ?? p.has_key) ? m.providers_configured() : m.providers_not_configured()}{p.key_source_kind ? ` · ${p.key_source_kind === 'other' ? p.key_source : p.key_source_kind}` : ''}{p.base_url ? ` · ${p.base_url}` : ''}{p.models_total !== undefined ? ` · ${m.providers_models_count({ n: p.models_total })}` : ''}
                    {!quotaNotice && quota?.message ? ` · ${quota.message}` : ''}
                  </div>
                  {p.auth_error && <div className="text-[11px] text-error">{p.auth_error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <IconButton label={m.providers_refresh_models()} disabled={refreshModels.isPending} onClick={() => refreshModels.mutate(p.id)}>
                    <RefreshCw size={14} aria-hidden="true" className={cn(refreshModels.isPending && refreshModels.variables === p.id && 'animate-spin')} />
                  </IconButton>
                  {p.is_self_hosted ? (
                    <Button onClick={() => setEditing(isEditing ? null : p.id)}>{m.providers_self_hosted_setup()}</Button>
                  ) : p.configurable !== false && !p.is_oauth && (
                    <Button onClick={() => setEditing(isEditing ? null : p.id)}>{m.providers_key_set()}</Button>
                  )}
                  {p.removable === true && (
                    <Button variant="ghost" className="text-error" onClick={() => saveKey.mutate({ id: p.id, key: null })}>{m.providers_key_remove()}</Button>
                  )}
                </div>
              </div>
              {p.id === 'nous' && <OAuthSignIn provider={p.id} label={p.display_name ?? p.id} signedIn={p.has_key === true} account={p.nous_account ?? null} accountError={p.nous_account_error ?? null} resultOnly compact idPrefix="providersNousOauth" onApproved={invalidate} />}
              {isEditing && p.is_self_hosted && <SelfHostedForm key={p.id} id={p.id} baseUrl={p.base_url ?? ''} saving={saveHosted.isPending} onSubmit={(body) => saveHosted.mutate({ id: p.id, name: p.display_name ?? p.id, ...body })} />}
              {isEditing && !p.is_self_hosted && <ProviderKeyForm key={p.id} label={`${p.display_name ?? p.id} API key`} hasKey={p.has_key === true} saving={saveKey.isPending} onSubmit={(key) => saveKey.mutate({ id: p.id, key })} />}
              {sources.map((s) => <ProviderQuotaPace key={s.source_id} source={s} showAccount={sources.length > 1} />)}
              {p.id === 'openrouter' && p.has_key && <OpenRouterCost />}
              {p.models && p.models.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted">{m.providers_models_count({ n: p.models.length })}</summary>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {p.models.map((mm) => (
                      <li key={mm.id}>
                        <button type="button" onClick={() => setDefault.mutate({ model: mm.id, provider: p.id })} className={cn('rounded-full border px-2 py-0.5 text-[11px]', mm.id === defaultModel ? 'border-accent bg-accent-bg text-accent-text' : 'border-border text-muted hover:text-text')} title={m.providers_set_default()}><ModelOptionContent entry={mm} /></button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ProviderKeyForm({ label, hasKey, saving, onSubmit }: { label: string; hasKey: boolean; saving: boolean; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()) }} className="mt-2 flex gap-2">
      <TextInput type="password" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={hasKey ? m.providers_key_placeholder_replace() : m.providers_key_placeholder_new()} aria-label={label} />
      <Button type="submit" variant="primary" disabled={saving}>{m.save()}</Button>
    </form>
  )
}

// Self-hosted setup also needs an endpoint and model, unlike ProviderKeyForm.
function SelfHostedForm({ id, baseUrl, saving, onSubmit }: { id: string; baseUrl: string; saving: boolean; onSubmit: (body: { base_url: string; model: string; api_key?: string }) => void }) {
  const [hosted, setHosted] = useState({ base_url: baseUrl, api_key: '', model: '' })
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ base_url: hosted.base_url.trim(), model: hosted.model.trim(), ...(hosted.api_key.trim() ? { api_key: hosted.api_key.trim() } : {}) }) }} className="mt-2 flex flex-col">
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
