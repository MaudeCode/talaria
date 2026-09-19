/**
 * Typed endpoint functions: one per Python route the frontend uses. Each pairs
 * a path with the response schema. React modules call these (or the Query
 * hooks built on them) and never see unchecked JSON.
 */
import { z } from 'zod'
import { get, post, postForm } from './client'
import {
  ActiveProfileSchema, AgentHealthSchema, ApprovalPendingEnvelopeSchema, ApprovalRespondRequestSchema, AuthStatusSchema, AuxiliaryModelsSchema,
  BackgroundStatusSchema, BootstrapSchema, CancelResponseSchema, ChatStartRequestSchema, ChatStartResponseSchema, ClarifyPendingEnvelopeSchema,
  ClarifyRespondRequestSchema, ClarifyRespondResponseSchema, CommandsSchema, CronHistorySchema, CronMutationSchema, CronRunSchema, CronStatusSchema, CronsSchema, DashboardStatusSchema, DirListingSchema,
  DraftRequestSchema, DraftResponseSchema, ExtensionStatusSchema, FileContentSchema, GitInfoSchema, GoalResponseSchema, InsightsSchema,
  KanbanBoardSchema, KanbanBoardsSchema, LoginResponseSchema, LogsSchema, McpServersSchema, MemorySchema, ModelsSchema, NotesSourcesSchema, OkSchema,
  OnboardingOAuthSchema, OnboardingProbeSchema, OnboardingStatusSchema, PersonalitiesSchema, PluginsSchema, ProfilesSchema, ProjectsSchema,
  PromptsSchema, ProviderQuotasSchema, ProvidersSchema, SessionDeleteResultSchema, SessionEnvelopeSchema, SessionIdSchema, SessionNewRequestSchema,
  SessionStatusSchema, SessionUsageSchema, SessionsListSchema, SettingsSchema, ShareCreateResponseSchema, ShareReadSchema, SkillContentSchema,
  SkillsSchema, SkillsUsageSchema, SteerRequestSchema, SteerResponseSchema, StreamStatusSchema, SystemHealthSchema, TranscribeCapabilitySchema,
  UpdateApplySchema, UpdatesCheckSchema, UpdatesSummarySchema, UploadResponseSchema, WorkspacesSchema,
  type ChatStartRequest, type SessionId, ReasoningStatusSchema, SessionRowSchema, NullableString } from '../contracts'

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

// Bootstrap and auth
export const fetchBootstrap = () => get('api/bootstrap', BootstrapSchema, { retries: 1, redirect401: false })
export const fetchAuthStatus = () => get('api/auth/status', AuthStatusSchema, { redirect401: false })
export const login = (password: string) => post('api/auth/login', { password }, LoginResponseSchema, { redirect401: false, retries: 0 })
export const logout = () => post('api/auth/logout', {}, OkSchema, { redirect401: false, retries: 0 })
export const passkeyOptions = () => post('api/auth/passkey/options', {}, z.looseObject({ publicKey: z.unknown().optional(), error: z.string().optional() }), { redirect401: false, retries: 0 })
export const passkeyLogin = (credential: unknown) => post('api/auth/passkey/login', credential, LoginResponseSchema, { redirect401: false, retries: 0 })
export const passkeyRegisterOptions = () => post('api/auth/passkey/register/options', {}, z.looseObject({ publicKey: z.unknown().optional(), error: z.string().optional() }), { retries: 0 })
export const passkeyRegister = (credential: unknown, name?: string) => post('api/auth/passkey/register', { ...(credential as object), name }, OkSchema, { retries: 0 })
export const passkeysList = () => get('api/auth/passkeys', z.looseObject({ passkeys: z.array(z.looseObject({ id: z.string(), name: z.string().optional(), created_at: z.unknown().optional() })).optional() }))
export const passkeyDelete = (id: string) => post('api/auth/passkey/delete', { id }, OkSchema, { retries: 0 })

