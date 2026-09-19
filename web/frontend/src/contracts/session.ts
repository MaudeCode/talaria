import { z } from 'zod'
import { NullableNumber, NullableString, UnixSeconds } from './common'

export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'invalid session id')
export type SessionId = z.infer<typeof SessionIdSchema>

export const AttachmentSchema = z.looseObject({
  filename: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  size: z.number().optional(),
  mime: z.string().optional(),
  is_image: z.boolean().optional(),
  rollback_token: z.string().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

/** Stored transcripts carry the OpenAI shape (`function.name` / `function.arguments` JSON string); live events carry `name` / `args`. */
export const ToolCallSchema = z.looseObject({
  name: z.string().optional(),
  args: z.unknown().optional(),
  function: z.looseObject({ name: z.string().optional(), arguments: z.unknown().optional() }).optional(),
  id: z.string().optional(),
  call_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  done: z.boolean().optional(),
  is_error: z.boolean().optional(),
  preview: z.string().nullable().optional(),
  result: z.unknown().optional(),
  output: z.unknown().optional(),
  duration: z.number().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  timestamp: z.number().nullable().optional(),
  event_type: z.string().optional(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

/** Message content: plain string or an array of typed parts (text, image_url, ...). */
export const ContentPartSchema = z.looseObject({ type: z.string(), text: z.string().optional() })
export const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema), z.null()])

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])

/** Persisted rows have integer ids; live rows carry string ids. */
export const MessageIdSchema = z.union([z.string(), z.number()])

export const MessageSchema = z.looseObject({
  role: z.string(),
  content: MessageContentSchema.optional(),
  id: MessageIdSchema.optional(),
  message_id: MessageIdSchema.optional(),
  timestamp: z.number().nullable().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  reasoning: z.union([z.string(), z.array(z.unknown())]).nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  tool_call_id: z.string().optional(),
  tool_use_id: z.string().optional(),
  name: z.string().optional(),
  badge: z.string().optional(),
  label: z.string().optional(),
  provider_details: z.unknown().optional(),
  provider_details_label: z.string().optional(),
  recovery_control: z.unknown().optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const ComposerDraftSchema = z.looseObject({ text: z.string().optional(), files: z.array(z.unknown()).optional() })

/** Full session record from `GET /api/session` and mutations returning `session`. */
export const SessionSchema = z.looseObject({
  session_id: SessionIdSchema,
  title: z.string(),
  workspace: z.string().optional(),
  created_workspace: z.string().nullable().optional(),
  model: NullableString.optional(),
  model_provider: NullableString.optional(),
  messages: z.array(MessageSchema).optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  created_at: UnixSeconds.optional(),
  updated_at: UnixSeconds.optional(),
  last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(),
  user_message_count: z.number().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  project_id: NullableString.optional(),
  profile: NullableString.optional(),
  personality: NullableString.optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  cache_hit_percent: NullableNumber.optional(),
  estimated_cost: NullableNumber.optional(),
  active_stream_id: NullableString.optional(),
  is_streaming: z.boolean().optional(),
  has_pending_user_message: z.boolean().optional(),
  pending_user_message: NullableString.optional(),
  pending_attachments: z.array(AttachmentSchema).optional(),
  pending_started_at: NullableNumber.optional(),
  pending_user_source: NullableString.optional(),
  context_length: NullableNumber.optional(),
  threshold_tokens: NullableNumber.optional(),
  last_prompt_tokens: NullableNumber.optional(),
  post_compression_context_tokens_estimate: NullableNumber.optional(),
  enabled_toolsets: z.array(z.string()).nullable().optional(),
  composer_draft: ComposerDraftSchema.optional(),
  is_cli_session: z.boolean().optional(),
  read_only: z.boolean().optional(),
  source_tag: NullableString.optional(),
  source_label: NullableString.optional(),
  session_source: NullableString.optional(),
  raw_source: NullableString.optional(),
  parent_session_id: NullableString.optional(),
  worktree_path: NullableString.optional(),
  worktree_branch: NullableString.optional(),
  worktree_repo_root: NullableString.optional(),
  share_token: NullableString.optional(),
  share_created_at: NullableNumber.optional(),
  manual_title: z.boolean().optional(),
  compression_anchor_summary: NullableString.optional(),
  compression_recovery: z.record(z.string(), z.unknown()).optional(),
  recommended_recovery_action: NullableString.optional(),
  compression_recovery_action: NullableString.optional(),
  compression_recovery_source_session_id: NullableString.optional(),
  gateway_routing: z.unknown().optional(),
  _messages_offset: z.number().optional(),
  _messages_truncated: z.boolean().optional(),
  _msg_limit_max: z.number().optional(),
  _load_revision: z.string().optional(),
})
export type Session = z.infer<typeof SessionSchema>

export const SessionEnvelopeSchema = z.looseObject({ session: SessionSchema })

/** Sidebar row from `GET /api/sessions`. */
export const SessionRowSchema = z.looseObject({
  session_id: SessionIdSchema,
  title: z.string(),
  workspace: z.string().optional(),
  model: NullableString.optional(),
  created_at: UnixSeconds.optional(),
  updated_at: UnixSeconds.optional(),
  last_message_at: NullableNumber.optional(),
  message_count: z.number().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  project_id: NullableString.optional(),
  profile: NullableString.optional(),
  is_streaming: z.boolean().optional(),
  is_cli_session: z.boolean().optional(),
  cron_running: z.boolean().optional(),
  read_only: z.boolean().optional(),
  attention: z.looseObject({ kind: z.string().optional(), count: z.number().optional() }).nullable().optional(),
  source_tag: NullableString.optional(),
  source_label: NullableString.optional(),
  session_source: NullableString.optional(),
  raw_source: NullableString.optional(),
  parent_session_id: NullableString.optional(),
  active_stream_id: NullableString.optional(),
  share_token: NullableString.optional(),
  worktree_branch: NullableString.optional(),
})
export type SessionRow = z.infer<typeof SessionRowSchema>

export const SessionsListSchema = z.looseObject({
  sessions: z.array(SessionRowSchema),
  active_profile: z.string().optional(),
  all_profiles: z.boolean().optional(),
  include_archived: z.boolean().optional(),
  archived_count: z.number().optional(),
  other_profile_count: z.number().optional(),
  server_time: z.number().optional(),
  server_tz: z.string().optional(),
  webui_session_count: z.number().optional(),
  cli_session_count: z.number().optional(),
  sidebar_reference_sessions: z.array(SessionRowSchema).optional(),
})
export type SessionsList = z.infer<typeof SessionsListSchema>

export const SessionStatusSchema = z.looseObject({
  session_id: SessionIdSchema,
  title: z.string().optional(),
  active_stream_id: NullableString.optional(),
  agent_running: z.boolean().optional(),
  message_count: z.number().optional(),
  model: NullableString.optional(),
  profile: NullableString.optional(),
  workspace: z.string().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  estimated_cost: NullableNumber.optional(),
  updated_at: UnixSeconds.optional(),
})
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionUsageSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  estimated_cost: NullableNumber.optional(),
  model: NullableString.optional(),
})

export const ProjectSchema = z.looseObject({ id: z.string(), name: z.string(), color: z.string().optional(), profile: NullableString.optional() })
export const ProjectsSchema = z.looseObject({ projects: z.array(ProjectSchema), active_profile: z.string().optional(), all_profiles: z.boolean().optional(), other_profile_count: z.number().optional() })

export const SessionDeleteResultSchema = z.looseObject({ ok: z.boolean(), state_db_cleanup_failed: z.boolean().optional() })
