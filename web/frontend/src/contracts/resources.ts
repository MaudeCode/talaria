import { z } from 'zod'
import { NullableNumber, NullableString } from './common'

// ── Auth and bootstrap-adjacent ───────────────────────────────────────────────
export const AuthStatusSchema = z.looseObject({
  auth_enabled: z.boolean(),
  logged_in: z.boolean(),
  oidc_enabled: z.boolean().optional(),
  oidc_native_handoff_enabled: z.boolean().optional(),
  password_auth_enabled: z.boolean().optional(),
  passwordless_enabled: z.boolean().optional(),
  passkeys_enabled: z.boolean().optional(),
  passkeys_count: z.number().optional(),
  passkey_feature_flag: z.boolean().optional(),
  auth_disabled_acknowledged: z.boolean().optional(),
  can_manage_server: z.boolean().optional(),
  trusted_auth_enabled: z.boolean().optional(),
  auth_type: z.string().optional(),
  user: NullableString.optional(),
  bound_profile: NullableString.optional(),
})
export type AuthStatus = z.infer<typeof AuthStatusSchema>

export const LoginResponseSchema = z.looseObject({ ok: z.boolean().optional(), error: z.string().optional() })

// ── Settings ─────────────────────────────────────────────────────────────────
export const SettingsSchema = z.looseObject({
  bot_name: z.string().optional(),
  default_model: z.string().optional(),
  default_workspace: z.string().optional(),
  language: z.string().optional(),
  send_key: z.string().optional(),
  font_size: z.string().optional(),
  full_width_chat: z.boolean().optional(),
  auto_scroll_follow: z.boolean().optional(),
  render_user_markdown: z.boolean().optional(),
  chat_activity_display_mode: z.string().optional(),
  default_message_mode: z.string().optional(),
  fade_text_effect: z.boolean().optional(),
  hidden_tabs: z.array(z.string()).optional(),
  composer_control_order: z.array(z.string()).optional(),
  show_cli_sessions: z.boolean().optional(),
  show_claude_code_sessions: z.boolean().optional(),
  show_cron_sessions: z.boolean().optional(),
  show_webhook_sessions: z.boolean().optional(),
  show_kanban_sessions: z.boolean().optional(),
  check_for_updates: z.boolean().optional(),
  ignore_agent_updates: z.boolean().optional(),
  auth_enabled: z.boolean().optional(),
  password_auth_enabled: z.boolean().optional(),
  password_env_var: z.boolean().optional(),
  passkeys_enabled: z.boolean().optional(),
  passwordless_enabled: z.boolean().optional(),
  auth_disabled_acknowledged: z.boolean().optional(),
  webui_version: z.string().optional(),
  agent_version: z.string().optional(),
  update_channel: z.string().optional(),
  update_channel_version: NullableString.optional(),
  max_tokens: NullableNumber.optional(),
  max_tokens_effective: NullableNumber.optional(),
  max_tokens_fallback: NullableNumber.optional(),
  tts_engine: z.string().optional(),
  tts_voice: z.string().optional(),
  dictation_append: z.boolean().optional(),
  persisted_speech_keys: z.array(z.string()).optional(),
  dashboard_plugins: z.record(z.string(), z.unknown()).optional(),
})
export type Settings = z.infer<typeof SettingsSchema>

// ── Profiles ─────────────────────────────────────────────────────────────────
export const ProfileSchema = z.looseObject({
  name: z.string(),
  path: z.string().optional(),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
  model: NullableString.optional(),
  provider: NullableString.optional(),
  skill_count: z.number().optional(),
  total_skills: z.number().optional(),
  enabled_skills: z.number().optional(),
  gateway_running: z.boolean().optional(),
  has_env: z.boolean().optional(),
  visible: z.boolean().optional(),
})
/** `/api/reasoning`: config.yaml agent.reasoning_effort / display.show_reasoning, resolved for a model. */
export const ReasoningStatusSchema = z.looseObject({ show_reasoning: z.boolean().optional(), reasoning_effort: z.string().nullable().optional(), supported_efforts: z.array(z.string()).optional(), supports_reasoning_effort: z.boolean().optional(), supports_thinking_toggle: z.boolean().optional() })
export type ReasoningStatus = z.infer<typeof ReasoningStatusSchema>

