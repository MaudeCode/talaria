/**
 * TAL-48: per-person session ownership on one shared server. Two people sign in with synthetic validated OIDC
 * identities against one disposable server; each sees only their own sessions, an unowned (legacy) session reaches
 * only an owner, and nothing a client sends can name a different person.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type SseFrame, type TestServer } from '../test/harness.js'

const ISSUER = 'https://identity.invalid'
const OIDC_ENV = { TALARIA_WEB_OIDC_ISSUER: ISSUER, TALARIA_WEB_OIDC_CLIENT_ID: 'synthetic-client', TALARIA_WEB_OIDC_ALLOW_CLAIM: 'email_verified', TALARIA_WEB_OIDC_ALLOW_VALUES: 'true', TALARIA_WEB_OIDC_OWNER_CLAIM: 'groups', TALARIA_WEB_OIDC_OWNER_VALUES: 'admins' }

interface Client { headers: Record<string, string>; cookie: string }
interface AuthStatusBody { person_isolation?: { version: number; enabled: boolean }; person?: { id: string; display_name: string } | null }

let s: TestServer | null = null
afterEach(async () => { await s?.close(); s = null })

async function boot(isolation: boolean, sidecar?: FakeSidecar): Promise<TestServer> {
  s = await bootTestServer({
    ...(sidecar ? { sidecar } : {}),
    env: { ...OIDC_ENV, ...(isolation ? { TALARIA_WEB_PERSON_ISOLATION: '1' } : {}) },
    // The identity provider's proof is the boundary; the gate, owner policy and session access stay real.
    deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) },
  })
  return s
}

/** A validated OIDC login for `subject`, as the callback records it; `owner` matched the owner policy. */
function signIn(server: TestServer, subject: string, owner = false): Client {
  return clientFor(server, server.deps.auth.createSession({ authType: 'oidc', username: `${subject}@example.invalid`, oidcBinding: { issuer: ISSUER, subject, ...(owner ? { owner: true } : {}) } }))
}

/** A password login bound to `profile`, as a profile-bound user gets. */
function boundLogin(server: TestServer, profile: string): Client {
  return clientFor(server, server.deps.auth.createSession({ authType: 'password', boundProfile: profile }))
}

/** The request headers of an existing login's cookie. */
function clientFor(server: TestServer, cookie: string): Client {
  return { cookie, headers: { cookie: `${server.deps.auth.cookieName()}=${cookie}`, origin: server.base, 'X-Hermes-CSRF-Token': server.deps.auth.csrfTokenForSession(cookie)!, 'content-type': 'application/json' } }
}

const post = (server: TestServer, client: Client, path: string, body: unknown): Promise<Response> => server.get(path, { method: 'POST', headers: client.headers, body: JSON.stringify(body) })

/** A chat with one turn, so the sidebar lists it. */
async function chat(server: TestServer, client: Client, body: Record<string, unknown> = {}): Promise<string> {
  const created = await post(server, client, '/api/session/new', body)
  expect(created.status).toBe(200)
  const sid = ((await created.json()) as { session: { session_id: string } }).session.session_id
  await withTurn(server, sid)
  return sid
}

async function withTurn(server: TestServer, sid: string): Promise<void> {
  const session = await server.deps.sessionStore.get(sid)
  session.messages.push({ role: 'user', content: `hello from ${sid}`, timestamp: Date.now() / 1000 })
  await server.deps.sessionStore.save(session)
}

async function listed(server: TestServer, client: Client): Promise<string[]> {
  const response = await server.get('/api/sessions', { headers: client.headers })
  expect(response.status).toBe(200)
  return ((await response.json()) as { sessions: { session_id: string }[] }).sessions.map((row) => row.session_id)
}

async function status(server: TestServer, client: Client): Promise<AuthStatusBody> {
  return (await (await server.get('/api/auth/status', { headers: client.headers })).json()) as AuthStatusBody
}

