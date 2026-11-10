import { memo, useEffect, useId, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDebounced } from '../../lib/useDebounced'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { cn } from '../../ui/cn'
import { Row, RowList } from '../../ui/List'
import { Check, X } from 'lucide-react'
import { IconButton } from '../../ui/Button'
import { Select } from '../../ui/Select'
import type { z } from 'zod'
import type { McpCostPatchSchema, McpCostPolicySchema, McpEventsSchema } from '@maudecode/talaria-web-contracts'
import { StatusDot, type DotState } from '../../ui/Badge'
import { HelpTip, TextInput } from '../../ui/Field'
import { SettingRow, SettingsGroup } from './SettingsRows'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { useResourceEffects, useResourceMutation, type ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
import { showToast } from '../toast/toast'

const STATUS: Record<string, { label: () => string; state: DotState }> = {
  active: { label: m.mcp_status_active, state: 'ok' },
  configured: { label: m.mcp_status_configured, state: 'idle' },
  disabled: { label: m.mcp_status_disabled, state: 'idle' },
  failed: { label: m.mcp_status_failed, state: 'error' },
  invalid_config: { label: m.mcp_status_invalid_config, state: 'error' },
}
const HEALTH: Record<string, { label: () => string; state: DotState }> = {
  unhealthy: { label: m.mcp_health_unhealthy, state: 'error' },
  needs_auth: { label: m.mcp_health_needs_auth, state: 'warning' },
}

type McpEvents = z.infer<typeof McpEventsSchema>
const EVENT_STATE: Record<McpEvents['state'], { label: () => string; state: DotState }> = {
  unsupported: { label: m.mcp_events_state_unsupported, state: 'idle' },
  off: { label: m.mcp_events_state_off, state: 'idle' },
  needs_public_url: { label: m.mcp_events_state_needs_public_url, state: 'warning' },
  invalid_public_url: { label: m.mcp_events_state_invalid_public_url, state: 'warning' },
  unavailable: { label: m.mcp_events_state_unavailable, state: 'warning' },
  ready: { label: m.mcp_events_state_ready, state: 'idle' },
  subscribed: { label: m.mcp_events_state_subscribed, state: 'ok' },
  refresh_overdue: { label: m.mcp_events_state_refresh_overdue, state: 'warning' },
  lapsed: { label: m.mcp_events_state_lapsed, state: 'error' },
  error: { label: m.mcp_events_state_error, state: 'error' },
}
const EVENT_COUNTS: Record<McpEvents['counts'][number]['state'], (v: { n: string }) => string> = {
  active: m.mcp_events_count_active, refresh_overdue: m.mcp_events_count_refresh_overdue, lapsed: m.mcp_events_count_lapsed, pending: m.mcp_events_count_pending, paused: m.mcp_events_count_paused,
}

function StatusBadge({ status }: { status: string | undefined }) {
  const known = STATUS[status ?? '']
  return <StatusDot state={known?.state ?? 'idle'}>{known ? known.label() : status ?? m.mcp_status_unknown()}</StatusDot>
}

/** MCP servers from config.yaml with server-computed status and health, the enable toggle, and server-side tool search. */
export function McpSection() {
  const effects = useResourceEffects<boolean>()
  const [q, setQuery] = useState('')
  // A cold health cache answers `health_pending`; re-read until the server's probes settle.
  const servers = useQuery({ queryKey: keys.mcp.servers, queryFn: api.fetchMcpServers, staleTime: 30_000, refetchInterval: (s) => (s.state.data?.health_pending ? 2500 : false) })
  const tools = useQuery({ queryKey: [...keys.mcp.tools, q], queryFn: () => api.fetchMcpTools(q), staleTime: 30_000, placeholderData: keepPreviousData })
  const saveEvents = useResourceMutation({
    resource: ({ name }: { name: string; events: boolean }) => `mcp-events:${name}`,
    effect: ({ events }) => ({ value: events }),
    queryKey: keys.mcp.all,
    mutationFn: ({ name, events }: { name: string; events: boolean }) => api.saveMcpEvents(name, events),
    onError: () => showToast(m.mcp_events_save_failed(), 5000, 'error'),
  })
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
      <SettingsGroup id="mcp-servers" section="mcp-servers" title={m.mcp_servers_title()} hint={<>{m.mcp_servers_desc()}{servers.data?.reload_required ? ` ${m.mcp_reload_hint()}` : ''}</>}>
        {servers.isPending ? <LoadingState /> : servers.isError && !servers.data ? <ErrorState error={servers.error} onRetry={() => { void servers.refetch() }} /> : servers.data.servers.length === 0 ? <EmptyState compact>{m.mcp_no_servers()}</EmptyState> : (
          <RowList aria-label={m.mcp_servers_title()}>
            {servers.data.servers.map((s) => <McpServerRow key={s.name} server={s} effect={effects[`mcp:${s.name}`]} eventsEffect={effects[`mcp-events:${s.name}`]} toggleSupported={servers.data.toggle_supported === true} onToggle={toggle.mutate} onEvents={saveEvents.mutate} />)}
          </RowList>
        )}
      </SettingsGroup>
      <SettingsGroup id="mcp-tools" section="mcp-tools" title={m.mcp_tools_title()} hint={`${m.mcp_tools_desc()} ${m.mcp_tools_runtime_note()}`}>
        <McpToolSearch onSearch={setQuery} />
        {tools.isPending ? <LoadingState /> : tools.isError ? <ErrorState error={tools.error} onRetry={() => { void tools.refetch() }} /> : tools.data.tools.length === 0 ? (
          <EmptyState compact>{q ? m.mcp_tools_no_matches() : m.mcp_tools_no_tools()}{!q && unavailable.length > 0 && <span className="mt-1 block text-xs">{m.mcp_tools_inactive_configured_servers({ servers: unavailable.join(', ') })}</span>}</EmptyState>
        ) : (
          <RowList aria-label={m.mcp_tools_title()} className={cn(tools.isPlaceholderData && 'opacity-60')}>
            {tools.data.tools.map((t) => <McpToolRow key={`${t.server ?? ''}\0${t.name ?? ''}`} name={t.name} server={t.server} description={t.description} status={typeof t.status === 'string' ? t.status : undefined} />)}
          </RowList>
        )}
      </SettingsGroup>
    </>
  )
}

