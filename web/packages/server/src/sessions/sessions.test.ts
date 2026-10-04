import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readMetadataJsonPrefixWithSignature, statSignature } from './store.js'
import type { Session } from './session.js'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SidecarResult } from '@maudecode/talaria-web-contracts'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { str } from '../util.js'
import { withPendingUserTurn, withoutRunningTurnOutput } from './merge.js'
import { RunJournalWriter } from './journal.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const completedTurn = (messages: Json[]): SidecarResult<'chat.start'> => ({
  status: 'completed', messages, final_response: str(messages[messages.length - 1]?.content), error: null, result_status: 'completed', tool_limit_reached: false,
  usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null }, context: {}, model: 'test-model', provider: 'test', compressed: false,
  agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
})

async function newSession(s: TestServer, body: Json = {}): Promise<Json> {
  const res = await post(s, '/api/session/new', body)
  expect(res.status).toBe(200)
  return (await json(res)).session as Json
}

/** New sessions stay in memory until their first message (Python `new_session`), so persist through the store. */
function writeMessages(s: TestServer, sid: string, messages: Json[]): void {
  const session = s.deps.sessionStore.get(sid)
  session.messages = messages
  s.deps.sessionStore.save(session)
}

describe('malformed session rows (TAL-37)', () => {
  it('normalizes only unambiguous schema scalars and rejects unusable identities', async () => {
    const { sanitizeSessionRow } = await import('./list.js')
    const s = await bootTestServer()
    try {
      const raw = { session_id: 'row-types', message_count: '2', archived: 'false', pinned: ' true ', workspace: {}, updated_at: 'bad', model: '123', profile: 42, read_only: 'unknown', pre_compression_snapshot: 'false' }
      const bytes = JSON.stringify(raw)
      expect(sanitizeSessionRow(raw, s.deps.sessionStore)).toEqual({ session_id: 'row-types', title: '', message_count: 2, archived: false, pinned: true, model: '123', profile: '42', read_only: true, pre_compression_snapshot: false })
      for (const value of [false, 'false', 0, '0']) expect(sanitizeSessionRow({ session_id: 'row-types', read_only: value }, s.deps.sessionStore)?.read_only).toBe(false)
      for (const value of [true, 'true', 1, '1', null, {}]) expect(sanitizeSessionRow({ session_id: 'row-types', read_only: value }, s.deps.sessionStore)?.read_only).toBe(true)
      expect(JSON.stringify(raw)).toBe(bytes)
      for (const row of [null, [], {}, { session_id: 42 }, { session_id: '   ' }, { session_id: '../bad' }, { session_id: 'different-file' }]) expect(sanitizeSessionRow(row, s.deps.sessionStore, 'invalid.json')).toBeNull()
      expect(s.logs.filter((line) => line.includes('invalid.json'))).toHaveLength(1)
    } finally {
      await s.close()
    }
  })

  it('lists and searches usable rows with corrected types, consistent counts and no file writes', async () => {
    const s = await bootTestServer()
    try {
      const dir = s.deps.sessionStore.sessionDir
      mkdirSync(dir, { recursive: true })
      const valid = { session_id: 'good-row', title: 'needle good', message_count: 2, last_message_at: 100, updated_at: 100, profile: 'default', archived: false }
      const drifted = { ...valid, session_id: 'drifted-row', title: undefined, message_count: '12', created_at: '90', pinned: 'false', archived: false }
      const missing = { ...valid, session_id: undefined, title: 'needle missing' }
      const files = new Map<string, string>()
      for (const [name, row] of [['good-row', valid], ['drifted-row', drifted], ['missing-row', missing]] as const) {
        const path = join(dir, `${name}.json`)
        const bytes = JSON.stringify({ ...row, messages: [{ role: 'user', content: 'needle' }] })
        writeFileSync(path, bytes)
        files.set(path, bytes)
      }
      writeFileSync(s.deps.sessionStore.indexFile, JSON.stringify([valid, drifted, missing]))
      for (const path of ['/api/sessions', '/api/sessions/search?q=', '/api/sessions/search?q=needle']) {
        const res = await s.get(path)
        expect(res.status, await res.clone().text()).toBe(200)
        const body = await json(res)
        const rows = body.sessions as Json[]
        expect(rows.map((r) => r.session_id).sort()).toEqual(['drifted-row', 'good-row'])
        expect(rows.find((r) => r.session_id === 'drifted-row')).toMatchObject({ title: '', message_count: 12, created_at: 90, pinned: false, archived: false })
        if (path === '/api/sessions') expect(body).toMatchObject({ webui_session_count: 2, cli_session_count: 0, archived_count: 0, other_profile_count: 0 })
        if (path.endsWith('q=needle')) expect(body.count).toBe(2)
      }
      for (const [path, bytes] of files) expect(readFileSync(path, 'utf8')).toBe(bytes)
      expect(s.logs.filter((line) => line.includes('missing-row.json'))).toHaveLength(1)
    } finally {
      await s.close()
    }
  })
})