describe('workspace authority from the request', () => {
  it.each([false, true])('passes restricted authority with person isolation %s', async (isolation) => {
    const server = await boot(isolation)
    const client = signIn(server, 'alice')
    const sid = await chat(server, client)
    const lookup = vi.spyOn(server.deps.workspaces, 'resolveTrusted')
    const add = vi.spyOn(server.deps.workspaces, 'validateToAdd')
    const workspace = server.deps.config.defaultWorkspace
    const created = await post(server, client, '/api/projects/create', { name: 'Project' })
    expect(created.status).toBe(200)
    const { project } = await created.json() as { project: { project_id: string } }

    for (const [route, body] of [
      ['/api/session/new', { workspace }],
      ['/api/session/update', { session_id: sid, workspace }],
      ['/api/projects/bind', { project_id: project.project_id, workspaces: [workspace] }],
    ] as const) {
      lookup.mockClear()
      expect((await post(server, client, route, body)).status, route).toBe(200)
      expect(lookup.mock.calls.some(([path, , serverOwner]) => path === workspace && !serverOwner), route).toBe(true)
    }
    await post(server, client, '/api/workspaces/add', { path: workspace })
    expect(add.mock.calls.some(([path, , serverOwner]) => path === workspace && !serverOwner)).toBe(true)
  })

  it.each(['safe', 'ignore_config'])('passes restricted authority for %s diagnostic creation', async (mode) => {
    const server = await boot(true)
    const client = signIn(server, 'alice')
    const workspace = server.deps.config.defaultWorkspace
    const resolve = vi.spyOn(server.deps.workspaces, 'resolveTrusted')
    await post(server, client, '/api/session/new', { execution_mode: mode, workspace })
    expect(resolve).toHaveBeenCalledWith(workspace, 'default', false)
  })

  it('passes restricted authority to native workspace mutations', async () => {
    const server = await boot(true)
    const client = signIn(server, 'alice')
    const sid = await chat(server, client)
    const owner = server.deps.sessions.owner!
    const action = vi.spyOn(owner, 'action').mockRejectedValue(new Error('Synthetic native owner refusal'))
    const body = { session_id: sid, action: 'mutate', request_id: 'workspace-change', expected_revision: 0, execution_generation: 0, operation: 'workspace', payload: { cwd: server.workspace } }
    await post(server, client, '/api/chat/owner-action', body)
    expect(action).toHaveBeenCalledWith(sid, expect.objectContaining(body), false)
  })

  it.each([false, true])('records server-owner authority (%s) at ordinary chat admission', async (serverOwner) => {
    const server = await boot(true, new FakeSidecar())
    const client = signIn(server, 'alice', serverOwner)
    const sid = await chat(server, client)
    const start = vi.spyOn(server.deps.turns, 'start').mockRejectedValue(new Error('Synthetic turn refusal'))
    await post(server, client, '/api/chat/start', { session_id: sid, message: 'Synthetic prompt' })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ session_id: sid }), expect.objectContaining({ workspaceServerOwner: serverOwner }))
  })

  it('uses the last authorized workspace for an implicit new session', async () => {
    const server = await boot(true)
    const client = signIn(server, 'alice')
    const last = join(server.deps.config.defaultWorkspace, 'last-selected')
    mkdirSync(last)
    await server.deps.workspaces.setLastWorkspace(last, 'default')
    const response = await post(server, client, '/api/session/new', {})
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ session: { workspace: last } })
  })

  it('refuses protected file targets even when the workspace is trusted', async () => {
    const server = await boot(false)
    const owner = signIn(server, 'olive', true)
    const workspace = dirname(server.state)
    server.deps.workspaces.deps.defaultWorkspace = () => workspace
    const sid = await chat(server, owner, { workspace })
    const query = new URLSearchParams({ session_id: sid, path: 'state' })
    for (const route of ['/api/file', '/api/file/raw', '/api/folder/download', '/api/list']) {
      expect((await server.get(`${route}?${query.toString()}`, { headers: owner.headers })).status, route).toBe(403)
    }
  })

  it('refuses workspace Git to a caller who may not work in the shared session\'s workspace (TAL-2646)', async () => {
    const server = await boot(false)
    const owner = signIn(server, 'olive', true)
    const workspace = dirname(server.state)
    server.deps.workspaces.deps.defaultWorkspace = () => workspace
    const sid = await chat(server, owner, { workspace })
    const bound = boundLogin(server, 'default')
    for (const route of ['/api/git/status?scope=branch', '/api/git/diff?scope=branch&path=a.txt', '/api/git/branches', '/api/git-info']) {
      const url = `${route}${route.includes('?') ? '&' : '?'}session_id=${sid}`
      expect((await server.get(url, { headers: bound.headers })).status, route).toBe(403)
    }
    expect((await server.get(`/api/git/status?scope=branch&session_id=${sid}`, { headers: owner.headers })).status).toBe(200)
  })

})

