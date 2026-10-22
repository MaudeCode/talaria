import { afterEach, expect, it, vi } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

let s: TestServer | undefined
afterEach(async () => { await s?.close(); s = undefined })

it('keeps Agent dashboards distinct from the legacy source and binds every request to its profile', async () => {
  const fake = new FakeSidecar()
  fake.respond('plugins.dashboard_list', ({ profile_home }) => ({ supported: true, plugins: [{ name: 'board', label: profile_home.endsWith('beta') ? 'Beta board' : 'Alpha board', version: '1', description: '', enabled: true, panel: 'dist/index.html', has_api: true }] }))
  fake.respond('plugins.dashboard_asset', ({ profile_home }) => ({ status: 200, body: Buffer.from(`<p>${profile_home}</p>`).toString('base64'), content_type: 'text/html; charset=utf-8' }))
  fake.respond('plugins.dashboard_request', ({ profile_home }) => ({ status: 200, body: Buffer.from(profile_home).toString('base64'), content_type: 'text/plain' }))
  s = await bootTestServer({ sidecar: fake })
  const manifests = async (cookie = '') => (await (await s!.get('/api/extensions/manifests', { headers: { cookie } })).json()) as { manifests: { id: string; name: string; source: string; panel: string; agent_host: boolean }[] }
  const alpha = (await manifests()).manifests.find((m) => m.source === 'agent-plugin')
  expect(alpha, 'the selected profile Agent dashboard must appear in the existing extension host').toBeDefined()
  const beta = (await manifests('hermes_profile=beta')).manifests.find((m) => m.source === 'agent-plugin')!
  expect(beta.id).not.toBe(alpha!.id)
  expect(beta.name).toBe('Beta board')
  const res = await s.get('/' + alpha!.panel)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
  expect(await res.text()).toContain(s.state)
  expect((await s.get('/' + alpha!.panel, { headers: { cookie: 'hermes_profile=beta' } })).status).toBe(404)
  expect((await s.get('/' + beta.panel, { headers: { cookie: 'hermes_profile=beta' } })).status).toBe(200)
  const api = await s.get(`/api/extensions/${beta.id}/sidecar/identity`, { headers: { cookie: 'hermes_profile=beta', origin: s.base } })
  expect(api.status).toBe(200)
  expect(await api.text()).toContain('beta')
  const calls = fake.calls.filter((c) => c.method === 'plugins.dashboard_request')
  expect(calls).toHaveLength(1)
  expect(calls[0]!.params).toMatchObject({ authenticated: true, name: 'board', path: '/identity' })
})

it('uses owner-bound ids and discards a delayed asset after a profile switch', async () => {
  const fake = new FakeSidecar()
  fake.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'board', label: 'Board', version: '', description: '', enabled: true, panel: 'dist/index.html', has_api: true }] }))
  s = await bootTestServer({ sidecar: fake })
  const scope = { home: s.state, owner: 'owner-one' }
  const plugins = s.deps.dashboardPlugins
  const one = (await plugins.agentManifests(scope))[0]!
  const two = (await plugins.agentManifests({ ...scope, owner: 'owner-two' }))[0]!
  expect(one.id).not.toBe(two.id)
  expect(await plugins.agentAsset({ ...scope, owner: 'owner-two' }, String(one.id), 'dist/index.html')).toBeNull()
  let resolve!: (value: { status: number; body: string; content_type: string }) => void
  let started!: () => void
  const ready = new Promise<void>((r) => { started = r })
  fake.respond('plugins.dashboard_asset', () => { started(); return new Promise((r) => { resolve = r }) })
  const pending = plugins.agentAsset(scope, String(one.id), 'dist/index.html')
  const rejected = expect(pending).rejects.toMatchObject({ status: 404 })
  await ready
  plugins.invalidateOwner(scope)
  resolve({ status: 200, body: Buffer.from('old-profile-secret').toString('base64'), content_type: 'text/html' })
  await rejected
  const grant = String(one.panel).split('/')[1]!
  expect(await plugins.agentAssetGrant(grant, 'dist/index.html')).toBeNull()
  const next = (await plugins.agentManifests(scope))[0]!
  expect(next.id).not.toBe(one.id)
  expect(await plugins.agentAsset(scope, String(one.id), 'dist/index.html')).toBeNull()
})

