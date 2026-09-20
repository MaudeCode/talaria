/**
 * Every captured live payload must parse with the schema the client uses for
 * that endpoint. The same files are checked against the running Python server
 * by tests/test_hweb100_contract_fixtures.py.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ZodType } from 'zod'
import * as C from './index'

const dir = join(import.meta.dirname, '__fixtures__', 'live')

const SCHEMAS: Record<string, ZodType> = {
  auth_status: C.AuthStatusSchema,
  settings: C.SettingsSchema,
  profiles: C.ProfilesSchema,
  profile_active: C.ActiveProfileSchema,
  models: C.ModelsSchema,
  sessions: C.SessionsListSchema,
  session: C.SessionEnvelopeSchema,
  session_metadata: C.SessionEnvelopeSchema,
  session_new: C.SessionEnvelopeSchema,
  session_rename: C.SessionEnvelopeSchema,
  session_status: C.SessionStatusSchema,
  session_usage: C.SessionUsageSchema,
  session_delete: C.SessionDeleteResultSchema,
  session_missing: C.ErrorBodySchema,
  workspaces: C.WorkspacesSchema,
  skills: C.SkillsSchema,
  skills_usage: C.SkillsUsageSchema,
  memory: C.MemorySchema,
  crons: C.CronsSchema,
  projects: C.ProjectsSchema,
  prompts: C.PromptsSchema,
  commands: C.CommandsSchema,
  onboarding_status: C.OnboardingStatusSchema,
  extensions_status: C.ExtensionStatusSchema,
  dashboard_status: C.DashboardStatusSchema,
  health_agent: C.AgentHealthSchema,
  system_health: C.SystemHealthSchema,
  updates_check: C.UpdatesCheckSchema,
  logs: C.LogsSchema,
  insights: C.InsightsSchema,
  plugins: C.PluginsSchema,
  providers: C.ProvidersSchema,
  personalities: C.PersonalitiesSchema,
  kanban_boards: C.KanbanBoardsSchema,
  kanban_board: C.KanbanBoardSchema,
  stream_status: C.StreamStatusSchema,
  mcp_servers: C.McpServersSchema,
  notes_sources: C.NotesSourcesSchema,
  model_auxiliary: C.AuxiliaryModelsSchema,
  provider_quotas: C.ProviderQuotasSchema,
  draft_set: C.DraftResponseSchema,
  goal_status: C.GoalResponseSchema,
  background_status: C.BackgroundStatusSchema,
  approval_pending: C.ApprovalPendingEnvelopeSchema,
  clarify_pending: C.ClarifyPendingEnvelopeSchema,
  api_404: C.ErrorBodySchema,
  list_dir: C.ErrorBodySchema,
  file: C.ErrorBodySchema,
  git_info: C.ErrorBodySchema,
  share_create: C.ErrorBodySchema,
  session_toolsets_bad: C.ErrorBodySchema,
  upload_no_file: C.ErrorBodySchema,
}

describe('live fixtures parse with their contract schemas', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  it('covers every fixture with a schema', () => {
    const missing = files.map((f) => f.slice(0, -5)).filter((n) => !(n in SCHEMAS))
    expect(missing).toEqual([])
  })
  for (const file of files) {
    const name = file.slice(0, -5)
    const schema = SCHEMAS[name]
    if (!schema) continue
    it(name, () => {
      const spec = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { body: unknown }
      const result = schema.safeParse(spec.body)
      if (!result.success) throw new Error(result.error.message)
      expect(result.success).toBe(true)
    })
  }
})

describe('bootstrap schema', () => {
  it('accepts an unauthenticated payload and rejects a malformed one', () => {
    const ok = C.BootstrapSchema.safeParse({
      webui_version: 'x', max_upload_bytes: 1, csrf_token: '', language: '', bot_name: 'Hermes',
      auth: { auth_enabled: true, logged_in: false }, profile: null, onboarding: null,
      features: { dashboard: false, terminal_remote_backend: false, extensions: false, single_profile_mode: false },
    })
    expect(ok.success).toBe(true)
    expect(C.BootstrapSchema.safeParse({ webui_version: 1 }).success).toBe(false)
  })
})