describe('media reach from the request (TAL-2205)', () => {
  it.each([['a non-owner person', true], ['a profile-bound login', false]] as const)('serves %s its own session\'s attachments only', async (_name, isolation) => {
    const server = await boot(isolation)
    const caller = isolation ? signIn(server, 'alice') : clientFor(server, server.deps.auth.createSession({ authType: 'password', username: 'scoped-user', boundProfile: 'default' }))
    const owner = signIn(server, 'olive', true)
    const own = await chat(server, caller)
    const other = await chat(server, owner)
    const file = (path: string): string => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'synthetic-bytes')
      return path
    }
    const mine = file(join(server.deps.uploads.sessionDir(own), 'mine.png'))
    const theirs = file(join(server.deps.uploads.sessionDir(other), 'theirs.png'))
    const profile = file(join(server.deps.config.hermesHome, 'profiles', 'other', 'profile.png'))
    const media = async (client: Client, path: string, sid: string): Promise<number> => (await server.get(`/api/media?${new URLSearchParams({ path, session_id: sid }).toString()}`, { headers: client.headers })).status
    expect(await media(caller, mine, own)).toBe(200)
    for (const path of [theirs, profile]) expect(await media(caller, path, own), path).toBe(403)
    for (const path of [mine, theirs, profile]) expect(await media(owner, path, other), path).toBe(200)
  })
})

