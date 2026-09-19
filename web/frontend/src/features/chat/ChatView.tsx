import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import { MAIN_VIEW } from '../../shell/AppShell'

/** Legacy `.chat-context-item`; the `·` separator between items stays a legacy `::before` rule. */
const CONTEXT_ITEM = 'chat-context-item border-0 bg-transparent text-muted text-[12px] font-medium py-px px-1.5 -mx-0.5 rounded-[5px] cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis max-w-[220px] transition-[background,color] duration-(--dur) ease-(--ease) hover:bg-hover hover:text-text'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { useBootstrap } from '../../app/bootstrap'
import { useSettingsQuery, useWorkspacesQuery } from '../../app/queries'
import type { Session, SessionsList } from '../../contracts'
import { configureStream, cancelTurn, startTurn } from '../../stream/connection'
import { dispatch } from '../../stream/store'
import { isTerminal } from '../../stream/reducer'
import { useTranscript, type VisibleMessage } from './useTranscript'
import { Transcript } from './Transcript'
import { TranscriptSkeleton } from './TranscriptSkeleton'
import { Composer, type QueuedTurn } from '../composer/Composer'
import { ApprovalCard } from './ApprovalCard'
import { ClarifyCard } from './ClarifyCard'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { WorkspacePanel } from '../workspace/WorkspacePanel'
import { workspaceLabel } from '../workspaces/label'
import { RuntimeNoticeStack } from '../notices/RuntimeNoticeStack'
import { showToast } from '../toast/toast'
import { isApiError } from '../../contracts/common'
import { ErrorState, formatDate } from '../../ui/States'
import { readPersisted, removePersisted, writePersisted } from '../../lib/persisted'
import type { ActivityMode } from './blocks/Worklog'
import { createSessionNow } from '../sessions/useNewChat'
import { useSessionSearch } from './useSessionSearch'