describe('server-computed context ring (TAL-299)', () => {
  it('uses the post-compression estimate, else the last prompt, never the cumulative input, over a known window only', async () => {
    const { contextUsage } = await import('./session.js')
    const ring = (used: number | null, window: number | null, percent: number | null, threshold: number | null = null) => ({ context_used_tokens: used, context_window_tokens: window, context_usage_percent: percent, context_threshold_percent: threshold })
    expect(contextUsage({ last_prompt_tokens: 64_000, context_length: 128_000 })).toEqual(ring(64_000, 128_000, 50))
    expect(contextUsage({ post_compression_context_tokens_estimate: 10_347, last_prompt_tokens: 120_000, context_length: 128_000 })).toEqual(ring(10_347, 128_000, 8))
    expect(contextUsage({ input_tokens: 900_000, last_prompt_tokens: 0, context_length: 200_000 } as Json)).toEqual(ring(null, 200_000, null))
    expect(contextUsage({ last_prompt_tokens: 5_000, context_length: null })).toEqual(ring(5_000, null, null))
    expect(contextUsage({ last_prompt_tokens: 5_000, context_length: 0 }, () => 20_000)).toEqual(ring(5_000, 20_000, 25))
    expect(contextUsage({ last_prompt_tokens: 300_000, context_length: 200_000, threshold_tokens: 160_000 })).toEqual(ring(300_000, 200_000, 100, 80))
    expect(contextUsage({ last_prompt_tokens: 'junk', context_length: '128000', threshold_tokens: -1 })).toEqual(ring(null, 128_000, null))
  })

  it('fills the ring on index rows written before the fields existed, in the list and in search', async () => {
    const s = await bootTestServer()
    try {
      const dir = s.deps.sessionStore.sessionDir
      mkdirSync(dir, { recursive: true })
      const base = { title: 'ring row', message_count: 2, last_message_at: 100, updated_at: 100, profile: 'default', archived: false }
      const rows = [
        { ...base, session_id: 'ring-cumulative', input_tokens: 900_000, context_length: 200_000 },
        { ...base, session_id: 'ring-compressed', post_compression_context_tokens_estimate: 30_000, last_prompt_tokens: 150_000, context_length: 200_000, threshold_tokens: 160_000 },
      ]
      for (const row of rows) writeFileSync(join(dir, `${row.session_id}.json`), JSON.stringify({ ...row, messages: [{ role: 'user', content: 'ring' }] }))
      writeFileSync(s.deps.sessionStore.indexFile, JSON.stringify(rows))
      for (const path of ['/api/sessions', '/api/sessions/search?q=ring']) {
        const listed = (await json(await s.get(path))).sessions as Json[]
        expect(listed.find((r) => r.session_id === 'ring-cumulative'), path).toMatchObject({ context_used_tokens: null, context_window_tokens: 200_000, context_usage_percent: null })
        expect(listed.find((r) => r.session_id === 'ring-compressed'), path).toMatchObject({ context_used_tokens: 30_000, context_window_tokens: 200_000, context_usage_percent: 15, context_threshold_percent: 80 })
      }
    } finally {
      await s.close()
    }
  })

  it('takes the window from the model catalog when the session has none, with no guessed default', async () => {
    const s = await bootTestServer()
    try {
      const sid = String((await newSession(s)).session_id)
      const session = s.deps.sessionStore.get(sid)
      session.messages = [{ role: 'user', content: 'hi' }]
      session.last_prompt_tokens = 64_000
      session.context_length = null
      s.deps.sessionStore.save(session)
      const lookup = vi.spyOn(s.deps.sessions.deps, 'contextLengthFor').mockReturnValue(null)
      const detail = async () => (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      expect(await detail()).toMatchObject({ context_used_tokens: 64_000, context_window_tokens: null, context_usage_percent: null })
      lookup.mockReturnValue(256_000)
      expect(await detail()).toMatchObject({ context_used_tokens: 64_000, context_window_tokens: 256_000, context_usage_percent: 25 })
      lookup.mockRestore()
    } finally {
      await s.close()
    }
  })
})

describe('session lifecycle over HTTP', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('creates a session with the default workspace and lists it with the ETag contract', async () => {
    const session = await newSession(s)
    expect(String(session.session_id)).toMatch(/^[0-9a-f]{12}$/)
    expect(session.workspace).toBe(realpathSync(join(s.state, 'workspace')))
    // Python keeps a brand-new session in memory until its first message.
    expect(existsSync(join(s.state, 'sessions', `${String(session.session_id)}.json`))).toBe(false)
    writeMessages(s, String(session.session_id), [{ role: 'user', content: 'hi' }])

    const res = await s.get('/api/sessions')
    expect(res.status).toBe(200)
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    const body = await json(res)
    expect((body.sessions as Json[]).map((r) => r.session_id)).toContain(session.session_id)
    expect(body.active_profile).toBe('default')
    expect(typeof body.server_time).toBe('number')

    const notModified = await s.get('/api/sessions', { headers: { 'if-none-match': etag ?? '' } })
    expect(notModified.status).toBe(304)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(String(session.session_id))
  })

  it('validates session ids and reports unknown sessions as 404', async () => {
    expect((await s.get('/api/session?session_id=../etc')).status).toBe(404)
    expect((await s.get('/api/session?session_id=deadbeef0000')).status).toBe(404)
    const res = await post(s, '/api/session/rename', { session_id: 'deadbeef0000', title: 'x' })
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'Session not found' })
  })

  it('renames, archives, pins with the configured cap, and moves between projects', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'hi' }])
    let res = await post(s, '/api/session/rename', { session_id: sid, title: '  New title  ' })
    expect(res.status).toBe(200)
    expect(((await json(res)).session as Json).title).toBe('New title')

    res = await post(s, '/api/session/archive', { session_id: sid, archived: true })
    expect(res.status).toBe(200)
    let list = await json(await s.get('/api/sessions'))
    expect((list.sessions as Json[]).some((r) => r.session_id === sid)).toBe(false)
    expect(list.archived_count).toBeGreaterThanOrEqual(1)
    list = await json(await s.get('/api/sessions?include_archived=1'))
    expect((list.sessions as Json[]).some((r) => r.session_id === sid && r.archived === true)).toBe(true)
    await post(s, '/api/session/archive', { session_id: sid, archived: false })

    s.deps.settings.save({ pinned_sessions_limit: 1 })
    expect((await post(s, '/api/session/pin', { session_id: sid, pinned: true })).status).toBe(200)
    const b = await newSession(s)
    res = await post(s, '/api/session/pin', { session_id: b.session_id, pinned: true })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Up to 1 sessions can be pinned. Unpin one before pinning another.')
    expect((await post(s, '/api/session/pin', { session_id: sid, pinned: false })).status).toBe(200)
    // Two concurrent pins racing for the last slot: the quota check and save run as one serialized transaction, so
    // exactly one wins even when the first is parked on its session lock past the other's check.
    let releaseA: () => void = () => undefined
    const holdA = s.deps.sessionStore.withLock(sid, () => new Promise<void>((resolve) => { releaseA = resolve }))
    await new Promise((r) => setTimeout(r, 20))
    const pinA = post(s, '/api/session/pin', { session_id: sid, pinned: true })
    await new Promise((r) => setTimeout(r, 50))
    const pinB = post(s, '/api/session/pin', { session_id: b.session_id, pinned: true })
    await new Promise((r) => setTimeout(r, 50))
    releaseA()
    await holdA
    const [resA, resB] = await Promise.all([pinA, pinB])
    expect([resA.status, resB.status].sort()).toEqual([200, 400])
    const pinnedNow = ((await json(await s.get('/api/sessions'))).sessions as Json[]).filter((r) => r.pinned === true)
    expect(pinnedNow).toHaveLength(1)
    await post(s, '/api/session/pin', { session_id: sid, pinned: false })
    await post(s, '/api/session/pin', { session_id: b.session_id, pinned: false })

    res = await post(s, '/api/projects/create', { name: 'Proj', color: '#abc' })
    expect(res.status).toBe(200)
    const project = (await json(res)).project as Json
    res = await post(s, '/api/session/move', { session_id: sid, project_id: project.project_id })
    expect(res.status).toBe(200)
    expect(((await json(res)).session as Json).project_id).toBe(project.project_id)
    res = await post(s, '/api/session/move', { session_id: sid, project_id: 'missing' })
    expect(res.status).toBe(404)
    expect((await post(s, '/api/projects/delete', { project_id: project.project_id })).status).toBe(200)
    const detail = await json(await s.get(`/api/session?session_id=${sid}`))
    expect((detail.session as Json).project_id).toBeNull()
  })

  it('returns a bounded message window with the truncation markers', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    const messages: Json[] = []
    for (let i = 0; i < 12; i += 1) messages.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, timestamp: 1000 + i })
    writeMessages(s, sid, messages)
    const res = await s.get(`/api/session?session_id=${sid}&msg_limit=4`)
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    const got = session.messages as Json[]
    expect(got.map((m) => m.content)).toEqual(['m8', 'm9', 'm10', 'm11'])
    expect(session._messages_truncated).toBe(true)
    expect(session._messages_offset).toBe(8)
    expect(session._msg_limit_max).toBe(500)
    const before = (await json(await s.get(`/api/session?session_id=${sid}&msg_limit=4&msg_before=8`))).session as Json
    expect((before.messages as Json[]).map((m) => m.content)).toEqual(['m4', 'm5', 'm6', 'm7'])
  })

  it('truncates, undoes, retries, clears, and keeps a .bak when the file shrinks', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' }, { role: 'assistant', content: 'two' },
    ])
    let res = await post(s, '/api/session/undo', { session_id: sid })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, removed_count: 2, removed_preview: 'second' })
    expect(existsSync(join(s.state, 'sessions', `${sid}.json.bak`))).toBe(true)

    res = await post(s, '/api/session/retry', { session_id: sid })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, last_user_text: 'first', removed_count: 2 })
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toEqual([])

    writeMessages(s, sid, [
      { role: 'user', content: 'a' }, { role: 'assistant', content: '', reasoning: 'think', tool_calls: [{ id: 't', name: 'read_file' }] },
      { role: 'tool', tool_call_id: 't', content: 'x' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ])
    res = await post(s, '/api/session/truncate', { session_id: sid, keep_count: 4 })
    expect(res.status).toBe(200)
    // The kept turns come back with the server's scenes, like the detail, so a client replacing its transcript keeps them.
    const kept = ((await json(res)).session as Json).messages as Json[]
    expect((kept.at(-1)?._anchor_activity_scene as Json | undefined)?.final_answer).toBe('b')
    res = await post(s, '/api/session/truncate', { session_id: sid, keep_count: 1 })
    expect(res.status).toBe(200)
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toHaveLength(1)
    res = await post(s, '/api/session/truncate', { session_id: sid, keep_count: -1 })
    expect(res.status).toBe(400)
    res = await post(s, '/api/session/clear', { session_id: sid })
    expect(res.status).toBe(200)
    expect(((await json(await s.get(`/api/session?session_id=${sid}`))).session as Json).messages).toEqual([])
  })

  it('duplicates and branches sessions with parent lineage', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }])
    let res = await post(s, '/api/session/duplicate', { session_id: sid })
    expect(res.status).toBe(200)
    const dup = (await json(res)).session as Json
    expect(dup.session_id).not.toBe(sid)
    expect(((await json(await s.get(`/api/session?session_id=${String(dup.session_id)}`))).session as Json).messages).toHaveLength(3)

    res = await post(s, '/api/session/branch', { session_id: sid, keep_count: 2, title: 'Branch' })
    expect(res.status).toBe(200)
    const branch = await json(res)
    expect(branch.parent_session_id).toBe(sid)
    expect(branch.title).toBe('Branch')
    const child = (await json(await s.get(`/api/session?session_id=${String(branch.session_id)}`))).session as Json
    expect(child.messages).toHaveLength(2)
    expect(child.parent_session_id).toBe(sid)
  })

  it('deletes a session, tombstones it, and prunes it from the index', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'bye' }])
    const res = await post(s, '/api/session/delete', { session_id: sid })
    expect(res.status).toBe(200)
    // No sidecar in this harness: the state.db cleanup cannot run, and the response says so (Python reported the
    // same when the store was unreachable) instead of claiming a cleanup that never happened.
    expect(await json(res)).toEqual({ ok: true, state_db_cleanup_failed: true })
    expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(false)
    expect((await s.get(`/api/session?session_id=${sid}`)).status).toBe(404)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).not.toContain(sid)
    const tomb = JSON.parse(readFileSync(join(s.state, 'sessions', '_deleted_webui_sessions.json'), 'utf8')) as Json
    expect(tomb.version).toBe(1)
    expect(tomb.ids).toContain(sid)
    // Python answers a repeat delete idempotently.
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
  })

  it('imports, searches, and reports status and usage', async () => {
    let res = await post(s, '/api/session/import', { title: 'Imported', messages: [{ role: 'user', content: 'needle in the hay' }, { role: 'assistant', content: 'found' }] })
    expect(res.status).toBe(200)
    const imported = (await json(res)).session as Json
    expect(imported.title).toBe('Imported')
    res = await s.get('/api/sessions/search?q=needle')
    expect(res.status).toBe(200)
    const found = await json(res)
    expect((found.sessions as Json[]).map((r) => r.session_id)).toContain(imported.session_id)
    res = await s.get(`/api/session/status?session_id=${String(imported.session_id)}`)
    expect(res.status).toBe(200)
    expect((await json(res)).session_id).toBe(imported.session_id)
    res = await s.get(`/api/session/usage?session_id=${String(imported.session_id)}`)
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    expect((await s.get('/api/session/status')).status).toBe(400)
  })

  it('reports streaming only for a live runtime stream on detail, list, search, status and mutation replies (TAL-312)', async () => {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'streamprobe question' }, { role: 'assistant', content: 'ok' }])
    // A dead run: the persisted id is not a live stream, and a fresh pending prompt keeps the stale sweep from clearing it.
    const stored = s.deps.sessionStore.get(sid)
    stored.title = 'Streamprobe'
    stored.active_stream_id = 'streamprobe1'
    stored.pending_user_message = 'still pending'
    stored.pending_started_at = Date.now() / 1000
    s.deps.sessionStore.save(stored)
    const payloads = async (): Promise<Json[]> => {
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      const row = ((await json(await s.get('/api/sessions'))).sessions as Json[]).find((r) => r.session_id === sid)!
      const hit = ((await json(await s.get('/api/sessions/search?q=streamprobe'))).sessions as Json[]).find((r) => r.session_id === sid)!
      const status = await json(await s.get(`/api/session/status?session_id=${sid}`))
      const pinned = (await json(await post(s, '/api/session/pin', { session_id: sid, pinned: false }))).session as Json
      return [detail, row, hit, status, pinned]
    }
    for (const payload of await payloads()) expect(payload).toMatchObject({ is_streaming: false, active_stream_id: null, read_only: false })
    expect((await payloads())[3]?.agent_running).toBe(false)
    s.deps.registry.liveIds.add('streamprobe1')
    try {
      for (const payload of await payloads()) expect(payload).toMatchObject({ is_streaming: true, active_stream_id: 'streamprobe1' })
      expect((await payloads())[3]?.agent_running).toBe(true)
    } finally {
      s.deps.registry.liveIds.delete('streamprobe1')
    }
  })

  it('marks persisted read-only and subagent sessions read_only on every payload (TAL-312)', async () => {
    const readOnly = String((await newSession(s)).session_id)
    const subagent = String((await newSession(s)).session_id)
    for (const [sid, apply] of [[readOnly, (x: Session) => { x.read_only = true }], [subagent, (x: Session) => { x.source_tag = 'subagent' }]] as const) {
      const stored = s.deps.sessionStore.get(sid)
      apply(stored)
      stored.title = 'Roprobe'
      stored.messages = [{ role: 'user', content: 'roprobe' }, { role: 'assistant', content: 'ok' }]
      s.deps.sessionStore.save(stored)
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      const hit = ((await json(await s.get('/api/sessions/search?q=roprobe'))).sessions as Json[]).find((r) => r.session_id === sid)!
      const status = await json(await s.get(`/api/session/status?session_id=${sid}`))
      for (const payload of [detail, hit, status]) expect(payload, sid).toMatchObject({ read_only: true, is_streaming: false })
      expect(detail).not.toHaveProperty('is_read_only')
      // The server refuses to branch either, and says so up front.
      for (const payload of [detail, hit]) expect(payload.can_branch, sid).toBe(false)
      expect((await post(s, '/api/session/branch', { session_id: sid })).status, sid).toBeGreaterThanOrEqual(400)
      // Pin, archive and duplicate refuse only the subagent child; each flag matches its endpoint's outcome.
      const allowed = sid === readOnly
      for (const payload of [detail, hit]) expect(payload, sid).toMatchObject({ can_pin: allowed, can_archive: allowed, can_duplicate: allowed })
      for (const [path, body] of [['/api/session/pin', { session_id: sid, pinned: false }], ['/api/session/archive', { session_id: sid, archived: false }], ['/api/session/duplicate', { session_id: sid }]] as const) {
        expect((await post(s, path, body)).status === 200, `${sid} ${path}`).toBe(allowed)
      }
    }
  })

  it('offers branching exactly where the branch gate allows it, including a read-only cron run (TAL-312)', async () => {
    const writable = String((await newSession(s)).session_id)
    const cron = String((await newSession(s)).session_id)
    const stored = s.deps.sessionStore.get(cron)
    stored.read_only = true
    stored.source_tag = 'cron'
    s.deps.sessionStore.save(stored)
    for (const sid of [writable, cron]) {
      writeMessages(s, sid, [{ role: 'user', content: 'branchprobe' }, { role: 'assistant', content: 'ok' }])
      const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
      expect(detail.can_branch, sid).toBe(true)
      expect((await post(s, '/api/session/branch', { session_id: sid })).status, sid).toBe(200)
    }
  })

  it('stores composer drafts with monotonic versions and 409 on stale writes', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    let res = await post(s, '/api/session/draft', { session_id: sid, text: 'hello', draft_version: '10' })
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.draft).toEqual({ text: 'hello', files: [] })
    expect(body.draft_version).toBe('10')
    expect(existsSync(join(s.state, 'sessions', '_drafts', `${sid}.json`))).toBe(true)

    res = await post(s, '/api/session/draft', { session_id: sid, text: 'older', draft_version: '5' })
    expect(res.status).toBe(409)
    body = await json(res)
    expect(body.error).toBe('Composer draft changed in another request')
    expect(body.draft_version).toBe('10')

    res = await post(s, '/api/session/draft', { session_id: sid, text: 'hello', draft_version: '10' })
    expect(res.status).toBe(200)
    expect((await json(res)).unchanged).toBe(true)

    res = await s.get(`/api/session/draft?session_id=${sid}`)
    expect(res.status).toBe(200)
    expect((await json(res)).draft).toEqual({ text: 'hello', files: [] })
    expect((await post(s, '/api/session/draft', { session_id: sid, draft_version: true })).status).toBe(400)
    expect((await post(s, '/api/session/draft', { session_id: 'deadbeef0000', text: 'x' })).status).toBe(404)
  })

  it('creates, reads, and revokes shares with the noindex header', async () => {
    const a = await newSession(s)
    const sid = String(a.session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'share me' }, { role: 'assistant', content: 'ok' }])
    let res = await post(s, '/api/share/create', { session_id: sid })
    expect(res.status).toBe(200)
    const share = (await json(res)).share as Json
    expect(String(share.token)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(share.message_count).toBe(2)
    res = await s.get(`/api/share/${String(share.token)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const read = (await json(res)).share as Json
    expect((read.messages as Json[]).map((m) => m.content)).toEqual(['share me', 'ok'])
    res = await post(s, '/api/share/revoke', { session_id: sid })
    expect(res.status).toBe(200)
    expect((await s.get(`/api/share/${String(share.token)}`)).status).toBe(404)
    expect((await s.get('/api/share/../etc')).status).toBe(404)
  })

  it('cleans up zero-message sessions and toggles yolo', async () => {
    const a = await newSession(s)
    writeMessages(s, String(a.session_id), [])
    const res = await post(s, '/api/sessions/cleanup_zero_message', {})
    expect(res.status).toBe(200)
    expect(((await json(res)).cleaned as number)).toBeGreaterThanOrEqual(1)
    expect((await s.get(`/api/session?session_id=${String(a.session_id)}`)).status).toBe(404)
    const b = await newSession(s)
    expect(await json(await s.get(`/api/session/yolo?session_id=${String(b.session_id)}`))).toEqual({ yolo_enabled: false })
    expect((await post(s, '/api/session/yolo', { session_id: b.session_id, enabled: true })).status).toBe(200)
    expect(await json(await s.get(`/api/session/yolo?session_id=${String(b.session_id)}`))).toEqual({ yolo_enabled: true })
  })
})

describe('session store disk freshness', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('a cached session whose file was deleted underneath it is evicted and never recreated by a later mutation', async () => {
    const sid = String((await newSession(s)).session_id)
    const cached = s.deps.sessionStore.get(sid)
    cached.title = 'persisted'
    s.deps.sessionStore.save(cached)
    rmSync(cached.path ?? '')
    expect(() => s.deps.sessionStore.get(sid)).toThrow()
    expect(() => s.deps.sessionStore.get(sid, { metadataOnly: true })).toThrow()
    expect((await post(s, '/api/session/rename', { session_id: sid, title: 'ghost' })).status).toBe(404)
    expect(existsSync(cached.path ?? '')).toBe(false)
  })

  it('a metadata-only read is signed by the inode it read, so a file replaced meanwhile is reloaded', async () => {
    const sid = String((await newSession(s)).session_id)
    const full = s.deps.sessionStore.get(sid)
    full.title = 'old owner'
    s.deps.sessionStore.save(full)
    const path = full.path ?? ''
    const before = readMetadataJsonPrefixWithSignature(path)
    // Atomic replacement after the descriptor was opened: the signature must describe the old inode, not the new file.
    const replacement = { ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), title: 'new owner' }
    writeFileSync(`${path}.tmp`, JSON.stringify(replacement))
    renameSync(`${path}.tmp`, path)
    expect(before.prefix).toContain('old owner')
    expect(before.signature).not.toBe(statSignature(path))
    s.deps.sessionStore.sessions.delete(sid)
    const stub = s.deps.sessionStore.loadMetadataOnly(sid)
    expect(stub?.title).toBe('new owner')
    expect(stub?.sidecarLoadedSignature).toBe(statSignature(path))
  })

  it('reloads a cached session whose read identity is unknown instead of trusting the stale snapshot', async () => {
    const sid = String((await newSession(s)).session_id)
    const cached = s.deps.sessionStore.get(sid)
    cached.title = 'cached title'
    s.deps.sessionStore.save(cached)
    // Another process replaces the transcript; the cached read happened while the file was changing.
    const doc = JSON.parse(readFileSync(cached.path ?? '', 'utf8')) as Record<string, unknown>
    doc.title = 'written by the Agent'
    writeFileSync(cached.path ?? '', JSON.stringify(doc))
    cached.sidecarLoadedSignature = null
    expect(s.deps.sessionStore.get(sid).title).toBe('written by the Agent')
    expect(s.deps.sessionStore.get(sid).sidecarLoadedSignature).not.toBeNull()
  })
})

describe('projects, workspaces, and files over HTTP', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('projects require a name, validate colours, and list per profile', async () => {
    expect((await post(s, '/api/projects/create', { name: '   ' })).status).toBe(400)
    let res = await post(s, '/api/projects/create', { name: 'Alpha', color: 'red' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Invalid color format')
    res = await post(s, '/api/projects/create', { name: 'Alpha', color: '#ff0000' })
    expect(res.status).toBe(200)
    const project = (await json(res)).project as Json
    expect(project.profile).toBe('default')
    res = await post(s, '/api/projects/rename', { project_id: project.project_id, name: 'Beta', color: null })
    expect(res.status).toBe(200)
    expect(((await json(res)).project as Json).color).toBeNull()
    const list = await json(await s.get('/api/projects'))
    expect((list.projects as Json[]).map((p) => p.name)).toEqual(['Beta'])
    expect((await post(s, '/api/projects/rename', { project_id: 'nope', name: 'x' })).status).toBe(404)
    const raw = JSON.parse(readFileSync(join(s.state, 'projects.json'), 'utf8')) as Json[]
    expect(raw[0]?.name).toBe('Beta')
  })

  it('workspaces strip pasted quotes, reject duplicates and system paths, reorder, and rename', async () => {
    const dir = join(realpathSync(s.state), 'proj')
    mkdirSync(dir)
    let res = await post(s, '/api/workspaces/add', { path: `"${dir}"` })
    expect(res.status).toBe(200)
    let list = (await json(res)).workspaces as Json[]
    expect(list.map((w) => w.path)).toContain(dir)
    expect(list.find((w) => w.path === dir)?.name).toBe('proj')
    res = await post(s, '/api/workspaces/add', { path: dir })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Workspace already in list')
    res = await post(s, '/api/workspaces/add', { path: '/etc' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/workspaces/add', { path: join(s.state, 'missing') })
    expect(res.status).toBe(400)
    res = await post(s, '/api/workspaces/add', { path: join(realpathSync(s.state), 'made'), create: true })
    expect(res.status).toBe(200)
    expect(existsSync(join(realpathSync(s.state), 'made'))).toBe(true)

    res = await post(s, '/api/workspaces/reorder', { paths: [join(realpathSync(s.state), 'made'), dir] })
    expect(res.status).toBe(200)
    list = (await json(res)).workspaces as Json[]
    expect(list.slice(0, 2).map((w) => w.path)).toEqual([join(realpathSync(s.state), 'made'), dir])
    res = await post(s, '/api/workspaces/rename', { path: dir, name: 'Renamed' })
    expect(res.status).toBe(200)
    res = await s.get('/api/workspaces')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect((body.workspaces as Json[]).find((w) => w.path === dir)?.name).toBe('Renamed')
    expect(body.terminal_remote_backend).toBe(false)
    res = await post(s, '/api/workspaces/remove', { path: dir })
    expect(((await json(res)).workspaces as Json[]).some((w) => w.path === dir)).toBe(false)
    const suggest = await json(await s.get(`/api/workspaces/suggest?prefix=${encodeURIComponent(join(realpathSync(s.state), 'ma'))}`))
    expect(suggest.suggestions).toContain(join(realpathSync(s.state), 'made'))
  })

  it('file operations stay inside the workspace and reject symlink escapes', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    const session = await newSession(s, { workspace: ws })
    const sid = String(session.session_id)
    let res = await post(s, '/api/file/create', { session_id: sid, path: 'notes/a.txt', content: 'hello' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, path: 'notes/a.txt' })
    expect((await post(s, '/api/file/create', { session_id: sid, path: 'notes/a.txt', content: '' })).status).toBe(400)
    res = await s.get(`/api/list?session_id=${sid}&path=notes`)
    expect(res.status).toBe(200)
    const listing = await json(res)
    expect((listing.entries as Json[]).map((e) => e.name)).toEqual(['a.txt'])
    expect(listing.workspace).toBe(ws)
    res = await s.get(`/api/file?session_id=${sid}&path=notes/a.txt`)
    expect(res.status).toBe(200)
    expect((await json(res)).content).toBe('hello')
    res = await post(s, '/api/file/save', { session_id: sid, path: 'notes/a.txt', content: 'changed' })
    expect(res.status).toBe(200)
    expect(readFileSync(join(ws, 'notes', 'a.txt'), 'utf8')).toBe('changed')
    expect((await post(s, '/api/file/create-dir', { session_id: sid, path: 'sub' })).status).toBe(200)
    res = await post(s, '/api/file/rename', { session_id: sid, path: 'notes/a.txt', new_name: 'b.txt' })
    expect(res.status).toBe(200)
    expect((await json(res)).new_path).toBe('notes/b.txt')
    res = await post(s, '/api/file/move', { session_id: sid, path: 'notes/b.txt', destination: 'sub' })
    expect(res.status).toBe(200)
    expect((await json(res)).new_path).toBe('sub/b.txt')
    expect((await post(s, '/api/file/move', { session_id: sid, path: 'sub', dest_dir: 'sub' })).status).toBe(400)

    expect((await s.get(`/api/file?session_id=${sid}&path=../../etc/passwd`)).status).toBe(404)
    expect((await post(s, '/api/file/save', { session_id: sid, path: '../outside.txt', content: 'x' })).status).toBe(400)
    expect(existsSync(join(s.state, 'outside.txt'))).toBe(false)
    symlinkSync(s.state, join(ws, 'escape'))
    expect((await post(s, '/api/file/delete', { session_id: sid, path: 'escape' })).status).toBe(400)
    expect((await s.get(`/api/file?session_id=${sid}&path=escape/settings.json`)).status).toBe(404)
    expect((await s.get(`/api/list?session_id=${sid}&path=escape`)).status).toBe(404)

    res = await post(s, '/api/file/delete', { session_id: sid, path: 'sub' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Set recursive=true to delete directories')
    expect((await post(s, '/api/file/delete', { session_id: sid, path: 'sub', recursive: true })).status).toBe(200)
    expect(readdirSync(ws)).not.toContain('sub')
    expect((await s.get('/api/list?session_id=deadbeef0000')).status).toBe(404)
  })

  it('file operations keep the Python validation contract: require(), Office guard, listing timestamps, launcher errors', async () => {
    const ws = realpathSync(join(s.state, 'workspace'))
    const sid = String((await newSession(s, { workspace: ws })).session_id)
    // `require()` rejects empty strings and names every missing field.
    let res = await post(s, '/api/file/create', { session_id: sid, path: '' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Missing required field(s): path')
    res = await post(s, '/api/file/rename', { session_id: '', path: 'x', new_name: '' })
    expect((await json(res)).error).toBe('Missing required field(s): session_id, new_name')
    res = await post(s, '/api/file/move', { session_id: sid, path: 'x' })
    expect((await json(res)).error).toBe('Missing required field(s): dest_dir')
    // `recursive` is truthy-checked like `body.get("recursive")`.
    mkdirSync(join(ws, 'rdir'))
    expect((await post(s, '/api/file/delete', { session_id: sid, path: 'rdir', recursive: 1 })).status).toBe(200)
    // Office documents are refused by the text save.
    writeFileSync(join(ws, 'doc.docx'), 'PK\u0003\u0004binary')
    res = await post(s, '/api/file/save', { session_id: sid, path: 'doc.docx', content: 'x' })
    expect(res.status).toBe(400)
    // `/api/file/office-save` was dropped with TAL-245: the refusal must not point clients at a 404.
    expect((await json(res)).error).toBe('Office documents cannot be saved from the Web UI')
    expect(readFileSync(join(ws, 'doc.docx'), 'utf8')).toBe('PK\u0003\u0004binary')
    // Listing timestamps are decimal strings.
    const listing = await json(await s.get(`/api/list?session_id=${sid}`))
    const doc = (listing.entries as Json[]).find((e) => e.name === 'doc.docx')
    expect(typeof doc?.mtime_ns).toBe('string')
    // A NUL byte in a path is invalid input, not a lookup miss.
    expect((await post(s, '/api/file/create', { session_id: sid, path: 'a\u0000b' })).status).toBe(400)
    // A workspace the trust policy rejects makes the listing a 404 with the policy text (Python `_handle_list`).
    const stray = mkdtempSync(join(tmpdir(), 'talaria-stray-'))
    const strayed = s.deps.sessionStore.get(sid)
    strayed.workspace = stray
    s.deps.sessionStore.save(strayed)
    res = await s.get(`/api/list?session_id=${sid}`)
    expect(res.status).toBe(404)
    expect(String((await json(res)).error)).toContain(stray)
    rmSync(stray, { recursive: true, force: true })
    strayed.workspace = ws
    s.deps.sessionStore.save(strayed)
  })
})

describe('truncation keeps deleted state.db turns deleted (TAL-504)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('serves and sends only the kept turns after a truncate of a CLI-continued session', async () => {
    const sid = String((await newSession(s)).session_id)
    const rows: [string, string, number][] = [['user', 'u1', 100], ['assistant', 'a1', 101], ['user', 'u2', 102], ['assistant', 'a2', 103], ['user', 'u3', 104], ['assistant', 'a3', 105]]
    writeMessages(s, sid, rows.map(([role, content, timestamp]) => ({ role, content, timestamp })))
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'cli', 100)
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    expect((await post(s, '/api/session/truncate', { session_id: sid, keep_count: 2 })).status).toBe(200)
    const served = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1`))).session as Json).messages as Json[]
    expect(served.map((m) => m.content)).toEqual(['u1', 'a1'])
    expect(s.deps.sessions.modelContext(s.deps.sessionStore.get(sid)).map((m) => m.content)).toEqual(['u1', 'a1'])
  })

  it('does not carry the cut to a duplicate, whose state.db has no deleted suffix', async () => {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'u1', timestamp: 100 }, { role: 'assistant', content: 'a1', timestamp: 101 }, { role: 'user', content: 'u2', timestamp: 102 }])
    expect((await post(s, '/api/session/truncate', { session_id: sid, keep_count: 2 })).status).toBe(200)
    const copy = String(((await json(await post(s, '/api/session/duplicate', { session_id: sid }))).session as Json).session_id)
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(copy, 'cli', 100)
    for (const [role, content, ts] of [['user', 'u1', 100], ['assistant', 'a1', 101], ['user', 'from the CLI', 200], ['assistant', 'CLI answer', 201]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(copy, role, content, ts)
    db.close()
    const served = ((await json(await s.get(`/api/session?session_id=${copy}&messages=1`))).session as Json).messages as Json[]
    expect(served.map((m) => m.content)).toEqual(['u1', 'a1', 'from the CLI', 'CLI answer'])
  })
})

