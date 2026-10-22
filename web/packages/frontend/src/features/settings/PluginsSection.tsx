import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginInstallResult, PluginOAuthClientView, PluginSettingView, PluginUpdateResult } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/Dialog'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'
import { useResourceEffects, useResourceMutation } from '../sessions/useResourceMutation'
import { getStreamContext } from '../../stream/connection'

export function PluginsSection() {
  const qc = useQueryClient()
  const updating = useRef(false)
  const [scan, setScan] = useState<Exclude<PluginUpdateResult, { status: 'updated' }> | null>(null)
  const update = useMutation({
    mutationFn: ({ key, accept, token }: { key: string; accept: boolean; token?: string }) => api.updatePlugin(key, accept, token),
    onSuccess: (result) => {
      if (result.status === 'updated') {
        setScan(null)
        showToast(m.plugins_updated())
        void qc.invalidateQueries({ queryKey: keys.plugins })
      } else setScan(result)
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : String(error), 5000, 'error')
      void qc.invalidateQueries({ queryKey: keys.plugins })
    },
    onSettled: () => { updating.current = false },
  })
  const requestUpdate = (key: string, accept = false, token?: string) => {
    if (updating.current) return
    updating.current = true
    setScan(null)
    update.mutate({ key, accept, ...(token ? { token } : {}) })
  }
  const plugins = useQuery({ queryKey: keys.plugins, queryFn: api.fetchPlugins, staleTime: 30_000 })
  const effects = useResourceEffects<Record<string, unknown>>()
  const [open, setOpen] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  if (plugins.isPending) return <LoadingState />
  if (plugins.isError) return <ErrorState error={plugins.error} onRetry={() => { void plugins.refetch() }} />
  // Saved non-secret values show at once until the reread; secrets never show.
  const list = plugins.data.plugins.map((p) => {
    const saved = effects[`plugin:${p.key}`]?.value
    return saved && p.settings ? { ...p, settings: p.settings.map((f) => f.key in saved ? { ...f, value: saved[f.key] } : f) } : p
  })
  const editable = !plugins.data.read_only
  return (
    <div className="flex flex-col gap-2" data-section="plugins">
      <div className="flex justify-end"><Button variant="ghost" className="min-h-11" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>{m.plugins_catalog()}</Button></div>
      {browsing && <PluginCatalogList />}
      {plugins.data.read_only && <div className="text-xs text-warning">{m.plugins_read_only()}</div>}
      {plugins.data.plugin_isolation_advisory && <div className="text-xs text-warning" data-advisory="plugin-isolation">{m.plugins_isolation_advisory()}</div>}
      {list.length === 0 && <EmptyState>{browsing ? m.plugins_catalog_no_installed() : m.plugins_empty()}</EmptyState>}
      <ul className="flex flex-col divide-y divide-border-subtle">
        {list.map((p) => (
          <PluginRow key={p.key} title={<>{p.name ?? p.key}{p.version ? <span className="ml-1 text-[11px] text-muted">v{p.version}</span> : null}</>} description={`${p.kind ? `${p.kind} · ` : ''}${p.description ?? ''}`} actions={<>
              {p.update?.available && <span className="text-[11px] text-warning">{m.plugins_update_available()}</span>}
              {editable && p.update?.available && <Button variant="ghost" className="min-h-11 min-w-11 px-2 py-1 text-xs" disabled={update.isPending} aria-busy={update.isPending && update.variables.key === p.key} onClick={() => requestUpdate(p.key)}>{m.plugins_update()}</Button>}
              {p.is_active_provider && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent-text">{m.providers_active()}</span>}
              <span className={p.enabled !== false ? 'text-[11px] text-success' : 'text-[11px] text-muted'}>{p.enabled !== false ? m.plugins_enabled() : m.plugins_disabled()}{p.activation ? ` · ${p.activation}` : ''}</span>
              {editable && p.settings?.length ? <Button variant="ghost" className="px-2 py-1 text-xs" aria-expanded={open === p.key} onClick={() => setOpen(open === p.key ? null : p.key)}>{m.settings_title()}</Button> : null}
            </>}>
            {p.oauth_clients?.length ? <ul className="mt-2 flex flex-col gap-2">{p.oauth_clients.map((c) => <PluginOAuthClientRow key={c.id} pluginKey={p.key} client={c} editable={editable} />)}</ul> : null}
            {scan?.key === p.key && scan.status === 'blocked' && <div role="alert" className="mt-2 whitespace-pre-line text-xs text-error [overflow-wrap:anywhere]">{scan.findings}</div>}
            {editable && open === p.key && p.settings ? <PluginSettingsForm pluginKey={p.key} fields={p.settings} onSaved={() => setOpen(null)} /> : null}
          </PluginRow>
        ))}
      </ul>
      <ConfirmDialog open={scan?.status === 'needs_consent'} onOpenChange={(isOpen) => { if (!isOpen) setScan((current) => current === scan && current?.status === 'needs_consent' ? null : current) }}
        title={m.plugins_update_consent()} description={scan?.findings} confirmLabel={m.plugins_update()} cancelLabel={m.cancel()} danger
        onConfirm={() => { if (scan?.status === 'needs_consent') requestUpdate(scan.key, true, scan.consent_token) }} />
    </div>
  )
}

