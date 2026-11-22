import type { FallbackCheckEntry, FallbackStatus } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { useFallbackCheckQuery } from '../../app/queries'
import { StatusDot, type DotState } from '../../ui/Badge'
import { Row, RowList } from '../../ui/List'
import { Monogram } from '../../ui/Monogram'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { SettingsGroup } from './SettingsGroup'

const FALLBACK_DOT: Record<FallbackStatus, DotState> = { ready: 'ok', auth: 'error', config: 'error' }
const fallbackWord = (status: FallbackStatus): string => status === 'ready' ? m.settings_fallback_ready() : status === 'auth' ? m.settings_fallback_auth() : m.settings_fallback_config()

/** One fallback entry as the Providers rows show a provider: its monogram, the model, the server's status and the Agent's reason. */
function FallbackRow({ entry }: { entry: FallbackCheckEntry }) {
  return (
    <Row compact className="flex-nowrap items-center gap-3 text-sm" data-fallback-status={entry.status}>
      <Monogram name={entry.provider_label} sm />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-text" title={entry.model}>{entry.model}</span>
        <div className="flex min-w-0"><StatusDot state={FALLBACK_DOT[entry.status]}>{`${entry.provider_label} · ${fallbackWord(entry.status)}`}</StatusDot></div>
        {entry.error && <p className="text-xs text-muted [overflow-wrap:anywhere]">{entry.error}</p>}
      </div>
    </Row>
  )
}

/** TAL-2655: the profile's fallback models in chain order, each with the server's static readiness verdict. */
export function FallbackModelsGroup() {
  const check = useFallbackCheckQuery()
  return (
    <SettingsGroup id="fallback-models" title={m.settings_group_fallback_models()}>
      {check.isPending ? <LoadingState compact />
        : check.isError ? <ErrorState error={check.error} onRetry={() => { void check.refetch() }} />
        : !check.data.available ? <EmptyState compact>{m.settings_fallback_unavailable()}</EmptyState>
        : !check.data.entries.length ? <EmptyState compact>{m.settings_fallback_none()}</EmptyState>
        : <RowList>{check.data.entries.map((entry) => <FallbackRow key={entry.position} entry={entry} />)}</RowList>}
    </SettingsGroup>
  )
}
