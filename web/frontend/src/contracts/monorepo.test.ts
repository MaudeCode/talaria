import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSchema } from './session'

describe('shared monorepo contracts', () => {
  it('accepts the same session and activity scene as the native client', () => {
    const fixture: unknown = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '../../../../contracts/fixtures/web-session.json'), 'utf8',
    ))
    const session = SessionSchema.parse((fixture as { session: unknown }).session)
    expect(session.session_id).toBe('contract-session')
    expect(session.messages?.[0]?._anchor_activity_scene).toMatchObject({ version: 'activity_scene_v1' })
  })
})
