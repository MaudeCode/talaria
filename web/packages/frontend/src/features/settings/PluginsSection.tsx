import { useCallback, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginOAuthClientView, PluginSettingView } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Button } from '../../ui/Button'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'

export function PluginsSection() {
  const plugins = useQuery({ queryKey: keys.plugins, queryFn: api.fetchPlugins, staleTime: 30_000 })
  const [open, setOpen] = useState<string | null>(null)
  if (plugins.isPending) return <LoadingState />
  if (plugins.isError) return <ErrorState error={plugins.error} onRetry={() => { void plugins.refetch() }} />
  const list = plugins.data.plugins
  const editable = !plugins.data.read_only
  return (
    <div className="flex flex-col gap-2" data-section="plugins">
      {plugins.data.read_only && <div className="text-xs text-warning">{m.plugins_read_only()}</div>}
      {plugins.data.plugin_isolation_advisory && <div className="text-xs text-warning" data-advisory="plugin-isolation">{m.plugins_isolation_advisory()}</div>}
      {list.length === 0 && <EmptyState>{m.plugins_empty()}</EmptyState>}
      <ul className="flex flex-col divide-y divide-border-subtle">
        {list.map((p) => (
          <li key={p.key} className="py-2">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text">{p.name ?? p.key}{p.version ? <span className="ml-1 text-[11px] text-muted">v{p.version}</span> : null}</div>
                <div className="truncate text-[11px] text-muted">{p.kind ? `${p.kind} · ` : ''}{p.description ?? ''}</div>
              </div>
              {p.is_active_provider && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent-text">{m.providers_active()}</span>}
              <span className={p.enabled !== false ? 'text-[11px] text-success' : 'text-[11px] text-muted'}>{p.enabled !== false ? m.plugins_enabled() : m.plugins_disabled()}{p.activation ? ` · ${p.activation}` : ''}</span>
              {editable && p.settings?.length ? <Button variant="ghost" className="px-2 py-1 text-xs" aria-expanded={open === p.key} onClick={() => setOpen(open === p.key ? null : p.key)}>{m.settings_title()}</Button> : null}
            </div>
            {p.oauth_clients?.length ? <ul className="mt-2 flex flex-col gap-2">{p.oauth_clients.map((c) => <PluginOAuthClientRow key={c.id} pluginKey={p.key} client={c} editable={editable} />)}</ul> : null}
            {editable && open === p.key && p.settings ? <PluginSettingsForm pluginKey={p.key} fields={p.settings} onSaved={() => setOpen(null)} /> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

const OAUTH_STATE: Record<PluginOAuthClientView['state'], { label: () => string; tone: string }> = {
  signed_in: { label: m.plugins_oauth_signed_in, tone: 'text-success' },
  sign_in_needed: { label: m.plugins_oauth_sign_in_needed, tone: 'text-warning' },
  revoked: { label: m.plugins_oauth_revoked, tone: 'text-warning' },
  logged_out: { label: m.plugins_oauth_logged_out, tone: 'text-muted' },
}

/** TAL-1276: one OAuth client the plugin declares, its sign-in state, and its Sign in / Sign out actions for the server owner. */
function PluginOAuthClientRow({ pluginKey, client, editable }: { pluginKey: string; client: PluginOAuthClientView; editable: boolean }) {
  const qc = useQueryClient()
  const refresh = useCallback(() => { void qc.invalidateQueries({ queryKey: keys.plugins }) }, [qc])
  const signOut = useMutation({
    mutationFn: () => api.pluginOauthLogout(pluginKey, client.id),
    onSuccess: refresh,
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  const state = OAUTH_STATE[client.state]
  return (
    <li className="flex flex-col gap-1 text-xs" data-oauth-client={client.id}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate font-medium text-text">{client.id}</span>
        <span className={state.tone}>{state.label()}</span>
        {editable && client.can_sign_out ? <Button variant="ghost" className="px-2 py-1 text-xs" disabled={signOut.isPending} onClick={() => signOut.mutate()}>{m.sign_out()}</Button> : null}
      </div>
      {editable && (
        <OAuthSignIn provider={`plugin:${pluginKey}:${client.id}`} label={client.id} signedIn={client.state === 'signed_in'} onApproved={refresh} idPrefix={`pluginOauth-${pluginKey}-${client.id}-`} compact>
          {(flow) => flow.flow_id ? <PastedRedirect flowId={flow.flow_id} /> : null}
        </OAuthSignIn>
      )}
    </li>
  )
}

/** The address the browser landed on after the approval, for when it runs on another machine than the Agent. */
function PastedRedirect({ flowId }: { flowId: string }) {
  const [url, setUrl] = useState('')
  const submit = useMutation({
    mutationFn: () => api.pluginOauthRedirect(flowId, url.trim()),
    onSuccess: () => setUrl(''),
  })
  const id = `plugin-oauth-redirect-${flowId}`
  return (
    <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); submit.mutate() }}>
      <label className="text-muted" htmlFor={id}>{m.oauth_plugin_paste()}</label>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><TextInput id={id} autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1/…" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
        <Button type="submit" disabled={submit.isPending || !url.trim()}>{m.oauth_plugin_paste_submit()}</Button>
      </div>
      {submit.isError && <p className="text-warning" role="alert">{submit.error instanceof Error ? submit.error.message : String(submit.error)}</p>}
    </form>
  )
}

/** A stored value as form text; lists and objects show as indented JSON. */
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : value == null ? '' : JSON.stringify(value, null, 2)

/** The plugin manifest's settings as the server reported them; only fields the user edits are sent, and the server checks and stores them. */
function PluginSettingsForm({ pluginKey, fields, onSaved }: { pluginKey: string; fields: PluginSettingView[]; onSaved: () => void }) {
  const qc = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({})
  const set = (key: string, value: string | boolean) => setDrafts((cur) => ({ ...cur, [key]: value }))
  const save = useMutation({
    mutationFn: () => {
      const values: Record<string, unknown> = {}
      const secrets: Record<string, string> = {}
      for (const f of fields) if (f.key in drafts) { if (f.type === 'secret') secrets[f.key] = text(drafts[f.key]); else values[f.key] = drafts[f.key] }
      return api.savePluginSettings(pluginKey, values, secrets)
    },
    onSuccess: () => { showToast(m.saved()); void qc.invalidateQueries({ queryKey: keys.plugins }); onSaved() },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  return (
    <form className="mt-2 border-t border-border-subtle" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      {fields.map((f) => {
        const id = `plugin-setting-${pluginKey}-${f.key}`
        const draft = drafts[f.key]
        return (
          <FieldRow key={f.key} label={f.label} htmlFor={id} {...(f.locked ? { hint: m.plugins_secret_locked({ env: f.env ?? '' }) } : f.description ? { hint: f.description } : {})} inline={f.type !== 'json'}>
            {f.type === 'boolean' ? <Switch id={id} checked={(draft ?? f.value) === true} onCheckedChange={(checked) => set(f.key, checked)} />
              : f.type === 'enum' ? <Select id={id} value={text(draft ?? f.value)} onValueChange={(v) => set(f.key, v)}>{(f.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}</Select>
              : f.type === 'json' ? <textarea id={id} rows={3} spellCheck={false} className="min-h-9 w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-text focus:border-accent" value={text(draft ?? f.value)} onChange={(e) => set(f.key, e.target.value)} />
              : f.type === 'secret' ? <div className="w-48 max-w-[50vw]"><TextInput id={id} type="password" autoComplete="off" disabled={f.locked === true} placeholder={f.has_value ? m.saved() : ''} value={text(draft)} onChange={(e) => set(f.key, e.target.value)} /></div>
              : <div className={f.type === 'number' ? 'w-28' : 'w-48 max-w-[50vw]'}><TextInput id={id} type={f.type === 'number' ? 'number' : 'text'} step="any" value={text(draft ?? f.value)} onChange={(e) => set(f.key, e.target.value)} /></div>}
          </FieldRow>
        )
      })}
      <div className="flex justify-end pt-1"><Button type="submit" variant="primary" disabled={save.isPending || Object.keys(drafts).length === 0}>{m.save()}</Button></div>
    </form>
  )
}
