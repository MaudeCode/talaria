import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MessageSchema, SessionSchema } from './session'
import { ChatEventSchema } from './sse'
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
    expect(turns.map((row) => row.turnKey)).toEqual(['legacy:start', 'legacy:1', 'contract-run-a', 'contract-run-b', 'contract-run-c', 'contract-run-d', 'contract-run-e', 'contract-run-g', 'contract-run-x', 'contract-run-y', 'contract-run-z', 'contract-run-f'])
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
    // Stamped and legacy failed turns carry their outcome in the scene; the client never reads the error row itself.
    expect([view('contract-run-x').status, view('contract-run-y').status, view('contract-run-z').status]).toEqual(['cancelled', 'error', 'cancelled'])
    // Persisted steers sit where the Agent took them: after the tool that had completed.
    expect(view('contract-run-g')).toMatchObject({ kinds: ['text', 'tool', 'steering', 'text', 'tool', 'steering'], final: 'Both files read.' })
  })

  it('shows each inline-thinking example\'s prose and reasoning exactly as the server split them (TAL-302)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Record<string, { messages: unknown; expected: Record<string, { prose: string; reasoning: string }> }>
    const example = fixture.inline_thinking_session!
    const turns = groupAssistantTurns(projectMessages(MessageSchema.array().parse(example.messages))).filter((row) => row.message.role === 'assistant')
    const shown = Object.fromEntries(turns.map((row) => {
      const activity = persistedActivity(row)
      return [String(row.message.message_id), { prose: activity.finalAnswer, reasoning: activity.items.flatMap((item) => (item.kind === 'reasoning' ? [item.text] : [])).join('\n\n') }]
    }))
    expect(shown).toEqual(example.expected)
  })

  it('states where a running session\'s transcript ends in its run journal', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { session: unknown; journaled_session: unknown }
    expect(SessionSchema.parse(fixture.session).transcript_seq).toBeNull()
    const journaled = SessionSchema.parse(fixture.journaled_session)
    expect(journaled.transcript_seq).toEqual({ stream_id: journaled.active_stream_id, seq: 0 })
    expect(journaled.messages?.at(-1)?.role).toBe('user')
  })

  it('collapses only the long bodies of the long-body example (TAL-456)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Record<string, unknown>
    const messages = MessageSchema.array().parse((fixture.long_body_session as { messages: unknown }).messages)
    expect(messages.map((message) => message._display_truncated === true)).toEqual([true, true, false, false])
    const reply = groupAssistantTurns(projectMessages(messages)).find((row) => row.message.message_id === 'long-body-reply')!
    expect(persistedActivity(reply).finalAnswerExcerpt).toBe(messages[1]?._display_excerpt)
  })

  it('accepts the server\'s pending steers and their stream events (TAL-424)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Record<string, { events: unknown[] }>
    const session = SessionSchema.parse(fixture.pending_steers_session)
    expect(session.pending_steers?.map((steer) => [steer.steer_id, steer.state, steer.actions.send_now])).toEqual([['steer-contract-1', 'pending', true], ['steer-contract-2', 'sending_now', false]])
    expect(fixture.pending_steers_session!.events.map((event) => ChatEventSchema.parse(event).event)).toEqual(['steer_pending', 'steer_withdrawn', 'steer_withdrawn'])
  })

  it('carries the server streaming and read-only flags on every session example (TAL-312)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Record<string, unknown>
    expect(SessionSchema.parse(fixture.session)).toMatchObject({ is_streaming: true, active_stream_id: 'contract-run-f', read_only: false })
    expect(SessionSchema.parse(fixture.stale_stream_session)).toMatchObject({ is_streaming: false, active_stream_id: null, read_only: false })
    expect(SessionSchema.parse(fixture.subagent_session)).toMatchObject({ is_streaming: false, read_only: true, can_branch: false })
  })

  it('carries the server-computed context ring, and null when the window is unknown (TAL-299)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as { context_usage_sessions: Record<string, unknown> }
    expect(SessionSchema.parse(fixture.context_usage_sessions.populated)).toMatchObject({ context_used_tokens: 64_000, context_window_tokens: 128_000, context_usage_percent: 50, context_threshold_percent: 78 })
    expect(SessionSchema.parse(fixture.context_usage_sessions.unknown_window)).toMatchObject({ context_used_tokens: 64_000, context_window_tokens: null, context_usage_percent: null, context_threshold_percent: null })
  })

  it('shows each tool call\'s server-resolved outcome in every persisted shape (TAL-313)', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Record<string, unknown>
    const session = SessionSchema.parse(fixture.tool_outcomes_session)
    const turns = groupAssistantTurns(projectMessages(session.messages ?? [])).filter((row) => row.message.role === 'assistant')
    const tools = (key: string) => persistedActivity(turns.find((row) => row.turnKey === key)!).items.flatMap((item) => (item.kind === 'tool' ? [[item.call.id, item.call.done, item.call.isError, item.call.duration, item.call.result]] : []))
    // OpenAI calls (one exits non-zero), an Anthropic tool_use call that failed, and a call only the session-level list held.
    expect(tools('tool-run-openai')).toEqual([['call-read', true, false, 1.25, 'A contents'], ['call-exit', true, true, 3.5, '{"exit_code": 2, "output": "1 failed"}']])
    expect(tools('tool-run-anthropic')).toEqual([['toolu-search', true, true, null, '{"error": "permission denied"}']])
    expect(tools('tool-run-session')).toEqual([['call-date', true, false, 0.42, 'Sat Sep 27']])
    // The running turn's unanswered call is not done; the live stream renders that turn.
    const running = session.messages?.find((m) => m._turn_id === 'tool-run-live' && m.role === 'assistant')
    expect(running?.tool_calls?.map((call) => [call.id, call.done, call.is_error])).toEqual([['call-build', false, false]])
  })

  it('keeps an assistant row whose only content is its server scene', () => {
    const scene = { version: 'activity_scene_v1' as const, activity_rows: [], final_answer: '', terminal_state: 'no_response', expanded_by_default: false }
    const rows = projectMessages([{ role: 'user', content: 'Go' }, { role: 'assistant', content: '', _anchor_activity_scene: scene }])
    expect(rows.map((row) => row.message.role)).toEqual(['user', 'assistant'])
  })
})
