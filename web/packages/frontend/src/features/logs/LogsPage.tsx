import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, Copy, Search } from 'lucide-react'
import type { LogEntry, LogLevel, LogLevelFilter } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { IconButton } from '../../ui/Button'
import { Switch } from '../../ui/Field'
import { Segmented } from '../../ui/Segmented'
import { TabStrip } from '../../ui/TabStrip'
import { cn } from '../../ui/cn'
import { copyWithToast } from '../../lib/clipboard'
import { useDebounced } from '../../lib/useDebounced'
import { SettingRow, SettingsStats, SETTINGS_PAGE } from '../settings/SettingsGroup'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'

/** "Load earlier" steps through these; the server reads at most the last of them. */
const TAILS = [200, 500, 1000, 2000] as const
const DEFAULT_TAIL = 500
const FOLLOW_MS = 15_000
const FILE_LABEL: Record<string, () => string> = { agent: m.logs_file_agent, webui: m.logs_file_webui, gateway: m.logs_file_gateway, bootstrap: m.logs_file_bootstrap }
const LEVEL_TOKEN: Record<LogLevel, () => string> = { error: m.logs_token_error, warning: m.logs_token_warning, info: m.logs_token_info, debug: m.logs_token_debug }
const LEVEL_TEXT: Partial<Record<LogLevel, string>> = { error: 'text-error', warning: 'text-warning' }
type LevelChoice = 'all' | LogLevelFilter

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
  const [file, setFile] = useState('agent')
  const [tail, setTail] = useState<number>(DEFAULT_TAIL)
  const [search, setSearch] = useState('')
  const q = useDebounced(search.trim(), 250)
  const [level, setLevel] = useState<LevelChoice>('all')
  const [follow, setFollow] = useState(true)
  const filter = level === 'all' ? undefined : level
  const logs = useQuery({
    queryKey: keys.logs(file, tail, q, filter), queryFn: () => api.fetchLogs(file, tail, q, filter),
    // While a search or filter of the same log loads, the last answer stays; another log starts empty.
    placeholderData: (previous, query) => query?.queryKey[1] === file ? previous : undefined, staleTime: 5_000, refetchInterval: follow ? FOLLOW_MS : false, refetchOnWindowFocus: follow,
  })
  const data = logs.data
  const [list, setList] = useState<HTMLOListElement | null>(null)
  // Following keeps the newest line in view, and turning it on goes there; scrolling up stops following.
  useLayoutEffect(() => {
    const pane = follow ? scrollParent(list) : null
    if (pane) pane.scrollTop = pane.scrollHeight
  }, [data, follow, list])
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
  const onFollow = (on: boolean) => {
    setFollow(on)
    if (on) void logs.refetch()
  }

  const entries = data?.entries
  const shown = entries ? entries.map(lineText) : data?.lines ?? []
  const files = data?.files ?? []
  const missing = files.find((f) => f.id === file)?.exists === false || (data?.lines.length === 0 && Boolean(data.hint))
  const read = logs.dataUpdatedAt ? new Date(logs.dataUpdatedAt).toLocaleTimeString() : ''
  const n = data?.counts?.lines
  const filtered = Boolean(q) || filter !== undefined
  const nextTail = TAILS.find((t) => t > tail)

  return (
    <HubPage title={m.tab_logs()} actions={<IconButton variant="ghost" label={m.copy()} disabled={shown.length === 0} onClick={() => { copyWithToast(shown.join('\n')) }}><Copy size={16} aria-hidden="true" /></IconButton>}>
      <div className={SETTINGS_PAGE}>
        {files.length > 0 && <TabStrip label={m.logs_file_label()} tabs={files.map((f) => ({ id: f.id, label: FILE_LABEL[f.id] ?? (() => f.id) }))} value={file} onChange={(id) => { setFile(id); setFollow(true) }} panelPrefix="logs" />}
        <div role={files.length > 0 ? 'tabpanel' : undefined} id={`logs-${file}`} className={SETTINGS_PAGE}>
          {logs.isPending && <LoadingState compact />}
          {logs.isError && !data && <ErrorState error={logs.error} onRetry={() => { void logs.refetch() }} />}
          {data && missing && <EmptyState compact>{data.hint || m.logs_empty()}</EmptyState>}
          {data && !missing && (
            <>
              {data.counts && (
                <SettingsStats label={m.logs_title()} stats={[
                  { id: 'errors', label: m.logs_severity_errors(), value: data.counts.error.toLocaleString(), tone: data.counts.error > 0 ? 'error' : undefined },
                  { id: 'warnings', label: m.logs_warnings(), value: data.counts.warning.toLocaleString(), tone: data.counts.warning > 0 ? 'warning' : undefined },
                  { id: 'lines', label: m.logs_tail_label(), value: data.counts.lines.toLocaleString() },
                  { id: 'updated', label: m.logs_updated(), value: read },
                ]} />
              )}
              {entries && (
                <div className="flex items-center gap-2">
                  <div className="sidebar-search hub-search min-w-0 flex-1">
                    <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
                    <input id="logs-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={m.logs_search()} aria-label={m.logs_search()} autoComplete="off" />
                  </div>
                  <Segmented id="logs-level" label={m.logs_severity()} value={level} onChange={(v) => setLevel(v as LevelChoice)}
                    options={[{ value: 'all', label: m.logs_severity_all() }, { value: 'warning', label: m.logs_warnings() }, { value: 'error', label: m.logs_severity_errors() }]} />
                </div>
              )}
              <div className="flex flex-col gap-3">
                <div className="border-b border-border-subtle">
                  <SettingRow label={m.logs_follow()} htmlFor="logs-follow" icon={ArrowDownToLine}><Switch id="logs-follow" checked={follow} onCheckedChange={onFollow} /></SettingRow>
                </div>
                {/* The log scrolls sideways at wide widths; at phone width its lines wrap and a dated time puts its date over its time. */}
                <div className="overflow-x-auto max-[641px]:overflow-x-visible">
                  <ol ref={setList} aria-label={FILE_LABEL[file]?.() ?? file} data-log-lines=""
                    className="grid w-max min-w-full grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 font-mono text-xs leading-relaxed text-pre-text max-[641px]:w-full max-[641px]:grid-cols-[min-content_auto_minmax(0,1fr)]">
                    {entries
                      ? entries.map((e, i) => (
                        <li key={i} data-level={e.level ?? undefined} className={cn('col-span-full grid grid-cols-subgrid', e.level && LEVEL_TEXT[e.level])}>
                          <span className="text-muted">{e.time}</span>
                          <span>{e.level ? LEVEL_TOKEN[e.level]() : ''}</span>
                          <span className="whitespace-pre max-[641px]:whitespace-pre-wrap max-[641px]:break-words">{highlighted(e.text, e.matches)}</span>
                        </li>
                      ))
                      : data.lines.map((line, i) => <li key={i} className="col-span-full whitespace-pre max-[641px]:whitespace-pre-wrap max-[641px]:break-words">{line}</li>)}
                  </ol>
                </div>
                <p role="status" className="text-xs text-muted" data-log-footer="">
                  {n !== undefined && (filtered && data.matched !== undefined ? m.logs_matching_lines({ matched: data.matched.toLocaleString(), n: n.toLocaleString() }) : m.logs_last_lines({ n: n.toLocaleString() }))}
                  {nextTail !== undefined && <>{n !== undefined && ' · '}<button type="button" className="linklike underline" onClick={() => setTail(nextTail)}>{m.logs_load_earlier()}</button></>}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </HubPage>
  )
}