// Settings, profiles, models
export const fetchSettings = () => get('api/settings', SettingsSchema)
export const saveSettings = (patch: Record<string, unknown>) => post('api/settings', patch, SettingsSchema.or(OkSchema), { retries: 0 })
export const fetchProfiles = () => get('api/profiles', ProfilesSchema)
export const fetchActiveProfile = () => get('api/profile/active', ActiveProfileSchema)
export const switchProfile = (name: string) => post('api/profile/switch', { name, profile: name }, OkSchema.or(z.looseObject({})), { retries: 0 })
export const createProfile = (body: Record<string, unknown>) => post('api/profile/create', body, z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), profile: z.unknown().optional() }), { retries: 0 })
export const deleteProfile = (name: string) => post('api/profile/delete', { name, profile: name }, OkSchema, { retries: 0 })
export const fetchModels = (freshness?: 'session_visit') => get(`api/models${qs({ freshness })}`, ModelsSchema)
export const refreshModels = () => post('api/models/refresh', {}, ModelsSchema.or(OkSchema), { retries: 0, timeoutMs: 60_000 })
export const setSessionModel = (body: { session_id: SessionId; model: string; model_provider?: string | null; explicit?: boolean }) => post('api/model/set', body, z.looseObject({ ok: z.boolean().optional(), session: z.unknown().optional(), error: z.string().optional() }), { retries: 0 })
/** config.yaml model.default (and provider): `/api/settings` does not persist `default_model`. */
export const setDefaultModel = (model: string, provider?: string | null) => post('api/default-model', { model, ...(provider ? { provider } : {}) }, OkSchema, { retries: 0 })
export const fetchProviders = () => get('api/providers', ProvidersSchema)
export const fetchProviderQuotas = (refresh = false) => get(`api/provider/quotas${qs({ refresh: refresh ? 1 : undefined })}`, ProviderQuotasSchema, { retries: 0, timeoutMs: 45_000 })
export const fetchPersonalities = () => get('api/personalities', PersonalitiesSchema)
export const setPersonality = (session_id: SessionId, personality: string | null) => post('api/personality/set', { session_id, personality }, OkSchema, { retries: 0 })
export const fetchAuxiliaryModels = () => get('api/model/auxiliary', AuxiliaryModelsSchema)
/** Reasoning config shared with the CLI (config.yaml agent.reasoning_effort / display.show_reasoning). */
export const fetchReasoning = (model?: string | null, provider?: string | null) => get(`api/reasoning${qs({ model: model ?? undefined, provider: provider ?? undefined })}`, ReasoningStatusSchema)
/** `effort: ''` clears the override so the provider default applies. */
export const setReasoningEffort = (effort: string, model?: string | null, provider?: string | null) => post('api/reasoning', { effort, ...(model ? { model } : {}), ...(provider ? { provider } : {}) }, ReasoningStatusSchema, { retries: 0 })
export const setReasoningDisplay = (display: 'show' | 'hide') => post('api/reasoning', { display }, ReasoningStatusSchema, { retries: 0 })

// Sessions
export interface SessionListParams { include_archived?: boolean; all_profiles?: boolean; sidebar_source?: 'webui' | 'cli'; exclude_hidden?: boolean }
export const fetchSessions = (params: SessionListParams = {}) => get(`api/sessions${qs({ include_archived: params.include_archived ? 1 : undefined, all_profiles: params.all_profiles ? 1 : undefined, sidebar_source: params.sidebar_source, exclude_hidden: params.exclude_hidden ? 1 : undefined })}`, SessionsListSchema, { timeoutMs: 45_000 })
/** Title and message-content search; rows carry `match_type` and, for content hits, `match_preview`. */
export const searchSessions = (q: string, depth = 5) => get(`api/sessions/search${qs({ q, content: 1, depth })}`, z.looseObject({ sessions: z.array(SessionRowSchema.extend({ match_type: z.string().optional(), match_preview: NullableString.optional() })), count: z.number().optional() }))
export interface SessionGetParams { messages?: boolean; msg_limit?: number; msg_before?: number; resolve_model?: boolean }
export const fetchSession = (id: SessionId, params: SessionGetParams = {}) =>
  get(`api/session${qs({ session_id: id, messages: params.messages === false ? 0 : undefined, msg_limit: params.msg_limit, msg_before: params.msg_before, resolve_model: params.resolve_model === false ? 0 : undefined })}`, SessionEnvelopeSchema, { timeoutMs: 60_000 })
