import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Filter, Plus, Search, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { openSessionListStream } from '../../api/sse'
import type { SessionRow } from '../../contracts'
import { PanelHead, PanelHeadButton } from '../../shell/Sidebar'
import { cn } from '../../ui/cn'
import { useNewChat } from './useNewChat'
import { SessionContextMenu } from './SessionContextMenu'
import { ProjectChip } from './ProjectChip'
import { closeMobileSidebar } from '../../shell/useShellState'
import { useLocale } from '../../i18n/useLocale'

export function useSessionListQuery(params: api.SessionListParams = {}) {
  return useQuery({ queryKey: keys.sessions.list(params as Record<string, string | boolean | number | undefined>), queryFn: () => api.fetchSessions(params), staleTime: 10_000 })
}

/** One EventSource for sidebar invalidation (`sessions_changed`), bounded to the panel's lifetime. */
export function useSessionListStream() {
  const qc = useQueryClient()
  useEffect(() => {
    let closed = false
    let handle = openSessionListStream({
      onEvent: (ev) => {
        if (ev.event === 'sessions_changed' || ev.event === 'initial') void qc.invalidateQueries({ queryKey: keys.sessions.all })
      },
      onError: () => { /* EventSource retries on its own; the poll below covers long outages */ },
    })
    const poll = window.setInterval(() => { if (!closed && document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: keys.sessions.all }) }, 60_000)
    return () => {
      closed = true
      handle.close()
      handle = { close: () => undefined, readyState: () => 2 }
      window.clearInterval(poll)
    }
  }, [qc])
}

export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return m.session_time_unknown()
  const tsMs = ts * 1000
  const diff = Math.max(0, now - tsMs)
  const minute = 60_000
  const hour = 60 * minute
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6)
  const startOfLastWeek = new Date(startOfToday); startOfLastWeek.setDate(startOfLastWeek.getDate() - 13)
  if (tsMs >= startOfToday.getTime()) {
    if (diff < minute) return m.session_time_minutes_ago({ n: 1 })
    if (diff < hour) return m.session_time_minutes_ago({ n: Math.floor(diff / minute) })
    return m.session_time_hours_ago({ n: Math.floor(diff / hour) })
  }
  if (tsMs >= startOfYesterday.getTime()) return m.session_time_days_ago({ n: 1 })
  if (tsMs >= startOfWeek.getTime()) return m.session_time_days_ago({ n: Math.round((startOfToday.getTime() - tsMs) / 86_400_000) + 1 })
  if (tsMs >= startOfLastWeek.getTime()) return m.session_time_last_week()
  const date = new Date(tsMs)
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (date.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric'
  return date.toLocaleDateString(undefined, options)
}

type GroupId = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

function groupLabel(row: SessionRow, now: number): GroupId {
  if (row.pinned) return 'pinned'
  const d = new Date(row.sort_ts * 1000)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  if (d >= today) return 'today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d >= yesterday) return 'yesterday'
  const week = new Date(today)
  week.setDate(today.getDate() - 7)
  if (d >= week) return 'week'
  return 'older'
}

const GROUP_LABEL: Record<GroupId, () => string> = {
  pinned: () => m.session_time_bucket_pinned(),
  today: () => m.session_time_bucket_today(),
  yesterday: () => m.session_time_bucket_yesterday(),
  week: () => m.session_time_bucket_this_week(),
  older: () => m.session_time_bucket_older(),
}

/** Spoken status for a row that needs the user; the server names the kind. */
const attentionLabel = (kind: string | undefined) => kind === 'approval' ? m.session_attention_approval_title() : kind === 'clarify' ? m.session_attention_clarify_title() : m.session_attention_generic_title()

const GROUP_ORDER: GroupId[] = ['pinned', 'today', 'yesterday', 'week', 'older']

/** Files rows under local-date groups by the server's `sort_ts`, keeping the server's order inside each group (TAL-306). */
export function groupSessionRows(rows: SessionRow[], now = Date.now()): { id: GroupId; rows: SessionRow[] }[] {
  const byGroup = new Map<GroupId, SessionRow[]>()
  for (const r of rows) {
    const g = groupLabel(r, now)
    byGroup.set(g, [...(byGroup.get(g) ?? []), r])
  }
  return GROUP_ORDER.flatMap((id) => { const grouped = byGroup.get(id); return grouped ? [{ id, rows: grouped }] : [] })
}

export function useProjectsQuery() {
  return useQuery({ queryKey: keys.projects, queryFn: () => api.fetchProjects(), staleTime: 60_000 })
}

