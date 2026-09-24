/**
 * Pinned response shapes shared by every consumer (formerly the frontend's
 * hand-written `src/contracts/*` schemas). Known fields are typed; every
 * object keeps a catchall because sidecar rows carry operator-defined extras
 * that must survive a round trip (documented passthrough).
 */
import { z } from 'zod'

const Json = z.unknown()
export const NullableString = z.string().nullable()
export const NullableNumber = z.number().nullable()
/** Unix seconds as the server emits them (float). */
export const UnixSeconds = z.number()

// ── sessions ─────────────────────────────────────────────────────────────

export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'invalid session id')
export type SessionId = z.infer<typeof SessionIdSchema>

export const AttachmentSchema = z.looseObject({
  filename: z.string().optional(), name: z.string().optional(), path: z.string().optional(), size: z.number().optional(), mime: z.string().optional(), is_image: z.boolean().optional(), rollback_token: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

/** Stored transcripts carry the OpenAI shape (`function.name` / `function.arguments` JSON string); live events carry `name` / `args`. */
export const ToolCallSchema = z.looseObject({
  name: z.string().optional(), args: Json.optional(), function: z.looseObject({ name: z.string().optional(), arguments: Json.optional() }).optional(), id: z.string().optional(), call_id: z.string().optional(), tool_call_id: z.string().optional(),
  done: z.boolean().optional(), is_error: z.boolean().optional(), preview: z.string().nullable().optional(), result: Json.optional(), output: Json.optional(), duration: z.number().nullable().optional(), cost_usd: z.number().nullable().optional(),
  timestamp: z.number().nullable().optional(), event_type: z.string().optional(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

export const ContentPartSchema = z.looseObject({ type: z.string(), text: z.string().optional() })
export const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema), z.null()])
export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
/** Persisted rows have integer ids; live rows carry string ids. */
export const MessageIdSchema = z.union([z.string(), z.number()])

/** One normalized activity row: the server decides role, order, tool completion/error, and steering consumption. */
export const ActivitySceneRowSchema = z.looseObject({
  row_id: z.string(), order_index: z.number().int(), role: z.enum(['prose', 'reasoning', 'tool', 'steering']), created_at: z.number().optional(),
  text: z.string().optional(), titles: z.array(z.string()).optional(),
  tool: z.looseObject({ id: z.string(), name: z.string(), args: Json.optional(), preview: z.string().nullable(), result: Json.optional(), done: z.boolean(), is_error: z.boolean(), duration: z.number().nullable(), cost_usd: z.number().nullable() }).optional(),
  steering: z.looseObject({ steer_id: z.string(), consumed: z.boolean(), submitted_at: z.number().nullable(), consumed_at: z.number().nullable() }).optional(),
})
export type ActivitySceneRow = z.infer<typeof ActivitySceneRowSchema>

/** `_anchor_activity_scene`: a turn's server-owned presentation, a tail preview of its rows plus paging fields. */
export const ActivitySceneSchema = z.looseObject({
  version: z.literal('activity_scene_v1'), activity_rows: z.array(ActivitySceneRowSchema), final_answer: z.string().optional(), turn_duration: z.number().nullable().optional(),
  activity_rows_total: z.number().int().optional(), activity_rows_offset: z.number().int().optional(), activity_rows_complete: z.boolean().optional(), activity_rows_omitted: z.number().int().optional(), activity_scene_ref: z.string().optional(),
})
export type ActivityScene = z.infer<typeof ActivitySceneSchema>

export const MessageSchema = z.looseObject({
  role: z.string(), content: MessageContentSchema.optional(), id: MessageIdSchema.optional(), message_id: MessageIdSchema.optional(), timestamp: z.number().nullable().optional(),
  attachments: z.array(AttachmentSchema).optional(), tool_calls: z.array(ToolCallSchema).optional(), reasoning: z.union([z.string(), z.array(Json)]).nullable().optional(), reasoning_content: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(), tool_call_id: z.string().optional(), tool_use_id: z.string().optional(), name: z.string().optional(), badge: z.string().optional(), label: z.string().optional(),
  provider_details: Json.optional(), provider_details_label: z.string().optional(), recovery_control: Json.optional(), _anchor_activity_scene: ActivitySceneSchema.optional(),
  /** The turn this row belongs to; the server stamps every row it sends, so clients group turns by equality alone. */
  _turn_id: z.string().optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const ComposerDraftSchema = z.looseObject({ text: z.string().optional(), files: z.array(Json).optional() })

/** Full session record from `GET /api/session` and mutations returning `session`. */
export const SessionSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string(), workspace: z.string().optional(), created_workspace: z.string().nullable().optional(), model: NullableString.optional(), model_provider: NullableString.optional(),
  messages: z.array(MessageSchema).optional(), tool_calls: z.array(ToolCallSchema).optional(), created_at: UnixSeconds.optional(), updated_at: UnixSeconds.optional(), last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(), user_message_count: z.number().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: NullableString.optional(), profile: NullableString.optional(),
  personality: NullableString.optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional(), cache_write_tokens: z.number().optional(),
  cache_hit_percent: NullableNumber.optional(), estimated_cost: NullableNumber.optional(), active_stream_id: NullableString.optional(), is_streaming: z.boolean().optional(), has_pending_user_message: z.boolean().optional(),
  pending_user_message: NullableString.optional(), pending_attachments: z.array(AttachmentSchema).optional(), pending_started_at: NullableNumber.optional(), pending_user_source: NullableString.optional(),
  context_length: NullableNumber.optional(), threshold_tokens: NullableNumber.optional(), last_prompt_tokens: NullableNumber.optional(), post_compression_context_tokens_estimate: NullableNumber.optional(),
  enabled_toolsets: z.array(z.string()).nullable().optional(), composer_draft: ComposerDraftSchema.optional(), is_cli_session: z.boolean().optional(), read_only: z.boolean().optional(), source_tag: NullableString.optional(),
  source_label: NullableString.optional(), session_source: NullableString.optional(), raw_source: NullableString.optional(), parent_session_id: NullableString.optional(), worktree_path: NullableString.optional(),
  worktree_branch: NullableString.optional(), worktree_repo_root: NullableString.optional(), share_token: NullableString.optional(), share_created_at: NullableNumber.optional(), manual_title: z.boolean().optional(),
  compression_anchor_summary: NullableString.optional(), compression_recovery: z.record(z.string(), Json).optional(), recommended_recovery_action: NullableString.optional(), compression_recovery_action: NullableString.optional(),
  compression_recovery_source_session_id: NullableString.optional(), gateway_routing: Json.optional(), _messages_offset: z.number().optional(), _messages_truncated: z.boolean().optional(), _msg_limit_max: z.number().optional(), _load_revision: z.string().optional(),
})
export type Session = z.infer<typeof SessionSchema>
export const SessionEnvelopeSchema = z.looseObject({ session: SessionSchema })

/** Sidebar row from `GET /api/sessions`. */
export const SessionRowSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string(), workspace: z.string().optional(), model: NullableString.optional(), created_at: UnixSeconds.optional(), updated_at: UnixSeconds.optional(), last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: NullableString.optional(), profile: NullableString.optional(), is_streaming: z.boolean().optional(),
  is_cli_session: z.boolean().optional(), cron_running: z.boolean().optional(), read_only: z.boolean().optional(), attention: z.looseObject({ kind: z.string().optional(), count: z.number().optional() }).nullable().optional(),
  source_tag: NullableString.optional(), source_label: NullableString.optional(), session_source: NullableString.optional(), raw_source: NullableString.optional(), parent_session_id: NullableString.optional(),
  active_stream_id: NullableString.optional(), share_token: NullableString.optional(), worktree_branch: NullableString.optional(), match_type: z.string().optional(), match_preview: NullableString.optional(),
})
export type SessionRow = z.infer<typeof SessionRowSchema>

