import { ProviderQuotaPace } from '../settings/ProviderQuotaPace'
import { Fragment, memo, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { ChevronDown, Cpu, Brain, Wrench, FolderOpen, GitBranch, Shield } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { useContextDetailQuery, useExecutionModesQuery, useModelsQuery, useWorkspacesQuery, useToolsetsCatalogQuery } from '../../app/queries'
import { MENU_ROW, Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../ui/Menu'
import { cn } from '../../ui/cn'
import { formatUsd } from '../../ui/States'
import { catalogEntryById, catalogGroupLabel, catalogModelSections, ModelOptionContent, type ModelEntry } from '../../lib/modelEntry'
import { useLocale } from '../../i18n/useLocale'
import { resetTime } from '../../i18n/units'
import type { ExecutionMode, ExecutionModes, Models } from '@maudecode/talaria-web-contracts'

/**
 * T3 Code's composer control (TAL-429): borderless and muted until hovered, with a faded chevron. `sm` sits in the card's
 * footer, `xs` in the context strip under it; `row` is a labelled row for the composer overflow panel. Also the render
 * target of `Menu`'s trigger, so every other prop (Base UI's aria attributes, handlers, ref) is spread onto the button.
 * `readOnly` shows a value the server froze: the same chip as text, with no chevron or hover.
 */
export function Chip({ icon, label, title, className, disabled, row, size = 'sm', id, readOnly, ...rest }: { icon: React.ReactNode; label: string; title: string; className?: string; disabled?: boolean; row?: boolean | undefined; size?: 'sm' | 'xs'; id?: string | undefined; readOnly?: boolean } & Omit<React.ComponentProps<'button'>, 'title' | 'className' | 'disabled' | 'id'>) {
  const sized = size === 'sm' ? 'h-7 max-w-[240px] gap-1.5 px-2.5 text-[13px] font-medium' : 'h-6 max-w-[220px] gap-1 px-1.5 text-xs font-normal'
  if (readOnly) {
    return (
      <span id={id} title={title} aria-label={`${title}: ${label}`} className={cn('composer-chip inline-flex shrink-0 items-center whitespace-nowrap rounded-(--control-radius) border border-(--chip-border) bg-(--chip-bg) text-(--chip-fg)', sized, className)}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
    )
  }
  if (row) {
    return (
      <button type="button" {...rest} id={id} disabled={disabled} title={title} aria-label={`${title}: ${label}`} className="composer-mobile-config-action">
        {icon}
        <span className="composer-mobile-config-copy"><span className="composer-mobile-config-kicker">{title}</span><span className="composer-mobile-config-value">{label}</span></span>
      </button>
    )
  }
  return (
    <button type="button" {...rest} id={id} disabled={disabled} title={title} aria-label={`${title}: ${label}`} className={cn('composer-chip inline-flex shrink-0 items-center whitespace-nowrap rounded-(--control-radius) border border-(--chip-border) bg-(--chip-bg) text-(--chip-fg) outline-none hover:border-(--chip-hover-border) hover:bg-(--chip-hover-bg) hover:text-(--chip-hover-fg) data-[popup-open]:bg-(--chip-hover-bg) data-[popup-open]:text-(--chip-hover-fg) focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:pointer-events-none disabled:opacity-60', sized, className)}>
      {icon}
      <span className="truncate">{label}</span>
      <ChevronDown size={12} className="-me-0.5 shrink-0 opacity-50" aria-hidden="true" />
    </button>
  )
}

const RADIO_CLASS = cn(MENU_ROW, 'data-[checked]:text-accent-text')
const SEARCH_LIST_KEYS = new Set(['Escape', 'ArrowDown', 'ArrowUp'])

/** TAL-807: the server's rate-limit state for a provider group: its account limit or a low quota level (never both). */
function GroupLimitBadge({ group, locale }: { group: Models['groups'][number]; locale: string }) {
  const badge = 'shrink-0 text-[11px] font-medium normal-case tracking-normal'
  if (group.limit?.scope === 'account') return <span data-model-limit="account" className={cn(badge, 'text-error')}>{m.model_limited_until({ time: resetTime(locale, group.limit.resets_at) })}</span>
  if (group.quota_level === 'critical') return <span data-quota-level="critical" className={cn(badge, 'text-error')}>{m.model_quota_critical()}</span>
  if (group.quota_level === 'warning') return <span data-quota-level="warning" className={cn(badge, 'text-warning')}>{m.model_quota_warning()}</span>
  return null
}

/**
 * Conversation model picker: grouped by provider with a search field and a custom id entry. `optionId` is the entry the
 * server says `model` selects (or a just-picked id); with no `model`, the catalog default is ticked. `servedModel` is the
 * session's `served_model` (TAL-978): the chip names the model that answered after a fallback while the picker keeps
 * the configured one ticked.
 */
export function ModelChip({ model, optionId, servedModel = null, onChange, row }: { model: string | null; optionId: string | null; servedModel?: string | null; onChange: (model: string, provider: string | null) => void; row?: boolean }) {
  const models = useModelsQuery()
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const groups = (() => {
    if (!open) return []
    return (models.data?.groups ?? []).map((g) => ({ ...g, displaySections: catalogModelSections(g, query) })).filter((g) => g.displaySections.some((section) => section.models.length))
  })()
  const onSelect = (id: string) => onChange(id, catalogEntryById(models.data, id)?.provider_id ?? null)
  const selected = catalogEntryById(models.data, model ? optionId : models.data?.default_option_id)
  const configured = selected ? selected.label ?? selected.id : (model ?? models.data?.default_model) || '—'
  const label = servedModel ?? configured
  const title = servedModel && !row ? m.composer_model_served({ configured, served: servedModel }) : m.composer_control_model()
  return (
    // TAL-807: opening the picker reads the catalog again, so a rate limit or quota level reflects the server now.
    // TAL-1131: search is the menu's pinned header; ArrowUp/ArrowDown reach Base UI's list navigation, other keys stay typing.
    <Menu open={open} initialFocus={searchInput} label={m.composer_control_model()} side="top" className="min-w-72 max-w-[calc(100vw-2rem)] [--menu-max-height:60vh]" onOpenChange={(open) => { setOpen(open); if (open) void models.refetch() }} trigger={<Chip id={row ? undefined : "composerModelChip"} icon={<Cpu size={16} aria-hidden="true" />} label={label} title={title} row={row} className="composer-model-chip" />}
      header={<div className="p-1"><input ref={searchInput} type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.model_search_placeholder()} aria-label={m.model_search_placeholder()} className="h-8 w-full rounded-md border border-border bg-input px-2 text-sm text-text" onKeyDown={(e) => { if (!SEARCH_LIST_KEYS.has(e.key)) e.stopPropagation() }} /></div>}>
      <MenuRadioGroup value={selected?.id ?? ''} onValueChange={onSelect}>
        {groups.map((g) => (
          <MenuGroup key={g.provider}>
            <MenuGroupLabel><span className="flex items-center justify-between gap-2"><span className="truncate">{catalogGroupLabel(g)}</span><GroupLimitBadge group={g} locale={locale} /></span></MenuGroupLabel>
            <ProviderQuotaPace plan={g.plan_usage} planStale={g.plan_stale} compact />
            {g.displaySections.map((section) => {
              const rows = section.models.map((entry) => <ModelMenuRow key={entry.id} entry={entry} locale={locale} />)
              return section.label ? <MenuGroup key={section.label}>
                <MenuGroupLabel>{section.label}</MenuGroupLabel>{rows}
              </MenuGroup> : <Fragment key={section.label}>{rows}</Fragment>
            })}
          </MenuGroup>
        ))}
      </MenuRadioGroup>
      {query.trim() && !groups.some((g) => g.models.some((mm) => mm.id === query.trim())) && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => onChange(query.trim(), null)}><span className="font-mono text-xs">{query.trim()}</span> <span className="text-xs text-muted">{m.model_custom_placeholder()}</span></MenuItem>
        </>
      )}
    </Menu>
  )
}

