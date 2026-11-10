/*
 * The model picker's structure is ported from T3 Code (https://github.com/pingdotgg/t3code) at
 * 5eebf77b373b719ca4456985340707afa267310e: apps/web/src/components/chat/ProviderModelPicker.tsx,
 * ModelPickerContent.tsx, ModelPickerSidebar.tsx and ModelListRow.tsx.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { memo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { Toolbar } from '@base-ui/react/toolbar'
import { Check, Search, Star } from 'lucide-react'
import type { Models } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { useModelFavoriteShown, useModelsQuery, useSetModelFavorite } from '../../app/queries'
import { catalogGroupLabel, catalogModelSections, ModelOptionContent, modelOptionLabel, type ModelEntry } from '../../lib/modelEntry'
import { ProviderIcon } from '../../lib/providerIcon'
import { useLocale } from '../../i18n/useLocale'
import { resetTime } from '../../i18n/units'
import { cn } from '../../ui/cn'
import { RowContextMenu } from '../../ui/Menu'
import { Tooltip } from '../../ui/Tooltip'
import { ProviderQuotaPace } from '../settings/ProviderQuotaPace'
import { ModelPickerList, type ModelPickerListHandle } from './ModelPickerList'

type Group = Models['groups'][number]
type Row = { kind: 'label'; key: string; label: string } | { kind: 'model'; key: string; entry: ModelEntry; group: Group; option: number } | { kind: 'custom'; key: string; id: string; option: number }

const FAVORITES = 'favorites'
/** The custom-id row's value; no catalog id starts with a NUL. */
const CUSTOM = '\u0000custom'
// Estimated row heights in px; rows measure themselves once rendered.
const LABEL_ROW = 26
const ONE_LINE_ROW = 32
const TWO_LINE_ROW = 46
const MAX_HEIGHT = 346
// The search box and list padding.
const CHROME = 52

/** TAL-807: the server's rate-limit state for a provider group: its account limit or a low quota level (never both). */
function groupLimit(group: Group, locale: string): { text: string; tone: string; data: Record<string, string> } | null {
  if (group.limit?.scope === 'account') return { text: m.model_limited_until({ time: resetTime(locale, group.limit.resets_at) }), tone: 'text-error', data: { 'data-model-limit': 'account' } }
  if (group.quota_level === 'critical') return { text: m.model_quota_critical(), tone: 'text-error', data: { 'data-quota-level': 'critical' } }
  if (group.quota_level === 'warning') return { text: m.model_quota_warning(), tone: 'text-warning', data: { 'data-quota-level': 'warning' } }
  return null
}

/** The group's limit badge: in the provider tab's header, and beside the provider on every row of Favorites and search. */
function GroupLimitBadge({ group, locale }: { group: Group; locale: string }) {
  const limit = groupLimit(group, locale)
  return limit && <span {...limit.data} className={cn('shrink-0 text-[11px] font-medium normal-case tracking-normal', limit.tone)}>{limit.text}</span>
}

const groupKey = (group: Group) => group.provider_id ?? group.provider

/**
 * Holds the page still behind the open picker (T3 Code's `lockBackgroundScroll`): wheel and touch scrolling outside the
 * picker are cancelled, which also covers the transcript pane, not only the document. Its lifetime is the popup's.
 */
export function lockBackgroundScroll(popup: HTMLElement) {
  const { documentElement, body } = document
  const previous = { overscroll: documentElement.style.overscrollBehavior, overflow: body.style.overflow, padding: body.style.paddingRight }
  const scrollbar = documentElement.clientWidth > 0 ? window.innerWidth - documentElement.clientWidth : 0
  documentElement.style.overscrollBehavior = 'contain'
  body.style.overflow = 'hidden'
  if (scrollbar > 0) body.style.paddingRight = `${String(scrollbar)}px`
  const block = (event: Event) => { if (!(event.target instanceof Node && popup.contains(event.target))) event.preventDefault() }
  const options = { capture: true, passive: false }
  document.addEventListener('wheel', block, options)
  document.addEventListener('touchmove', block, options)
  return () => {
    document.removeEventListener('wheel', block, { capture: true })
    document.removeEventListener('touchmove', block, { capture: true })
    documentElement.style.overscrollBehavior = previous.overscroll
    body.style.overflow = previous.overflow
    body.style.paddingRight = previous.padding
  }
}