describe('session detail marks background wakeups as updates (TAL-371)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  const detail = async (sid: string, query = ''): Promise<Json[]> => ((await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json).messages as Json[]

  it('labels a stored wakeup, keeps a typed marker a user message, and agrees in every window', async () => {
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [
      { role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_typed]\nI typed this myself', timestamp: 1000 },
      { role: 'assistant', content: 'Noted.', timestamp: 1001 },
      { role: 'user', content: '[IMPORTANT: Background process proc_1 completed (exit_code=0).]\nCommand: make', timestamp: 1002, _source: 'process_wakeup', _turn_id: 'wake-legacy' },
      { role: 'assistant', content: 'The build passed.', timestamp: 1003, _turn_id: 'wake-legacy' },
    ]
    s.deps.sessionStore.save(session)
    for (const query of ['', '&msg_limit=120', '&msg_limit=2', '&msg_limit=1', '&msg_limit=1&msg_before=3']) {
      for (const m of await detail(sid, query)) {
        if (m.timestamp === 1000) expect(m, query).not.toHaveProperty('_background_update')
        // No event metadata survives for an older wakeup, so it gets the generic label.
        if (m.timestamp === 1002) expect(m._background_update, query).toEqual({ kind: 'other', attention: false, count: 1, summary: 'IMPORTANT: Background process proc_1 completed (exit_code=0).', lines: [{ kind: 'other', status: 'completed', label: 'IMPORTANT: Background process proc_1 completed (exit_code=0).' }] })
        if (m.role === 'assistant') expect(m).not.toHaveProperty('_background_update')
        // TAL-460: the reply to the wakeup is marked in every window, even one that starts after the wakeup row.
        if (m.timestamp === 1001) expect(m, query).not.toHaveProperty('_background_reply')
        if (m.timestamp === 1003) expect(m._background_reply, query).toBe(true)
      }
    }
  })

  it('labels the Agent\'s own delivery row from its state.db display kind', async () => {
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'dispatch', timestamp: 1000 }, { role: 'assistant', content: 'Dispatched.', timestamp: 1001 }]
    s.deps.sessionStore.save(session)
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, display_metadata TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'user', 'dispatch', 1000)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, 'assistant', 'Dispatched.', 1001)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp, display_kind, display_metadata) VALUES (?, ?, ?, ?, ?, ?)').run(sid, 'user', '[IMPORTANT: 3 background subagent delegations completed for this session.]\n…', 1002, 'async_delegation_complete', JSON.stringify({ delegation_id: 'deleg_db', task_count: 3, completed_count: 2, failed_count: 1 }))
    db.close()
    const row = (await detail(sid)).find((m) => m.timestamp === 1002)
    expect(row?._background_update).toEqual({ kind: 'delegation', attention: true, count: 1, summary: 'IMPORTANT: 3 background subagent delegations completed for this session.', lines: [{ kind: 'other', status: 'failed', label: 'IMPORTANT: 3 background subagent delegations completed for this session.' }] })
  })
  it('serves the shared background-update example exactly as the contract fixture records it', async () => {
    const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Json).background_update_session as Json
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    // The stored rows are what the server reads; `_background_update` is what it adds on the way out.
    session.messages = (fixture.messages as Json[]).map((m) => { const stored = { ...m }; delete stored._background_update; return stored })
    session.extra.background_updates = fixture.background_updates
    s.deps.sessionStore.save(session)
    const served = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1&msg_limit=50`))).session as Json).messages
    expect(served).toEqual(fixture.messages)
  })
})

describe('session detail collapses very long message bodies (TAL-456)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('stamps an excerpt on long settled rows in every window, leaves short rows alone, and never rewrites the file', async () => {
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [
      { role: 'user', content: `${'w'.repeat(2500)}\n${'r'.repeat(20000)}`, timestamp: 1000 },
      { role: 'assistant', content: 'short reply', timestamp: 1001 },
      { role: 'user', content: 'tiny', timestamp: 1002 },
      { role: 'assistant', content: [{ type: 'text', text: 'p'.repeat(5000) }], timestamp: 1003 },
    ]
    s.deps.sessionStore.save(session)
    s.deps.sessionStore.sessions.delete(sid)
    const path = join(s.state, 'sessions', `${sid}.json`)
    const before = readFileSync(path)
    for (const query of ['', '&msg_limit=120', '&msg_limit=2', '&msg_limit=2&msg_before=2']) {
      const res = await s.get(`/api/session?session_id=${sid}&messages=1${query}`)
      expect(res.status, query).toBe(200)
      for (const m of ((await json(res)).session as Json).messages as Json[]) {
        const long = m.timestamp === 1000 || m.timestamp === 1003
        expect(m._display_truncated, `${query} ${String(m.timestamp)}`).toBe(long ? true : undefined)
        if (m.timestamp === 1000) expect(m._display_excerpt).toBe('w'.repeat(2500))
        if (m.timestamp === 1003) {
          expect(m._display_excerpt).toBe('p'.repeat(3000))
          expect((m._anchor_activity_scene as Json).final_answer_excerpt).toBe('p'.repeat(3000))
        }
        if (m.timestamp === 1001) expect(m._anchor_activity_scene).not.toHaveProperty('final_answer_excerpt')
        if (!long) expect(m).not.toHaveProperty('_display_excerpt')
      }
    }
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('serves the shared long-body example exactly as the contract fixture records it', async () => {
    const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Json).long_body_session as Json
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = (fixture.messages as Json[]).map(({ role, content, timestamp, message_id }) => ({ role, content, timestamp, message_id }))
    s.deps.sessionStore.save(session)
    const served = ((await json(await s.get(`/api/session?session_id=${sid}&messages=1&msg_limit=50`))).session as Json).messages
    expect(served).toEqual(fixture.messages)
    if (process.env.RECORD_TAL460) { const path = join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'); const all = JSON.parse(readFileSync(path, 'utf8')) as Json; (all.background_update_session as Json).messages = served; writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`) }
  })
})

