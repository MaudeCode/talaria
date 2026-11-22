import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useJsonStorage } from '../test/storage.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionFind } from '@maudecode/talaria-web-contracts'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { Session } from './session.js'

useJsonStorage()

type Row = Record<string, unknown>
/** The find response the App decodes (TAL-1471), produced here from the fixture's transcript. */
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/session-find.json'), 'utf8')) as { query: string; session: { session_id: string; messages: Row[] }; response: SessionFind }

describe('GET /api/session/find (TAL-2666)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(async () => { await s.close() })

  const seeded = async (sid: string, messages: Row[]) => {
    await s.deps.sessionStore.save(new Session({ session_id: sid, messages: messages.map((m) => ({ ...m })) }, { workspace: s.state, model: null }))
    return sid
  }
  const find = async (sid: string, q?: string): Promise<SessionFind> => {
    const response = await s.get(`/api/session/find?session_id=${sid}${q === undefined ? '' : `&q=${encodeURIComponent(q)}`}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionFind
  }

  it('matches the question and the answer in transcript order, case- and accent-blind, and not the folded Worked text', async () => {
    const sid = await seeded(fixture.session.session_id, fixture.session.messages)
    // The query also sits in the turn's folded work: its prose and its tool call.
    const detail = await s.deps.sessions.detail(sid, { messages: '1' })
    const scene = (detail.messages as Row[]).find((m) => m.message_id === 'a2')?._anchor_activity_scene as Row
    expect(scene.expanded_by_default).toBe(false)
    expect((scene.activity_rows as Row[]).some((row) => String(row.text).includes('cafe list'))).toBe(true)
    expect(await find(sid, fixture.query)).toEqual(fixture.response)
  })

  it('counts ranges in UTF-16 code units and keeps a combining accent inside its match', async () => {
    const sid = await seeded('find-utf16', [{ role: 'user', content: '👋 Café au lait', message_id: 'u1', timestamp: 1 }])
    expect((await find(sid, 'CAFÉ')).matches).toEqual([{ message_id: 'u1', range: { start: 3, end: 8 } }])
  })

  it('matches the redacted text the transcript shows, never the credential behind it', async () => {
    const secret = 'ghp_abcdefghij0123456789'
    const sid = await seeded('find-redacted', [{ role: 'user', content: `key ${secret}`, message_id: 'u1', timestamp: 1 }])
    expect((await find(sid, secret)).matches).toEqual([])
    expect((await find(sid, 'ghp_ab...6789')).matches).toEqual([{ message_id: 'u1', range: { start: 4, end: 17 } }])
  })

  it('answers no matches for an empty or missing query', async () => {
    const sid = await seeded('find-empty', [{ role: 'user', content: '  spaced  ', message_id: 'u1', timestamp: 1 }])
    expect(await find(sid, '  ')).toEqual({ session_id: sid, matches: [] })
    expect(await find(sid)).toEqual({ session_id: sid, matches: [] })
  })

  it('answers 404 for an unknown session', async () => {
    expect((await s.get('/api/session/find?session_id=find-missing&q=x')).status).toBe(404)
  })
})