/**
 * The picker's body: a provider rail (Favorites, then the catalog's groups), search, and one virtualized list. Search
 * spans every provider and hides the rail; each row then names its provider. Selection, search and layout are the
 * client's; every value shown, including `favorite`, is the server's.
 */
export function ModelPickerContent({ selectedId, searchInput, onSelect, onCustom, onClose }: { selectedId: string; searchInput: RefObject<HTMLInputElement | null>; onSelect: (id: string) => void; onCustom: (id: string) => void; onClose: () => void }) {
  const models = useModelsQuery()
  const locale = useLocale()
  const shown = useModelFavoriteShown()
  const star = useSetModelFavorite()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const list = useRef<ModelPickerListHandle>(null)
  const groups = models.data?.groups ?? []
  const q = query.trim()
  const searching = q !== ''
  // Favorites in the server's starred order, as the user's pending stars show them: an unstar drops its row, a new star
  // goes last, where the server puts it.
  const byId = new Map(groups.flatMap((group) => group.models.map((entry) => [entry.id, { entry, group }] as const)))
  const starredIds = models.data?.favorite_option_ids ?? []
  const favorites = [
    ...starredIds.flatMap((id) => { const row = byId.get(id); return row && shown(row.entry) ? [row] : [] }),
    ...[...byId.values()].filter(({ entry }) => shown(entry) && !starredIds.includes(entry.id)),
  ]
  // Opens on Favorites when any exist, else on the selected model's provider, as T3 Code does.
  const opening = favorites.length ? FAVORITES : groups.find((g) => g.models.some((e) => e.id === selectedId)) ?? groups[0]
  const fallback = opening === FAVORITES || !opening ? FAVORITES : groupKey(opening)
  const view = picked !== null && (picked === FAVORITES || groups.some((g) => groupKey(g) === picked)) ? picked : fallback
  const group = groups.find((g) => groupKey(g) === view)

  const rows: Row[] = []
  const options: string[] = []
  const addModel = (entry: ModelEntry, g: Group) => { rows.push({ kind: 'model', key: entry.id, entry, group: g, option: options.length }); options.push(entry.id) }
  if (searching) {
    for (const g of groups) for (const section of catalogModelSections(g, q)) for (const entry of section.models) addModel(entry, g)
    if (!groups.some((g) => g.models.some((entry) => entry.id === q))) { rows.push({ kind: 'custom', key: CUSTOM, id: q, option: options.length }); options.push(CUSTOM) }
  } else if (view === FAVORITES) {
    for (const { entry, group: g } of favorites) addModel(entry, g)
  } else if (group) {
    for (const section of catalogModelSections(group)) {
      if (section.label) rows.push({ kind: 'label', key: `label:${section.label}`, label: section.label })
      for (const entry of section.models) addModel(entry, group)
    }
  }
  const mixed = searching || view === FAVORITES
  // The tallest provider tab sets the height, so switching tabs or searching does not resize the popup.
  const tallest = Math.max(favorites.length * TWO_LINE_ROW, ...groups.map((g) => catalogModelSections(g).reduce((sum, s) => sum + (s.label ? LABEL_ROW : 0) + s.models.length * ONE_LINE_ROW, 0)))
  const choose = (value: string) => { if (value === CUSTOM) onCustom(q); else onSelect(value) }
  const focusSearch = () => searchInput.current?.focus({ preventScroll: true })
  const toggleStar = (entry: ModelEntry, favorite: boolean) => {
    const { provider_id, bare_id } = entry
    if (!provider_id || !bare_id) return
    // The open tab stays put, even when this empties Favorites.
    setPicked(view)
    star.mutate({ id: entry.id, provider_id, bare_id, favorite })
  }

  return (
    <div data-model-picker-content className="flex max-h-[min(346px,var(--available-height,100vh))] w-[min(360px,calc(100vw-2rem))] max-w-(--available-width) flex-row overflow-hidden" style={{ minHeight: `min(${String(Math.min(tallest + CHROME, MAX_HEIGHT))}px, var(--available-height, 100vh))` }}>
      {!searching && <ProviderRail groups={groups} view={view} onPick={(key) => { setPicked(key); requestAnimationFrame(focusSearch) }} onFocusSearch={focusSearch} />}
      <Combobox.Root inline open items={options} filteredItems={options} filter={null} autoHighlight virtualized value={selectedId || null}
        onValueChange={(value) => { if (typeof value === 'string') choose(value) }}
        onItemHighlighted={(value, details) => { if (details.reason === 'keyboard' && typeof value === 'string') list.current?.reveal(value) }}>
        <div className={cn('flex min-w-0 flex-1 flex-col overflow-hidden', !searching && 'border-s border-border')}>
          <div className="shrink-0 px-2 pt-2">
            <div className="relative">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Combobox.Input ref={searchInput} type="search" value={query} placeholder={m.model_search_placeholder()} aria-label={m.model_search_placeholder()}
                className="h-8 w-full rounded-md border border-border bg-input ps-8 pe-2 text-sm text-text placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (!searching && !event.altKey && !event.ctrlKey && !event.metaKey && ((event.key === 'ArrowLeft' && !event.shiftKey) || (event.key === 'Tab' && event.shiftKey))) {
                    const rail = event.currentTarget.closest('[data-model-picker-content]')?.querySelector<HTMLButtonElement>('[data-model-picker-rail] button[aria-pressed="true"]')
                    if (rail) { event.preventDefault(); event.stopPropagation(); rail.focus(); return }
                  }
                  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
                }} />
            </div>
          </div>
          {!searching && group && <div className="shrink-0 px-3 pt-2" data-model-picker-group={groupKey(group)}>
            <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider text-muted"><span className="truncate">{catalogGroupLabel(group)}</span><GroupLimitBadge group={group} locale={locale} /></div>
            <ProviderQuotaPace plan={group.plan_usage} planStale={group.plan_stale} compact />
          </div>}
          {rows.length ? <ModelPickerList key={searching ? 'search' : view} handle={list} rows={rows} estimateSize={(row) => row.kind === 'label' ? LABEL_ROW : mixed ? TWO_LINE_ROW : ONE_LINE_ROW} reveal={selectedId} query={q} render={(row) => row.kind === 'label'
            ? <div role="presentation" className="px-2 pb-1 pt-2 text-xs font-medium text-muted">{row.label}</div>
            : row.kind === 'custom'
              ? <Combobox.Item index={row.option} value={CUSTOM} aria-label={`${m.model_custom_label()}: ${row.id}`} className={ROW}><span className="min-w-0 flex-1 truncate"><span className="font-mono text-xs">{row.id}</span> <span className="text-xs text-muted">{m.model_custom_label()}</span></span></Combobox.Item>
              : <ModelRow entry={row.entry} group={row.group} index={row.option} locale={locale} mixed={mixed} selected={row.entry.id === selectedId} favorite={shown(row.entry)}
                  onStar={toggleStar} />} />
            : <p role="status" className="px-3 py-4 text-center text-sm text-muted">{searching ? m.model_search_no_results() : view === FAVORITES && byId.size ? m.model_favorites_empty() : m.model_none_available()}</p>}
        </div>
      </Combobox.Root>
    </div>
  )
}

