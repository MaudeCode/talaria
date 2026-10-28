import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionEnvelopeSchema } from '@maudecode/talaria-web-contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer, openStateDb } from '../test/harness.js'

type Json = Record<string, unknown>
const post = (s: TestServer, body: unknown) => s.get('/api/session/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const ref = (id: string, profile = 'default') => ({ session_id: id, tip_session_id: id, profile })

describe('new-chat conversation references', () => {
  let s: TestServer
  beforeEach(async () => { s = await bootTestServer({ sidecar: null }) })
  afterEach(async () => { await s.close() })

  async function seed(id: string, title = id, profile = 'default', privacy: unknown = ['no_training']): Promise<void> {
    const home = profile === 'default' ? s.state : join(s.state, 'profiles', profile)
    mkdirSync(home, { recursive: true })
    const db = openStateDb(join(home, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, parent_session_id TEXT, ended_at REAL, end_reason TEXT); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_metadata TEXT)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, NULL, NULL)').run(id, 'webui', title, 100)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, display_metadata) VALUES (?, ?, ?, ?, ?)').run(id, 'tool', 'SECRET TRANSCRIPT MATERIAL', 101, JSON.stringify({ data_use: privacy }))
    db.close()
    const local = await s.deps.sessionStore.newSession({ profile })
    local.session_id = id
    local.title = title
    local.messages = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]
    await s.deps.sessionStore.save(local)
  }

  it('creates an ordinary empty chat without references', async () => {
    const res = await post(s, { source_references: [] })
    expect(res.status).toBe(200)
    expect(SessionEnvelopeSchema.parse(await res.json()).session.messages).toEqual([])
  })

  it('accepts multiple pointers, uses current titles, carries privacy, and copies no transcript', async () => {
    await seed('first', 'Old title')
    await seed('second', 'Second')
    const local = await s.deps.sessionStore.get('first')
    local.title = 'Renamed'
    await s.deps.sessionStore.save(local)
    const res = await post(s, { source_references: [ref('first'), ref('second')], request_id: 'multiple' })
    expect(res.status).toBe(200)
    const session = SessionEnvelopeSchema.parse(await res.json()).session
    expect(session.source_references).toEqual([{ ...ref('first'), title: 'Renamed' }, { ...ref('second'), title: 'Second' }])
    const saved = await s.deps.sessionStore.get(session.session_id)
    expect(saved.messages).toEqual([])
    expect(saved.context_messages[0]).toMatchObject({ role: 'user', data_use: ['no_training'] })
    expect(JSON.stringify(saved.context_messages)).toContain('session_search')
    expect(JSON.stringify(saved.context_messages)).not.toContain('SECRET TRANSCRIPT MATERIAL')
  })

  it.each([
    { source_references: [ref('missing')], request_id: 'missing', expected: 409 },
    { source_references: [ref('foreign', 'work')], request_id: 'foreign', expected: 409 },
    { source_references: [ref('first')], profile: 'work', request_id: 'switch', expected: 409 },
    { source_references: [ref('first'), ref('first')], request_id: 'repeated', expected: 400 },
    { source_references: Array.from({ length: 6 }, (_, i) => ref(String(i))), request_id: 'bounded', expected: 400 },
  ])('refuses invalid selection before creation: $request_id', async (body) => {
    await seed('first')
    await seed('foreign', 'Foreign', 'work')
    const create = vi.spyOn(s.deps.sessionStore, 'newSession')
    const res = await post(s, body)
    expect(res.status).toBe(body.expected)
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses deleted, changed tip, and malformed privacy sources', async () => {
    await seed('first')
    expect((await post(s, { source_references: [{ ...ref('first'), tip_session_id: 'compressed' }], request_id: 'tip' })).status).toBe(409)
    await s.deps.sessionStore.delete('first')
    expect((await post(s, { source_references: [ref('first')], request_id: 'deleted' })).status).toBe(409)
    await seed('bad-privacy', 'Protected', 'default', 'invalid')
    expect((await post(s, { source_references: [ref('bad-privacy')], request_id: 'privacy' })).status).toBe(409)
  })

  it('concurrent retries converge on one persisted creation and changed choices are refused', async () => {
    await seed('first')
    const body = { source_references: [ref('first')], request_id: 'retry' }
    const responses = await Promise.all([post(s, body), post(s, body)])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const sessions = await Promise.all(responses.map(async (r) => SessionEnvelopeSchema.parse(await r.json()).session))
    expect(sessions[0]!.session_id).toBe(sessions[1]!.session_id)
    expect((await post(s, { ...body, model: 'changed' })).status).toBe(409)
    s.deps.sessionStore.sessions.clear()
    const reloaded = SessionEnvelopeSchema.parse(await (await post(s, body)).json()).session
    expect(reloaded.session_id).toBe(sessions[0]!.session_id)
  })

  it('requires a creation receipt and refuses diagnostic mode before creating', async () => {
    await seed('first')
    expect((await post(s, { source_references: [ref('first')] })).status).toBe(400)
    expect((await post(s, { source_references: [ref('first')], request_id: 'safe', execution_mode: 'safe' })).status).toBe(400)
  })

  it('revalidates sources after workspace resolution and creates nothing on a refusal', async () => {
    await seed('first')
    const resolve = s.deps.sessions.resolveNewSessionWorkspace.bind(s.deps.sessions)
    vi.spyOn(s.deps.sessions, 'resolveNewSessionWorkspace').mockImplementationOnce(async (...args) => {
      await s.deps.sessionStore.delete('first')
      return resolve(...args)
    })
    const create = vi.spyOn(s.deps.sessionStore, 'newSession')
    expect((await post(s, { source_references: [ref('first')], request_id: 'changed-during-setup' })).status).toBe(409)
    expect(create).not.toHaveBeenCalled()
  })

  it('does not allocate a worktree when sources change during workspace resolution', async () => {
    await seed('first')
    vi.spyOn(s.deps.sessions, 'resolveNewSessionWorkspace').mockImplementationOnce(async () => {
      await s.deps.sessionStore.delete('first')
      return join(s.state, 'workspace')
    })
    vi.spyOn(s.deps.git, 'holdWrite').mockImplementation(async (_path, action) => action())
    const worktree = vi.spyOn(s.deps.worktrees, 'create').mockResolvedValue({ path: join(s.state, 'worktree'), branch: 'synthetic', repo_root: s.state, created_at: 1 })
    const res = await post(s, { source_references: [ref('first')], request_id: 'changed-before-worktree', worktree: true, workspace: join(s.state, 'workspace') })
    expect(res.status).toBe(409)
    expect(worktree).not.toHaveBeenCalled()
  })

  it('refuses a retained row whose identity was retired', async () => {
    await seed('retired')
    const db = openStateDb(join(s.state, 'state.db'))
    db.exec('CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO state_meta VALUES (?, ?)').run('gateway.retired_session.v1.retired', '{}')
    db.close()
    expect((await post(s, { source_references: [ref('retired')], request_id: 'retired' })).status).toBe(409)
  })

  it('refuses a compressed old tip, accepts its current logical identity, and retains earlier privacy', async () => {
    await seed('root')
    await seed('tip', 'Continued', 'default', ['zero_retention'])
    const db = openStateDb(join(s.state, 'state.db'))
    db.prepare('UPDATE sessions SET ended_at = 110, end_reason = ? WHERE id = ?').run('compression', 'root')
    db.prepare('UPDATE sessions SET parent_session_id = ?, started_at = 111 WHERE id = ?').run('root', 'tip')
    db.close()
    expect((await post(s, { source_references: [ref('root')], request_id: 'old-tip' })).status).toBe(409)
    const res = await post(s, { source_references: [{ ...ref('root'), tip_session_id: 'tip' }], request_id: 'new-tip' })
    expect(res.status).toBe(200)
    const session = SessionEnvelopeSchema.parse(await res.json()).session
    expect(session.source_references).toEqual([{ ...ref('root'), tip_session_id: 'tip', title: 'Continued' }])
    const saved = await s.deps.sessionStore.get(session.session_id)
    expect(saved.context_messages[0]?.data_use).toEqual(['no_training', 'zero_retention'])
  })

  it('searches authorized display titles without leaking transcript snippets or other profiles', async () => {
    await seed('first', 'Parser decisions')
    await seed('second', 'Other topic')
    await seed('foreign', 'Parser private', 'work')
    const res = await s.get('/api/sessions/references?q=parser')
    expect(res.status).toBe(200)
    const result = await res.json() as { sessions: Json[]; max_sources: number }
    expect(result.sessions.map((row: Json) => row.session_id)).toEqual(['first'])
    expect(result.sessions[0]!.source_reference).toEqual(ref('first'))
    expect(JSON.stringify(result)).not.toContain('SECRET TRANSCRIPT MATERIAL')
    expect(JSON.stringify(result)).not.toContain('foreign')
    expect(result.max_sources).toBe(5)
  })

  it('lists candidates before a search query is entered', async () => {
    await seed('first', 'Earlier conversation')
    const res = await s.get('/api/sessions/references')
    expect(res.status).toBe(200)
    const result = await res.json() as { sessions: Json[] }
    expect(result.sessions.map((row) => row.session_id)).toEqual(['first'])
  })
})
