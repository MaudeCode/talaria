import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { Session } from './session.js'

type Row = Record<string, unknown>
/** The chat a client opens, viewed through `viewed_through` rows; the rest arrive after that view (TAL-2676). */
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/unread-from-message.json'), 'utf8')) as { viewed_through: number; session: { messages: Row[]; unread_from_message_id: string } }
const seen = fixture.session.messages.slice(0, fixture.viewed_through)
const added = fixture.session.messages.slice(fixture.viewed_through)

const viewed = (s: TestServer, sid: string): Promise<Response> => s.get('/api/talaria/viewed', { method: 'POST', body: JSON.stringify({ session_id: sid }), headers: { 'content-type': 'application/json' } })
const unread = async (s: TestServer, sid: string): Promise<unknown> => {
  const res = await s.get(`/api/session?session_id=${sid}&msg_limit=50`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { session: Row }).session.unread_from_message_id
}

describe('the last-viewed position (TAL-2676)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(async () => { await s.close() })

  const seeded = async (sid: string): Promise<string> => {
    await s.deps.sessionStore.save(new Session({ session_id: sid, messages: seen.map((m) => ({ ...m })) }, { workspace: s.state, model: null }))
    return sid
  }
  const append = async (server: TestServer, sid: string): Promise<void> => {
    const session = await server.deps.sessionStore.get(sid)
    session.messages.push(...added.map((m) => ({ ...m })))
    await server.deps.sessionStore.save(session)
  }

  it('names the first row added since the last view, and none before any view or once viewed again', async () => {
    const sid = await seeded('viewed_basic')
    expect(await unread(s, sid)).toBeNull()
    expect((await viewed(s, sid)).status).toBe(200)
    await append(s, sid)
    expect(await unread(s, sid)).toBe(fixture.session.unread_from_message_id)
    expect((await viewed(s, sid)).status).toBe(200)
    expect(await unread(s, sid)).toBeNull()
  })

  it('keeps the position in the session store across a restart', async () => {
    const sid = await seeded('viewed_restart')
    expect((await viewed(s, sid)).status).toBe(200)
    const restarted = await bootTestServer({ env: { HERMES_HOME: s.state, TALARIA_WEB_STATE_DIR: s.state, TALARIA_WEB_DEFAULT_WORKSPACE: s.workspace } })
    try {
      await append(restarted, sid)
      expect(await unread(restarted, sid)).toBe(fixture.session.unread_from_message_id)
    } finally { await restarted.close() }
  })

  it('keeps each profile\'s position apart', async () => {
    const sid = await seeded('viewed_profiles')
    await s.deps.sessions.markViewed(sid, 'work')
    await append(s, sid)
    expect(await s.deps.sessions.unreadFromMessageId(sid, 'work')).toBe(fixture.session.unread_from_message_id)
    expect(await s.deps.sessions.unreadFromMessageId(sid, 'default')).toBeNull()
    await s.deps.sessions.markViewed(sid, 'default')
    expect(await s.deps.sessions.unreadFromMessageId(sid, 'work')).toBe(fixture.session.unread_from_message_id)
  })
})