const ROW = 'group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text outline-none select-none data-highlighted:bg-hover'

/** A vertical toolbar: Favorites, then one icon per provider group, each named by the server's group label. */
function ProviderRail({ groups, view, onPick, onFocusSearch }: { groups: Group[]; view: string; onPick: (key: string) => void; onFocusSearch: () => void }) {
  const button = 'flex aspect-square w-full items-center justify-center rounded-md text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-(--focus-ring) aria-pressed:bg-accent-bg aria-pressed:text-accent-text'
  return (
    <Toolbar.Root orientation="vertical" aria-label={m.model_picker_providers()} data-model-picker-rail className="w-11 shrink-0 overflow-y-auto overscroll-contain bg-bg/40 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onKeyDown={(event) => { if (event.key === 'ArrowRight' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); onFocusSearch() } }}>
      <div className="flex flex-col gap-1 p-1">
        <RailButton label={m.model_favorites()} pressed={view === FAVORITES} data={FAVORITES} className={button} onClick={() => onPick(FAVORITES)}><Star size={18} className="fill-current" aria-hidden="true" /></RailButton>
        <div className="border-b border-border" aria-hidden="true" />
        {groups.map((group) => {
          const label = catalogGroupLabel(group)
          return <RailButton key={groupKey(group)} label={label} pressed={view === groupKey(group)} data={groupKey(group)} className={button} onClick={() => onPick(groupKey(group))}><ProviderIcon icon={group.icon} className="size-5" /></RailButton>
        })}
      </div>
    </Toolbar.Root>
  )
}