export const ProfilesSchema = z.looseObject({ profiles: z.array(ProfileSchema), active: z.string(), single_profile_mode: z.boolean().optional() })
export type Profiles = z.infer<typeof ProfilesSchema>
export const ActiveProfileSchema = z.looseObject({ name: z.string(), path: z.string().optional(), is_default: z.boolean().optional(), default_workspace: NullableString.optional() })

// ── Models and providers ──────────────────────────────────────────────────────
export const ModelEntrySchema = z.looseObject({ id: z.string(), label: z.string().optional(), provider: z.string().optional(), supports_fast_tier: z.boolean().optional() })
export const ModelGroupSchema = z.looseObject({ provider: z.string(), provider_id: z.string().optional(), models: z.array(ModelEntrySchema) })
export const ModelsSchema = z.looseObject({
  active_provider: NullableString.optional(),
  default_model: z.string().optional(),
  groups: z.array(ModelGroupSchema),
  aliases: z.record(z.string(), z.unknown()).optional(),
  configured_model_badges: z.record(z.string(), z.unknown()).optional(),
})
export type Models = z.infer<typeof ModelsSchema>

export const ProviderSchema = z.looseObject({
  id: z.string(),
  display_name: z.string().optional(),
  has_key: z.boolean().optional(),
  configurable: z.boolean().optional(),
  is_oauth: z.boolean().optional(),
  is_plugin_provider: z.boolean().optional(),
  is_self_hosted: z.boolean().optional(),
  key_source: z.string().optional(),
  base_url: NullableString.optional(),
  auth_error: NullableString.optional(),
  models: z.array(ModelEntrySchema).optional(),
  models_total: z.number().optional(),
})
export const ProvidersSchema = z.looseObject({ providers: z.array(ProviderSchema), active_provider: NullableString.optional() })

export const ProviderQuotaSourceSchema = z.looseObject({
  source_id: z.string(),
  provider_id: z.string().optional(),
  provider_label: z.string().optional(),
  status: z.string().optional(),
  supported: z.boolean().optional(),
  message: z.string().optional(),
  is_active_provider: z.boolean().optional(),
  quota: z.unknown().optional(),
  windows: z.array(z.unknown()).optional(),
  balances: z.array(z.unknown()).optional(),
})
export const ProviderQuotasSchema = z.looseObject({ sources: z.array(ProviderQuotaSourceSchema), active_provider: NullableString.optional(), version: z.number().optional() })

export const PersonalitiesSchema = z.looseObject({ personalities: z.array(z.looseObject({ name: z.string(), description: z.string().optional() })) })

export const AuxiliaryModelsSchema = z.looseObject({
  main: z.looseObject({ model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional(), api_key_set: z.boolean().optional() }).optional(),
  tasks: z.array(z.looseObject({ task: z.string(), label: z.string().optional(), description: z.string().optional(), model: z.string().optional(), provider: z.string().optional() })).optional(),
})

// ── Workspaces and files ──────────────────────────────────────────────────────
export const WorkspaceSchema = z.looseObject({ name: z.string().optional(), path: z.string() })
export type Workspace = z.infer<typeof WorkspaceSchema>
export const WorkspacesSchema = z.looseObject({ workspaces: z.array(WorkspaceSchema), last: NullableString.optional(), terminal_remote_backend: z.boolean().optional() })
export type Workspaces = z.infer<typeof WorkspacesSchema>

