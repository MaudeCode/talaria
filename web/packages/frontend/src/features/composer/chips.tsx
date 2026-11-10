import { ProviderQuotaPace } from '../settings/ProviderQuotaPace'
import { useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { ChevronDown, Cpu, Brain, Gauge, Wrench, FolderOpen, GitBranch, Shield } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { useContextDetailQuery, useExecutionModesQuery, useModelsQuery, useWorkspacesQuery, useToolsetsCatalogQuery } from '../../app/queries'
import { Menu, MenuChoiceCheckbox, MenuChoiceItem, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuSeparator, type MenuProps } from '../../ui/Menu'
import { cn } from '../../ui/cn'
import { POPUP_MOTION } from '../../ui/popupMotion'
import { formatUsd } from '../../ui/States'
import { catalogEntryById } from '../../lib/modelEntry'
import { ProviderIcon } from '../../lib/providerIcon'
import { lockBackgroundScroll, ModelPickerContent } from './ModelPicker'
import { useDebounced } from '../../lib/useDebounced'
import { useProviderQuotas } from '../../lib/useProviderQuotas'
import { LEVEL_COLOR } from '../insights/QuotaMeter'
import type { ContextWindowSource, ExecutionMode, ExecutionModes } from '@maudecode/talaria-web-contracts'

/**
 * T3 Code's composer control (TAL-429): borderless and muted until hovered, with a faded chevron. `sm` sits in the card's
 * footer, `xs` in the context strip under it; `row` is a labelled row for the composer overflow panel. Also the render
 * target of `Menu`'s trigger, so every other prop (Base UI's aria attributes, handlers, ref) is spread onto the button.
 * `readOnly` shows a value the server froze: the same chip as text, with no chevron or hover. `tooltip` replaces `title` as
 * the hover text only, such as a full name the chip truncates; the accessible name stays `title: label`. `chevron={false}`
 * is a chip that navigates rather than opening a menu.
 */
export function Chip({ icon, label, title, tooltip = title, className, disabled, row, size = 'sm', id, readOnly, chevron = true, ...rest }: { icon: React.ReactNode; label: string; title: string; tooltip?: string; className?: string; disabled?: boolean; row?: boolean | undefined; size?: 'sm' | 'xs'; id?: string | undefined; readOnly?: boolean; chevron?: boolean } & Omit<React.ComponentProps<'button'>, 'title' | 'className' | 'disabled' | 'id'>) {
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
    <button type="button" {...rest} id={id} disabled={disabled} title={tooltip} aria-label={`${title}: ${label}`} className={cn('composer-chip inline-flex shrink-0 items-center whitespace-nowrap rounded-(--control-radius) border border-(--chip-border) bg-(--chip-bg) text-(--chip-fg) outline-none hover:border-(--chip-hover-border) hover:bg-(--chip-hover-bg) hover:text-(--chip-hover-fg) data-[popup-open]:bg-(--chip-hover-bg) data-[popup-open]:text-(--chip-hover-fg) focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:pointer-events-none disabled:opacity-60', sized, className)}>
      {icon}
      <span className="truncate">{label}</span>
      {chevron && <ChevronDown size={12} className="-me-0.5 shrink-0 opacity-50" aria-hidden="true" />}
    </button>
  )
}

/** The catalog entry a chat's model selects: the server's `model_option_id` (TAL-301), else the catalog default for a chat without a model. */
function useChatModelEntry(model: string | null, optionId: string | null) {
  const models = useModelsQuery()
  return { models, selected: catalogEntryById(models.data, model ? optionId : models.data?.default_option_id) }
}

/**
 * Conversation model picker (TAL-1858, T3 Code's): a provider rail with Favorites, search across every provider, a custom
 * id entry and stars. `optionId` is the entry the server says `model` selects (or a just-picked id); with no `model`,
 * the catalog default is ticked. `servedModel` is the session's `served_model` (TAL-978): the chip names the model that
 * answered after a fallback while the picker keeps the configured one ticked.
 */
