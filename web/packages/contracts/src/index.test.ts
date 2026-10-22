import { settingsContract, ReasoningUnsupportedSchema } from './routes/settings.js'
import { RpcRequestSchema } from './sidecar/rpc.js'
import { ModelConfirmationRequiredSchema, sessionsContract } from './routes/sessions.js'
import { ChatStartResponseSchema, MessageSchema, SessionSchema, ToolCallSchema } from './views.js'
import { ExecutionModesSchema, OwnerAttachmentSchema, OwnerActionRequestSchema, GatewaySessionResultSchema } from './gateway-session.js'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { CronBlueprintsSchema, CronBlueprintFillSchema, AgentHealthSchema, ErrorBodySchema, ChatEventSchema, ClarifyPendingEnvelopeSchema, MemoryWriteRefusalSchema, ModelsSchema, ProviderQuotasSchema, SIDECAR_RPC_VERSION, SkillsSchema, SpeechPrepareSchema, TranscribeResponseSchema, TranscribeStreamEndSchema, TranscribeStreamEventSchema, TranscribeStreamStartSchema, UpdatesCheckSchema, UpdateNotificationsSchema, UpdateApplySchema, SteerSendNowResponseSchema } from './index.js'

const shared = (path: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts', path), 'utf8'))

describe('contracts package', () => {
  it('preserves the scheduled-chat refusal and nonretryable recovery instruction', () => {
    const fixture = shared('fixtures/native-cron-refusal.json') as { event: unknown }
    expect(ChatEventSchema.parse(fixture.event)).toEqual(fixture.event)
  })
  it('accepts the shared closed voice-stop receipt and existing suppressed response', () => {
    const fixture = shared('fixtures/gateway-owner.json') as { voice_stop_receipt: unknown; voice_stop_response: unknown }
    const result = { state: 'attached', reason: null, snapshot: null, receipt: fixture.voice_stop_receipt }
    expect(GatewaySessionResultSchema.parse(result).receipt).toEqual({ voice_stopped: true })
    const response = ChatStartResponseSchema.parse(fixture.voice_stop_response)
    expect(response).toMatchObject({ ok: true, status: 'suppressed', reason: 'voice_stopped' })
    expect(response).not.toHaveProperty('stream_id')
    for (const receipt of [{ voice_stopped: false }, { voice_stopped: 'true' }, { voice_stopped: true, operation: 'model' }]) {
      expect(GatewaySessionResultSchema.safeParse({ ...result, receipt }).success).toBe(false)
    }
  })
  it('preserves chat identity and profile intent at the shared reasoning boundary', () => {
    const fixture = shared('fixtures/reasoning-scope.json') as { effort: unknown; reset: unknown; profile: unknown; refusal: unknown; status: unknown }
    const input = settingsContract.reasoning.set['~orpc'].inputSchema!
    for (const request of [fixture.effort, fixture.reset, fixture.profile]) expect(input.parse(request)).toEqual(request)
    expect(input.safeParse({ effort: 'high', session_id: '' }).success).toBe(false)
    expect(input.safeParse({ effort: '', session_id: '   ' }).success).toBe(false)
    expect(input.safeParse({ effort: 'high', session_id: null }).success).toBe(false)
    expect(ReasoningUnsupportedSchema.parse(fixture.refusal)).toEqual(fixture.refusal)
    expect(settingsContract.reasoning.get['~orpc'].outputSchema!.parse(fixture.status)).toEqual(fixture.status)
  })
  it('shares live MCP progress between SSE and the running tool view', () => {
    const fixture = shared('fixtures/tool-progress.json') as { running: unknown; completed: unknown; tool: unknown }
    expect(ChatEventSchema.parse(fixture.running)).toEqual(fixture.running)
    expect(ChatEventSchema.parse(fixture.completed)).toEqual(fixture.completed)
    expect(ToolCallSchema.parse(fixture.tool)).toEqual(fixture.tool)
    expect(ToolCallSchema.parse({ id: 'old-agent', name: 'tool' }).progress).toBeUndefined()
  })
  it('accepts optional opaque startup correlation without requiring it from older peers', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'chat.start', params: {} }
    expect(RpcRequestSchema.parse(request)).toEqual(request)
    const correlated = { ...request, trace_id: '11111111-1111-4111-8111-111111111111' }
    expect(RpcRequestSchema.parse(correlated)).toEqual(correlated)
    expect(RpcRequestSchema.safeParse({ ...request, trace_id: '/private/prompt-or-secret' }).success).toBe(false)
  })
  it('validates the native model confirmation refusal against the canonical server schema', () => {
    const fixture = shared('fixtures/model-confirmation.json') as { request: unknown; refusal: unknown }
    expect(sessionsContract.session.update['~orpc'].inputSchema!.parse(fixture.request)).toEqual(fixture.request)
    expect(ModelConfirmationRequiredSchema.parse(fixture.refusal).warnings.map((warning) => warning.kind)).toEqual(['data_policy', 'context_cache'])
  })
  it('preserves recorded owner capabilities and explicit unknown recovery actions', () => {
    const fixture = shared('fixtures/gateway-owner.json') as Record<string, unknown>
    const normal = OwnerAttachmentSchema.parse(fixture.normal)
    const unknown = OwnerAttachmentSchema.parse(fixture.unknown)
    const batch = OwnerAttachmentSchema.parse(fixture.batch)
    const served = OwnerAttachmentSchema.parse(fixture.served)
    const restarting = OwnerAttachmentSchema.parse(fixture.restarting)
    expect(normal).toMatchObject({ state: 'attached', can_submit: true, can_attach: false })
    expect(unknown).toMatchObject({ can_submit: false, admissions: [{ status: 'unknown', actions: ['retry', 'discard'] }] })
    expect(batch.reason).toBe('native_clarify_batch_unavailable')
    expect(served.reason).toBe('served_profile_sessions_unavailable')
    expect(restarting).toMatchObject({ state: 'attached', restarting: true, can_submit: false })
    expect(normal.restarting).toBe(false)
    expect(OwnerActionRequestSchema.safeParse({ session_id: 'fixture', action: 'discard', admission_id: 'input' }).success).toBe(false)
    expect(OwnerActionRequestSchema.safeParse({ session_id: 'fixture', action: 'mutate', operation: 'delete', request_id: 'request', expected_revision: 1, execution_generation: 2, payload: {} }).success).toBe(false)
  })
  it('preserves the shared readiness projection across health, refusal, and replay', () => {
    const fixture = shared('fixtures/chat-readiness.json') as { recovery: { health: unknown; http: unknown; event: unknown }[]; completed_update: unknown; legacy: unknown }
    for (const row of fixture.recovery) {
      const health = AgentHealthSchema.parse(row.health)
      const http = ErrorBodySchema.parse(row.http)
      const event = ChatEventSchema.parse(row.event)
      expect(health.chat?.available).toBe(false)
      if (!health.chat || health.chat.available || event.event !== 'apperror') throw new Error('invalid recovery fixture')
      for (const key of ['agent_runtime_reason', 'agent_update_state', 'retryable', 'restart_scheduled'] as const) {
        expect(http[key]).toEqual(health.chat[key])
        expect(event.data[key]).toEqual(health.chat[key])
      }
    }
    expect(AgentHealthSchema.parse(fixture.completed_update).chat).toEqual({ available: true, condition: null })
    expect(AgentHealthSchema.parse(fixture.legacy).chat).toEqual({ available: false, condition: 'agent_runtime_stale' })
  })

  it('preserves shared catalog recovery authority without turning it into an empty deletion', () => {
    const fixture = shared('fixtures/catalog-recovery.json') as { models: unknown; quotas: unknown }
    const models = ModelsSchema.parse(fixture.models)
    const quotas = ProviderQuotasSchema.parse(fixture.quotas)
    expect(models.availability).toMatchObject({ status: 'stale', authoritative: false })
    expect(models.groups[0]?.availability).toEqual(models.availability)
    expect(models.default_model).toBe('gpt-6.1-sol')
    expect(quotas.availability).toEqual(models.availability)
    expect(quotas.missing_source).toBe(false)
    expect(quotas.sources.every((s) => s.status === 'stale')).toBe(true)
  })

  it('accepts all five explicit background review states and additive older rows (TAL-1022)', () => {
    const fixture = shared('fixtures/background-review.json') as { messages: unknown[] }
    const messages = fixture.messages.map((m) => MessageSchema.parse(m))
    expect(messages.map((m) => m._background_update?.lines[0]?.review_state)).toEqual(['waiting', 'reviewing', 'reviewed', 'failed', 'unknown'])
    expect(MessageSchema.parse({ role: 'user', _background_update: { kind: 'other', attention: false, count: 1, summary: '', lines: [] } })._background_update?.review_state).toBeUndefined()
  })

  it('preserves every shared Send now outcome and the legacy delivery boolean', () => {
    const responses = Object.values(shared('fixtures/steer-send-now.json') as Record<string, unknown>).map((body) => SteerSendNowResponseSchema.parse(body))
    expect(responses.map((r) => r.outcome)).toEqual(['delivered', 'next_step', 'not_running', 'taken', 'failed'])
    expect(responses.map((r) => r.redirected)).toEqual([true, false, false, false, false])
  })

  it('preserves scoped legacy refresh confirmation and rejects malformed consent', () => {
    const pending = UpdateApplySchema.parse(shared('fixtures/agent-update-refresh.json'))
    expect(pending.refresh_confirmation).toEqual({ token: 'c'.repeat(32), services: ['synthetic.dashboard'] })
    expect(UpdateApplySchema.safeParse({ ...pending, refresh_confirmation: { token: 'not-a-token', services: [] } }).success).toBe(false)
  })

  it('preserves the shared Agent update hold and its separate recovery verdicts', () => {
    const hold = UpdateApplySchema.parse(shared('fixtures/agent-update-hold.json'))
    expect(hold.ok).toBe(false)
    expect(hold.recovery_compatibility).toEqual({ manual_execution: false, bot_chat_delivery: false })
    expect(hold.message).toContain('Reconcile')
    expect(UpdateApplySchema.safeParse({ ...hold, recovery_compatibility: { manual_execution: 'false', bot_chat_delivery: false } }).success).toBe(false)
  })
  it('preserves resolved duplicate skill identities in the shared fixture', () => {
    const parsed = SkillsSchema.parse(shared('fixtures/skills.json'))
    expect(parsed.skills.map((row) => row.name)).toEqual(['a/one', 'b/two'])
    expect(parsed.skills.every((row) => row.load_name === row.name && row.status === 'ambiguous' && row.tier === 1)).toBe(true)
  })
  it('parses the shared memory save refusals (TAL-886, TAL-784)', () => {
    const fixture = shared('fixtures/memory-write-refusals.json') as Record<string, unknown>
    expect(Object.values(fixture).map((body) => MemoryWriteRefusalSchema.parse(body).code)).toEqual(['memory_char_limit', 'memory_mask_ambiguous', 'memory_mask_edited', 'memory_conflict'])
  })
  it('parses the shared model picker limits (TAL-807, TAL-935)', () => {
    const groups = ModelsSchema.parse(shared('fixtures/models-limits.json')).groups
    expect(groups.map((g) => [g.limit?.scope ?? null, g.quota_level ?? null])).toEqual([['models', 'warning'], ['account', null], [null, 'critical']])
    expect(groups[0]?.models.map((e) => e.limit?.resets_at ?? null)).toEqual([null, '2026-10-14T16:30:00Z'])
  })
  it('parses the shared live dictation exchange (TAL-802)', () => {
    const fixture = shared('fixtures/transcribe-stream.json') as { start: unknown; end: unknown; events: unknown[]; unavailable: unknown }
    expect(TranscribeStreamStartSchema.parse(fixture.start).sample_rate).toBe(48000)
    expect(TranscribeStreamEndSchema.parse(fixture.end).eos).toBe(true)
    expect(fixture.events.map((event) => TranscribeStreamEventSchema.parse(event).type)).toEqual(['partial', 'partial', 'final'])
    expect(TranscribeStreamEventSchema.parse(fixture.unavailable).type).toBe('error')
    expect(TranscribeStreamStartSchema.safeParse({ sample_rate: 96000 }).success).toBe(false)
  })
  it('parses the shared dictation transcripts, filtered and heard (TAL-917)', () => {
    const fixture = shared('fixtures/transcribe.json') as Record<string, unknown>
    expect(Object.values(fixture).map((body) => TranscribeResponseSchema.parse(body))).toEqual([
      { ok: true, transcript: 'Ship the release notes.', filtered: false }, { ok: true, transcript: '', filtered: true },
    ])
  })
  it('parses prompt-reading progress, unknown progress, explicit clears, and current-session state (TAL-1058)', () => {
    const fixture = shared('fixtures/prompt-reading.json') as { progress: unknown; unknown: unknown; cleared: unknown; session: unknown }
    expect(ChatEventSchema.parse(fixture.progress)).toMatchObject({ event: 'run_status', data: { status: { phase: 'prompt_reading', progress_percent: 42 } } })
    expect(ChatEventSchema.parse(fixture.unknown)).toMatchObject({ data: { status: { phase: 'prompt_reading', progress_percent: null } } })
    expect(ChatEventSchema.parse(fixture.cleared)).toMatchObject({ data: { status: null } })
    expect(SessionSchema.parse(fixture.session).run_status).toEqual({ phase: 'prompt_reading', progress_percent: 42 })
    expect(SessionSchema.parse({ ...(fixture.session as object), run_status: undefined }).run_status).toBeUndefined()
    for (const progress_percent of [-1, 101, '42', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ChatEventSchema.safeParse({ event: 'run_status', data: { session_id: 's', status: { phase: 'prompt_reading', progress_percent } } }).success).toBe(false)
    }
  })
  it('parses the shared rate-limit wait run-status frames (TAL-821)', () => {
    const fixture = shared('fixtures/rate-limit-wait.json') as { wait: unknown; cleared: unknown }
    const wait = ChatEventSchema.parse(fixture.wait)
    expect(wait.event === 'rate_limit_wait' && wait.data.wait).toEqual({ provider: 'openrouter', provider_label: 'OpenRouter', until: 1800000600, until_kind: 'reset' })
    const cleared = ChatEventSchema.parse(fixture.cleared)
    expect(cleared.event === 'rate_limit_wait' && cleared.data.wait).toBeNull()
  })
  it('parses the shared password-manager prompts (TAL-887)', () => {
    const fixture = shared('fixtures/vault-prompts.json') as Record<string, unknown>
    const prompts = Object.values(fixture).map((body) => ClarifyPendingEnvelopeSchema.parse(body).pending?.vault)
    expect(prompts.map((p) => [p?.kind, p?.fields.map((f) => `${f.key}${f.secure ? '*' : ''}`)])).toEqual([
      ['vault_unlock', ['master_password*']], ['vault_save_login', ['identifier', 'password*']], ['vault_code', ['code']], ['skill_secret', ['secret*']],
    ])
  })
  it('parses the shared speech.prepare exchange, which is the Agent answer recorded for its text (TAL-906)', () => {
    const fixture = shared('fixtures/speech-prepare.json') as { request: { text: string }; response: unknown }
    const recorded = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/sidecar/text.json'), 'utf8')) as Record<string, { params: { text: string }; result: unknown }[]>)['text.spoken']
    expect(SpeechPrepareSchema.parse(fixture.response)).toEqual(recorded?.find((entry) => entry.params.text === fixture.request.text)?.result)
  })
  it('exports an integer sidecar RPC version', () => {
    expect(Number.isInteger(SIDECAR_RPC_VERSION)).toBe(true)
    expect(SIDECAR_RPC_VERSION).toBeGreaterThan(0)
  })

  it('publishes contract versions that satisfy their schema', () => {
    const schema = z.fromJSONSchema(shared('versions.schema.json') as Parameters<typeof z.fromJSONSchema>[0])
    expect(schema.safeParse(shared('versions.json')).error).toBeUndefined()
  })

  it('parses the shared failed Web update status and rejects invalid versions', () => {
    const fixture = shared('fixtures/update-rollback.json')
    const parsed = UpdatesCheckSchema.parse(fixture)
    expect(parsed.webui?.failed_update).toEqual({ version: '2.0.0', restored_version: '1.0.0' })
    expect(UpdatesCheckSchema.safeParse({ webui: { ...parsed.webui, failed_update: { version: 2, restored_version: '1.0.0' } } }).success).toBe(false)
  })

  it('parses the shared update notification fixture', () => {
    const fixture = shared('fixtures/update-notifications.json')
    const parsed = UpdateNotificationsSchema.parse(fixture)
    expect(parsed.notifications.map((row) => row.kind)).toEqual(['update', 'system', 'update', 'update', 'agent_warning'])
    expect(parsed.notifications[4]).toMatchObject({ kind: 'agent_warning', target: 'agent', phase: 'active', severity: 'warning', persistent: true, unread: true, can_dismiss: true, actions: [], destination: null })
    expect(parsed.frontend_build).toMatchObject({ refresh_required: true, notification_id: null })
    expect(parsed.notifications[0]).toMatchObject({ phase: 'verifying', presents_dialog: true, dialog_close: 'none', steps: [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { id: 'agent_ready', state: 'active' }] })
    expect(parsed.tab_update).toEqual(parsed.notifications[0])
    expect(parsed.notifications[1]).toMatchObject({ requires_interaction: true, can_dismiss: false, destination: { key: 'settings.system' }, steps: [], dialog_close: 'close' })
    expect(parsed.notifications[2]).toMatchObject({ verified_revision: 'a'.repeat(40), verified_version: 'web-v1.2.3', dialog_close: 'auto' })
    expect(parsed.notifications[3]).toMatchObject({ target: 'agent', phase: 'waiting_for_idle', can_dismiss: false, actions: [{ id: 'restart_gateway_now', style: 'destructive', acknowledges: false }], dialog_close: 'restart_later' })
    expect(UpdateNotificationsSchema.safeParse({ ...parsed, tab_update: { ...parsed.tab_update, steps: [{ id: 'install', label: 'Installing', state: 'running' }] } }).success).toBe(false)
  })
})

