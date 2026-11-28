import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowDownToLine, Copy, RefreshCw, Search, X } from 'lucide-react'
import { LogLevelFilterSchema, type LogEntry, type LogLevel } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { LOG_TAILS, type LogsSearch } from '../../contracts/url'
import { HubPage } from '../../shell/AppShell'
import { FilterMenu, FilterRadioItem } from '../../shell/FilterMenu'
import { IconButton } from '../../ui/Button'
import { Switch, TextInput } from '../../ui/Field'
import { MenuGroupLabel, MenuRadioGroup, MenuSeparator, RowContextMenu } from '../../ui/Menu'
import { cn } from '../../ui/cn'
import { copyWithToast } from '../../lib/clipboard'
import { useDebounced } from '../../lib/useDebounced'
import { SettingRow, SettingsStats, SETTINGS_PAGE } from '../settings/SettingsGroup'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'

const DEFAULT_FILE = 'agent'
const DEFAULT_TAIL = 500
const FOLLOW_MS = 15_000
const FILE_LABEL: Record<string, () => string> = { agent: m.logs_file_agent, webui: m.logs_file_webui, gateway: m.logs_file_gateway, bootstrap: m.logs_file_bootstrap }
const LEVEL_TOKEN: Record<LogLevel, () => string> = { error: m.logs_token_error, warning: m.logs_token_warning, info: m.logs_token_info, debug: m.logs_token_debug }
const LEVEL_TEXT: Partial<Record<LogLevel, string>> = { error: 'text-error', warning: 'text-warning' }
const LEVEL_LABEL = { warning: m.logs_severity_warnings, error: m.logs_severity_errors }
const fileLabel = (file: string) => (Object.hasOwn(FILE_LABEL, file) ? FILE_LABEL[file]?.() : undefined) ?? file
const tailLabel = (tail: number) => m.logs_last_lines({ n: tail.toLocaleString() })

/** The element the page scrolls in: the nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p
  return null
}

/** `text` with the server's match offsets wrapped in `<mark>`. */
function highlighted(text: string, matches: LogEntry['matches']): ReactNode {
  if (!matches?.length) return text
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of matches) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start} className="rounded-sm bg-accent text-accent-fg">{text.slice(start, end)}</mark>)
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/** A shown line as plain text: what the row reads, time, level token and text. */
const lineText = (e: LogEntry) => [e.time, e.level ? LEVEL_TOKEN[e.level]() : null, e.text].filter((part) => part !== null && part !== '').join(' ')

