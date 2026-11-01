/**
 * TAL-48: per-person session ownership on one shared server. Two people sign in with synthetic validated OIDC
 * identities against one disposable server; each sees only their own sessions, an unowned (legacy) session reaches
 * only an owner, and nothing a client sends can name a different person.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

const ISSUER = 'https://identity.invalid'
const OIDC_ENV = { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins' }

interface Client { headers: Record<string, string>; cookie: string }
interface AuthStatusBody { person_isolation?: { version: number; enabled: boolean }; person?: { id: string; display_name: string } | null }

let s: TestServer | null = null
afterEach(async () => { await s?.close(); s = null })

async function boot(isolation: boolean): Promise<TestServer> {
  s = await bootTestServer({
    env: { ...OIDC_ENV, ...(isolation ? { HERMES_WEBUI_PERSON_ISOLATION: '1' } : {}) },
    // The identity provider's proof is the boundary; the gate, owner policy and session access stay real.
    deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) },
  })
  return s
}

/** A validated OIDC login for `subject`, as the callback records it; `owner` matched the owner policy. */
function signIn(server: TestServer, subject: string, owner = false): Client {
  const cookie = server.deps.auth.createSession({ authType: 'oidc', username: `${subject}@example.invalid`, oidcBinding: { issuer: ISSUER, subject, ...(owner ? { owner: true } : {}) } })
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
