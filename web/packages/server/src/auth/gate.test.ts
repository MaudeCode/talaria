import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { normalizeRequestPath } from '../http/context.js'

/**
 * TAL-2201: the owner-only surface, decided once by the auth gate. Each row is a route and method; `owner` routes answer
 * 403 Owner session required to a session without owner authority and pass the gate for an owner or with auth off.
 */
const ROUTES: { method: string; path: string; owner: boolean }[] = [
  ...['start', 'exec', 'input', 'resize', 'close'].map((name) => ({ method: 'POST', path: `/api/terminal/${name}`, owner: true })),
  { method: 'GET', path: '/api/terminal/read', owner: true },
  { method: 'GET', path: '/api/terminal/output?session_id=synthetic', owner: true },
  // Path variants reach the handler as the canonical path, so they get its decision.
  { method: 'POST', path: '/api/terminal/start/', owner: true },
  { method: 'POST', path: '//api/terminal/start', owner: true },
  { method: 'GET', path: '/api/mcp/servers', owner: false },
  { method: 'GET', path: '/api/mcp/tools', owner: false },
  { method: 'POST', path: '/api/mcp/servers', owner: true },
  ...['POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({ method, path: '/api/mcp/servers/synthetic', owner: true })),
  { method: 'PUT', path: '/api/mcp/servers/a%2Fb', owner: true },
  { method: 'DELETE', path: '/api/mcp/servers/synthetic/', owner: true },
  ...['setup', 'probe', 'complete', 'oauth/start', 'oauth/cancel'].map((name) => ({ method: 'POST', path: `/api/onboarding/${name}`, owner: true })),
  { method: 'GET', path: '/api/onboarding/oauth/poll', owner: true },
  { method: 'GET', path: '/api/onboarding/status', owner: false },
  { method: 'GET', path: '/api/providers', owner: false },
  ...['/api/providers', '/api/providers/self-hosted', '/api/providers/delete'].map((path) => ({ method: 'POST', path, owner: true })),
  { method: 'POST', path: '/api/kanban/dispatch', owner: true },
  { method: 'GET', path: '/api/dashboard/config', owner: true },
  { method: 'POST', path: '/api/dashboard/config', owner: true },
]

const OWNER_REQUIRED = { error: 'Owner session required' }

async function decision(server: TestServer, route: { method: string; path: string }, headers: Record<string, string>): Promise<'owner_required' | 'passed'> {
  const res = await server.get(route.path, { method: route.method, headers: { ...headers, 'content-type': 'application/json' }, ...(route.method === 'GET' ? {} : { body: '{}' }) })
  const text = await res.text()
  return res.status === 403 && text === JSON.stringify(OWNER_REQUIRED) ? 'owner_required' : 'passed'
}

it('reads a target with doubled or backslashed leading slashes as its path, never as a host (TAL-2201)', () => {
  // A browser cannot send a raw backslash, so the HTTP table above covers `//` only.
  expect(['//api/terminal/start', '/\\api/terminal/start', '\\/api/terminal/start/', '/api//terminal/./start'].map(normalizeRequestPath)).toEqual(Array(4).fill('/api/terminal/start'))
})

describe('owner-only routes (TAL-2201)', () => {
  let server: TestServer
  let open: TestServer
  const sidecar = new FakeSidecar()
  const sessions: Record<'bound' | 'person' | 'owner', Record<string, string>> = { bound: {}, person: {}, owner: {} }
  const issuer = 'https://identity.invalid'

  beforeAll(async () => {
    server = await bootTestServer({ sidecar, env: {
      TALARIA_WEB_TRUSTED_AUTH_HEADER: 'X-Remote-User', TALARIA_WEB_GROUP_PROFILE_MAP: '{}',
      TALARIA_WEB_OIDC_ISSUER: issuer, TALARIA_WEB_OIDC_CLIENT_ID: 'synthetic-client',
      TALARIA_WEB_OIDC_OWNER_CLAIM: 'groups', TALARIA_WEB_OIDC_OWNER_VALUES: 'admins',
    }, deps: (deps) => { deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true) } })
    open = await bootTestServer({ sidecar: new FakeSidecar() })
    const cookie = (value: string) => `${server.deps.auth.cookieName()}=${value}`
    sessions.bound = { cookie: cookie(server.deps.auth.createSession({ authType: 'trusted', username: 'scoped-user', boundProfile: 'default' })), 'X-Remote-User': 'scoped-user' }
    sessions.person = { cookie: cookie(server.deps.auth.createSession({ authType: 'oidc', username: 'alice', oidcBinding: { issuer, subject: 'alice' } })) }
    sessions.owner = { cookie: cookie(server.deps.auth.createSession({ authType: 'password' })) }
  })
  afterAll(async () => { await server.close(); await open.close() })

  it('refuses every owner route to a profile-bound and a non-owner person session, and passes the rest', async () => {
    for (const who of ['bound', 'person'] as const) {
      const got = await Promise.all(ROUTES.map(async (route) => `${route.method} ${route.path} ${await decision(server, route, sessions[who])}`))
      expect(got, who).toEqual(ROUTES.map((route) => `${route.method} ${route.path} ${route.owner ? 'owner_required' : 'passed'}`))
    }
  })

  it('passes the bound profile to the Kanban RPC and gives owner calls unrestricted scope', async () => {
    sidecar.respond('kanban.assignees', () => ({ assignees: [] }))
    const after = sidecar.calls.length
    for (const who of ['bound', 'owner'] as const) {
      const response = await server.get('/api/kanban/assignees', { headers: sessions[who] })
      expect(response.status).toBe(200)
    }
    const calls = sidecar.calls.slice(after).filter(call => call.method === 'kanban.assignees')
    expect(calls.map(call => call.params)).toEqual([
      expect.objectContaining({ allowed_assignees: ['default'] }),
      expect.objectContaining({ allowed_assignees: null }),
    ])
  })

  it('lists the terminal command for no client of a session without owner authority', async () => {
    const terminal = async (headers: Record<string, string>) => ((await (await server.get('/api/commands', { headers })).json()) as { commands: { name: string; clients: string[]; unsupported_message?: string }[] }).commands.find((c) => c.name === 'terminal')
    expect(await terminal(sessions.owner)).toMatchObject({ clients: ['web'] })
    for (const who of ['bound', 'person'] as const) expect(await terminal(sessions[who]), who).toMatchObject({ clients: [], unsupported_message: 'Only the server owner can open the terminal.' })
  })

  it('refuses a model route\'s connection fields to a session without owner authority, and keeps its model picks', async () => {
    const writes: { method: string; path: string; body: { advanced?: Record<string, unknown> } & Record<string, unknown>; owner: boolean }[] = [
      ...['base_url', 'api_key', 'api_key_clear'].flatMap((field) => [
        { method: 'POST', path: '/api/default-model', body: { model: 'synthetic', advanced: { [field]: field === 'api_key_clear' ? true : 'https://route.invalid' } }, owner: true },
        { method: 'POST', path: '/api/model/set', body: { scope: 'main', model: 'synthetic', advanced: { [field]: field === 'api_key_clear' ? true : 'https://route.invalid' } }, owner: true },
        { method: 'POST', path: '/api/model/set', body: { scope: 'auxiliary', task: 'vision', model: 'synthetic', advanced: { [field]: field === 'api_key_clear' ? true : 'https://route.invalid' } }, owner: true },
      ]),
      { method: 'POST', path: '/api/default-model', body: { model: 'synthetic', advanced: { service_tier: 'priority' } }, owner: false },
      { method: 'POST', path: '/api/model/set', body: { scope: 'main', model: 'synthetic' }, owner: false },
    ]
    const decide = (target: TestServer, headers: Record<string, string>) => Promise.all(writes.map(async ({ method, path, body }) => {
      const res = await target.get(path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return `${path} ${JSON.stringify(body.advanced ?? {})} ${res.status === 403 && (await res.text()) === JSON.stringify(OWNER_REQUIRED) ? 'owner_required' : 'passed'}`
    }))
    const expected = (owner: boolean) => writes.map(({ path, body, owner: ownerOnly }) => `${path} ${JSON.stringify(body.advanced ?? {})} ${owner || !ownerOnly ? 'passed' : 'owner_required'}`)
    for (const who of ['bound', 'person'] as const) expect(await decide(server, sessions[who]), who).toEqual(expected(false))
    expect(await decide(server, sessions.owner)).toEqual(expected(true))
  })

  it('passes every route for an owner session and with auth off', async () => {
    for (const [target, headers] of [[server, sessions.owner], [open, {}]] as const) {
      const got = await Promise.all(ROUTES.map(async (route) => `${route.method} ${route.path} ${await decision(target, route, headers)}`))
      expect(got).toEqual(ROUTES.map((route) => `${route.method} ${route.path} passed`))
    }
  })
})