export const fetchSessionStatus = (id: SessionId) => get(`api/session/status${qs({ session_id: id })}`, SessionStatusSchema)
export const fetchSessionUsage = (id: SessionId) => get(`api/session/usage${qs({ session_id: id })}`, SessionUsageSchema)
export const newSession = (body: z.infer<typeof SessionNewRequestSchema>) => post('api/session/new', SessionNewRequestSchema.parse(body), SessionEnvelopeSchema, { retries: 0 })
export const renameSession = (session_id: SessionId, title: string) => post('api/session/rename', { session_id, title }, SessionEnvelopeSchema, { retries: 0 })
export const deleteSession = (session_id: SessionId) => post('api/session/delete', { session_id }, SessionDeleteResultSchema, { retries: 0 })
export const pinSession = (session_id: SessionId, pinned: boolean) => post('api/session/pin', { session_id, pinned }, OkSchema.or(SessionEnvelopeSchema), { retries: 0 })
export const archiveSession = (session_id: SessionId, archived: boolean) => post('api/session/archive', { session_id, archived }, OkSchema.or(SessionEnvelopeSchema), { retries: 0 })
export const moveSession = (session_id: SessionId, project_id: string | null) => post('api/session/move', { session_id, project_id }, OkSchema.or(SessionEnvelopeSchema), { retries: 0 })
export const duplicateSession = (session_id: SessionId) => post('api/session/duplicate', { session_id }, SessionEnvelopeSchema, { retries: 0 })
/** `keep_count`: number of messages (absolute, from the start of the session) to copy or keep. */
/** Omit `keep_count` to fork the complete conversation (the server counts raw messages, not rendered rows). */
export const branchSession = (session_id: SessionId, keep_count?: number) => post('api/session/branch', { session_id, ...(keep_count !== undefined ? { keep_count } : {}) }, z.looseObject({ session_id: SessionIdSchema, title: z.string().optional(), parent_session_id: NullableString.optional() }), { retries: 0 })
export const truncateSession = (session_id: SessionId, keep_count: number) => post('api/session/truncate', { session_id, keep_count }, SessionEnvelopeSchema.or(OkSchema), { retries: 0 })
export const undoSession = (session_id: SessionId) => post('api/session/undo', { session_id }, SessionEnvelopeSchema.or(OkSchema), { retries: 0 })
export const retrySession = (session_id: SessionId) => post('api/session/retry', { session_id }, ChatStartResponseSchema.or(OkSchema), { retries: 0 })
export const clearSession = (session_id: SessionId) => post('api/session/clear', { session_id }, SessionEnvelopeSchema.or(OkSchema), { retries: 0 })
export const regenerateTitle = (session_id: SessionId) => post('api/session/title/regenerate', { session_id }, z.looseObject({ ok: z.boolean().optional(), title: z.string().optional(), error: z.string().optional() }), { retries: 0, timeoutMs: 60_000 })
export const importSession = (payload: unknown) => post('api/session/import', payload, SessionEnvelopeSchema.or(OkSchema), { retries: 0 })
export const importCliSession = (session_id: string) => post('api/session/import_cli', { session_id }, SessionEnvelopeSchema.or(OkSchema), { retries: 0, timeoutMs: 60_000 })
export const exportSessionUrl = (session_id: SessionId, format: 'json' | 'markdown' | 'html' = 'json') => `api/session/export${qs({ session_id, format })}`
export const updateSession = (session_id: SessionId, body: { model?: string; model_provider?: string | null; workspace?: string }) => post('api/session/update', { session_id, ...body }, SessionEnvelopeSchema.or(OkSchema), { retries: 0 })
export const setSessionYolo = (session_id: SessionId, enabled: boolean) => post('api/session/yolo', { session_id, enabled }, z.looseObject({ yolo_enabled: z.boolean().optional(), ok: z.boolean().optional() }), { retries: 0 })
export const fetchSessionYolo = (session_id: SessionId) => get(`api/session/yolo${qs({ session_id })}`, z.looseObject({ yolo_enabled: z.boolean() }))
export const setSessionToolsets = (session_id: SessionId, toolsets: string[] | null) => post('api/session/toolsets', { session_id, toolsets }, OkSchema.or(SessionEnvelopeSchema), { retries: 0 })
export const compressSession = (session_id: SessionId) => post('api/session/compress/start', { session_id }, z.looseObject({ ok: z.boolean().optional(), job_id: z.string().optional(), error: z.string().optional() }), { retries: 0 })
export const compressStatus = (session_id: SessionId) => get(`api/session/compress/status${qs({ session_id })}`, z.looseObject({ status: z.enum(['running', 'done', 'error', 'idle']).or(z.string()).optional(), session: z.looseObject({ session_id: SessionIdSchema }).optional(), session_id: NullableString.optional(), error: z.string().optional() }))
export const handoffSummary = (session_id: SessionId) => post('api/session/handoff-summary', { session_id }, z.looseObject({ ok: z.boolean().optional(), summary: z.string().optional(), error: z.string().optional() }), { retries: 0, timeoutMs: 90_000 })
export const saveDraft = (body: z.infer<typeof DraftRequestSchema>) => post('api/session/draft', body, DraftResponseSchema, { retries: 0, timeoutMs: 8000 })
export const worktreeStatus = (session_id: SessionId) => get(`api/session/worktree/status${qs({ session_id })}`, z.looseObject({ status: z.unknown() }))
export const worktreeRemove = (session_id: SessionId, force = false) => post('api/session/worktree/remove', { session_id, force }, OkSchema, { retries: 0 })
export const cleanupZeroMessageSessions = () => post('api/sessions/cleanup_zero_message', {}, z.looseObject({ removed: z.number().optional(), ok: z.boolean().optional() }), { retries: 0 })

