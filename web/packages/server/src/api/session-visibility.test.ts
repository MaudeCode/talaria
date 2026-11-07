/**
 * Request-profile session visibility across the whole API surface: the active
 * profile is bound per request (cookie / trusted-session binding), and any
 * request-supplied top-level `session_id` outside the request's profile answers
 * 404 before the handler runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BootstrapSchema } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { Session, type Message, type SessionInit } from '../sessions/session.js'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'

interface Identity { headers: Record<string, string>; csrf: string }

async function login(s: TestServer, user: string, groups: string): Promise<Identity> {
  const res = await s.get('/api/auth/status', { headers: { 'X-Remote-User': user, 'X-Remote-Groups': groups } })
  const cookie = cookieHeader(res.headers.getSetCookie(), 'hermes_session')
  if (!cookie) throw new Error('no trusted session cookie')
  const headers = { cookie, 'X-Remote-User': user, 'X-Remote-Groups': groups, origin: s.base }
  const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers })).json())
  return { headers: { ...headers, 'X-Hermes-CSRF-Token': boot.csrf_token }, csrf: boot.csrf_token }
}

const post = (s: TestServer, id: Identity, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { ...id.headers, 'content-type': 'application/json' } })

describe('request-profile session visibility', () => {
  let s: TestServer
  let root: Identity
  let work: Identity
  let sid = ''
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
    root = await login(s, 'lee', 'dev')
    work = await login(s, 'kim', 'ops')
    const created = await post(s, root, '/api/session/new', {})
    expect(created.status).toBe(200)
    sid = ((await created.json()) as { session: { session_id: string } }).session.session_id
  })
  afterAll(() => s.close())

  it('activeProfile() follows the request binding, so the list and the detail load are profile-scoped', async () => {
    const workList = (await (await s.get('/api/sessions', { headers: work.headers })).json()) as { active_profile: string; sessions: { session_id: string }[] }
    expect(workList.active_profile).toBe('work')
    expect(workList.sessions.map((r) => r.session_id)).not.toContain(sid)
    const rootList = (await (await s.get('/api/sessions', { headers: root.headers })).json()) as { active_profile: string }
    expect(rootList.active_profile).toBe('default')
    // Outside a request the process default answers.
    expect(s.deps.activeProfile()).toBe('default')
    // Detail load is exempt from the generic guard and reports the mismatch itself (frontend switches profile).
    // A legacy session saved without a profile counts as root and answers a plain 404 elsewhere.
    const legacy = (await s.deps.sessionStore.get(sid))
    legacy.profile = null
    await s.deps.sessionStore.save(legacy)
    expect((await s.get(`/api/session?session_id=${sid}`, { headers: root.headers })).status).toBe(200)
    expect((await s.get(`/api/session?session_id=${sid}`, { headers: work.headers })).status).toBe(404)
    // A session that names its profile answers 409 so the frontend can offer to switch (Python detail-load behaviour).
    const tagged = (await s.deps.sessionStore.get(sid))
    tagged.profile = 'default'
    await s.deps.sessionStore.save(tagged)
    const mismatch = await s.get(`/api/session?session_id=${sid}`, { headers: work.headers })
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toMatchObject({ code: 'session_profile_mismatch', profile: 'default' })
  })

  it('assistant_name names the agent: the bot_name setting for the root profile, a named profile its own name', async () => {
    const detailName = async (id: Identity, sessionId: string): Promise<unknown> => ((await (await s.get(`/api/session?session_id=${sessionId}`, { headers: id.headers })).json()) as { session: { assistant_name?: string } }).session.assistant_name
    const bootName = async (id: Identity): Promise<string> => BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers: id.headers })).json()).assistant_name
    const workCreated = await post(s, work, '/api/session/new', { profile: 'work' })
    const workSid = ((await workCreated.json()) as { session: { session_id: string } }).session.session_id
    expect(await detailName(root, sid)).toBe('Hermes')
    expect(await bootName(root)).toBe('Hermes')
    expect(await detailName(work, workSid)).toBe('Work')
    expect(await bootName(work)).toBe('Work')
    await s.deps.settings.save({ bot_name: 'Maude' })
    expect(await detailName(root, sid)).toBe('Maude')
    expect(await bootName(root)).toBe('Maude')
    expect(await detailName(work, workSid)).toBe('Work')
    // A mutation reply carries it too, so a client that caches the reply keeps the name.
    const renamed = (await (await post(s, work, '/api/session/rename', { session_id: workSid, title: 'named' })).json()) as { session: { assistant_name?: string } }
    expect(renamed.session.assistant_name).toBe('Work')
    await s.deps.settings.save({ bot_name: '' })
    expect(await detailName(root, sid)).toBe('Hermes')
    expect(await bootName(root)).toBe('Hermes')
    await s.deps.settings.save({ bot_name: 'Hermes' })
  })

  it('a body session_id outside the request profile answers 404 on every contract route', async () => {
    for (const [path, body] of [
      ['/api/reasoning', { session_id: sid, effort: 'high' }],
      ['/api/reasoning', { session_id: sid, effort: '' }],
      ['/api/session/rename', { session_id: sid, title: 'x' }],
      ['/api/terminal/start', { session_id: sid }],
      ['/api/terminal/exec', { session_id: sid, mode: 'owner_command', target_key: 'foreign', command: 'pwd' }],
      ['/api/session/worktree/remove', { session_id: sid }],
      ['/api/chat/steer', { session_id: sid, message: 'hi' }],
    ] as const) {
      const res = await post(s, work, path, body)
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toEqual({ error: 'Session not found' })
    }
    const own = await post(s, root, '/api/session/rename', { session_id: sid, title: 'renamed' })
    expect(own.status).toBe(200)
    // A padded id is what a trimming handler would act on: it is checked as such, never waved through as "unsafe".
    for (const [path, body] of [
      ['/api/session/yolo', { session_id: ` ${sid}`, enabled: true }],
      ['/api/terminal/start', { session_id: `${sid} ` }],
      ['/api/session/worktree/remove', { session_id: ` ${sid} ` }],
    ] as const) {
      const res = await post(s, work, path, body)
      expect(res.status, path).toBe(404)
    }
    expect((await s.get(`/api/terminal/output?session_id=${encodeURIComponent(` ${sid}`)}`, { headers: work.headers })).status).toBe(404)
    expect((await post(s, work, '/api/session/rename', { session_id: 'not a session id', title: 'x' })).status).toBe(404)
  })

  it('a query session_id outside the request profile answers 404 before dispatch', async () => {
    expect((await s.get(`/api/git/status?session_id=${sid}`, { headers: work.headers })).status).toBe(404)
    expect((await s.get(`/api/session/draft?session_id=${sid}`, { headers: work.headers })).status).toBe(404)
    expect((await s.get(`/api/session/draft?session_id=${sid}`, { headers: root.headers })).status).toBe(200)
    // TAL-372: another profile never sees a session's background work or its results.
    expect((await s.get(`/api/background/tasks?session_id=${sid}`, { headers: work.headers })).status).toBe(404)
    expect((await s.get(`/api/background/result?session_id=${sid}&task_id=t1`, { headers: work.headers })).status).toBe(404)
    expect((await post(s, work, '/api/background/dismiss', { session_id: sid, task_id: 't1' })).status).toBe(404)
    expect((await post(s, work, '/api/background/stop', { session_id: sid, task_id: 't1' })).status).toBe(404)
    expect((await s.get(`/api/background/tasks?session_id=${sid}`, { headers: root.headers })).status).toBe(200)
  })

  it('a finished run replays from the journal only to the owning profile', async () => {
    const w = (await s.deps.journal.writer(sid, 'run1234abcd'))
    await w.appendSseEvent('token', { text: 'hi' })
    await w.appendSseEvent('done', { session_id: sid })
    await w.close()
    expect((await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: work.headers })).status).toBe(404)
    expect((await s.get('/api/chat/stream/status?stream_id=run1234abcd', { headers: work.headers })).status).toBe(404)
    expect((await post(s, work, '/api/chat/cancel', { stream_id: 'run1234abcd' })).status).toBe(404)
    const own = await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: root.headers })
    expect(own.status).toBe(200)
    expect(await own.text()).toContain('event: done')
    expect(((await (await s.get('/api/chat/stream/status?stream_id=run1234abcd', { headers: root.headers })).json()) as { replay_available: boolean }).replay_available).toBe(true)
    const resumed = await s.deps.journal.writer(sid, 'run1234abcd')
    await resumed.appendSseEvent('title', { title: 'Fresh title' })
    await resumed.appendSseEvent('stream_end', {})
    await resumed.close()
    const replay = await s.get('/api/chat/stream?stream_id=run1234abcd&after_seq=2', { headers: root.headers })
    expect(await replay.text()).toContain('Fresh title')
    expect((await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: work.headers })).status).toBe(404)
    // A warm run-owner lookup must still check the session's current profile.
    const session = await s.deps.sessionStore.get(sid)
    session.profile = 'work'
    await s.deps.sessionStore.save(session)
    expect((await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: root.headers })).status).toBe(404)
    expect((await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: work.headers })).status).toBe(200)
  })
})

/** TAL-1948: an ultimately refused request leaves the other profile's document and the resident cache exactly as they were. */
describe.each(['json', 'sqlite'])('a refused session request on %s storage', (backend) => {
  const sidecar = new FakeSidecar()
  const partial: Message = { role: 'assistant', content: 'unfinished', _partial: true, timestamp: 2 }
  const repairable: Message[] = [{ role: 'user', content: 'question', timestamp: 1 }, partial, { ...partial }]
  const defaults = { workspace: '/synthetic', model: null, modelProvider: null }
  let s: TestServer
  let root: Identity
  let work: Identity
  let seeded = 0

  beforeAll(async () => {
    s = await bootTestServer({ sidecar, env: { TALARIA_STORAGE: backend, HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
    root = await login(s, 'lee', 'dev')
    work = await login(s, 'kim', 'ops')
  })
  afterAll(() => s.close())
  afterEach(() => { vi.restoreAllMocks() })

  const store = () => s.deps.sessionStore
  const sessions = () => store().deps.storage.sessions

  /** Commit a document straight to storage, as another process would: no resident session and no local revision. */
  async function commit(sid: string, init: SessionInit): Promise<void> {
    const { messages, ...doc } = new Session({ session_id: sid, ...init }, defaults).toDocument()
    const rows = messages as Message[]
    await sessions().write(sid, { doc, messages: { kind: 'replace', rows }, all: rows }, await sessions().revision(sid))
  }
  async function seed(init: SessionInit = {}): Promise<string> {
    const sid = `refusal${String(++seeded)}`
    await commit(sid, { profile: 'work', messages: repairable, ...init })
    return sid
  }
  /** The document kept in storage with its duplicate rows, resident under the same revision. */
  async function resident(sid: string): Promise<Session> {
    const session = (await store().load(sid, { repairDuplicates: false }))!
    await store().touch(session)
    return session
  }
  const state = async (sid: string) => {
    const stored = await sessions().readDocument(sid)
    return { revision: await sessions().revision(sid), profile: stored?.doc.profile, rows: stored?.messages, cache: [...store().sessions.keys()], resident: store().sessions.get(sid) }
  }
  /** Runs `act`, then proves it wrote nothing and left the stored rows, revision and the cache's membership and order alone. */
  async function untouched<T>(sid: string, act: () => Promise<T>): Promise<T> {
    const before = await state(sid)
    const writes = vi.spyOn(sessions(), 'write')
    const result = await act()
    expect(writes).not.toHaveBeenCalled()
    writes.mockRestore()
    const after = await state(sid)
    expect(after).toEqual(before)
    expect(after.resident).toBe(before.resident)
    return result
  }
  const detail = (id: Identity, sid: string, metadataOnly = false): Promise<Response> => s.get(`/api/session?session_id=${sid}${metadataOnly ? '&messages=0' : ''}`, { headers: id.headers })
  /** Every shared-gate surface and both detail modes, answering as the profile's refusal contract says. */
  async function refuseEverywhere(sid: string, id: Identity = root, detailStatus = 409): Promise<void> {
    await untouched(sid, async () => {
      expect((await detail(id, sid)).status).toBe(detailStatus)
      expect((await detail(id, sid, true)).status).toBe(detailStatus)
      expect((await s.get(`/api/session/draft?session_id=${sid}`, { headers: id.headers })).status).toBe(404)
      expect((await post(s, id, '/api/session/rename', { session_id: sid, title: 'x' })).status).toBe(404)
      expect((await post(s, id, '/api/chat/start', { session_id: sid, message: 'hi' })).status).toBe(404)
      // Ids no request guard sees: an upload's form field and a source reference.
      const form = new FormData()
      form.set('session_id', sid)
      form.set('file', new Blob(['synthetic']), 'note.txt')
      expect((await s.get('/api/upload', { method: 'POST', body: form, headers: id.headers })).status).toBe(404)
      const profile = id === work ? 'work' : 'default'
      expect((await post(s, id, '/api/session/new', { profile, request_id: `refused-${sid}`, source_references: [{ session_id: sid, tip_session_id: sid, profile }] })).status).toBe(409)
    })
  }
  /** A metadata read as a backend without a usable header answers it. */
  const metadataRead = (mode: 'legacy' | 'unreadable' | 'without its late profile'): void => {
    const read = sessions().readDocument.bind(sessions())
    vi.spyOn(sessions(), 'readDocument').mockImplementation(async (sid, opts) => {
      if (opts?.metadataOnly && mode === 'unreadable') throw new SyntaxError('synthetic unreadable header')
      const stored = await read(sid)
      if (!stored || !opts?.metadataOnly || mode === 'legacy') return stored
      const { profile: _late, ...doc } = stored.doc
      return { ...stored, doc, messages: [], metadataOnly: true }
    })
  }

  it('refuses a cold document with a modern header before repairing or caching it', async () => {
    await refuseEverywhere(await seed())
  })

  it.each(['legacy', 'unreadable', 'without its late profile'] as const)('refuses a cold document whose metadata read is %s, which falls back to a full read', async (mode) => {
    const sid = await seed()
    metadataRead(mode)
    await refuseEverywhere(sid)
  })

  it('refuses a legacy document without a profile from another profile with a plain 404', async () => {
    await refuseEverywhere(await seed({ profile: null }), work, 404)
  })

  it('refuses a warm foreign session without promoting it', async () => {
    const sid = await seed()
    await resident(sid)
    await store().touch(new Session({ session_id: `${sid}newer`, profile: 'default' }, defaults))
    await refuseEverywhere(sid)
  })

  it('refuses when storage moved a resident session to another profile, whichever read serves the request', async () => {
    const sid = await seed({ profile: 'default', messages: [{ role: 'user', content: 'question', timestamp: 1 }] })
    await resident(sid)
    await commit(sid, { profile: 'work', messages: repairable })
    await refuseEverywhere(sid)
  })

  it('refuses a resident session of another profile when storage names this one, until a full read serves it', async () => {
    const sid = await seed({ messages: [{ role: 'user', content: 'question', timestamp: 1 }] })
    await resident(sid)
    await commit(sid, { profile: 'default', messages: [{ role: 'user', content: 'question', timestamp: 1 }, { role: 'assistant', content: 'answer', timestamp: 2 }] })
    await untouched(sid, async () => {
      expect(await s.deps.sessions.sessionIdVisible(sid)).toBe(false)
      expect((await detail(root, sid, true)).status).toBe(409)
    })
    // A full read serves the document, not the stale resident: its answer stays what the loader finds.
    expect((await detail(root, sid)).status).toBe(200)
    expect(store().sessions.get(sid)?.profile).toBe('default')
  })

  it('reads an id whose stored identity is malformed or unreadable as no document, and never repairs it', async () => {
    const malformed = await seed()
    const read = sessions().readDocument.bind(sessions())
    const answer = vi.spyOn(sessions(), 'readDocument').mockImplementation(async (sid, opts) => {
      const stored = await read(sid, opts)
      return sid === malformed && stored ? { ...stored, doc: { ...stored.doc, session_id: 'someone-else' } } : stored
    })
    await untouched(malformed, async () => {
      expect(await s.deps.sessions.sessionIdVisible(malformed)).toBe(true)
      expect((await detail(root, malformed)).status).toBe(404)
    })
    answer.mockRestore()
    const unreadable = await seed()
    const writes = vi.spyOn(sessions(), 'write')
    vi.spyOn(sessions(), 'readDocument').mockRejectedValue(new SyntaxError('synthetic corrupt document'))
    expect(await s.deps.sessions.sessionIdVisible(unreadable)).toBe(true)
    expect((await detail(root, unreadable)).status).toBe(404)
    expect(writes).not.toHaveBeenCalled()
    expect(store().sessions.has(unreadable)).toBe(false)
  })

  it('still repairs and caches a document for its own profile', async () => {
    const sid = await seed({ profile: 'default' })
    expect(await s.deps.sessions.sessionIdVisible(sid)).toBe(true)
    expect((await detail(root, sid)).status).toBe(200)
    expect((await sessions().readDocument(sid))?.messages).toHaveLength(2)
    expect(store().sessions.has(sid)).toBe(true)
    const mismatch = await seed()
    expect(await (await detail(root, mismatch)).json()).toMatchObject({ code: 'session_profile_mismatch', session_id: mismatch, profile: 'work' })
  })

  it('admits chat only for an empty placeholder the request retags, and starts no turn otherwise', async () => {
    const started = (): number => sidecar.calls.filter((call) => call.method === 'chat.start').length
    const before = started()
    for (const init of [{ messages: repairable }, { messages: [], context_messages: [{ role: 'user', content: 'kept', timestamp: 1 }] }, { messages: [], pending_user_message: 'queued' }]) {
      const sid = await seed(init)
      await untouched(sid, async () => {
        expect((await post(s, root, '/api/chat/start', { session_id: sid, message: 'hi', profile: 'default' })).status).toBe(404)
      })
    }
    const placeholder = await seed({ messages: [] })
    await untouched(placeholder, async () => {
      expect((await post(s, root, '/api/chat/start', { session_id: placeholder, message: 'hi' })).status).toBe(404)
    })
    expect(started()).toBe(before)
    expect(s.deps.registry.activeRuns.size).toBe(0)
    sidecar.respond('chat.start', () => new Promise(() => undefined))
    const admitted = await post(s, root, '/api/chat/start', { session_id: placeholder, message: 'hi', profile: 'default' })
    expect(admitted.status).toBe(200)
    expect(store().sessions.get(placeholder)?.profile).toBe('default')
    expect(((await admitted.json()) as { stream_id?: string }).stream_id).toBeTruthy()
  })
})