export function ModelChip({ model, optionId, servedModel = null, onChange, row }: { model: string | null; optionId: string | null; servedModel?: string | null; onChange: (model: string, provider: string | null) => void; row?: boolean }) {
  const { models, selected } = useChatModelEntry(model, optionId)
  const configured = selected ? selected.label ?? selected.id : (model ?? models.data?.default_model) || '—'
  const label = servedModel ?? configured
  const title = servedModel && !row ? m.composer_model_served({ configured, served: servedModel }) : m.composer_control_model()
  const group = selected && models.data?.groups.find((g) => g.models.includes(selected))
  const icon = group ? <ProviderIcon icon={group.icon} className={row ? 'size-5' : undefined} /> : <Cpu size={16} aria-hidden="true" />
  return <ModelPickerPopover selectedId={selected?.id ?? ''} onPick={onChange}
    trigger={<Chip id={row ? undefined : 'composerModelChip'} icon={icon} label={label} title={title} tooltip={servedModel && !row ? title : `${title}: ${label}`} row={row} className="composer-model-chip" />} />
}

/**
 * TAL-2151: the remaining quota of the provider the chat's model routes to, as the server's `composer` words and levels it,
 * opening that provider's Settings page. Mounted only while `show_quota_chip` is on, so nothing is read while it is off;
 * renders nothing while the server has no figure for the provider.
 */
export function QuotaChip({ model, optionId, row }: { model: string | null; optionId: string | null; row?: boolean }) {
  const provider = useChatModelEntry(model, optionId).selected?.provider_id
  const { quotas } = useProviderQuotas({ provider, enabled: !!provider })
  const navigate = useNavigate()
  const quota = provider ? quotas.data?.composer : null
  if (!provider || !quota) return null
  return <Chip id={row ? undefined : 'composerQuotaChip'} className="composer-quota-chip" row={row} chevron={false} data-level={quota.level} label={quota.label} title={m.composer_quota_chip_title()}
    icon={<Gauge size={16} className={cn('shrink-0', LEVEL_COLOR[quota.level].text)} aria-hidden="true" />}
    onClick={() => { void navigate({ to: '/settings/providers/$providerId', params: { providerId: provider } }) }} />
}

/**
 * TAL-1858's model picker in a popover on `trigger`, shared by the composer's model chip and Settings › Models' Change
 * button (TAL-2137). `onPick` gets the entry's `provider_id`, or null for a typed custom id.
 */
