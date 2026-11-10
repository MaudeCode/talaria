import { memo, useContext, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PluginAutoUpdateView, PluginOAuthClientView, PluginSettingView, PluginUpdateAllRow, PluginUpdateResult } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Box, Brain, Check, ChevronDown, ChevronRight, ChevronsLeft, CircleArrowUp, Clock, Cpu, Download, Ellipsis, Globe, Image, Info, Lock, LogOut, MessageSquare, Plus, Search, Settings2, Video, type LucideIcon } from 'lucide-react'
import { IconButton } from '../../ui/Button'
import { Mark, StatusDot, type DotState } from '../../ui/Badge'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { ConfirmDialog } from '../../ui/Dialog'
import { FieldRow, Switch, TextInput } from '../../ui/Field'
import { cn } from '../../ui/cn'
import { HubHeadSlotsContext } from '../../shell/hubHeadSlots'
import { QuotaMeter } from '../insights/QuotaMeter'
import { SETTINGS_PAGE, SettingRow, SettingsGroup, SettingsStats } from './SettingsGroup'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { OAuthSignIn } from '../onboarding/OAuthSignIn'
import { useResourceEffects, useResourceMutation, type ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
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
  const enabledEffects = useResourceEffects<boolean>()
  // TAL-2133: the switch moves at once; the group meters and figures follow from the reread, and a refusal rolls it back.
  const setEnabled = useResourceMutation({
    resource: ({ key }: { key: string; enabled: boolean }) => enabledResource(key), effect: ({ enabled }) => ({ value: enabled }), queryKey: keys.plugins,
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => api.setPluginEnabled(key, enabled),
    onSuccess: (result) => { if (result.restart_required) showToast(m.plugins_toggle_restart_required(), 10000) },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  const [open, setOpen] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const head = useContext(HubHeadSlotsContext)
  // TAL-2132: "Add plugin" opens the catalog; it is the section heading's primary action.
  const add = <IconButton variant="primary" label={m.plugins_add()} active={browsing} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}><Plus aria-hidden="true" /></IconButton>
  const addButton = head?.actions ? createPortal(add, head.actions) : <div className="flex justify-end">{add}</div>
  if (plugins.isPending) return <>{addButton}<LoadingState /></>
  if (plugins.isError) return <>{addButton}<ErrorState error={plugins.error} onRetry={() => { void plugins.refetch() }} /></>
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
  const { groups, summary } = plugins.data
  const rowProps = (p: InstalledPlugin) => ({ plugin: p, editable, open: open === p.key, onOpen: setOpen, updateBusy, updating: update.isPending && update.variables.key === p.key,
    blockedFindings: scan?.key === p.key && scan.status === 'blocked' ? scan.findings : null, onUpdate: requestUpdate, enabledEffect: enabledEffects[enabledResource(p.key)], onSetEnabled: setEnabled.mutate })
  // TAL-2132: with the server's groups, Update all shows only while a plugin has an update; an older server keeps the install-wide button.
  const updateAllButton = autoUpdate && (summary ? summary.updates > 0 : installed)
    ? <IconButton variant="ghost" label={m.plugins_update_all()} disabled={updateBusy} aria-busy={updateAll.isPending} onClick={requestUpdateAll}><CircleArrowUp aria-hidden="true" /></IconButton> : null
  return (
    <div className={SETTINGS_PAGE} data-section="plugins">
      {addButton}
      {browsing && <PluginCatalogList updating={updateBusy} updatingKey={update.isPending ? update.variables.key : null} onUpdate={requestUpdate} />}
      {groups && summary && <SettingsStats label={m.settings_section_plugins_title()} stats={[
        { id: 'installed', label: m.plugins_group_installed(), value: String(summary.installed) },
        { id: 'bundled', label: m.plugins_builtin(), value: String(summary.bundled) },
        { id: 'enabled', label: m.plugins_stat_enabled(), value: String(summary.enabled), mode: m.plugins_stat_of({ total: summary.total }) },
        { id: 'updates', label: m.plugins_stat_updates(), value: String(summary.updates), tone: summary.updates_tone ?? undefined },
      ]} />}
      {plugins.data.read_only && <div className="flex min-w-0"><StatusDot state="warning" title={m.plugins_read_only()}>{m.plugins_read_only()}</StatusDot></div>}
      {plugins.data.plugin_isolation_advisory && <div className="flex min-w-0" data-advisory="plugin-isolation"><StatusDot state="warning" title={m.plugins_isolation_advisory()}>{m.plugins_isolation_advisory()}</StatusDot></div>}
      {updatedAll?.context === streamContext && updatedAll.rows.length > 0 && <PluginUpdateAllResults rows={updatedAll.rows} />}
      {installed && <TextInput type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.plugins_filter()} aria-label={m.plugins_filter()} />}
      {installed && list.length === 0 && <EmptyState compact>{m.plugins_filter_empty()}</EmptyState>}
      {groups && summary
        ? <PluginGroups groups={groups} bundled={summary.bundled} plugins={list} filtering={q !== ''} browsing={browsing} rowProps={rowProps} updateAll={updateAllButton} autoUpdate={autoUpdate} />
        : <div className="flex flex-col gap-2">
          {updateAllButton && <div className="flex justify-end">{updateAllButton}</div>}
          {autoUpdate && <PluginAutoUpdateRow state={autoUpdate} />}
          {!installed && <EmptyState compact>{browsing ? m.plugins_catalog_no_installed() : m.plugins_empty()}</EmptyState>}
          <ul className="flex flex-col divide-y divide-border-subtle">{list.map((p) => <InstalledPluginRow key={p.key} {...rowProps(p)} />)}</ul>
        </div>}
      <ConfirmDialog open={scan?.status === 'needs_consent'} onOpenChange={(isOpen) => { if (!isOpen) setScan((current) => current === scan && current?.status === 'needs_consent' ? null : current) }}
        title={m.plugins_update_consent()} description={scan?.findings} confirmLabel={m.plugins_update()} cancelLabel={m.cancel()} danger
        onConfirm={() => { if (scan?.status === 'needs_consent') requestUpdate(scan.key, true, scan.consent_token) }} />
    </div>
  )
}

