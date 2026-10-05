/** TAL-536: stale-stream cleanup recovers a dead run's journaled output instead of dropping it. */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { messageText, pendingUserRow, stripWorkspacePrefix } from './merge.js'
import type { Message } from './session.js'

type Json = Record<string, unknown>
const MARKER = '**Interrupted:** The reply was interrupted before it could be saved.'
/** A model context as role and text, without the workspace prefix the prompt the Agent got carries. */
const said = (rows: Message[]) => rows.map((m) => [m.role, stripWorkspacePrefix(messageText(m.content))])

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
    // As a Stop settles it: the prompt the Agent was sent, then the prose that streamed.
    expect(said(after.context_messages)).toEqual([['user', 'hi'], ['assistant', 'hello'], ['user', 'summarize the repo'], ['assistant', 'Part']])
  })

  it('a done frame supplies an answer that never streamed, like the tool-limit summary', async () => {
    const streamId = 'deadrun536limit'
    const summary = { role: 'assistant', content: 'I ran out of tool calls; the tree has a README.', _turn_id: streamId }
    const sid = await deadRun(streamId, [...work, ['done', { terminal_state: 'tool_limit_reached', session: { messages: [summary] } }]])
    const { messages } = recovered(sid)
    expect(messages.map((m) => m.content)).toEqual(['summarize the repo', 'Checking the tree.', summary.content])
    expect(messages[2]).not.toHaveProperty('_partial')
  })

  it('a done frame without a final answer still gets the marker', async () => {
    const sid = await deadRun('deadrun536noanswer', [...work, ['done', { terminal_state: 'completed', session: { messages: [] } }]])
    expect(recovered(sid).messages.map((m) => m.content)).toEqual(['summarize the repo', 'Checking the tree.', MARKER])
  })

  it('the run\'s own state.db rows are covered by the recovered turn, and earlier CLI rows stay', async () => {
    const streamId = 'deadrun536statedb'
    const history = [{ role: 'user', content: 'hi', timestamp: 1 }, { role: 'assistant', content: 'hello', timestamp: 2 }]
    let startedAt = 0
    const sid = await deadRun(streamId, [...work, ['token', { text: 'It is a mono' }]], (session) => {
      startedAt = Number(session.pending_started_at)
      session.messages = [...history]
      session.context_messages = [...history]
    })
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1)
    const rows: [string, string, number][] = [['user', 'hi', 1], ['assistant', 'hello', 2], ['user', 'from the CLI', startedAt - 60], ['assistant', 'CLI answer', startedAt - 59], ['user', 'summarize the repo', startedAt + 1], ['assistant', 'Checking the tree.', startedAt + 2], ['tool', 'README.md', startedAt + 3]]
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    recovered(sid)
    const detail = (await (await s.get(`/api/session?session_id=${sid}`)).json()) as { session: { messages: Json[] } }
    const turn = ['summarize the repo', 'Checking the tree.', 'It is a mono', MARKER]
    expect(detail.session.messages.map((m) => m.content)).toEqual(['hi', 'hello', 'from the CLI', 'CLI answer', ...turn])
    // The Agent's own rows, then the prose that streamed past them.
    expect(said(s.deps.sessions.modelContext(s.deps.sessionStore.get(sid)))).toEqual([['user', 'hi'], ['assistant', 'hello'], ['user', 'from the CLI'], ['assistant', 'CLI answer'], ['user', 'summarize the repo'], ['assistant', 'Checking the tree.'], ['tool', 'README.md'], ['assistant', 'It is a mono']])
  })

  /** A state.db holding `rows` for `sid`, as the Agent and other clients committed them. */
  const stateDb = (sid: string, rows: [string, string, number][]): void => {
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1)
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
  }

  it('rows another client committed while the run was going stay in the transcript and the model context', async () => {
    const history = [{ role: 'user', content: 'hi', timestamp: 1 }, { role: 'assistant', content: 'hello', timestamp: 2 }]
    let startedAt = 0
    const sid = await deadRun('deadrun536concurrent', [...work, ['token', { text: 'It is a mono' }]], (session) => {
      startedAt = Number(session.pending_started_at)
      session.messages = [...history]
      session.context_messages = [...history]
    })
    stateDb(sid, [['user', 'hi', 1], ['assistant', 'hello', 2], ['user', 'summarize the repo', startedAt + 1], ['assistant', 'Checking the tree.', startedAt + 2], ['user', 'asked in the CLI meanwhile', startedAt + 5], ['assistant', 'CLI answer', startedAt + 6]])
    recovered(sid)
    const detail = (await (await s.get(`/api/session?session_id=${sid}`)).json()) as { session: { messages: Json[] } }
    expect(detail.session.messages.map((m) => m.content)).toEqual(['hi', 'hello', 'summarize the repo', 'Checking the tree.', 'It is a mono', MARKER, 'asked in the CLI meanwhile', 'CLI answer'])
    expect(said(s.deps.sessions.modelContext(s.deps.sessionStore.get(sid))).slice(-2)).toEqual([['user', 'asked in the CLI meanwhile'], ['assistant', 'CLI answer']])
  })

  it('an attachment-only prompt the Agent never committed keeps its files in the model context', async () => {
    const history = [{ role: 'user', content: 'hi', timestamp: 1 }, { role: 'assistant', content: 'hello', timestamp: 2 }]
    const doc = { path: '/tmp/report.pdf', mime: 'application/pdf', name: 'report.pdf' }
    const sid = await deadRun('deadrun536files', [['token', { text: 'Reading it' }]], (session) => {
      Object.assign(session, { pending_user_message: '', pending_attachments: [doc], messages: [...history], context_messages: [...history] })
    })
    const after = recovered(sid)
    expect(said(after.context_messages)).toEqual([['user', 'hi'], ['assistant', 'hello'], ['user', '[Attached files: /tmp/report.pdf]'], ['assistant', 'Reading it']])
  })

  it('a done run whose last segment is reasoning only is no answer', async () => {
    const sid = await deadRun('deadrun536thinking', [...work, ['reasoning', { text: 'That should do.' }], ['done', { terminal_state: 'completed', session: { messages: [] } }]])
    const { messages } = recovered(sid)
    expect(messages.map((m) => m.content)).toEqual(['summarize the repo', 'Checking the tree.', '', MARKER])
    expect(messages[2]).toMatchObject({ reasoning: 'That should do.', _partial: true })
  })
})
