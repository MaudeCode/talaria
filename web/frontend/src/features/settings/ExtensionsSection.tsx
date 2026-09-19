import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useExtensionManifests } from '../../extensions/registry'
import type { ExtensionManifest } from '../../contracts/extension'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Field'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { useBootstrap } from '../../app/bootstrap'
import { cn } from '../../ui/cn'

const GUIDE = 'https://github.com/nesquena/hermes-webui/blob/master/docs/architecture/extension-migration-guide.md'

/** Installed extensions from the unified manifest list, sidecar consent, gallery install, and the legacy-injection migration notice. */
export function ExtensionsSection() {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const manifests = useExtensionManifests()
  const registry = useQuery({ queryKey: keys.extensions.registry, queryFn: api.fetchExtensionRegistry, staleTime: 5 * 60_000, retry: false })
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const invalidate = () => { void qc.invalidateQueries({ queryKey: keys.extensions.manifests }); void qc.invalidateQueries({ queryKey: keys.extensions.status }) }
  const act = useMutation({
    mutationFn: ({ action, body }: { action: Parameters<typeof api.extensionAction>[0]; body: Record<string, unknown> }) => api.extensionAction(action, body),
    onSuccess: (r) => { if (r.error) showToast(r.error, 5000, 'error'); else showToast(m.saved()); invalidate() },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 5000, 'error'),
  })
  if (manifests.isPending) return <LoadingState />
  if (manifests.isError) return <ErrorState error={manifests.error} onRetry={() => { void manifests.refetch() }} />
  const list = manifests.data.manifests
  const gallery = (registry.data?.entries ?? registry.data?.extensions ?? []) as { id?: string; name?: string; description?: string; version?: string; download_url?: string; sha256?: string }[]
  const installed = new Set(list.map((e) => e.id))
  const canManage = bootstrap.auth.can_manage_server !== false
  return (
    <div className="flex flex-col gap-5" data-section="extensions">
      {!bootstrap.features.extensions && <p className="text-xs text-muted">{m.extensions_disabled_hint()}</p>}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-text">{m.extensions_installed()}</h2>
        {list.length === 0 && <EmptyState>{m.extensions_none()}</EmptyState>}
        <ul className="flex flex-col gap-2">
          {list.map((e) => <ExtensionRow key={e.id} ext={e} canManage={canManage} onToggle={(enabled) => act.mutate({ action: 'toggle', body: { id: e.id, enabled } })} onConsent={(consent) => act.mutate({ action: 'sidecar-proxy-consent', body: { id: e.id, consent } })} onUninstall={() => setConfirmUninstall(e.id)} />)}
        </ul>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-text">{m.extensions_gallery()}</h2>
        {registry.isPending && <LoadingState />}
        {registry.isError && <p className="text-xs text-muted">{m.extensions_unavailable()}</p>}
        {registry.data?.unavailable && <p className="text-xs text-muted">{m.extensions_unavailable()}</p>}
        <ul className="flex flex-col divide-y divide-border-subtle">
          {gallery.filter((g) => g.id).map((g) => (
            <li key={g.id} className="flex items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><div className="font-medium text-text">{g.name ?? g.id}{g.version ? <span className="ml-1 text-[11px] text-muted">v{g.version}</span> : null}</div><div className="truncate text-[11px] text-muted">{g.description ?? ''}</div></div>
              {installed.has(g.id ?? '') ? <span className="text-[11px] text-muted">{m.extensions_installed()}</span> : canManage && <Button onClick={() => act.mutate({ action: 'install', body: { id: g.id, download_url: g.download_url, sha256: g.sha256 } })} disabled={act.isPending}>{m.extensions_install()}</Button>}
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog open={confirmUninstall !== null} onOpenChange={(o) => { if (!o) setConfirmUninstall(null) }} title={m.extensions_uninstall()} description={confirmUninstall ?? ''} confirmLabel={m.extensions_uninstall()} cancelLabel={m.cancel()} danger onConfirm={() => { if (confirmUninstall) act.mutate({ action: 'uninstall', body: { id: confirmUninstall } }) }} />
    </div>
  )
}

function ExtensionRow({ ext, canManage, onToggle, onConsent, onUninstall }: { ext: ExtensionManifest; canManage: boolean; onToggle: (enabled: boolean) => void; onConsent: (consent: boolean) => void; onUninstall: () => void }) {
  const perms = Object.entries(ext.permissions ?? {}).filter(([, v]) => v).map(([k]) => k)
  return (
    <li className={cn('rounded-lg border border-border bg-surface p-3 text-sm', !ext.enabled && 'opacity-80')} data-extension-id={ext.id} data-source={ext.source}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text">{ext.name}{ext.version ? <span className="ml-1 text-[11px] text-muted">v{ext.version}</span> : null} <span className="ml-1 rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wider text-muted">{ext.source}</span></div>
          <div className="text-[11px] text-muted">{ext.id}{ext.description ? ` · ${ext.description}` : ''}</div>
        </div>
        {ext.panel && ext.enabled && <Link to="/ext/$extensionId" params={{ extensionId: ext.id }} className="text-xs text-accent-text underline">{m.extensions_open()}</Link>}
        {canManage && ext.source !== 'plugin' && !ext.legacy_injection && (
          <label className="flex items-center gap-1 text-xs text-muted"><Switch checked={ext.enabled} onCheckedChange={(checked) => onToggle(checked)} aria-label={`${ext.name}: ${ext.enabled ? m.plugins_enabled() : m.plugins_disabled()}`} /> {ext.enabled ? m.plugins_enabled() : m.plugins_disabled()}</label>
        )}
        {canManage && ext.source === 'gallery' && <Button variant="ghost" className="text-error" onClick={onUninstall}>{m.extensions_uninstall()}</Button>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[10px] uppercase tracking-wider text-muted">
        {ext.capabilities.map((c) => <span key={c} className="rounded-full border border-border px-1.5">{c}</span>)}
        {perms.map((p) => <span key={p} className="rounded-full border border-warning px-1.5 text-warning">{p}</span>)}
      </div>
      {ext.sidecar && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-mono">{ext.sidecar.origin}</span>
          {canManage && <label className="flex items-center gap-1"><Switch checked={!!ext.sidecar.consented} onCheckedChange={(checked) => onConsent(checked)} /> {m.extensions_sidecar_consent()}</label>}
        </div>
      )}
      {ext.legacy_injection && (
        <div className="mt-2 rounded-md border border-warning px-2 py-1.5 text-xs text-warning" role="status">
          {m.extensions_legacy_notice()} <a href={GUIDE} target="_blank" rel="noopener noreferrer" className="underline">{m.extensions_migration_guide()}</a>
        </div>
      )}
      {ext.warnings.length > 0 && <ul className="mt-1 text-[11px] text-warning">{ext.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
    </li>
  )
}