export function ModelPickerPopover({ trigger, selectedId, onPick, label = m.composer_control_model(), side = 'top', align = 'start' }: { trigger: React.ReactElement; selectedId: string; onPick: (model: string, provider: string | null) => void; label?: string; side?: 'top' | 'bottom'; align?: 'start' | 'end' }) {
  const models = useModelsQuery()
  const [open, setOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const pick = (id: string, provider: string | null) => { setOpen(false); onPick(id, provider) }
  return (
    // TAL-807: opening the picker reads the catalog again, so a rate limit or quota level reflects the server now.
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) void models.refetch() }}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side={side} align={align} sideOffset={6} sticky className="z-[1400] outline-none">
          {/* TAL-1625: a touch or pen opening focuses the popup, so no software keyboard covers the list; a printable key then goes to search. */}
          <Popover.Popup aria-label={label} initialFocus={(type) => type === 'touch' || type === 'pen' ? popup.current : searchInput.current}
            ref={(node: HTMLDivElement | null) => { popup.current = node; return node ? lockBackgroundScroll(node) : undefined }}
            onKeyDown={(event) => { if (event.target !== searchInput.current && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) searchInput.current?.focus() }}
            className={cn('rounded-lg border border-border bg-surface text-sm text-text shadow-md outline-none', POPUP_MOTION)}>
            <ModelPickerContent selectedId={selectedId} searchInput={searchInput} onClose={() => setOpen(false)}
              onSelect={(id) => pick(id, catalogEntryById(models.data, id)?.provider_id ?? null)} onCustom={(id) => pick(id, null)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** The composer card a chip sits in; the Auxiliary models page's Reasoning chip has none. */
const composerCard = (trigger: HTMLElement) => trigger.closest('.composer-wrap')?.querySelector('.composer-box')

/**
 * TAL-2095: every composer menu opens upward at one width with its name as its first label, and at phone width spans the
 * composer card from its left edge instead of hanging off its chip.
 */
export function ComposerMenu({ label, className, children, ...props }: Omit<MenuProps, 'side' | 'align' | 'host'> & { label: string }) {
  return (
    // In the composer a tall menu, such as Toolsets on a phone, scrolls in the room above rather than covering the input.
    <Menu {...props} label={label} side="top" host={composerCard} className={cn('min-w-64', className)}>
      <MenuGroup><MenuGroupLabel>{label}</MenuGroupLabel>{children}</MenuGroup>
    </Menu>
  )
}

const EFFORTS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const REASONING_LEVEL_LABEL = new Map<string, () => string>([
  ['none', m.reasoning_level_none], ['minimal', m.reasoning_level_minimal], ['low', m.reasoning_level_low], ['medium', m.reasoning_level_medium],
  ['high', m.reasoning_level_high], ['xhigh', m.reasoning_level_xhigh], ['max', m.reasoning_level_max], ['ultra', m.reasoning_level_ultra],
])
/** TAL-2097: a server effort id in words; an id without a message shows as sent. The id itself is what is sent back. */
export const reasoningLevelLabel = (level: string) => REASONING_LEVEL_LABEL.get(level)?.() ?? level

/** `defaultLabel` names what no saved level falls back to (the auxiliary delegation slot inherits its parent's, TAL-1285). */
export function ReasoningChip({ value, levels, onChange, row, defaultLabel = m.reasoning_default() }: { value: string | null; levels: string[] | undefined; onChange: (level: string | null) => void; row?: boolean; defaultLabel?: string }) {
  const options = levels?.length ? ['default', ...levels] : [...EFFORTS]
  return (
    <ComposerMenu label={m.composer_control_reasoning()} trigger={<Chip id={row ? undefined : "composerReasoningChip"} icon={<Brain size={16} aria-hidden="true" />} label={value === null ? defaultLabel : reasoningLevelLabel(value)} title={m.composer_control_reasoning()} row={row} className="composer-reasoning-chip" />}>
      <MenuRadioGroup value={value ?? 'default'} onValueChange={(v: string) => onChange(v === 'default' ? null : v)}>
        {options.map((o) => <MenuChoiceItem key={o} value={o}>{o === 'default' ? defaultLabel : reasoningLevelLabel(o)}</MenuChoiceItem>)}
      </MenuRadioGroup>
    </ComposerMenu>
  )
}

/** Keys a menu's search field hands to the menu: ArrowDown and ArrowUp reach the rows, Escape closes it. */
const SEARCH_LIST_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Escape'])

/**
 * TAL-2096: checkbox rows that apply at once and keep the menu open. `value` is the session's (or a new chat's pending)
 * toolsets as its owner shows them: the choice at once, the previous one again when the server refuses it.
 */
export function ToolsetsChip({ value, onChange, row, sessionId }: { value: string[] | null; onChange: (toolsets: string[] | null) => void; row?: boolean | undefined; sessionId?: string | undefined }) {
  const searchInput = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const title = m.composer_control_toolsets()
  const label = value === null ? m.toolsets_profile_defaults() : (value.length === 1 && value[0]) || m.toolsets_count({ n: value.length })
  const header = <div className="p-1"><input ref={searchInput} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.toolsets_search()} aria-label={m.toolsets_search()} className="h-8 w-full rounded-md border border-border bg-input px-2 text-sm text-text" onKeyDown={(event) => { if (!SEARCH_LIST_KEYS.has(event.key)) event.stopPropagation() }} /></div>
  return (
    <ComposerMenu label={title} search={searchInput} header={header} onOpenChange={(open) => { if (!open) setSearch('') }}
      trigger={<Chip icon={<Wrench size={13} aria-hidden="true" />} label={label} title={title} tooltip={`${title}: ${value?.length ? value.join(', ') : label}`} row={row} size="xs" className="composer-toolsets-chip" />}>
      <ToolsetsPicker value={value} sessionId={sessionId} search={search} onChange={onChange} />
    </ComposerMenu>
  )
}

