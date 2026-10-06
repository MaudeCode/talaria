/**
 * Endpoint functions, one per route the application uses, all typed by the
 * contract package through the oRPC client (`orpc.ts`). Byte streams
 * (uploads, downloads, exports) keep the raw transport in `client.ts`.
 * Dead endpoints were deleted in TAL-245; do not add untyped routes here.
 */
import { orpc, timeout } from './orpc'
import { postForm } from './client'
import { loadedBuild, tabId } from '../app/tabBuild'
import { UploadResponseSchema, type ChatStartRequest, type SessionId, type SessionNewRequestSchema, type SteerRequestSchema, type ApprovalRespondRequestSchema, type ClarifyRespondRequestSchema, type DraftRequestSchema } from '../contracts'
import type { z } from 'zod'
import type { SteerSendNowRequestSchema, SteerWithdrawRequest } from '@maudecode/talaria-web-contracts'

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
const flag = (v: boolean | undefined) => (v ? '1' : undefined)
const num = (v: number | undefined) => (v === undefined ? undefined : String(v))

// Bootstrap and auth
export const fetchBootstrap = () => orpc().bootstrap()
export const login = (password: string) => orpc().auth.login({ password })
export const logout = () => orpc().auth.logout()
export const passkeyOptions = () => orpc().auth.passkeyOptions()
export const passkeyLogin = (credential: unknown) => orpc().auth.passkeyLogin(credential as Record<string, unknown>)
export const passkeyRegisterOptions = () => orpc().auth.passkeyRegisterOptions()
/** `label` is the server's field for the credential name. */
export const passkeyRegister = (credential: unknown, label?: string) => orpc().auth.passkeyRegister({ ...(credential as Record<string, unknown>), ...(label ? { name: label } : {}) })
export const passkeysList = () => orpc().auth.passkeys()
export const passkeyDelete = (id: string) => orpc().auth.passkeyDelete({ id })

// Settings, profiles, models
export const fetchSettings = () => orpc().settings.get()
export const saveSettings = (patch: Record<string, unknown>) => orpc().settings.save(patch)
export const checkExternalLink = (url: string) => orpc().settings.linkCheck({ url })
export const fetchProfiles = () => orpc().profiles.list()
export const fetchActiveProfile = () => orpc().profiles.active()
export const switchProfile = (name: string) => orpc().profiles.switch({ name })
export const createProfile = (body: Record<string, unknown>) => orpc().profiles.create(body)
export const deleteProfile = (name: string) => orpc().profiles.delete({ name })
export const fetchModels = (freshness?: 'session_visit') => orpc().models.list(freshness ? { freshness } : {})
/** config.yaml model.default (and provider): `/api/settings` does not persist `default_model`. */
export const setDefaultModel = (model: string, provider?: string | null) => orpc().models.setDefault({ model, ...(provider ? { provider } : {}) })
export const fetchAuxiliaryModels = () => orpc().models.auxiliary()
/** One auxiliary task slot (`__reset__` returns every slot to Auto); answers the refreshed `auxiliary` state. */
export const setAuxiliaryModel = (task: string, model: string, provider?: string | null) => orpc().models.set({ scope: 'auxiliary', task, model, ...(provider ? { provider } : {}) })
export const fetchProviders = () => orpc().providers.list()
export const fetchProviderQuotas = (refresh = false) => orpc().providers.quotas(refresh ? { refresh: '1' } : {}, { signal: timeout(45_000) })
export const fetchOpenRouterCostHistory = () => orpc().providers.costHistory({ provider: 'openrouter' }, { signal: timeout(45_000) })
export const setPersonality = (session_id: SessionId, personality: string | null) => orpc().personalities.set({ session_id, name: personality ?? '' })
/** Reasoning config shared with the CLI (config.yaml agent.reasoning_effort / display.show_reasoning). */
export const fetchReasoning = (model?: string | null, provider?: string | null) => orpc().reasoning.get({ ...(model ? { model } : {}), ...(provider ? { provider } : {}) })
/** `effort: ''` clears the override so the provider default applies. */
export const setReasoningEffort = (effort: string, model?: string | null, provider?: string | null) => orpc().reasoning.set({ effort, ...(model ? { model } : {}), ...(provider ? { provider } : {}) })
export const setReasoningDisplay = (display: 'show' | 'hide') => orpc().reasoning.set({ display })