/** Search changes membership; surviving catalog rows keep their rendered label and cooldown. */
const ModelMenuRow = memo(function ModelMenuRow({ entry, locale }: { entry: ModelEntry; locale: string }) {
  const resetsAt = entry.limit?.resets_at
  return <MenuRadioItem value={entry.id} className={RADIO_CLASS}>
    <ModelOptionContent entry={entry} />
    {resetsAt && <span data-model-limit="model" className="ms-auto shrink-0 text-xs text-warning">{m.model_limited_until({ time: resetTime(locale, resetsAt) })}</span>}
  </MenuRadioItem>
})

const EFFORTS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
/** `defaultLabel` names what no saved level falls back to (the auxiliary delegation slot inherits its parent's, TAL-1285). */
export function ReasoningChip({ value, levels, onChange, row, defaultLabel = m.reasoning_default() }: { value: string | null; levels: string[] | undefined; onChange: (level: string | null) => void; row?: boolean; defaultLabel?: string }) {
  const options = levels?.length ? ['default', ...levels] : [...EFFORTS]
  return (
    <Menu label={m.composer_control_reasoning()} side="top" trigger={<Chip id={row ? undefined : "composerReasoningChip"} icon={<Brain size={16} aria-hidden="true" />} label={value ?? defaultLabel} title={m.composer_control_reasoning()} row={row} className="composer-reasoning-chip" />}>
      <MenuRadioGroup value={value ?? 'default'} onValueChange={(v: string) => onChange(v === 'default' ? null : v)}>
        {options.map((o) => <MenuRadioItem key={o} value={o} className={RADIO_CLASS}>{o === 'default' ? defaultLabel : o}</MenuRadioItem>)}
      </MenuRadioGroup>
    </Menu>
  )
}