describe('person isolation on', () => {
  it('lists, opens, streams and changes only the requesting person\'s sessions', async () => {
    const server = await boot(true)
    // Created outside any request, as sessions from before isolation or from the Agent are: no person owns it.
    const legacy = await server.deps.sessionStore.newSession({})
    await withTurn(server, legacy.session_id)
    const alice = signIn(server, 'alice')
    const bob = signIn(server, 'bob')
    const owner = signIn(server, 'olive', true)
    const aliceChat = await chat(server, alice)
    const bobChat = await chat(server, bob)

    expect(await listed(server, alice)).toEqual([aliceChat])
    expect(await listed(server, bob)).toEqual([bobChat])
    // Owner authority reaches unowned sessions only, never a person's.
    expect(await listed(server, owner)).toEqual([legacy.session_id])

    // Another person's session is not found: no profile hint, no export, no stream, no change, no deletion.
    for (const path of [`/api/session?session_id=${aliceChat}`, `/api/session/export?session_id=${aliceChat}`, `/api/session/stream?session_id=${aliceChat}`]) {
      expect((await server.get(path, { headers: bob.headers })).status, path).toBe(404)
    }
    expect((await post(server, bob, '/api/session/rename', { session_id: aliceChat, title: 'taken' })).status).toBe(404)
    expect((await post(server, bob, '/api/session/delete', { session_id: aliceChat })).status).toBe(404)
    expect((await post(server, bob, '/api/session/duplicate', { session_id: aliceChat })).status).toBe(404)
    expect((await server.get(`/api/session?session_id=${legacy.session_id}`, { headers: alice.headers })).status).toBe(404)
    expect((await server.get(`/api/session?session_id=${aliceChat}`, { headers: owner.headers })).status).toBe(404)
    const own = await server.get(`/api/session?session_id=${aliceChat}`, { headers: alice.headers })
    expect(own.status).toBe(200)
    expect(((await own.json()) as { session: { title: string } }).session.title).not.toBe('taken')
    expect((await server.get(`/api/session?session_id=${legacy.session_id}`, { headers: owner.headers })).status).toBe(200)
  })

  it('refuses another person\'s stored session without repairing or caching it (TAL-1948)', async () => {
    const server = await boot(true)
    const alice = signIn(server, 'alice')
    const bob = signIn(server, 'bob')
    const sid = await chat(server, alice)
    const store = server.deps.sessionStore
    const session = await store.get(sid)
    const partial = { role: 'assistant', content: 'unfinished', _partial: true, timestamp: 2 }
    session.messages.push(partial, { ...partial })
    await store.save(session)
    store.sessions.delete(sid)
    const revision = await store.revision(sid)
    for (const path of [`/api/session?session_id=${sid}`, `/api/session?session_id=${sid}&messages=0`, `/api/session/draft?session_id=${sid}`]) {
      expect((await server.get(path, { headers: bob.headers })).status, path).toBe(404)
    }
    expect((await post(server, bob, '/api/chat/start', { session_id: sid, message: 'hi' })).status).toBe(404)
    expect(await store.revision(sid)).toBe(revision)
    expect(store.sessions.has(sid)).toBe(false)
  })

  it('replays a missed completion sound only to the person whose session finished (TAL-1954)', async () => {
    const server = await boot(true)
    const alice = signIn(server, 'alice')
    const bob = signIn(server, 'bob')
    const aliceChat = await chat(server, alice)
    // Each reads one connection through a sentinel published after `initial`, then reconnects as EventSource does.
    const connect = (client: Client, headers: Record<string, string> = {}): Promise<SseFrame[]> => server.sse('/api/sessions/events', (frame) => {
      if (frame.event === 'initial') server.deps.events.publish('sentinel')
      return (frame.data as { reason?: string }).reason === 'sentinel'
    }, { headers: { ...client.headers, ...headers } })
    const cursor = async (client: Client): Promise<Record<string, string>> => {
      const id = (await connect(client)).filter((frame) => frame.id).at(-1)?.id
      expect(id, 'the stream writes a cursor').toBeTruthy()
      return { 'last-event-id': id! }
    }
    const [aliceCursor, bobCursor] = [await cursor(alice), await cursor(bob)]
    const webAudio = (identity: string) => ({ identity, scope: 'default', profile: 'default', eligible: true, expires_at: Date.UTC(2100, 0, 1) })
    server.deps.events.publish('web_completion', { profile: 'default', sessionId: aliceChat, webAudio: webAudio('alice-run') })
    // A completion that names no session cannot prove whose it is.
    server.deps.events.publish('web_completion', { profile: 'default', webAudio: webAudio('unnamed-run') })
    const played = (frames: SseFrame[]) => frames.flatMap((frame) => ((frame.data as { web_audio?: { identity: string }[] }).web_audio ?? []).map((item) => item.identity))
    expect(played(await connect(alice, aliceCursor))).toEqual(['alice-run'])
    expect(played(await connect(bob, bobCursor))).toEqual([])
  })

  it('binds new sessions to the signed-in person, whatever the request claims', async () => {
    const server = await boot(true)
    const alice = signIn(server, 'alice')
    const bob = signIn(server, 'bob')
    const aliceStatus = await status(server, alice)
    const bobStatus = await status(server, bob)
    expect(aliceStatus.person_isolation).toEqual({ version: 1, enabled: true })
    expect(aliceStatus.person).toEqual({ id: expect.stringMatching(/^oidc:[0-9a-f]{64}$/) as string, display_name: 'alice@example.invalid' })
    expect(bobStatus.person?.id).not.toBe(aliceStatus.person?.id)

    // Alice names Bob as the owner; the server binds the chat to Alice.
    const spoofed = await chat(server, alice, { owner_person_id: bobStatus.person!.id, person_id: bobStatus.person!.id })
    expect((await server.deps.sessionStore.get(spoofed)).owner_person_id).toBe(aliceStatus.person!.id)
    expect(await listed(server, bob)).toEqual([])
    // A copy belongs to whoever made it.
    const copied = await post(server, alice, '/api/session/duplicate', { session_id: spoofed })
    expect(copied.status).toBe(200)
    const copyId = ((await copied.json()) as { session: { session_id: string } }).session.session_id
    expect((await server.deps.sessionStore.get(copyId)).owner_person_id).toBe(aliceStatus.person!.id)
  })

  it('a login with no person sees no person\'s sessions, and a revoked login sees nothing', async () => {
    const server = await boot(true)
    const alice = signIn(server, 'alice')
    const aliceChat = await chat(server, alice)
    const cookie = server.deps.auth.createSession({ authType: 'oidc', username: 'nobody' })
    const anonymous: Client = { cookie, headers: { cookie: `${server.deps.auth.cookieName()}=${cookie}`, origin: server.base } }
    expect((await status(server, anonymous)).person).toBeNull()
    expect(await listed(server, anonymous)).not.toContain(aliceChat)

    expect((await post(server, alice, '/api/auth/logout', {})).status).toBe(200)
    expect((await server.get('/api/sessions', { headers: alice.headers })).status).toBe(401)
    expect((await server.get(`/api/session?session_id=${aliceChat}`, { headers: alice.headers })).status).toBe(401)
  })
})