// Sessions
export interface SessionListParams { include_archived?: boolean; all_profiles?: boolean; sidebar_source?: 'webui' | 'cli'; exclude_hidden?: boolean }
export const fetchSessions = (params: SessionListParams = {}) => orpc().sessions.list({ include_archived: flag(params.include_archived), all_profiles: flag(params.all_profiles), sidebar_source: params.sidebar_source, exclude_hidden: flag(params.exclude_hidden) }, { signal: timeout(45_000) })
/** The sidebar filters a search answers within (TAL-308); `project_id: 'none'` selects rows without a project. */
export interface SessionSearchFilters { project_id: string | undefined; sidebar_source: 'webui' | 'cli' | undefined; include_archived: boolean }
/** The sidebar's complete, ordered search result; rows carry `match_type` and, for content hits, `match_preview`. */
export const searchSessions = (q: string, filters: SessionSearchFilters, depth = 5) => orpc().sessions.search({ q, content: '1', depth: String(depth), project_id: filters.project_id, sidebar_source: filters.sidebar_source, include_archived: filters.include_archived ? '1' : '0' })
export interface SessionGetParams { messages?: boolean; msg_limit?: number; msg_before?: number; resolve_model?: boolean }
export const fetchSession = (id: SessionId, params: SessionGetParams = {}) =>
  orpc().session.get({ session_id: id, messages: params.messages === false ? '0' : undefined, msg_limit: num(params.msg_limit), msg_before: num(params.msg_before), resolve_model: params.resolve_model === false ? '0' : undefined }, { signal: timeout(60_000) })
export const fetchAnchorScene = (session_id: string, message_ref: string, message_index: number, before: number, signal: AbortSignal) => orpc().session.anchorSceneGet({ session_id, message_ref, message_index: String(message_index), before: String(before), limit: '80' }, { signal: AbortSignal.any([signal, timeout(30_000)]) })
/** TAL-331: the whole result of a scene tool row a limited response clipped (`result_truncated`). */
export const fetchToolResult = (session_id: string, tool_call_id: string, signal: AbortSignal) => orpc().session.toolResult({ session_id, tool_call_id }, { signal: AbortSignal.any([signal, timeout(30_000)]) })
export const fetchSessionStatus = (id: SessionId) => orpc().session.status({ session_id: id })
export const fetchSessionUsage = (id: SessionId) => orpc().session.usage({ session_id: id })
export const markSessionViewed = (session_id: SessionId) => orpc().talaria.viewed({ session_id })
export const newSession = (body: z.infer<typeof SessionNewRequestSchema>) => orpc().session.new(body)
export const renameSession = (session_id: SessionId, title: string) => orpc().session.rename({ session_id, title })
export const deleteSession = (session_id: SessionId) => orpc().session.delete({ session_id })
export const pinSession = (session_id: SessionId, pinned: boolean) => orpc().session.pin({ session_id, pinned })
export const archiveSession = (session_id: SessionId, archived: boolean) => orpc().session.archive({ session_id, archived })
export const moveSession = (session_id: SessionId, project_id: string | null) => orpc().session.move({ session_id, project_id })
export const duplicateSession = (session_id: SessionId) => orpc().session.duplicate({ session_id })
/** `keep_count`: number of messages (absolute, from the start of the session) to copy or keep; omit to fork the whole conversation. */
export const branchSession = (session_id: SessionId, keep_count?: number) => orpc().session.branch({ session_id, ...(keep_count !== undefined ? { keep_count } : {}) })
export const truncateSession = (session_id: SessionId, keep_count: number) => orpc().session.truncate({ session_id, keep_count })
export const undoSession = (session_id: SessionId) => orpc().session.undo({ session_id })
export const retrySession = (session_id: SessionId) => orpc().session.retry({ session_id })
export const clearSession = (session_id: SessionId) => orpc().session.clear({ session_id })
export const regenerateTitle = (session_id: SessionId) => orpc().session.regenerateTitle({ session_id }, { signal: timeout(60_000) })
export const exportSessionUrl = (session_id: SessionId, format: 'json' | 'markdown' | 'html' = 'json') => `api/session/export${qs({ session_id, format })}`
export const updateSession = (session_id: SessionId, body: { model?: string; model_provider?: string | null; workspace?: string }) => orpc().session.update({ session_id, ...body })
export const setSessionYolo = (session_id: SessionId, enabled: boolean) => orpc().session.yoloSet({ session_id, enabled })
export const fetchSessionYolo = (session_id: SessionId) => orpc().session.yoloGet({ session_id })
export const setSessionToolsets = (session_id: SessionId, toolsets: string[] | null) => orpc().session.toolsets({ session_id, toolsets })
export const compressSession = (session_id: SessionId) => orpc().session.compressStart({ session_id })
export const compressStatus = (session_id: SessionId) => orpc().session.compressStatus({ session_id })
export const saveDraft = (body: z.infer<typeof DraftRequestSchema>) => orpc().session.draftSave({ session_id: body.session_id, text: body.draft.text, files: body.draft.files ?? [], draft_version: body.draft_version ?? null })