export const fetchProjects = () => get('api/projects', ProjectsSchema)
export const createProject = (name: string, color?: string) => post('api/projects/create', { name, color }, z.looseObject({ ok: z.boolean().optional(), project: z.unknown().optional() }), { retries: 0 })
export const renameProject = (id: string, name: string) => post('api/projects/rename', { id, name }, OkSchema, { retries: 0 })
export const deleteProject = (id: string) => post('api/projects/delete', { id }, OkSchema, { retries: 0 })

// Chat
export const startChat = (body: ChatStartRequest) => post('api/chat/start', ChatStartRequestSchema.parse(body), ChatStartResponseSchema, { retries: 0, timeoutMs: 60_000 })
export const cancelChat = (stream_id: string) => get(`api/chat/cancel${qs({ stream_id })}`, CancelResponseSchema, { retries: 0, dedupe: false })
export const steerChat = (body: z.infer<typeof SteerRequestSchema>) => post('api/chat/steer', body, SteerResponseSchema, { retries: 0 })
export const fetchStreamStatus = (stream_id: string) => get(`api/chat/stream/status${qs({ stream_id })}`, StreamStatusSchema, { dedupe: false })
export const fetchApprovalPending = (session_id: SessionId) => get(`api/approval/pending${qs({ session_id })}`, ApprovalPendingEnvelopeSchema, { dedupe: false })
export const respondApproval = (body: z.infer<typeof ApprovalRespondRequestSchema>) => post('api/approval/respond', body, z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), pending_count: z.number().optional() }), { retries: 0 })
export const fetchClarifyPending = (session_id: SessionId) => get(`api/clarify/pending${qs({ session_id })}`, ClarifyPendingEnvelopeSchema, { dedupe: false })
export const respondClarify = (body: z.infer<typeof ClarifyRespondRequestSchema>) => post('api/clarify/respond', body, ClarifyRespondResponseSchema, { retries: 0 })
export const uploadFile = (session_id: SessionId, file: File) => {
  const form = new FormData()
  form.set('session_id', session_id)
  form.set('file', file, file.name)
  return postForm(`api/upload${qs({ session_id })}`, form, UploadResponseSchema, { timeoutMs: 120_000 })
}
export const rollbackUpload = (session_id: SessionId, rollback_tokens: string[]) => post('api/upload/rollback', { session_id, rollback_tokens }, OkSchema, { retries: 0 })
export const goalCommand = (session_id: SessionId, action: string, text?: string) => post('api/goal', { session_id, action, text }, GoalResponseSchema, { retries: 0 })
export const fetchBackground = (session_id: SessionId) => get(`api/background/status${qs({ session_id })}`, BackgroundStatusSchema, { dedupe: false })
export const ackBackgroundTask = (session_id: SessionId, task_id: string) => post('api/bg-task-complete-ack', { session_id, task_id }, OkSchema, { retries: 0 })
export const ackProcessComplete = (session_id: SessionId, id: string) => post('api/process-complete-ack', { session_id, id }, OkSchema, { retries: 0 })
export const createShare = (session_id: SessionId) => post('api/share/create', { session_id }, ShareCreateResponseSchema, { retries: 0 })
export const revokeShare = (session_id: SessionId) => post('api/share/revoke', { session_id }, OkSchema, { retries: 0 })
export const fetchShare = (token: string) => get(`api/share/${encodeURIComponent(token)}`, ShareReadSchema, { redirect401: false })
export const fetchCommands = () => get('api/commands', CommandsSchema)
export const execCommand = (session_id: SessionId, command: string) => post('api/commands/exec', { session_id, command }, z.looseObject({ ok: z.boolean().optional(), output: z.string().optional(), message: z.string().optional(), error: z.string().optional(), action: z.string().optional() }), { retries: 0, timeoutMs: 60_000 })
export const fetchPrompts = () => get('api/prompts', PromptsSchema)
export const savePrompts = (prompts: unknown[]) => post('api/prompts', { prompts }, PromptsSchema.or(OkSchema), { retries: 0 })
export const transcribeCapability = () => get('api/transcribe/capability', TranscribeCapabilitySchema)
export const speakUrl = () => 'api/tts'

