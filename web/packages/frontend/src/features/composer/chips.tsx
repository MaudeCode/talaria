import { useMemo, useState } from 'react'
import { ChevronDown, Cpu, Brain, Wrench, FolderOpen, GitBranch } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { useModelsQuery, useWorkspacesQuery } from '../../app/queries'
import { HelpTip } from '../../ui/Field'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../ui/Menu'
import { cn } from '../../ui/cn'
import { catalogEntryById } from '../../lib/modelEntry'

/**
 * T3 Code's composer control (TAL-429): borderless and muted until hovered, with a faded chevron. `sm` sits in the card's
 * footer, `xs` in the context strip under it; `row` is a labelled row for the composer overflow panel. Also the render
 * target of `Menu`'s trigger, so every other prop (Base UI's aria attributes, handlers, ref) is spread onto the button.
 */
export function Chip({ icon, label, title, className, disabled, row, size = 'sm', id, ...rest }: { icon: React.ReactNode; label: string; title: string; className?: string; disabled?: boolean; row?: boolean | undefined; size?: 'sm' | 'xs'; id?: string | undefined } & Omit<React.ComponentProps<'button'>, 'title' | 'className' | 'disabled' | 'id'>) {
  if (row) {
    return (
      <button type="button" {...rest} id={id} disabled={disabled} title={title} aria-label={`${title}: ${label}`} className="composer-mobile-config-action">
        {icon}
        <span className="composer-mobile-config-copy"><span className="composer-mobile-config-kicker">{title}</span><span className="composer-mobile-config-value">{label}</span></span>
      </button>
    )
  }
  return (
    <button type="button" {...rest} id={id} disabled={disabled} title={title} aria-label={`${title}: ${label}`} className={cn('composer-chip inline-flex shrink-0 items-center whitespace-nowrap rounded-(--control-radius) border border-(--chip-border) bg-(--chip-bg) text-(--chip-fg) outline-none hover:border-(--chip-hover-border) hover:bg-(--chip-hover-bg) hover:text-(--chip-hover-fg) data-[popup-open]:bg-(--chip-hover-bg) data-[popup-open]:text-(--chip-hover-fg) focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:pointer-events-none disabled:opacity-60', size === 'sm' ? 'h-7 max-w-[240px] gap-1.5 px-2.5 text-[13px] font-medium' : 'h-6 max-w-[220px] gap-1 px-1.5 text-xs font-normal', className)}>
      {icon}
      <span className="truncate">{label}</span>
      <ChevronDown size={12} className="-me-0.5 shrink-0 opacity-50" aria-hidden="true" />
    </button>
  )
}

const RADIO_CLASS = 'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[checked]:text-accent-text'

/**
 * Conversation model picker: grouped by provider with a search field and a custom id entry. `optionId` is the entry the
 * server says `model` selects (or a just-picked id); with no `model`, the catalog default is ticked.
 */