export const FileEntrySchema = z.looseObject({
  name: z.string(),
  path: z.string().optional(),
  is_dir: z.boolean().optional(),
  type: z.string().optional(),
  size: z.number().nullable().optional(),
  mtime: z.number().nullable().optional(),
  hidden: z.boolean().optional(),
})
export const DirListingSchema = z.looseObject({ path: z.string().optional(), entries: z.array(FileEntrySchema).optional(), items: z.array(FileEntrySchema).optional(), is_git: z.boolean().optional() })
export const FileContentSchema = z.looseObject({ path: z.string().optional(), content: z.string().optional(), lines: z.number().optional(), size: z.number().optional(), truncated: z.boolean().optional(), binary: z.boolean().optional(), mime: z.string().optional() })
export const GitInfoSchema = z.looseObject({ git: z.looseObject({ is_git: z.boolean().optional(), branch: NullableString.optional(), dirty: z.number().optional(), modified: z.number().optional(), untracked: z.number().optional(), ahead: z.number().optional(), behind: z.number().optional() }).nullable().optional() })

// ── Skills, memory, tasks ─────────────────────────────────────────────────────
export const SkillSchema = z.looseObject({ name: z.string(), description: NullableString.optional(), category: NullableString.optional(), disabled: z.boolean().optional() })
export const SkillsSchema = z.looseObject({ skills: z.array(SkillSchema), categories: z.array(z.unknown()).optional() })
export const SkillContentSchema = z.looseObject({ name: z.string().optional(), content: z.string().optional(), path: z.string().optional(), success: z.boolean().optional(), message: z.string().optional() })
export const SkillsUsageSchema = z.looseObject({ usage: z.record(z.string(), z.looseObject({ use_count: z.number().optional(), view_count: z.number().optional(), patch_count: z.number().optional() })), total_invocations: z.number().optional(), unique_skills_used: z.number().optional() })

export const MemorySchema = z.looseObject({
  memory: z.string(), user: z.string(), soul: z.string(),
  project_context: z.string().optional(),
  memory_path: z.string().optional(), user_path: z.string().optional(), soul_path: z.string().optional(), project_context_path: z.string().optional(),
  project_context_name: z.string().optional(), project_context_workspace: z.string().optional(),
  memory_mtime: NullableNumber.optional(), user_mtime: NullableNumber.optional(), soul_mtime: NullableNumber.optional(), project_context_mtime: NullableNumber.optional(),
  external_notes_enabled: z.boolean().optional(),
})
export type Memory = z.infer<typeof MemorySchema>

