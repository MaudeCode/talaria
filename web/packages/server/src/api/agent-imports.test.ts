import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it('TAL-1493: exposes owner-only discovery, preview and explicit receipt application in the active profile', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('profiles.import', (params) => ({ status: params.action === 'discover' ? 'available' : params.action === 'preview' ? 'preview' : 'applied', profile: 'default', sources: [{ agent: 'cursor', label: 'Cursor' }], items: [], stripped_secrets: [], receipt: params.action === 'preview' ? 'opaque-preview' : null, can_apply: params.action === 'preview', message: null }))
  server = await bootTestServer({ sidecar })
  const call = (path: string, body: unknown) => server!.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await server.get('/api/profile/import')).status, 'Owner can discover import sources').toBe(200)
  expect(await (await call('/api/profile/import/preview', { agent: 'cursor' })).json()).toMatchObject({ status: 'preview', receipt: 'opaque-preview' })
  expect(await (await call('/api/profile/import/apply', { receipt: 'opaque-preview' })).json()).toMatchObject({ status: 'applied' })
  expect(sidecar.calls.filter((c) => c.method === 'profiles.import').map((c) => c.params)).toEqual([
    { action: 'discover', profile_home: server.deps.profileHome('default') },
    { action: 'preview', agent: 'cursor', profile_home: server.deps.profileHome('default') },
    { action: 'apply', receipt: 'opaque-preview', profile_home: server.deps.profileHome('default') },
  ])
  expect((await call('/api/profile/import/preview', { agent: '../../secrets' })).status).toBe(400)
  expect((await call('/api/profile/import/apply', { receipt: 'x', target: '/tmp/foreign' })).status).toBe(400)
})

it('refuses member discovery and import before any sidecar call', async () => {
  const sidecar = new FakeSidecar()
  server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
  const headers = { 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops', 'content-type': 'application/json' }
  for (const [path, body] of [['/api/profile/import', null], ['/api/profile/import/result?receipt=foreign', null], ['/api/profile/import/preview', { agent: 'cursor' }], ['/api/profile/import/apply', { receipt: 'foreign' }]] as const) {
    expect((await server.get(path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })).status).toBe(403)
  }
  expect(sidecar.calls.filter((c) => c.method === 'profiles.import')).toEqual([])
})

it('returns typed unavailable or unknown outcomes without exposing native exception text or replaying', async () => {
  const sidecar = new FakeSidecar()
  server = await bootTestServer({ sidecar })
  sidecar.respond('profiles.import', () => { throw new Error('API_TOKEN=DECOY-SECRET at /private/source') })
  for (const path of ['/api/profile/import', '/api/profile/import/preview', '/api/profile/import/apply', '/api/profile/import/result?receipt=bound']) {
    const action = path.endsWith('preview') ? { agent: 'cursor' } : path.endsWith('apply') ? { receipt: 'bound' } : null
    const response = await server.get(path, action ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) } : {})
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ status: path.includes('apply') || path.includes('result?') ? 'unknown' : 'unavailable', can_apply: false })
    expect(JSON.stringify(result)).not.toContain('DECOY')
  }
  expect(sidecar.calls.filter((c) => c.method === 'profiles.import')).toHaveLength(4)
  expect(server.logs.join('\n')).not.toContain('DECOY')
})
