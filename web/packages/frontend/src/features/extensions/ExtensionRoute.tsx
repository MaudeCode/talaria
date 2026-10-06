import { useEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { AppShell, HubPage } from '../../shell/AppShell'
import { SessionListPanel } from '../sessions/SessionListPanel'
import { useExtensionManifests, registerTtsEngine, subscribeLifecycle } from '../../extensions/registry'
import { ExtensionHost, type HostStatus } from '../../extensions/host'
import type { ExtensionManifest } from '../../contracts/extension'
import { appUrl } from '../../lib/appRoot'
import { showToast } from '../toast/toast'
import { readAppearance } from '../../app/appearance'
import { readPersisted } from '../../lib/persisted'
import { SessionIdSchema } from '../../contracts/session'
import { ErrorState, LoadingState } from '../../ui/States'
import { request } from '../../api/client'
import { SidecarFetchResult } from '../../contracts/extension'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { keys } from '../../api/queryKeys'

/** Connects one sandboxed extension iframe to the host services once its document loads; closes it on unmount. */
function useExtensionHost(manifest: ExtensionManifest, iframe: RefObject<HTMLIFrameElement | null>): { status: HostStatus; detail: string | undefined } {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [status, setStatus] = useState<HostStatus>('loading')
  const [detail, setDetail] = useState<string | undefined>(undefined)
  useEffect(() => {
    const el = iframe.current
    if (!el || !manifest.panel) return
    const host = new ExtensionHost(manifest, el, {
      fetchSidecar: (id, p) => request(`api/extensions/${encodeURIComponent(id)}/sidecar/${sidecarProxyPath(p.path)}`, { method: p.method ?? 'GET', schema: SidecarFetchResult, retries: 0, ...(p.body !== undefined ? { body: p.body } : {}), ...(p.headers ? { headers: p.headers } : {}) }).catch((e: unknown) => {
        const err = e as { status?: number; body?: unknown; message?: string }
        return { status: err.status ?? 0, headers: {}, body: typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? { error: err.message ?? 'sidecar request failed' }) }
      }),
      currentSession: () => { const r = SessionIdSchema.safeParse(readPersisted('hermes-webui-session')); return { sessionId: r.success ? r.data : null, title: null } },
      currentTheme: () => { const a = readAppearance(); return { theme: a.theme, skin: a.skin, dark: document.documentElement.classList.contains('dark') } },
      toast: (text, ttl) => showToast(text, ttl),
      navigateSession: (sessionId) => { void navigate({ to: '/session/$sessionId', params: { sessionId } }) },
      registerTts: (extensionId, engine, synthesize) => registerTtsEngine({ ...engine, extensionId, synthesize }),
      subscribeLifecycle,
    })
    const unsub = host.onStatus((s, d) => { setStatus(s); setDetail(d) })
    const onLoad = () => host.start()
    el.addEventListener('load', onLoad)
    return () => { el.removeEventListener('load', onLoad); unsub(); host.close(); void qc.invalidateQueries({ queryKey: keys.extensions.manifests }) }
  }, [manifest, iframe, navigate, qc])
  return { status, detail }
}

function ExtensionFrame({ manifest, iframe, className }: { manifest: ExtensionManifest; iframe: RefObject<HTMLIFrameElement | null>; className: string }) {
  return (
    <iframe
      ref={iframe}
      title={manifest.name}
      src={appUrl(manifest.panel ?? '').href}
      sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"
      referrerPolicy="no-referrer"
      allow=""
      className={className}
    />
  )
}

/** Sandboxed iframe host for one extension panel. */
export function ExtensionPanel({ manifest }: { manifest: ExtensionManifest }) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const { status, detail } = useExtensionHost(manifest, iframe)
  if (!manifest.panel) return <ErrorState error={new Error(m.extensions_no_panel())} />
  return (
    <div className="extension-panel flex min-h-0 flex-1 flex-col" data-extension-id={manifest.id} data-status={status}>
      {status === 'loading' && <LoadingState label={m.extensions_connecting()} />}
      {status === 'error' && <div className="p-2"><ErrorState error={new Error(m.extensions_handshake_failed({ detail: detail ?? '' }))} /></div>}
      <ExtensionFrame manifest={manifest} iframe={iframe} className="min-h-0 w-full flex-1 border-0 bg-bg" />
    </div>
  )
}

/**
 * The panel's `sidecar.fetch` path may only name a location under this extension's proxy: every segment is encoded so
 * `..`, `?`, `#`, or an encoded slash cannot resolve to another `/api` route with the user's cookies and CSRF token.
 */
export function sidecarProxyPath(raw: string): string {
  const [pathPart, query] = raw.replace(/^\/+/, '').split('?', 2)
  const segments = (pathPart ?? '').split('/').filter((seg) => seg.length > 0)
  if (segments.some((seg) => seg === '.' || seg === '..' || /%2e|%2f|#/i.test(seg))) throw new Error('sidecar path must stay under the extension proxy')
  const encoded = segments.map((seg) => encodeURIComponent(decodeSegment(seg))).join('/')
  return query !== undefined && !query.includes('#') ? `${encoded}?${query}` : encoded
}

function decodeSegment(seg: string): string {
  try { return decodeURIComponent(seg) } catch { return seg }
}

/** An enabled extension that declares a TTS engine runs hidden for the whole session, so its engine is in Settings > Speech and reads replies with its panel closed. */
function BackgroundExtensionHost({ manifest }: { manifest: ExtensionManifest }) {
  const iframe = useRef<HTMLIFrameElement>(null)
  useExtensionHost(manifest, iframe)
  return <ExtensionFrame manifest={manifest} iframe={iframe} className="hidden" />
}

export function ExtensionTtsHosts() {
  const manifests = useExtensionManifests()
  // A changed manifest remounts its frame: the host only starts on the iframe's load.
  return manifests.data?.manifests.filter((mf) => mf.enabled && mf.panel && mf.tts).map((mf) => <BackgroundExtensionHost key={JSON.stringify(mf)} manifest={mf} />)
}

export function ExtensionRoute({ extensionId }: { extensionId: string }) {
  const manifests = useExtensionManifests()
  const manifest = manifests.data?.manifests.find((mf) => mf.id === extensionId)
  return (
    <AppShell sidebar={<SessionListPanel />} subtitle={manifest?.name ?? extensionId}>
      {manifests.isPending && <LoadingState />}
      {manifests.isError && <div className="p-4"><ErrorState error={manifests.error} onRetry={() => { void manifests.refetch() }} /></div>}
      {manifests.isSuccess && !manifest && (
        <HubPage title={extensionId}><ErrorState error={new Error(m.extensions_unknown())} /><Link to="/settings/$section" params={{ section: 'extensions' }} className="mt-2 inline-block text-sm text-accent-text underline">{m.settings_section_extensions_title()}</Link></HubPage>
      )}
      {manifest && !manifest.enabled && <HubPage title={manifest.name}><ErrorState error={new Error(m.extensions_disabled_panel())} /></HubPage>}
      {manifest && manifest.enabled && <ExtensionPanel key={manifest.id} manifest={manifest} />}
    </AppShell>
  )
}