export const SessionsListSchema = z.looseObject({
  sessions: z.array(SessionRowSchema), sidebar_reference_sessions: z.array(SessionRowSchema), server_time: z.number(), server_tz: z.string(), active_profile: z.string(), all_profiles: z.boolean(), include_archived: z.boolean(),
  archived_count: z.number().int(), archived_webui_count: z.number().int(), archived_cli_count: z.number().int(), other_profile_count: z.number().int(), cli_count: z.number().int(), webui_session_count: z.number().int(),
  cli_session_count: z.number().int(), archived_limit: z.number().int().nullable().optional(), archived_offset: z.number().int().optional(),
})
export type SessionsList = z.infer<typeof SessionsListSchema>

export const SessionStatusSchema = z.looseObject({
  session_id: SessionIdSchema, title: z.string().optional(), active_stream_id: NullableString.optional(), agent_running: z.boolean().optional(), message_count: z.number().optional(), model: NullableString.optional(),
  profile: NullableString.optional(), workspace: z.string().optional(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(), estimated_cost: NullableNumber.optional(), updated_at: UnixSeconds.optional(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export const SessionUsageSchema = z.looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), total_tokens: z.number().optional(), estimated_cost: NullableNumber.optional(), model: NullableString.optional() })

export const ProjectSchema = z.looseObject({ project_id: z.string(), name: z.string(), color: z.string().nullable().optional(), profile: NullableString.optional(), created_at: z.number().optional() })
export const ProjectsSchema = z.looseObject({ projects: z.array(ProjectSchema), active_profile: z.string(), all_profiles: z.boolean(), other_profile_count: z.number().int() })
export const SessionDeleteResultSchema = z.looseObject({ ok: z.literal(true), state_db_cleanup_failed: z.boolean().optional() })

// ── chat ─────────────────────────────────────────────────────────────────

export const ChatStartRequestSchema = z.looseObject({
  session_id: SessionIdSchema, message: z.string().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(), workspace: z.string().nullable().optional(), profile: z.string().nullable().optional(),
  explicit_model_pick: z.boolean().optional(), attachments: z.array(z.union([AttachmentSchema, z.string()])).optional(), moa_config: z.boolean().optional(), regenerate: z.boolean().optional(), regeneration_revision: z.string().optional(),
})
export type ChatStartRequest = z.infer<typeof ChatStartRequestSchema>
/** Accepted turn. `stream_id` is the owner identity for the SSE connection. */
export const ChatStartResponseSchema = z.looseObject({
  stream_id: z.string().optional(), session_id: SessionIdSchema.optional(), turn_id: z.string().optional(), user_message_id: z.union([z.string(), z.number()]).nullable().optional(), pending_started_at: z.number().nullable().optional(),
  title: z.string().optional(), effective_model: z.string().optional(), effective_model_provider: z.string().optional(), queued: z.boolean().optional(), ok: z.boolean().optional(), status: z.string().optional(), reason: z.string().optional(), session: SessionSchema.optional(),
})
export type ChatStartResponse = z.infer<typeof ChatStartResponseSchema>
export const StreamStatusSchema = z.looseObject({ active: z.boolean(), stream_id: z.string(), replay_available: z.boolean().optional(), journal: Json.optional() })
export type StreamStatus = z.infer<typeof StreamStatusSchema>
export const CancelResponseSchema = z.looseObject({ ok: z.boolean(), cancelled: z.boolean(), stream_id: z.string().optional(), error: z.string().optional() })
/** `text` is delivered to the running agent; `display_text` is what the transcript shows. */
export const SteerRequestSchema = z.looseObject({ session_id: SessionIdSchema, text: z.string().min(1), display_text: z.string().optional(), steer_id: z.string().optional() })
/** `accepted: false` with a `fallback` reason means the message was not delivered; the caller keeps the draft. */
export const SteerResponseSchema = z.looseObject({ accepted: z.boolean(), fallback: NullableString.optional(), stream_id: NullableString.optional(), steer_id: z.string().optional() })

export const ApprovalPendingSchema = z.looseObject({
  approval_id: z.string().optional(), session_id: z.string().optional(), command: z.string().optional(), description: z.string().optional(), title: z.string().optional(), name: z.string().optional(), kind: z.string().optional(),
  reason: z.string().optional(), action: z.string().optional(), question: z.string().optional(), status: z.string().optional(), pending_count: z.number().optional(), run_id: z.string().optional(), mirror_token: z.string().optional(),
})
export type ApprovalPending = z.infer<typeof ApprovalPendingSchema>
export const ApprovalPendingEnvelopeSchema = z.looseObject({ pending: ApprovalPendingSchema.nullable(), pending_count: z.number().int() })
export const ApprovalChoiceSchema = z.enum(['once', 'session', 'always', 'deny'])
export const ApprovalRespondRequestSchema = z.looseObject({ session_id: SessionIdSchema, choice: ApprovalChoiceSchema, approval_id: z.string().optional(), command: z.string().optional(), yolo: z.boolean().optional(), run_id: z.string().optional(), mirror_token: z.string().optional() })
export const ApprovalRespondResponseSchema = z.looseObject({ ok: z.boolean(), choice: z.string().optional(), yolo_enabled: z.boolean().optional(), stale_cleared: z.boolean().optional(), error: z.string().optional(), pending_count: z.number().optional() })

export const ClarifyChoiceSchema = z.union([z.string(), z.looseObject({ label: z.string().optional(), value: z.string().optional(), text: z.string().optional() })])
export const ClarifyPendingSchema = z.looseObject({
  clarify_id: z.string().optional(), session_id: z.string().optional(), question: z.string().optional(), description: z.string().optional(), choices: z.array(ClarifyChoiceSchema).optional(), title: z.string().optional(),
  name: z.string().optional(), kind: z.string().optional(), reason: z.string().optional(), action: z.string().optional(), status: z.string().optional(), raw_preview: z.string().optional(), timeout_at: z.number().optional(),
  timeout_seconds: z.number().optional(), pending_count: z.number().optional(), index: z.number().optional(), total: z.number().optional(),
})
export type ClarifyPending = z.infer<typeof ClarifyPendingSchema>
export const ClarifyPendingEnvelopeSchema = z.looseObject({ pending: ClarifyPendingSchema.nullable(), pending_count: z.number().int() })
export const ClarifyRespondRequestSchema = z.looseObject({ session_id: SessionIdSchema, response: z.string().optional(), answer: z.string().optional(), choice: z.string().optional(), clarify_id: z.string().optional() })
export const ClarifyRespondResponseSchema = z.looseObject({ ok: z.boolean(), response: z.string().optional(), error: z.string().optional(), stale: z.boolean().optional() })

export const DraftSchema = z.looseObject({ text: z.string(), files: z.array(Json) })
export const DraftResponseSchema = z.looseObject({ ok: z.literal(true), draft: DraftSchema, draft_version: z.string().nullable(), unchanged: z.boolean().optional() })
export const UploadResponseSchema = z.looseObject({ filename: z.string(), path: z.string(), size: z.number(), mime: z.string(), is_image: z.boolean().optional(), rollback_token: z.string().optional() })
export type UploadResponse = z.infer<typeof UploadResponseSchema>
export const GoalViewSchema = z.looseObject({ text: z.string().optional(), state: z.string().optional(), status: z.string().optional(), turns: z.number().optional(), max_turns: z.number().optional(), reason: z.string().optional() })
export const GoalResponseSchema = z.looseObject({ ok: z.boolean().optional(), action: z.string().optional(), goal: GoalViewSchema.nullable().optional(), message: z.string().optional(), message_key: z.string().optional(), stream_id: z.string().optional(), status: z.string().optional(), reason: z.string().optional() })
export const BackgroundResultSchema = z.looseObject({ id: z.string().optional(), task_id: z.string().optional(), status: z.string().optional(), title: z.string().optional(), summary: z.string().optional(), prompt: z.string().optional(), answer: NullableString.optional(), error: z.string().optional(), completed_at: z.number().nullable().optional() })
export const BackgroundStatusSchema = z.looseObject({ results: z.array(BackgroundResultSchema) })
export const ShareCreateResponseSchema = z.looseObject({ ok: z.literal(true), share: z.looseObject({ token: z.string(), url: z.string(), title: z.string(), message_count: z.number().int(), created_at: z.number(), updated_at: z.number() }), session: SessionRowSchema })
export const ShareMessageSchema = z.looseObject({ role: z.string(), content: z.union([z.string(), z.null(), z.array(Json)]).optional() })
export const ShareSchema = z.looseObject({ title: z.string(), messages: z.array(ShareMessageSchema), message_count: z.number().int(), created_at: z.number().optional(), updated_at: z.number().optional(), model: NullableString.optional() })
export const ShareReadSchema = z.looseObject({ share: ShareSchema })

export const SessionNewRequestSchema = z.looseObject({
  title: z.string().optional(), workspace: z.string().optional(), workspace_inherited_from_prev_session: z.boolean().optional(), model: z.string().nullable().optional(), model_provider: z.string().nullable().optional(),
  profile: z.string().nullable().optional(), prev_session_id: z.string().optional(), project_id: z.string().nullable().optional(), worktree: Json.optional(), enabled_toolsets: z.array(z.string()).nullable().optional(), parent_session_id: z.string().optional(),
})
export const TranscribeCapabilitySchema = z.looseObject({ ok: z.literal(true), available: z.boolean(), provider: z.string() })

// ── settings, profiles, models, providers ───────────────────────────────

export const LoginResponseSchema = z.looseObject({ ok: z.literal(true), message: z.string().optional() })
export const SettingsSchema = z.looseObject({
  bot_name: z.string().optional(), default_model: z.string().optional(), default_workspace: z.string().optional(), language: z.string().optional(), send_key: z.string().optional(), font_size: z.string().optional(),
  full_width_chat: z.boolean().optional(), auto_scroll_follow: z.boolean().optional(), render_user_markdown: z.boolean().optional(), chat_activity_display_mode: z.string().optional(), default_message_mode: z.string().optional(),
  fade_text_effect: z.boolean().optional(), hidden_tabs: z.array(z.string()).optional(), composer_control_order: z.array(z.string()).optional(), show_cli_sessions: z.boolean().optional(), show_claude_code_sessions: z.boolean().optional(),
  show_cron_sessions: z.boolean().optional(), show_webhook_sessions: z.boolean().optional(), show_kanban_sessions: z.boolean().optional(), check_for_updates: z.boolean().optional(), ignore_agent_updates: z.boolean().optional(),
  auth_enabled: z.boolean().optional(), password_auth_enabled: z.boolean().optional(), password_env_var: z.boolean().optional(), passkeys_enabled: z.boolean().optional(), passwordless_enabled: z.boolean().optional(),
  auth_disabled_acknowledged: z.boolean().optional(), webui_version: z.string().optional(), agent_version: z.string().optional(), update_channel: z.string().optional(), agent_update_channel: z.enum(['stable', 'experimental']).optional(), update_channel_version: NullableString.optional(),
  max_tokens: NullableNumber.optional(), max_tokens_effective: NullableNumber.optional(), max_tokens_fallback: NullableNumber.optional(), tts_engine: z.string().optional(), tts_voice: z.string().optional(),
  dictation_append: z.boolean().optional(), persisted_speech_keys: z.array(z.string()).optional(),
})
export type Settings = z.infer<typeof SettingsSchema>
export const ProfileSchema = z.looseObject({
  name: z.string(), path: z.string().optional(), is_active: z.boolean().optional(), is_default: z.boolean().optional(), model: NullableString.optional(), provider: NullableString.optional(), skill_count: z.number().optional(),
  total_skills: z.number().optional(), enabled_skills: z.number().optional(), gateway_running: z.boolean().optional(), has_env: z.boolean().optional(), visible: z.boolean().optional(),
})
export const ProfilesSchema = z.looseObject({ profiles: z.array(ProfileSchema), active: z.string(), single_profile_mode: z.boolean().optional() })
export type Profiles = z.infer<typeof ProfilesSchema>
export const ActiveProfileSchema = z.looseObject({ name: z.string(), path: z.string().optional(), is_default: z.boolean().optional(), default_workspace: NullableString.optional() })
export const ProfileSwitchSchema = ProfilesSchema.extend({ is_default: z.boolean(), default_model: Json, default_model_provider: Json, default_workspace: z.string().nullable() })
/** `/api/reasoning`: config.yaml agent.reasoning_effort / display.show_reasoning, resolved for a model. */
export const ReasoningStatusSchema = z.looseObject({ show_reasoning: z.boolean().optional(), reasoning_effort: z.string().nullable().optional(), supported_efforts: z.array(z.string()).optional(), supports_reasoning_effort: z.boolean().optional(), supports_thinking_toggle: z.boolean().optional() })
export type ReasoningStatus = z.infer<typeof ReasoningStatusSchema>
export const ModelEntrySchema = z.looseObject({ id: z.string(), label: z.string().optional(), provider: z.string().optional(), supports_fast_tier: z.boolean().optional() })
export const ModelGroupSchema = z.looseObject({ provider: z.string(), provider_id: z.string().optional(), models: z.array(ModelEntrySchema), extra_models: z.array(ModelEntrySchema).optional() })
export const ModelsSchema = z.looseObject({ active_provider: NullableString.optional(), default_model: z.string().optional(), groups: z.array(ModelGroupSchema), aliases: z.record(z.string(), Json).optional(), configured_model_badges: z.record(z.string(), Json).optional() })
export type Models = z.infer<typeof ModelsSchema>
export const ProviderSchema = z.looseObject({
  id: z.string(), display_name: z.string().optional(), has_key: z.boolean().optional(), configurable: z.boolean().optional(), is_oauth: z.boolean().optional(), is_plugin_provider: z.boolean().optional(), is_self_hosted: z.boolean().optional(),
  is_custom: z.boolean().optional(), key_source: z.string().optional(), base_url: NullableString.optional(), auth_error: NullableString.optional(), env_var: NullableString.optional(), models: z.array(ModelEntrySchema).optional(), models_total: z.number().optional(),
})
export const ProvidersSchema = z.looseObject({ providers: z.array(ProviderSchema), active_provider: NullableString.optional() })
export const QuotaSourceSchema = z.looseObject({
  source_id: z.string(), provider_id: z.string().optional(), provider_label: z.string().optional(), account_label: z.string().optional(), status: z.string().optional(), supported: z.boolean().optional(), message: z.string().nullable().optional(),
  is_active_provider: z.boolean().optional(), quota: Json.optional(), windows: Json.optional(), balances: Json.optional(), plan: Json.optional(), details: Json.optional(), unavailable_reason: Json.optional(), retry_after: Json.optional(), fetched_at: Json.optional(),
})
/** Python `get_provider_quotas`: the stable identity envelope the iOS quota widget persists (`scope_id`/`profile_id`). */
export const ProviderQuotasSchema = z.looseObject({ version: z.number(), scope_id: z.string(), profile_id: z.string(), active_provider: NullableString, requested_source_id: NullableString, missing_source: z.boolean(), sources: z.array(QuotaSourceSchema) })
export const PersonalitiesSchema = z.looseObject({ personalities: z.array(z.looseObject({ name: z.string(), description: z.string().optional() })) })
export const AuxiliaryTaskSchema = z.looseObject({ task: z.string(), label: z.string().optional(), description: z.string().optional(), model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional(), api_key_set: z.boolean().optional() })
export const AuxiliaryModelsSchema = z.looseObject({ main: z.looseObject({ model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional(), api_key_set: z.boolean().optional() }).optional(), tasks: z.array(AuxiliaryTaskSchema).optional() })
export const MaxTokensSchema = z.looseObject({ max_tokens: NullableNumber, max_tokens_effective: NullableNumber, max_tokens_fallback: NullableNumber })

// ── workspaces, files, git ───────────────────────────────────────────────

export const WorkspaceEntrySchema = z.looseObject({ name: z.string().optional(), path: z.string() })
export type Workspace = z.infer<typeof WorkspaceEntrySchema>
export const WorkspacesSchema = z.looseObject({ workspaces: z.array(WorkspaceEntrySchema), last: NullableString.optional(), terminal_remote_backend: z.boolean().optional() })
export type Workspaces = z.infer<typeof WorkspacesSchema>
export const FileEntrySchema = z.looseObject({
  name: z.string(), path: z.string().optional(), is_dir: z.boolean().optional(), type: z.string().optional(), size: z.number().nullable().optional(), mtime: z.number().nullable().optional(), mtime_ns: z.union([z.number(), z.string()]).nullable().optional(),
  birthtime_ns: z.union([z.number(), z.string()]).nullable().optional(), hidden: z.boolean().optional(), workspace_sort_rank: z.number().int().optional(), target: z.string().optional(), target_outside_workspace: z.boolean().optional(),
})
export const DirListingSchema = z.looseObject({ path: z.string().optional(), entries: z.array(FileEntrySchema), signature: z.string().optional(), workspace: z.string().optional(), workspace_recovered: z.boolean().optional(), is_git: z.boolean().optional() })
export const FileContentSchema = z.looseObject({ path: z.string().optional(), content: z.string().optional(), lines: z.number().optional(), size: z.number().optional(), truncated: z.boolean().optional(), binary: z.boolean().optional(), mime: z.string().optional() })
export const GitInfoSchema = z.looseObject({ git: z.looseObject({ is_git: z.boolean().optional(), branch: NullableString.optional(), dirty: z.number().optional(), modified: z.number().optional(), untracked: z.number().optional(), ahead: z.number().optional(), behind: z.number().optional() }).nullable().optional() })

// ── tools ────────────────────────────────────────────────────────────────

export const SkillSchema = z.looseObject({ name: z.string(), description: NullableString.optional(), category: NullableString.optional(), disabled: z.boolean().optional() })
export const SkillsSchema = z.looseObject({ skills: z.array(SkillSchema), categories: z.array(Json).optional() })
export const SkillContentSchema = z.looseObject({ name: z.string().optional(), content: z.string().optional(), path: z.string().optional(), success: z.boolean().optional(), message: z.string().optional(), ok: z.boolean().optional() })
export const SkillsUsageSchema = z.looseObject({ usage: z.record(z.string(), z.looseObject({ use_count: z.number().optional(), view_count: z.number().optional(), patch_count: z.number().optional() })), skill_names: z.array(z.string()).optional(), total_invocations: z.number().optional(), unique_skills_used: z.number().optional() })
export const MemorySchema = z.looseObject({
  memory: z.string(), user: z.string(), soul: z.string(), project_context: z.string().optional(), memory_path: z.string().optional(), user_path: z.string().optional(), soul_path: z.string().optional(), project_context_path: z.string().optional(),
  project_context_name: z.string().optional(), project_context_workspace: z.string().optional(), memory_mtime: NullableNumber.optional(), user_mtime: NullableNumber.optional(), soul_mtime: NullableNumber.optional(), project_context_mtime: NullableNumber.optional(),
  project_context_shadowed: z.array(Json).optional(), external_notes_enabled: z.boolean().optional(),
})
export type Memory = z.infer<typeof MemorySchema>
export const PromptSchema = z.looseObject({ id: z.string().optional(), name: z.string().optional(), title: z.string().optional(), label: z.string().optional(), text: z.string().optional(), content: z.string().optional(), created_at: z.number().optional() })
export const PromptsSchema = z.looseObject({ prompts: z.array(PromptSchema) })
export const CommandRowSchema = z.looseObject({ name: z.string(), description: z.string().optional(), aliases: z.array(z.string()).optional(), args_hint: z.string().optional(), category: z.string().optional(), cli_only: z.boolean().optional(), gateway_only: z.boolean().optional(), subcommands: z.array(Json).optional() })
export const CommandsSchema = z.looseObject({ commands: z.array(CommandRowSchema) })
export type Command = z.infer<typeof CommandRowSchema>
export const LogsSchema = z.looseObject({ file: z.string(), tail: z.number().optional(), lines: z.array(z.string()), truncated: z.boolean().optional(), total_bytes: z.number().optional(), mtime: NullableNumber.optional(), hint: z.string().optional() })
export type Logs = z.infer<typeof LogsSchema>
export const InsightsSchema = z.looseObject({
  period_days: z.number().optional(), total_sessions: z.number().optional(), total_messages: z.number().optional(), total_tokens: z.number().optional(), total_input_tokens: z.number().optional(), total_output_tokens: z.number().optional(),
  total_cache_read_tokens: z.number().optional(), total_cache_hit_percent: NullableNumber.optional(), total_cost: z.number().optional(), activity_by_day: z.array(z.looseObject({ day: z.string(), sessions: z.number() })).optional(),
  activity_by_hour: z.array(z.looseObject({ hour: z.number(), sessions: z.number() })).optional(), daily_tokens: z.array(z.looseObject({ date: z.string(), input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional(), cost: z.number().optional(), sessions: z.number().optional() })).optional(),
  models: z.array(z.looseObject({ model: z.string().optional(), sessions: z.number().optional(), tokens: z.number().optional(), cost: z.number().optional() })).optional(),
})
export type Insights = z.infer<typeof InsightsSchema>
export const DashboardStatusSchema = z.looseObject({ running: z.boolean(), enabled: z.string().optional(), url: z.string().optional(), browser_url: z.string().optional(), host: z.string().optional(), port: z.number().int().optional(), version: z.string().optional(), error: z.string().optional() })
export const AgentHealthSchema = z.looseObject({ alive: z.boolean().nullable().optional(), checked_at: z.string().optional(), details: z.looseObject({ state: z.string().optional(), reason: z.string().optional() }).optional(), gateway_chat: z.looseObject({ enabled: z.boolean().optional(), backend: z.string().optional(), base_url_configured: z.boolean().optional(), api_key_configured: z.boolean().optional() }).optional(), error: z.string().optional() })
export const SystemHealthSchema = z.looseObject({
  available: z.boolean().optional(), status: z.string().optional(), checked_at: z.string().optional(), cpu: Json.nullable().optional(), memory: Json.nullable().optional(), disk: z.looseObject({ percent: z.number().optional(), total_bytes: z.number().optional(), used_bytes: z.number().optional() }).nullable().optional(),
  errors: z.array(z.looseObject({ code: z.string().optional(), metric: z.string().optional() })).optional(), webui_runtime: Json.optional(),
})
export const UpdateTargetSchema = z.looseObject({ name: z.string().optional(), channel: z.enum(['stable', 'experimental']).optional(), unsupported: z.boolean().optional(), supported_revision: z.string().optional(), supported_version: z.string().optional(), candidate_revision: z.string().optional(), behind: z.number().nullable().optional(), current_sha: z.string().nullable().optional(), latest_sha: z.string().nullable().optional(), compare_url: z.string().optional(), repo_url: z.string().optional(), error: z.string().optional(), ok: z.boolean().optional(), manual_update: z.boolean().optional(), no_git: z.boolean().optional(), install_kind: z.literal('npm').optional(), npm: z.string().optional(), dirty: z.boolean().optional(), metadata_repair: z.boolean().optional(), release_url: z.string().optional(), ignored: z.boolean().optional(), current_version: z.string().optional() })
export const UpdatesCheckSchema = z.looseObject({ disabled: z.boolean().optional(), cached: z.boolean().optional(), channel: z.string().optional(), agent_channel: z.enum(['stable', 'experimental']).optional(), checked_at: z.number().optional(), include_agent: z.boolean().optional(), webui: UpdateTargetSchema.nullable().optional(), agent: UpdateTargetSchema.nullable().optional() })
export const UpdatesSummarySchema = z.looseObject({ summary: z.string().optional(), text: z.string().optional(), ok: z.boolean().optional(), error: z.string().optional(), diff_links: z.array(Json).optional() })
export const UpdateApplySchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional(), error: z.string().optional(), message: z.string().optional(), lock: Json.optional(), confirmation_required: z.boolean().optional(), candidate_revision: z.string().optional(), supported_revision: z.string().optional(), supported_version: z.string().optional(), agent_channel: z.enum(['stable', 'experimental']).optional() })
export const PluginSchema = z.looseObject({ key: z.string(), name: z.string().optional(), kind: z.string().optional(), enabled: z.boolean().optional(), description: z.string().optional(), version: z.string().optional(), activation: z.string().optional(), is_active_provider: z.boolean().optional(), hooks: z.array(Json).optional() })
export const PluginsSchema = z.looseObject({ plugins: z.array(PluginSchema), empty: z.boolean().optional(), read_only: z.boolean().optional(), supported_hooks: z.array(z.string()).optional(), unavailable: z.boolean().optional() })
export const McpServerSchema = z.looseObject({ name: z.string(), id: z.string().optional(), transport: z.string().optional(), enabled: z.boolean().optional(), active: z.boolean().optional(), status: z.string().optional(), tools: z.number().optional(), tool_count: z.number().int().nullable().optional(), health: z.string().optional(), health_detail: z.string().optional(), health_checked_at: Json.optional(), health_pending: z.boolean().optional() })
export const McpServersSchema = z.looseObject({ servers: z.array(McpServerSchema), health_pending: z.boolean().optional(), reload_required: z.boolean().optional(), toggle_supported: z.boolean().optional() })
export const McpToolsSchema = z.looseObject({ tools: z.array(z.looseObject({ name: z.string().optional(), server: z.string().optional(), description: z.string().optional() })), total: z.number().int().optional(), source: z.string().optional(), inventory_scope: z.string().optional(), unavailable_servers: z.array(z.string()).optional() })
export const NotesSourcesSchema = z.looseObject({ enabled: z.boolean().optional(), sources: z.array(Json).optional(), source: z.string().optional(), inventory_scope: z.string().optional(), recent_ai_notes: z.array(Json).optional(), attach_supported: z.boolean().optional(), automatic_recall_unchanged: z.boolean().optional() })
export const TodoItemSchema = z.looseObject({ id: z.union([z.string(), z.number()]).optional(), text: z.string().optional(), content: z.string().optional(), title: z.string().optional(), status: z.string().optional(), done: z.boolean().optional(), completed: z.boolean().optional() })
export const TodoStateSchema = z.looseObject({ session_id: z.string().optional(), todos: z.array(TodoItemSchema).optional(), version: z.number().optional(), ts: z.number().optional(), source: z.string().optional(), description: z.string().optional(), pending_count: z.number().optional() })
export type TodoState = z.infer<typeof TodoStateSchema>

