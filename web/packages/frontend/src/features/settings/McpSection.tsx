import { memo, useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounced } from '../../lib/useDebounced'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { cn } from '../../ui/cn'
import { Badge } from '../../ui/Badge'
import { HelpTip, TextInput } from '../../ui/Field'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { useResourceEffects, useResourceMutation, type ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
import { showToast } from '../toast/toast'

const STATUS: Record<string, { label: () => string; tone: string }> = {
  active: { label: m.mcp_status_active, tone: 'border-success/50 text-success' },
  configured: { label: m.mcp_status_configured, tone: 'border-border text-muted' },
  disabled: { label: m.mcp_status_disabled, tone: 'border-border text-muted' },
  invalid_config: { label: m.mcp_status_invalid_config, tone: 'border-error/50 text-error' },
}
const HEALTH: Record<string, { label: () => string; tone: string }> = {
  unhealthy: { label: m.mcp_health_unhealthy, tone: 'border-error/50 text-error' },
  needs_auth: { label: m.mcp_health_needs_auth, tone: 'border-warning/50 text-warning' },
}

function StatusBadge({ status }: { status: string | undefined }) {
  const known = STATUS[status ?? '']
  return <Badge tone={known?.tone ?? 'border-border text-muted'}>{known ? known.label() : status ?? m.mcp_status_unknown()}</Badge>
}

/** MCP servers from config.yaml with server-computed status and health, the enable toggle, and server-side tool search. */
export function McpSection({ heading }: { heading: string }) {
  const effects = useResourceEffects<boolean>()
  const [q, setQuery] = useState('')
  // A cold health cache answers `health_pending`; re-read until the server's probes settle.
  const servers = useQuery({ queryKey: keys.mcp.servers, queryFn: api.fetchMcpServers, staleTime: 30_000, refetchInterval: (s) => (s.state.data?.health_pending ? 2500 : false) })
  const tools = useQuery({ queryKey: [...keys.mcp.tools, q], queryFn: () => api.fetchMcpTools(q), staleTime: 30_000, placeholderData: keepPreviousData })
  const toggle = useResourceMutation({
    resource: ({ name }: { name: string; enabled: boolean }) => `mcp:${name}`,
    effect: ({ enabled }) => ({ value: enabled }),
    queryKey: keys.mcp.all,
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.toggleMcpServer(name, enabled),
    onSuccess: (r) => showToast(r.enabled ? m.mcp_enabled_toast({ name: r.name }) : m.mcp_disabled_toast({ name: r.name })),
    onError: () => showToast(m.mcp_toggle_failed(), 5000, 'error'),
  })
  const unavailable = tools.data?.unavailable_servers ?? []
  return (
    <>
      <section aria-labelledby="systemMcpHeading" className="flex flex-col gap-2" data-section="mcp-servers">
        <h2 id="systemMcpHeading" className={heading}>{m.mcp_servers_title()}<HelpTip label={m.field_help_about({ label: m.mcp_servers_title() })}>{m.mcp_servers_desc()}{servers.data?.reload_required ? ` ${m.mcp_reload_hint()}` : ''}</HelpTip></h2>
        {servers.isPending ? <LoadingState /> : servers.isError && !servers.data ? <ErrorState error={servers.error} onRetry={() => { void servers.refetch() }} /> : servers.data.servers.length === 0 ? <EmptyState>{m.mcp_no_servers()}</EmptyState> : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {servers.data.servers.map((s) => <McpServerRow key={s.name} server={s} effect={effects[`mcp:${s.name}`]} toggleSupported={servers.data.toggle_supported === true} onToggle={toggle.mutate} />)}
          </ul>
        )}
      </section>
      <section aria-labelledby="systemMcpToolsHeading" className="flex flex-col gap-2" data-section="mcp-tools">
        <h2 id="systemMcpToolsHeading" className={heading}>{m.mcp_tools_title()}<HelpTip label={m.field_help_about({ label: m.mcp_tools_title() })}>{m.mcp_tools_desc()} {m.mcp_tools_runtime_note()}</HelpTip></h2>
        <McpToolSearch onSearch={setQuery} />
        {tools.isPending ? <LoadingState /> : tools.isError ? <ErrorState error={tools.error} onRetry={() => { void tools.refetch() }} /> : tools.data.tools.length === 0 ? (
          <EmptyState>{q ? m.mcp_tools_no_matches() : m.mcp_tools_no_tools()}{!q && unavailable.length > 0 && <span className="mt-1 block text-xs">{m.mcp_tools_inactive_configured_servers({ servers: unavailable.join(', ') })}</span>}</EmptyState>
        ) : (
          <ul aria-label={m.mcp_tools_title()} className={cn('flex max-h-96 flex-col divide-y divide-border-subtle overflow-y-auto', tools.isPlaceholderData && 'opacity-60')}>
            {tools.data.tools.map((t) => <McpToolRow key={`${t.server ?? ''}\0${t.name ?? ''}`} tool={t} />)}
          </ul>
        )}
      </section>
    </>
  )
}

function McpToolSearch({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 250)
  useEffect(() => { onSearch(debounced) }, [debounced, onSearch])
  return <TextInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.mcp_tools_search()} aria-label={m.mcp_tools_search()} title={m.mcp_tools_search_placeholder()} autoComplete="off" />
}

const McpServerRow = memo(function McpServerRow({ server: s, effect, toggleSupported, onToggle }: {
  server: Awaited<ReturnType<typeof api.fetchMcpServers>>['servers'][number]
  effect: ResourceEffect<boolean> | undefined
  toggleSupported: boolean
  onToggle: (value: { name: string; enabled: boolean }) => void
}) {
  const health = HEALTH[s.health ?? '']
  return (
    <li className="flex items-center gap-3 py-2" data-mcp-server={s.name}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="font-medium text-text">{s.name}</span>
          {s.transport && <span className="text-[11px] text-muted">{s.transport}</span>}
          <StatusBadge status={s.status} />
          {health && <Badge tone={health.tone} title={s.health_detail}>{health.label()}</Badge>}
        </div>
        {typeof s.tool_count === 'number' && <div className="text-[11px] text-muted">{m.mcp_tool_count({ a0: String(s.tool_count) })}</div>}
      </div>
      {toggleSupported && s.can_toggle === true && (
        <ResourceSwitch effect={effect} checked={s.enabled !== false} onCheckedChange={(enabled) => onToggle({ name: s.name, enabled })} aria-label={s.name} />
      )}
    </li>
  )
})

const McpToolRow = memo(function McpToolRow({ tool: t }: { tool: Awaited<ReturnType<typeof api.fetchMcpTools>>['tools'][number] }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-mono text-[13px] text-text">{t.name}</span>
        <span className="text-[11px] text-muted">{t.server}</span>
        <StatusBadge status={typeof t.status === 'string' ? t.status : undefined} />
      </div>
      {t.description && <div className="line-clamp-2 text-[11px] text-muted">{t.description}</div>}
    </li>
  )
})
