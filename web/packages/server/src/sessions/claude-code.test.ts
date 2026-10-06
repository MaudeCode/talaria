import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const line = (v: unknown): string => JSON.stringify(v)

describe('Claude Code sessions (TAL-551)', () => {
  let s: TestServer
  const listed = async (query = ''): Promise<Json[]> => ((await json(await s.get(`/api/sessions${query}`))).sessions as Json[]).filter((r) => r.source_tag === 'claude_code')

  beforeAll(async () => {
    s = await bootTestServer()
    const project = join(s.state, 'claude-projects', '-Users-me-repo')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'one.jsonl'), [
      line({ type: 'summary', summary: 'Fix   the login bug' }),
      line({ type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Why does login fail?' } }),
      'not json',
      line({ type: 'assistant', timestamp: '2026-10-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The token expired.' }] } }),
    ].join('\n'))
    writeFileSync(join(project, 'two.jsonl'), line({ type: 'user', timestamp: '2026-10-02T09:00:00Z', message: { role: 'user', content: 'Second   transcript question' } }) + '\n')
    writeFileSync(join(project, 'empty.jsonl'), line({ type: 'progress' }) + '\n')
    writeFileSync(join(project, 'notes.txt'), line({ type: 'user', message: { role: 'user', content: 'ignored' } }))
    symlinkSync(join(project, 'two.jsonl'), join(project, 'link.jsonl'))
  })
  afterAll(async () => { await s.close() })

  it('lists the projects dir as read-only imported sessions only while the toggle is on', async () => {
    await s.deps.settings.save({ show_cli_sessions: true, show_claude_code_sessions: true })
    const rows = await listed()
    expect(rows.map((r) => r.title)).toEqual(['Second transcript question', 'Fix the login bug'])
    expect(rows[1]).toMatchObject({
      session_id: expect.stringMatching(/^claude_code_[0-9a-f]{24}$/) as unknown, source_kind: 'claude_code', source_label: 'Claude Code', model: 'claude-code',
      message_count: 2, created_at: Date.parse('2026-10-01T10:00:00Z') / 1000, last_message_at: Date.parse('2026-10-01T10:01:00Z') / 1000,
      is_cli_session: true, read_only: true, can_delete: false,
    })
    await s.deps.settings.save({ show_claude_code_sessions: false })
    expect(await listed()).toEqual([])
    expect(await listed('?show_claude_code_sessions=1')).toHaveLength(2)
    // The Claude Code toggle sits under the CLI one.
    await s.deps.settings.save({ show_cli_sessions: false, show_claude_code_sessions: true })
    expect(await listed()).toEqual([])
  })

  it('opens a listed transcript read-only and refuses changes', async () => {
    await s.deps.settings.save({ show_cli_sessions: true, show_claude_code_sessions: true })
    const sid = String((await listed()).find((r) => r.title === 'Fix the login bug')?.session_id)
    const res = await s.get(`/api/session?session_id=${sid}`)
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    expect(session).toMatchObject({ session_id: sid, read_only: true, source_kind: 'claude_code' })
    expect((session.messages as Json[]).map((m) => [m.role, m.content])).toEqual([['user', 'Why does login fail?'], ['assistant', 'The token expired.']])
    expect((await post(s, '/api/session/rename', { session_id: sid, title: 'x' })).status).toBe(403)
  })
})
