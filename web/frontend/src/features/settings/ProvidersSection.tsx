import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useSetDefaultModel } from '../../app/queries'
import { post } from '../../api/client'
import { OkSchema } from '../../contracts'
import { Button } from '../../ui/Button'
import { TextInput } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'
import { useSettingField } from './useSettingField'

const setProviderKey = (provider: string, api_key: string | null) => post('api/providers', { provider, api_key }, OkSchema, { retries: 0 })

export function ProvidersSection() {
  const qc = useQueryClient()
  const providers = useQuery({ queryKey: keys.providers, queryFn: api.fetchProviders, staleTime: 30_000 })
  const quotas = useQuery({ queryKey: keys.providerQuotas, queryFn: () => api.fetchProviderQuotas(false), staleTime: 60_000 })
  const { str } = useSettingField()
  const setDefault = useSetDefaultModel()
  const [editing, setEditing] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.providers }); void qc.invalidateQueries({ queryKey: keys.models }) }
  const saveKey = useMutation({ mutationFn: ({ id, key }: { id: string; key: string | null }) => setProviderKey(id, key), onSuccess: (_r, v) => { showToast(v.key ? m.providers_key_saved() : m.providers_key_removed()); setEditing(null); setKeyValue(''); invalidate() }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  if (providers.isPending) return <LoadingState />
  if (providers.isError) return <ErrorState error={providers.error} onRetry={() => { void providers.refetch() }} />
  const active = providers.data.active_provider
  const defaultModel = str('default_model')
  return (
    <div className="flex flex-col gap-3" data-section="providers">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{m.providers_active()}: <strong className="text-text">{active ?? '—'}</strong></span>
        <Button onClick={() => { void api.fetchProviderQuotas(true).then((d) => qc.setQueryData(keys.providerQuotas, d)).catch(() => undefined) }}>{m.providers_quota_refresh()}</Button>
      </div>
      <ul className="flex flex-col gap-2">
        {providers.data.providers.map((p) => {
          const quota = quotas.data?.sources.find((s) => s.provider_id === p.id)
          const isEditing = editing === p.id
          return (
            <li key={p.id} className={cn('rounded-lg border border-border bg-surface p-3', p.id === active && 'border-accent-bg-strong')} data-provider={p.id}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text">{p.display_name ?? p.id}</div>
                  <div className="text-[11px] text-muted">
                    {p.has_key ? m.providers_configured() : m.providers_not_configured()}{p.key_source ? ` · ${p.key_source}` : ''}{p.models_total !== undefined ? ` · ${m.providers_models_count({ n: p.models_total })}` : ''}
                    {quota?.message ? ` · ${quota.message}` : ''}
                  </div>
                  {p.auth_error && <div className="text-[11px] text-error">{p.auth_error}</div>}
                </div>
                {p.configurable !== false && !p.is_oauth && (
                  <Button onClick={() => { setEditing(isEditing ? null : p.id); setKeyValue('') }}>{m.providers_key_set()}</Button>
                )}
                {p.has_key && p.configurable !== false && !p.is_oauth && (
                  <Button variant="ghost" className="text-error" onClick={() => saveKey.mutate({ id: p.id, key: null })}>{m.providers_key_remove()}</Button>
                )}
              </div>
              {isEditing && (
                <form onSubmit={(e) => { e.preventDefault(); if (keyValue.trim()) saveKey.mutate({ id: p.id, key: keyValue.trim() }) }} className="mt-2 flex gap-2">
                  <TextInput type="password" autoComplete="off" autoFocus value={keyValue} onChange={(e) => setKeyValue(e.target.value)} placeholder={p.has_key ? m.providers_key_placeholder_replace() : m.providers_key_placeholder_new()} aria-label={`${p.display_name ?? p.id} API key`} />
                  <Button type="submit" variant="primary" disabled={saveKey.isPending}>{m.save()}</Button>
                </form>
              )}
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