// Persisted shape from the agent's cron.jobs store (see create_job there) plus
// the WebUI projections (owner_profile, read_only, monitor, continuity).
export const CronScheduleSchema = z.looseObject({ kind: z.string().optional(), expr: z.string().optional(), minutes: z.number().optional(), run_at: z.string().optional(), display: z.string().optional() })
export const CronRepeatSchema = z.looseObject({ times: NullableNumber.optional(), completed: z.number().optional() })
export const CronJobSchema = z.looseObject({
  read_only: z.boolean().optional(),
  owner_profile: NullableString.optional(),
  id: z.string().optional(),
  job_id: z.string().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  schedule: z.union([z.string(), CronScheduleSchema]).optional(),
  schedule_display: z.string().optional(),
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  paused_reason: NullableString.optional(),
  state: NullableString.optional(),
  last_status: NullableString.optional(),
  last_error: NullableString.optional(),
  last_delivery_error: NullableString.optional(),
  // ISO string from cron/jobs.py; older servers emit epoch seconds.
  next_run_at: z.union([z.string(), z.number(), z.null()]).optional(),
  last_run_at: z.union([z.string(), z.number(), z.null()]).optional(),
  repeat: z.union([CronRepeatSchema, z.number(), z.null()]).optional(),
  status: z.string().optional(),
  last_run: z.unknown().optional(),
  next_run: z.unknown().optional(),
  profile: NullableString.optional(),
  session_id: NullableString.optional(),
  model: NullableString.optional(),
  provider: NullableString.optional(),
  workspace: NullableString.optional(),
  workdir: NullableString.optional(),
  deliver: NullableString.optional(),
  skills: z.array(z.string()).optional(),
  no_agent: z.boolean().optional(),
  script: NullableString.optional(),
  monitor: NullableString.optional(),
  continuity: z.boolean().optional(),
  context_from: z.union([z.array(z.string()), z.string(), z.null()]).optional(),
  reasoning_effort: NullableString.optional(),
  toast_notifications: z.boolean().optional(),
  running: z.boolean().optional(),
})
export type CronJob = z.infer<typeof CronJobSchema>
export const CronsSchema = z.looseObject({ jobs: z.array(CronJobSchema), active_profile: z.string().optional(), all_profiles: z.boolean().optional(), other_profile_count: z.number().optional(), cron_unavailable: z.boolean().optional() })
export type Crons = z.infer<typeof CronsSchema>
export const CronMutationSchema = z.looseObject({ ok: z.boolean().optional(), job: CronJobSchema.optional(), job_id: z.string().optional(), status: z.string().optional(), error: z.string().optional() })
export const CronRunUsageSchema = z.looseObject({ input_tokens: NullableNumber.optional(), output_tokens: NullableNumber.optional(), total_tokens: NullableNumber.optional(), estimated_cost_usd: NullableNumber.optional(), duration_seconds: NullableNumber.optional(), model: z.string().optional(), provider: z.string().optional() })
export const CronRunSummarySchema = z.looseObject({ filename: z.string(), size: z.number(), modified: z.number(), usage: CronRunUsageSchema.optional() })
export const CronHistorySchema = z.looseObject({ job_id: z.string().optional(), runs: z.array(CronRunSummarySchema), total: z.number().optional(), offset: z.number().optional() })
export type CronHistory = z.infer<typeof CronHistorySchema>
export const CronRunSchema = z.looseObject({ content: z.string().optional(), snippet: z.string().optional(), usage: CronRunUsageSchema.optional(), error: z.string().optional() })
export const CronStatusSchema = z.looseObject({ running: z.union([z.boolean(), z.record(z.string(), z.number())]).optional() })

export const PromptSchema = z.looseObject({ id: z.string().optional(), name: z.string().optional(), title: z.string().optional(), text: z.string().optional(), content: z.string().optional() })
export const PromptsSchema = z.looseObject({ prompts: z.array(PromptSchema) })

export const CommandSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  args_hint: z.string().optional(),
  category: z.string().optional(),
  cli_only: z.boolean().optional(),
  gateway_only: z.boolean().optional(),
  subcommands: z.array(z.unknown()).optional(),
})
export const CommandsSchema = z.looseObject({ commands: z.array(CommandSchema) })
export type Command = z.infer<typeof CommandSchema>

// ── Onboarding ───────────────────────────────────────────────────────────────
export const OnboardingProviderSchema = z.looseObject({ id: z.string(), name: z.string().optional(), label: z.string().optional(), kind: z.string().optional(), oauth: z.boolean().optional(), needs_key: z.boolean().optional(), base_url: NullableString.optional(), models: z.array(z.unknown()).optional(), category: z.string().optional() })
export const OnboardingStatusSchema = z.looseObject({
  completed: z.boolean(),
  settings: z.looseObject({ bot_name: z.string().optional(), default_model: z.string().optional(), default_workspace: NullableString.optional(), password_enabled: z.boolean().optional() }).optional(),
  setup: z.looseObject({
    providers: z.array(OnboardingProviderSchema).optional(),
    categories: z.array(z.unknown()).optional(),
    current: z.looseObject({ provider: z.string().optional(), model: z.string().optional(), base_url: z.string().optional() }).optional(),
    current_is_oauth: z.boolean().optional(),
    unsupported_note: z.string().optional(),
  }).optional(),
  system: z.looseObject({
    hermes_found: z.boolean().optional(),
    imports_ok: z.boolean().optional(),
    chat_ready: z.boolean().optional(),
    provider_ready: z.boolean().optional(),
    provider_configured: z.boolean().optional(),
    setup_state: z.string().optional(),
    provider_note: z.string().optional(),
    provider_note_key: z.string().optional(),
    missing_modules: z.array(z.string()).optional(),
    import_errors: z.record(z.string(), z.string()).optional(),
    config_path: z.string().optional(),
    env_path: z.string().optional(),
  }).optional(),
  workspaces: z.looseObject({ items: z.array(WorkspaceSchema).optional(), last: NullableString.optional() }).optional(),
  models: ModelsSchema.optional(),
})
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>
export const OnboardingProbeSchema = z.looseObject({ ok: z.boolean().optional(), success: z.boolean().optional(), error: z.string().optional(), message: z.string().optional(), models: z.array(z.unknown()).optional() })
export const OnboardingOAuthSchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional(), url: z.string().optional(), verification_url: z.string().optional(), user_code: z.string().optional(), message: z.string().optional(), error: z.string().optional(), flow_id: z.string().optional() })