export function ToolsetsChip({ value, onChange, row, sessionId }: { value: string[] | null; onChange: (toolsets: string[] | null) => void; row?: boolean | undefined; sessionId?: string | undefined }) {
  const [open, setOpen] = useState(false)
  return (
    <Menu open={open} onOpenChange={setOpen} label={m.composer_control_toolsets()} side="top" className="min-w-72" trigger={<Chip icon={<Wrench size={13} aria-hidden="true" />} label={value?.length ? value.join(', ') : m.toolsets_global()} title={m.composer_control_toolsets()} row={row} size="xs" className="composer-toolsets-chip" />}>
      {open && <ToolsetsPicker value={value} sessionId={sessionId} onChange={(names) => { onChange(names); setOpen(false) }} />}
    </Menu>
  )
}

function ToolsetsPicker({ value, sessionId, onChange }: { value: string[] | null; sessionId?: string | undefined; onChange: (names: string[] | null) => void }) {
  const query = useToolsetsCatalogQuery(value, sessionId)
  const [draft, setDraft] = useState<string[] | null>(null)
  if (query.isPending) return <div role="status" className="p-3">{m.loading()}</div>
  if (query.isError) return <div className="p-3"><p role="alert">{m.toolsets_load_error()}</p><button type="button" onClick={() => { void query.refetch() }}>{m.retry()}</button></div>
  const selected = draft ?? query.data.selected_toolsets
  return <form className="flex flex-col gap-2 p-2" onSubmit={(event) => { event.preventDefault(); onChange(draft === null && query.data.using_defaults ? null : selected) }}>
    <div className="max-h-64 overflow-y-auto">
      {query.data.toolsets.map((item) => <label key={item.name} title={item.description} className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" disabled={!item.available} checked={draft === null ? item.selected : draft.includes(item.name)} onChange={(event) => setDraft(event.target.checked ? [...selected, item.name] : selected.filter((name) => name !== item.name))} />
        <span>{item.name}</span>
        {!item.available && <span className="ml-auto text-xs text-muted">{item.unavailable_reason === 'disabled' ? m.toolsets_disabled() : m.toolsets_unavailable()}</span>}
      </label>)}
    </div>
    <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
      <button type="button" onClick={() => onChange(null)} className="min-h-11 text-xs text-muted">{m.toolsets_defaults()}</button>
      <button type="submit" disabled={selected.length === 0} className="min-h-11 min-w-11 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg disabled:opacity-50">{m.save()}</button>
    </div>
  </form>
}

const EXECUTION_MODE_LABEL: Record<ExecutionMode, () => string> = {
  normal: m.execution_mode_normal, ignore_config: m.execution_mode_ignore_config, safe: m.execution_mode_safe,
}
const EXECUTION_MODE_REASON: Record<NonNullable<ExecutionModes['modes'][number]['reason']>, () => string> = {
  agent_unsupported: m.execution_mode_agent_unsupported, served_profile: m.execution_mode_served_profile,
  gateway_stopped: m.execution_mode_gateway_stopped, gateway_unavailable: m.execution_mode_gateway_unavailable,
}

