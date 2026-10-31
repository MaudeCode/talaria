import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Filter, GitBranch, Plus, Search, Upload, Users, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import type { SessionRow } from '../../contracts'
import { PanelHead, PanelHeadButton } from '../../shell/Sidebar'
import { cn } from '../../ui/cn'
import { useDebounced } from '../../lib/useDebounced'
import { HelpTip } from '../../ui/Field'
import { useNewChat } from './useNewChat'
import { SessionContextMenu } from './SessionContextMenu'
import { ProjectChip } from './ProjectChip'
import { closeMobileSidebar } from '../../shell/useShellState'
import { inTextField } from '../../shell/useShortcuts'
import { useLocale } from '../../i18n/useLocale'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { useResourceEffects, useResourceMutation, withEffects } from './useResourceMutation'
import { useSessionPin } from './useSessionPin'
import { getStreamContext, useStreamContext } from '../../stream/connection'
import { randomHex } from '../../lib/randomHex'

const SESSION_DRAG_TYPE = 'application/x-talaria-session-pin'

export function useSessionListQuery(params: api.SessionListParams = {}) {
  return useQuery({ queryKey: keys.sessions.list(params as Record<string, string | boolean | number | undefined>), queryFn: ({ signal }) => api.fetchSessions(params, signal), staleTime: 10_000 })
}

export { useSessionListStream } from './useSessionListStream'

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

/** Files rows under the server's Pinned group (TAL-1534), the rest under local-date groups by the server's `sort_ts`, keeping the server's order inside each group (TAL-306). */
export function groupSessionRows(rows: SessionRow[], now = Date.now()): { id: GroupId; rows: SessionRow[] }[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const week = new Date(today); week.setDate(today.getDate() - 7)
  const todayMs = today.getTime(), yesterdayMs = yesterday.getTime(), weekMs = week.getTime()
  const byGroup = new Map<GroupId, SessionRow[]>()
  for (const r of rows) {
    const ts = r.sort_ts * 1000
    const g: GroupId = r.sidebar_group === 'pinned' ? 'pinned' : ts >= todayMs ? 'today' : ts >= yesterdayMs ? 'yesterday' : ts >= weekMs ? 'week' : 'older'
    const grouped = byGroup.get(g)
    if (grouped) grouped.push(r)
    else byGroup.set(g, [r])
  }
  return GROUP_ORDER.flatMap((id) => { const grouped = byGroup.get(id); return grouped ? [{ id, rows: grouped }] : [] })
}

