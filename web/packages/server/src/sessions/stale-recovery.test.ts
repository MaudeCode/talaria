/** TAL-536: stale-stream cleanup recovers a dead run's journaled output instead of dropping it. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { pendingUserRow } from './merge.js'

type Json = Record<string, unknown>
const MARKER = '**Interrupted:** The reply was interrupted before it could be saved.'

describe('stale-stream cleanup with a run journal', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer({ sidecar: new FakeSidecar() }) })
  afterAll(() => s.close())

  /** A session whose run died with the server, its journal holding `frames`. */
  const deadRun = async (streamId: string, frames: [string, Json][], seed?: (session: Json) => void): Promise<string> => {
    const res = await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    const sid = String(((await res.json()) as { session: Json }).session.session_id)
    const session = s.deps.sessionStore.get(sid)
    Object.assign(session, { active_stream_id: streamId, pending_user_message: 'summarize the repo', pending_attachments: [], pending_started_at: Date.now() / 1000 - 120 })
    seed?.(session as unknown as Json)
    s.deps.sessionStore.save(session)
    const writer = s.deps.journal.writer(sid, streamId)
    for (const [event, payload] of frames) writer.appendSseEvent(event, payload)
    writer.close()
    return sid
  }
  const recovered = (sid: string) => {
    expect(s.deps.sessions.clearStaleStreamState(s.deps.sessionStore.get(sid))).toBe(true)
    return s.deps.sessionStore.get(sid)
  }
  const work: [string, Json][] = [
    ['reasoning', { text: 'Look at the files first.' }],
    ['token', { text: 'Checking ' }],
    ['token', { text: 'the tree.' }],
    ['tool', { name: 'terminal', args: { command: 'ls' }, id: 'call-1' }],
    ['tool_complete', { name: 'terminal', id: 'call-1', preview: 'README.md', is_error: false, duration: 0.2 }],
  ]

  it('a journal ending in done yields the full reply and no interruption marker', async () => {
    const sid = await deadRun('deadrun536done', [...work, ['token', { text: 'It is a monorepo.' }], ['done', { terminal_state: 'completed' }]])
    const { messages } = recovered(sid)
    expect(messages.map((m) => [m.role, m.content])).toEqual([['user', 'summarize the repo'], ['assistant', 'Checking the tree.'], ['assistant', 'It is a monorepo.']])
    expect(messages[1]).toMatchObject({ reasoning: 'Look at the files first.', _partial_tool_calls: [{ name: 'terminal', tid: 'call-1', done: true, snippet: 'README.md', is_error: false }] })
    expect(messages[2]).not.toHaveProperty('_partial')
    expect(messages.every((m) => m._turn_id === 'deadrun536done')).toBe(true)
    // The detail shows the recovered turn as answered.
    const detail = (await (await s.get(`/api/session?session_id=${sid}`)).json()) as { session: { messages: Json[] } }
    expect(detail.session.messages.some((m) => m.content === MARKER)).toBe(false)
    expect(detail.session.messages.at(-1)?._anchor_activity_scene).toMatchObject({ final_answer: 'It is a monorepo.' })
  })

  it('a journal ending mid-stream yields the partial output plus one marker', async () => {
    const sid = await deadRun('deadrun536mid', [...work, ['token', { text: 'It is a mono' }]])
    const { messages } = recovered(sid)
    expect(messages.map((m) => [m.role, m.content])).toEqual([['user', 'summarize the repo'], ['assistant', 'Checking the tree.'], ['assistant', 'It is a mono'], ['assistant', MARKER]])
    expect(messages[2]).toMatchObject({ _partial: true })
    expect(messages.filter((m) => m.content === MARKER)).toHaveLength(1)
  })

  it('an eager checkpoint keeps the prompt once and the model context gains it', async () => {
    const streamId = 'deadrun536eager'
    const history = [{ role: 'user', content: 'hi', timestamp: 1 }, { role: 'assistant', content: 'hello', timestamp: 2 }]
    const sid = await deadRun(streamId, [['token', { text: 'Part' }]], (session) => {
      const startedAt = Number(session.pending_started_at)
      session.messages = [...history, pendingUserRow('summarize the repo', [], startedAt, 'webui', streamId)]
      session.context_messages = [...history]
    })
    const after = recovered(sid)
    expect(after.messages.filter((m) => m.role === 'user' && m.content === 'summarize the repo')).toHaveLength(1)
    expect(after.messages.map((m) => m.content)).toEqual(['hi', 'hello', 'summarize the repo', 'Part', MARKER])
    expect(after.context_messages.map((m) => [m.role, m.content])).toEqual([['user', 'hi'], ['assistant', 'hello'], ['user', 'summarize the repo']])
  })
})
