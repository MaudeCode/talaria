import { IncomingMessage, request, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BootstrapSchema, AuthStatusSchema, HealthSchema } from '@maudecode/talaria-web-contracts'
import { bootTestServer, cookieHeader, WEB_ROOT, type TestServer } from './test/harness.js'
import { FakeSidecar } from './sidecar/fake.js'
import { RequestContext } from './http/context.js'
import { AssetCache, SpaShell } from './spa.js'

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
    expect(await res.json()).toEqual({ ok: true, message: 'Auth not enabled', redirect_path: '/' })
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

    it('serves synthetic cold assets with gzip, ETag, MIME, replacement and path checks', async () => {
      const root = mkdtempSync(join(tmpdir(), 'talaria-static-'))
      mkdirSync(join(root, 'dist', 'assets'), { recursive: true })
      const bundle = 'console.log("cold");\n'.repeat(50_000)
      writeFileSync(join(root, 'dist', 'assets', 'app-cold.js'), bundle)
      writeFileSync(join(root, 'mark.svg'), '<svg/>')
      const synthetic = await bootTestServer({ deps: (deps) => {
        deps.spa = new SpaShell(join(root, 'dist'))
        deps.staticFiles = new AssetCache(root)
      } })
      try {
        const [first, second, health] = await Promise.all([
          synthetic.get('/assets/app-cold.js', { headers: { 'accept-encoding': 'gzip' } }),
          synthetic.get('/static/dist/assets/app-cold.js', { headers: { 'accept-encoding': 'identity' } }),
          synthetic.get('/health'),
        ])
        expect(health.status).toBe(200)
        expect(first.status).toBe(200)
        expect(first.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
        expect(first.headers.get('content-encoding')).toBe('gzip')
        expect(await first.text()).toBe(bundle)
        expect(second.headers.get('content-encoding')).toBeNull()
        expect(await second.text()).toBe(bundle)
        const etag = first.headers.get('etag')
        expect(etag).toBe(second.headers.get('etag'))
        expect((await synthetic.get('/assets/app-cold.js', { headers: { 'if-none-match': etag! } })).status).toBe(304)
        const mark = await synthetic.get('/static/mark.svg')
        expect(mark.headers.get('content-type')).toBe('image/svg+xml')
        expect(await mark.text()).toBe('<svg/>')
        writeFileSync(join(root, 'mark.svg'), '<svg width="1"/>')
        const replaced = await synthetic.get('/static/mark.svg')
        expect(await replaced.text()).toBe('<svg width="1"/>')
        expect(replaced.headers.get('etag')).not.toBe(mark.headers.get('etag'))
        expect((await synthetic.get('/static/missing.css')).status).toBe(404)
        expect((await synthetic.get('/assets/missing.js')).status).toBe(404)
        expect(await synthetic.rawStatus('/static/dist/../../mark.svg')).toBe(404)
        expect(await synthetic.rawStatus('/assets/%2e%2e/%2e%2e/mark.svg')).toBe(404)
      } finally {
        await synthetic.close()
        rmSync(root, { recursive: true, force: true })
      }
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
    expect(await res.json()).toEqual({ ok: true, redirect_path: '/' })
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

  it('counts concurrent failed logins before the password check finishes', async () => {
    s.deps.auth.clearLoginAttempts('127.0.0.1')
    const verify = vi.spyOn(s.deps.auth, 'verifyPassword')
    const login = (password: string) => s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    try {
      const statuses = (await Promise.all(Array.from({ length: 20 }, () => login('nope')))).map((res) => res.status)
      expect(verify).toHaveBeenCalledTimes(5)
      expect(statuses.filter((status) => status === 401)).toHaveLength(5)
      expect(statuses.filter((status) => status === 429)).toHaveLength(15)
      // A correct login clears its own reservation, so it leaves all five attempts for later.
      s.deps.auth.clearLoginAttempts('127.0.0.1')
      expect((await login(PASSWORD)).status).toBe(200)
      for (let i = 0; i < 5; i += 1) expect((await login('nope')).status).toBe(401)
    } finally {
      verify.mockRestore()
      s.deps.auth.clearLoginAttempts('127.0.0.1')
    }
  })

  it('a correct login releases only its own reservation, not concurrent failures', async () => {
    s.deps.auth.clearLoginAttempts('127.0.0.1')
    const login = (password: string) => s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    try {
      const statuses = (await Promise.all([login(PASSWORD), ...Array.from({ length: 4 }, () => login('nope'))])).map((res) => res.status)
      expect(statuses.toSorted()).toEqual([200, 401, 401, 401, 401])
      expect((await login('nope')).status).toBe(401)
      expect((await login('nope')).status).toBe(429)
    } finally {
      s.deps.auth.clearLoginAttempts('127.0.0.1')
    }
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
    // Profile-bound viewers cannot write plugin settings or update executable plugin code.
    const pluginSave = await s.get('/api/plugins/settings', { method: 'POST', headers: { cookie: session!, 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops', 'content-type': 'application/json' }, body: JSON.stringify({ key: 'p', values: {} }) })
    expect(pluginSave.status).toBe(403)
    expect(await pluginSave.json()).toEqual({ error: 'Owner session required' })
    const pluginUpdate = await s.get('/api/plugins/update', { method: 'POST', headers: { cookie: session!, 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops', 'content-type': 'application/json' }, body: JSON.stringify({ key: 'p', accept_caution: true }) })
    expect(pluginUpdate.status).toBe(403)
    expect(await pluginUpdate.json()).toEqual({ error: 'Owner session required' })
    const out =await s.get('/api/auth/logout', { method: 'POST', headers: { cookie: session!, 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops' } })
    expect(await out.json()).toEqual({ ok: true, trusted_logout_url: 'https://sso.example/logout' })
  })
})

describe('trusted-header auth on an isolated profile instance', () => {
  // Every gated route refuses the mismatched binding; the public bootstrap and auth status report it logged out.
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
      for (const groups of ['bob-team', 'strangers']) {
        const headers = { 'X-Remote-User': 'mallory', 'X-Remote-Groups': groups }
        const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers })).json())
        expect(boot, groups).toMatchObject({ csrf_token: '', profile: null, onboarding: null, auth: { logged_in: false } })
        expect(AuthStatusSchema.parse(await (await s.get('/api/auth/status', { headers })).json()).logged_in, groups).toBe(false)
      }
      for (const route of ROUTES) {
        for (const groups of ['bob-team', 'strangers']) {
          const res = await s.get(route, { headers: { 'X-Remote-User': 'mallory', 'X-Remote-Groups': groups } })
          expect(res.status, `${route} as ${groups}`).toBe(403)
          expect(await res.json()).toEqual({ error: 'Profile access forbidden' })
        }
        const ok = await s.get(route, { headers: { 'X-Remote-User': 'alice', 'X-Remote-Groups': 'alice-team' } })
        expect([401, 403], route).not.toContain(ok.status)
      }
      const boot = BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers: { 'X-Remote-User': 'alice', 'X-Remote-Groups': 'alice-team' } })).json())
      expect(boot.auth.logged_in && boot.profile?.name).toBe('alice')
      expect(boot.csrf_token).not.toBe('')
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

describe('pre-auth request hardening', () => {
  let s: TestServer
  const password = 'synthetic-login-password'
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: password } }) })
  afterAll(() => s.close())

  const postBody = (path: string, bytes: number, chunked: boolean, headers: Record<string, string> = {}): Promise<{ status: number; body: string; cookies: string[] }> => new Promise((resolve, reject) => {
    const json = JSON.stringify({ password })
    const body = json + ' '.repeat(bytes - Buffer.byteLength(json))
    const req = request(s.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(!chunked ? { 'content-length': String(bytes) } : {}), ...headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode!, body: text, cookies: res.headers['set-cookie'] ?? [] }) })
      res.on('error', reject)
    })
    req.on('error', reject)
    // Multiple individually sub-limit writes exercise cumulative chunked counting.
    for (let offset = 0; offset < body.length; offset += 8192) req.write(body.slice(offset, offset + 8192))
    req.end()
  })

  for (const chunked of [false, true]) {
    const framing = chunked ? 'chunked' : 'declared'
    it.each([
      '/api/auth/login',
      '/api/auth/oidc/native/start',
      '/api/auth/oidc/native/exchange',
      '/api/auth/oidc/native/cancel',
      '/api/auth/passkey/options',
      '/api/auth/passkey/login',
    ])(`rejects a ${framing} public auth body one byte over 64 KiB at %s`, async (path) => {
      const res = await postBody(path, 64 * 1024 + 1, chunked)
      expect(res.status).toBe(413)
      expect((JSON.parse(res.body) as { error: string }).error).toContain('max 65536')
    })

    it(`rejects a 65 KiB ${framing} login body`, async () => {
      expect((await postBody('/api/auth/login', 65 * 1024, chunked)).status).toBe(413)
    })

    it(`allows a ${framing} login at exactly 64 KiB and creates a working session`, async () => {
      const res = await postBody('/api/auth/login', 64 * 1024, chunked)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ ok: true })
      const cookie = cookieHeader(res.cookies, 'hermes_session')!
      expect(cookie).toBeTruthy()
      const status = await s.get('/api/auth/status', { headers: { cookie } })
      expect(await status.json()).toMatchObject({ logged_in: true })
      const boot = await s.get('/api/bootstrap', { headers: { cookie } })
      const { csrf_token: csrf } = await boot.json() as { csrf_token: string }
      const headers = { cookie, 'X-Hermes-CSRF-Token': csrf }
      expect((await postBody('/api/auth/passkeys', 65 * 1024, chunked, headers)).status).toBe(200)
      const oversized = await postBody('/api/auth/passkeys', 20 * 1024 * 1024 + 1, chunked, headers)
      expect(oversized.status).toBe(413)
      expect((JSON.parse(oversized.body) as { error: string }).error).toContain('max 20971520')
      const escape = await postBody('/api/escape/authorize', 4097, chunked, headers)
      expect(escape.status).toBe(400)
      expect((JSON.parse(escape.body) as { error: string }).error).toContain('max 4096')
    })
  }

  it('never takes the logged client from X-Real-IP or a scoped IPv6 hop', () => {
    const env = s.deps.config.env
    const record = (headers: Record<string, string>): Record<string, unknown> => {
      const socket = new Socket()
      Object.defineProperty(socket, 'remoteAddress', { value: '10.0.0.1' })
      const req = new IncomingMessage(socket)
      req.method = 'GET'
      req.url = '/api/auth/status'
      req.headers = headers
      new RequestContext(req, new ServerResponse(req), s.deps).logRequest(200)
      return JSON.parse(s.logs.at(-1)!.slice('[webui] '.length)) as Record<string, unknown>
    }
    env.HERMES_WEBUI_TRUST_FORWARDED_FOR = '1'
    env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS = '10.0.0.0/8'
    try {
      // A proxy relays a client-supplied X-Real-IP unchanged, so it never names the logged client.
      expect(record({ 'x-real-ip': '203.0.113.77' })).not.toHaveProperty('forwarded_for')
      // A zone id is free-form header text, so a scoped hop never becomes the logged client.
      expect(record({ 'x-forwarded-for': 'fe80::1%syntheticmarker' })).not.toHaveProperty('forwarded_for')
    } finally {
      delete env.HERMES_WEBUI_TRUST_FORWARDED_FOR
      delete env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS
    }
  })

  it('logs forwarded clients only from a validated chain with opt-in and a trusted raw peer', async () => {
    const env = s.deps.config.env
    const lines: string[] = []
    const record = (peer: string, forwarded?: string | string[], realIp?: string): Record<string, unknown> => {
      const socket = new Socket()
      Object.defineProperty(socket, 'remoteAddress', { value: peer })
      const req = new IncomingMessage(socket)
      req.method = 'GET'
      req.url = '/api/auth/status'
      req.headers = { ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }), ...(realIp ? { 'x-real-ip': realIp } : {}) }
      const before = s.logs.length
      new RequestContext(req, new ServerResponse(req), s.deps).logRequest(200)
      lines.push(...s.logs.slice(before))
      return JSON.parse(s.logs.at(-1)!.slice('[webui] '.length)) as Record<string, unknown>
    }
    // Only the forwarding fields, so every assertion also proves the two are mutually exclusive.
    const fields = (rec: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(rec).filter(([key]) => key.startsWith('forwarded_for')))
    const ignored = { forwarded_for_ignored: true }
    const scoped = 'fe80::1%syntheticmarker'
    const oversized = 'x'.repeat(15_000)

    // Opt-in off: a forwarded header is never trusted, but the record says it was dropped.
    expect(fields(record('127.0.0.1', '203.0.113.9'))).toEqual(ignored)
    env.HERMES_WEBUI_TRUST_FORWARDED_FOR = '1'
    env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS = '10.0.0.0/8'
    try {
      expect(fields(record('10.0.0.1', undefined, '203.0.113.77'))).toEqual({})
      expect(fields(record('10.0.0.1', 'bad', '203.0.113.77'))).toEqual(ignored)
      expect(fields(record('10.0.0.1', scoped))).toEqual(ignored)
      expect(fields(record('10.0.0.1', `203.0.113.9, ${scoped}`))).toEqual(ignored)

      // A valid trusted chain resolves to one canonical address; repeated headers keep wire order.
      expect(record('10.0.0.1', '203.0.113.9, 10.0.0.2')).toMatchObject({ remote: '10.0.0.1', forwarded_for: '203.0.113.9' })
      expect(fields(record('10.0.0.1', ['198.51.100.7', '203.0.113.9, 10.0.0.2']))).toEqual({ forwarded_for: '203.0.113.9' })
      expect(fields(record('10.0.0.1', ['203.0.113.9', '198.51.100.7']))).toEqual({ forwarded_for: '198.51.100.7' })
      expect(fields(record('::ffff:10.0.0.1', '203.0.113.9'))).toEqual({ forwarded_for: '203.0.113.9' })
      expect(fields(record('10.0.0.1', '::ffff:203.0.113.9, ::ffff:10.0.0.2'))).toEqual({ forwarded_for: '203.0.113.9' })
      expect(fields(record('10.0.0.1', '0:0:0:0:0:ffff:cb00:7109'))).toEqual({ forwarded_for: '203.0.113.9' })
      expect(fields(record('10.0.0.1', '2001:0DB8:0000:0000:0000:0000:0000:0001'))).toEqual({ forwarded_for: '2001:db8::1' })
      const client = record('10.0.0.1', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff').forwarded_for
      expect(client).toBe('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff')

      // A nonblank chain that names no client other than the peer is flagged, never echoed.
      for (const [peer, chain] of [
        ['198.51.100.1', '203.0.113.9'], // untrusted peer
        ['10.0.0.1', 'bad, 10.0.0.2'], // malformed hop
        ['10.0.0.1', '203.0.113.9,'], // trailing comma
        ['10.0.0.1', ' , '], // separators only
        ['10.0.0.1', oversized],
        ['10.0.0.1', '10.0.0.3, 10.0.0.2'], // every hop is a trusted proxy
        ['::ffff:10.0.0.1', '10.0.0.1'], // resolves to the peer itself
      ] as const) expect(fields(record(peer, chain)), `${peer} ${chain.slice(0, 40)}`).toEqual(ignored)

      // No XFF, or only blank values: neither field, so the plain record is unchanged.
      for (const chain of [undefined, [], '', '   ', ['', ' ']]) expect(fields(record('10.0.0.1', chain)), JSON.stringify(chain)).toEqual({})
      expect(fields(record('198.51.100.1', undefined))).toEqual({})

      // One warning per process for an untrusted proxy, however many first requests arrive together.
      await Promise.all(['198.51.100.2', '198.51.100.3', '198.51.100.4'].map(async (peer) => { await Promise.resolve(); record(peer, oversized) }))
      record('198.51.100.5', '203.0.113.9')
      const warnings = lines.filter((line) => line.includes('HERMES_WEBUI_TRUSTED_PROXY_CIDRS'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('198.51.100.1')
      // Hostile header text never reaches a warning or a record.
      for (const line of lines) {
        expect(line).not.toContain('syntheticmarker')
        expect(line).not.toContain('xxxxxxxx')
        expect(line).not.toContain('bad')
        expect(line).not.toContain('203.0.113.77')
      }
    } finally {
      delete env.HERMES_WEBUI_TRUST_FORWARDED_FOR
      delete env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS
    }
  })
})