function ToolsetsPicker({ value, sessionId, search, onChange }: { value: string[] | null; sessionId?: string | undefined; search: string; onChange: (names: string[] | null) => void }) {
  // TAL-2144: the server searches and orders the rows; the menu renders them as they arrive.
  const query = useToolsetsCatalogQuery(value, sessionId, useDebounced(search.trim(), 250))
  if (query.isPending) return <div role="status" className="p-3">{m.loading()}</div>
  if (query.isError) return <div className="p-3"><p role="alert">{m.toolsets_load_error()}</p><button type="button" onClick={() => { void query.refetch() }}>{m.retry()}</button></div>
  // Until the catalog for a new choice arrives, the previous catalog's rows show that choice, and a reset the profile
  // defaults that catalog reported.
  const choosing = query.isPlaceholderData
  const defaults = choosing ? value === null : query.data.using_defaults
  const selected = choosing ? value ?? query.data.default_toolsets : query.data.selected_toolsets
  const rows = query.data.toolsets
  const split = rows.findIndex((item) => item.group === 'not_available')
  const toolsetRow = (item: (typeof rows)[number]) => {
    const on = selected.includes(item.name)
    return (
      // The last selected toolset stays: a session runs with at least one.
      <MenuChoiceCheckbox key={item.name} checked={on} disabled={!item.available || (on && selected.length === 1)}
        onCheckedChange={(next) => onChange(next ? [...selected, item.name] : selected.filter((name) => name !== item.name))}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{item.name}</span>
          {item.description && <span className="truncate text-xs text-muted">{item.description}</span>}
          {item.stripped_tools?.length ? <span className="text-xs text-muted">{m.toolsets_stripped({ tools: item.stripped_tools.join(', '), entries: item.stripped_by?.join(', ') ?? '' })}</span> : null}
        </span>
        {!item.available && <span className="shrink-0 text-xs text-muted">{item.unavailable_reason === 'disabled' ? m.toolsets_disabled() : m.toolsets_unavailable()}</span>}
      </MenuChoiceCheckbox>
    )
  }
  return <>
    <MenuChoiceCheckbox checked={defaults} onCheckedChange={() => { if (!defaults) onChange(null) }}>{m.toolsets_defaults()}</MenuChoiceCheckbox>
    {(split < 0 ? rows : rows.slice(0, split)).map(toolsetRow)}
    {split >= 0 && <MenuGroup><MenuGroupLabel>{m.toolsets_not_available()}</MenuGroupLabel>{rows.slice(split).map(toolsetRow)}</MenuGroup>}
    {rows.length === 0 && <p className="px-2.5 py-1.5 text-sm text-muted">{m.toolsets_no_matches()}</p>}
  </>
}

const EXECUTION_MODE_LABEL: Record<ExecutionMode, () => string> = {
  normal: m.execution_mode_normal, ignore_config: m.execution_mode_ignore_config, safe: m.execution_mode_safe,
}
const EXECUTION_MODE_REASON: Record<NonNullable<ExecutionModes['modes'][number]['reason']>, () => string> = {
  agent_unsupported: m.execution_mode_agent_unsupported, served_profile: m.execution_mode_served_profile,
  gateway_stopped: m.execution_mode_gateway_stopped, gateway_unavailable: m.execution_mode_gateway_unavailable,
}