export const fetchProjects = () => orpc().projects.list({})
export const createProject = (name: string, color?: string) => orpc().projects.create({ name, color: color ?? null })

// Chat
export const startChat = (body: ChatStartRequest) => orpc().chat.start(body, { signal: timeout(60_000) })
export const cancelChat = (stream_id: string) => orpc().chat.cancel({ stream_id })
export const steerChat = (body: z.infer<typeof SteerRequestSchema>) => orpc().chat.steer(body)
export const withdrawSteer = (body: SteerWithdrawRequest) => orpc().chat.steerWithdraw(body)
export const sendSteerNow = (body: z.infer<typeof SteerSendNowRequestSchema>) => orpc().chat.steerSendNow(body)
export const fetchStreamStatus = (stream_id: string) => orpc().chat.streamStatus({ stream_id })
export const respondApproval = (body: z.infer<typeof ApprovalRespondRequestSchema>) => orpc().approval.respond(body)
export const fetchClarifyPending = (session_id: string) => orpc().clarify.pending({ session_id })
export const respondClarify = (body: z.infer<typeof ClarifyRespondRequestSchema>) => orpc().clarify.respond(body)
export const uploadFile = (session_id: SessionId, file: File) => {
  const form = new FormData()
  form.set('session_id', session_id)
  form.set('file', file, file.name)
  return postForm(`api/upload${qs({ session_id })}`, form, UploadResponseSchema, { timeoutMs: 120_000 })
}
export const rollbackUpload = (session_id: SessionId, rollback_tokens: string[]) => orpc().upload.rollback({ session_id, rollback_tokens })
export const goalCommand = (session_id: SessionId, action: string, text?: string) => orpc().goal({ session_id, args: action, ...(text !== undefined ? { text } : {}) })
// TAL-372: the session's background work, one shared record each; reading never consumes a result.
export const startBackground = (session_id: SessionId, prompt: string) => orpc().background.start({ session_id, prompt })
export const fetchBackgroundTasks = (session_id: SessionId, kind?: 'delegation' | 'process' | 'background_command') => orpc().background.tasks({ session_id, ...(kind ? { kind } : {}) })
export const fetchBackgroundResult = (session_id: SessionId, task_id: string) => orpc().background.result({ session_id, task_id })
export const dismissBackgroundTask = (session_id: SessionId, task_id: string) => orpc().background.dismiss({ session_id, task_id })
// TAL-518: `/btw` answers in a hidden copy of the chat; the reply streams on the returned `stream_id`.
export const askBtw = (session_id: SessionId, question: string) => orpc().btw({ session_id, question })
export const createShare = (session_id: SessionId) => orpc().share.create({ session_id })
export const revokeShare = (session_id: SessionId) => orpc().share.revoke({ session_id })
export const fetchShare = (token: string) => orpc().share.read({ token })
export const fetchCommands = () => orpc().commands.list()
export const execCommand = (command: string, session_id?: SessionId) => orpc().commands.exec({ command, ...(session_id ? { session_id } : {}) })