/** TAL-1040: a fresh chat picks how its Agent runs; without `onChange` it shows the mode the server froze. */
export function ExecutionModeChip({ value, onChange, row }: { value: ExecutionMode; onChange?: ((mode: ExecutionMode) => void) | undefined; row?: boolean | undefined }) {
  const [open, setOpen] = useState(false)
  const chip = { icon: <Shield size={13} aria-hidden="true" />, label: EXECUTION_MODE_LABEL[value](), title: m.composer_control_execution_mode(), row, size: 'xs' as const, className: 'composer-execution-mode-chip' }
  if (!onChange) return <Chip {...chip} readOnly />
  return (
    <Menu open={open} onOpenChange={setOpen} label={m.composer_control_execution_mode()} side="top" className="min-w-64" trigger={<Chip {...chip} />}>
      {open && <ExecutionModePicker value={value} onChange={(mode) => { onChange(mode); setOpen(false) }} />}
    </Menu>
  )
}

function ExecutionModePicker({ value, onChange }: { value: ExecutionMode; onChange: (mode: ExecutionMode) => void }) {
  const query = useExecutionModesQuery()
  if (query.isPending) return <div role="status" className="p-3">{m.loading()}</div>
  if (query.isError) return <div className="p-3"><p role="alert">{m.execution_mode_gateway_unavailable()}</p><button type="button" onClick={() => { void query.refetch() }}>{m.retry()}</button></div>
  return (
    <MenuRadioGroup value={value} onValueChange={(mode: ExecutionMode) => onChange(mode)}>
      {query.data.modes.map((option) => (
        <MenuRadioItem key={option.mode} value={option.mode} disabled={!option.available} className={cn(RADIO_CLASS, 'data-[disabled]:opacity-60')}>
          <span>{EXECUTION_MODE_LABEL[option.mode]()}</span>
          {option.reason && <span className="ms-auto text-xs text-muted">{EXECUTION_MODE_REASON[option.reason]()}</span>}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  )
}

/** `name` is the session's `workspace_name`; without a session the chip shows the chosen registry entry's name (TAL-303). */
export function WorkspaceChip({ value, name, onChange, onNewWorktree, onRemoveWorktree, row }: { value: string | undefined; name?: string | null | undefined; onChange: (path: string) => void; onNewWorktree?: ((workspace: string | undefined) => void) | undefined; onRemoveWorktree?: (() => void) | undefined; row?: boolean | undefined }) {
  const ws = useWorkspacesQuery()
  const list = ws.data?.workspaces ?? []
  const label = (name !== undefined ? name : list.find((w) => w.path === value)?.name) || '—'
  return (
    <Menu label={m.composer_control_workspace()} side="top" className="min-w-64" trigger={<Chip id={row ? undefined : "composerWorkspaceChip"} icon={<FolderOpen size={13} aria-hidden="true" />} label={label} title={m.composer_control_workspace()} row={row} size="xs" className="composer-workspace-chip" disabled={list.length === 0} />}>
      <MenuRadioGroup value={value ?? ''} onValueChange={(v: string) => onChange(v)}>
        {list.map((w) => <MenuRadioItem key={w.path} value={w.path} className={RADIO_CLASS}><span className="flex min-w-0 flex-col"><span className="truncate">{w.name}</span><span className="truncate font-mono text-[10px] text-muted">{w.path}</span></span></MenuRadioItem>)}
      </MenuRadioGroup>
      {(onNewWorktree ?? onRemoveWorktree) && <MenuSeparator />}
      {onNewWorktree && (
        <MenuItem onClick={() => onNewWorktree(value)} className="items-start gap-2">
          <GitBranch size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-col"><span>{m.workspace_new_worktree_conversation()}</span><span className="text-[11px] text-muted">{m.workspace_new_worktree_conversation_meta()}</span></span>
        </MenuItem>
      )}
      {/* A worktree chat's own removal, reachable on touch layouts that hide the sidebar row's menu. */}
      {onRemoveWorktree && <MenuItem onClick={onRemoveWorktree} className="text-error">{m.session_worktree_remove()}</MenuItem>}
    </Menu>
  )
}

/**
 * The context ring's server figures (TAL-299) and the session's usage counters (TAL-614): rendered as sent, nothing
 * derived here. `onCompress` runs the chat's manual compression; `compressing` disables it while a job runs.
 */
export interface ContextFigures {
  sessionId?: string | undefined; detailKey?: string | null | undefined
  percent: number | null | undefined; used: number | null | undefined; window: number | null | undefined; thresholdPercent?: number | null | undefined
  planGauge?: import('@maudecode/talaria-web-contracts').PlanGauge | null | undefined
  input?: number | undefined; output?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined; cacheHitPercent?: number | null | undefined; cost?: number | null | undefined
  onCompress?: (() => void) | undefined; compressing?: boolean | undefined
}

/** Token, cost and cache lines for a usage record as sent: the session's in the context popover, one reply's in its footer (TAL-1076). */
export function usageDetailLines({ input, output, cacheRead, cacheWrite, cacheHitPercent, cost }: Pick<ContextFigures, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheHitPercent' | 'cost'>): string[] {
  return [
    input != null ? `${m.usage_input_tokens()}: ${input.toLocaleString()}` : null,
    output != null ? `${m.usage_output_tokens()}: ${output.toLocaleString()}` : null,
    cost != null ? `${m.usage_estimated_cost()}: ${formatUsd(cost)}` : null,
    cacheHitPercent != null ? m.usage_cache_hit_detail({ a0: cacheHitPercent, a1: (cacheRead ?? 0).toLocaleString(), a2: (cacheWrite ?? 0).toLocaleString() }) : null,
  ].filter((d) => d !== null)
}

function contextStats({ percent, used, window, thresholdPercent, ...usage }: ContextFigures) {
  if (percent == null || used == null || window == null) return null
  const tone = percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low'
  const threshold = thresholdPercent != null ? `${m.auto_compress_label()}: ${thresholdPercent}%` : null
  const title = `${m.composer_context_usage()}: ${percent}% (${used.toLocaleString()} / ${window.toLocaleString()})${threshold ? ` · ${threshold}` : ''}`
  // The popover's and phone row's detail lines, after the headline usage line.
  const details = [
    `${used.toLocaleString()} / ${window.toLocaleString()}`,
    threshold,
    ...usageDetailLines(usage),
  ].filter((d) => d !== null)
  return { pct: percent, tone, title, usage: `${m.composer_context_usage()}: ${percent}%`, details }
}

const COMPRESS_CLASS = 'self-start rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-60'

/** The footer ring; a click opens the usage figures and Compress now, as legacy's ring did. */
export function ContextRing(figures: ContextFigures) {
  const [open, setOpen] = useState(false)
  const st = contextStats(figures)
  if (!st) return <ProviderQuotaPace gauge={figures.planGauge} compact />
  const { pct, tone: t, title } = st
  const r = 9.75
  const c = 2 * Math.PI * r
  const tone = t === 'high' ? 'text-error' : t === 'mid' ? 'text-warning' : 'text-accent'
  return (
    <div className="ctx-indicator-wrap relative flex items-center" id="ctxIndicatorWrap">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className={cn('ctx-indicator relative flex h-8 w-8 items-center justify-center rounded-full', tone)} aria-label={title} title={title} id="ctxIndicator">
          <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
            <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100} strokeLinecap="round" />
          </svg>
          <span className="absolute text-[8px] font-semibold tabular-nums" id="ctxPercent">{pct}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="end" sideOffset={6} className="z-[1500]">
            <Popover.Popup id="ctxPopup" aria-label={m.composer_context_usage()} className="flex max-h-[min(36rem,70vh)] max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text shadow-md outline-none">
              <span className="font-medium">{st.usage}</span>
              {st.details.map((d) => <span key={d} className="tabular-nums text-muted">{d}</span>)}
              <ProviderQuotaPace gauge={figures.planGauge} compact />
              {open && <ContextDetailRows key={figures.detailKey} sessionId={figures.sessionId} identity={figures.detailKey} />}
              {figures.onCompress && <Popover.Close className={cn(COMPRESS_CLASS, 'mt-1.5')} id="ctxCompressBtn" disabled={figures.compressing} onClick={figures.onCompress}>{m.ctx_compress_now()}</Popover.Close>}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

/** Context readout row for the overflow panel on phones, where the footer ring is hidden. */
export function ContextRow(figures: ContextFigures) {
  const st = contextStats(figures)
  if (!st) return <ProviderQuotaPace gauge={figures.planGauge} compact />
  return (
    <div className={cn('composer-mobile-config-action composer-mobile-context-action', st.tone === 'mid' && 'ctx-mid', st.tone === 'high' && 'ctx-high')} role="group" aria-label={m.composer_mobile_context()} id="composerMobileContextAction">
      <div className="composer-mobile-config-copy composer-mobile-context-copy">
        <span className="composer-mobile-config-kicker">{m.composer_mobile_context()}</span>
        <span className="composer-mobile-config-value">{st.usage}</span>
        {st.details.map((d) => <span key={d} className="composer-mobile-context-detail">{d}</span>)}
        <ProviderQuotaPace gauge={figures.planGauge} compact />
        <ContextDetailRows key={figures.detailKey} sessionId={figures.sessionId} identity={figures.detailKey} />
        {figures.onCompress && <button type="button" className={cn(COMPRESS_CLASS, 'mt-1')} id="composerMobileCompressBtn" disabled={figures.compressing} onClick={figures.onCompress}>{m.ctx_compress_now()}</button>}
      </div>
    </div>
  )
}


/** The existing ring and overflow row share one metadata renderer and open-only query. */
function ContextDetailRows({ sessionId, identity }: { sessionId?: string | undefined; identity?: string | null | undefined }) {
  if (!sessionId || !identity) return <span className="text-muted">{m.context_detail_unavailable()}</span>
  return <LoadedContextDetail sessionId={sessionId} identity={identity} />
}

function LoadedContextDetail({ sessionId, identity }: { sessionId: string; identity: string }) {
  const query = useContextDetailQuery(sessionId, identity)
  if (query.isPending) return <span role="status" className="text-muted">{m.loading()}</span>
  if (query.isError || !query.data.available) return <span className="text-muted">{query.data?.reason === 'not_built' ? m.context_detail_not_built() : m.context_detail_unavailable()}</span>
  const detail = query.data
  const categories = { system_prompt: m.context_category_system, tool_definitions: m.context_category_tools, rules: m.context_category_rules, skills: m.context_category_skills, mcp: m.context_category_mcp, subagent_definitions: m.context_category_subagents, memory: m.context_category_memory, conversation: m.context_category_conversation }
  const sources = { provider_usage: m.context_source_provider, local_estimate: m.context_source_local, provider_usage_plus_estimate: m.context_source_mixed }
  const statuses = { loaded: m.context_file_loaded, truncated: m.context_file_truncated, flagged: m.context_file_flagged, shadowed: m.context_file_shadowed, blocked: m.context_file_blocked, empty: m.context_file_empty, unreadable: m.context_file_unreadable, suppressed: m.context_file_suppressed, unknown: m.context_unknown }
  return <div className="mt-2 flex min-w-0 flex-col gap-2 border-t border-border pt-2" data-context-detail>
    <span className="text-muted">{detail.source ? sources[detail.source]() : m.context_unknown()}</span>
    {detail.used_tokens != null && detail.window_tokens != null && <span className="tabular-nums">{m.context_detail_occupancy({ used: detail.used_tokens.toLocaleString(), total: detail.window_tokens.toLocaleString() })}</span>}
    <span className="font-medium">{m.context_category_estimates()}</span>
    <dl className="flex flex-col gap-1">
      {detail.categories.map((category) => <div key={category.id}>
        <div className="flex justify-between gap-4"><dt>{categories[category.id]()}</dt><dd className="tabular-nums">~{category.tokens.toLocaleString()}</dd></div>
        {category.percent != null && <div className="h-0.5 overflow-hidden rounded-full bg-border" aria-hidden="true"><div className="h-full bg-accent" style={{ width: `${category.percent}%` }} /></div>}
      </div>)}
    </dl>
    {detail.current_turn_output_tokens != null && <span>{m.context_current_output({ tokens: detail.current_turn_output_tokens.toLocaleString() })}</span>}
    {detail.last_turn_output_tokens != null && <span>{m.context_last_output({ tokens: detail.last_turn_output_tokens.toLocaleString() })}</span>}
    {detail.files.length > 0 && <><span className="font-medium">{m.context_files()}</span><ul className="flex flex-col gap-2">{detail.files.map((file, i) => <li key={i} className="flex flex-col">
      <span className="flex justify-between gap-4"><span className="font-mono">{file.label === 'Context file' ? m.context_file() : file.label}</span><span>{statuses[file.status]()}</span></span>
      <span className="tabular-nums text-muted">{m.context_file_size({ characters: file.characters?.toLocaleString() ?? m.context_unknown(), tokens: file.tokens?.toLocaleString() ?? m.context_unknown() })}</span>
    </li>)}</ul></>}
    {detail.truncated && <span className="text-muted">{m.context_details_limited()}</span>}
  </div>
}