/**
 * TAL-1040: a fresh chat picks how its Agent runs; without `onChange` it shows the mode the server froze. TAL-2097: a fresh
 * chat shows it once the server says there is a mode to choose (`selectable`, absent from an older server); a mode already
 * picked keeps it, so the pick can still go back to Normal.
 */
export function ExecutionModeChip({ value, onChange, row }: { value: ExecutionMode; onChange?: ((mode: ExecutionMode) => void) | undefined; row?: boolean | undefined }) {
  const [open, setOpen] = useState(false)
  const modes = useExecutionModesQuery(!!onChange)
  const chip = { icon: <Shield size={13} aria-hidden="true" />, label: EXECUTION_MODE_LABEL[value](), title: m.composer_control_execution_mode(), row, size: 'xs' as const, className: 'composer-execution-mode-chip' }
  if (!onChange) return <Chip {...chip} readOnly />
  if (value === 'normal' && (modes.isPending || modes.data?.selectable === false)) return null
  return (
    <ComposerMenu open={open} onOpenChange={setOpen} label={m.composer_control_execution_mode()} trigger={<Chip {...chip} />}>
      <ExecutionModePicker value={value} onChange={(mode) => { onChange(mode); setOpen(false) }} />
    </ComposerMenu>
  )
}

function ExecutionModePicker({ value, onChange }: { value: ExecutionMode; onChange: (mode: ExecutionMode) => void }) {
  const query = useExecutionModesQuery()
  if (query.isPending) return <div role="status" className="p-3">{m.loading()}</div>
  if (query.isError) return <div className="p-3"><p role="alert">{m.execution_mode_gateway_unavailable()}</p><button type="button" onClick={() => { void query.refetch() }}>{m.retry()}</button></div>
  return (
    <MenuRadioGroup value={value} onValueChange={(mode: ExecutionMode) => onChange(mode)}>
      {query.data.modes.map((option) => (
        <MenuChoiceItem key={option.mode} value={option.mode} disabled={!option.available}>
          <span>{EXECUTION_MODE_LABEL[option.mode]()}</span>
          {option.reason && <span className="ms-auto text-xs text-muted">{EXECUTION_MODE_REASON[option.reason]()}</span>}
        </MenuChoiceItem>
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
    <ComposerMenu label={m.composer_control_workspace()} trigger={<Chip id={row ? undefined : "composerWorkspaceChip"} icon={<FolderOpen size={13} aria-hidden="true" />} label={label} title={m.composer_control_workspace()} row={row} size="xs" className="composer-workspace-chip" disabled={list.length === 0} />}>
      <MenuRadioGroup value={value ?? ''} onValueChange={(v: string) => onChange(v)}>
        {list.map((w) => <MenuChoiceItem key={w.path} value={w.path}><span className="flex min-w-0 flex-col"><span className="truncate">{w.name}</span><span className="truncate font-mono text-xs text-muted">{w.path}</span></span></MenuChoiceItem>)}
      </MenuRadioGroup>
      {(onNewWorktree ?? onRemoveWorktree) && <MenuSeparator />}
      {onNewWorktree && (
        <MenuItem onClick={() => onNewWorktree(value)} title={m.workspace_new_worktree_conversation_meta()} className="gap-2">
          <GitBranch size={14} className="shrink-0" aria-hidden="true" />
          <span>{m.workspace_new_worktree_conversation()}</span>
        </MenuItem>
      )}
      {/* A worktree chat's own removal, reachable on touch layouts that hide the sidebar row's menu. */}
      {onRemoveWorktree && <MenuItem onClick={onRemoveWorktree} className="text-error">{m.session_worktree_remove()}</MenuItem>}
    </ComposerMenu>
  )
}

/**
 * The context ring's server figures (TAL-299) and the session's usage counters (TAL-614): rendered as sent, nothing
 * derived here. `onCompress` runs the chat's manual compression; `compressing` disables it while a job runs.
 */
export interface ContextFigures {
  sessionId?: string | undefined; detailKey?: string | null | undefined
  percent: number | null | undefined; used: number | null | undefined; window: number | null | undefined; windowSource?: ContextWindowSource | null | undefined; thresholdPercent?: number | null | undefined
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

const WINDOW_SOURCES = { pinned: m.context_window_pinned, fallback: m.context_window_fallback }

/** A window as sent, labelled when the server says it is a pin or a default rather than a detected limit (TAL-1908). */
const windowText = (tokens: number, source: ContextWindowSource | null | undefined) => source ? `${tokens.toLocaleString()} ${WINDOW_SOURCES[source]()}` : tokens.toLocaleString()

function contextStats({ percent, used, window, windowSource, thresholdPercent, ...usage }: ContextFigures) {
  if (percent == null || used == null || window == null) return null
  const tone = percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low'
  const threshold = thresholdPercent != null ? `${m.auto_compress_label()}: ${thresholdPercent}%` : null
  const total = windowText(window, windowSource)
  const title = `${m.composer_context_usage()}: ${percent}% (${used.toLocaleString()} / ${total})${threshold ? ` · ${threshold}` : ''}`
  // The popover's and phone row's detail lines, after the headline usage line.
  const details = [
    `${used.toLocaleString()} / ${total}`,
    threshold,
    ...usageDetailLines(usage),
  ].filter((d) => d !== null)
  return { pct: percent, tone, title, usage: `${m.composer_context_usage()}: ${percent}%`, details }
}

const COMPRESS_CLASS = 'self-start rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:opacity-60'

/** The ring the footer draws for a context percentage; Settings › Chat's composer drawing (TAL-2138) draws it too. */
export function ContextRingGlyph({ pct }: { pct: number }) {
  const r = 9.75
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100} strokeLinecap="round" />
    </svg>
  )
}

/** The footer ring; a click opens the usage figures and Compress now, as legacy's ring did. */
export function ContextRing(figures: ContextFigures) {
  const [open, setOpen] = useState(false)
  // TAL-1672: a reopen during the close transition keeps the popup mounted; a new key still makes it a new read.
  const [opening, setOpening] = useState(0)
  const st = contextStats(figures)
  if (!st) return <ProviderQuotaPace gauge={figures.planGauge} compact />
  const { pct, tone: t, title } = st
  const tone = t === 'high' ? 'text-error' : t === 'mid' ? 'text-warning' : 'text-accent'
  return (
    <div className="ctx-indicator-wrap relative flex items-center" id="ctxIndicatorWrap">
      <Popover.Root open={open} onOpenChange={(next) => { if (next) setOpening((n) => n + 1); setOpen(next) }}>
        <Popover.Trigger className={cn('ctx-indicator relative flex h-8 w-8 items-center justify-center rounded-full', tone)} aria-label={title} title={title} id="ctxIndicator">
          <ContextRingGlyph pct={pct} />
          <span className="absolute text-[8px] font-semibold tabular-nums" id="ctxPercent">{pct}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="end" sideOffset={6} className="z-[1500]">
            <Popover.Popup id="ctxPopup" aria-label={m.composer_context_usage()} className={cn('flex max-h-[min(36rem,70vh)] max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-text shadow-md outline-none', POPUP_MOTION)}>
              <span className="font-medium">{st.usage}</span>
              {st.details.map((d) => <span key={d} className="tabular-nums text-muted">{d}</span>)}
              <ProviderQuotaPace gauge={figures.planGauge} compact />
              <ContextDetailRows key={`${figures.detailKey ?? ''}:${opening}`} sessionId={figures.sessionId} identity={figures.detailKey} />
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
    {detail.source && <span className="text-muted">{sources[detail.source]()}</span>}
    {detail.used_tokens != null && detail.window_tokens != null && <span className="tabular-nums">{m.context_detail_occupancy({ used: detail.used_tokens.toLocaleString(), total: windowText(detail.window_tokens, detail.window_source) })}</span>}
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