// ── Platform status ───────────────────────────────────────────────────────────
export const ExtensionStatusSchema = z.looseObject({
  enabled: z.boolean(),
  extension_dir_configured: z.boolean().optional(),
  extension_dir_valid: z.boolean().optional(),
  extensions: z.array(z.looseObject({ id: z.string(), enabled: z.boolean().optional(), name: z.string().optional(), version: z.string().optional() })).optional(),
  warnings: z.array(z.unknown()).optional(),
  manifest: z.looseObject({ configured: z.boolean().optional(), loaded: z.boolean().optional(), status: z.string().optional(), entry_count: z.number().optional() }).optional(),
  counts: z.record(z.string(), z.number()).optional(),
})
export const DashboardStatusSchema = z.looseObject({ running: z.boolean(), enabled: z.string().optional(), url: z.string().optional(), browser_url: z.string().optional(), error: z.string().optional() })
export const AgentHealthSchema = z.looseObject({
  alive: z.boolean().nullable().optional(),
  checked_at: z.string().optional(),
  details: z.looseObject({ state: z.string().optional(), reason: z.string().optional() }).optional(),
  gateway_chat: z.looseObject({ enabled: z.boolean().optional(), backend: z.string().optional() }).optional(),
  error: z.string().optional(),
})
export const SystemHealthSchema = z.looseObject({
  available: z.boolean().optional(),
  status: z.string().optional(),
  checked_at: z.string().optional(),
  cpu: z.unknown().nullable().optional(),
  memory: z.unknown().nullable().optional(),
  disk: z.looseObject({ percent: z.number().optional(), total_bytes: z.number().optional(), used_bytes: z.number().optional() }).nullable().optional(),
  errors: z.array(z.looseObject({ code: z.string().optional(), metric: z.string().optional() })).optional(),
  webui_runtime: z.unknown().optional(),
})
export const UpdateTargetSchema = z.looseObject({ name: z.string().optional(), behind: z.number().optional(), current_sha: z.string().optional(), latest_sha: z.string().optional(), compare_url: z.string().optional(), repo_url: z.string().optional(), error: z.string().optional(), ok: z.boolean().optional() })
export const UpdatesCheckSchema = z.looseObject({
  disabled: z.boolean().optional(),
  cached: z.boolean().optional(),
  channel: z.string().optional(),
  checked_at: z.number().optional(),
  include_agent: z.boolean().optional(),
  webui: UpdateTargetSchema.nullable().optional(),
  agent: UpdateTargetSchema.nullable().optional(),
})
export const UpdatesSummarySchema = z.looseObject({ summary: z.string().optional(), text: z.string().optional(), ok: z.boolean().optional(), error: z.string().optional(), diff_links: z.array(z.unknown()).optional() })
export const UpdateApplySchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional(), error: z.string().optional(), message: z.string().optional(), lock: z.unknown().optional() })

export const LogsSchema = z.looseObject({ file: z.string(), tail: z.number().optional(), lines: z.array(z.string()), truncated: z.boolean().optional(), total_bytes: z.number().optional(), mtime: NullableNumber.optional(), hint: z.string().optional() })
export type Logs = z.infer<typeof LogsSchema>

