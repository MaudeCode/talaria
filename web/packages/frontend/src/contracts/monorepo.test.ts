import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionSchema } from './session'
import { groupAssistantTurns, persistedActivity } from '../features/chat/turnActivity'
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
    expect(turns.map((row) => row.turnKey)).toEqual(['legacy:start', 'legacy:1', 'contract-run-a', 'contract-run-b', 'contract-run-c', 'contract-run-d', 'contract-run-e', 'contract-run-g', 'contract-run-f'])
    expect(turns[2]?.assistantRows?.map((row) => row.message.message_id)).toEqual(['contract-run-a-1', 'contract-run-a-2'])
  })

  it('renders each completed turn from its server scene', () => {
    const fixture: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8'))
    const session = SessionSchema.parse((fixture as { session: unknown }).session)
    const turns = groupAssistantTurns(projectMessages(session.messages ?? [])).filter((row) => row.message.role === 'assistant')
    const view = (key: string) => { const activity = persistedActivity(turns.find((row) => row.turnKey === key)!); return { kinds: activity.items.map((item) => item.kind), texts: activity.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])), final: activity.finalAnswer, status: activity.status } }
    // Codex commentary is prose under Worked, before its tool; the answer is outside.
    expect(view('contract-run-c')).toEqual({ kinds: ['reasoning', 'text', 'tool'], texts: ['Reading both config files.'], final: 'The service uses port 8080.', status: 'completed' })
    expect(view('contract-run-a')).toMatchObject({ texts: ['First reply.'], final: 'Second reply in the same turn.' })
    expect(view('contract-run-d')).toMatchObject({ final: 'Tool budget exhausted; here is the saved explanation.', status: 'tool_limit_reached' })
    expect(view('contract-run-e')).toMatchObject({ kinds: ['text', 'tool'], final: '', status: 'no_response' })
    expect(view('legacy:start')).toMatchObject({ kinds: ['text', 'tool'], final: 'Contract answer.' })
    // Persisted steers sit where the Agent took them: after the tool that had completed.
    expect(view('contract-run-g')).toMatchObject({ kinds: ['text', 'tool', 'steering', 'text', 'tool', 'steering'], final: 'Both files read.' })
  })

  it('carries the server streaming and read-only flags on every session example (TAL-312)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Record<string, unknown>
    expect(SessionSchema.parse(fixture.session)).toMatchObject({ is_streaming: true, active_stream_id: 'contract-run-f', read_only: false })
    expect(SessionSchema.parse(fixture.stale_stream_session)).toMatchObject({ is_streaming: false, active_stream_id: null, read_only: false })
    expect(SessionSchema.parse(fixture.subagent_session)).toMatchObject({ is_streaming: false, read_only: true, can_branch: false })
  })

  it('keeps an assistant row whose only content is its server scene', () => {
    const scene = { version: 'activity_scene_v1' as const, activity_rows: [], final_answer: '', terminal_state: 'no_response', expanded_by_default: false }
    const rows = projectMessages([{ role: 'user', content: 'Go' }, { role: 'assistant', content: '', _anchor_activity_scene: scene }])
    expect(rows.map((row) => row.message.role)).toEqual(['user', 'assistant'])
  })
})
