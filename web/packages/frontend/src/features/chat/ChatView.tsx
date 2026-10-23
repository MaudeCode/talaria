import type { OwnerActionRequest } from '@maudecode/talaria-web-contracts'
import { useResourceEffects, useResourceMutation, withEffect, withEffects } from '../sessions/useResourceMutation'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import { useLocale } from '../../i18n/useLocale'
import { cn } from '../../ui/cn'
import { MAIN_VIEW } from '../../shell/AppShell'
import { PanelRight, TerminalSquare } from 'lucide-react'

import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { invalidateSessionQueries } from '../../api/sessionQueries'
import { useBootstrap } from '../../app/bootstrap'
import { useSettingsQuery, useWorkspacesQuery } from '../../app/queries'
import type { Session, SessionsList } from '../../contracts'
import { configureStream, cancelTurn, getStreamContext, startTurn } from '../../stream/connection'
import { dispatch, useTurnIntent } from '../../stream/store'
import { isTerminal, runStart, type LiveTurn } from '../../stream/reducer'
import { useTranscript, type VisibleMessage } from './useTranscript'
import { chosenFields, useSessionUpdate } from './useSessionUpdate'
import { transcriptCut, useEditMessage } from './useEditMessage'
import { Transcript } from './Transcript'
import { TranscriptSkeleton } from './TranscriptSkeleton'
import { Composer, turnRequest } from '../composer/Composer'
import { composerStateId, useQueuedTurns, type QueuedTurn } from '../composer/queue'
import { returnToComposer } from '../composer/composerReturn'
import { ApprovalCard } from './ApprovalCard'
import { ClarifyCard } from './ClarifyCard'
import { ConnectCard } from '../connectors/ConnectCard'
import { useClarify } from './useClarify'
import { VaultPromptCard, useVaultPrompt } from './VaultPromptCard'
import { useMarkViewed } from './useMarkViewed'
import { TerminalPanelFrame } from '../terminal/TerminalPanelFrame'
import { ChatSidePanel } from './ChatSidePanel'
import { setSidePanelOpen, toggleSidePanel, useShellState } from '../../shell/useShellState'
import { useRuntimeNotices } from '../notices/useRuntimeNotices'
import { showRichToast, showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { isApiError } from '../../contracts/common'
import { ErrorState, formatDate } from '../../ui/States'
import { readPersisted, removePersisted, writePersisted } from '../../lib/persisted'
import type { ActivityMode } from './blocks/Worklog'
import { createSessionNow, useCreationId } from '../sessions/useNewChat'
import type { ExecutionMode } from '@maudecode/talaria-web-contracts'
import { WorktreeRemoveDialog } from '../sessions/WorktreeRemoveDialog'
import { beginDock, playDock, requestScroll } from './sendMotion'
import { bindFirstSend, ownsFirstSend, useFirstSend } from './firstSend'

const TerminalPanel = lazy(() => import('../terminal/TerminalPanel').then((module) => ({ default: module.TerminalPanel })))

// Text and replay cursors belong to the transcript. Every other turn field still updates chat controls.
const TEXT_FIELDS = new Set<keyof LiveTurn>(['segments', 'reasoningText', 'reasoningTitles', 'lastEventId', 'lastSeq'])
function sameTurnControls(previous: LiveTurn | null, next: LiveTurn | null): boolean {
  if (previous === next) return true
  if (!previous || !next) return false
  return (Object.keys(next) as (keyof LiveTurn)[]).every((key) => TEXT_FIELDS.has(key) || Object.is(previous[key], next[key]))
}

type AdmissionRequest = Extract<OwnerActionRequest, { admission_id: string }>
const admissionResource = (sessionId: string, admissionId: string) => `owner-admission:${sessionId}:${admissionId}`

export function ChatView({ sessionId }: { sessionId: string | null }) {
  const bootstrap = useBootstrap()
  const locale = useLocale()
  const qc = useQueryClient()
  const { mutate: renameSession } = useResourceMutation({ resource: () => `session:${sessionId}`, effect: (title: string) => ({ fields: { title } }), mutationFn: (title) => { if (!sessionId) throw new Error(m.error_generic()); return api.renameSession(sessionId, title) }, onError: (e) => showErrorToast(e) })

  const navigate = useNavigate()
  const settings = useSettingsQuery()
  const { query, session, rows, base, live, truncated, loadOlder, loadingOlder, olderError, refresh } = useTranscript(sessionId, sameTurnControls)
  // Edit, /clear and /undo show their cut at once; the reread of the session confirms it.
  const cutFrom = useResourceEffects<number>()[transcriptCut(sessionId ?? '')]?.value
  const shownRows = useMemo(() => typeof cutFrom === 'number' ? rows.filter((row) => row.index < cutFrom) : rows, [rows, cutFrom])
  const lastExchange = useMemo(() => [...rows].reverse().find((row) => row.message.role === 'user')?.index, [rows])
  const intent = useTurnIntent(sessionId)
  const { onEdit, dialog: editDialog, operation, runHistory } = useEditMessage(sessionId, refresh)
  const clarify = useClarify(sessionId, live)
  const vaultPrompt = useVaultPrompt(sessionId, live)
  useMarkViewed(sessionId, !session?.owner_attachment && (query.isFetchedAfterMount || (query.isSuccess && !query.isStale)), live && isTerminal(live.status) ? live.streamId : null)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const onToggleTerminal = useCallback(() => setTerminalOpen((t) => !t), [])
  const { sidePanelOpen } = useShellState()
  const [queued, setQueued] = useQueuedTurns(composerStateId(session))
  const onQueue = useCallback((entry: QueuedTurn) => setQueued((q) => [...q, entry]), [setQueued])
  const draining = useRef(false)
  const [failedQueued, setFailedQueued] = useState<string | null>(null)
  // Choices made on the unsaved chat (no session yet) apply when the session is created.
  const [pending, setPending] = useState<{ model?: string; model_provider?: string | null; workspace?: string; enabled_toolsets?: string[] | null; execution_mode?: ExecutionMode }>({})
  const focusKey = useSearch({ strict: false }).msg
  const creation = useCreationId(pending)

  useEffect(() => {
    configureStream({ queryClient: qc, onCompressed: (sid, next) => { if (sid === sessionId) void navigate({ to: '/session/$sessionId', params: { sessionId: next } }) } })
  }, [qc, navigate, sessionId])

  const yoloSessionId = session && !session.owner_attachment ? sessionId : null
  const yoloQuery = useQuery({ queryKey: keys.yolo(yoloSessionId ?? ''), queryFn: () => api.fetchSessionYolo(yoloSessionId ?? ''), enabled: !!yoloSessionId, retry: false })
  const yoloEffect = useResourceEffects<boolean>()[`yolo:${sessionId}`]
  const yoloShown = typeof yoloEffect?.value === 'boolean' ? yoloEffect.value : yoloQuery.data?.yolo_enabled ?? false
  const yoloOn = yoloSessionId ? yoloShown : false

  // Queue drain: when the live turn settles, send the next queued message. A queue a reload restored onto a session
  // whose run ended meanwhile has no turn to settle; the server reporting no active stream starts it instead.
  useEffect(() => {
    if (!sessionId || !session || session.owner_attachment?.can_submit === false || intent.send || intent.stop || operation || (live ? !isTerminal(live.status) : session.active_stream_id)) return
    const next = queued[0]
    if (!next || draining.current || failedQueued === next.id) return
    // One drain in flight at a time; the item leaves the queue only once its turn has started, so a
    // failed start keeps it and a re-render mid-request cannot start the next item concurrently.
    draining.current = true
    const scope = getStreamContext()
    void startTurn({ sessionId, message: next.text, queueId: next.id, request: { ...next.request, ...(next.attachments.length ? { attachments: next.attachments } : {}) } })
      // External-store queue updates notify synchronously; release before publishing the next queue.
      .finally(() => { draining.current = false })
      .then(() => { if (scope === getStreamContext()) setQueued((q) => q.filter((t) => t.id !== next.id)) })
      .catch((e: unknown) => { if (scope !== getStreamContext()) return; setFailedQueued(next.id); showErrorToast(e) })
  }, [sessionId, session, queued, live, setQueued, intent, operation, failedQueued])

  const ensureSession = useCallback(async (onCreated?: (sessionId: string) => void): Promise<Session> => {
    if (session) return session
    const scope = getStreamContext()
    const created = await createSessionNow({ ...(settings.data?.default_workspace ? { workspace: settings.data.default_workspace } : {}), ...pending, profile: bootstrap.profile?.name ?? 'default', request_id: creation.next() })
    creation.settle()
    if (scope !== getStreamContext()) throw new DOMException('Context changed', 'AbortError')
    onCreated?.(created.session_id)
    qc.setQueryData(keys.sessions.detail(created.session_id), { session: created })
    bindFirstSend(created.session_id)
    await navigate({ to: '/session/$sessionId', params: { sessionId: created.session_id }, replace: true })
    return created
  }, [session, settings.data, bootstrap.profile, qc, navigate, pending, creation])

  const [removingWorktree, setRemovingWorktree] = useState(false)
  const onRemoveWorktree = useCallback(() => setRemovingWorktree(true), [])
  // TAL-605: a new conversation in its own git worktree of the chosen workspace; the server creates the worktree.
  const newWorktreeChat = useCallback(async (workspace: string | undefined) => {
    try {
      const created = await createSessionNow({ ...pending, ...(workspace ? { workspace } : {}), profile: bootstrap.profile?.name ?? 'default', worktree: true })
      qc.setQueryData(keys.sessions.detail(created.session_id), { session: created })
      void invalidateSessionQueries(qc, created.session_id)
      showToast(m.workspace_worktree_created())
      await navigate({ to: '/session/$sessionId', params: { sessionId: created.session_id } })
    } catch (e) {
      showToast(m.workspace_worktree_failed() + (e instanceof Error ? e.message : String(e)), 4000, 'error')
    }
  }, [pending, bootstrap.profile, qc, navigate])
  const onNewWorktreeChat = useCallback((workspace: string | undefined) => { void newWorktreeChat(workspace) }, [newWorktreeChat])

  // Reasoning effort is server state shared with the CLI (config.yaml), keyed on the session's model.
  const reasoningKey = ['reasoning', session?.model ?? null, session?.model_provider ?? null] as const
  const reasoningStatus = useQuery({ queryKey: reasoningKey, queryFn: () => api.fetchReasoning(session?.model, session?.model_provider), enabled: !!sessionId, staleTime: 30_000 })
  const reasoningResource = JSON.stringify(['reasoning', session?.model ?? null, session?.model_provider ?? null])
  const reasoningEffect = useResourceEffects<string | null>()[reasoningResource]
  // The chosen effort shows at once; the server's answer replaces it.
  const reasoning = reasoningEffect && 'value' in reasoningEffect ? reasoningEffect.value ?? null : reasoningStatus.data?.reasoning_effort || null
  const reasoningLevels = reasoningStatus.data?.supported_efforts
  const reasoningSupported = reasoningStatus.data?.supports_reasoning_effort !== false || reasoningStatus.data?.supports_thinking_toggle === true
  const reasoningWrite = useResourceMutation({
    resource: ({ resource }: { resource: string; key: readonly unknown[]; level: string | null; model: string | null | undefined; provider: string | null | undefined; sid: string | undefined }) => resource,
    queryKey: ['reasoning'], readKeys: ({ key }) => [{ queryKey: key, exact: true }],
    effect: ({ level }) => ({ value: level }),
    mutationFn: ({ level, model, provider, sid }) => api.setReasoningEffort(level ?? '', model, provider, sid),
    onSuccess: (status, { key }) => { qc.setQueryData(key, status); showToast(`${m.composer_control_reasoning()}: ${status.reasoning_effort || m.reasoning_default()}`) },
    onError: (e) => showErrorToast(e),
  })
  const sendReasoning = reasoningWrite.mutate
  const setReasoning = useCallback((level: string | null) => {
    sendReasoning({ resource: reasoningResource, key: reasoningKey, level, model: session?.model, provider: session?.model_provider, sid: sessionId ?? undefined })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reasoningKey is derived from session model/provider
  }, [sendReasoning, reasoningResource, sessionId, session?.model, session?.model_provider])

  const { updateSession, dialog: modelDialog, notice: modelNotice, confirming } = useSessionUpdate(sessionId, refresh, session?.owner_attachment)
  // Session controls (toolsets, personality) show the choice at once; the reread of the session confirms it.
  const sessionWrite = useResourceMutation({
    resource: ({ sid }: { sid: string; fields: Record<string, unknown>; run: () => Promise<unknown> }) => `session:${sid}`,
    queryKey: keys.sessions.all, readKeys: ({ sid }) => [{ queryKey: keys.sessions.detail(sid), exact: true }],
    effect: ({ fields }) => ({ fields }),
    mutationFn: ({ run }) => run(),
    onError: (e) => showErrorToast(e),
  })
  const sendSessionWrite = sessionWrite.mutate

  // An owner input the user cancels, discards or steers leaves the queue at once, and an edit shows its new text;
  // a refusal brings it back. Retry is executed by the server, so it waits.
  const admissionWrite = useResourceMutation({
    resource: (request: AdmissionRequest) => admissionResource(request.session_id, request.admission_id),
    queryKey: keys.sessions.all, readKeys: (request) => [{ queryKey: keys.sessions.detail(request.session_id), exact: true }],
    effect: (request) => request.action === 'replace_queued' ? { fields: { text: request.text } } : { remove: true },
    mutationFn: (request) => api.ownerAction(request),
  })
  const sendAdmission = admissionWrite.mutateAsync
  const onOwnerAction = useCallback(async (request: OwnerActionRequest) => {
    if (!sessionId || request.session_id !== sessionId) return
    const scope = getStreamContext()
    try {
      const result = request.action === 'cancel' || request.action === 'steer_queued' || request.action === 'replace_queued' || request.action === 'discard' ? await sendAdmission(request) : await api.ownerAction(request)
      if (scope !== getStreamContext()) return
      await refresh(result.session)
      if (scope === getStreamContext() && result.draft !== undefined) returnToComposer(sessionId, result.draft)
    } catch (error) {
      if (scope === getStreamContext()) showErrorToast(error)
      throw error
    }
  }, [sessionId, refresh, sendAdmission])

  const onModelChange = useCallback((model: string, provider: string | null) => { if (!sessionId) { setPending((p) => ({ ...p, model, model_provider: provider })); return } updateSession({ model, model_provider: provider }) }, [sessionId, updateSession])
  const onWorkspaceChange = useCallback((path: string) => { if (!sessionId) { setPending((p) => ({ ...p, workspace: path })); return } updateSession({ workspace: path }) }, [sessionId, updateSession])
  const onExecutionModeChange = useCallback((mode: ExecutionMode) => { setPending((p) => ({ ...p, execution_mode: mode })) }, [])
  const onToolsetsChange = useCallback((toolsets: string[] | null) => { if (!sessionId) { setPending((p) => ({ ...p, enabled_toolsets: toolsets })); return } sendSessionWrite({ sid: sessionId, fields: { enabled_toolsets: toolsets }, run: () => api.setSessionToolsets(sessionId, toolsets) }) }, [sessionId, sendSessionWrite])
  const yoloWrite = useResourceMutation({
    resource: ({ sid }: { sid: string; on: boolean }) => `yolo:${sid}`, queryKey: ['yolo'], readKeys: ({ sid }) => [{ queryKey: keys.yolo(sid), exact: true }], effect: ({ on }) => ({ value: on }),
    mutationFn: ({ sid, on }) => api.setSessionYolo(sid, on),
    onSuccess: (r, { sid }) => { qc.setQueryData(keys.yolo(sid), r) },
    onError: (e) => showErrorToast(e),
  })
  const sendYolo = yoloWrite.mutate
  const onToggleYolo = useCallback(() => { if (!sessionId) return; sendYolo({ sid: sessionId, on: !yoloShown }) }, [sessionId, yoloShown, sendYolo])

  // Regenerate, `/retry`, and the error notice's Retry: the server drops the last exchange, then its prompt and files are resent.
  // One at a time: a second retry while the first is pending would drop the exchange before it too.
  const onRegenerate = useCallback(async () => {
    if (!sessionId || !session) return false
    return runHistory(m.history_retrying(), async (current) => {
      const r = await api.retrySession(sessionId)
      if (!current()) return
      if ('error' in r) { showToast(r.error, 4000, 'error'); return false }
      await refresh(undefined, true)
      if (!current()) return
      // Old-server payloads return to the composer for review rather than resending normalized text.
      if (r.last_user_prompt === undefined) { returnToComposer(sessionId, r.last_user_text); return }
      const attachments = r.last_user_attachments ?? []
      await startTurn({ sessionId, message: r.last_user_prompt, recover: true, request: { ...turnRequest(session, bootstrap.profile?.name ?? 'default'), ...(attachments.length ? { attachments } : {}) } })
    })
  }, [sessionId, session, refresh, bootstrap.profile, runHistory])

  // Manual compression: start, poll the job to done/error, then load the compacted session (a new id when the server forks).
  // Leaving the session unmounts this view and stops the poll, so it never navigates from the session shown next.
  // TAL-1006: when the job started (ms): this tab's click until the server's `started_at` arrives.
  const [compressingSince, setCompressingSince] = useState<number | null>(null)
  const compression = useRef<AbortController | null>(null)
  useEffect(() => () => compression.current?.abort(), [])
  // The running job this view follows, by its server start, so a session still reporting it is not followed twice.
  const followed = useRef<number | null>(null)
  /** `start` starts or names the job and gives its server start (epoch seconds); the job is then polled to its end. */
  const followCompression = useCallback(async (sid: string, start: () => Promise<number | null | undefined>) => {
    const { signal } = (compression.current = new AbortController())
    setCompressingSince(Date.now())
    try {
      const startedAt = await start()
      signal.throwIfAborted()
      followed.current = startedAt ?? null
      setCompressingSince(runStart(startedAt, Date.now(), Date.now()))
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        signal.throwIfAborted()
        const st = await api.compressStatus(sid)
        signal.throwIfAborted()
        if (st.status === 'running') continue
        if (st.status === 'error') throw new Error(st.error ?? m.compress_failed_label())
        if (st.status === 'idle') throw new Error(m.compress_failed_label())
        const next = st.session?.session_id ?? st.session_id ?? sid
        showToast(m.compress_complete_label())
        void invalidateSessionQueries(qc, next)
        if (next !== sid) await navigate({ to: '/session/$sessionId', params: { sessionId: next } })
        else await refresh()
        return
      }
      throw new Error(m.compress_failed_label())
    } catch (e) {
      if (!signal.aborted) showToast(e instanceof Error ? e.message : String(e), 5000, 'error')
    } finally {
      setCompressingSince(null)
    }
  }, [qc, navigate, refresh])
  const runCompression = useCallback((sid: string) => followCompression(sid, async () => (await api.compressSession(sid)).started_at), [followCompression])
  // TAL-1006: a manual job the session reports running (started in another tab, or before this view opened) shows and
  // is followed here as well.
  const runningJob = session && !session.active_stream_id ? (session.compression_started_at ?? null) : null
  useEffect(() => {
    if (!sessionId || runningJob === null || compressingSince !== null || followed.current === runningJob) return
    void followCompression(sessionId, () => Promise.resolve(runningJob))
  }, [sessionId, runningJob, compressingSince, followCompression])

  const onLocalCommand = useCallback(async (name: string, args: string): Promise<boolean | 'refused'> => {
    switch (name) {
      case 'stop': if (sessionId) await cancelTurn(sessionId); return true
      case 'new': removePersisted('hermes-webui-session'); await navigate({ to: '/', search: { action: 'new-chat' } }); return true
      case 'clear': if (sessionId) return await runHistory(m.history_clearing(), async (current) => { const r = await api.clearSession(sessionId); if (current()) await refresh(r.session) }, 0) ? true : 'refused'; return true
      case 'terminal': setTerminalOpen((t) => !t); return true
      case 'title': if (sessionId && args) renameSession(args); return true
      case 'retry': if (sessionId) return await onRegenerate() ? true : 'refused'; return true
      case 'undo': if (sessionId) return await runHistory(m.history_undoing(), async (current) => { const r = await api.undoSession(sessionId); if (!current()) return; if ('error' in r) throw new Error(r.error); await refresh(undefined, true) }, lastExchange) ? true : 'refused'; return true
      case 'compress': if (sessionId) { void runCompression(sessionId) } return true
      case 'usage': if (sessionId) { const u = await api.fetchSessionUsage(sessionId); showToast(`${(u.input_tokens ?? 0).toLocaleString()} in · ${(u.output_tokens ?? 0).toLocaleString()} out${u.estimated_cost ? ` · $${u.estimated_cost.toFixed(4)}` : ''}`, 4000) } return true
      case 'yolo': onToggleYolo(); return true
      case 'branch': if (sessionId) { const r = await api.branchSession(sessionId); void invalidateSessionQueries(qc, r.session_id); await navigate({ to: '/session/$sessionId', params: { sessionId: r.session_id } }) } return true
      case 'reasoning': {
        const arg = args.trim().toLowerCase()
        if (!arg) { showToast(`${m.composer_control_reasoning()}: ${reasoning ?? m.reasoning_default()}`, 4000); return true }
        // Nothing on the page shows the display choice, so the command finishes at once; a refusal reports itself.
        if (arg === 'show' || arg === 'on' || arg === 'hide' || arg === 'off') { void api.setReasoningDisplay(arg === 'show' || arg === 'on' ? 'show' : 'hide').then(() => qc.invalidateQueries({ queryKey: keys.settings }), (e: unknown) => showErrorToast(e)); return true }
        setReasoning(arg === 'default' ? null : arg)
        return true
      }
      case 'model': if (args) onModelChange(args, null); return true
      case 'workspace': if (args) onWorkspaceChange(args); return true
      case 'personality': {
        // TAL-612: alone it lists the personalities and changes nothing.
        if (args) { if (sessionId) sendSessionWrite({ sid: sessionId, fields: { personality: args }, run: () => api.setPersonality(sessionId, args) }); return true }
        try {
          const { personalities } = await api.fetchPersonalities()
          if (!personalities.length) showToast(m.no_personalities(), 4000)
          else showRichToast({ id: 'personalities', title: m.available_personalities(), text: personalities.map((p) => p.name).join(' · '), ttl: 8000, kind: 'info', dismissible: true, actions: [] })
        } catch { showToast(m.personalities_load_failed(), 4000, 'error') }
        return true
      }
      case 'goal': if (sessionId) { const r = await api.goalCommand(sessionId, args); showToast(r.message ?? (r.goal?.text ?? m.done())); await refresh() } return true
      case 'status': if (sessionId) { const s = await api.fetchSessionStatus(sessionId); showToast(`${s.model ?? ''} · ${s.message_count ?? 0} msgs · ${s.agent_running ? m.status_streaming() : m.done()}`, 4000) } return true
      case 'help': await navigate({ to: '/settings/$section', params: { section: 'help' } }); return true
      case 'skills': await navigate({ to: '/skills' }); return true
      case 'use': return false
      case 'voice': showToast(m.voice_error(), 3000); return true
      default: return false
    }
  }, [renameSession, sessionId, navigate, refresh, qc, onToggleYolo, onModelChange, onWorkspaceChange, onRegenerate, reasoning, setReasoning, runCompression, runHistory, lastExchange, sendSessionWrite])

  const onBranch = useCallback(async (row: VisibleMessage) => {
    if (!sessionId) return
    const r = await api.branchSession(sessionId, row.index + 1)
    void invalidateSessionQueries(qc, r.session_id)
    await navigate({ to: '/session/$sessionId', params: { sessionId: r.session_id } })
  }, [sessionId, navigate, qc])

  const actions = useMemo(() => ({
    ...(session?.read_only ? {} : { onEdit: (row: VisibleMessage, text: string) => { void onEdit(row, text) }, onRegenerate: () => { void onRegenerate() } }),
    ...(session?.can_branch ? { onBranch: (row: VisibleMessage) => { void onBranch(row) } } : {}),
  }), [session?.read_only, session?.can_branch, onEdit, onRegenerate, onBranch])

  const mode = (settings.data?.chat_activity_display_mode as ActivityMode | undefined) ?? 'compact_worklog'
  const assistantName = session?.assistant_name ?? bootstrap.assistant_name
  const resourceEffects = useResourceEffects()
  const sessionEffect = resourceEffects[`session:${sessionId}`]
  const shownSession = useMemo(() => session && withEffect(session, sessionEffect), [session, sessionEffect])
  // The composer shows a pick awaiting confirmation and the owner inputs as the user's pending actions leave them.
  const composerSession = useMemo(() => {
    if (!shownSession) return null
    const owner = shownSession.owner_attachment
    const admissions = owner && withEffects(owner.admissions, (admission) => admissionResource(shownSession.session_id, admission.admission_id), resourceEffects)
    if (!confirming && (!owner || admissions?.length === owner.admissions.length && admissions.every((a, i) => a === owner.admissions[i]))) return shownSession
    return { ...shownSession, ...(confirming ? chosenFields(confirming) : {}), ...(owner && admissions ? { owner_attachment: { ...owner, admissions } } : {}) }
  }, [shownSession, confirming, resourceEffects])
  // Until the transcript arrives the header shows the title the sidebar already has for this session.
  const listedTitle = sessionId ? qc.getQueryData<SessionsList>(keys.sessions.list({}))?.sessions.find((r) => r.session_id === sessionId)?.title : undefined
  const title = shownSession?.title ?? listedTitle ?? ''
  // TAL-639: an existing chat names only its own workspace, none until its record loads, so the Files page and
  // terminal never mount on the default and remount; the default stands in only for the unsaved chat.
  const workspace = sessionId ? session?.workspace : settings.data?.default_workspace
  const workspaces = useWorkspacesQuery()
  // TAL-303: the server names the workspace: the session's own label, else the default workspace's registry entry.
  const wsLabel = session ? session.workspace_name : workspaces.data?.workspaces.find((w) => w.path === workspace)?.name
  const meta = useMemo(() => [session?.model, session?.message_count !== undefined ? m.session_meta_messages({ n: session.message_count }) : null, session?.updated_at ? formatDate(session.updated_at) : null].filter(Boolean).join(' · '), [session])

  // Composer placement. A session is assumed to have content until the transcript says otherwise;
  // only a session remembered as empty (legacy `hermes-webui-session-empty`) opens in the hero layout
  // before its transcript has loaded, so the composer never starts mid-screen and slides down.
  // A first send in flight has already left the hero (sendMotion.ts).
  const knownEmpty = !sessionId || readPersisted('hermes-webui-session-empty') === sessionId
  const firstSend = useFirstSend()
  const pendingUserText = intent.send && (!intent.send.error || intent.send.uncertain || intent.send.recover) ? intent.send.text : firstSend && !firstSend.failed && ownsFirstSend(firstSend, sessionId) ? firstSend.text : undefined
  const hero = !live && pendingUserText === undefined && (!sessionId || (query.isSuccess ? rows.length === 0 : knownEmpty))
  useEffect(() => {
    if (!sessionId || !query.isSuccess) return
    if (rows.length === 0) writePersisted('hermes-webui-session-empty', sessionId)
    else if (readPersisted('hermes-webui-session-empty') === sessionId) removePersisted('hermes-webui-session-empty')
  }, [sessionId, query.isSuccess, rows.length])

  const onRetry = useCallback(() => { void onRegenerate() }, [onRegenerate])
  const runtime = useRuntimeNotices({ live, onRetry, compressingSince, agentNotices: session?.notices, goal: session?.goal })
  const notices = useMemo(() => [
    ...runtime.notices,
    ...(modelNotice ? [modelNotice] : []),
    ...(operation ? [{ id: 'history', content: <span role="status">{operation}</span> }] : []),
    ...(session?.owner_attachment?.restarting ? [{ id: 'owner-restarting', content: <span role="status">{m.owner_restarting()}</span> }] : []),
    ...(failedQueued && queued.some((q) => q.id === failedQueued) ? [{ id: 'queue-failed', tone: 'error' as const, content: m.composer_queue_failed(), action: { label: m.retry(), run: () => setFailedQueued(null) } }] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Paraglide messages read the active locale implicitly.
  ], [runtime.notices, modelNotice, operation, session?.owner_attachment?.restarting, failedQueued, queued, locale])
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404
  const otherProfile = query.isError && isApiError(query.error) && query.error.status === 409

  // The composer floats over the transcript (T3 Code's composer overlay): centred in the stage as the hero, docked to its
  // bottom otherwise. Its measured height is the transcript's bottom inset (`--composer-h`), and leaving the hero moves
  // it down with a FLIP that a first send's remount resumes (sendMotion.ts).
  const stage = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const heroTop = useRef<number | null>(null)
  useLayoutEffect(() => {
    const stageEl = stage.current
    const dockEl = dock.current
    if (!stageEl || !dockEl) return
    const measure = () => {
      const height = `${dockEl.offsetHeight}px`
      if (stageEl.style.getPropertyValue('--composer-h') !== height) { stageEl.style.setProperty('--composer-h', height); requestScroll('follow') }
      // The hero centres the card, not the dock: the strip under it and the wrap's padding would lift it off centre.
      const box = dockEl.classList.contains('composer-dock--hero') ? dockEl.querySelector('.composer-box') : null
      if (box) {
        const d = dockEl.getBoundingClientRect()
        const b = box.getBoundingClientRect()
        stageEl.style.setProperty('--composer-hero-shift', `${((d.bottom - b.bottom) - (b.top - d.top)) / 2}px`)
      }
      heroTop.current = dockEl.classList.contains('composer-dock--hero') ? dockEl.getBoundingClientRect().top : null
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(dockEl)
    ro.observe(stageEl)
    return () => ro.disconnect()
  }, [])
  const wasHero = useRef(hero)
  useLayoutEffect(() => {
    const dockEl = dock.current
    if (wasHero.current && !hero && heroTop.current !== null) beginDock(heroTop.current)
    wasHero.current = hero
    heroTop.current = hero && dockEl ? dockEl.getBoundingClientRect().top : null
    if (!hero && dockEl) playDock(dockEl)
  }, [hero])

  return (
    <>
      <div id="mainChat" className={cn(MAIN_VIEW, 'active')}>
        <div className="chat-header flex items-center gap-3 min-h-[52px] px-5 py-1.5 border-b border-border shrink-0 max-[641px]:hidden">
          <div className="chat-header-text min-w-0 flex-1 flex flex-col gap-px">
            <h1 className="chat-header-title m-0 text-[13.5px] font-[550] text-text whitespace-nowrap overflow-hidden text-ellipsis tracking-[-.01em]" id="topbarTitle">{session || listedTitle ? (title || m.untitled()) : bootstrap.bot_name}</h1>
            {session && meta && <div className="chat-header-meta hidden text-[11px] text-muted whitespace-nowrap overflow-hidden text-ellipsis font-mono" id="topbarMeta">{meta}</div>}
          </div>
          {/* T3 Code keeps the terminal toggle in the thread header; phones reach it from the composer's overflow menu. */}
          {sessionId && <button type="button" className={cn('icon-btn has-tooltip has-tooltip--left', terminalOpen && 'active')} id="btnTerminalInline" data-tooltip={m.composer_terminal_toggle()} aria-label={m.composer_terminal_toggle()} aria-pressed={terminalOpen} onClick={() => setTerminalOpen((t) => !t)}><TerminalSquare size={16} aria-hidden="true" /></button>}
          {/* TAL-373: the side panel's edge tab is hidden below 901px; tablets open it here, phones from the titlebar. */}
          {sessionId && <button type="button" className={cn('icon-btn chat-header-side-panel has-tooltip has-tooltip--left', sidePanelOpen && 'active')} id="btnSidePanelInline" data-tooltip={m.panel_label()} aria-label={m.panel_label()} aria-pressed={sidePanelOpen} onClick={toggleSidePanel}><PanelRight size={16} aria-hidden="true" /></button>}
        </div>
        {/* The first runtime notice, for screen readers: errors interrupt, everything else waits its turn. */}
        <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{runtime.announcement?.assertive ? runtime.announcement.text : ''}</div>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{runtime.announcement && !runtime.announcement.assertive ? runtime.announcement.text : ''}</div>
        {notFound && <div className="p-4"><ErrorState error={new Error(m.transcript_not_found())} onRetry={() => { void navigate({ to: '/', search: { action: 'new-chat' } }) }} /></div>}
        {otherProfile && <div className="p-4"><ErrorState error={new Error(m.transcript_other_profile({ profile: ((query.error as { body?: { profile?: string } }).body?.profile ?? '') }))} /></div>}
        {query.isError && !notFound && !otherProfile && <div className="p-4"><ErrorState error={query.error} onRetry={() => { void refresh() }} /></div>}
        <div ref={stage} className="chat-stage relative flex flex-1 min-h-0 flex-col">
        {!query.isError && (
          <Transcript
            disclosureScope={JSON.stringify([bootstrap.profile?.name ?? 'default', sessionId])}
            rows={shownRows}
            live={live}
            subscribeToStream
            assistantName={assistantName}
            mode={mode}
            renderUserMarkdown={!!settings.data?.render_user_markdown}
            autoFollow={settings.data?.auto_scroll_follow !== false}
            sessionId={sessionId ?? undefined}
            focusKey={focusKey}
            actions={actions}
            tts={!!(settings.data as Record<string, unknown> | undefined)?.tts_enabled}
            autoRead={(settings.data as Record<string, unknown> | undefined)?.tts_auto_read === true}
            truncated={truncated}
            loadedFrom={base}
            onLoadOlder={(retry, beforePrepend) => { void loadOlder(retry, beforePrepend) }}
            loadingOlder={loadingOlder}
            olderError={olderError}
            emptyState={query.isPending && !knownEmpty ? <TranscriptSkeleton /> : null}
            pendingUserText={pendingUserText}
            pendingAttachments={intent.send?.attachments}
            pendingPreviousStreamId={intent.send?.previousStreamId}
            showJumpButtons={(settings.data as Record<string, unknown> | undefined)?.session_jump_buttons !== false}
            virtualizeLongTranscripts={(settings.data as Record<string, unknown> | undefined)?.virtualize_transcript === true}
          />
        )}
        <div ref={dock} className={cn('composer-dock', hero && 'composer-dock--hero')}>
        {hero && <h2 className="composer-hero-title" id="emptyHeroTitle">{wsLabel ? m.empty_hero_title_workspace({ a0: wsLabel }) : m.empty_hero_title()}</h2>}
        <div className="composer-flyout">
          {sessionId && live?.approval && <ApprovalCard key={live.approval.approval_id} sessionId={sessionId} pending={live.approval} onResolved={() => dispatch({ type: 'clear_approval', sessionId })} />}
          {clarify && <ClarifyCard key={clarify.pending.clarify_id} clarify={clarify} />}
          {sessionId && vaultPrompt && <VaultPromptCard key={vaultPrompt.clarifyId} sessionId={sessionId} clarifyId={vaultPrompt.clarifyId} vault={vaultPrompt.vault} />}
          {live?.connectCard && <ConnectCard key={live.connectCard.op_id} initial={live.connectCard} />}
          {terminalOpen && sessionId && <Suspense fallback={
            <TerminalPanelFrame workspace={workspace} status="loading" onClose={() => setTerminalOpen(false)}>
              <div className="composer-terminal-surface px-2 py-1" style={{ height: 260 }} />
            </TerminalPanelFrame>
          }><TerminalPanel sessionId={sessionId} workspace={workspace} onClose={() => setTerminalOpen(false)} onReopen={() => setTerminalOpen(true)} /></Suspense>}
        </div>
        <Composer
          sessionId={sessionId}
          session={composerSession}
          pendingChoices={sessionId ? undefined : pending}
          busy={!!live && !isTerminal(live.status)}
          streamId={live?.streamId ?? null}
          settings={settings.data}
          onEnsureSession={ensureSession}
          onLocalCommand={onLocalCommand}
          terminalOpen={terminalOpen}
          onToggleTerminal={onToggleTerminal}
          onModelChange={onModelChange}
          onWorkspaceChange={onWorkspaceChange}
          // The server refuses worktrees for a profile without local I/O (a remote terminal backend), so none is offered.
          onNewWorktreeChat={bootstrap.features.terminal_remote_backend ? undefined : onNewWorktreeChat}
          onRemoveWorktree={sessionId && shownSession?.worktree_branch ? onRemoveWorktree : undefined}
          onToolsetsChange={onToolsetsChange}
          onExecutionModeChange={onExecutionModeChange}
          onReasoningChange={setReasoning}
          reasoning={reasoning}
          reasoningLevels={reasoningLevels}
          reasoningSupported={reasoningSupported}
          yolo={yoloOn}
          onToggleYolo={onToggleYolo}
          queued={queued}
          locked={compressingSince !== null || operation !== null || session?.owner_attachment?.can_submit === false}
          onQueue={onQueue}
          onQueueChange={setQueued}
          onOwnerAction={onOwnerAction}
          clarify={clarify}
          notices={notices}
        />
        </div>
        </div>
        <span className="sr-only" aria-live="polite" id="a11yAnnouncer">{live?.status === 'done' ? m.done() : ''}</span>
      </div>
      {/* Always mounted beside main (its queries run only while open) so opening and closing animate and the edge tab is always there. */}
      {editDialog}{modelDialog}
      {sessionId && removingWorktree && <WorktreeRemoveDialog sessionId={sessionId} onClose={() => setRemovingWorktree(false)} />}
      {sessionId && <ChatSidePanel key={sessionId} sessionId={sessionId} workspace={workspace} open={sidePanelOpen} onToggle={toggleSidePanel} onClose={() => setSidePanelOpen(false)} />}
    </>
  )
}
