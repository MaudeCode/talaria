import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { ChatEventSchema, MemoryWriteRefusalSchema, ModelsSchema, SIDECAR_RPC_VERSION, SkillsSchema, TranscribeStreamEndSchema, TranscribeStreamEventSchema, TranscribeStreamStartSchema, UpdateNotificationsSchema } from './index.js'

const shared = (path: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts', path), 'utf8'))

describe('contracts package', () => {
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
  it('parses the shared rate-limit wait run-status frames (TAL-821)', () => {
    const fixture = shared('fixtures/rate-limit-wait.json') as { wait: unknown; cleared: unknown }
    const wait = ChatEventSchema.parse(fixture.wait)
    expect(wait.event === 'rate_limit_wait' && wait.data.wait).toEqual({ provider: 'openrouter', provider_label: 'OpenRouter', until: 1800000600 })
    const cleared = ChatEventSchema.parse(fixture.cleared)
    expect(cleared.event === 'rate_limit_wait' && cleared.data.wait).toBeNull()
  })
  it('exports an integer sidecar RPC version', () => {
    expect(Number.isInteger(SIDECAR_RPC_VERSION)).toBe(true)
    expect(SIDECAR_RPC_VERSION).toBeGreaterThan(0)
  })

  it('publishes contract versions that satisfy their schema', () => {
    const schema = z.fromJSONSchema(shared('versions.schema.json') as Parameters<typeof z.fromJSONSchema>[0])
    expect(schema.safeParse(shared('versions.json')).error).toBeUndefined()
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