describe('person isolation off', () => {
  it('restricts session creation to the bound profile for non-owners', async () => {
    const sidecar = new FakeSidecar()
    const server = await boot(false, sidecar)
    const caller = boundLogin(server, 'default')
    const profile = 'work'
    mkdirSync(join(server.deps.config.hermesHome, 'profiles', profile), { recursive: true })
    const denied = await post(server, caller, '/api/session/new', { profile })
    expect(denied.status).toBe(403)
    expect(sidecar.calls.filter(({ method }) => method === 'chat.session_open')).toEqual([])
    expect((await post(server, caller, '/api/session/new', {})).status).toBe(200)
    expect(sidecar.calls.filter(({ method }) => method === 'chat.session_open')).toEqual([
      { method: 'chat.session_open', params: { session_id: expect.any(String) as string, profile_home: server.deps.profileHome('default'), reason: 'create' } },
    ])
  })

  it('keeps the shared single-user behavior and reports no person', async () => {
    const server = await boot(false)
    const alice = signIn(server, 'alice')
    const bob = signIn(server, 'bob')
    const aliceChat = await chat(server, alice)
    expect(await listed(server, bob)).toContain(aliceChat)
    expect((await server.get(`/api/session?session_id=${aliceChat}`, { headers: bob.headers })).status).toBe(200)
    expect((await server.deps.sessionStore.get(aliceChat)).owner_person_id).toBeNull()
    const body = await status(server, alice)
    expect(body.person_isolation).toEqual({ version: 1, enabled: false })
    expect(body).not.toHaveProperty('person')
  })
})

