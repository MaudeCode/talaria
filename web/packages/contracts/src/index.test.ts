import { MessageSchema } from './views.js'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AgentHealthSchema, ErrorBodySchema, ChatEventSchema, ClarifyPendingEnvelopeSchema, MemoryWriteRefusalSchema, ModelsSchema, ProviderQuotasSchema, SIDECAR_RPC_VERSION, SkillsSchema, SpeechPrepareSchema, TranscribeResponseSchema, TranscribeStreamEndSchema, TranscribeStreamEventSchema, TranscribeStreamStartSchema, UpdatesCheckSchema, UpdateNotificationsSchema, UpdateApplySchema, SteerSendNowResponseSchema } from './index.js'

const shared = (path: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts', path), 'utf8'))

describe('contracts package', () => {
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
      ['vault_unlock', ['master_password*']], ['vault_save_login', ['identifier', 'password*']], ['vault_code', ['code']],
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
    expect(parsed.notifications.map((row) => row.kind)).toEqual(['system', 'update', 'update'])
    expect(parsed.frontend_build).toMatchObject({ refresh_required: true, notification_id: null })
    expect(parsed.notifications[0]).toMatchObject({ requires_interaction: true, can_dismiss: false, destination: { key: 'settings.system' } })
    expect(parsed.notifications[1]).toMatchObject({ verified_revision: 'a'.repeat(40), verified_version: 'web-v1.2.3' })
    expect(parsed.notifications[2]).toMatchObject({ target: 'agent', phase: 'waiting_for_idle', can_dismiss: false, actions: [{ id: 'restart_gateway_now', style: 'destructive', acknowledges: false }] })
  })
})