// ── onboarding ───────────────────────────────────────────────────────────

export const OnboardingProviderSchema = z.looseObject({ id: z.string(), name: z.string().optional(), label: z.string().optional(), kind: z.string().optional(), oauth: z.boolean().optional(), needs_key: z.boolean().optional(), base_url: NullableString.optional(), models: z.array(Json).optional(), category: z.string().optional() })
export const OnboardingStatusSchema = z.looseObject({
  completed: z.boolean(),
  settings: z.looseObject({ bot_name: z.string().optional(), default_model: z.string().optional(), default_workspace: NullableString.optional(), password_enabled: z.boolean().optional() }).optional(),
  setup: z.looseObject({ providers: z.array(OnboardingProviderSchema).optional(), categories: z.array(Json).optional(), current: z.looseObject({ provider: z.string().optional(), model: z.string().optional(), base_url: z.string().optional() }).optional(), current_is_oauth: z.boolean().optional(), unsupported_note: z.string().optional() }).optional(),
  system: z.looseObject({ hermes_found: z.boolean().optional(), imports_ok: z.boolean().optional(), chat_ready: z.boolean().optional(), provider_ready: z.boolean().optional(), provider_configured: z.boolean().optional(), setup_state: z.string().optional(), provider_note: z.string().optional(), provider_note_key: z.string().optional(), missing_modules: z.array(z.string()).optional(), import_errors: z.record(z.string(), z.string()).optional(), config_path: z.string().optional(), env_path: z.string().optional() }).optional(),
  workspaces: z.looseObject({ items: z.array(WorkspaceEntrySchema).optional(), last: NullableString.optional() }).optional(),
  models: ModelsSchema.optional(),
})
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>
export const OnboardingProbeSchema = z.looseObject({ ok: z.boolean().optional(), success: z.boolean().optional(), error: z.string().optional(), message: z.string().optional(), models: z.array(Json).optional() })
export const OnboardingOAuthSchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional(), url: z.string().optional(), verification_url: z.string().optional(), user_code: z.string().optional(), message: z.string().optional(), error: z.string().optional(), flow_id: z.string().optional() })

