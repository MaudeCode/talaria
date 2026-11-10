import type { ConnectorOperationView } from '@maudecode/talaria-web-contracts'
import { ArrowRight, Link2 } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { IconButton } from '../../ui/Button'
import { ConnectTargets, useConnectorOperation } from './ConnectTargets'

/** TAL-818: a chat's `manage_connections` card: the apps the turn waits on, until the operation settles. */
export function ConnectCard({ initial }: { initial: ConnectorOperationView }) {
  const operation = useConnectorOperation(initial)
  const { view, lost, move, running } = operation
  if (view.settled || lost) return null
  return (
    <div className="connect-card" role="region" aria-labelledby="connectCardHeading" id="connectCard">
      <div className="connect-inner">
        <div className="flex items-center gap-2 text-sm font-semibold text-text">
          <Link2 size={14} className="text-info" aria-hidden="true" />
          <span id="connectCardHeading">{m.connect_card_heading()}</span>
          <span className="flex-1" />
          {view.can_continue && <IconButton variant="ghost" label={m.connect_card_continue()} onClick={() => move({ action: 'continue' })}><ArrowRight aria-hidden="true" /></IconButton>}

        </div>
        <ConnectTargets view={view} move={move} running={running} />
      </div>
    </div>
  )
}