export const InsightsSchema = z.looseObject({
  period_days: z.number().optional(),
  total_sessions: z.number().optional(),
  total_messages: z.number().optional(),
  total_tokens: z.number().optional(),
  total_input_tokens: z.number().optional(),
  total_output_tokens: z.number().optional(),
  total_cache_read_tokens: z.number().optional(),
  total_cache_hit_percent: NullableNumber.optional(),
  total_cost: z.number().optional(),
  activity_by_day: z.array(z.looseObject({ day: z.string(), sessions: z.number() })).optional(),
  activity_by_hour: z.array(z.looseObject({ hour: z.number(), sessions: z.number() })).optional(),
  daily_tokens: z.array(z.looseObject({ date: z.string(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional(), cost: z.number().optional(), sessions: z.number().optional() })).optional(),
  models: z.array(z.looseObject({ model: z.string().optional(), sessions: z.number().optional(), tokens: z.number().optional(), cost: z.number().optional() })).optional(),
})
export type Insights = z.infer<typeof InsightsSchema>

export const KanbanTaskSchema = z.looseObject({ id: z.union([z.string(), z.number()]), title: z.string().optional(), status: z.string().optional(), assignee: NullableString.optional(), priority: z.union([z.string(), z.number()]).nullable().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), session_id: NullableString.optional(), created_at: z.unknown().optional(), updated_at: z.unknown().optional() })
export const KanbanColumnSchema = z.looseObject({ name: z.string(), tasks: z.array(KanbanTaskSchema) })
export const KanbanBoardSchema = z.looseObject({ columns: z.array(KanbanColumnSchema), assignees: z.array(z.unknown()).optional(), filters: z.unknown().optional(), latest_event_id: z.number().optional(), read_only: z.boolean().optional(), tenants: z.array(z.unknown()).optional(), changed: z.boolean().optional() })
export const KanbanBoardsSchema = z.looseObject({ boards: z.array(z.looseObject({ slug: z.string(), name: z.string().optional(), is_current: z.boolean().optional(), total: z.number().optional(), archived: z.boolean().optional(), color: z.string().optional(), icon: z.string().optional(), description: z.string().optional() })), current: z.string().optional(), read_only: z.boolean().optional() })

export const PluginSchema = z.looseObject({ key: z.string(), name: z.string().optional(), kind: z.string().optional(), enabled: z.boolean().optional(), description: z.string().optional(), version: z.string().optional(), activation: z.string().optional(), is_active_provider: z.boolean().optional(), hooks: z.array(z.unknown()).optional() })
export const PluginsSchema = z.looseObject({ plugins: z.array(PluginSchema), empty: z.boolean().optional(), read_only: z.boolean().optional(), supported_hooks: z.array(z.string()).optional() })

export const McpServersSchema = z.looseObject({ servers: z.array(z.looseObject({ name: z.string().optional(), id: z.string().optional(), enabled: z.boolean().optional(), status: z.string().optional(), tools: z.number().optional() })), health_pending: z.boolean().optional(), reload_required: z.boolean().optional(), toggle_supported: z.boolean().optional() })
export const NotesSourcesSchema = z.looseObject({ enabled: z.boolean().optional(), sources: z.array(z.unknown()).optional(), source: z.string().optional(), recent_ai_notes: z.array(z.unknown()).optional(), attach_supported: z.boolean().optional() })

export const TodoItemSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), text: z.string().optional(), content: z.string().optional(), title: z.string().optional(), status: z.string().optional(), done: z.boolean().optional(), completed: z.boolean().optional() })
export const TodoStateSchema = z.looseObject({ session_id: z.string().optional(), todos: z.array(TodoItemSchema).optional(), version: z.number().optional(), ts: z.number().optional(), source: z.string().optional(), description: z.string().optional(), pending_count: z.number().optional() })
export type TodoState = z.infer<typeof TodoStateSchema>
