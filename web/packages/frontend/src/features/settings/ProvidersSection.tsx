import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useSetDefaultModel } from '../../app/queries'
import { post } from '../../api/client'
import { OkSchema } from '../../contracts'
import { Button, IconButton } from '../../ui/Button'
import { FieldRow, TextInput } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'
import { OpenRouterCost } from './OpenRouterCost'
import { ProviderQuotaPace } from './ProviderQuotaPace'
import { QuotaThresholdsForm } from './QuotaThresholds'

const setProviderKey = (provider: string, api_key: string | null) => post('api/providers', { provider, api_key }, OkSchema, { retries: 0 })

export function ProvidersSection() {
  const qc = useQueryClient()
  const providers = useQuery({ queryKey: keys.providers, queryFn: api.fetchProviders, staleTime: 30_000 })
  // The server recomputes pace on every read (provider calls are cached 45 s), so a reset replaces an expired pace within a minute.
  const quotas = useQuery({ queryKey: keys.providerQuotas, queryFn: () => api.fetchProviderQuotas(false), staleTime: 60_000, refetchInterval: 60_000 })
  const { str } = useSettingField()
  const setDefault = useSetDefaultModel()
  const [editing, setEditing] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [hosted, setHosted] = useState({ base_url: '', api_key: '', model: '' })
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.providers }); void qc.invalidateQueries({ queryKey: keys.models }) }
  const toastError = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
  const saveKey = useMutation({ mutationFn: ({ id, key }: { id: string; key: string | null }) => setProviderKey(id, key), onSuccess: (_r, v) => { showToast(v.key ? m.providers_key_saved() : m.providers_key_removed()); setEditing(null); setKeyValue(''); invalidate() }, onError: toastError })
  // The server also makes the model the default, so settings reread with the provider list.
  const saveHosted = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) => api.saveSelfHostedProvider({ provider: id, base_url: hosted.base_url.trim(), model: hosted.model.trim(), ...(hosted.api_key.trim() ? { api_key: hosted.api_key.trim() } : {}) }),
    onSuccess: (_r, v) => { showToast(m.providers_self_hosted_saved({ provider: v.name })); setEditing(null); invalidate(); void qc.invalidateQueries({ queryKey: keys.settings }) },
    onError: toastError,
  })
  const refreshModels = useMutation({ mutationFn: (id: string) => api.refreshModels(id), onSuccess: () => { showToast(m.providers_models_refreshed()); invalidate() }, onError: toastError })
  if (providers.isPending) return <LoadingState />
  if (providers.isError) return <ErrorState error={providers.error} onRetry={() => { void providers.refetch() }} />
  const active = providers.data.active_provider
  const defaultModel = str('default_model')
  return (
    <div className="flex flex-col gap-3" data-section="providers">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{m.providers_active()}: <strong className="text-text">{active ?? '—'}</strong></span>
        <Button onClick={() => { void api.fetchProviderQuotas(true).then((d) => { qc.setQueryData(keys.providerQuotas, d); void qc.invalidateQueries({ queryKey: keys.providerCostHistory }) }).catch(() => undefined) }}>{m.providers_quota_refresh()}</Button>
      </div>
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
                    {(p.configured ?? p.has_key) ? m.providers_configured() : m.providers_not_configured()}{p.key_source_kind ? ` · ${p.key_source_kind === 'other' ? p.key_source : p.key_source_kind}` : ''}{p.base_url ? ` · ${p.base_url}` : ''}{p.models_total !== undefined ? ` · ${m.providers_models_count({ n: p.models_total })}` : ''}
                    {quota?.message ? ` · ${quota.message}` : ''}
                  </div>
                  {p.auth_error && <div className="text-[11px] text-error">{p.auth_error}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <IconButton label={m.providers_refresh_models()} disabled={refreshModels.isPending} onClick={() => refreshModels.mutate(p.id)}>
                    <RefreshCw size={14} aria-hidden="true" className={cn(refreshModels.isPending && refreshModels.variables === p.id && 'animate-spin')} />
                  </IconButton>
                  {p.is_self_hosted ? (
                    <Button onClick={() => { setEditing(isEditing ? null : p.id); setHosted({ base_url: p.base_url ?? '', api_key: '', model: '' }) }}>{m.providers_self_hosted_setup()}</Button>
                  ) : p.configurable !== false && !p.is_oauth && (
                    <Button onClick={() => { setEditing(isEditing ? null : p.id); setKeyValue('') }}>{m.providers_key_set()}</Button>
                  )}
                  {p.removable === true && (
                    <Button variant="ghost" className="text-error" onClick={() => saveKey.mutate({ id: p.id, key: null })}>{m.providers_key_remove()}</Button>
                  )}
                </div>
              </div>
              {isEditing && p.is_self_hosted && (
                <form onSubmit={(e) => { e.preventDefault(); saveHosted.mutate({ id: p.id, name: p.display_name ?? p.id }) }} className="mt-2 flex flex-col">
                  <FieldRow label={m.onboarding_base_url_label()} hint={m.onboarding_base_url_help()} htmlFor={`${p.id}-base-url`}>
                    <TextInput id={`${p.id}-base-url`} type="url" required autoComplete="off" autoFocus value={hosted.base_url} onChange={(e) => setHosted({ ...hosted, base_url: e.target.value })} placeholder={m.onboarding_base_url_placeholder()} />
                  </FieldRow>
                  <FieldRow label={m.onboarding_api_key_label_optional()} hint={m.onboarding_api_key_help_keyless()} htmlFor={`${p.id}-api-key`}>
                    <TextInput id={`${p.id}-api-key`} type="password" autoComplete="off" value={hosted.api_key} onChange={(e) => setHosted({ ...hosted, api_key: e.target.value })} placeholder={m.onboarding_api_key_placeholder_optional()} />
                  </FieldRow>
                  <FieldRow label={m.onboarding_model_label()} htmlFor={`${p.id}-model`}>
                    <TextInput id={`${p.id}-model`} required autoComplete="off" value={hosted.model} onChange={(e) => setHosted({ ...hosted, model: e.target.value })} />
                  </FieldRow>
                  <Button type="submit" variant="primary" className="self-end" disabled={saveHosted.isPending}>{m.save()}</Button>
                </form>
              )}
              {isEditing && !p.is_self_hosted && (
                <form onSubmit={(e) => { e.preventDefault(); if (keyValue.trim()) saveKey.mutate({ id: p.id, key: keyValue.trim() }) }} className="mt-2 flex gap-2">
                  <TextInput type="password" autoComplete="off" autoFocus value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder={p.has_key ? m.providers_key_placeholder_replace() : m.providers_key_placeholder_new()} aria-label={`${p.display_name ?? p.id} API key`} />
                  <Button type="submit" variant="primary" disabled={saveKey.isPending}>{m.save()}</Button>
                </form>
              )}
              {sources.map((s) => <ProviderQuotaPace key={s.source_id} source={s} showAccount={sources.length > 1} />)}
              {p.id === 'openrouter' && p.has_key && <OpenRouterCost />}
              {p.models && p.models.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted">{m.providers_models_count({ n: p.models.length })}</summary>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {p.models.map((mm) => (
                      <li key={mm.id}>
                        <button type="button" onClick={() => setDefault.mutate({ model: mm.id, provider: p.id }, { onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })} className={cn('rounded-full border px-2 py-0.5 text-[11px]', mm.id === defaultModel ? 'border-accent bg-accent-bg text-accent-text' : 'border-border text-muted hover:text-text')} title={m.providers_set_default()}>{mm.label ?? mm.id}</button>
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
