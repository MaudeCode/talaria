import { useQuery } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'

export function PluginsSection() {
  const plugins = useQuery({ queryKey: keys.plugins, queryFn: api.fetchPlugins, staleTime: 30_000 })
  if (plugins.isPending) return <LoadingState />
  if (plugins.isError) return <ErrorState error={plugins.error} onRetry={() => { void plugins.refetch() }} />
  const list = plugins.data.plugins
  return (
    <div className="flex flex-col gap-2" data-section="plugins">
      {plugins.data.read_only && <div className="text-xs text-warning">{m.plugins_read_only()}</div>}
      {list.length === 0 && <EmptyState>{m.plugins_empty()}</EmptyState>}
      <ul className="flex flex-col divide-y divide-border-subtle">
        {list.map((p) => (
          <li key={p.key} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text">{p.name ?? p.key}{p.version ? <span className="ml-1 text-[11px] text-muted">v{p.version}</span> : null}</div>
              <div className="truncate text-[11px] text-muted">{p.kind ? `${p.kind} · ` : ''}{p.description ?? ''}</div>
            </div>
            {p.is_active_provider && <span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent-text">{m.providers_active()}</span>}
            <span className={p.enabled !== false ? 'text-[11px] text-success' : 'text-[11px] text-muted'}>{p.enabled !== false ? m.plugins_enabled() : m.plugins_disabled()}{p.activation ? ` · ${p.activation}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
