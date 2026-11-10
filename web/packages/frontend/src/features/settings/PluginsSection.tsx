import { memo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginAutoUpdateView, PluginOAuthClientView, PluginSettingView, PluginUpdateAllRow, PluginUpdateResult } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Check, ChevronRight, ChevronsLeft, CircleArrowUp, Download, Info, LogOut, Search, Settings2, Store } from 'lucide-react'
import { IconButton } from '../../ui/Button'
import { Mark, StatusDot, type DotState } from '../../ui/Badge'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { ConfirmDialog } from '../../ui/Dialog'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'
import { useResourceEffects, useResourceMutation } from '../sessions/useResourceMutation'
import { getStreamContext, useStreamContext } from '../../stream/connection'
import { usePluginInstall } from './usePluginInstall'
import { useDebounced } from '../../lib/useDebounced'
import { sameRowProps } from '../../lib/sameRowProps'

export function PluginsSection() {
  const qc = useQueryClient()
  const updating = useRef(false)
  const [scan, setScan] = useState<Exclude<PluginUpdateResult, { status: 'updated' }> | null>(null)
  const [updatedAll, setUpdatedAll] = useState<{ context: object; rows: PluginUpdateAllRow[] } | null>(null)
  const streamContext = useStreamContext()
  const refreshInstalled = () => { for (const queryKey of [keys.plugins, keys.pluginCatalog]) void qc.invalidateQueries({ queryKey }) }
  const update = useMutation({
    mutationFn: ({ key, accept, token }: { key: string; accept: boolean; token?: string }) => api.updatePlugin(key, accept, token),
    onSuccess: (result) => {
      if (result.status === 'updated') {
        setScan(null)
        showToast(m.plugins_updated())
        refreshInstalled()
      } else setScan(result)
    },
    onError: (error) => {
      showToast(error instanceof Error ? error.message : String(error), 5000, 'error')
      refreshInstalled()
    },
    onSettled: () => { updating.current = false },
  })
  const updateAll = useMutation({
    mutationFn: (_context: object) => api.updateAllPlugins(),
    onSuccess: (result, context) => {
      if (context !== getStreamContext()) return
      setUpdatedAll({ context, rows: result.results })
      if (result.results.length === 0) showToast(m.plugins_update_all_none())
    },
    onError: (error, context) => {
      if (context === getStreamContext()) showToast(error instanceof Error ? error.message : String(error), 5000, 'error')
    },
    onSettled: () => {
      updating.current = false
      refreshInstalled()
    },
  })
  const requestUpdateAll = () => {
    if (updating.current) return
    updating.current = true
    setScan(null)
    setUpdatedAll(null)
    updateAll.mutate(streamContext)
  }
  // The stable `mutate` keeps this callback, and so each memoized row, unchanged across filter keystrokes.
  const mutateUpdate = update.mutate
  const requestUpdate = (key: string, accept = false, token?: string) => {
    if (updating.current) return
    updating.current = true
    setScan(null)
    mutateUpdate({ key, accept, ...(token ? { token } : {}) })
  }
  const [filter, setFilter] = useState('')
  const q = useDebounced(filter.trim(), 250)
  const plugins = useQuery({ queryKey: [...keys.plugins, { q }], queryFn: () => api.fetchPlugins(q), staleTime: 30_000, placeholderData: keepPreviousData })
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
  const autoUpdate = editable ? plugins.data.auto_update : undefined
  const updateBusy = update.isPending || updateAll.isPending
  // TAL-2129: `plugins` is the server's filter answer; `total` counts the whole install.
  const installed = (plugins.data.total ?? 0) > 0
  return (
    <div className="flex flex-col gap-2" data-section="plugins">
      <div className="flex justify-end gap-2">
        {autoUpdate && installed && <IconButton variant="ghost" label={m.plugins_update_all()} disabled={updateBusy} aria-busy={updateAll.isPending} onClick={requestUpdateAll}><CircleArrowUp aria-hidden="true" /></IconButton>}
        <IconButton variant="ghost" label={m.plugins_catalog()} active={browsing} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}><Store aria-hidden="true" /></IconButton>
      </div>
      {autoUpdate && <PluginAutoUpdateRow state={autoUpdate} />}
      {updatedAll?.context === streamContext && updatedAll.rows.length > 0 && <PluginUpdateAllResults rows={updatedAll.rows} />}
      {browsing && <PluginCatalogList updating={updateBusy} updatingKey={update.isPending ? update.variables.key : null} onUpdate={requestUpdate} />}
      {plugins.data.read_only && <div className="flex min-w-0"><StatusDot state="warning" title={m.plugins_read_only()}>{m.plugins_read_only()}</StatusDot></div>}
      {plugins.data.plugin_isolation_advisory && <div className="flex min-w-0" data-advisory="plugin-isolation"><StatusDot state="warning" title={m.plugins_isolation_advisory()}>{m.plugins_isolation_advisory()}</StatusDot></div>}
      {!installed && <EmptyState compact>{browsing ? m.plugins_catalog_no_installed() : m.plugins_empty()}</EmptyState>}
      {installed && <TextInput type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.plugins_filter()} aria-label={m.plugins_filter()} />}
      {installed && list.length === 0 && <EmptyState compact>{m.plugins_filter_empty()}</EmptyState>}
      <ul className="flex flex-col divide-y divide-border-subtle">
        {list.map((p) => <InstalledPluginRow key={p.key} plugin={p} editable={editable} open={open === p.key} onOpen={setOpen} updateBusy={updateBusy}
          updating={update.isPending && update.variables.key === p.key} blockedFindings={scan?.key === p.key && scan.status === 'blocked' ? scan.findings : null} onUpdate={requestUpdate} />)}
      </ul>
      <ConfirmDialog open={scan?.status === 'needs_consent'} onOpenChange={(isOpen) => { if (!isOpen) setScan((current) => current === scan && current?.status === 'needs_consent' ? null : current) }}
        title={m.plugins_update_consent()} description={scan?.findings} confirmLabel={m.plugins_update()} cancelLabel={m.cancel()} danger
        onConfirm={() => { if (scan?.status === 'needs_consent') requestUpdate(scan.key, true, scan.consent_token) }} />
    </div>
  )
}