export function ModelChip({ model, optionId, onChange, row }: { model: string | null; optionId: string | null; onChange: (model: string, provider: string | null) => void; row?: boolean }) {
  const models = useModelsQuery()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (models.data?.groups ?? []).map((g) => ({ ...g, models: g.models.filter((mm) => !q || mm.id.toLowerCase().includes(q) || (mm.label ?? '').toLowerCase().includes(q)) })).filter((g) => g.models.length > 0)
  }, [models.data, query])
  const selected = catalogEntryById(models.data, model ? optionId : models.data?.default_option_id)
  const label = selected ? selected.label ?? selected.id : (model ?? models.data?.default_model) || '—'
  return (
    <Menu label={m.composer_control_model()} side="top" className="max-h-[60vh] min-w-72" trigger={<Chip id={row ? undefined : "composerModelChip"} icon={<Cpu size={16} aria-hidden="true" />} label={label} title={m.composer_control_model()} row={row} className="composer-model-chip" />}>
      <div className="p-1"><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.model_search_placeholder()} aria-label={m.model_search_placeholder()} className="h-8 w-full rounded-md border border-border bg-input px-2 text-sm text-text" onKeyDown={(e) => e.stopPropagation()} /></div>
      <MenuRadioGroup value={selected?.id ?? ''} onValueChange={(v: string) => onChange(v, catalogEntryById(models.data, v)?.provider_id ?? null)}>
        {groups.map((g) => (
          <MenuGroup key={g.provider}>
            <MenuGroupLabel>{g.provider}</MenuGroupLabel>
            {g.models.map((mm) => <MenuRadioItem key={mm.id} value={mm.id} className={RADIO_CLASS}>{mm.label ?? mm.id}</MenuRadioItem>)}
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

const EFFORTS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export function ReasoningChip({ value, levels, onChange, row }: { value: string | null; levels: string[] | undefined; onChange: (level: string | null) => void; row?: boolean }) {
  const options = levels?.length ? ['default', ...levels] : [...EFFORTS]
  return (
    <Menu label={m.composer_control_reasoning()} side="top" trigger={<Chip id={row ? undefined : "composerReasoningChip"} icon={<Brain size={16} aria-hidden="true" />} label={value ?? m.reasoning_default()} title={m.composer_control_reasoning()} row={row} className="composer-reasoning-chip" />}>
      <MenuRadioGroup value={value ?? 'default'} onValueChange={(v: string) => onChange(v === 'default' ? null : v)}>
        {options.map((o) => <MenuRadioItem key={o} value={o} className={RADIO_CLASS}>{o === 'default' ? m.reasoning_default() : o}</MenuRadioItem>)}
      </MenuRadioGroup>
    </Menu>
  )
}

export function ToolsetsChip({ value, onChange, row }: { value: string[] | null; onChange: (toolsets: string[] | null) => void; row?: boolean | undefined }) {
  const [draft, setDraft] = useState((value ?? []).join(', '))
  return (
    <Menu label={m.composer_control_toolsets()} side="top" className="min-w-72" trigger={<Chip icon={<Wrench size={13} aria-hidden="true" />} label={value?.length ? value.join(', ') : m.toolsets_global()} title={m.composer_control_toolsets()} row={row} size="xs" className="composer-toolsets-chip" />}>
      <form className="flex flex-col gap-2 p-2" onSubmit={(e) => { e.preventDefault(); const list = draft.split(',').map((s) => s.trim()).filter(Boolean); onChange(list.length ? list : null) }}>
        <div className="flex items-center text-xs font-medium text-text">{m.composer_control_toolsets()}<HelpTip label={m.field_help_about({ label: m.composer_control_toolsets() })} className="shrink-0">{m.toolsets_hint()}</HelpTip></div>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={m.session_toolsets_placeholder()} aria-label={m.composer_control_toolsets()} className="h-8 w-full rounded-md border border-border bg-input px-2 font-mono text-xs text-text" onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="self-end rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg">{m.save()}</button>
      </form>
    </Menu>
  )
}

/** `name` is the session's `workspace_name`; without a session the chip shows the chosen registry entry's name (TAL-303). */
export function WorkspaceChip({ value, name, onChange, onNewWorktree, row }: { value: string | undefined; name?: string | null | undefined; onChange: (path: string) => void; onNewWorktree?: ((workspace: string | undefined) => void) | undefined; row?: boolean | undefined }) {
  const ws = useWorkspacesQuery()
  const list = ws.data?.workspaces ?? []
  const label = (name !== undefined ? name : list.find((w) => w.path === value)?.name) || '—'
  return (
    <Menu label={m.composer_control_workspace()} side="top" className="min-w-64" trigger={<Chip id={row ? undefined : "composerWorkspaceChip"} icon={<FolderOpen size={13} aria-hidden="true" />} label={label} title={m.composer_control_workspace()} row={row} size="xs" className="composer-workspace-chip" disabled={list.length === 0} />}>
      <MenuRadioGroup value={value ?? ''} onValueChange={(v: string) => onChange(v)}>
        {list.map((w) => <MenuRadioItem key={w.path} value={w.path} className={RADIO_CLASS}><span className="flex min-w-0 flex-col"><span className="truncate">{w.name}</span><span className="truncate font-mono text-[10px] text-muted">{w.path}</span></span></MenuRadioItem>)}
      </MenuRadioGroup>
      {onNewWorktree && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => onNewWorktree(value)} className="items-start gap-2">
            <GitBranch size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="flex min-w-0 flex-col"><span>{m.workspace_new_worktree_conversation()}</span><span className="text-[11px] text-muted">{m.workspace_new_worktree_conversation_meta()}</span></span>
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

/** The context ring's server figures (TAL-299): rendered as sent, nothing derived here. */
export interface ContextFigures { percent: number | null | undefined; used: number | null | undefined; window: number | null | undefined; thresholdPercent?: number | null | undefined }

function contextStats({ percent, used, window, thresholdPercent }: ContextFigures) {
  if (percent == null || used == null || window == null) return null
  const tone = percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low'
  const title = `${m.composer_context_usage()}: ${percent}% (${used.toLocaleString()} / ${window.toLocaleString()})${thresholdPercent != null ? ` · ${m.auto_compress_label()}: ${thresholdPercent}%` : ''}`
  return { pct: percent, used, window, tone, title }
}

export function ContextRing(figures: ContextFigures) {
  const st = contextStats(figures)
  if (!st) return null
  const { pct, tone: t, title } = st
  const r = 9.75
  const c = 2 * Math.PI * r
  const tone = t === 'high' ? 'text-error' : t === 'mid' ? 'text-warning' : 'text-accent'
  return (
    <div className="ctx-indicator-wrap relative flex items-center" id="ctxIndicatorWrap">
      <button type="button" className={cn('ctx-indicator relative flex h-8 w-8 items-center justify-center rounded-full', tone)} aria-label={title} title={title} id="ctxIndicator">
        <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
          <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
          <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100} strokeLinecap="round" />
        </svg>
        <span className="absolute text-[8px] font-semibold tabular-nums" id="ctxPercent">{pct}</span>
      </button>
    </div>
  )
}

/** Context readout row for the overflow panel on phones, where the footer ring is hidden. */
export function ContextRow(figures: ContextFigures) {
  const st = contextStats(figures)
  if (!st) return null
  return (
    <div className={cn('composer-mobile-config-action composer-mobile-context-action', st.tone === 'mid' && 'ctx-mid', st.tone === 'high' && 'ctx-high')} role="group" aria-label={m.composer_mobile_context()} id="composerMobileContextAction">
      <span className="composer-mobile-config-copy composer-mobile-context-copy">
        <span className="composer-mobile-config-kicker">{m.composer_mobile_context()}</span>
        <span className="composer-mobile-config-value">{m.composer_context_usage()}: {st.pct}%</span>
        <span className="composer-mobile-context-detail">{st.used.toLocaleString()} / {st.window.toLocaleString()}</span>
        {figures.thresholdPercent != null ? <span className="composer-mobile-context-detail">{m.auto_compress_label()}: {figures.thresholdPercent}%</span> : null}
      </span>
    </div>
  )
}