/** The existing sidebar row, memoized so unchanged server rows retain their rendered subtree. */
export const SessionListItem = memo(function SessionListItem({ row, active, proj, preview, timeLabel, onArchive, selection, onDragStart, onDragEnd }: {
  row: SessionRow
  active: boolean
  proj: Awaited<ReturnType<typeof api.fetchProjects>>['projects'][number] | undefined
  preview: string | undefined
  timeLabel: string
  onArchive: (id: string, archived: boolean) => void
  selection?: { selected: boolean; disabled: boolean; onSelect: () => void }
  onDragStart?: (event: DragEvent<HTMLAnchorElement>, row: SessionRow) => void
  onDragEnd?: () => void
}) {
  useLocale()
  const id = useId()
  const displayTitle = row.title || m.untitled()
  const content = (<>
      <div className="session-text" id={`${id}-text`}>
        <div className="session-title-row">
          <span className="session-title" title={displayTitle}>{displayTitle}</span>
          {row.worktree_branch && <span className="session-worktree-badge" role="img" aria-label={`${m.session_worktree_badge()}: ${row.worktree_branch}`} title={`${m.session_worktree_badge()}: ${row.worktree_branch}`}><GitBranch size={12} aria-hidden="true" /></span>}
          {proj && <span className="session-project-dot" style={{ background: proj.color ?? 'var(--blue)' }} title={proj.name} />}
          <span className="session-time">{timeLabel}</span>
        </div>
        {preview && <div className="session-search-preview truncate text-[11px] text-muted" title={m.session_search_content_matches()}>{preview}</div>}
      </div>
  </>)
  if (selection) return <button type="button" role="checkbox" aria-checked={selection.selected} disabled={selection.disabled} onClick={selection.onSelect} className={cn('session-item min-h-11 w-full text-left', selection.selected && 'active')} data-sid={row.session_id}>
    {content}<span aria-hidden="true">{selection.selected ? '✓' : ''}</span>
  </button>
  // TAL-1120: the wrapper is the list item, so the anchor keeps its link role; its name skips the nested action buttons.
  return (
    <div role="listitem">
      <Link
        to="/session/$sessionId"
        params={{ sessionId: row.session_id }}
        onClick={closeMobileSidebar}
        draggable={!!onDragStart && row.can_pin && !row.read_only}
        onDragStart={(event) => { if (onDragStart) onDragStart(event, row); else event.preventDefault() }}
        onDragEnd={onDragEnd}
        aria-labelledby={`${id}-text ${id}-status`}
        data-sid={row.session_id}
        data-source={row.is_cli_session ? (row.source_label ?? 'CLI') : undefined}
        aria-current={active ? 'page' : undefined}
        className={cn('session-item', active && 'active', row.is_streaming && 'streaming', row.is_cli_session && 'cli-session', row.attention && 'needs-attention', row.archived && 'archived')}
      >
        {content}
        {/* The rail shows status by color; this says it in words (TAL-365). */}
        <span className="sr-only" id={`${id}-status`}>{row.is_streaming ? m.status_streaming() : row.attention ? attentionLabel(row.attention.kind) : null}</span>
        <div className="session-actions">
          {row.can_archive && <button type="button" className="session-archive-toggle" title={row.archived ? m.session_restore() : m.session_batch_archive()} aria-label={row.archived ? m.session_restore() : m.session_batch_archive()} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onArchive(row.session_id, !row.archived) }}>
            {row.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
          </button>}
          <SessionContextMenu row={row} active={active} />
        </div>
      </Link>
    </div>
  )
})

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
  const listParams = showArchived ? { include_archived: true } : {}
  const list = useSessionListQuery(listParams)
  const projects = useProjectsQuery()
  const newChat = useNewChat()
  const data = list.data
  const effects = useResourceEffects()
  const rows = withEffects(data?.sessions ?? [], (r) => `session:${r.session_id}`, effects).filter((r) => showArchived || !r.archived)
  const cliCount = rows.filter((r) => r.is_cli_session).length
  // TAL-308: the server searches within the visible project, source tab and archive state; the local title filter covers the wait.
  const q = useDebounced(filter.trim(), 200)
  const [retainSearchMatches, setRetainSearchMatches] = useState(false)
  const searchFilters: api.SessionSearchFilters = { project_id: project === NO_PROJECT ? 'none' : (project ?? undefined), sidebar_source: cliCount > 0 ? source : undefined, include_archived: showArchived }
  const search = useQuery({ queryKey: keys.sessions.search(q, searchFilters), queryFn: ({ signal }) => api.searchSessions(q, searchFilters, 5, signal), enabled: q.length >= 2, staleTime: 15_000,
    // Retain matches only within the same source, project and archive scope.
    placeholderData: (previous, query) => {
      const before = query?.queryKey[3] as api.SessionSearchFilters | undefined
      return retainSearchMatches && before?.project_id === searchFilters.project_id && before?.sidebar_source === searchFilters.sidebar_source && before?.include_archived === searchFilters.include_archived ? keepPreviousData(previous) : undefined
    },
  })
  // Disabled short-term queries never replace Query's previous data. Re-arm only after a real search result.
  if (q.length < 2 && retainSearchMatches) setRetainSearchMatches(false)
  else if (q.length >= 2 && search.data && !search.isPlaceholderData && !retainSearchMatches) setRetainSearchMatches(true)
  const webuiCount = rows.length - cliCount
  // TAL-785: the server says when state.db could not serve the Agent sessions; an empty list alone would read as deleted history.
  const storage = data?.agent_storage
  const storageNotice = storage?.state === 'corrupt' ? m.agent_storage_corrupt() : storage?.state === 'unavailable' ? m.agent_storage_unavailable() : storage?.state === 'outdated' ? m.agent_storage_outdated() : null
  const hasUnprojected = rows.some((r) => !r.project_id)
  const projectList = withEffects(projects.data?.projects ?? [], (p) => `project:${p.project_id}`, effects)
  const projectsById = new Map(projectList.map((p) => [p.project_id, p]))
  const newName = effects['project:new']?.fields?.name
  // The provisional chip gives way as soon as the server's list carries the created project.
  const newProject = typeof newName === 'string' && !projectList.some((p) => p.name === newName) ? newName : null
  const filtered = (() => {
    const term = q.toLowerCase()
    let visible = rows
    if (cliCount > 0) visible = visible.filter((r) => (source === 'cli' ? !!r.is_cli_session : !r.is_cli_session))
    if (project === NO_PROJECT) visible = visible.filter((r) => !r.project_id)
    else if (project) visible = visible.filter((r) => r.project_id === project)
    if (!term) return visible
    if (q.length >= 2 && search.data) return withEffects(search.data.sessions, (r) => `session:${r.session_id}`, effects).filter((r) => showArchived || !r.archived)
    return visible.filter((r) => r.title.toLowerCase().includes(term))
  })()
  const previews = new Map((q.length >= 2 ? search.data?.sessions ?? [] : []).flatMap((r) => (r.match_preview ? [[r.session_id, r.match_preview] as const] : [])))
  const groups = groupSessionRows(filtered).map((g) => ({ ...g, label: GROUP_LABEL[g.id]() }))
  const context = useStreamContext()
  const pin = useSessionPin()
  const scope = JSON.stringify([filter, project, source, showArchived])
  const [drag, setDrag] = useState<{ id: string; token: string; context: object; scope: string; list: typeof data; search: typeof search.data } | null>(null)
  const [dropTarget, setDropTarget] = useState<boolean | null>(null)
  const dragFocus = useRef<{ id: string; element: HTMLElement; context: object } | null>(null)
  // Group moves remount rows; retain existing focus through the optimistic move and rollback.
  useLayoutEffect(() => {
    const focus = dragFocus.current
    if (!focus) return
    if (focus.context !== context || (document.activeElement !== focus.element && (focus.element.isConnected || document.activeElement !== document.body))) { dragFocus.current = null; return }
    const item = [...document.querySelectorAll<HTMLElement>('#sessionList [data-sid]')].find((item) => item.dataset.sid === focus.id)
    const body = item?.closest<HTMLElement>('.session-date-body')
    const next = body?.style.display === 'none' ? body.parentElement?.querySelector<HTMLElement>('.session-date-header') : item
    if (next) { next.focus({ preventScroll: true }); dragFocus.current = { ...focus, element: next } }
    else dragFocus.current = null
  })
  const mutableRow = (id: string) => filtered.find((row) => row.session_id === id && row.can_pin && !row.read_only
    && data?.sessions.some((r) => r.session_id === id && r.can_pin && !r.read_only && (!r.profile || r.profile === data.active_profile)))
  const dragRow = drag?.context === context && drag.scope === scope && drag.list === data && drag.search === search.data
    ? mutableRow(drag.id)
    : undefined
  // A replacement snapshot or context retires this gesture, even if the same ID returns later.
  if (drag && !dragRow) { setDrag(null); setDropTarget(null) }
  const endDrag = () => { setDrag(null); setDropTarget(null) }
  const startDrag = (event: DragEvent<HTMLAnchorElement>, row: SessionRow) => {
    if (!mutableRow(row.session_id) || list.isError || search.isPlaceholderData || (event.target as Element).closest('button')) { event.preventDefault(); return }
    const token = randomHex()
    event.dataTransfer.clearData()
    event.dataTransfer.setData(SESSION_DRAG_TYPE, token)
    event.dataTransfer.effectAllowed = 'move'
    setDrag({ id: row.session_id, token, context, scope, list: data, search: search.data })
  }
  const acceptsDrop = (event: DragEvent, pinned: boolean) => !!dragRow && !!drag
    && !list.isError && !search.isPlaceholderData && drag.context === getStreamContext()
    && qc.getQueryData(keys.sessions.list(listParams)) === drag.list
    && (q.length < 2 || qc.getQueryData(keys.sessions.search(q, searchFilters)) === drag.search)
    && event.dataTransfer.types.length === 1 && event.dataTransfer.types.includes(SESSION_DRAG_TYPE)
    && (dragRow.sidebar_group === 'pinned') !== pinned
  const dropHandlers = (pinned: boolean) => ({
    onDragOver: (event: DragEvent) => {
      if (!acceptsDrop(event, pinned)) return
      event.preventDefault(); event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget(pinned)
    },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) },
    onDrop: (event: DragEvent) => {
      event.preventDefault(); event.stopPropagation()
      if (event.dataTransfer.getData(SESSION_DRAG_TYPE) === drag?.token && acceptsDrop(event, pinned)) {
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.closest('[data-sid]')?.getAttribute('data-sid') === drag.id) dragFocus.current = { id: drag.id, element: focused, context }
        pin.mutate({ id: drag.id, pinned })
      }
      endDrag()
    },
  })
  // Empty targets exist only during an internal gesture; ordinary visits keep the existing groups.
  if (dragRow && !groups.some((g) => g.id === 'pinned')) groups.unshift({ id: 'pinned', label: GROUP_LABEL.pinned(), rows: [] })
  if (dragRow && groups.every((g) => g.id === 'pinned')) groups.push({ id: 'today', label: m.session_unpin(), rows: [] })
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const archive = useResourceMutation({
    resource: ({ id }: { id: string; archived: boolean }) => `session:${id}`,
    effect: ({ archived }) => ({ fields: { archived } }),
    mutationFn: ({ id, archived }) => api.archiveSession(id, archived),
    onError: (e) => showErrorToast(e),
  })
  const mutateArchive = archive.mutate
  const onArchive = (id: string, archived: boolean) => mutateArchive({ id, archived })
  const createProject = useResourceMutation({
    resource: () => 'project:new',
    effect: (name: string) => ({ fields: { name } }),
    exclusive: true,
    mutationFn: (name) => api.createProject(name),
    onError: (e) => showErrorToast(e),
  })
  const navigate = useNavigate()
  // Legacy J/K: open the next or previous shown session in sidebar order, unless typing, modified, or inside a dialog or menu (TAL-613).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'j' && e.key !== 'k') || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || inTextField(e.target) || (e.target as Element | null)?.closest?.('[role="dialog"],[role="alertdialog"],[role="menu"]')) return
      const ids = groups.flatMap((g) => (collapsedGroups[g.id] ? [] : g.rows.map((r) => r.session_id)))
      const i = activeId ? ids.indexOf(activeId) : -1
      if (i < 0) return
      e.preventDefault()
      const next = ids[i + (e.key === 'j' ? 1 : -1)]
      if (next) void navigate({ to: '/session/$sessionId', params: { sessionId: next } })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [groups, collapsedGroups, activeId, navigate])
  const importInput = useRef<HTMLInputElement>(null)
  const importSession = useMutation({
    mutationFn: async (file: File) => {
      let doc: unknown
      try { doc = JSON.parse(await file.text()) } catch { throw new Error(m.import_invalid_json()) }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(m.import_invalid_json())
      return api.importSession(doc as Record<string, unknown>)
    },
    onSuccess: (r) => {
      showToast(m.session_imported())
      void qc.invalidateQueries({ queryKey: keys.sessions.all })
      closeMobileSidebar()
      void navigate({ to: '/session/$sessionId', params: { sessionId: r.session.session_id } })
    },
    onError: (e) => showToast(m.import_failed() + (e instanceof Error ? e.message : ''), 4000, 'error'),
  })

  return (
    <div className={cn('panel-view active', searchOpen && 'search-open')} id="panelChat">
      <PanelHead
        title={m.tab_chat()}
        actions={
          <>
            <PanelHeadButton label={m.group_discussions()} onClick={() => { void navigate({ to: '/groups' }) }}><Users size={16} aria-hidden="true" /></PanelHeadButton>
            <PanelHeadButton label={m.filter_conversations()} active={searchOpen} onClick={() => { setSearchOpen((o) => !o); if (searchOpen) setFilter('') }}>
              <Filter size={16} aria-hidden="true" />
            </PanelHeadButton>
            <PanelHeadButton label={showArchived ? m.session_hide_archived() : m.session_show_archived()} active={showArchived} onClick={() => setShowArchived((a) => !a)}>
              {showArchived ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
            </PanelHeadButton>
            <PanelHeadButton label={m.import_session_json_tooltip()} tooltipSide="bottom-right" onClick={() => importInput.current?.click()}>
              <Upload size={16} aria-hidden="true" />
            </PanelHeadButton>
            <PanelHeadButton label={m.new_conversation()} id="btnNewChat" tooltipSide="bottom-right" onClick={() => { void newChat() }}>
              <Plus size={16} aria-hidden="true" />
            </PanelHeadButton>
          </>
        }
      />
      <input ref={importInput} type="file" accept=".json,application/json" hidden aria-label={m.import_session_json_tooltip()} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) importSession.mutate(file) }} />
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
        <span className="sr-only" role="status">{dropTarget === null ? '' : dropTarget ? m.session_pin() : m.session_unpin()}</span>
        {cliCount > 0 && (
          <div className="session-source-tabs">
            <button type="button" className={cn('session-source-tab', source === 'webui' && 'active')} aria-pressed={source === 'webui'} onClick={() => setSource('webui')}>{m.sessions_source_webui({ n: webuiCount })}</button>
            <button type="button" className={cn('session-source-tab', source === 'cli' && 'active')} aria-pressed={source === 'cli'} onClick={() => setSource('cli')}>{m.sessions_source_cli({ n: cliCount })}</button>
          </div>
        )}
        {(projectList.length > 0 || hasUnprojected || newProject) && (
          <div className="project-bar" role="group" aria-label={m.project_filter_label()}>
            <span role="button" tabIndex={0} className={cn('project-chip', !project && 'active')} onClick={() => setProject(null)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setProject(null) }}>{m.project_all()}</span>
            {hasUnprojected && <span role="button" tabIndex={0} className={cn('project-chip no-project', project === NO_PROJECT && 'active')} title={m.project_unassigned_hint()} onClick={() => setProject(NO_PROJECT)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setProject(NO_PROJECT) }}>{m.project_unassigned()}</span>}
            {newProject && <span className="project-chip"><span>{newProject}</span></span>}
            {projectList.map((p) => <ProjectChip key={p.project_id} project={p} active={project === p.project_id} onSelect={() => setProject(p.project_id)} onDeleted={() => setProject((cur) => (cur === p.project_id ? null : cur))} />)}
            <span role="button" tabIndex={0} className="project-chip project-chip-add" title={m.project_new()} aria-label={m.project_new()} onClick={() => { const name = window.prompt(m.project_new_prompt()); if (name?.trim()) createProject.mutate(name.trim()) }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { const name = window.prompt(m.project_new_prompt()); if (name?.trim()) createProject.mutate(name.trim()) } }}>+</span>
          </div>
        )}
        {storageNotice && (
          <div className="session-list-note session-list-error" role="status">
            <div>{storageNotice}{storage?.reason && <HelpTip label={m.field_help_about({ label: storageNotice })}>{storage.reason}</HelpTip>}</div>
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
            <div key={g.id} className={cn('session-date-group', dropTarget !== null && dropTarget === (g.id === 'pinned') && 'session-drop-target')} {...dropHandlers(g.id === 'pinned')}>
              <div className={cn('session-date-header', g.id === 'pinned' && 'pinned')} role="button" tabIndex={0} aria-expanded={!isCollapsed} onClick={() => setCollapsedGroups((c) => ({ ...c, [g.id]: !c[g.id] }))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsedGroups((c) => ({ ...c, [g.id]: !c[g.id] })) } }}>
                <span className={cn('session-date-caret', isCollapsed && 'collapsed')} aria-hidden="true">{'\u25BE'}</span>
                <span>{g.label}</span>
              </div>
              <div className="session-date-body" style={isCollapsed ? { display: 'none' } : undefined}>
                {g.rows.map((row) => <SessionListItem key={row.session_id} row={row} active={row.session_id === activeId} proj={row.project_id ? projectsById.get(row.project_id) : undefined} preview={previews.get(row.session_id)} timeLabel={relativeTime(row.sort_ts)} onArchive={onArchive} onDragStart={startDrag} onDragEnd={endDrag} />)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