describe('session detail with legacy string attachments (TAL-277)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  /** A session file as the Python server wrote it: attachments as bare filenames, read back from disk. */
  async function legacySession(attachments: unknown[], pending: unknown[] = []): Promise<{ sid: string; path: string }> {
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = [
      { role: 'user', content: 'look at this', timestamp: 1000, attachments },
      { role: 'assistant', content: 'seen', timestamp: 1001 },
    ]
    session.pending_attachments = pending
    s.deps.sessionStore.save(session)
    s.deps.sessionStore.sessions.delete(sid)
    return { sid, path: join(s.state, 'sessions', `${sid}.json`) }
  }

  it('ships bare-filename attachments as filename-only objects in every window without rewriting the file', async () => {
    const upload = { name: 'upload.png', path: '/uploads/upload.png', mime: 'image/png', is_image: true }
    const { sid, path } = await legacySession(['example.png', upload], ['draft.txt'])
    const before = readFileSync(path)
    for (const query of ['', '&msg_limit=120', '&msg_limit=1&msg_before=1']) {
      const res = await s.get(`/api/session?session_id=${sid}&messages=1${query}`)
      expect(res.status).toBe(200)
      const session = (await json(res)).session as Json
      const user = (session.messages as Json[]).find((m) => m.role === 'user')
      expect(user?.attachments).toEqual([{ name: 'example.png', filename: 'example.png' }, upload])
      expect(session.pending_attachments).toEqual([{ name: 'draft.txt', filename: 'draft.txt' }])
    }
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('still refuses an attachment that is neither a filename nor an object', async () => {
    const { sid } = await legacySession([42])
    expect((await s.get(`/api/session?session_id=${sid}&messages=1`)).status).toBe(500)
  })
})

describe('session detail transcript cursor (TAL-316)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const detail = async (sid: string, query = ''): Promise<Json> => (await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json
  const contents = (session: Json): unknown[] => (session.messages as Json[]).map((m) => m.content)

  /** A session with one settled turn whose next run is held mid-turn (prose, tool, prose) with its rows partly in state.db. */
  async function runningTurn(): Promise<{ sid: string; streamId: string; release: () => void }> {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'earlier', timestamp: 1000 }, { role: 'assistant', content: 'earlier reply', timestamp: 1001 }])
    let release: () => void = () => undefined
    sidecar.respond('chat.start', (params, emit) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'Reading.' } })
      emit({ event: 'tool', data: { event_type: 'tool.started', name: 'read_file', args: {}, tid: 't1' } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'read_file', tid: 't1', preview: 'A' } })
      emit({ event: 'token', data: { text: 'Done' } })
      release = () => { resolve(completedTurn([{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'A' }, { role: 'assistant', content: 'Done' }])) }
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message: 'read it' }))
    const streamId = String(start.stream_id)
    const startedAt = Number(start.pending_started_at)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token' && (f.data as Json).text === 'Done')
    // The Agent has already written the prompt, the first prose segment and the tool round to state.db.
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    const rows: [string, string, number][] = [['user', 'earlier', 1000], ['assistant', 'earlier reply', 1001], ['user', 'read it', startedAt + 0.5], ['assistant', 'Reading.', startedAt + 1], ['tool', 'A', startedAt + 2]]
    for (const [role, content, ts] of rows) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    return { sid, streamId, release }
  }

  it('omits a journaled running turn\'s output, keeps its prompt, and resuming from the cursor renders each segment once', async () => {
    const { sid, streamId, release } = await runningTurn()
    const session = await detail(sid)
    expect(contents(session)).toEqual(['earlier', 'earlier reply', 'read it'])
    expect(session.transcript_seq).toEqual({ stream_id: streamId, seq: 0 })
    expect(session.message_count).toBe(3)
    // Every window agrees: the omission applies before windowing.
    const window = await detail(sid, '&msg_limit=2')
    expect(window.transcript_seq).toEqual({ stream_id: streamId, seq: 0 })
    expect(contents(window)).toEqual(['earlier reply', 'read it'])
    expect(window.message_count).toBe(3)
    const older = await detail(sid, '&msg_limit=2&msg_before=1')
    expect(contents(older)).toEqual(['earlier'])
    // Resuming from the stated cursor delivers the running turn once, in order.
    const seq = (session.transcript_seq as { seq: number }).seq
    const frames = await s.sse(`/api/chat/stream?stream_id=${streamId}&after_seq=${String(seq)}`, (f) => f.event === 'token' && (f.data as Json).text === 'Done')
    expect(frames.filter((f) => ['token', 'tool', 'tool_complete'].includes(f.event)).map((f) => `${f.event}:${String((f.data as Json).text ?? (f.data as Json).name)}`))
      .toEqual(['token:Reading.', 'tool:read_file', 'tool_complete:read_file', 'token:Done'])
    const ids = frames.map((f) => f.id).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    // A settled session states no cursor and returns its whole transcript.
    const settled = await detail(sid)
    expect(settled.transcript_seq).toBeNull()
    expect(contents(settled)).toContain('Done')
  })

  it('returns the persisted transcript unchanged and no cursor when the running turn has no journal', async () => {
    const { sid, release } = await runningTurn()
    const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
    try {
      const session = await detail(sid)
      expect(session.transcript_seq).toBeNull()
      expect(contents(session)).toEqual(['earlier', 'earlier reply', 'read it', 'Reading.', 'A'])
    } finally {
      findRunSummary.mockRestore()
      release()
    }
  })

  it('states no cursor and keeps the persisted turn when its journal missed a frame', async () => {
    const append = Object.getOwnPropertyDescriptor(RunJournalWriter.prototype, 'appendSseEvent')?.value as (this: RunJournalWriter, event: string, data: unknown) => ReturnType<RunJournalWriter['appendSseEvent']>
    const failing = vi.spyOn(RunJournalWriter.prototype, 'appendSseEvent').mockImplementation(function (this: RunJournalWriter, event: string, data: unknown) {
      if (event === 'tool') throw new Error('disk full')
      return append.call(this, event, data)
    })
    let turn: Awaited<ReturnType<typeof runningTurn>> | null = null
    try {
      turn = await runningTurn()
    } finally {
      failing.mockRestore()
    }
    try {
      const session = await detail(turn.sid)
      expect(session.transcript_seq).toBeNull()
      expect(contents(session)).toEqual(['earlier', 'earlier reply', 'read it', 'Reading.', 'A'])
    } finally {
      turn.release()
    }
  })

  it('an idle session states no cursor', async () => {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, [{ role: 'user', content: 'hi', timestamp: 10 }, { role: 'assistant', content: 'hello', timestamp: 11 }])
    const session = await detail(sid)
    expect(session.transcript_seq).toBeNull()
    expect(contents(session)).toEqual(['hi', 'hello'])
  })

  it('keeps a checkpointed prompt and the server\'s steer rows, and drops the rest of the turn', () => {
    const turn = { localCount: 4, turnId: 'run1', startedAt: 100, activeTurnToken: 'run1:100' }
    const rows = [
      { role: 'user', content: 'earlier', timestamp: 1 }, { role: 'assistant', content: 'earlier reply', timestamp: 2 },
      { role: 'user', content: 'prompt', timestamp: 100, _turn_id: 'run1', _active_turn_token: 'run1:100' },
      { role: 'user', content: 'steer', timestamp: 103, _turn_id: 'run1', _steer: { steer_id: 's1' } },
      { role: 'user', content: 'prompt', timestamp: 101 }, { role: 'assistant', content: 'partial', timestamp: 102 },
    ]
    expect(withoutRunningTurnOutput(rows, turn).map((m) => m.content)).toEqual(['earlier', 'earlier reply', 'prompt', 'steer'])
    // Deferred save: no checkpointed prompt, so the turn starts at its first state.db row past the sidecar.
    const deferred = [rows[0]!, rows[1]!, rows[4]!, rows[5]!]
    expect(withoutRunningTurnOutput(deferred, { ...turn, localCount: 2 }).map((m) => m.content)).toEqual(['earlier', 'earlier reply', 'prompt'])
    // Nothing of the turn persisted yet: the transcript is unchanged.
    expect(withoutRunningTurnOutput([rows[0]!, rows[1]!], { ...turn, localCount: 2 })).toHaveLength(2)
  })
})