function RailButton({ label, pressed, data, className, onClick, children }: { label: string; pressed: boolean; data: string; className: string; onClick: () => void; children: ReactNode }) {
  return <Tooltip label={label} side="left"><Toolbar.Button type="button" aria-label={label} aria-pressed={pressed} data-model-picker-provider={data} className={className} onClick={onClick}>{children}</Toolbar.Button></Tooltip>
}

/** One model: its name and the server's allowance on one line, its provider under it when providers mix, then star and check. */
const ModelRow = memo(function ModelRow({ entry, group, index, locale, mixed, selected, favorite, onStar }: { entry: ModelEntry; group: Group; index: number; locale: string; mixed: boolean; selected: boolean; favorite: boolean; onStar: (entry: ModelEntry, favorite: boolean) => void }) {
  const resetsAt = entry.limit?.resets_at
  const provider = catalogGroupLabel(group)
  const starrable = !!entry.provider_id && !!entry.bare_id
  const starLabel = favorite ? m.model_favorite_remove() : m.model_favorite_add()
  // The star is the row's one action besides choosing it, so right-click and long-press offer it too.
  return <RowContextMenu label={entry.label ?? entry.id} actions={starrable ? [{ label: starLabel, run: () => onStar(entry, !favorite) }] : []} trigger={
    <Combobox.Item index={index} value={entry.id} data-model-option={entry.id} aria-label={[modelOptionLabel(entry, locale), resetsAt ? m.model_limited_until({ time: resetTime(locale, resetsAt) }) : null, mixed ? provider : null, mixed ? groupLimit(group, locale)?.text : null].filter(Boolean).join(' · ')} className={ROW}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <ModelOptionContent entry={entry} />
          {resetsAt && <span data-model-limit="model" className="ms-auto shrink-0 text-xs text-warning">{m.model_limited_until({ time: resetTime(locale, resetsAt) })}</span>}
        </span>
        {mixed && <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted"><ProviderIcon icon={group.icon} className="size-3" /><span className="truncate">{provider}</span><GroupLimitBadge group={group} locale={locale} /></span>}
      </span>
      {starrable
        ? <button type="button" aria-label={starLabel} title={starLabel} data-model-favorite={favorite ? 'true' : 'false'}
            className={cn('-me-1 flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-(--focus-ring)', favorite ? 'text-accent' : 'text-muted opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100')}
            onClick={(event) => { event.stopPropagation(); onStar(entry, !favorite) }} onKeyDown={(event) => event.stopPropagation()}>
            <Star size={13} className={cn(favorite && 'fill-current')} aria-hidden="true" />
          </button>
        : <span className="-me-1 size-6 shrink-0" aria-hidden="true" />}
      {/* Always reserved, so stars and checks keep fixed columns. */}
      <Check size={14} aria-hidden="true" className={cn('shrink-0', !selected && 'invisible')} />
    </Combobox.Item>} />
})
