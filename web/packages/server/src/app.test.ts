import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootstrapSchema, AuthStatusSchema, HealthSchema } from '@maudecode/talaria-web-contracts'
import { bootTestServer, cookieHeader, WEB_ROOT, type TestServer } from './test/harness.js'
import { FakeSidecar } from './sidecar/fake.js'

const DIST_INDEX = resolve(WEB_ROOT, 'static/dist/index.html')

describe('open server (no auth)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('/health reports ok with release identity and the accept-loop counters', async () => {
    const res = await s.get('/health')
    expect(res.status).toBe(200)
    const body = HealthSchema.parse(await res.json())
    expect(body.status).toBe('ok')
    expect(body.release.version).toBe('development')
    expect(body.accept_loop.requests_total).toBeGreaterThan(0)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('content-security-policy-report-only')).toContain('report-uri /api/csp-report')
    expect(res.headers.get('report-to')).toContain('csp-endpoint')
  })

  it('/health reports Agent readiness separately from server liveness', async () => {
    const body = HealthSchema.parse(await (await s.get('/health')).json())
    expect(body.status).toBe('ok')
    expect(body.agent).toEqual({ status: 'unavailable' })
    for (const status of ['ready', 'incompatible', 'restarting'] as const) {
      const withSidecar = await bootTestServer({ sidecar: new FakeSidecar({ status }) })
      try {
        const res = await withSidecar.get('/health')
        expect(res.status).toBe(200)
        const health = HealthSchema.parse(await res.json())
        expect(health.status).toBe('ok')
        expect(health.agent).toEqual({ status })
      } finally {
        await withSidecar.close()
      }
    }
  })

  it('/health never names sessions or streams (it is public)', async () => {
    s.deps.registry.registerActiveRun({ stream_id: 'stream-secret', session_id: 'sess-secret', phase: 'running', started_at: 1, workspace: '/w', model: null, provider: null, ephemeral: false })
    try {
      const body = HealthSchema.parse(await (await s.get('/health')).json())
      expect(body.active_runs).toBe(1)
      expect(JSON.stringify(body)).not.toContain('secret')
      expect(body.runs[0]).toEqual({ phase: 'running', started_at: 1 })
    } finally {
      s.deps.registry.activeRuns.delete('stream-secret')
    }
  })

  it('/health?deep=1 answers 503 starting while the startup gate is armed', async () => {
    s.deps.startup.arm()
    try {
      const res = await s.get('/health?deep=1')
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
      const body = HealthSchema.parse(await res.json())
      expect(body.status).toBe('starting')
      expect(body.phase).toBe('session recovery')
    } finally {
      s.deps.startup.release()
    }
    const res = await s.get('/health?deep=1')
    expect(res.status).toBe(200)
    expect(HealthSchema.parse(await res.json()).checks).toBeDefined()
  })

  it('api requests wait on the startup gate and get the retryable 503 once it times out', async () => {
    s.deps.startup.arm()
    const pending = s.get('/api/auth/status')
    await new Promise((r) => setTimeout(r, 50))
    s.deps.startup.release()
    expect((await pending).status).toBe(200)
    s.deps.startup.arm()
    try {
      // The immediate paths bypass the gate.
      expect((await s.get('/api/csp-report', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(204)
    } finally {
      s.deps.startup.release()
    }
  })

  it('/api/bootstrap has the documented shape without auth', async () => {
    const res = await s.get('/api/bootstrap')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = BootstrapSchema.parse(await res.json())
    expect(Object.keys(body).sort()).toEqual(['assistant_name', 'auth', 'bot_name', 'csrf_token', 'features', 'language', 'max_upload_bytes', 'onboarding', 'profile', 'webui_version'].sort())
    expect(body.csrf_token).toBe('')
    expect(body.auth.auth_enabled).toBe(false)
    expect(body.profile).toEqual({ name: 'default', is_default: true })
    expect(body.onboarding).toEqual({ completed: false })
    expect(body.webui_version).toBe('web-v0.0.0-test')
    const text = JSON.stringify(body)
    for (const forbidden of ['password_hash', 'api_key', 'cookie']) expect(text).not.toContain(forbidden)
  })

  it('bootstrap auth block equals /api/auth/status', async () => {
    const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap')).json())
    const auth = AuthStatusSchema.parse(await (await s.get('/api/auth/status')).json())
    expect(boot.auth).toEqual(auth)
  })

  it('login without auth answers ok and logout is allowed', async () => {
    const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message: 'Auth not enabled' })
    const out = await s.get('/api/auth/logout', { method: 'POST' })
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ ok: true })
    const cleared = out.headers.getSetCookie()
    expect(cleared).toContain('hermes_session=""; HttpOnly; Max-Age=0; Path=/; SameSite=Lax')
    expect(cleared).toContain('hermes_profile=""; HttpOnly; Max-Age=0; Path=/; SameSite=Lax')
  })

  it('sandboxed documents (Origin: null) cannot call the API', async () => {
    const res = await s.get('/api/auth/status', { headers: { origin: 'null' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Sandboxed documents cannot call the API directly' })
  })

  it('unknown API paths answer JSON 404 and unknown pages are not shadowed by the shell', async () => {
    const api = await s.get('/api/definitely-not-a-route')
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: 'not found' })
    for (const path of ['/definitely-not-a-route', '/settingsx', '/random/path']) expect((await s.get(path)).status, path).toBe(404)
  })

  it('malformed JSON bodies are 400 with the Python error text', async () => {
    const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('OPTIONS preflight echoes only a same-origin Origin', async () => {
    const host = s.base.replace('http://', '')
    const ok = await s.get('/api/auth/status', { method: 'OPTIONS', headers: { origin: s.base, host } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(s.base)
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS')
    const bad = await s.get('/api/auth/status', { method: 'OPTIONS', headers: { origin: 'https://evil.example', host } })
    expect(bad.status).toBe(200)
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('every access is logged as one JSON line', async () => {
    await s.get('/health')
    const line = s.logs.findLast((l) => l.startsWith('[webui] {'))
    const record = JSON.parse(line!.slice('[webui] '.length)) as Record<string, unknown>
    expect(record).toMatchObject({ method: 'GET', path: '/health', status: 200 })
    expect(typeof record.ms).toBe('number')
  })

  describe('SPA shell and static assets', () => {
    it.skipIf(!readFileSync(DIST_INDEX, 'utf8'))('shell routes render index.html with substituted placeholders', async () => {
      for (const path of ['/', '/index.html', '/session/abc123', '/tasks', '/settings/providers', '/ext/desktop-companion', '/onboarding', '/login', '/share/tok']) {
        const res = await s.get(path)
        expect(res.status, path).toBe(200)
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(res.headers.get('cache-control')).toBe('no-store')
        const html = await res.text()
        expect(html).not.toContain('__BASE_HREF__')
        expect(html).not.toContain('__LANG__')
        expect(html).not.toContain('__WEBUI_VERSION__')
        expect(html).toContain('<html lang="en">')
        expect(html).toContain(path.split('/').filter(Boolean).length > 1 ? '<base href="../">' : '<base href="./">')
      }
      const share = await s.get('/share/tok')
      expect(share.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    })

    it('serves the service worker, manifest, hashed assets, and the legacy static alias', async () => {
      const sw = await s.get('/sw.js')
      expect(sw.status).toBe(200)
      expect(sw.headers.get('service-worker-allowed')).toBe('/')
      expect(sw.headers.get('cache-control')).toBe('no-store')
      expect((await sw.text()).length).toBeGreaterThan(0)
      for (const path of ['/manifest.json', '/manifest.webmanifest', '/session/manifest.webmanifest']) {
        const res = await s.get(path)
        expect(res.status, path).toBe(200)
        expect(res.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8')
      }
      const html = await (await s.get('/')).text()
      const asset = /\.\/assets\/([A-Za-z0-9._-]+\.js)/.exec(html)?.[1]
      expect(asset).toBeDefined()
      const res = await s.get(`/assets/${asset}`, { headers: { 'accept-encoding': 'gzip' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(res.headers.get('content-encoding')).toBe('gzip')
      const etag = res.headers.get('etag')
      expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
      const cached = await s.get(`/assets/${asset}`, { headers: { 'if-none-match': etag! } })
      expect(cached.status).toBe(304)
      expect((await s.get(`/static/dist/assets/${asset}`)).status).toBe(200)
      expect(await s.rawStatus('/static/dist/%2e%2e/index.html')).toBe(404)
      expect(await s.rawStatus('/static/dist/../../server.py')).toBe(404)
      expect(await s.rawStatus('/static/../server.py')).toBe(404)
      expect(await s.rawStatus('/static/dist/index.html')).toBe(200)
      const brand = await s.get('/static/brand/favicon.svg?v=web-v1.2.3')
      expect(brand.status).toBe(200)
      expect(brand.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect((await s.get('/static/brand/favicon.svg?v=unknown')).headers.get('cache-control')).toBe('public, max-age=300')
      expect((await s.get('/session/static/brand/favicon.svg')).status).toBe(200)
      expect((await s.get('/session/static/missing.css')).status).toBe(404)
      expect((await s.get('/favicon.ico')).headers.get('content-type')).toBe('image/x-icon')
    })
  })
})

describe('password auth', () => {
  let s: TestServer
  const PASSWORD = 'correct horse battery staple'
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD } }) })
  afterAll(() => s.close())

  const host = () => s.base.replace('http://', '')

  it('protected API routes answer 401 and pages redirect to login with an encoded next', async () => {
    const api = await s.get('/api/sessions?limit=50&offset=0')
    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({ error: 'Authentication required' })
    const page = await s.get('/session/abc?tab=files&x=1')
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('login?next=/session/abc%3Ftab%3Dfiles%26x%3D1')
    const nested = await s.get('/session/login?next=/tasks')
    expect(nested.headers.get('location')).toBe('../login?next=/tasks')
    // The gate and the router see one canonical path: a trailing slash or dot segment cannot reach a handler ungated.
    for (const path of ['/api/sessions/', '/api/share/create/', '/api/x/../share/create', '/api//share/create', '/api/shutdown/', '/api/updates/apply/']) {
      const res = await s.get(path, path.includes('sessions') ? {} : { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
      expect(res.status, path).toBe(401)
    }
    expect((await s.get('/health/')).status).toBe(200)
    const loop = await s.get('/session/login?next=/session/login%3Fnext%3D/x')
    expect(loop.headers.get('location')).toBe('../login')
  })

  it('public paths stay reachable', async () => {
    for (const path of ['/login', '/health', '/api/bootstrap', '/api/auth/status', '/sw.js', '/manifest.webmanifest']) expect((await s.get(path)).status, path).toBe(200)
    const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap')).json())
    expect(boot.auth).toMatchObject({ auth_enabled: true, logged_in: false, password_auth_enabled: true, can_manage_server: false })
    expect(boot.profile).toBeNull()
    expect(boot.bot_name).toBe('Hermes')
  })

  it('logs in, receives a signed HttpOnly cookie, and the CSRF token is bound to the session', async () => {
    const bad = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
    expect(bad.status).toBe(401)
    expect(await bad.json()).toEqual({ error: 'Invalid password' })
    const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const setCookie = res.headers.getSetCookie()
    expect(setCookie).toHaveLength(1)
    expect(setCookie[0]).toMatch(/^hermes_session=[0-9a-f]{64}\.[0-9a-f]{64}; HttpOnly; Max-Age=2592000; Path=\/; SameSite=Lax$/)
    const cookie = cookieHeader(setCookie, 'hermes_session')!
    const status = AuthStatusSchema.parse(await (await s.get('/api/auth/status', { headers: { cookie } })).json())
    expect(status).toMatchObject({ logged_in: true, can_manage_server: true })
    const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers: { cookie } })).json())
    expect(boot.csrf_token).toMatch(/^[0-9a-f]{64}$/)
    expect(boot.profile).toEqual({ name: 'default', is_default: true })

    // Browser writes need the token; non-browser clients (no Origin/Referer) do not.
    const noToken = await s.get('/api/auth/logout', { method: 'POST', headers: { cookie, origin: s.base, host: host() } })
    expect(noToken.status).toBe(403)
    expect(await noToken.json()).toEqual({ error: 'Session expired - reload the page' })
    const crossOrigin = await s.get('/api/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.example', host: host(), 'X-Hermes-CSRF-Token': boot.csrf_token } })
    expect(crossOrigin.status).toBe(403)
    expect(await crossOrigin.json()).toEqual({ error: 'Cross-origin mismatch - check reverse proxy headers' })
    const out = await s.get('/api/auth/logout', { method: 'POST', headers: { cookie, origin: s.base, host: host(), 'X-Hermes-CSRF-Token': boot.csrf_token } })
    expect(out.status).toBe(200)
    expect(out.headers.getSetCookie()[0]).toBe('hermes_session=""; HttpOnly; Max-Age=0; Path=/; SameSite=Lax')
    expect((await s.get('/api/auth/status', { headers: { cookie } })).ok).toBe(true)
    expect(AuthStatusSchema.parse(await (await s.get('/api/auth/status', { headers: { cookie } })).json()).logged_in).toBe(false)
    expect((await s.get('/api/auth/logout', { method: 'POST', headers: { cookie } })).status).toBe(401)
  })

  it('rate-limits failed logins per client', async () => {
    s.deps.auth.clearLoginAttempts('127.0.0.1')
    for (let i = 0; i < 5; i += 1) {
      const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
      expect(res.status).toBe(401)
    }
    const blocked = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Too many attempts. Try again in a minute.' })
    s.deps.auth.clearLoginAttempts('127.0.0.1')
  })
})

describe('trusted-header auth', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}', HERMES_WEBUI_TRUSTED_AUTH_LOGOUT_URL: 'https://sso.example/logout' } })
  })
  afterAll(() => s.close())

  it('a loopback proxy header mints a trusted session bound to the mapped profile', async () => {
    const anon = await s.get('/api/auth/status')
    expect(AuthStatusSchema.parse(await anon.json())).toMatchObject({ auth_enabled: true, logged_in: false, trusted_auth_enabled: true })
    const res = await s.get('/api/auth/status', { headers: { 'X-Remote-User': 'kim', 'X-Remote-Groups': 'dev, ops' } })
    const status = AuthStatusSchema.parse(await res.json())
    expect(status).toMatchObject({ logged_in: true, auth_type: 'trusted', user: 'kim', bound_profile: 'work', can_manage_server: false })
    const cookies = res.headers.getSetCookie()
    const session = cookieHeader(cookies, 'hermes_session')
    expect(session).toMatch(/^hermes_session=[0-9a-f]{64}\.[0-9a-f]{64}$/)
    expect(cookieHeader(cookies, 'hermes_profile')).toMatch(/^hermes_profile=work\.[0-9a-f]{64}$/)
    const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers: { cookie: session!, 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops' } })).json())
    expect(boot.profile?.name).toBe('work')
    const out = await s.get('/api/auth/logout', { method: 'POST', headers: { cookie: session!, 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops' } })
    expect(await out.json()).toEqual({ ok: true, trusted_logout_url: 'https://sso.example/logout' })
  })
})

describe('trusted-header auth on an isolated profile instance', () => {
  // `/api/bootstrap` is a public path; every gated route refuses the mismatched binding.
  const ROUTES = ['/api/sessions', '/api/profiles', '/api/settings', '/api/crons', '/api/memory']
  let base = ''
  let home = ''
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'talaria-isolated-auth-'))
    home = join(base, 'profiles', 'alice')
    mkdirSync(home, { recursive: true })
  })
  afterAll(() => { rmSync(base, { recursive: true, force: true }) })
  const boot = (env: Record<string, string> = {}) => bootTestServer({ env: { HERMES_WEBUI_ISOLATED_PROFILE: '1', HERMES_HOME: home, HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', ...env } })

  // `/api/crons` answers 503 without a sidecar; admission only means the gate let the request through.
  it('refuses a session bound to another profile on every API route and admits the pinned profile', async () => {
    const s = await boot({ HERMES_WEBUI_GROUP_PROFILE_MAP: '{"alice-team":"alice","bob-team":"bob"}' })
    try {
      for (const route of ROUTES) {
        for (const groups of ['bob-team', 'strangers']) {
          const res = await s.get(route, { headers: { 'X-Remote-User': 'mallory', 'X-Remote-Groups': groups } })
          expect(res.status, `${route} as ${groups}`).toBe(403)
          expect(await res.json()).toEqual({ error: 'Profile access forbidden' })
        }
        const ok = await s.get(route, { headers: { 'X-Remote-User': 'alice', 'X-Remote-Groups': 'alice-team' } })
        expect([401, 403], route).not.toContain(ok.status)
      }
      expect(s.deps.requestScope.run({ requestProfile: 'bob' }, () => s.deps.activeProfile())).toBe('alice')
    } finally { await s.close() }
  })

  it('admits an unbound session on the pinned profile', async () => {
    const s = await boot()
    try {
      for (const route of ROUTES) expect([401, 403], route).not.toContain((await s.get(route, { headers: { 'X-Remote-User': 'alice' } })).status)
      const res = await s.get('/api/bootstrap', { headers: { 'X-Remote-User': 'alice' } })
      expect(BootstrapSchema.parse(await res.json()).profile?.name).toBe('alice')
    } finally { await s.close() }
  })
})