function McpToolSearch({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 250)
  useEffect(() => { onSearch(debounced) }, [debounced, onSearch])
  return <TextInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.mcp_tools_search()} aria-label={m.mcp_tools_search()} title={m.mcp_tools_search_placeholder()} autoComplete="off" />
}

const McpServerRow = memo(function McpServerRow({ server: s, effect, eventsEffect, toggleSupported, onToggle, onEvents }: {
  server: Awaited<ReturnType<typeof api.fetchMcpServers>>['servers'][number]
  effect: ResourceEffect<boolean> | undefined
  eventsEffect: ResourceEffect<boolean> | undefined
  toggleSupported: boolean
  onToggle: (value: { name: string; enabled: boolean }) => void
  onEvents: (value: { name: string; events: boolean }) => void
}) {
  const health = HEALTH[s.health ?? '']
  const events = s.events
  const eventState = events?.show_state ? EVENT_STATE[events.state] : undefined
  return (
    <Row data-mcp-server={s.name}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium text-text">{s.name}</span>
            {s.transport && <span className="text-xs text-muted">{s.transport}</span>}
            <StatusBadge status={s.status} />
            {health && <StatusDot state={health.state} title={s.health_detail}>{health.label()}</StatusDot>}
            {eventState && <StatusDot state={eventState.state} title={events?.detail || undefined}>{eventState.label()}</StatusDot>}
          </div>
          {typeof s.tool_count === 'number' && <div className="text-xs tabular-nums text-muted">{m.mcp_tool_count({ a0: String(s.tool_count) })}</div>}
        </div>
        {toggleSupported && s.can_toggle === true && (
          <ResourceSwitch effect={effect} checked={s.enabled !== false} onCheckedChange={(enabled) => onToggle({ name: s.name, enabled })} aria-label={s.name} />
        )}
      </div>
      {events?.show_panel && <McpEventsPanel name={s.name} events={events} effect={eventsEffect} onChange={onEvents} />}
      {s.cost_policy && <details className="text-sm"><summary className="cursor-pointer text-muted">{m.mcp_cost_title()}</summary><McpCostEditor key={s.cost_policy.revision} policy={s.cost_policy} /></details>}
    </Row>
  )
})

/** TAL-1510: the experimental events opt-in and the server's native subscription status for one row. */
function McpEventsPanel({ name, events, effect, onChange }: { name: string; events: McpEvents; effect: ResourceEffect<boolean> | undefined; onChange: (value: { name: string; events: boolean }) => void }) {
  return <details className="text-sm" data-mcp-events={name}>
    <summary className="cursor-pointer text-muted">{m.mcp_events_title()}</summary>
    <div className="mt-2 flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text">{m.mcp_events_switch()}</span>
        <HelpTip label={m.field_help_about({ label: m.mcp_events_switch() })}>{m.mcp_events_help()}</HelpTip>
        <ResourceSwitch effect={effect} checked={events.enabled} disabled={!events.can_edit} onCheckedChange={(on) => onChange({ name, events: on })} aria-label={m.mcp_events_switch_label({ name })} />
      </div>
      {events.counts.length > 0 && <p className="text-xs text-muted">{events.counts.map(({ state, count }) => EVENT_COUNTS[state]({ n: count.toLocaleString() })).join(' · ')}</p>}
      {events.detail && <p className="text-xs break-words text-muted">{events.detail}</p>}
    </div>
  </details>
}