const NO_PROJECT = '__none__'

export function SessionListPanel() {
  useLocale()
  const params: { sessionId?: string } = useParams({ strict: false })
  const activeId = params.sessionId ?? null
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [source, setSource] = useState<'webui' | 'cli'>('webui')
  const [project, setProject] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const list = useSessionListQuery(showArchived ? { include_archived: true } : {})
  const projects = useProjectsQuery()
  useSessionListStream()
  const newChat = useNewChat()
  const data = list.data
  const rows = useMemo(() => (data?.sessions ?? []).filter((r) => showArchived || !r.archived), [data, showArchived])
  const cliCount = useMemo(() => rows.filter((r) => r.is_cli_session).length, [rows])
  // TAL-308: the server searches within the visible project, source tab and archive state; the local title filter covers the wait.
  const q = filter.trim()
  const searchFilters: api.SessionSearchFilters = { project_id: project === NO_PROJECT ? 'none' : (project ?? undefined), sidebar_source: cliCount > 0 ? source : undefined, include_archived: showArchived }
  const search = useQuery({ queryKey: keys.sessions.search(q, searchFilters), queryFn: () => api.searchSessions(q, searchFilters), enabled: q.length >= 2, staleTime: 15_000 })
  const webuiCount = rows.length - cliCount
  const hasUnprojected = useMemo(() => rows.some((r) => !r.project_id), [rows])
  const projectList = projects.data?.projects ?? []
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let visible = rows
    if (cliCount > 0) visible = visible.filter((r) => (source === 'cli' ? !!r.is_cli_session : !r.is_cli_session))
    if (project === NO_PROJECT) visible = visible.filter((r) => !r.project_id)
    else if (project) visible = visible.filter((r) => r.project_id === project)
    if (!q) return visible
    if (search.data) return search.data.sessions
    return visible.filter((r) => r.title.toLowerCase().includes(q))
  }, [rows, filter, cliCount, source, project, search.data])
  const previews = useMemo(() => new Map((search.data?.sessions ?? []).flatMap((r) => (r.match_preview ? [[r.session_id, r.match_preview] as const] : []))), [search.data])
  const groups = useMemo(() => groupSessionRows(filtered).map((g) => ({ ...g, label: GROUP_LABEL[g.id]() })), [filtered])
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.archiveSession(id, archived),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.sessions.all }) },
  })
  const createProject = useMutation({
    mutationFn: (name: string) => api.createProject(name),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.projects }) },
  })

  return (
    <div className={cn('panel-view active', searchOpen && 'search-open')} id="panelChat">
      <PanelHead
        title={m.tab_chat()}
        actions={
          <>
            <PanelHeadButton label={m.filter_conversations()} active={searchOpen} onClick={() => { setSearchOpen((o) => !o); if (searchOpen) setFilter('') }}>
              <Filter size={16} aria-hidden="true" />
            </PanelHeadButton>
            <PanelHeadButton label={showArchived ? m.session_hide_archived() : m.session_show_archived()} active={showArchived} onClick={() => setShowArchived((a) => !a)}>
              {showArchived ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
            </PanelHeadButton>
            <PanelHeadButton label={m.new_conversation()} id="btnNewChat" tooltipSide="bottom-right" onClick={() => { void newChat() }}>
              <Plus size={16} aria-hidden="true" />
            </PanelHeadButton>
          </>
        }
      />
      <div className="session-search sidebar-search">
        <div className="session-search-field">
          <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
          <input id="sessionSearch" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={m.filter_conversations()} aria-label={m.filter_conversations()} autoComplete="off" data-1p-ignore data-lpignore="true" onKeyDown={(e) => { if (e.key === 'Escape') { setFilter(''); setSearchOpen(false) } }} />
          {filter && (
            <button type="button" className="sidebar-search-clear" aria-label={m.clear_conversation_filter()} onClick={() => setFilter('')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="session-list" id="sessionList" role="list">
        {cliCount > 0 && (
          <div className="session-source-tabs">
            <button type="button" className={cn('session-source-tab', source === 'webui' && 'active')} aria-pressed={source === 'webui'} onClick={() => setSource('webui')}>{m.sessions_source_webui({ n: webuiCount })}</button>
            <button type="button" className={cn('session-source-tab', source === 'cli' && 'active')} aria-pressed={source === 'cli'} onClick={() => setSource('cli')}>{m.sessions_source_cli({ n: cliCount })}</button>
          </div>
        )}
        {(projectList.length > 0 || hasUnprojected) && (
          <div className="project-bar" role="group" aria-label={m.project_filter_label()}>
            <span role="button" tabIndex={0} className={cn('project-chip', !project && 'active')} onClick={() => setProject(null)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setProject(null) }}>{m.project_all()}</span>
            {hasUnprojected && <span role="button" tabIndex={0} className={cn('project-chip no-project', project === NO_PROJECT && 'active')} title={m.project_unassigned_hint()} onClick={() => setProject(NO_PROJECT)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setProject(NO_PROJECT) }}>{m.project_unassigned()}</span>}
            {projectList.map((p) => <ProjectChip key={p.project_id} project={p} active={project === p.project_id} onSelect={() => setProject(p.project_id)} onDeleted={() => setProject((cur) => (cur === p.project_id ? null : cur))} />)}
            <span role="button" tabIndex={0} className="project-chip project-chip-add" title={m.project_new()} aria-label={m.project_new()} onClick={() => { const name = window.prompt(m.project_new_prompt()); if (name?.trim()) createProject.mutate(name.trim()) }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { const name = window.prompt(m.project_new_prompt()); if (name?.trim()) createProject.mutate(name.trim()) } }}>+</span>
          </div>
        )}
        {list.isPending && <div className="session-list-note" role="status">{m.loading()}</div>}
        {list.isError && (
          <div className="session-list-note session-list-error" role="alert">
            {m.error_generic()} <button type="button" className="linklike" onClick={() => { void list.refetch() }}>{m.retry()}</button>
          </div>
        )}
        {list.isSuccess && filtered.length === 0 && !(q.length >= 2 && search.isPending) && <div className="session-list-note">{filter ? m.no_matching_sessions() : m.no_sessions_yet()}</div>}
        {groups.map((g) => {
          const isCollapsed = !!collapsedGroups[g.id]
          return (
            <div key={g.id} className="session-date-group">
              <div className={cn('session-date-header', g.id === 'pinned' && 'pinned')} role="button" tabIndex={0} aria-expanded={!isCollapsed} onClick={() => setCollapsedGroups((c) => ({ ...c, [g.id]: !c[g.id] }))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsedGroups((c) => ({ ...c, [g.id]: !c[g.id] })) } }}>
                <span className={cn('session-date-caret', isCollapsed && 'collapsed')} aria-hidden="true">{'\u25BE'}</span>
                <span>{g.label}</span>
              </div>
              <div className="session-date-body" style={isCollapsed ? { display: 'none' } : undefined}>
                {g.rows.map((row) => {
                  const active = row.session_id === activeId
                  const proj = row.project_id ? projectList.find((p) => p.project_id === row.project_id) : undefined
                  return (
                    <Link
                      key={row.session_id}
                      to="/session/$sessionId"
                      params={{ sessionId: row.session_id }}
                      onClick={closeMobileSidebar}
                      role="listitem"
                      data-sid={row.session_id}
                      data-source={row.is_cli_session ? (row.source_label ?? 'CLI') : undefined}
                      aria-current={active ? 'page' : undefined}
                      className={cn('session-item', active && 'active', row.is_streaming && 'streaming', row.is_cli_session && 'cli-session', row.attention && 'needs-attention', row.archived && 'archived')}
                    >
                      <div className="session-text">
                        <div className="session-title-row">
                          <span className="session-title" title={row.title || m.untitled()}>{row.title || m.untitled()}</span>
                          {proj && <span className="session-project-dot" style={{ background: proj.color ?? 'var(--blue)' }} title={proj.name} />}
                          <span className="session-time">{relativeTime(row.sort_ts)}</span>
                        </div>
                        {previews.get(row.session_id) && <div className="session-search-preview truncate text-[11px] text-muted" title={m.session_search_content_matches()}>{previews.get(row.session_id)}</div>}
                      </div>
                      {/* The rail shows status by color; this says it in words (TAL-365). */}
                      {row.is_streaming ? <span className="sr-only">{m.status_streaming()}</span> : row.attention && <span className="sr-only">{attentionLabel(row.attention.kind)}</span>}
                      <div className="session-actions">
                        <button type="button" className="session-archive-toggle" title={row.archived ? m.session_restore() : m.session_batch_archive()} aria-label={row.archived ? m.session_restore() : m.session_batch_archive()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); archive.mutate({ id: row.session_id, archived: !row.archived }) }}>
                          {row.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                        </button>
                        <SessionContextMenu row={row} active={active} />
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