// TAL-2202: other profiles' rows and the owner's Claude Code transcripts reach only server-owner authority.
describe('owner-only reach', () => {
  const PROFILES = ['default', 'work']
  /** A server holding one chat, project and cron job in each profile, all titled `needle`. */
  async function seeded(isolation: boolean): Promise<TestServer> {
    const sidecar = new FakeSidecar()
    const server = await boot(isolation, sidecar)
    const home = (profile: string): string => (profile === 'default' ? server.state : join(server.state, 'profiles', profile))
    for (const profile of PROFILES) mkdirSync(home(profile), { recursive: true })
    sidecar.respond('profiles.list', () => ({ profiles: PROFILES.map((name) => ({ name, path: home(name), is_default: name === 'default', gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })) as never[] }))
    sidecar.respond('cron.list', (params) => ({ jobs: PROFILES.filter((name) => home(name) === params.profile_home).map((name) => ({ id: `cron-${name}`, name: 'needle', profile: name === 'default' ? null : name, toast_notifications: true, monitor: '', continuity: false })) as never[] }))
    for (const profile of PROFILES) {
      const session = await server.deps.sessionStore.newSession({ profile })
      session.title = 'needle'
      await server.deps.sessionStore.save(session)
      await withTurn(server, session.session_id)
    }
    await server.deps.projects.save(PROFILES.map((profile) => ({ project_id: `project-${profile}`, name: 'needle', profile })))
    return server
  }

  /** Each listing's rows by profile, with its `all_profiles` and `other_profile_count`. */
  async function reach(server: TestServer, viewer: Client, flag: string): Promise<Record<string, unknown>> {
    const read = async (path: string, rows: string, profileOf: (row: Record<string, unknown>) => unknown) => {
      const response = await server.get(`${path}${flag}`, { headers: viewer.headers })
      expect(response.status, path).toBe(200)
      const body = await response.json() as Record<string, unknown>
      return { profiles: [...new Set((body[rows] as Record<string, unknown>[]).map(profileOf))].sort(), all_profiles: body.all_profiles, other_profile_count: body.other_profile_count }
    }
    return {
      sessions: await read('/api/sessions?', 'sessions', (row) => row.profile),
      search: await read('/api/sessions/search?q=needle&', 'sessions', (row) => row.profile),
      projects: await read('/api/projects?', 'projects', (row) => row.profile),
      crons: await read('/api/crons?', 'jobs', (row) => row.owner_profile),
    }
  }

  it.each([
    { viewer: 'a profile-bound login', owner: false },
    { viewer: 'the owner', owner: true },
  ])('all_profiles reaches other profiles only for $viewer', async ({ owner }) => {
    const server = await seeded(false)
    const viewer = owner ? signIn(server, 'olive', true) : boundLogin(server, 'work')
    const own = owner ? 'default' : 'work'
    // A non-owner is offered nothing beyond its profile, and its flag changes nothing.
    const listing = (profiles: string[], all: boolean, others: number | undefined) => ({ profiles, all_profiles: all, other_profile_count: others })
    const without = owner ? 1 : 0
    const flagged = owner ? listing(PROFILES, true, 0) : listing([own], false, 0)
    expect(await reach(server, viewer, 'all_profiles=1')).toEqual({ sessions: flagged, search: { ...flagged, other_profile_count: undefined }, projects: flagged, crons: flagged })
    expect(await reach(server, viewer, '')).toEqual({ sessions: listing([own], false, without), search: listing([own], false, undefined), projects: listing([own], false, without), crons: listing([own], false, without) })
  })

  // TAL-1762: the job script listing reads the caller's active profile home, as the cron list does; no input selects another.
  it.each([
    { viewer: 'a profile-bound login', owner: false },
    { viewer: 'the owner', owner: true },
  ])('the job script listing shows only the active profile to $viewer', async ({ owner }) => {
    const server = await seeded(false)
    for (const profile of PROFILES) {
      const scripts = join(profile === 'default' ? server.state : join(server.state, 'profiles', profile), 'scripts')
      mkdirSync(scripts, { recursive: true })
      writeFileSync(join(scripts, `${profile}.py`), `# ${profile} script\n`)
    }
    const viewer = owner ? signIn(server, 'olive', true) : boundLogin(server, 'work')
    const response = await server.get('/api/crons/scripts?profile=default&all_profiles=1', { headers: viewer.headers })
    expect(response.status).toBe(200)
    const own = owner ? 'default' : 'work'
    expect(((await response.json()) as { scripts: { name: string; description: string }[] }).scripts.map((row) => [row.name, row.description])).toEqual([[`${own}.py`, `${own} script`]])
  })

  it.each([
    { viewer: 'a profile-bound login', isolation: false, owner: false },
    { viewer: 'a non-owner person', isolation: true, owner: false },
    { viewer: 'the owner without person isolation', isolation: false, owner: true },
    { viewer: 'the owner with person isolation', isolation: true, owner: true },
  ])('Claude Code transcripts reach only owner authority: $viewer', async ({ isolation, owner }) => {
    const server = await boot(isolation)
    const project = join(server.state, 'claude-projects', '-repo')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'one.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'owner transcript' } }) + '\n')
    const claudeCode = async (viewer: Client): Promise<string[]> => {
      const response = await server.get('/api/sessions?show_claude_code_sessions=1', { headers: viewer.headers })
      return ((await response.json()) as { sessions: { session_id: string; source_kind: string }[] }).sessions.filter((row) => row.source_kind === 'claude_code').map((row) => row.session_id)
    }
    const [sid] = await claudeCode(signIn(server, 'olive', true))
    expect(sid).toMatch(/^claude_code_/)
    const viewer = owner ? signIn(server, 'olive', true) : isolation ? signIn(server, 'alice') : boundLogin(server, 'work')
    expect(await claudeCode(viewer)).toEqual(owner ? [sid] : [])
    // An SSE stream the viewer may open stays open, so only a refused one is read. Export serves stored chats only.
    for (const path of [`/api/session?session_id=${sid!}`, ...(owner ? [] : [`/api/session/stream?session_id=${sid!}`])]) {
      expect((await server.get(path, { headers: viewer.headers })).status, path).toBe(owner ? 200 : 404)
    }
  })
})