// Workspaces and files
export const fetchWorkspaces = () => get('api/workspaces', WorkspacesSchema)
export const addWorkspace = (path: string, name?: string) => post('api/workspaces/add', { path, name }, WorkspacesSchema.or(z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), workspace: z.unknown().optional() })), { retries: 0 })
export const removeWorkspace = (path: string) => post('api/workspaces/remove', { path }, WorkspacesSchema.or(OkSchema), { retries: 0 })
export const renameWorkspace = (path: string, name: string) => post('api/workspaces/rename', { path, name }, WorkspacesSchema.or(OkSchema), { retries: 0 })
export const reorderWorkspaces = (paths: string[]) => post('api/workspaces/reorder', { paths }, WorkspacesSchema.or(OkSchema), { retries: 0 })
export const suggestWorkspaces = (prefix: string) => get(`api/workspaces/suggest${qs({ prefix })}`, z.looseObject({ suggestions: z.array(z.string()), prefix: z.string().optional() }))
export const listDir = (session_id: string, path = '.', showHidden = false) => get(`api/list${qs({ session_id, path, show_hidden: showHidden ? 1 : undefined })}`, DirListingSchema)
export const readFile = (session_id: string, path: string) => get(`api/file${qs({ session_id, path })}`, FileContentSchema, { timeoutMs: 60_000 })
export const rawFileUrl = (session_id: string, path: string) => `api/file/raw${qs({ session_id, path })}`
export const saveFile = (session_id: string, path: string, content: string) => post('api/file/save', { session_id, path, content }, OkSchema, { retries: 0 })
export const createFile = (session_id: string, path: string) => post('api/file/create', { session_id, path }, OkSchema, { retries: 0 })
export const createDir = (session_id: string, path: string) => post('api/file/create-dir', { session_id, path }, OkSchema, { retries: 0 })
export const deleteFile = (session_id: string, path: string) => post('api/file/delete', { session_id, path }, OkSchema, { retries: 0 })
export const renameFile = (session_id: string, path: string, new_name: string) => post('api/file/rename', { session_id, path, new_name }, OkSchema, { retries: 0 })
export const moveFile = (session_id: string, path: string, destination: string) => post('api/file/move', { session_id, path, destination }, OkSchema, { retries: 0 })
export const revealFile = (session_id: string, path: string) => post('api/file/reveal', { session_id, path }, OkSchema, { retries: 0 })
export const openInVsCode = (session_id: string, path: string) => post('api/file/open-vscode', { session_id, path }, OkSchema, { retries: 0 })
export const folderDownloadUrl = (session_id: string, path: string) => `api/folder/download${qs({ session_id, path })}`
export const fetchGitInfo = (sessionId: string) => get(`api/git-info${qs({ session_id: sessionId })}`, GitInfoSchema)
export const fetchGitStatus = (sessionId: string) => get(`api/git/status${qs({ session_id: sessionId })}`, z.looseObject({ status: z.unknown().optional(), files: z.array(z.unknown()).optional(), branch: z.string().optional(), error: z.string().optional() }))
export const fetchGitDiff = (session_id: string, path?: string, staged?: boolean) => get(`api/git/diff${qs({ session_id, path, staged: staged ? 1 : undefined })}`, z.looseObject({ diff: z.string().optional(), error: z.string().optional() }))
export const fetchGitBranches = (session_id: string) => get(`api/git/branches${qs({ session_id })}`, z.looseObject({ branches: z.array(z.unknown()).optional(), current: z.string().optional() }))
export const gitAction = (action: 'stage' | 'unstage' | 'discard' | 'commit' | 'commit-selected' | 'fetch' | 'pull' | 'push' | 'checkout' | 'stash-checkout' | 'commit-message' | 'commit-message-selected', body: Record<string, unknown>) =>
  post(`api/git/${action}`, body, z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), message: z.string().optional(), output: z.string().optional() }), { retries: 0, timeoutMs: 120_000 })