describe('session detail keeps the running turn\'s prompt (TAL-368)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(() => s.close())

  const detail = async (sid: string, query = ''): Promise<Json> => (await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json
  const users = (session: Json): Json[] => (session.messages as Json[]).filter((m) => m.role === 'user')

  /** A deferred-save turn held after its first token; the Agent has written nothing to state.db. */
  async function heldTurn(message: string, history: Json[], attachments?: Json[]): Promise<{ sid: string; streamId: string; startedAt: number; release: () => void }> {
    const sid = String((await newSession(s)).session_id)
    writeMessages(s, sid, history)
    let release: () => void = () => undefined
    sidecar.respond('chat.interrupt', () => ({ ok: true }))
    sidecar.respond('chat.start', (params, emit, opts) => new Promise((resolve) => {
      emit({ event: 'token', data: { text: 'Agent is still working.' } })
      const turn = [{ role: 'user', content: str(params.user_message) }, { role: 'assistant', content: 'Agent is still working.' }]
      release = () => { resolve(completedTurn(turn)) }
      opts.signal?.addEventListener('abort', () => { resolve({ ...completedTurn(turn.slice(0, 1)), status: 'cancelled' }) })
    }))
    const start = await json(await post(s, '/api/chat/start', { session_id: sid, message, ...(attachments ? { attachments } : {}) }))
    const streamId = String(start.stream_id)
    await s.sse(`/api/chat/stream?stream_id=${streamId}`, (f) => f.event === 'token')
    return { sid, streamId, startedAt: Number(start.pending_started_at), release }
  }

  const history = [{ role: 'user', content: 'continue', timestamp: 1000 }, { role: 'assistant', content: 'earlier reply', timestamp: 1001 }]

  it('shows the pending prompt exactly once, last, in full and windowed reads, and settles to one canonical row', async () => {
    const { sid, streamId, release } = await heldTurn('Unique pending follow-up', history, [{ name: 'notes.txt', path: '/tmp/notes.txt', mime: 'text/plain' }])
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
    for (const session of [await detail(sid), await detail(sid, '&msg_limit=1')]) {
      const last = (session.messages as Json[]).at(-1)
      expect(last).toMatchObject({ role: 'user', content: 'Unique pending follow-up', _turn_id: streamId, _active_turn_user: true })
      expect(JSON.stringify(last?.attachments)).toContain('notes.txt')
      expect(users(session).filter((m) => m.content === 'Unique pending follow-up')).toHaveLength(1)
      expect(session.message_count).toBe(3)
      expect(session.transcript_seq).toEqual({ stream_id: streamId, seq: 0 })
    }
    // The projection is a read: deferred save still holds the prompt back from the sidecar.
    expect(s.deps.sessionStore.get(sid).messages).toHaveLength(2)
    release()
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'stream_end')
    const res = await s.get(`/api/session?session_id=${sid}&messages=1`)
    expect(res.status, await res.clone().text()).toBe(200)
    const settled = users((await json(res)).session as Json)
    expect(settled.map((m) => m.content)).toEqual(['continue', 'Unique pending follow-up'])
    expect(settled[1]?.attachments).toEqual([{ name: 'notes.txt', path: '/tmp/notes.txt', mime: 'text/plain' }])
    expect(settled.some((m) => m._active_turn_user)).toBe(false)
  })

  it('keeps a repeated prompt distinct from identical older text', async () => {
    const { sid, release } = await heldTurn('continue', history)
    try {
      const session = await detail(sid)
      expect(users(session).map((m) => m.content)).toEqual(['continue', 'continue'])
      expect(users(session)[1]?._active_turn_user).toBe(true)
    } finally {
      release()
    }
  })

  it('keeps the Agent\'s state.db prompt once, stamped as the running turn with its attachments', async () => {
    const { sid, streamId, startedAt, release } = await heldTurn('from state db', history, [{ name: 'plan.md', path: '/tmp/plan.md', mime: 'text/markdown' }])
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    for (const [role, content, ts] of [['user', 'continue', 1000], ['assistant', 'earlier reply', 1001], ['user', '[Workspace::v1: /tmp/ws]\nfrom state db', startedAt + 0.5]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    try {
      const prompts = users(await detail(sid))
      expect(prompts.map((m) => m.content)).toEqual(['continue', 'from state db'])
      expect(prompts[1]).toMatchObject({ _turn_id: streamId, _active_turn_user: true, attachments: [{ name: 'plan.md', path: '/tmp/plan.md', mime: 'text/markdown' }] })
      // Without a journal the persisted rows stand as they are, still with one prompt.
      const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
      try {
        expect(users(await detail(sid)).map((m) => m.content)).toEqual(['continue', 'from state db'])
      } finally {
        findRunSummary.mockRestore()
      }
    } finally {
      release()
    }
  })

  it('keeps the prompt in a limited window of a long running turn without a journal', async () => {
    const { sid, streamId, startedAt, release } = await heldTurn('long degraded run', history)
    const db = new DatabaseSync(join(s.state, 'state.db'))
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT)')
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(sid, 'webui', 1000)
    for (const [role, content, ts] of [['user', 'continue', 1000], ['assistant', 'earlier reply', 1001], ['user', 'long degraded run', startedAt + 0.1], ['assistant', 'step one', startedAt + 1], ['assistant', 'step two', startedAt + 2], ['assistant', 'step three', startedAt + 3]] as const) db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(sid, role, content, ts)
    db.close()
    const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
    try {
      const window = await detail(sid, '&msg_limit=1')
      expect((window.messages as Json[]).map((m) => m.content)).toEqual(['long degraded run', 'step one', 'step two', 'step three'])
      expect((window.messages as Json[])[0]).toMatchObject({ _turn_id: streamId, _active_turn_user: true })
      expect(window._messages_offset).toBe(2)
      // The older page ends before the prompt, so the prompt is never delivered twice.
      expect((await detail(sid, '&msg_limit=10&msg_before=2')).messages as Json[]).toHaveLength(2)
    } finally {
      findRunSummary.mockRestore()
      release()
    }
  })

  it('projects the prompt without a journal, and a cancelled turn settles to one row with its attachments', async () => {
    const { sid, streamId } = await heldTurn('cancel me', history, [{ name: 'cat.png', path: '/tmp/cat.png', mime: 'image/png' }])
    const findRunSummary = vi.spyOn(s.deps.journal, 'findRunSummary').mockReturnValue(null)
    try {
      const session = await detail(sid)
      expect(session.transcript_seq).toBeNull()
      expect(users(session).map((m) => m.content)).toEqual(['continue', 'cancel me'])
    } finally {
      findRunSummary.mockRestore()
    }
    expect((await json(await s.get(`/api/chat/cancel?stream_id=${streamId}`))).cancelled).toBe(true)
    await s.sse(`/api/chat/stream?stream_id=${streamId}&replay=1`, (f) => f.event === 'cancel')
    const settled = users(await detail(sid))
    expect(settled.map((m) => m.content)).toEqual(['continue', 'cancel me'])
    expect(JSON.stringify(settled[1]?.attachments)).toContain('cat.png')
    expect(settled[1]?._active_turn_user).toBeUndefined()
  })

  it('projects an attachment-only prompt ahead of the turn\'s first Agent row', () => {
    const turn = { localCount: 2, turnId: 'run1', startedAt: 100, activeTurnToken: 'run1:100', prompt: { role: 'user', content: '', attachments: [{ name: 'a.png' }] } }
    const rows = [{ role: 'user', content: 'earlier', timestamp: 1 }, { role: 'assistant', content: 'reply', timestamp: 2 }]
    expect(withPendingUserTurn(rows, turn).at(-1)).toMatchObject({ role: 'user', content: '', attachments: [{ name: 'a.png' }] })
    // An Agent row of the turn already past the sidecar: the prompt opens the turn ahead of it.
    const withOutput = [...rows, { role: 'assistant', content: 'partial', timestamp: 101 }]
    expect(withPendingUserTurn(withOutput, turn).map((m) => m.content)).toEqual(['earlier', 'reply', '', 'partial'])
  })
})