type InstalledPlugin = Awaited<ReturnType<typeof api.fetchPlugins>>['plugins'][number]
interface InstalledPluginRowProps {
  plugin: InstalledPlugin
  editable: boolean
  open: boolean
  onOpen: (key: string | null) => void
  updateBusy: boolean
  updating: boolean
  blockedFindings: string | null
  onUpdate: (key: string) => void
}

// Memoized so typing in the filter renders only the rows entering the list (TAL-1405); each filter answer is a new response.
const InstalledPluginRow = memo(function InstalledPluginRow({ plugin: p, editable, open, onOpen, updateBusy, updating, blockedFindings, onUpdate }: InstalledPluginRowProps) {
  return (
    <PluginRow id={p.key} title={<>{p.name ?? p.key}{p.version ? <span className="ml-1 text-xs font-normal tabular-nums text-muted">v{p.version}</span> : null}</>} description={`${p.kind ? `${p.kind} · ` : ''}${p.description ?? ''}`} status={<>
        {p.update?.available && <StatusDot state="warning">{m.plugins_update_available()}</StatusDot>}
        {p.is_active_provider && <Mark>{m.providers_active()}</Mark>}
        <StatusDot state={p.enabled !== false ? 'ok' : 'idle'}>{p.enabled !== false ? m.plugins_enabled() : m.plugins_disabled()}{p.activation ? ` · ${p.activation}` : ''}</StatusDot>
      </>} actions={[
        ...(editable && p.update?.available ? [{ label: m.plugins_update(), run: () => onUpdate(p.key), disabled: updateBusy, busy: updating, icon: CircleArrowUp }] : []),
        ...(editable && p.settings?.length ? [{ label: m.settings_title(), run: () => onOpen(open ? null : p.key), expanded: open, icon: Settings2 }] : []),
      ]}>
      {p.disabled_reason && <div className="mt-1 flex min-w-0"><StatusDot state="warning" title={m.plugins_disabled_by_update({ reason: p.disabled_reason.reason })}>{m.plugins_disabled_by_update({ reason: p.disabled_reason.reason })}</StatusDot></div>}
      {p.oauth_clients?.length ? <ul className="mt-2 flex flex-col gap-2">{p.oauth_clients.map((c) => <PluginOAuthClientRow key={c.id} pluginKey={p.key} client={c} editable={editable} />)}</ul> : null}
      {blockedFindings !== null && <div role="alert" className="mt-2 whitespace-pre-line text-xs text-error [overflow-wrap:anywhere]">{blockedFindings}</div>}
      {editable && open && p.settings ? <PluginSettingsForm pluginKey={p.key} fields={p.settings} onSaved={() => onOpen(null)} /> : null}
    </PluginRow>
  )
}, sameRowProps<InstalledPluginRowProps>('plugin'))

