import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { previewGrantRoot, previewUrl } from './preview.js'

const PASSWORD = 'preview frame password'

/** TAL-566: an HTML preview's relative assets load from a signed, cookie-free workspace URL. */
describe('workspace preview route', () => {
  let s: TestServer
  let cookie: string
  let sid: string
  let ws: string
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD } })
    const login = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
    ws = realpathSync(join(s.state, 'workspace'))
    mkdirSync(join(ws, 'site', 'css'), { recursive: true })
    writeFileSync(join(ws, 'site', 'index.html'), '<html><head><link rel="stylesheet" href="css/app.css"></head><body><script src="../app.js"></script></body></html>')
    writeFileSync(join(ws, 'site', 'css', 'app.css'), 'body { color: teal }')
    writeFileSync(join(ws, 'app.js'), 'document.body.dataset.ran = "1"')
    writeFileSync(join(s.state, 'outside.txt'), 'secret')
    symlinkSync(s.state, join(ws, 'escape'))
    const created = await s.get('/api/session/new', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ workspace: ws }) })
    sid = ((await created.json()) as { session: { session_id: string } }).session.session_id
  })
  afterAll(() => s.close())

  it('serves the page and its relative assets without a cookie, inside the workspace only', async () => {
    const read = await s.get(`/api/file?session_id=${sid}&path=site/index.html`, { headers: { cookie } })
    expect(read.status).toBe(200)
    const { preview, preview_url: url } = (await read.json()) as { preview: string; preview_url: string }
    expect(preview).toBe('html')
    expect(url).toMatch(/^workspace-preview\/[A-Za-z0-9_-]+\.\d+\.[0-9a-f]{64}\/site\/index\.html$/)
    const page = new URL(url, `${s.base}/`)

    // The sandboxed frame sends no cookie: the grant in the path is the authority.
    const html = await s.get(page.pathname)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox')
    expect(html.headers.get('x-frame-options')).toBeNull()
    expect(html.headers.get('access-control-allow-origin')).toBeNull()
    expect(await html.text()).toContain('css/app.css')
    const css = await s.get(new URL('css/app.css', page).pathname)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toBe('text/css')
    expect(await css.text()).toBe('body { color: teal }')
    const js = await s.get(new URL('../app.js', page).pathname)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript')

    const grant = page.pathname.split('/')[2] ?? ''
    expect((await s.get(`/workspace-preview/${grant}/..%2Foutside.txt`)).status).toBe(404)
    expect((await s.get(`/workspace-preview/${grant}/escape/outside.txt`)).status).toBe(404)
    const forged = grant.slice(0, -1) + (grant.endsWith('0') ? '1' : '0')
    expect((await s.get(`/workspace-preview/${forged}/site/index.html`)).status).toBe(404)
    expect((await s.get('/workspace-preview/site/index.html')).status).toBe(404)
  })

  it('grants expire and name only the root they were signed for', () => {
    const key = Buffer.alloc(32, 7)
    const now = Date.UTC(2026, 9, 6, 12, 30)
    const grant = (previewUrl(key, '/w', 'a.html', now).split('/')[1]) ?? ''
    expect(previewGrantRoot(key, grant, now)).toBe('/w')
    expect(previewGrantRoot(key, grant, now + 2 * 3600_000 + 1)).toBeNull()
    expect(previewGrantRoot(Buffer.alloc(32, 8), grant, now)).toBeNull()
    // Within one hour the URL is stable, so a refetch does not reload the frame.
    expect(previewUrl(key, '/w', 'a.html', now + 60_000)).toBe(previewUrl(key, '/w', 'a.html', now))
  })
})
