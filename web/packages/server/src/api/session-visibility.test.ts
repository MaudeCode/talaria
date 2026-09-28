/**
 * Request-profile session visibility across the whole API surface: the active
 * profile is bound per request (cookie / trusted-session binding), and any
 * request-supplied top-level `session_id` outside the request's profile answers
 * 404 before the handler runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootstrapSchema } from '@maudecode/talaria-web-contracts'
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
    expect((await s.get(`/api/session?session_id=${sid}`, { headers: root.headers })).status).toBe(200)
    expect((await s.get(`/api/session?session_id=${sid}`, { headers: work.headers })).status).toBe(404)
    // A session that names its profile answers 409 so the frontend can offer to switch (Python detail-load behaviour).
    const tagged = s.deps.sessionStore.get(sid)
    tagged.profile = 'default'
    s.deps.sessionStore.save(tagged)
    const mismatch = await s.get(`/api/session?session_id=${sid}`, { headers: work.headers })
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toMatchObject({ code: 'session_profile_mismatch', profile: 'default' })
  })

  it('a body session_id outside the request profile answers 404 on every contract route', async () => {
    for (const [path, body] of [
      ['/api/session/rename', { session_id: sid, title: 'x' }],
      ['/api/terminal/start', { session_id: sid }],
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
  })

  it('a finished run replays from the journal only to the owning profile', async () => {
    const w = s.deps.journal.writer(sid, 'run1234abcd')
    w.appendSseEvent('token', { text: 'hi' })
    w.appendSseEvent('done', { session_id: sid })
    w.close()
    expect((await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: work.headers })).status).toBe(404)
    expect((await s.get('/api/chat/stream/status?stream_id=run1234abcd', { headers: work.headers })).status).toBe(404)
    expect((await post(s, work, '/api/chat/cancel', { stream_id: 'run1234abcd' })).status).toBe(404)
    const own = await s.get('/api/chat/stream?stream_id=run1234abcd', { headers: root.headers })
    expect(own.status).toBe(200)
    expect(await own.text()).toContain('event: done')
    expect(((await (await s.get('/api/chat/stream/status?stream_id=run1234abcd', { headers: root.headers })).json()) as { replay_available: boolean }).replay_available).toBe(true)
  })
})