type PluginRowAction = RowAction & { icon: NonNullable<RowAction['icon']> }

/**
 * Installed and catalog entries share the existing Plugins row and disclosure layout; its actions show inline and in its right-click and long-press menu.
 * TAL-2082: the description keeps to one truncated line, with the full text in its `title` and the DOM for screen readers.
 */
function PluginRow({ id, title, description, status, actions, children }: { id?: string; title: ReactNode; description: string; status: ReactNode; actions: PluginRowAction[]; children?: ReactNode }) {
  const row = <li className="py-2" data-plugin={id}><div className="flex flex-wrap items-center gap-3">
    <div className="min-w-0 flex-1 basis-40"><div className="text-sm font-medium text-text">{title}</div><div className="truncate text-xs text-muted" title={description || undefined}>{description}</div></div>
    {status}
    <RowActionButtons actions={actions} />
  </div>{children}</li>
  return <RowContextMenu label={m.plugins_row_menu()} actions={actions} trigger={row} />
}

const AUTO_UPDATE_RESOURCE = 'plugin-auto-update'

/** TAL-1914: the active profile's switch, with the reason it has no effect in place of the check interval. */
function PluginAutoUpdateRow({ state }: { state: PluginAutoUpdateView }) {
  const effects = useResourceEffects<boolean>()
  const save = useResourceMutation({
    resource: () => AUTO_UPDATE_RESOURCE, effect: (enabled: boolean) => ({ value: enabled }), queryKey: keys.plugins,
    mutationFn: (enabled) => api.setPluginAutoUpdate(enabled),
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  const enabled = effects[AUTO_UPDATE_RESOURCE]?.value ?? state.auto_apply
  const status = state.inactive_reason === 'no_gateway' ? m.gateway_not_running() : state.inactive_reason === 'checks_off' ? m.plugins_auto_update_checks_off() : enabled ? m.plugins_auto_update_every({ hours: state.check_hours }) : null
  return <div className="border-b border-border-subtle"><FieldRow label={m.plugins_auto_update()} htmlFor="plugins-auto-update" inline>
    <div className="flex items-center gap-3">
      {status && (state.inactive_reason ? <StatusDot state="warning">{status}</StatusDot> : <span className="text-xs tabular-nums text-muted">{status}</span>)}
      <Switch id="plugins-auto-update" checked={enabled} onCheckedChange={(checked) => save.mutate(checked)} />
    </div>
  </FieldRow></div>
}

const UPDATE_ALL_STATUS: Record<PluginUpdateAllRow['status'], { label: () => string; state: DotState }> = {
  updated: { label: m.plugins_update_all_updated, state: 'ok' },
  current: { label: m.plugins_update_all_current, state: 'idle' },
  failed: { label: m.plugins_update_all_failed, state: 'error' },
  needs_review: { label: m.plugins_update_all_needs_review, state: 'warning' },
  skipped: { label: m.plugins_update_all_skipped, state: 'idle' },
}

function PluginUpdateAllResults({ rows }: { rows: PluginUpdateAllRow[] }) {
  return <ul aria-label={m.plugins_update_all_results()} className="flex flex-col gap-1 border-b border-border-subtle pb-2 text-xs">
    {rows.map((row) => <li key={row.name} className="flex flex-wrap gap-x-2">
      <span className="font-medium text-text">{row.name}</span>
      <StatusDot state={UPDATE_ALL_STATUS[row.status].state}>{UPDATE_ALL_STATUS[row.status].label()}</StatusDot>
      {row.detail && <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{row.detail}</span>}
    </li>)}
  </ul>
}

function PluginCatalogList({ updating, updatingKey, onUpdate }: { updating: boolean; updatingKey: string | null; onUpdate: (key: string) => void }) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [details, setDetails] = useState<string | null>(null)
  const install = usePluginInstall()
  const catalog = useQuery({ queryKey: [...keys.pluginCatalog, query, offset], queryFn: () => api.fetchPluginCatalog(query, offset), retry: false })
  return <section aria-label={m.plugins_catalog()} className="border-b border-border-subtle pb-4">
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(search); setOffset(0) }}>
      <TextInput aria-label={m.plugins_catalog_search()} value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} />
      <IconButton type="submit" variant="default" label={m.search()}><Search aria-hidden="true" /></IconButton>
    </form>
    {catalog.isPending ? <LoadingState /> : catalog.isError ? <ErrorState error={catalog.error} onRetry={() => { void catalog.refetch() }} /> : <>
      {!catalog.data.supported && <p className="py-2 text-xs text-muted">{m.plugins_catalog_unsupported()}</p>}
      {catalog.data.supported && catalog.data.total === 0 && <EmptyState compact>{m.plugins_catalog_empty()}</EmptyState>}
      <ul className="flex flex-col divide-y divide-border-subtle">{catalog.data.entries.map((entry) => <PluginRow key={entry.name} title={entry.title} description={entry.description} status={<>
        <span className="text-xs text-muted">{entry.tier} · {entry.category}</span>
        {entry.installed_key && <span className="text-xs text-muted">{m.plugins_catalog_on_disk()}</span>}
      </>} actions={[
        { label: m.plugins_catalog_details(), run: () => setDetails(details === entry.name ? null : entry.name), expanded: details === entry.name, icon: Info },
        ...(entry.can_update && entry.installed_key ? [{ label: m.plugins_update(), run: () => onUpdate(entry.installed_key ?? ''), disabled: updating, busy: updatingKey === entry.installed_key, icon: CircleArrowUp }] : []),
        ...(entry.can_install ? [{ label: m.plugins_catalog_install(), run: () => install.request(entry.name), disabled: install.isInstalling(entry.name), busy: install.isInstalling(entry.name), icon: Download }] : []),
      ]}>
        {details === entry.name && <div className="mt-2 space-y-1 text-xs text-muted [overflow-wrap:anywhere]">
          <p>{entry.repo}</p><p>{entry.sha}</p>{entry.installed_sha && <p>{entry.installed_sha}</p>}
          {entry.requirements.map((requirement) => <p key={requirement}>{requirement}</p>)}
          <p>{m.plugins_catalog_desktop()}</p>{entry.refusal && <p role="alert" className="text-warning">{entry.refusal}</p>}
        </div>}
        {install.blocked(entry.name)}
      </PluginRow>)}</ul>
      <div className="flex justify-end gap-2">
        {offset > 0 && <IconButton variant="ghost" label={m.plugins_catalog_first()} onClick={() => setOffset(0)}><ChevronsLeft aria-hidden="true" /></IconButton>}
        {catalog.data.next_offset !== null && <IconButton variant="ghost" label={m.plugins_catalog_next()} onClick={() => setOffset(catalog.data.next_offset ?? 0)}><ChevronRight aria-hidden="true" /></IconButton>}
      </div>
    </>}
    {install.consent}
  </section>
}