// ── automation ───────────────────────────────────────────────────────────

export const CronScheduleSchema = z.looseObject({ kind: z.string().optional(), expr: z.string().optional(), minutes: z.number().optional(), run_at: z.string().optional(), display: z.string().optional() })
export const CronRepeatSchema = z.looseObject({ times: NullableNumber.optional(), completed: z.number().optional() })
export const CronJobViewSchema = z.looseObject({
  read_only: z.boolean().optional(), owner_profile: NullableString.optional(), id: z.string().optional(), job_id: z.string().optional(), name: z.string().nullable().optional(), prompt: z.string().optional(), schedule: z.union([z.string(), CronScheduleSchema]).optional(),
  schedule_display: z.string().optional(), enabled: z.boolean().optional(), paused: z.boolean().optional(), paused_reason: NullableString.optional(), state: NullableString.optional(), last_status: NullableString.optional(), last_error: NullableString.optional(),
  last_delivery_error: NullableString.optional(), next_run_at: z.union([z.string(), z.number(), z.null()]).optional(), last_run_at: z.union([z.string(), z.number(), z.null()]).optional(), repeat: z.union([CronRepeatSchema, z.number(), z.null()]).optional(),
  status: z.string().optional(), last_run: Json.optional(), next_run: Json.optional(), profile: NullableString.optional(), session_id: NullableString.optional(), model: NullableString.optional(), provider: NullableString.optional(), workspace: NullableString.optional(),
  workdir: NullableString.optional(), deliver: NullableString.optional(), skills: z.array(z.string()).optional(), no_agent: z.boolean().optional(), script: NullableString.optional(), monitor: NullableString.optional(), continuity: z.boolean().optional(),
  context_from: z.union([z.array(z.string()), z.string(), z.null()]).optional(), reasoning_effort: NullableString.optional(), toast_notifications: z.boolean().optional(), running: z.boolean().optional(),
})
export type CronJob = z.infer<typeof CronJobViewSchema>
export const CronsSchema = z.looseObject({ jobs: z.array(CronJobViewSchema), active_profile: z.string().optional(), all_profiles: z.boolean().optional(), other_profile_count: z.number().optional(), cron_unavailable: z.boolean().optional() })
export type Crons = z.infer<typeof CronsSchema>
export const CronMutationSchema = z.looseObject({ ok: z.boolean().optional(), job: CronJobViewSchema.optional(), job_id: z.string().optional(), status: z.string().optional(), error: z.string().optional(), elapsed: z.number().optional() })
export const CronRunUsageSchema = z.looseObject({ input_tokens: NullableNumber.optional(), output_tokens: NullableNumber.optional(), total_tokens: NullableNumber.optional(), estimated_cost_usd: NullableNumber.optional(), duration_seconds: NullableNumber.optional(), model: z.string().optional(), provider: z.string().optional() })
export const CronRunSummarySchema = z.looseObject({ filename: z.string(), size: z.number(), modified: z.number(), usage: CronRunUsageSchema.optional() })
export const CronHistorySchema = z.looseObject({ job_id: z.string().optional(), runs: z.array(CronRunSummarySchema), total: z.number().optional(), offset: z.number().optional() })
export type CronHistory = z.infer<typeof CronHistorySchema>
export const CronRunSchema = z.looseObject({ content: z.string().optional(), snippet: z.string().optional(), usage: CronRunUsageSchema.optional(), error: z.string().optional() })
export const CronStatusSchema = z.looseObject({ running: z.union([z.boolean(), z.record(z.string(), z.number())]).optional() })
export const KanbanTaskViewSchema = z.looseObject({ id: z.union([z.string(), z.number()]), title: z.string().optional(), status: z.string().optional(), assignee: NullableString.optional(), priority: z.union([z.string(), z.number()]).nullable().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), session_id: NullableString.optional(), archived: z.boolean().optional(), created_at: Json.optional(), updated_at: Json.optional() })
export const KanbanColumnSchema = z.looseObject({ name: z.string(), tasks: z.array(KanbanTaskViewSchema) })
export const KanbanBoardViewSchema = z.looseObject({ columns: z.array(KanbanColumnSchema).optional(), assignees: z.array(Json).optional(), filters: Json.optional(), latest_event_id: z.number().optional(), read_only: z.boolean().optional(), tenants: z.array(Json).optional(), changed: z.boolean().optional() })
export const KanbanBoardsViewSchema = z.looseObject({ boards: z.array(z.looseObject({ slug: z.string(), name: z.string().nullable().optional(), is_current: z.boolean().optional(), total: z.number().optional(), archived: z.boolean().optional(), color: z.string().optional(), icon: z.string().optional(), description: z.string().optional() })), current: z.string().optional(), read_only: z.boolean().optional() })
export const ExtensionStatusSchema = z.looseObject({
  enabled: z.boolean(), extension_dir_configured: z.boolean().optional(), extension_dir_valid: z.boolean().optional(), script_urls: z.array(z.string()).optional(), stylesheet_urls: z.array(z.string()).optional(), sidecars: z.array(Json).optional(),
  extensions: z.array(z.looseObject({ id: z.string(), enabled: z.boolean().optional(), name: z.string().optional(), version: z.string().optional() })).optional(), warnings: z.array(Json).optional(),
  manifest: z.looseObject({ configured: z.boolean().optional(), loaded: z.boolean().optional(), status: z.string().optional(), entry_count: z.number().optional() }).optional(), counts: z.record(z.string(), z.number()).optional(), gallery_installed: z.record(z.string(), Json).optional(),
})