it('parses both shared automation blueprint route fixtures', () => {
  const fixture = shared('fixtures/cron-blueprints.json') as { catalog: unknown; fill: unknown }
  expect(CronBlueprintsSchema.parse(fixture.catalog).blueprints.some((b) => b.key === 'morning-brief')).toBe(true)
  expect(CronBlueprintFillSchema.parse(fixture.fill).draft.schedule).toBe('30 8 * * *')
})

it('parses the shared diagnostic execution mode fixtures the App renders (TAL-1045)', () => {
  const fixture = shared('fixtures/execution-modes.json') as Record<'available' | 'unavailable' | 'create_request' | 'created' | 'existing' | 'refusal', unknown>
  expect(ExecutionModesSchema.parse(fixture.available).modes.map((m) => [m.mode, m.available])).toEqual([['normal', true], ['ignore_config', true], ['safe', true]])
  expect(ExecutionModesSchema.parse(fixture.unavailable).modes.filter((m) => !m.available).map((m) => m.reason)).toEqual(['gateway_stopped', 'gateway_stopped'])
  expect(sessionsContract.session.new['~orpc'].inputSchema!.parse(fixture.create_request)).toMatchObject({ execution_mode: 'safe', request_id: 'fixture-creation-1' })
  // The fixture keeps the fields the App reads; the server test matches it against the full envelope.
  const owned = SessionSchema.pick({ session_id: true, execution_mode: true, read_only: true, owner_attachment: true })
  expect(owned.parse((fixture.created as { session: unknown }).session)).toMatchObject({ execution_mode: 'safe', read_only: true, owner_attachment: { state: 'attached' } })
  expect(owned.parse((fixture.existing as { session: unknown }).session).execution_mode).toBe('ignore_config')
  expect(ErrorBodySchema.parse(fixture.refusal)).toMatchObject({ code: 'execution_mode_unavailable', reason: 'gateway_stopped' })
})