const OAUTH_STATE: Record<PluginOAuthClientView['state'], { label: () => string; state: DotState }> = {
  signed_in: { label: m.plugins_oauth_signed_in, state: 'ok' },
  sign_in_needed: { label: m.plugins_oauth_sign_in_needed, state: 'warning' },
  revoked: { label: m.plugins_oauth_revoked, state: 'warning' },
  logged_out: { label: m.plugins_oauth_logged_out, state: 'idle' },
}

/** TAL-1276: one OAuth client the plugin declares, its sign-in state, and its Sign in / Sign out actions for the server owner. */
function PluginOAuthClientRow({ pluginKey, client, editable }: { pluginKey: string; client: PluginOAuthClientView; editable: boolean }) {
  const qc = useQueryClient()
  const refresh = () => { void qc.invalidateQueries({ queryKey: keys.plugins }) }
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
        <StatusDot state={state.state}>{state.label()}</StatusDot>
        {editable && client.can_sign_out ? <IconButton variant="ghost" label={m.plugins_oauth_sign_out()} disabled={signOut.isPending} onClick={() => signOut.mutate()}><LogOut aria-hidden="true" /></IconButton> : null}
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
        <IconButton type="submit" variant="default" label={m.oauth_plugin_paste_submit()} disabled={submit.isPending || !url.trim()}><Check aria-hidden="true" /></IconButton>
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
      <div className="flex justify-end pt-1"><IconButton type="submit" variant="default" label={m.save()} disabled={Object.keys(drafts).length === 0}><Check aria-hidden="true" /></IconButton></div>

    </form>
  )
}
