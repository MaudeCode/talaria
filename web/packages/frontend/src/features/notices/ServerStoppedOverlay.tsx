import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { m } from '../../paraglide/messages.js'
import { getStreamState, subscribe } from '../../stream/store'
import { Button } from '../../ui/Button'
import { markServerStopped, recheckServer, RetryCountdown, retryDelay, STOPPED_AFTER, useServerProbe } from './useRuntimeNotices'

/** Tabs of this origin tell each other when the server stops answering and when it answers again. */
const CHANNEL = 'talaria-server-state'
type Signal = 'stopped' | 'recovered'

const streamReconnecting = () => Object.values(getStreamState().turns).some((turn) => turn.status === 'reconnecting')

/**
 * Full-screen "Server stopped" once the server probe goes unanswered `STOPPED_AFTER` times in a row, or Stop server
 * ran in this or another tab (legacy boot.js). A BroadcastChannel covers and clears every open tab at once instead of
 * at each tab's next probe. `suppressed` while a Web update restarts the server: the Updating dialog owns that wait.
 */
export function ServerStoppedOverlay({ suppressed }: { suppressed: boolean }) {
  const qc = useQueryClient()
  const { online, probe, failures, retry } = useServerProbe()
  const stopped = failures >= STOPPED_AFTER
  const channel = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(CHANNEL)
    ch.onmessage = (event: MessageEvent<Signal>) => {
      if (event.data === 'stopped') markServerStopped(qc)
      else if (event.data === 'recovered') recheckServer(qc)
    }
    channel.current = ch
    return () => { ch.close(); channel.current = null }
  }, [qc])
  const announced = useRef(stopped)
  useEffect(() => {
    if (stopped === announced.current) return
    announced.current = stopped
    channel.current?.postMessage((stopped ? 'stopped' : 'recovered') satisfies Signal)
  }, [stopped])
  // A live turn's stream that dropped asks the probe now rather than at its next scheduled check.
  const reconnecting = useSyncExternalStore(subscribe, streamReconnecting, streamReconnecting)
  const { refetch } = probe
  useEffect(() => { if (reconnecting && online) void refetch() }, [reconnecting, online, refetch])

  if (!stopped || suppressed) return null
  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Popup className="fixed inset-0 z-[1500] flex flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-text outline-none">
          <AlertDialog.Title className="text-lg font-semibold text-strong">{m.server_stopped_title()}</AlertDialog.Title>
          <AlertDialog.Description className="max-w-sm text-sm text-muted">{m.server_stopped_detail()}</AlertDialog.Description>
          <Button variant="primary" className="mt-2" onClick={retry}>{m.retry()}</Button>
          <span className="text-xs text-muted"><RetryCountdown at={(probe.data?.failedAt ?? 0) + retryDelay(failures)} busy={probe.isFetching} /></span>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
