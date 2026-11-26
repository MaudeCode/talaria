import { use, useEffect, useRef, useState, type Ref } from 'react'
import { ExternalLink } from 'lucide-react'
import { appUrl } from '../../../lib/appRoot'
import { m } from '../../../paraglide/messages.js'
import { IconButton } from '../../../ui/Button'
import { RowContextMenu } from '../../../ui/Menu'
import { LinkCheckContext } from '../render/LinkCheckContext'
import { LinkSafetyDialog } from '../render/LinkSafetyDialog'

const REPORT_THEME = {
  '--background': '--bg', '--foreground': '--text', '--card': '--surface',
  '--muted': '--surface-subtle', '--muted-foreground': '--muted', '--border': '--border',
  '--primary': '--accent', '--primary-foreground': '--accent-fg',
  '--font-sans': '--font-conversation', '--font-mono': '--font-mono',
}

function readReportTheme(): string {
  const style = getComputedStyle(document.documentElement)
  return JSON.stringify(Object.fromEntries(Object.entries(REPORT_THEME).map(([target, token]) => [target, style.getPropertyValue(token).trim()])))
}

/** Each URL gets one navigation. The sandbox denies navigation of the parent and opening popups. */
function SandboxedFrame({ src, title, report, frame }: { src: string; title: string; report: boolean; frame: Ref<HTMLIFrameElement> }) {
  const loads = useRef(0)
  const [left, setLeft] = useState(false)
  if (left) return <p role="status" className="mt-2 text-muted">{m.show_frame_left()}</p>
  return <iframe ref={frame} src={src} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => { if (++loads.current > 1) setLeft(true) }} className={`mt-2 w-full rounded border border-border-subtle bg-white ${report ? 'h-[min(36rem,54dvh,calc(100dvh_-_13rem))]' : 'h-96'}`} />
}

export function ShowFrame({ url, title, report = false }: { url: string; title: string; report?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const checkLink = use(LinkCheckContext)
  const [theme, setTheme] = useState(() => report ? readReportTheme() : '')
  const [link, setLink] = useState<{ url: string; host: string | null } | null>(null)

  useEffect(() => {
    if (!report) return
    const root = document.documentElement
    const update = () => { setTheme(readReportTheme()) }
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-skin', 'style'] })
    return () => { observer.disconnect() }
  }, [report])

  useEffect(() => {
    if (!report) return
    const routeLink = (event: MessageEvent) => {
      const source = frame.current?.contentWindow
      if (!source || event.source !== source || event.origin !== 'null') return
      const payload = event.data as { type?: unknown; url?: unknown } | null
      if (payload?.type !== 'talaria-report-link' || typeof payload.url !== 'string' || payload.url.length > 4096) return
      let target: URL
      try { target = new URL(payload.url) } catch { return }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return
      // The report is untrusted. A frame message never supplies the user's consent to navigate.
      const url = target.href
      setLink({ url, host: null })
      void checkLink?.(url).then(({ host }) => {
        setLink((current) => current?.url === url ? { url, host } : current)
      }).catch(() => undefined)
    }
    window.addEventListener('message', routeLink)
    return () => { window.removeEventListener('message', routeLink) }
  }, [checkLink, report])

  const src = appUrl(url.replace(/^\.\//, ''))
  if (report) src.searchParams.set('theme', theme)
  const open = (destination: string) => { window.open(destination, '_blank', 'noopener,noreferrer') }
  const content = <SandboxedFrame key={src.href} src={src.href} title={title} report={report} frame={frame} />
  if (!report) return content
  const openReport = { label: m.show_open(), run: () => { open(src.href) } }
  return <>
    <RowContextMenu label={title} actions={[openReport]} trigger={<div>
      <div className="flex justify-end"><IconButton label={openReport.label} onClick={openReport.run}><ExternalLink aria-hidden="true" /></IconButton></div>
      {content}
    </div>} />
    {link && <LinkSafetyDialog isOpen url={link.url} host={link.host} onClose={() => { setLink(null) }} onConfirm={() => { open(link.url) }} />}
  </>
}
