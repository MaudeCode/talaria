import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, Download, Trash2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useExtensionManifests } from '../../extensions/registry'
import type { ExtensionManifest } from '../../contracts/extension'
import { readExtensionSettings, writeExtensionSetting, type SettingValue } from '../../extensions/host'
import { Mark, StatusDot } from '../../ui/Badge'
import { IconButton, iconButtonClass } from '../../ui/Button'
import { Tooltip } from '../../ui/Tooltip'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { Switch, TextInput } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { useBootstrap } from '../../app/bootstrap'
import { useResourceEffects, useResourceMutation, withEffects, type ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
import { Row, RowList } from '../../ui/List'
import { cn } from '../../ui/cn'
import { SettingRow, SettingsGroup, SETTINGS_PAGE } from './SettingsGroup'

const GUIDE = 'https://github.com/MaudeCode/talaria/blob/main/web/docs/architecture/extension-migration-guide.md'

/** Installed extensions from the unified manifest list, sidecar consent, gallery install, and the legacy-injection migration notice. */
export function ExtensionsSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const manifests = useExtensionManifests()
  const registry = useQuery({ queryKey: keys.extensions.registry, queryFn: api.fetchExtensionRegistry, staleTime: 5 * 60_000, retry: false })
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.extensions.manifests }); void qc.invalidateQueries({ queryKey: keys.extensions.status }) }
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
    queryKey: keys.extensions.all, readKeys: () => [keys.extensions.manifests, keys.extensions.status],
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
  // Install fetches and verifies a package on the server: only its button waits.
  const act = useMutation({
    mutationFn: async ({ action, body }: { action: Parameters<typeof api.extensionAction>[0]; body: Record<string, unknown> }) => { await api.extensionAction(action, body) },
    onSuccess: () => { showToast(m.saved()); invalidate() },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  if (manifests.isPending) return <LoadingState />
  if (manifests.isError && !manifests.data) return <ErrorState error={manifests.error} onRetry={() => { void manifests.refetch() }} />
  const list = withEffects(manifests.data?.manifests ?? [], (e) => `extension:${e.id}`, effects)
  const gallery = ((registry.data?.entries ?? registry.data?.extensions ?? []) as { id?: string; name?: string; description?: string; version?: string; download_url?: string; sha256?: string }[]).filter((g) => g.id)
  const installed = new Set(list.map((e) => e.id))
  const canManage = bootstrap.auth.can_manage_server
  return (
    <div className={SETTINGS_PAGE}>
      <SettingsGroup id="installed" title={m.extensions_installed()}>
        {list.length === 0 && <EmptyState compact>{m.extensions_none()}</EmptyState>}
        <RowList>
          {list.map((e) => <ExtensionRow key={e.id} ext={e} canManage={canManage} effect={effects[`extension:${e.id}`]} consentEffect={effects[`extension-consent:${e.id}`]} onToggle={(enabled) => toggle.mutate({ id: e.id, enabled })} onConsent={(value) => consent.mutate({ id: e.id, consent: value })} onUninstall={() => setConfirmUninstall(e.id)} />)}
        </RowList>
      </SettingsGroup>
      <SettingsGroup id="gallery" title={m.extensions_gallery()}>
        {registry.isPending && <LoadingState />}
        {(registry.isError || registry.data?.unavailable) && <p className="py-2 text-xs text-muted">{m.extensions_unavailable()}</p>}
        <RowList>
          {gallery.map((g) => {
            const install: RowAction[] = !installed.has(g.id ?? '') && canManage ? [{ label: m.extensions_install(), run: () => act.mutate({ action: 'install', body: { id: g.id, download_url: g.download_url, sha256: g.sha256 } }), disabled: act.isPending, icon: Download }] : []
            return (
              <RowContextMenu key={g.id} label={m.extensions_row_menu()} actions={install} trigger={<Row>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <ExtensionName name={g.name ?? g.id ?? ''} version={g.version} />
                    {g.description && <div className="truncate text-xs text-muted" title={g.description}>{g.description}</div>}
                  </div>
                  {installed.has(g.id ?? '') ? <Mark>{m.ext_gallery_installed()}</Mark> : canManage && <IconButton variant="default" label={m.extensions_install()} onClick={install[0]?.run} disabled={act.isPending}><Download aria-hidden="true" /></IconButton>}
                </div>
              </Row>} />
            )
          })}
        </RowList>
      </SettingsGroup>
      <ConfirmDialog open={confirmUninstall !== null} onOpenChange={(o) => { if (!o) setConfirmUninstall(null) }} title={m.extensions_uninstall()} description={confirmUninstall ?? ''} confirmLabel={m.extensions_uninstall()} cancelLabel={m.cancel()} danger onConfirm={() => { if (confirmUninstall) uninstall.mutate(confirmUninstall) }} />
    </div>
  )
}

function ExtensionRow({ ext, canManage, effect, consentEffect, onToggle, onConsent, onUninstall }: { ext: ExtensionManifest; effect: ResourceEffect<boolean> | undefined; consentEffect: ResourceEffect<boolean> | undefined; canManage: boolean; onToggle: (enabled: boolean) => void; onConsent: (consent: boolean) => void; onUninstall: () => void }) {
  const perms = Object.entries(ext.permissions ?? {}).filter(([, v]) => v).map(([k]) => k)
  const navigate = useNavigate()
  const openable = !!(ext.panel || ext.native_view) && ext.enabled
  const actions: RowAction[] = [
    ...(openable ? [{ label: m.extensions_open(), run: () => { void navigate({ to: '/ext/$extensionId', params: { extensionId: ext.id } }) } }] : []),
    ...(canManage && ext.source === 'gallery' ? [{ label: m.extensions_uninstall(), run: onUninstall, danger: true }] : []),
  ]
  // TAL-2131: the source word leads the second line instead of a chip.
  const second = [ext.agent_host ? m.tab_agent() : ext.source, ext.display_id ?? ext.id, ext.description].filter(Boolean).join(' · ')
  return (
    <RowContextMenu label={m.extensions_row_menu()} actions={actions} trigger={<Row className={cn(!ext.enabled && 'opacity-80')} data-extension-id={ext.id} data-source={ext.source}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <ExtensionName name={ext.name} version={ext.version} />
          <div className="truncate text-xs text-muted" title={second}>{second}</div>
        </div>
        {openable && <Tooltip label={m.extensions_open()} side="top"><Link to="/ext/$extensionId" params={{ extensionId: ext.id }} aria-label={m.extensions_open()} className={iconButtonClass('default')}><ArrowUpRight aria-hidden="true" /></Link></Tooltip>}
        {canManage && ext.can_toggle && (
          <ResourceSwitch effect={effect} checked={ext.enabled} onCheckedChange={(checked) => onToggle(checked)} aria-label={ext.name} stateLabel={(enabled) => enabled ? m.plugins_enabled() : m.plugins_disabled()} />
        )}
        {canManage && ext.source === 'gallery' && <IconButton variant="danger" label={m.extensions_uninstall()} onClick={onUninstall}><Trash2 aria-hidden="true" /></IconButton>}
      </div>
      {(ext.capabilities.length > 0 || perms.length > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-extension-capabilities="">
          {ext.capabilities.length > 0 && <span className="min-w-0 truncate" title={ext.capabilities.join(' · ')}>{ext.capabilities.join(' · ')}</span>}
          {perms.length > 0 && <StatusDot state="warning" title={perms.join(', ')}>{perms.join(', ')}</StatusDot>}
        </div>
      )}
      {ext.settings_schema.length > 0 && <ExtensionSettings ext={ext} />}
      {ext.sidecar && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-mono">{ext.sidecar.origin}</span>
          {canManage && <label className="flex items-center gap-1"><ResourceSwitch effect={consentEffect} checked={!!ext.sidecar.consented} onCheckedChange={(checked) => onConsent(checked)} /> {m.extensions_sidecar_consent()}</label>}
        </div>
      )}
      {(ext.legacy_injection || ext.warnings.length > 0) && (
        <div className="flex flex-col gap-1 text-xs text-warning">
          {ext.legacy_injection && <p role="status">{m.extensions_legacy_notice()} <a href={GUIDE} target="_blank" rel="noopener noreferrer" className="underline">{m.extensions_migration_guide()}</a></p>}
          {ext.warnings.length > 0 && <ul>{ext.warnings.map((w) => <li key={w}>{w === 'web_extension_migration_required' ? m.extensions_web_migration_required() : w}</li>)}</ul>}
        </div>
      )}
    </Row>} />
  )
}


/** A row's header line: the name, the version in muted text, then any state badge. */
function ExtensionName({ name, version, children }: { name: string; version?: string | undefined; children?: ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-text"><span>{name}</span>{version && <span className="text-xs font-normal text-muted">v{version}</span>}{children}</div>
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
    <div className="flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
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