type PluginsView = Awaited<ReturnType<typeof api.fetchPlugins>>
type InstalledPlugin = PluginsView['plugins'][number]
type PluginGroup = NonNullable<PluginsView['groups']>[number]
type RowProps = Omit<InstalledPluginRowProps, 'nested'>
const enabledResource = (key: string) => `plugin-enabled:${key}`

/** TAL-2132: each group's symbol and name (layout only; the server decides the groups). */
const GROUP: Record<PluginGroup['id'], { icon: LucideIcon; label: () => string }> = {
  installed: { icon: Box, label: m.plugins_group_installed },
  platforms: { icon: MessageSquare, label: m.plugins_group_platforms },
  web: { icon: Search, label: m.plugins_group_web },
  image_gen: { icon: Image, label: m.plugins_group_image_gen },
  video_gen: { icon: Video, label: m.plugins_group_video_gen },
  browser: { icon: Globe, label: m.plugins_group_browser },
  dashboard_auth: { icon: Lock, label: m.plugins_group_dashboard_auth },
  memory: { icon: Brain, label: m.plugins_group_memory },
  model_providers: { icon: Cpu, label: m.plugins_group_model_providers },
  other: { icon: Ellipsis, label: m.plugins_group_other },
}

/**
 * TAL-2132: the profile's own plugins, then the Agent's in one collapsible row per group. Groups open on a click and start
 * closed; while the filter has text the server lists only the groups with a match, and each is open.
 */
function PluginGroups({ groups, bundled, plugins, filtering, browsing, rowProps, updateAll, autoUpdate }: { groups: PluginGroup[]; bundled: number; plugins: InstalledPlugin[]; filtering: boolean; browsing: boolean; rowProps: (p: InstalledPlugin) => RowProps; updateAll: ReactNode; autoUpdate: PluginAutoUpdateView | undefined }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const byKey = new Map(plugins.map((p) => [p.key, p]))
  const rows = (group: PluginGroup) => group.plugin_keys.flatMap((key) => byKey.get(key) ?? [])
  const mine = groups.find((g) => g.id === 'installed')
  const installedRows = mine ? rows(mine) : []
  const shown = groups.filter((g) => g.id !== 'installed')
  const toggle = (id: string) => setExpanded((cur) => { const next = new Set(cur); if (!next.delete(id)) next.add(id); return next })
  return <>
    {mine && <SettingsGroup id="installed" title={m.plugins_group_installed()} detail={mine.total_count} action={updateAll}>
      {!filtering && mine.total_count === 0 && <EmptyState compact>{browsing ? m.plugins_catalog_no_installed() : m.plugins_empty()}</EmptyState>}
      {installedRows.map((p) => <InstalledPluginRow key={p.key} {...rowProps(p)} />)}
      {autoUpdate && !filtering && <PluginAutoUpdateRow state={autoUpdate} />}
    </SettingsGroup>}
    {shown.length > 0 && <SettingsGroup id="bundled" title={m.plugins_builtin()} detail={bundled}>
      {shown.map((group) => {
        const isOpen = filtering || expanded.has(group.id)
        return <div key={group.id} data-plugin-group={group.id}>
          <PluginGroupRow group={group} open={isOpen} onToggle={() => toggle(group.id)} />
          {isOpen && <ul id={`plugin-group-${group.id}`} className="flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
            {rows(group).map((p) => <InstalledPluginRow key={p.key} {...rowProps(p)} nested />)}
          </ul>}
        </div>
      })}
    </SettingsGroup>}
  </>
}