export function ChatView({ sessionId }: { sessionId: string | null }) {
  const bootstrap = useBootstrap()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const settings = useSettingsQuery()
  const { query, session, rows, live, truncated, loadOlder, loadingOlder, refresh } = useTranscript(sessionId)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(() => readPersisted('hermes-webui-workspace-panel') === 'open')
  const [queued, setQueued] = useState<QueuedTurn[]>([])
  const draining = useRef(false)
  const [yolo, setYolo] = useState(false)
  // Choices made on the unsaved chat (no session yet) apply when the session is created.
  const [pending, setPending] = useState<{ model?: string; model_provider?: string | null; workspace?: string; enabled_toolsets?: string[] | null }>({})
  useSessionSearch(sessionId)

  useEffect(() => {
    configureStream({ queryClient: qc, onCompressed: (sid, next) => { if (sid === sessionId) void navigate({ to: '/session/$sessionId', params: { sessionId: next } }) } })
  }, [qc, navigate, sessionId])

  useEffect(() => {
    if (!sessionId) return
    api.fetchSessionYolo(sessionId).then((r) => setYolo(r.yolo_enabled)).catch(() => setYolo(false))
  }, [sessionId])
  const yoloOn = sessionId ? yolo : false

  // Queue drain: when the live turn settles, send the next queued message.
  useEffect(() => {
    if (!sessionId || !session || !live || !isTerminal(live.status)) return
    const next = queued[0]
    if (!next || draining.current) return
    // One drain in flight at a time; the item leaves the queue only once its turn has started, so a
    // failed start keeps it and a re-render mid-request cannot start the next item concurrently.
    draining.current = true
    void startTurn({ sessionId, message: next.text, request: { ...next.request, ...(next.attachments.length ? { attachments: next.attachments } : {}) } })
      .then(() => setQueued((q) => (q[0] === next ? q.slice(1) : q)))
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'))
      .finally(() => { draining.current = false })
  }, [live?.status, sessionId, session, queued, live])

  const ensureSession = useCallback(async (): Promise<Session> => {
    if (session) return session
    const created = await createSessionNow({ ...(settings.data?.default_workspace ? { workspace: settings.data.default_workspace } : {}), ...pending, profile: bootstrap.profile?.name ?? 'default' })
    qc.setQueryData(keys.sessions.detail(created.session_id), { session: created })
    await navigate({ to: '/session/$sessionId', params: { sessionId: created.session_id }, replace: true })
    return created
  }, [session, settings.data, bootstrap.profile, qc, navigate, pending])

  // Reasoning effort is server state shared with the CLI (config.yaml), keyed on the session's model.
  const reasoningKey = ['reasoning', session?.model ?? null, session?.model_provider ?? null] as const
  const reasoningStatus = useQuery({ queryKey: reasoningKey, queryFn: () => api.fetchReasoning(session?.model, session?.model_provider), enabled: !!sessionId, staleTime: 30_000 })
  const reasoning = reasoningStatus.data?.reasoning_effort || null
  const reasoningLevels = reasoningStatus.data?.supported_efforts
  const reasoningSupported = reasoningStatus.data?.supports_reasoning_effort !== false || reasoningStatus.data?.supports_thinking_toggle === true
  const setReasoning = useCallback((level: string | null) => {
    void api.setReasoningEffort(level ?? '', session?.model, session?.model_provider)
      .then((status) => { qc.setQueryData(reasoningKey, status); showToast(`${m.composer_control_reasoning()}: ${status.reasoning_effort || m.reasoning_default()}`) })
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reasoningKey is derived from session model/provider
  }, [qc, session?.model, session?.model_provider])

  const patchSession = useMutation({ mutationFn: (body: { model?: string; model_provider?: string | null; workspace?: string }) => api.updateSession(sessionId ?? '', body) })
  const updateSession = useCallback(async (body: { model?: string; model_provider?: string | null; workspace?: string }) => {
    if (!sessionId) return
    try {
      await patchSession.mutateAsync(body)
      await refresh()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 4000, 'error')
    }
  }, [sessionId, patchSession, refresh])

  const onModelChange = useCallback((model: string, provider: string | null) => { if (!sessionId) { setPending((p) => ({ ...p, model, model_provider: provider })); return } void updateSession({ model, model_provider: provider }) }, [sessionId, updateSession])
  const onWorkspaceChange = useCallback((path: string) => { if (!sessionId) { setPending((p) => ({ ...p, workspace: path })); return } void updateSession({ workspace: path }) }, [sessionId, updateSession])
  const onToolsetsChange = useCallback((toolsets: string[] | null) => { if (!sessionId) { setPending((p) => ({ ...p, enabled_toolsets: toolsets })); return } void api.setSessionToolsets(sessionId, toolsets).then(() => refresh()).catch((e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')) }, [sessionId, refresh])
  const onToggleYolo = useCallback(() => { if (!sessionId) return; void api.setSessionYolo(sessionId, !yolo).then((r) => setYolo(!!r.yolo_enabled)).catch((e: unknown) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error')) }, [sessionId, yolo])

  const onRegenerate = useCallback(async () => {
    if (!sessionId) return
    const r = await api.retrySession(sessionId)
    const streamId = 'stream_id' in r ? r.stream_id : undefined
    const turnId = 'turn_id' in r ? r.turn_id : undefined
    if (typeof streamId === 'string' && streamId) dispatch({ type: 'start', sessionId, streamId, turnId: typeof turnId === 'string' ? turnId : null, userMessageId: null, userText: '', now: Date.now() })
    await refresh()
  }, [sessionId, refresh])

  // Manual compression: start, poll the job to done/error, then load the compacted session (a new id when the server forks).
  const [compressing, setCompressing] = useState(false)
  const runCompression = useCallback(async (sid: string) => {
    setCompressing(true)
    showToast(m.live_compressing())
    try {
      await api.compressSession(sid)
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const st = await api.compressStatus(sid)
        if (st.status === 'running') continue
        if (st.status === 'error') throw new Error(st.error ?? m.compress_failed_label())
        if (st.status === 'idle') throw new Error(m.compress_failed_label())
        const next = st.session?.session_id ?? st.session_id ?? sid
        showToast(m.compress_complete_label())
        void qc.invalidateQueries({ queryKey: keys.sessions.all })
        if (next !== sid) await navigate({ to: '/session/$sessionId', params: { sessionId: next } })
        else await refresh()
        return
      }
      throw new Error(m.compress_failed_label())
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 5000, 'error')
    } finally {
      setCompressing(false)
    }
  }, [qc, navigate, refresh])

  const onLocalCommand = useCallback(async (name: string, args: string): Promise<boolean> => {
    switch (name) {
      case 'stop': if (sessionId) await cancelTurn(sessionId); return true
      case 'new': removePersisted('hermes-webui-session'); await navigate({ to: '/', search: { action: 'new-chat' } }); return true
      case 'clear': if (sessionId) { await api.clearSession(sessionId); await refresh() } return true
      case 'terminal': setTerminalOpen((t) => !t); return true
      case 'title': if (sessionId && args) { await api.renameSession(sessionId, args); await refresh(); void qc.invalidateQueries({ queryKey: keys.sessions.all }) } return true
      case 'retry': if (sessionId) { await onRegenerate() } return true
      case 'undo': if (sessionId) { await api.undoSession(sessionId); await refresh() } return true
      case 'compress': case 'compact': if (sessionId) { void runCompression(sessionId) } return true
      case 'usage': if (sessionId) { const u = await api.fetchSessionUsage(sessionId); showToast(`${(u.input_tokens ?? 0).toLocaleString()} in · ${(u.output_tokens ?? 0).toLocaleString()} out${u.estimated_cost ? ` · $${u.estimated_cost.toFixed(4)}` : ''}`, 4000) } return true
      case 'yolo': onToggleYolo(); return true
      case 'branch': if (sessionId) { const r = await api.branchSession(sessionId); void qc.invalidateQueries({ queryKey: keys.sessions.all }); await navigate({ to: '/session/$sessionId', params: { sessionId: r.session_id } }) } return true
      case 'reasoning': {
        const arg = args.trim().toLowerCase()
        if (!arg) { showToast(`${m.composer_control_reasoning()}: ${reasoning ?? m.reasoning_default()}`, 4000); return true }
        if (arg === 'show' || arg === 'on' || arg === 'hide' || arg === 'off') { await api.setReasoningDisplay(arg === 'show' || arg === 'on' ? 'show' : 'hide'); void qc.invalidateQueries({ queryKey: keys.settings }); return true }
        setReasoning(arg === 'default' ? null : arg)
        return true
      }
      case 'model': if (args) onModelChange(args, null); return true
      case 'workspace': if (args) onWorkspaceChange(args); return true
      case 'personality': if (sessionId) { await api.setPersonality(sessionId, args || null); await refresh() } return true
      case 'goal': if (sessionId) { const r = await api.goalCommand(sessionId, args ? 'set' : 'status', args || undefined); showToast(r.message ?? (r.goal?.text ?? m.done())) } return true
      case 'status': if (sessionId) { const s = await api.fetchSessionStatus(sessionId); showToast(`${s.model ?? ''} · ${s.message_count ?? 0} msgs · ${s.agent_running ? m.status_streaming() : m.done()}`, 4000) } return true
      case 'help': await navigate({ to: '/settings/$section', params: { section: 'help' } }); return true
      case 'skills': await navigate({ to: '/skills' }); return true
      case 'use': return false
      case 'voice': showToast(m.voice_error(), 3000); return true
      default: return false
    }
  }, [sessionId, navigate, refresh, qc, onToggleYolo, onModelChange, onWorkspaceChange, onRegenerate, reasoning, setReasoning, runCompression])

  const onEdit = useCallback(async (row: VisibleMessage, text: string) => {
    if (!sessionId) return
    const keep = row.index
    await api.truncateSession(sessionId, keep)
    await refresh()
    const el = document.getElementById('msg') as HTMLTextAreaElement | null
    if (el) { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus() }
  }, [sessionId, refresh])
  const onBranch = useCallback(async (row: VisibleMessage) => {
    if (!sessionId) return
    const r = await api.branchSession(sessionId, row.index + 1)
    void qc.invalidateQueries({ queryKey: keys.sessions.all })
    await navigate({ to: '/session/$sessionId', params: { sessionId: r.session_id } })
  }, [sessionId, navigate, qc])

  const mode = (settings.data?.chat_activity_display_mode as ActivityMode | undefined) ?? 'compact_worklog'
  const assistantName = bootstrap.profile && !bootstrap.profile.is_default ? bootstrap.profile.name.charAt(0).toUpperCase() + bootstrap.profile.name.slice(1) : bootstrap.bot_name
  // Until the transcript arrives the header shows the title the sidebar already has for this session.
  const listedTitle = sessionId ? qc.getQueryData<SessionsList>(keys.sessions.list({}))?.sessions.find((r) => r.session_id === sessionId)?.title : undefined
  const title = session?.title ?? listedTitle ?? ''
  const workspace = session?.workspace ?? settings.data?.default_workspace
  const workspaces = useWorkspacesQuery()
  const wsLabel = workspaceLabel(workspaces.data?.workspaces, workspace)
  const meta = useMemo(() => [session?.model, session?.message_count !== undefined ? m.session_meta_messages({ n: session.message_count }) : null, session?.updated_at ? formatDate(session.updated_at) : null].filter(Boolean).join(' · '), [session])

  // Composer placement. A session is assumed to have content until the transcript says otherwise;
  // only a session remembered as empty (legacy `hermes-webui-session-empty`) opens in the hero layout
  // before its transcript has loaded, so the composer never starts mid-screen and slides down.
  const knownEmpty = !sessionId || readPersisted('hermes-webui-session-empty') === sessionId
  const hero = !live && (!sessionId || (query.isSuccess ? rows.length === 0 : knownEmpty))
  useEffect(() => {
    if (!sessionId || !query.isSuccess) return
    if (rows.length === 0) writePersisted('hermes-webui-session-empty', sessionId)
    else if (readPersisted('hermes-webui-session-empty') === sessionId) removePersisted('hermes-webui-session-empty')
  }, [sessionId, query.isSuccess, rows.length])

  const notFound = query.isError && isApiError(query.error) && query.error.status === 404
  const otherProfile = query.isError && isApiError(query.error) && query.error.status === 409

  const emptyState = (
    <div className="empty-state" id="emptyState">
      <h2 className="empty-hero-title ready" id="emptyHeroTitle">{wsLabel ? m.empty_hero_title_workspace({ a0: wsLabel }) : m.empty_hero_title()}</h2>
    </div>
  )
  const openChip = (id: string) => { const el = document.getElementById(id); if (el instanceof HTMLElement) el.click() }

  return (
    <>
      <div id="mainChat" className={cn(MAIN_VIEW, 'active', hero && 'composer-hero')}>
        <div className="chat-header flex items-center gap-3 min-h-[52px] px-5 py-1.5 border-b border-border shrink-0 max-[641px]:hidden">
          <div className="chat-header-text min-w-0 flex-1 flex flex-col gap-px">
            <h1 className="chat-header-title m-0 text-[13.5px] font-[550] text-text whitespace-nowrap overflow-hidden text-ellipsis tracking-[-.01em]" id="topbarTitle">{session || listedTitle ? (title || m.untitled()) : bootstrap.bot_name}</h1>
            {session && meta && <div className="chat-header-meta hidden text-[11px] text-muted whitespace-nowrap overflow-hidden text-ellipsis font-mono" id="topbarMeta">{meta}</div>}
            <div className="chat-context flex items-center gap-0.5 mt-0.5 min-w-0 overflow-hidden max-[641px]:hidden">
              <button type="button" className={cn(CONTEXT_ITEM, 'chat-context-profile')} onClick={() => openChip('profileChip')}>{bootstrap.profile?.name ?? 'default'}</button>
              {(session?.model ?? settings.data?.default_model) && <button type="button" className={cn(CONTEXT_ITEM, 'chat-context-model')} onClick={() => openChip('composerModelChip')}>{session?.model ?? settings.data?.default_model}</button>}
              {reasoning && reasoningSupported && <button type="button" className={cn(CONTEXT_ITEM, 'chat-context-effort')} onClick={() => openChip('composerReasoningChip')}>{reasoning}</button>}
              {wsLabel && <button type="button" className={cn(CONTEXT_ITEM, 'chat-context-workspace')} onClick={() => openChip('composerWorkspaceChip')}>{wsLabel}</button>}
            </div>
          </div>
        </div>
        <RuntimeNoticeStack live={live} onRetry={() => { void onRegenerate() }} />
        {notFound && <div className="p-4"><ErrorState error={new Error(m.transcript_not_found())} onRetry={() => { void navigate({ to: '/', search: { action: 'new-chat' } }) }} /></div>}
        {otherProfile && <div className="p-4"><ErrorState error={new Error(m.transcript_other_profile({ profile: ((query.error as { body?: { profile?: string } }).body?.profile ?? '') }))} /></div>}
        {query.isError && !notFound && !otherProfile && <div className="p-4"><ErrorState error={query.error} onRetry={() => { void refresh() }} /></div>}
        {!query.isError && (
          <Transcript
            rows={rows}
            live={live}
            assistantName={assistantName}
            mode={mode}
            renderUserMarkdown={!!settings.data?.render_user_markdown}
            autoFollow={settings.data?.auto_scroll_follow !== false}
            sessionId={sessionId ?? undefined}
            actions={{ onEdit: (row, text) => { void onEdit(row, text) }, onBranch: (row) => { void onBranch(row) }, onRegenerate: () => { void onRegenerate() } }}
            tts={!!(settings.data as Record<string, unknown> | undefined)?.tts_enabled}
            truncated={truncated}
            onLoadOlder={() => { void loadOlder() }}
            loadingOlder={loadingOlder}
            emptyState={query.isPending && !knownEmpty ? <TranscriptSkeleton /> : emptyState}
            showJumpButtons={(settings.data as Record<string, unknown> | undefined)?.session_jump_buttons !== false}
            virtualizeLongTranscripts={(settings.data as Record<string, unknown> | undefined)?.virtualize_transcript === true}
          />
        )}
        <div className="composer-flyout">
          {sessionId && live?.approval && <ApprovalCard sessionId={sessionId} pending={live.approval} onResolved={() => dispatch({ type: 'clear_approval', sessionId })} />}
          {sessionId && live?.clarify && <ClarifyCard sessionId={sessionId} pending={live.clarify} onResolved={() => dispatch({ type: 'clear_clarify', sessionId })} />}
          {terminalOpen && sessionId && <TerminalPanel sessionId={sessionId} workspace={workspace} onClose={() => setTerminalOpen(false)} />}
        </div>
        <Composer
          sessionId={sessionId}
          session={session}
          pendingChoices={sessionId ? undefined : pending}
          live={live}
          settings={settings.data}
          onEnsureSession={ensureSession}
          onLocalCommand={onLocalCommand}
          terminalOpen={terminalOpen}
          onToggleTerminal={() => setTerminalOpen((t) => !t)}
          onModelChange={onModelChange}
          onWorkspaceChange={onWorkspaceChange}
          onToolsetsChange={onToolsetsChange}
          onReasoningChange={setReasoning}
          reasoning={reasoning}
          reasoningLevels={reasoningLevels}
          reasoningSupported={reasoningSupported}
          yolo={yoloOn}
          onToggleYolo={onToggleYolo}
          queued={queued}
          locked={compressing}
          onQueue={(entry) => setQueued((q) => [...q, entry])}
        />
        <span className="sr-only" aria-live="polite" id="a11yAnnouncer">{live?.status === 'done' ? m.done() : ''}</span>
      </div>
      {/* Always mounted beside main (its queries run only while open) so opening and closing animate and the edge tab is always there. */}
      {workspace && sessionId && <WorkspacePanel key={workspace} workspace={workspace} sessionId={sessionId} open={workspaceOpen} onToggle={() => setWorkspaceOpen((o) => !o)} onClose={() => setWorkspaceOpen(false)} />}
    </>
  )
}
