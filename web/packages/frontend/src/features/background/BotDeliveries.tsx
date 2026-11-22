/**
 * TAL-2684: the requests the profile's bot sent its teammates that they have not settled, shown in its canonical Bot
 * Chat. The server decides which chat that is and each row's state; this renders them and changes nothing. A failed
 * reread keeps the list the server last confirmed.
 */
import { useQuery } from '@tanstack/react-query'
import type { BotDelivery } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { TaskHeading } from './BackgroundWork'

/** A teammate's progress changes on the Agent's side; the Background Work card's own quiet refresh. */
const REFRESH_MS = 15_000
const NONE: readonly BotDelivery[] = []

export function useBotDeliveries(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: keys.botDeliveries(sessionId ?? ''),
    queryFn: () => api.fetchBotDeliveries(sessionId ?? ''),
    // The rows to show: none outside the Bot Chat, before v0.23.3 or with no request open.
    select: (data) => (data.state === 'available' ? data.deliveries : NONE),
    enabled: Boolean(sessionId),
    // Only the Bot Chat of an Agent that lists deliveries is worth asking again.
    refetchInterval: (query) => (query.state.data && query.state.data.state !== 'available' ? false : REFRESH_MS),
  })
}

const ICONS = { queued: 'waiting', running: 'running', waiting_on_user: 'attention' } as const

function stateLabel(delivery: BotDelivery): string {
  if (delivery.state === 'queued') return m.bot_delivery_queued()
  if (delivery.state === 'running') return m.bot_delivery_running()
  if (delivery.waiting_on === 'clarify') return m.bot_delivery_waiting_clarify()
  if (delivery.waiting_on === 'approval') return m.bot_delivery_waiting_approval()
  return m.bot_delivery_waiting()
}

export function BotDeliveriesCard({ deliveries }: { deliveries: readonly BotDelivery[] }) {
  return (
    <span className="bg-work-card flex min-w-0 flex-1 flex-col gap-1" role="region" aria-label={m.bot_deliveries_title()} aria-live="polite">
      <ul className="flex min-w-0 flex-col gap-1">{deliveries.map((d) => (
        <li key={d.delivery_id} className="bg-work-task flex min-w-0 flex-col gap-1" data-delivery-state={d.state}>
          <TaskHeading task={{ status: ICONS[d.state], title: d.preview }} titleBasis="basis-36" title={<><span className="text-muted">{d.target_handle}</span> {d.preview}</>}>
            <span className="text-[11px] text-muted">{stateLabel(d)}</span>
          </TaskHeading>
        </li>
      ))}</ul>
    </span>
  )
}