/** TAL-2139: one log's tail, classified, counted and filtered by the server; this page renders those fields. */
export function LogsPage() {
  const { file: requestedFile = DEFAULT_FILE, tail = DEFAULT_TAIL, query = '', level }: LogsSearch = useSearch({ strict: false })
  const navigate = useNavigate({ from: '/settings/$section' })
  const setFilters = (patch: Partial<LogsSearch>, replace = false) => navigate({ search: (prev) => ({ ...prev, ...patch }), hash: true, resetScroll: false, replace })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const lastEdit = useRef<string | null>(null)
  const [follow, setFollow] = useState(true)
  const q = query.trim()
  const settledSearch = useDebounced(q, 250)
  const logs = useQuery({
    queryKey: keys.logs(requestedFile, tail, q, level), queryFn: () => api.fetchLogs(requestedFile, tail, q, level),
    enabled: !filtersOpen || settledSearch === q,
    // While a search or filter of the same log loads, the last answer stays; another log starts empty.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === requestedFile ? previous : undefined, staleTime: 5_000, refetchInterval: follow ? FOLLOW_MS : false, refetchOnWindowFocus: follow,
  })
  const data = logs.data
  const file = data?.file ?? DEFAULT_FILE
  const [list, setList] = useState<HTMLOListElement | null>(null)
  // Following keeps the newest line in view, and turning it on goes there; scrolling up stops following.
  // A failed refresh changes the height below the tail even though the log rows stay the same.
  useLayoutEffect(() => {
    const pane = follow ? scrollParent(list) : null
    if (pane) pane.scrollTop = pane.scrollHeight
  }, [data, follow, list, logs.isRefetchError])
  useEffect(() => {
    const pane = scrollParent(list)
    if (!pane) return
    let last = pane.scrollTop
    const onScroll = () => {
      if (pane.scrollTop < last && pane.scrollHeight - pane.clientHeight - pane.scrollTop > 4) setFollow(false)
      last = pane.scrollTop
    }
    pane.addEventListener('scroll', onScroll, { passive: true })
    return () => pane.removeEventListener('scroll', onScroll)
  }, [list])
  const refresh = () => { void logs.refetch() }
  const onFollow = (on: boolean) => {
    setFollow(on)
    if (on) refresh()
  }

  const entries = data?.entries ?? []
  const shown = entries.map(lineText)
  const files = data?.files ?? []
  const missing = files.find((f) => f.id === file)?.exists === false || (data?.lines.length === 0 && Boolean(data.hint))
  const read = logs.dataUpdatedAt ? new Date(logs.dataUpdatedAt).toLocaleTimeString() : ''
  const n = data?.counts?.lines
  const filtered = Boolean(q) || level !== undefined
  const activeFilters = [
    ...(file !== DEFAULT_FILE ? [{ key: 'file', label: fileLabel(file) }] as const : []),
    ...(level ? [{ key: 'level', label: LEVEL_LABEL[level]() }] as const : []),
    ...(q ? [{ key: 'query', label: q }] as const : []),
    ...(tail !== DEFAULT_TAIL ? [{ key: 'tail', label: tailLabel(tail) }] as const : []),
  ]

  return (
    <HubPage title={m.tab_logs()} actions={<>
      <FilterMenu label={m.logs_filters()} filtered={activeFilters.length > 0} search={searchInput} onOpenChange={(open) => {
        lastEdit.current = null
        setFiltersOpen(open)
      }} header={<div className="relative w-56 max-w-full px-1 pt-1 pb-2">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute start-4 top-4 text-muted" />
        <TextInput ref={searchInput} type="search" value={query} retainDraft placeholder={m.logs_search()} aria-label={m.logs_search()} autoComplete="off" className="ps-8" onChange={(event) => {
          const value = event.target.value
          // One Back step returns to the query before this edit, even after typing several characters.
          const replace = lastEdit.current === query
          lastEdit.current = value
          return setFilters({ query: value || undefined }, replace)
        }} />
      </div>}>
        {files.length > 0 && <>
          <MenuRadioGroup value={file} onValueChange={(value: string) => { void setFilters({ file: value === DEFAULT_FILE ? undefined : value }) }}>
            <MenuGroupLabel>{m.logs_file_label()}</MenuGroupLabel>
            {files.map(({ id }) => <FilterRadioItem key={id} value={id}>{fileLabel(id)}</FilterRadioItem>)}
          </MenuRadioGroup>
          <MenuSeparator />
        </>}
        <MenuRadioGroup value={level ?? ''} onValueChange={(value: string) => { void setFilters({ level: LogLevelFilterSchema.safeParse(value).data }) }}>
          <MenuGroupLabel>{m.logs_severity()}</MenuGroupLabel>
          <FilterRadioItem value="">{m.logs_severity_all()}</FilterRadioItem>
          <FilterRadioItem value="warning">{m.logs_severity_warnings()}</FilterRadioItem>
          <FilterRadioItem value="error">{m.logs_severity_errors()}</FilterRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup value={String(tail)} onValueChange={(value: string) => { void setFilters({ tail: LOG_TAILS.find((n) => n !== DEFAULT_TAIL && String(n) === value) }) }}>
          <MenuGroupLabel>{m.logs_tail_label()}</MenuGroupLabel>
          {LOG_TAILS.map((n) => <FilterRadioItem key={n} value={String(n)}>{tailLabel(n)}</FilterRadioItem>)}
        </MenuRadioGroup>
      </FilterMenu>
      <IconButton variant="ghost" label={m.copy()} disabled={shown.length === 0} onClick={() => { copyWithToast(shown.join('\n')) }}><Copy size={16} aria-hidden="true" /></IconButton>
    </>}>
      <div className={SETTINGS_PAGE}>
        {activeFilters.length > 0 && <ul aria-label={m.logs_filters()} className="flex flex-wrap gap-2">
          {activeFilters.map(({ key, label }) => {
            const clear = { label: m.logs_clear_filter({ value: label }), run: () => { void setFilters({ [key]: undefined }) }, icon: X }
            return <RowContextMenu key={key} label={label} actions={[clear]} trigger={<li className="flex min-w-0 max-w-full items-center rounded-md border border-border ps-2.5 text-xs text-text">
              <span className="max-w-48 truncate" title={label}>{label}</span>
              <IconButton variant="ghost" label={clear.label} className="size-6 [&_svg]:size-3" onClick={clear.run}><X aria-hidden="true" /></IconButton>
            </li>} />
          })}
        </ul>}
        {logs.isPending && <LoadingState compact />}
        {logs.isLoadingError && <ErrorState error={logs.error} onRetry={refresh} />}
        {data && missing && <EmptyState compact>{data.hint || m.logs_empty()}</EmptyState>}
        {data && !missing && (
          <>
            {data.counts && (
              <SettingsStats label={m.logs_title()} stats={[
                { id: 'errors', label: m.logs_severity_errors(), value: data.counts.error.toLocaleString(), tone: data.count_tones?.error ?? undefined },
                { id: 'warnings', label: m.logs_warnings(), value: data.counts.warning.toLocaleString(), tone: data.count_tones?.warning ?? undefined },
                { id: 'lines', label: m.logs_tail_label(), value: data.counts.lines.toLocaleString() },
                { id: 'updated', label: m.logs_updated(), value: read },
              ]} />
            )}
            <div className="flex flex-col gap-3">
              <div className="border-b border-border-subtle">
                <SettingRow label={m.logs_follow()} htmlFor="logs-follow" icon={ArrowDownToLine}><Switch id="logs-follow" checked={follow} onCheckedChange={onFollow} /></SettingRow>
              </div>
              {/* The log scrolls sideways at wide widths; at phone width its lines wrap and a dated time puts its date over its time.
                  `overflow-y-hidden` keeps the browser from computing `overflow-x-auto` as a vertical scroller, which Follow would take for the page's. */}
              <div className="overflow-x-auto overflow-y-hidden max-[641px]:overflow-visible">
                <ol ref={setList} aria-label={fileLabel(file)} data-log-lines=""
                  className="grid w-max min-w-full grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 font-mono text-xs leading-relaxed text-pre-text max-[641px]:w-full max-[641px]:grid-cols-[min-content_auto_minmax(0,1fr)]">
                  {entries.map((e, i) => (
                    <li key={i} data-level={e.level ?? undefined} className={cn('col-span-full grid grid-cols-subgrid', e.level && LEVEL_TEXT[e.level])}>
                      <span className="text-muted">{e.time}</span>
                      <span>{e.level ? LEVEL_TOKEN[e.level]() : ''}</span>
                      <span className="whitespace-pre max-[641px]:whitespace-pre-wrap max-[641px]:break-words">{highlighted(e.text, e.matches)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <p role="status" className="text-xs text-muted" data-log-footer="">
                {n !== undefined && (filtered && data.matched !== undefined ? m.logs_matching_lines({ matched: data.matched.toLocaleString(), n: n.toLocaleString() }) : m.logs_last_lines({ n: n.toLocaleString() }))}
              </p>
            </div>
          </>
        )}
        {logs.isRefetchError && (
          <ErrorState>
            <div className="flex items-center justify-between gap-2">
              <span>{m.logs_refresh_failed()}</span>
              <IconButton variant="default" label={m.retry()} onClick={refresh} disabled={logs.isFetching}><RefreshCw aria-hidden="true" /></IconButton>
            </div>
          </ErrorState>
        )}
      </div>
    </HubPage>
  )
}
