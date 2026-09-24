import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSchema } from './session'
import { groupAssistantTurns } from '../features/chat/turnActivity'
import { projectMessages } from '../features/chat/useTranscript'

describe('shared monorepo contracts', () => {
  it('accepts the same session and activity scene as the native client', () => {
    const fixture: unknown = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8',
    ))
    const session = SessionSchema.parse((fixture as { session: unknown }).session)
    expect(session.session_id).toBe('contract-session')
    expect(session.messages?.[0]?._anchor_activity_scene).toMatchObject({ version: 'activity_scene_v1' })
    // Turns come from the server stamp: two completed replies in one turn stay together; a new id starts a turn.
    const turns = groupAssistantTurns(projectMessages(session.messages ?? [])).filter((row) => row.message.role === 'assistant')
    expect(turns.map((row) => row.turnKey)).toEqual(['legacy:start', 'legacy:1', 'contract-run-a', 'contract-run-b'])
    expect(turns[2]?.assistantRows?.map((row) => row.message.message_id)).toEqual(['contract-run-a-1', 'contract-run-a-2'])
  })
})
