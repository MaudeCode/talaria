import type { ConnectorOperationView } from '@maudecode/talaria-web-contracts'
import { Link2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { ConnectTargets, useConnectorOperation } from './ConnectTargets'

/** TAL-818: a chat's `manage_connections` card: the apps the turn waits on, until the operation settles. */
export function ConnectCard({ initial }: { initial: ConnectorOperationView }) {
  const operation = useConnectorOperation(initial)
  const { view, lost, move } = operation
  if (view.settled || lost) return null
  return (
    <div className="connect-card" role="region" aria-labelledby="connectCardHeading" id="connectCard">
      <div className="connect-inner">
        <div className="flex items-center gap-2 text-sm font-semibold text-text">
          <Link2 size={14} className="text-info" aria-hidden="true" />
          <span id="connectCardHeading">{m.connect_card_heading()}</span>
          <span className="flex-1" />
          {view.can_continue && <Button variant="ghost" disabled={move.isPending} onClick={() => move.mutate({ action: 'continue' })}>{m.connect_card_continue()}</Button>}
        </div>
        <ConnectTargets view={view} move={move} />
      </div>
    </div>
  )
}