// Workspaces and files
export const fetchWorkspaces = () => orpc().workspaces.list()
export const addWorkspace = (path: string, name?: string) => orpc().workspaces.add({ path, ...(name ? { name } : {}) })
export const removeWorkspace = (path: string) => orpc().workspaces.remove({ path })
export const renameWorkspace = (path: string, name: string) => orpc().workspaces.rename({ path, name })
export const reorderWorkspaces = (paths: string[]) => orpc().workspaces.reorder({ paths })
export const suggestWorkspaces = (prefix: string) => orpc().workspaces.suggest({ prefix })
export const listDir = (session_id: string, path = '.', showHidden = false) => orpc().files.list({ session_id, path, ...(showHidden ? { show_hidden: '1' } : {}) })
export const readFile = (session_id: string, path: string) => orpc().files.read({ session_id, path })
export const rawFileUrl = (session_id: string, path: string) => `api/file/raw${qs({ session_id, path })}`
export const saveFile = (session_id: string, path: string, content: string) => orpc().files.save({ session_id, path, content })
export const createFile = (session_id: string, path: string) => orpc().files.create({ session_id, path, content: '' })
export const createDir = (session_id: string, path: string) => orpc().files.createDir({ session_id, path })
export const renameEntry = (session_id: string, path: string, new_name: string) => orpc().files.rename({ session_id, path, new_name })
export const moveEntry = (session_id: string, path: string, dest_dir: string) => orpc().files.move({ session_id, path, dest_dir })
export const deleteEntry = (session_id: string, path: string, recursive: boolean) => orpc().files.delete({ session_id, path, recursive })
export const revealEntry = (session_id: string, path: string) => orpc().files.reveal({ session_id, path })
export const openInVsCode = (session_id: string, path: string) => orpc().files.openVsCode({ session_id, path })
export const folderDownloadUrl = (session_id: string, path: string) => `api/folder/download${qs({ session_id, path })}`
export const fetchGitInfo = (sessionId: string) => orpc().gitInfo({ session_id: sessionId })

