/**
 * TAL-2380: the profile's Bot Screen in a dialog: noVNC over the server's RFB socket, watch-only until Take over.
 * Closing the dialog closes the socket, and the server hands control back to the agent.
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, Hand, MousePointerClick, RefreshCw } from 'lucide-react'
import { SCREEN_STREAM_PATH, type ScreenView } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { leaseScreen } from '../../api/endpoints'
import { resolveApiUrl } from '../../api/client'
import { Dialog } from '../../ui/Dialog'
import { IconButton } from '../../ui/Button'
import { copyWithToast } from '../../lib/clipboard'
import { showErrorToast } from '../toast/errorToast'
import { randomUuid } from '../../lib/randomHex'
import type RFB from '@novnc/novnc'

type Connection = 'connecting' | 'connected' | 'disconnected'
type Control = ScreenView['control']

const newViewId = (): string => randomUuid().replaceAll('-', '')
/** noVNC loads with the first viewer; module scope, because React Compiler cannot lower `import()` inside a component. */
const loadNoVnc = () => import('@novnc/novnc')

export function ScreenViewer({ open, onOpenChange, screen }: { open: boolean; onOpenChange: (open: boolean) => void; screen: ScreenView }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={m.screen_title()} maxWidth={1100}>
      {open && <ScreenBody screen={screen} />}
    </Dialog>
  )
}

function ScreenBody({ screen }: { screen: ScreenView }) {
  if (screen.state === 'not_installed') {
    const command = screen.install_command
    return (
      <div className="screen-install flex flex-col gap-2 text-sm">
        <p className="m-0 text-text">{command ? m.screen_not_installed() : m.screen_no_package_manager()}</p>
        {command && (
          <div className="flex items-start gap-1">
            <code className="screen-install-command min-w-0 flex-1 whitespace-pre-wrap break-all py-2 font-mono text-xs text-text">{command}</code>
            <IconButton variant="default" label={m.copy()} onClick={() => { copyWithToast(command) }}><Copy aria-hidden="true" /></IconButton>
          </div>
        )}
      </div>
    )
  }
  if (screen.state !== 'running') return <p className="screen-stopped m-0 text-sm text-muted">{screen.available ? m.screen_stopped() : m.screen_unavailable()}</p>
  return <LiveScreen initialControl={screen.control} />
}

/** One viewer connection; Reconnect starts a fresh one under a new view id. */
function LiveScreen({ initialControl }: { initialControl: Control }) {
  const host = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const [viewId, setViewId] = useState(newViewId)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [control, setControl] = useState<Control>(initialControl)

  useEffect(() => {
    const target = host.current
    if (!target) return
    let cancelled = false
    let client: RFB | null = null
    void loadNoVnc().then(({ default: Client }) => {
      if (cancelled) return
      const url = resolveApiUrl(SCREEN_STREAM_PATH)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('view_id', viewId)
      client = new Client(target, url.href, { shared: true })
      client.viewOnly = true
      client.scaleViewport = true
      client.background = 'transparent'
      client.addEventListener('connect', () => { setConnection('connected') })
      // Another viewer took control, the screen stopped or the link dropped; the server handed back what this one held.
      client.addEventListener('disconnect', () => {
        setConnection('disconnected')
        setControl((held) => (held === 'you' ? 'agent' : held))
      })
      rfb.current = client
    }, (error: unknown) => { if (!cancelled) { setConnection('disconnected'); showErrorToast(error) } })
    return () => {
      cancelled = true
      rfb.current = null
      client?.disconnect()
    }
  }, [viewId])

  // noVNC's own input gate is only presentation; the server and the Agent refuse input from a viewer without control.
  useEffect(() => { if (rfb.current) rfb.current.viewOnly = control !== 'you' }, [control, connection])

  const lease = async (action: 'acquire' | 'release') => {
    const before = control
    setControl(action === 'acquire' ? 'you' : 'agent')
    try {
      setControl((await leaseScreen({ view_id: viewId, action })).control)
    } catch (error) {
      setControl(before)
      showErrorToast(error)
    }
  }

  const reconnect = () => {
    setConnection('connecting')
    setViewId(newViewId())
  }

  const status = connection === 'disconnected' ? m.screen_disconnected() : control === 'other' ? m.screen_other_control() : null
  return (
    <div className="screen-live flex flex-col gap-2">
      <div className="screen-toolbar flex min-h-[34px] items-center gap-1">
        <span className="screen-status min-w-0 flex-1 truncate text-xs text-muted" role="status" aria-live="polite">{status}</span>
        {connection === 'disconnected'
          ? <IconButton variant="default" label={m.screen_reconnect()} onClick={reconnect}><RefreshCw aria-hidden="true" /></IconButton>
          : control === 'you'
            ? <IconButton variant="default" label={m.screen_hand_back()} onClick={() => { void lease('release') }}><Hand aria-hidden="true" /></IconButton>
            : <IconButton variant="default" label={m.screen_take_over()} disabled={connection !== 'connected'} onClick={() => { void lease('acquire') }}><MousePointerClick aria-hidden="true" /></IconButton>}
      </div>
      <div ref={host} className="screen-canvas relative aspect-[16/10] max-h-[calc(90dvh-9rem)] w-full overflow-hidden rounded-lg border border-border bg-black" data-control={control} data-connection={connection} />
    </div>
  )
}
