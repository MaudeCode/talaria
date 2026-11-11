/** TAL-1712: bootstrap ships the shell's settings, profiles, workspaces and projects so the client skips those four reads. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BootstrapSchema } from '@maudecode/talaria-web-contracts'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

async function bootstrap(s: TestServer, headers: Record<string, string> = {}) {
  const res = await s.get('/api/bootstrap', { headers })
  expect(res.status).toBe(200)
  return BootstrapSchema.parse(await res.json())
}

/** The bodies of the four routes the shell would otherwise read, for the same request identity. */
async function routeBodies(s: TestServer, headers: Record<string, string> = {}) {
  const read = async (path: string) => { const res = await s.get(path, { headers }); expect(res.status, path).toBe(200); return res.json() }
  return { settings: await read('/api/settings'), profiles: await read('/api/profiles'), workspaces: await read('/api/workspaces'), projects: await read('/api/projects') }
}

describe('bootstrap shell on an open server', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await bootTestServer({ sidecar: new FakeSidecar() })
    const created = await s.get('/api/projects/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic project' }) })
    expect(created.status).toBe(200)
  })
  afterAll(() => s.close())

  it('equals the four routes the shell reads', async () => {
    const boot = await bootstrap(s)
    expect(boot.shell?.projects.projects.map((p) => p.name)).toEqual(['Synthetic project'])
    expect(boot.shell).toEqual(await routeBodies(s))
  })

  it('omits the shell, still answering 200, when a loader fails', async () => {
    const load = vi.spyOn(s.deps.projects, 'load').mockRejectedValue(new Error('synthetic project store failure'))
    try {
      const boot = await bootstrap(s)
      expect(boot.shell).toBeUndefined()
      expect(boot.profile).toEqual({ name: 'default', is_default: true })
    } finally {
      load.mockRestore()
    }
  })

  it('omits the shell rather than hold the bootstrap on a read that does not answer', async () => {
    const load = vi.spyOn(s.deps.projects, 'load').mockReturnValue(new Promise(() => undefined))
    try {
      const started = Date.now()
      expect((await bootstrap(s)).shell).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      load.mockRestore()
    }
  })

  it('omits the shell while the startup gate holds the routes it would answer for', async () => {
    s.deps.startup.arm()
    try {
      expect((await bootstrap(s)).shell).toBeUndefined()
    } finally {
      s.deps.startup.release()
    }
    expect((await bootstrap(s)).shell).toBeDefined()
  })
})

describe('bootstrap shell behind password auth', () => {
  let s: TestServer
  const PASSWORD = 'correct horse battery staple'
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD }, sidecar: new FakeSidecar() }) })
  afterAll(() => s.close())

  it('an unauthenticated request gets no shell', async () => {
    const boot = await bootstrap(s)
    expect(boot.auth.logged_in).toBe(false)
    expect(boot.shell).toBeUndefined()
  })

  it('a signed-in request gets the shell its session would read', async () => {
    const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    const cookie = cookieHeader(res.headers.getSetCookie(), 'hermes_session')!
    const boot = await bootstrap(s, { cookie })
    expect(boot.auth.logged_in).toBe(true)
    expect(boot.shell).toEqual(await routeBodies(s, { cookie }))
  })
})