describe('session detail resolves each tool call\'s outcome (TAL-313)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  const RUN = 'tool-run-live'
  const call = (id: string, name: string, args: Json): Json => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  /** One turn per persisted shape: OpenAI calls (one failing), an Anthropic `tool_use` call, a call only the session-level list holds, and a running turn. */
  const transcript: Json[] = [
    { role: 'user', content: 'Read a.txt and run the tests', message_id: 'tool-user-openai', timestamp: 2000, _turn_id: 'tool-run-openai' },
    { role: 'assistant', content: '', message_id: 'tool-openai-calls', timestamp: 2001, _turn_id: 'tool-run-openai', tool_calls: [call('call-read', 'read_file', { path: 'a.txt' }), call('call-exit', 'terminal', { command: 'make test' })] },
    { role: 'tool', tool_call_id: 'call-read', content: 'A contents', timestamp: 2002, _turn_id: 'tool-run-openai' },
    { role: 'tool', tool_call_id: 'call-exit', content: '{"exit_code": 2, "output": "1 failed"}', timestamp: 2003, _turn_id: 'tool-run-openai' },
    { role: 'assistant', content: 'a.txt is read; one test fails.', message_id: 'tool-openai-answer', timestamp: 2004, _turn_id: 'tool-run-openai' },
    { role: 'user', content: 'Search for TODOs', message_id: 'tool-user-anthropic', timestamp: 2010, _turn_id: 'tool-run-anthropic' },
    { role: 'assistant', content: [{ type: 'text', text: 'Searching.' }, { type: 'tool_use', id: 'toolu-search', name: 'search_files', input: { pattern: 'TODO' } }], message_id: 'tool-anthropic-calls', timestamp: 2011, _turn_id: 'tool-run-anthropic' },
    { role: 'tool', tool_use_id: 'toolu-search', content: '{"error": "permission denied"}', timestamp: 2012, _turn_id: 'tool-run-anthropic' },
    { role: 'assistant', content: 'The search failed.', message_id: 'tool-anthropic-answer', timestamp: 2013, _turn_id: 'tool-run-anthropic' },
    { role: 'user', content: 'What day is it?', message_id: 'tool-user-session', timestamp: 2020, _turn_id: 'tool-run-session' },
    { role: 'assistant', content: 'Checking.', message_id: 'tool-session-calls', timestamp: 2021, _turn_id: 'tool-run-session' },
    { role: 'tool', content: 'Sat Sep 27', timestamp: 2022, _turn_id: 'tool-run-session' },
    { role: 'assistant', content: 'It is Saturday.', message_id: 'tool-session-answer', timestamp: 2023, _turn_id: 'tool-run-session' },
    { role: 'user', content: 'Run the build', message_id: 'tool-user-live', timestamp: 2030, _turn_id: RUN },
    { role: 'assistant', content: 'Building.', message_id: 'tool-live-calls', timestamp: 2031, _turn_id: RUN, tool_calls: [call('call-build', 'terminal', { command: 'make' })] },
  ]
  /** The live stream recorded these at settlement; the Anthropic call predates durations. */
  const sessionToolCalls: Json[] = [
    { name: 'read_file', snippet: 'A contents', tid: 'call-read', assistant_msg_idx: 1, args: { path: 'a.txt' }, is_error: false, duration: 1.25 },
    { name: 'terminal', snippet: '{"exit_code": 2, "output": "1 failed"}', tid: 'call-exit', assistant_msg_idx: 1, args: { command: 'make test' }, is_error: true, duration: 3.5 },
    { name: 'search_files', snippet: '{"error": "permission denied"}', tid: 'toolu-search', assistant_msg_idx: 6, args: { pattern: 'TODO' } },
    { name: 'terminal', snippet: 'Sat Sep 27', tid: 'call-date', assistant_msg_idx: 10, args: { command: 'date' }, is_error: false, duration: 0.42 },
  ]

  async function seeded(): Promise<string> {
    const sid = String((await newSession(s)).session_id)
    const session = s.deps.sessionStore.get(sid)
    session.messages = structuredClone(transcript)
    session.tool_calls = structuredClone(sessionToolCalls)
    session.title = 'Tool outcomes'
    session.active_stream_id = RUN
    s.deps.sessionStore.save(session)
    s.deps.registry.liveIds.add(RUN)
    return sid
  }
  const detail = async (sid: string, query = ''): Promise<Json> => (await json(await s.get(`/api/session?session_id=${sid}&messages=1${query}`))).session as Json
  const callsById = (session: Json): Map<string, Json[]> => new Map((session.messages as Json[]).filter((m) => m.role === 'assistant').map((m) => [str(m.message_id), (m.tool_calls as Json[] | undefined) ?? []]))
  const outcomes = (calls: Json[] | undefined) => (calls ?? []).map((c) => ({ id: c.id, name: (c.function as Json).name, done: c.done, is_error: c.is_error, duration: c.duration, result: c.result }))

  it('ships done, is_error, duration and result on every call in every persisted shape, the same in every window', async () => {
    const sid = await seeded()
    try {
      const full = await detail(sid)
      const calls = callsById(full)
      expect(outcomes(calls.get('tool-openai-calls'))).toEqual([
        { id: 'call-read', name: 'read_file', done: true, is_error: false, duration: 1.25, result: 'A contents' },
        { id: 'call-exit', name: 'terminal', done: true, is_error: true, duration: 3.5, result: '{"exit_code": 2, "output": "1 failed"}' },
      ])
      // The Anthropic call joins tool_calls in the OpenAI shape; its content blocks stay as written. It predates durations.
      expect(outcomes(calls.get('tool-anthropic-calls'))).toEqual([{ id: 'toolu-search', name: 'search_files', done: true, is_error: true, duration: null, result: '{"error": "permission denied"}' }])
      expect((full.messages as Json[]).find((m) => m.message_id === 'tool-anthropic-calls')?.content).toMatchObject(transcript[6]?.content as Json[])
      // A call only the session-level list recorded joins its owning assistant row.
      expect(outcomes(calls.get('tool-session-calls'))).toEqual([{ id: 'call-date', name: 'terminal', done: true, is_error: false, duration: 0.42, result: 'Sat Sep 27' }])
      // The running turn's unanswered call is not done.
      expect(outcomes(calls.get('tool-live-calls'))).toEqual([{ id: 'call-build', name: 'terminal', done: false, is_error: false, duration: null, result: null }])
      // Answers carry no tool calls.
      expect(calls.get('tool-openai-answer')).toEqual([])
      // Each completed turn's scene shows the same outcomes.
      const sceneTools = (id: string) => (((full.messages as Json[]).find((m) => m.message_id === id)?._anchor_activity_scene as Json).activity_rows as Json[]).filter((r) => r.role === 'tool').map((r) => { const t = r.tool as Json; return [t.id, t.done, t.is_error, t.duration] })
      expect(sceneTools('tool-openai-answer')).toEqual([['call-read', true, false, 1.25], ['call-exit', true, true, 3.5]])
      expect(sceneTools('tool-anthropic-answer')).toEqual([['toolu-search', true, true, null]])
      expect(sceneTools('tool-session-answer')).toEqual([['call-date', true, false, 0.42]])
      // Every window resolves the same values as the full detail.
      for (const query of ['&msg_limit=2', '&msg_limit=3&msg_before=8', '&msg_limit=1&msg_before=2', '&msg_limit=2&msg_before=11']) {
        const window = callsById(await detail(sid, query))
        expect(window.size).toBeGreaterThan(0)
        for (const [id, windowCalls] of window) expect(windowCalls, `${query} ${id}`).toEqual(calls.get(id))
      }
      // The projection writes nothing back: stored rows keep their persisted shape.
      const stored = JSON.parse(readFileSync(s.deps.sessionStore.pathFor(sid), 'utf8')) as Json
      expect(stored.messages).toEqual(transcript)
      expect(stored.tool_calls).toEqual(sessionToolCalls)
    } finally {
      s.deps.registry.liveIds.delete(RUN)
    }
  })

  it('matches the shared contract fixture', async () => {
    const sid = await seeded()
    try {
      const full = await detail(sid)
      const fixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/web-session.json'), 'utf8')) as Json).tool_outcomes_session as Json
      const actual = Object.fromEntries(Object.keys(fixture).map((key) => [key, full[key]]))
      expect({ ...actual, session_id: fixture.session_id }).toEqual(fixture)
    } finally {
      s.deps.registry.liveIds.delete(RUN)
    }
  })
})