type CostPatch = z.infer<typeof McpCostPatchSchema>
type CostPolicy = z.infer<typeof McpCostPolicySchema>
const COST_FIELDS = {
  tool_costs: { label: m.mcp_cost_tools, hint: m.mcp_cost_edit_help },
  spend_limit: { label: m.mcp_cost_limit, hint: m.mcp_cost_limit_help },
  cost_unit: { label: m.mcp_cost_unit, hint: m.mcp_cost_unit_help },
}
const COST_SOURCES = { native: m.mcp_cost_native, package: m.mcp_cost_package, default: m.mcp_cost_default, native_override: m.mcp_cost_override }

function McpCostEditor({ policy }: { policy: CostPolicy }) {
  const id = useId()
  const [field, setField] = useState<keyof CostPatch>('spend_limit')
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const effects = useResourceEffects<CostPatch>()
  const values = { ...policy.overrides, ...effects[`mcp-policy:${policy.name}`]?.value }
  const saved = values[field]
  const text = draft ?? (saved === null || saved === undefined ? '' : typeof saved === 'string' ? saved : JSON.stringify(saved))
  const save = useResourceMutation({
    resource: () => `mcp-policy:${policy.name}`,
    effect: (patch: CostPatch) => ({ value: patch }),
    queryKey: keys.mcp.all,
    mutationFn: (patch: CostPatch) => api.saveMcpCostPolicy(policy.name, policy.revision, patch),
    onError: () => showToast(m.mcp_cost_save_failed(), 5000, 'error'),
  })
  const submit = (unset: boolean) => {
    let value: unknown = null
    try { value = unset ? null : field === 'cost_unit' ? text : JSON.parse(text) }
    catch { setError(m.mcp_cost_json_error()); return }
    setError('')
    setDraft(null)
    save.mutate({ [field]: value })
  }
  return <div className="mt-2 flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-text">{m.mcp_cost_estimate()}</span><span className="text-xs text-muted">{COST_SOURCES[policy.source]()}</span><HelpTip label={m.mcp_cost_provenance()}>{m.mcp_cost_help()}</HelpTip></div>
    {policy.error && <p role="alert" className="text-error">{policy.error}</p>}
    <dl className="text-xs text-muted">
      <div className="flex flex-wrap gap-2"><dt>{m.mcp_cost_limit()}</dt><dd>{policy.spend_limit.toLocaleString()} {policy.cost_unit} · {COST_SOURCES[policy.field_sources.spend_limit]()}</dd></div>
      <div className="flex flex-wrap gap-2"><dt>{m.mcp_cost_unit()}</dt><dd>{policy.cost_unit} · {COST_SOURCES[policy.field_sources.cost_unit]()}</dd></div>
      <div className="flex flex-wrap gap-2"><dt>{m.mcp_cost_tools()}</dt><dd>{COST_SOURCES[policy.field_sources.tool_costs]()}</dd></div>
      {policy.tool_costs.map((cost) => <div key={cost.name} className="flex flex-wrap gap-2"><dt className="font-mono break-all">{cost.name}</dt><dd>{cost.low.toLocaleString()}{cost.high !== cost.low ? `–${cost.high.toLocaleString()}` : ''} {policy.cost_unit}{cost.note ? ` · ${cost.note}` : ''}</dd></div>)}
    </dl>
    <p className="text-xs text-muted">{m.mcp_cost_reload()}</p>
    {policy.can_edit ? <form onSubmit={(e) => { e.preventDefault(); submit(false) }}>
      <SettingRow label={m.mcp_cost_field()} htmlFor={`${id}-field`}>
        <Select id={`${id}-field`} value={field} onValueChange={(v) => { setField(v as keyof CostPatch); setDraft(null); setError('') }}>{Object.entries(COST_FIELDS).map(([key, entry]) => <option key={key} value={key}>{entry.label()}</option>)}</Select>
      </SettingRow>
      <SettingRow label={COST_FIELDS[field].label()} hint={COST_FIELDS[field].hint()} htmlFor={`${id}-value`} stacked>
        {field === 'tool_costs' ? <textarea id={`${id}-value`} value={text} onChange={(e) => setDraft(e.target.value)} rows={4} className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm text-text" /> : <TextInput id={`${id}-value`} value={text} onChange={(e) => setDraft(e.target.value)} />}
      </SettingRow>
      {error && <p role="alert" className="text-error">{error}</p>}
      <div className="flex flex-wrap justify-end gap-1"><IconButton type="submit" variant="default" label={m.mcp_cost_save()}><Check aria-hidden="true" /></IconButton><IconButton variant="ghost" label={m.mcp_cost_unset()} onClick={() => submit(true)}><X aria-hidden="true" /></IconButton></div>
    </form> : <p className="text-xs text-muted">{m.mcp_cost_readonly()}</p>}
  </div>
}

const McpToolRow = memo(function McpToolRow({ name, server, description, status }: {
  name: string | undefined
  server: string | undefined
  description: string | undefined
  status: string | undefined
}) {
  return (
    <Row compact>
      <span className="font-mono text-[13px] text-text">{name}</span>
      <span className="text-xs text-muted">{server}</span>
      <StatusBadge status={status} />
      {description && <span className="line-clamp-2 basis-full text-xs text-muted">{description}</span>}
    </Row>
  )
})
