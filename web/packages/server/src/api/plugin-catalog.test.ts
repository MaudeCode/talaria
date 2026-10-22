import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it('keeps member catalog reads display-only and refuses installation before calling the Agent', async () => {
  const sidecar = new FakeSidecar()
  server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
  const headers = { 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops', 'content-type': 'application/json' }
  const read = await server.get('/api/plugins/catalog', { headers })
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ read_only: true, entries: [{ can_install: false }] })
  expect((await server.get('/api/plugins/install', { method: 'POST', body: '{"name":"catalog-probe"}', headers })).status).toBe(403)
  expect(sidecar.calls.some((c) => c.method === 'plugins.install')).toBe(false)
})

it('TAL-1331: exposes a bounded catalog and installs only after a profile-bound preview', async () => {
  const sidecar = new FakeSidecar()
  server = await bootTestServer({ sidecar })
  const response = await server.get('/api/plugins/catalog?query=probe&offset=0&limit=10')
  expect(response.status, 'Plugins settings must expose the reviewed Agent catalog').toBe(200)
  const body = await response.json() as { entries: unknown[] }
  expect(body.entries).toBeInstanceOf(Array)
  expect(sidecar.calls.filter((c) => c.method === 'plugins.catalog').at(-1)?.params).toEqual({ profile_home: server.deps.profileHome('default'), query: 'probe', offset: 0, limit: 10 })
  expect((await server.get('/api/plugins/catalog?limit=51')).status).toBe(400)
  const calls: unknown[] = []
  sidecar.respond('plugins.install', (params, _emit, opts) => {
    calls.push(params)
    expect(opts.timeoutMs).toBe(0)
    return params.consent_token ? { name: params.name, key: 'different-manifest-name', status: 'installed', enabled: false }
      : { name: params.name, status: 'needs_consent', findings: 'Disabled only; dependencies not approved', consent_token: 'preview-bound-to-profile' }
  })
  const install = (body: unknown) => server!.get('/api/plugins/install', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  expect(await (await install({ name: 'catalog-probe' })).json()).toMatchObject({ status: 'needs_consent' })
  expect(await (await install({ name: 'catalog-probe', consent_token: 'preview-bound-to-profile' })).json()).toMatchObject({ key: 'different-manifest-name', enabled: false })
  expect(calls).toEqual([{ name: 'catalog-probe', profile_home: server.deps.profileHome('default') }, { name: 'catalog-probe', consent_token: 'preview-bound-to-profile', profile_home: server.deps.profileHome('default') }])
  expect((await install({ name: 'https://example.invalid/arbitrary' })).status).toBe(400)
  sidecar.respond('plugins.install', () => { throw new SidecarError('Profile or preview changed', { condition: 'plugin_install_consent_changed' }) })
  expect((await install({ name: 'catalog-probe', consent_token: 'stale' })).status).toBe(409)
  const before = calls.length
  sidecar.respond('plugins.install', () => { calls.push('lost-ack'); throw new Error('sidecar disconnected after publication') })
  const lost = await install({ name: 'catalog-probe', consent_token: 'valid-but-ack-lost' })
  expect(lost.status).toBe(503)
  expect(await lost.json()).toMatchObject({ condition: 'plugin_install_unconfirmed' })
  expect(calls).toHaveLength(before + 1)
})
