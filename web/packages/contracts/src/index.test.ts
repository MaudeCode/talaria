import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { SIDECAR_RPC_VERSION, UpdateNotificationsSchema } from './index.js'

const shared = (path: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts', path), 'utf8'))

describe('contracts package', () => {
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
    expect(parsed.notifications.map((row) => row.kind)).toEqual(['system', 'update'])
    expect(parsed.frontend_build).toMatchObject({ refresh_required: true, notification_id: null })
    expect(parsed.notifications[0]).toMatchObject({ requires_interaction: true, can_dismiss: false, destination: { key: 'settings.system' } })
    expect(parsed.notifications[1]).toMatchObject({ verified_revision: 'a'.repeat(40), verified_version: 'web-v1.2.3' })
  })
})