it('keeps unknown and disabled Agent access indistinguishable without forwarding a request', async () => {
  const fake = new FakeSidecar()
  let enabled = true
  fake.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'board', label: 'Board', version: '', description: '', enabled, panel: 'dist/index.html', has_api: true }] }))
  s = await bootTestServer({ sidecar: fake })
  const scope = { home: s.state, owner: 'reader' }
  const plugins = s.deps.dashboardPlugins
  const row = (await plugins.agentManifests(scope))[0]!
  enabled = false
  for (const id of [String(row.id), 'agent-' + '0'.repeat(40)]) {
    expect(await plugins.agentAsset(scope, id, 'dist/index.html')).toBeNull()
    await expect(plugins.agentRequest(scope, id, { path: '/', method: 'GET', query: '', body: '', headers: {}, websocket: true })).rejects.toMatchObject({ status: 404 })
  }
  expect(fake.calls.filter((c) => c.method === 'plugins.dashboard_request' || c.method === 'plugins.dashboard_asset')).toHaveLength(0)
})

it('returns an explicit 501 for an admitted WebSocket without retrying the Agent host', async () => {
  const { request } = await import('node:http')
  const fake = new FakeSidecar()
  fake.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'board', label: 'Board', version: '', description: '', enabled: true, panel: 'dist/index.html', has_api: true }] }))
  fake.respond('plugins.dashboard_request', ({ websocket }) => ({ status: websocket ? 501 : 200, body: Buffer.from('Agent plugin host supports buffered HTTP only').toString('base64'), content_type: 'text/plain' }))
  s = await bootTestServer({ sidecar: fake })
  const body = await (await s.get('/api/extensions/manifests')).json() as { manifests: { id: string; source: string }[] }
  const id = body.manifests.find((m) => m.source === 'agent-plugin')!.id
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${s!.base}/api/extensions/${id}/sidecar/events`, { headers: { origin: s!.base, connection: 'Upgrade', upgrade: 'websocket' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.once('error', reject)
    req.end()
  })
  expect(status).toBe(501)
  expect(fake.calls.filter((c) => c.method === 'plugins.dashboard_request')).toHaveLength(1)
})

it('loads password-authenticated dashboard assets without cookies while keeping API authority private', async () => {
  const fake = new FakeSidecar()
  fake.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'board', label: 'Board', version: '', description: '', enabled: true, panel: 'dist/index.html', has_api: true }] }))
  fake.respond('plugins.dashboard_asset', ({ path }) => ({ status: 200, body: Buffer.from(path.endsWith('.js') ? 'window.dashboardLoaded = true' : '<script src="app.js"></script>').toString('base64'), content_type: path.endsWith('.js') ? 'application/javascript' : 'text/html' }))
  s = await bootTestServer({ sidecar: fake, env: { HERMES_WEBUI_PASSWORD: 'synthetic dashboard password' } })
  const login = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic dashboard password' }) })
  const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  const manifests = await (await s.get('/api/extensions/manifests', { headers: { cookie } })).json() as { manifests: { id: string; source: string; panel: string }[] }
  const row = manifests.manifests.find((m) => m.source === 'agent-plugin')!
  const url = new URL('/' + row.panel, s.base)
  const asset = new URL('app.js', url)
  // A sandboxed frame's subresource fetch has no session cookie.
  const js = await s.get(asset.pathname)
  expect(js.status, 'the authenticated panel must not redirect its cookie-free assets to login').toBe(200)
  expect(await js.text()).toBe('window.dashboardLoaded = true')
  expect(js.headers.get('content-security-policy')).toContain('sandbox allow-scripts')
  const segment = asset.pathname.split('/')[2]!
  const forged = segment.slice(0, -1) + (segment.endsWith('0') ? '1' : '0')
  expect((await s.get(asset.pathname.replace(segment, forged))).status).toBe(404)
  expect((await s.get(`/api/extensions/${row.id}/sidecar/identity`, { headers: { origin: s.base } })).status).toBe(401)
})


it('expires static grants and keeps their profile scope separate from API ids', async () => {
  const fake = new FakeSidecar()
  fake.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'board', label: 'Board', version: '', description: '', enabled: true, panel: 'dist/index.html', has_api: true }] }))
  fake.respond('plugins.dashboard_asset', () => ({ status: 200, body: Buffer.from('static').toString('base64'), content_type: 'text/html' }))
  s = await bootTestServer({ sidecar: fake })
  const scope = { home: s.state, owner: 'owner' }
  const plugins = s.deps.dashboardPlugins
  const row = (await plugins.agentManifests(scope))[0]!
  const grant = String(row.panel).split('/')[1]!
  expect(await plugins.agentAssetGrant(grant, 'dist/index.html')).not.toBeNull()
  expect(await plugins.agentAssetGrant(grant, 'dist/index.html', undefined, { ...scope, home: scope.home + '/profiles/other' })).toBeNull()
  expect(await plugins.agentAssetGrant(grant, 'dist/index.html', undefined, { ...scope, owner: 'other-owner' })).toBeNull()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 3_600_000)
  try { expect(await plugins.agentAssetGrant(grant, 'dist/index.html')).toBeNull() }
  finally { clock.mockRestore() }
})
