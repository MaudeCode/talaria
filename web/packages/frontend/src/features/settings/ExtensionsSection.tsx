import { useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, ChevronDown, ChevronRight, Download, LoaderCircle, Puzzle, Search } from 'lucide-react'
import type { ExtensionRegistryEntry } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { fetchExtensionManifestList } from '../../extensions/registry'
import type { ExtensionManifest } from '../../contracts/extension'
import { readExtensionSettings, writeExtensionSetting, type SettingValue } from '../../extensions/host'
import { currentLocale } from '../../i18n/runtime'
import { StatusDot } from '../../ui/Badge'
import { IconButton, iconButtonClass } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionsMenu } from '../../ui/RowActionsMenu'
import { Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { useBootstrap } from '../../app/bootstrap'
import { useDebounced } from '../../lib/useDebounced'
import { useResourceEffects, useResourceMutation, withEffects, type ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
import { Row, RowList } from '../../ui/List'
import { cn } from '../../ui/cn'
import { SettingRow, SettingsGroup, SettingsStats, SETTINGS_PAGE } from './SettingsGroup'

const GUIDE = 'https://github.com/MaudeCode/talaria/blob/main/web/docs/architecture/extension-migration-guide.md'

/** What a declared permission lets an extension do, after "Can"; installed and gallery rows share it. An unknown key reads as itself. */
const PERMISSION_WORDS: Record<string, () => string> = {
  webui_api: m.extensions_permission_webui_api, webui_navigation: m.extensions_permission_webui_navigation, dom: m.extensions_permission_dom,
  storage: m.extensions_permission_storage, loopback_sidecar: m.extensions_permission_loopback_sidecar, native_host: m.extensions_permission_native_host,
  filesystem: m.extensions_permission_filesystem, network_external: m.extensions_permission_network_external, sidecar_commands: m.extensions_permission_sidecar_commands,
  registers_skin: m.extensions_permission_registers_skin, embeds_iframe: m.extensions_permission_embeds_iframe, requires_csp_frame_extra: m.extensions_permission_requires_csp_frame_extra,
}
const canLine = (permissions: readonly string[]): string =>
  m.extensions_can({ list: new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(permissions.map((p) => PERMISSION_WORDS[p]?.() ?? p.replaceAll('_', ' '))) })

/** Installed extensions and the gallery, both filtered by the server, with the server's counts; sidecar consent, install, and the legacy-injection notice. */
export function ExtensionsSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const q = useDebounced(filter.trim(), 250)
  const manifests = useQuery({ queryKey: [...keys.extensions.manifests, { q }], queryFn: ({ signal }) => fetchExtensionManifestList(q, signal), staleTime: 30_000, placeholderData: keepPreviousData })
  const registry = useQuery({ queryKey: [...keys.extensions.registry, { q }], queryFn: () => api.fetchExtensionRegistry(q), staleTime: 5 * 60_000, retry: false, placeholderData: keepPreviousData })
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const effects = useResourceEffects<boolean>()
  const toggle = useResourceMutation({
    resource: ({ id }: { id: string; enabled: boolean }) => `extension:${id}`,
    effect: ({ enabled }) => ({ value: enabled }),
    queryKey: keys.extensions.all,
    readKeys: () => [keys.extensions.manifests, keys.extensions.status],
    mutationFn: async ({ id, enabled }) => api.extensionAction('toggle', { id, enabled }),
    onSuccess: () => showToast(m.saved()),
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  const uninstall = useResourceMutation({
    resource: (id: string) => `extension:${id}`, effect: () => ({ remove: true }),
    queryKey: keys.extensions.all, readKeys: () => [keys.extensions.manifests, keys.extensions.status, keys.extensions.registry],
    mutationFn: async (id) => { await api.extensionAction('uninstall', { id }) },
    onSuccess: () => showToast(m.saved()),
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  const consent = useResourceMutation({
    resource: ({ id }: { id: string; consent: boolean }) => `extension-consent:${id}`, effect: ({ consent }) => ({ value: consent }),
    queryKey: keys.extensions.all, readKeys: () => [keys.extensions.manifests, keys.extensions.status],
    mutationFn: async ({ id, consent }) => { await api.extensionAction('sidecar-proxy-consent', { id, consent }) },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  // Install fetches and verifies a package on the server, so only the clicked row waits; it stays busy until the reread
  // lands, so it turns to "Installed" without showing Install again. Never replayed: an unknown outcome reads back.
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set())
  const install = useMutation({
    mutationFn: async (g: ExtensionRegistryEntry) => { await api.extensionAction('install', { id: g.id, download_url: g.download_url, sha256: g.sha256 }) },
    retry: false,
    onMutate: (g) => { setInstalling((cur) => new Set(cur).add(g.id)) },
    onSuccess: () => showToast(m.saved()),
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
    onSettled: async (_r, _e, g) => {
      await qc.invalidateQueries({ queryKey: keys.extensions.all })
      setInstalling((cur) => { const next = new Set(cur); next.delete(g.id); return next })
    },
  })
  if (manifests.isPending) return <LoadingState />
  if (manifests.isError && !manifests.data) return <ErrorState error={manifests.error} onRetry={() => { void manifests.refetch() }} />
  const list = withEffects(manifests.data.manifests, (e) => `extension:${e.id}`, effects)
  const gallery = registry.data
  const canManage = bootstrap.auth.can_manage_server
  const disclose = (id: string) => setOpen((cur) => cur === id ? null : id)
  return (
    <div className={SETTINGS_PAGE}>
      <SettingsStats label={m.extensions_stats()} stats={[
        { id: 'installed', label: m.ext_gallery_installed(), value: String(manifests.data.total) },
        { id: 'enabled', label: m.extensions_stat_enabled(), value: String(manifests.data.enabled_count) },
        { id: 'gallery', label: m.extensions_stat_gallery(), value: gallery && !gallery.error ? String(gallery.total) : '—' },
      ]} />
      <div className="relative">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <TextInput type="search" className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.extensions_filter()} aria-label={m.extensions_filter()} />
      </div>
      <SettingsGroup id="installed" title={m.ext_gallery_installed()} detail={manifests.data.total}>
        {list.length === 0 && <EmptyState compact>{q ? m.extensions_filter_empty() : m.extensions_none()}</EmptyState>}
        <RowList>
          {list.map((e) => <ExtensionRow key={e.id} ext={e} canManage={canManage} open={open === `installed:${e.id}`} onDisclose={() => disclose(`installed:${e.id}`)} effect={effects[`extension:${e.id}`]} consentEffect={effects[`extension-consent:${e.id}`]} onToggle={(enabled) => toggle.mutate({ id: e.id, enabled })} onConsent={(value) => consent.mutate({ id: e.id, consent: value })} onUninstall={() => setConfirmUninstall(e.id)} />)}
        </RowList>
      </SettingsGroup>
      <SettingsGroup id="gallery" title={m.extensions_gallery()} detail={gallery?.total}>
        {registry.isPending && <LoadingState />}
        {(registry.isError || gallery?.error) && <p className="py-2 text-xs text-muted">{m.extensions_unavailable()}</p>}
        {gallery && !gallery.error && gallery.entries.length === 0 && <EmptyState compact>{m.extensions_filter_empty()}</EmptyState>}
        <RowList>
          {gallery?.entries.map((g) => <GalleryRow key={g.id} entry={g} canManage={canManage} open={open === `gallery:${g.id}`} onDisclose={() => disclose(`gallery:${g.id}`)} busy={installing.has(g.id)} onInstall={() => install.mutate(g)} />)}
        </RowList>
      </SettingsGroup>
      <ConfirmDialog open={confirmUninstall !== null} onOpenChange={(o) => { if (!o) setConfirmUninstall(null) }} title={m.extensions_uninstall()} description={confirmUninstall ?? ''} confirmLabel={m.extensions_uninstall()} cancelLabel={m.cancel()} danger onConfirm={() => { if (confirmUninstall) uninstall.mutate(confirmUninstall) }} />
    </div>
  )
}

/** The puzzle row icon, a row's chevron, and the details it opens in place: one layout for installed and gallery rows. */
function ExtensionRowFrame({ title, summary, controls, open, onDisclose, children }: { title: ReactNode; summary: ReactNode; controls: ReactNode; open: boolean; onDisclose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <Puzzle size={18} strokeWidth={1.75} aria-hidden="true" data-row-icon="" className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">{title}{summary}</div>
        <div className="flex shrink-0 items-center gap-1">
          {controls}
          <IconButton variant="ghost" label={open ? m.extensions_details_hide() : m.extensions_details_show()} aria-expanded={open} onClick={onDisclose}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</IconButton>
        </div>
      </div>
      {open && <div className="flex min-w-0 flex-col gap-2 pl-[30px] text-xs text-muted" data-extension-details="">{children}</div>}
    </>
  )
}

/** The permissions an extension declares, after a warning dot, read whole. */
function Permissions({ permissions }: { permissions: readonly string[] }) {
  return <div className="flex min-w-0"><StatusDot state="warning" wrap>{canLine(permissions)}</StatusDot></div>
}

interface ExtensionRowProps { ext: ExtensionManifest; canManage: boolean; open: boolean; onDisclose: () => void; effect: ResourceEffect<boolean> | undefined; consentEffect: ResourceEffect<boolean> | undefined; onToggle: (enabled: boolean) => void; onConsent: (consent: boolean) => void; onUninstall: () => void }

function ExtensionRow({ ext, canManage, open, onDisclose, effect, consentEffect, onToggle, onConsent, onUninstall }: ExtensionRowProps) {
  const perms = Object.entries(ext.permissions ?? {}).filter(([, v]) => v).map(([k]) => k)
  const navigate = useNavigate()
  const openable = !!(ext.panel || ext.native_view) && ext.enabled
  const actions: RowAction[] = [
    ...(openable ? [{ label: m.extensions_open(), run: () => { void navigate({ to: '/ext/$extensionId', params: { extensionId: ext.id } }) } }] : []),
    ...(canManage && ext.source === 'gallery' ? [{ label: m.extensions_uninstall(), run: onUninstall, danger: true }] : []),
  ]
  const warning = (w: string) => w === 'web_extension_migration_required' ? m.extensions_web_migration_required() : w
  // Closed, a legacy notice or the first warning takes the description's line.
  const notice = ext.legacy_injection ? m.extensions_legacy_notice() : ext.warnings[0] ? warning(ext.warnings[0]) : null
  const summary = !open && notice
    ? <div className="flex min-w-0" {...(ext.legacy_injection ? { role: 'status' } : {})}><StatusDot state="warning" title={notice}>{notice}</StatusDot></div>
    : ext.description ? <div className="truncate text-xs text-muted" title={ext.description}>{ext.description}</div> : null
  const origin = [ext.agent_host ? m.tab_agent() : ext.source, ext.display_id ?? ext.id].join(' · ')
  return (
    <RowContextMenu label={m.extensions_row_menu()} actions={actions} trigger={<Row className={cn('gap-3', !ext.enabled && 'opacity-80')} data-extension-id={ext.id} data-source={ext.source}>
      <ExtensionRowFrame title={<ExtensionName name={ext.name} version={ext.version} />} summary={summary} open={open} onDisclose={onDisclose} controls={<>
        {openable && <Tooltip label={m.extensions_open()} side="top"><Link to="/ext/$extensionId" params={{ extensionId: ext.id }} aria-label={m.extensions_open()} className={iconButtonClass('ghost')}><ArrowUpRight aria-hidden="true" /></Link></Tooltip>}
        {canManage && ext.can_toggle && (
          <ResourceSwitch effect={effect} checked={ext.enabled} onCheckedChange={(checked) => onToggle(checked)} aria-label={ext.name} stateLabel={(enabled) => enabled ? m.plugins_enabled() : m.plugins_disabled()} />
        )}
        <RowActionsMenu label={m.extensions_row_menu()} actions={actions} />
      </>}>
        <p className="font-mono [overflow-wrap:anywhere]">{origin}</p>
        {ext.capabilities.length > 0 && <p data-extension-capabilities="">{ext.capabilities.join(' · ')}</p>}
        {perms.length > 0 && <Permissions permissions={perms} />}
        {ext.settings_schema.length > 0 && <ExtensionSettings ext={ext} />}
        {ext.sidecar && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{ext.sidecar.origin}</span>
            {canManage && <label className="flex items-center gap-1"><ResourceSwitch effect={consentEffect} checked={!!ext.sidecar.consented} onCheckedChange={(checked) => onConsent(checked)} /> {m.extensions_sidecar_consent()}</label>}
          </div>
        )}
        {(ext.legacy_injection || ext.warnings.length > 0) && (
          <div className="flex flex-col gap-1 text-warning">
            {ext.legacy_injection && <p role="status">{m.extensions_legacy_notice()} <a href={GUIDE} target="_blank" rel="noopener noreferrer" className="underline">{m.extensions_migration_guide()}</a></p>}
            {ext.warnings.length > 0 && <ul>{ext.warnings.map((w) => <li key={w}>{warning(w)}</li>)}</ul>}
          </div>
        )}
      </ExtensionRowFrame>
    </Row>} />
  )
}

function GalleryRow({ entry: g, canManage, open, onDisclose, busy, onInstall }: { entry: ExtensionRegistryEntry; canManage: boolean; open: boolean; onDisclose: () => void; busy: boolean; onInstall: () => void }) {
  const actions: RowAction[] = !g.installed && canManage ? [{ label: m.extensions_install(), run: onInstall, disabled: busy, busy, icon: Download }] : []
  return (
    <RowContextMenu label={m.extensions_row_menu()} actions={actions} trigger={<Row className="gap-3" data-gallery-id={g.id}>
      <ExtensionRowFrame title={<ExtensionName name={g.name} version={g.version} />} open={open} onDisclose={onDisclose}
        summary={!open && g.description ? <div className="truncate text-xs text-muted" title={g.description}>{g.description}</div> : null}
        controls={g.installed ? <span className="px-2 text-xs text-muted">{m.ext_gallery_installed()}</span>
          : canManage && <IconButton variant="default" label={m.extensions_install()} onClick={onInstall} disabled={busy} aria-busy={busy || undefined}>
            {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download aria-hidden="true" />}
          </IconButton>}>
        {g.description && <p className="text-sm text-text [overflow-wrap:anywhere]">{g.description}</p>}
        {g.permissions.length > 0 ? <Permissions permissions={g.permissions} /> : <div className="flex min-w-0"><StatusDot state="idle" wrap>{m.extensions_permissions_after_install()}</StatusDot></div>}
        {g.capabilities.length > 0 && <p>{g.capabilities.join(' · ')}</p>}
        {g.homepage && <a href={g.homepage} target="_blank" rel="noopener noreferrer" className="self-start text-accent-text underline">{m.extensions_homepage()}</a>}
      </ExtensionRowFrame>
    </Row>} />
  )
}

/** A row's header line: the name, then the version in muted text. */
function ExtensionName({ name, version }: { name: string; version?: string | undefined }) {
  return <div className="flex min-w-0 items-baseline gap-x-2 text-sm font-medium text-text"><span className="truncate">{name}</span>{version && <span className="shrink-0 text-xs font-normal text-muted">{version}</span>}</div>
}

/** The extension's settings_schema as a form; each change saves to the browser-local settings the extension reads. */
function ExtensionSettings({ ext }: { ext: ExtensionManifest }) {
  const [values, setValues] = useState(() => readExtensionSettings(ext))
  const save = (key: string, value: SettingValue) => {
    try {
      const saved = writeExtensionSetting(ext, key, value)
      setValues((cur) => ({ ...cur, [key]: saved }))
    } catch {
      /* a value the schema rejects (a fraction in an integer field) keeps the saved one */
    }
  }
  return (
    <div className="flex flex-col divide-y divide-border-subtle border-t border-border-subtle text-sm">
      {ext.settings_schema.map((f) => {
        const id = `ext-setting-${ext.id}-${f.key}`
        const value = values[f.key]
        return (
          <SettingRow key={f.key} label={f.label} htmlFor={id} {...(f.description ? { hint: f.description } : {})}>
            {f.type === 'boolean' ? <Switch id={id} checked={value === true} onCheckedChange={(checked) => save(f.key, checked)} />
              : f.type === 'enum' ? <Select id={id} value={String(value ?? '')} onValueChange={(v) => save(f.key, v)}>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
              : f.type === 'string' ? <div className="w-48 max-w-[50vw]"><TextInput id={id} maxLength={2000} value={String(value ?? '')} onChange={(e) => save(f.key, e.target.value)} /></div>
              : <NumberSetting id={id} integer={f.type === 'integer'} value={value ?? null} onSave={(n) => save(f.key, n)} />}
          </SettingRow>
        )
      })}
    </div>
  )
}

/** Holds the typed text while editing; a value the schema rejects (blank, or a fraction in an integer field) is flagged and shows the saved value again on blur. */
function NumberSetting({ id, integer, value, onSave }: { id: string; integer: boolean; value: SettingValue; onSave: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const saved = String(value ?? '')
  const invalid = draft !== null && (draft.trim() === '' || Number(draft) !== value)
  return (
    <div className="w-28">
      <TextInput id={id} type="number" step={integer ? 1 : 'any'} aria-invalid={invalid || undefined} className="aria-invalid:border-error" value={draft ?? saved}
        onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim() !== '') onSave(Number(e.target.value)) }} onBlur={() => setDraft(null)} />
    </div>
  )
}