/** One built-in group's disclosure: its symbol, name, the share turned on as a thin meter and a count, and a chevron. */
function PluginGroupRow({ group, open, onToggle }: { group: PluginGroup; open: boolean; onToggle: () => void }) {
  const { icon: Icon, label } = GROUP[group.id]
  const on = group.enabled_count === group.total_count ? m.plugins_group_on({ count: group.enabled_count }) : m.plugins_group_on_of({ enabled: group.enabled_count, total: group.total_count })
  const Chevron = open ? ChevronDown : ChevronRight
  return <button type="button" aria-expanded={open} aria-controls={`plugin-group-${group.id}`} onClick={onToggle}
    className="flex min-h-11 w-full items-center gap-2.5 py-2 text-left text-sm text-text transition-colors hover:text-accent-text focus-visible:outline-2 focus-visible:outline-accent">
    <Icon size={18} strokeWidth={1.75} aria-hidden="true" data-row-icon="" className="shrink-0 text-muted" />
    <span className="min-w-0 flex-1 truncate font-medium">{label()}</span>
    <QuotaMeter thin level="healthy" percent={group.enabled_percent} marker={null} label={`${label()}, ${on}`} />
    <span className="shrink-0 text-xs font-medium tabular-nums">{on}</span>
    <Chevron size={14} aria-hidden="true" className="shrink-0 text-muted" />
  </button>
}

interface InstalledPluginRowProps {
  plugin: InstalledPlugin
  editable: boolean
  open: boolean
  onOpen: (key: string | null) => void
  updateBusy: boolean
  updating: boolean
  blockedFindings: string | null
  onUpdate: (key: string) => void
  enabledEffect: ResourceEffect<boolean> | undefined
  onSetEnabled: (value: { key: string; enabled: boolean }) => void
  /** Inside a built-in group: indented, without the row symbol. */
  nested?: boolean
}

// Memoized so typing in the filter renders only the rows entering the list (TAL-1405); each filter answer is a new response.
const InstalledPluginRow = memo(function InstalledPluginRow({ plugin: p, editable, open, onOpen, updateBusy, updating, blockedFindings, onUpdate, enabledEffect, onSetEnabled, nested }: InstalledPluginRowProps) {
  const name = p.name ?? p.key
  const control = p.can_toggle
    ? <ResourceSwitch effect={enabledEffect} checked={p.enabled === true} onCheckedChange={(enabled) => onSetEnabled({ key: p.key, enabled })} aria-label={name} stateLabel={(on) => on ? m.plugins_enabled() : m.plugins_disabled()} />
    : undefined
  return (
    <PluginRow id={p.key} icon={nested ? undefined : Box} nested={nested} title={<>{name}{p.version ? <span className="ml-1 text-xs font-normal tabular-nums text-muted">{p.version}</span> : null}{p.is_active_provider && <span className="ml-2"><Mark>{m.plugins_in_use()}</Mark></span>}</>}
      description={p.description ?? ''} note={p.update?.available ? <StatusDot state="warning">{m.plugins_update_available()}</StatusDot> : undefined}
      status={!control && p.enabled === false ? <span className="text-xs text-muted">{m.plugins_off()}</span> : null} control={control} actions={[
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
 * TAL-2132: `note` takes the description's line (an update waiting); `icon` leads the row, and a `nested` row is indented under its group.
 * TAL-2133: `control` (the on/off switch) ends the row after its actions; on a narrow row both wrap together to the right.
 */
function PluginRow({ id, icon: Icon, nested, title, description, note, status, actions, control, children }: { id?: string; icon?: LucideIcon | undefined; nested?: boolean | undefined; title: ReactNode; description: string; note?: ReactNode; status: ReactNode; actions: PluginRowAction[]; control?: ReactNode; children?: ReactNode }) {
  const row = <li className={cn('list-none py-2', nested && 'pl-7')} data-plugin={id}><div className="flex flex-wrap items-center gap-3">
    {Icon && <Icon size={18} strokeWidth={1.75} aria-hidden="true" data-row-icon="" className="shrink-0 text-muted" />}
    <div className="min-w-0 flex-1 basis-40"><div className="flex min-w-0 items-baseline text-sm font-medium text-text">{title}</div>
      {note ? <div className="flex min-w-0">{note}</div> : <div className="truncate text-xs text-muted" title={description || undefined}>{description}</div>}</div>
    {status}
    {control ? <div className="ml-auto flex shrink-0 items-center gap-3"><RowActionButtons actions={actions} />{control}</div> : <RowActionButtons actions={actions} />}
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
  return <SettingRow label={m.plugins_auto_update()} htmlFor="plugins-auto-update" icon={Clock}>
    <div className="flex items-center gap-3">
      {status && (state.inactive_reason ? <StatusDot state="warning">{status}</StatusDot> : <span className="text-xs tabular-nums text-muted">{status}</span>)}
      <Switch id="plugins-auto-update" checked={enabled} onCheckedChange={(checked) => save.mutate(checked)} />
    </div>
  </SettingRow>
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