// Panels
export const fetchSkills = (category?: string) => orpc().skills.list(category ? { category } : {})
export const fetchSkillContent = (name: string) => orpc().skills.content({ name })
export const saveSkill = (name: string, content: string) => orpc().skills.save({ name, content })
export const deleteSkill = (name: string) => orpc().skills.delete({ name })
export const toggleSkill = (name: string, enabled: boolean) => orpc().skills.toggle({ name, enabled })
export const fetchSkillsUsage = () => orpc().skills.usage()
export const fetchMemory = (workspace?: string) => orpc().memory.get(workspace ? { workspace } : {})
/** `section` names the file: `memory`, `user`, or `soul`. */
export const writeMemory = (body: { section: 'memory' | 'user' | 'soul'; content: string }) => orpc().memory.write(body)
export const fetchCronContextSources = (input: { profile?: string; editing_job_id?: string; exclude_job_id?: string; selected_refs?: string[] }) => orpc().crons.contextSources(input)
export const fetchCrons = (allProfiles = false) => orpc().crons.list(allProfiles ? { all_profiles: '1' } : {})
export const cronAction = (action: 'create' | 'update' | 'delete' | 'run' | 'pause' | 'resume', body: Record<string, unknown>) => {
  const c = orpc().crons
  if (action === 'create') return c.create(body)
  if (action === 'update') return c.update(body)
  if (action === 'delete') return c.delete(body)
  if (action === 'run') return c.runNow(body)
  if (action === 'pause') return c.pause(body)
  return c.resume(body)
}
export const fetchCronHistory = (job_id: string, limit = 50) => orpc().crons.history({ job_id, limit: String(limit) })
export const fetchCronRun = (job_id: string, filename: string) => orpc().crons.run({ job_id, filename })
export const fetchCronDeliveryOptions = () => orpc().crons.deliveryOptions()
export const fetchCronStatus = () => orpc().crons.status({})
export const fetchKanbanBoards = () => orpc().kanban.boards({})
export const fetchKanbanBoard = (params: Record<string, string | boolean | undefined> = {}) => orpc().kanban.board(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : v])))
export const switchKanbanBoard = (slug: string) => orpc().kanban.switchBoard({ slug })
/** The real task action set: `patch`, `comments`, `block`, `unblock`, `dispatch` (archive is `patch {status: 'archived'}`). */
export const kanbanTaskAction = (id: string | number, action: 'patch' | 'comments' | 'block' | 'unblock' | 'dispatch', body: Record<string, unknown>) => {
  const k = orpc().kanban
  const task_id = String(id)
  if (action === 'comments') return k.comment({ task_id, ...body })
  if (action === 'block') return k.block({ task_id, ...body })
  if (action === 'unblock') return k.unblock({ task_id, ...body })
  if (action === 'dispatch') return k.dispatch({})
  return k.patch({ task_id, ...body })
}
export const createKanbanTask = (body: Record<string, unknown>) => orpc().kanban.createTask(body)
export const fetchKanbanTaskLog = (id: string | number) => orpc().kanban.taskLog({ task_id: String(id) })
export const fetchInsights = (days: number) => orpc().insights({ days: String(days) })
export const fetchLogs = (file: string, tail: number) => orpc().logs({ file, tail: String(tail) })
export const fetchOnboarding = () => orpc().onboarding.status(undefined, { signal: timeout(45_000) })
export const onboardingSetup = (body: Record<string, unknown>) => orpc().onboarding.setup(body, { signal: timeout(60_000) })
export const onboardingProbe = (body: Record<string, unknown>) => orpc().onboarding.probe(body, { signal: timeout(60_000) })
export const onboardingComplete = (body: Record<string, unknown> = {}) => orpc().onboarding.complete(body)
export const onboardingOauthStart = (provider: string) => orpc().onboarding.oauthStart({ provider }, { signal: timeout(60_000) })
export const onboardingOauthPoll = (flowId: string) => orpc().onboarding.oauthPoll({ flow_id: flowId })
export const onboardingOauthCancel = (flowId: string) => orpc().onboarding.oauthCancel({ flow_id: flowId })
export const fetchExtensionRegistry = () => orpc().extensions.registry(undefined, { signal: timeout(45_000) })
export const extensionAction = (action: 'install' | 'uninstall' | 'toggle' | 'sidecar-proxy-consent', body: Record<string, unknown>) => {
  const e = orpc().extensions
  const opts = { signal: timeout(120_000) }
  if (action === 'install') return e.install(body, opts)
  if (action === 'uninstall') return e.uninstall(body, opts)
  if (action === 'toggle') return e.toggle(body, opts)
  return e.consent(body, opts)
}
export const fetchDashboardStatus = () => orpc().ops.dashboard()
export const fetchAgentHealth = () => orpc().ops.agent()
export const restartAgent = () => orpc().ops.restart({}, { signal: timeout(120_000) })
export const fetchSystemHealth = () => orpc().ops.system()
/** Passive reader: the server answers from cache and never fetches. */
export const fetchUpdatesCheck = () => orpc().updates.check(undefined, { signal: timeout(45_000) })
/** Manual "Check now": only POST `{force:true}` runs a real update check; an explicit `channel` wins over the persisted setting. */
export const checkUpdatesNow = (channel?: string, agentChannel?: 'stable' | 'experimental') => orpc().updates.checkNow({ force: true, ...(channel ? { channel } : {}), ...(agentChannel ? { agent_channel: agentChannel } : {}) }, { signal: timeout(120_000) })
export const applyUpdates = (action: 'apply' | 'force' | 'clear_lock', channel?: string, target: 'webui' | 'agent' = 'webui', agentOptions: { agent_channel?: 'stable' | 'experimental'; confirmed_agent_revision?: string } = {}) => {
  const u = orpc().updates
  // The tab id lets this tab's Updating dialog follow the operation the server starts.
  const body = { target, ...(channel ? { channel } : {}), ...agentOptions, tab_id: tabId }
  const opts = { signal: timeout(300_000) }
  return action === 'apply' ? u.apply(body, opts) : action === 'force' ? u.force(body, opts) : u.clearLock(body, opts)
}
/** Every call names this tab so the server can show and resolve its tab-scoped refresh notice. */
export const fetchUpdateNotifications = () => orpc().updateNotifications.list({ tab_id: tabId, loaded_build: loadedBuild })
export const readUpdateNotification = (id: string) => orpc().updateNotifications.read({ id, read: true, tab_id: tabId })
export const dismissUpdateNotification = (id: string) => orpc().updateNotifications.dismiss({ id, dismiss: true, tab_id: tabId })
export const clearUpdateNotifications = () => orpc().updateNotifications.clear({ clear: true, tab_id: tabId, loaded_build: loadedBuild })
export const cancelUpdateNotification = (id: string) => orpc().updateNotifications.cancel({ id, cancel: true })
export const performUpdateNotificationAction = (id: string, action_id: string) => orpc().updateNotifications.action({ id, action_id, perform: true, tab_id: tabId })
export const fetchPlugins = () => orpc().plugins()
export const shutdownServer = () => orpc().ops.shutdown({})
