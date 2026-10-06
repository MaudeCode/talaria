import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { cn } from '../../ui/cn'
import { HelpTip, Switch, TextInput } from '../../ui/Field'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
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

function Badge({ tone, title, children }: { tone: string; title?: string | undefined; children: string }) {
  return <span title={title} className={cn('rounded-full border px-1.5 text-[10px] uppercase tracking-wider', tone)}>{children}</span>
}

function StatusBadge({ status }: { status: string | undefined }) {
  const known = STATUS[status ?? '']
  return <Badge tone={known?.tone ?? 'border-border text-muted'}>{known ? known.label() : status ?? m.mcp_status_unknown()}</Badge>
}

/** MCP servers from config.yaml with server-computed status and health, the enable toggle, and server-side tool search. */
export function McpSection({ heading }: { heading: string }) {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const t = setTimeout(() => setQ(query), 250); return () => clearTimeout(t) }, [query])
  // A cold health cache answers `health_pending`; re-read until the server's probes settle.
  const servers = useQuery({ queryKey: keys.mcp.servers, queryFn: api.fetchMcpServers, staleTime: 30_000, refetchInterval: (s) => (s.state.data?.health_pending ? 2500 : false) })
  const tools = useQuery({ queryKey: [...keys.mcp.tools, q], queryFn: () => api.fetchMcpTools(q), staleTime: 30_000, placeholderData: keepPreviousData })
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.toggleMcpServer(name, enabled),
    onSuccess: (r) => showToast(r.enabled ? m.mcp_enabled_toast({ name: r.name }) : m.mcp_disabled_toast({ name: r.name })),
    onError: () => showToast(m.mcp_toggle_failed(), 5000, 'error'),
    onSettled: () => { void qc.invalidateQueries({ queryKey: keys.mcp.servers }); void qc.invalidateQueries({ queryKey: keys.mcp.tools }) },
  })
  const unavailable = tools.data?.unavailable_servers ?? []
  return (
    <>
      <section aria-labelledby="systemMcpHeading" className="flex flex-col gap-2" data-section="mcp-servers">
        <h2 id="systemMcpHeading" className={heading}>{m.mcp_servers_title()}<HelpTip label={m.field_help_about({ label: m.mcp_servers_title() })}>{m.mcp_servers_desc()}{servers.data?.reload_required ? ` ${m.mcp_reload_hint()}` : ''}</HelpTip></h2>
        {servers.isPending ? <LoadingState /> : servers.isError ? <ErrorState error={servers.error} onRetry={() => { void servers.refetch() }} /> : servers.data.servers.length === 0 ? <EmptyState>{m.mcp_no_servers()}</EmptyState> : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {servers.data.servers.map((s) => {
              const health = HEALTH[s.health ?? '']
              return (
                <li key={s.name} className="flex items-center gap-3 py-2" data-mcp-server={s.name}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium text-text">{s.name}</span>
                      {s.transport && <span className="text-[11px] text-muted">{s.transport}</span>}
                      <StatusBadge status={s.status} />
                      {health && <Badge tone={health.tone} title={s.health_detail}>{health.label()}</Badge>}
                    </div>
                    {typeof s.tool_count === 'number' && <div className="text-[11px] text-muted">{m.mcp_tool_count({ a0: String(s.tool_count) })}</div>}
                  </div>
                  {servers.data.toggle_supported && (
                    <Switch checked={s.enabled !== false} disabled={toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ name: s.name, enabled })} aria-label={`${s.name}: ${s.enabled !== false ? m.mcp_enabled_yes() : m.mcp_enabled_no()}`} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="systemMcpToolsHeading" className="flex flex-col gap-2" data-section="mcp-tools">
        <h2 id="systemMcpToolsHeading" className={heading}>{m.mcp_tools_title()}<HelpTip label={m.field_help_about({ label: m.mcp_tools_title() })}>{m.mcp_tools_desc()} {m.mcp_tools_runtime_note()}</HelpTip></h2>
        <TextInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.mcp_tools_search()} aria-label={m.mcp_tools_search()} title={m.mcp_tools_search_placeholder()} autoComplete="off" />
        {tools.isPending ? <LoadingState /> : tools.isError ? <ErrorState error={tools.error} onRetry={() => { void tools.refetch() }} /> : tools.data.tools.length === 0 ? (
          <EmptyState>{q ? m.mcp_tools_no_matches() : m.mcp_tools_no_tools()}{!q && unavailable.length > 0 && <span className="mt-1 block text-xs">{m.mcp_tools_inactive_configured_servers({ servers: unavailable.join(', ') })}</span>}</EmptyState>
        ) : (
          <ul aria-label={m.mcp_tools_title()} className={cn('flex max-h-96 flex-col divide-y divide-border-subtle overflow-y-auto', tools.isPlaceholderData && 'opacity-60')}>
            {tools.data.tools.map((t) => (
              <li key={`${t.server ?? ''}\0${t.name ?? ''}`} className="py-2">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-mono text-[13px] text-text">{t.name}</span>
                  <span className="text-[11px] text-muted">{t.server}</span>
                  <StatusBadge status={typeof t.status === 'string' ? t.status : undefined} />
                </div>
                {t.description && <div className="line-clamp-2 text-[11px] text-muted">{t.description}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