/** Installed and catalog entries share the existing Plugins row and disclosure layout. */
function PluginRow({ title, description, actions, children }: { title: ReactNode; description: string; actions: ReactNode; children?: ReactNode }) {
  return <li className="py-2"><div className="flex flex-wrap items-center gap-3">
    <div className="min-w-0 flex-1 basis-40"><div className="text-sm font-medium text-text">{title}</div><div className="text-[11px] text-muted [overflow-wrap:anywhere]">{description}</div></div>
    {actions}
  </div>{children}</li>
}

function PluginCatalogList() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [details, setDetails] = useState<string | null>(null)
  const [result, setResult] = useState<{ context: object; value: PluginInstallResult } | null>(null)
  const active = useRef(false)
  const catalog = useQuery({ queryKey: [...keys.pluginCatalog, query, offset], queryFn: () => api.fetchPluginCatalog(query, offset), retry: false })
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: keys.plugins }), qc.invalidateQueries({ queryKey: keys.pluginCatalog })]) }
  const install = useMutation({
    mutationFn: async ({ name, token, context }: { name: string; token?: string; context: object }) => {
      if (context !== getStreamContext()) throw new Error(m.plugins_catalog_changed())
      return api.installPlugin(name, token)
    },
    retry: false,
    onSuccess: (value, variables) => {
      if (variables.context !== getStreamContext()) return
      setResult({ context: variables.context, value })
      if (value.status === 'installed') { showToast(m.plugins_catalog_installed()); void refresh() }
    },
    onError: (error, variables) => {
      if (variables.context !== getStreamContext()) return
      showToast(error instanceof Error ? error.message : String(error), 10000, 'error')
      // Read back even after a lost acknowledgement. Never replay the non-idempotent install.
      void refresh()
    },
    onSettled: () => { active.current = false },
  })
  const request = (name: string, token?: string) => {
    if (active.current) return
    active.current = true
    setResult(null)
    install.mutate({ name, ...(token ? { token } : {}), context: getStreamContext() })
  }
  const current = result?.context === getStreamContext() ? result.value : null
  return <section aria-label={m.plugins_catalog()} className="border-b border-border-subtle pb-4">
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(search); setOffset(0) }}>
      <TextInput aria-label={m.plugins_catalog_search()} value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} />
      <Button type="submit" className="min-h-11">{m.search()}</Button>
    </form>
    {catalog.isPending ? <LoadingState /> : catalog.isError ? <ErrorState error={catalog.error} onRetry={() => { void catalog.refetch() }} /> : <>
      {!catalog.data.supported && <p className="py-2 text-xs text-muted">{m.plugins_catalog_unsupported()}</p>}
      {catalog.data.supported && catalog.data.total === 0 && <EmptyState>{m.plugins_catalog_empty()}</EmptyState>}
      <ul className="flex flex-col divide-y divide-border-subtle">{catalog.data.entries.map((entry) => <PluginRow key={entry.name} title={entry.title} description={entry.description} actions={<>
        <span className="text-[11px] text-muted">{entry.tier} · {entry.category}</span>
        {entry.installed_key && <span className="text-xs text-muted">{m.plugins_catalog_on_disk()}</span>}
        <Button variant="ghost" className="min-h-11" aria-expanded={details === entry.name} onClick={() => setDetails(details === entry.name ? null : entry.name)}>{m.plugins_catalog_details()}</Button>
        {entry.can_install && <Button variant="ghost" className="min-h-11" aria-busy={install.isPending && install.variables.name === entry.name} disabled={install.isPending && install.variables.name === entry.name} onClick={() => request(entry.name)}>{m.plugins_catalog_install()}</Button>}
      </>}>
        {details === entry.name && <div className="mt-2 space-y-1 text-xs text-muted [overflow-wrap:anywhere]">
          <p>{entry.repo}</p><p>{entry.sha}</p>{entry.installed_sha && <p>{entry.installed_sha}</p>}
          {entry.requirements.map((requirement) => <p key={requirement}>{requirement}</p>)}
          <p>{m.plugins_catalog_desktop()}</p>{entry.refusal && <p role="alert" className="text-warning">{entry.refusal}</p>}
        </div>}
        {current?.name === entry.name && current.status === 'blocked' && <p role="alert" className="mt-2 whitespace-pre-line text-xs text-error [overflow-wrap:anywhere]">{current.findings}</p>}
      </PluginRow>)}</ul>
      <div className="flex justify-end gap-2">
        {offset > 0 && <Button variant="ghost" className="min-h-11" onClick={() => setOffset(0)}>{m.plugins_catalog_first()}</Button>}
        {catalog.data.next_offset !== null && <Button variant="ghost" className="min-h-11" onClick={() => setOffset(catalog.data.next_offset ?? 0)}>{m.plugins_catalog_next()}</Button>}
      </div>
    </>}
    <ConfirmDialog open={current?.status === 'needs_consent'} onOpenChange={(open) => { if (!open) setResult(null) }} title={m.plugins_catalog_install()} description={current?.status === 'needs_consent' ? current.findings : undefined} confirmLabel={m.plugins_catalog_install()} cancelLabel={m.cancel()}
      onConfirm={() => { if (current?.status === 'needs_consent') request(current.name, current.consent_token) }} />
  </section>
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
        {editable && client.can_sign_out ? <Button variant="ghost" className="px-2 py-1 text-xs" disabled={signOut.isPending} onClick={() => signOut.mutate()}>{m.plugins_oauth_sign_out()}</Button> : null}
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
/** Closes on Save: the plugin shows its saved values at once while the server applies them. */
function PluginSettingsForm({ pluginKey, fields, onSaved }: { pluginKey: string; fields: PluginSettingView[]; onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({})
  const set = (key: string, value: string | boolean) => setDrafts((cur) => ({ ...cur, [key]: value }))
  const save = useResourceMutation({
    resource: () => `plugin:${pluginKey}`, queryKey: keys.plugins,
    effect: ({ values }: { values: Record<string, unknown>; secrets: Record<string, string> }) => ({ value: values }),
    mutationFn: ({ values, secrets }) => api.savePluginSettings(pluginKey, values, secrets),
    onSuccess: (result) => {
      showToast(result.runtime_application === 'applied' ? m.saved() : result.runtime_application === 'restart_required' ? m.plugins_settings_restart_required() : m.plugins_settings_runtime_unknown(), result.runtime_application === 'applied' ? 3000 : 10000)
    },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  const submit = () => {
    const values: Record<string, unknown> = {}
    const secrets: Record<string, string> = {}
    for (const f of fields) if (f.key in drafts) { if (f.type === 'secret') secrets[f.key] = text(drafts[f.key]); else values[f.key] = drafts[f.key] }
    save.mutate({ values, secrets })
    onSaved()
  }
  return (
    <form className="mt-2 border-t border-border-subtle" onSubmit={(e) => { e.preventDefault(); submit() }}>
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
      <div className="flex justify-end pt-1"><Button type="submit" variant="primary" disabled={Object.keys(drafts).length === 0}>{m.save()}</Button></div>
    </form>
  )
}