export const fetchRollbackList = (workspace: string) => get(`api/rollback/list${qs({ workspace })}`, z.looseObject({ checkpoints: z.array(z.unknown()).optional() }))
export const fetchRollbackDiff = (workspace: string, id: string) => get(`api/rollback/diff${qs({ workspace, id })}`, z.looseObject({ diff: z.string().optional(), files_changed: z.number().optional() }))
export const restoreRollback = (workspace: string, id: string) => post('api/rollback/restore', { workspace, id }, OkSchema, { retries: 0 })

// Panels
export const fetchSkills = (category?: string) => get(`api/skills${qs({ category })}`, SkillsSchema)
export const fetchSkillContent = (name: string) => get(`api/skills/content${qs({ name })}`, SkillContentSchema)
export const saveSkill = (name: string, content: string) => post('api/skills/save', { name, content }, SkillContentSchema.or(OkSchema), { retries: 0 })
export const deleteSkill = (name: string) => post('api/skills/delete', { name }, OkSchema, { retries: 0 })
export const toggleSkill = (name: string, enabled: boolean) => post('api/skills/toggle', { name, enabled }, OkSchema, { retries: 0 })
export const fetchSkillsUsage = () => get('api/skills/usage', SkillsUsageSchema)
export const fetchMemory = (workspace?: string) => get(`api/memory${qs({ workspace })}`, MemorySchema)
export const writeMemory = (body: { target: 'memory' | 'user' | 'soul'; content: string }) => post('api/memory/write', { section: body.target, content: body.content }, OkSchema, { retries: 0 })
export const fetchCrons = (allProfiles = false) => get(`api/crons${qs({ all_profiles: allProfiles ? 1 : undefined })}`, CronsSchema)
export const cronAction = (action: 'create' | 'update' | 'delete' | 'run' | 'pause' | 'resume', body: Record<string, unknown>) => post(`api/crons/${action}`, body, CronMutationSchema, { retries: 0 })
export const fetchCronHistory = (job_id: string, limit = 50) => get(`api/crons/history${qs({ job_id, limit })}`, CronHistorySchema)
export const fetchCronRun = (job_id: string, filename: string) => get(`api/crons/run${qs({ job_id, filename })}`, CronRunSchema)
export const fetchCronOutput = (job_id: string, run_id?: string) => get(`api/crons/output${qs({ job_id, run_id })}`, z.looseObject({ output: z.string().optional(), error: z.string().optional() }))
export const fetchCronDeliveryOptions = () => get('api/crons/delivery-options', z.looseObject({ platforms: z.array(z.unknown()).optional() }))
export const fetchCronStatus = () => get('api/crons/status', CronStatusSchema)
export const fetchKanbanBoards = () => get('api/kanban/boards', KanbanBoardsSchema)
export const fetchKanbanBoard = (params: Record<string, string | boolean | undefined> = {}) => get(`api/kanban/board${qs(params)}`, KanbanBoardSchema)
export const switchKanbanBoard = (slug: string) => post(`api/kanban/boards/${encodeURIComponent(slug)}/switch`, {}, OkSchema.or(z.looseObject({})), { retries: 0 })
export const kanbanTaskAction = (id: string | number, action: 'patch' | 'comments' | 'move' | 'archive' | 'unarchive' | 'delete' | 'dispatch', body: Record<string, unknown>) => post(`api/kanban/tasks/${encodeURIComponent(String(id))}/${action}`, body, z.looseObject({ ok: z.boolean().optional(), task: z.unknown().optional(), error: z.string().optional() }), { retries: 0 })
export const createKanbanTask = (body: Record<string, unknown>) => post('api/kanban/tasks', body, z.looseObject({ ok: z.boolean().optional(), task: z.unknown().optional(), error: z.string().optional() }), { retries: 0 })
export const fetchKanbanTaskLog = (id: string | number) => get(`api/kanban/tasks/${encodeURIComponent(String(id))}/log`, z.looseObject({ log: z.array(z.unknown()).optional(), entries: z.array(z.unknown()).optional() }))
export const fetchInsights = (days: number) => get(`api/insights${qs({ days })}`, InsightsSchema)
export const fetchCostHistory = (days: number) => get(`api/provider/cost-history${qs({ days })}`, z.looseObject({ history: z.array(z.unknown()).optional(), days: z.array(z.unknown()).optional() }))
export const fetchLogs = (file: string, tail: number) => get(`api/logs${qs({ file, tail })}`, LogsSchema)
export const fetchOnboarding = () => get('api/onboarding/status', OnboardingStatusSchema, { timeoutMs: 45_000 })
export const onboardingSetup = (body: Record<string, unknown>) => post('api/onboarding/setup', body, z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), status: z.unknown().optional() }), { retries: 0, timeoutMs: 60_000 })
export const onboardingProbe = (body: Record<string, unknown>) => post('api/onboarding/probe', body, OnboardingProbeSchema, { retries: 0, timeoutMs: 60_000 })
export const onboardingComplete = (body: Record<string, unknown> = {}) => post('api/onboarding/complete', body, OkSchema, { retries: 0 })
export const onboardingOAuth = (action: 'start' | 'poll' | 'cancel', body: Record<string, unknown>) => post(`api/onboarding/oauth/${action}`, body, OnboardingOAuthSchema, { retries: 0, timeoutMs: 60_000 })
export const fetchExtensionsStatus = () => get('api/extensions/status', ExtensionStatusSchema)
export const fetchExtensionRegistry = () => get('api/extensions/registry', z.looseObject({ entries: z.array(z.unknown()).optional(), extensions: z.array(z.unknown()).optional(), error: z.string().optional(), unavailable: z.boolean().optional() }), { timeoutMs: 45_000 })
export const extensionAction = (action: 'install' | 'uninstall' | 'toggle' | 'sidecar-proxy-consent', body: Record<string, unknown>) => post(`api/extensions/${action}`, body, z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), status: z.unknown().optional() }), { retries: 0, timeoutMs: 120_000 })
export const fetchDashboardStatus = () => get('api/dashboard/status', DashboardStatusSchema)
export const fetchAgentHealth = () => get('api/health/agent', AgentHealthSchema, { dedupe: false, retries: 0 })
export const restartAgent = () => post('api/health/restart', {}, OkSchema.or(z.looseObject({})), { retries: 0, timeoutMs: 120_000 })
export const fetchSystemHealth = () => get('api/system/health', SystemHealthSchema)
/** Passive reader: the server answers from cache and never fetches, even with `?force=1` (see routes.py GET /api/updates/check). */
export const fetchUpdatesCheck = () => get('api/updates/check', UpdatesCheckSchema, { timeoutMs: 45_000 })
/** Manual "Check now": only POST `{force:true}` runs a real update check, and it bypasses the automatic-check toggle. An explicit `channel` wins over the persisted setting so a check right after a channel switch does not answer for the old channel. */
export const checkUpdatesNow = (channel?: string) => post('api/updates/check', { force: true, ...(channel ? { channel } : {}) }, UpdatesCheckSchema, { retries: 0, timeoutMs: 120_000 })
export const fetchUpdatesSummary = () => get('api/updates/summary', UpdatesSummarySchema, { timeoutMs: 60_000 })
export const applyUpdates = (action: 'apply' | 'force' | 'clear_lock') => post(`api/updates/${action}`, {}, UpdateApplySchema, { retries: 0, timeoutMs: 300_000 })
export const fetchPlugins = () => get('api/plugins', PluginsSchema)
export const savePlugins = (body: Record<string, unknown>) => post('api/plugins', body, PluginsSchema.or(OkSchema), { retries: 0 })
export const fetchMcpServers = () => get('api/mcp/servers', McpServersSchema)
export const fetchMcpTools = () => get('api/mcp/tools', z.looseObject({ tools: z.array(z.unknown()).optional(), servers: z.array(z.unknown()).optional() }))
export const mcpServerAction = (name: string, body: Record<string, unknown>) => post(`api/mcp/servers/${encodeURIComponent(name)}`, body, OkSchema.or(z.looseObject({})), { retries: 0 })
export const fetchNotesSources = () => get('api/notes/sources', NotesSourcesSchema)
export const searchNotes = (q: string) => get(`api/notes/search${qs({ q })}`, z.looseObject({ results: z.array(z.unknown()).optional() }))
export const shutdownServer = () => post('api/shutdown', {}, OkSchema.or(z.looseObject({})), { retries: 0 })
export const logClientEvent = (body: Record<string, unknown>) => post('api/client-events/log', body, OkSchema.or(z.looseObject({})), { retries: 0, redirect401: false, timeoutMs: 5000 })
export const talariaPresence = (body: Record<string, unknown>) => post('api/talaria/presence', body, OkSchema.or(z.looseObject({})), { retries: 0, redirect401: false, timeoutMs: 4000, keepalive: true })
export const sessionIdParam = SessionIdSchema
