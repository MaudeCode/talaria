import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { previewGrantRoot, previewUrl } from './preview.js'

const PASSWORD = 'preview frame password'
const PREVIEW_CSP = "sandbox allow-scripts allow-popups; default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * TAL-566: an HTML preview's relative assets load from a signed, cookie-free workspace URL.
 * TAL-2196: the grant covers only the previewed file's folder, minus dot-prefixed paths, and the frame cannot call out.
 */
describe('workspace preview route', () => {
  let s: TestServer
  let cookie: string
  let sid: string
  let ws: string
  beforeAll(async () => {
    s = await bootTestServer({ env: { TALARIA_WEB_PASSWORD: PASSWORD } })
    const login = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
    ws = realpathSync(s.workspace)
    const put = (rel: string, text: string) => { writeFileSync(join(ws, rel), text) }
    for (const dir of ['docs/site/img', 'docs/site/.git', 'docs/other', '.git']) mkdirSync(join(ws, dir), { recursive: true })
    put('docs/site/index.html', '<html><head><link rel="stylesheet" href="app.css"></head><body><script src="app.js"></script></body></html>')
    put('docs/site/app.js', 'document.body.dataset.ran = "1"')
    put('docs/site/img/a.png', 'png')
    put('docs/site/.env', 'SITE_SECRET=1')
    put('docs/site/.git/config', '[core]')
    put('docs/other/x.txt', 'sibling')
    put('index.html', '<p>root page</p>')
    put('secret.txt', 'root file')
    put('.env', 'ROOT_SECRET=1')
    put('.git/config', '[core]')
    writeFileSync(join(s.state, 'outside.txt'), 'secret')
    symlinkSync(s.state, join(ws, 'docs/site/escape'))
    symlinkSync('.env', join(ws, 'docs/site/env-link'))
    const created = await s.get('/api/session/new', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ workspace: ws }) })
    sid = ((await created.json()) as { session: { session_id: string } }).session.session_id
  })
  afterAll(() => s.close())

  /** The preview URL `/api/file` mints for `rel`, as a path whose grant segment the cases below reuse. */
  async function previewPath(rel: string): Promise<{ page: URL; grant: string }> {
    const read = await s.get(`/api/file?session_id=${sid}&path=${encodeURIComponent(rel)}`, { headers: { cookie } })
    expect(read.status).toBe(200)
    const { preview, preview_url: url } = (await read.json()) as { preview: string; preview_url: string }
    expect(preview).toBe('html')
    const page = new URL(url, `${s.base}/`)
    return { page, grant: page.pathname.split('/')[2] ?? '' }
  }

  it("serves the page and assets in its folder without a cookie, and nothing outside that folder", async () => {
    const { page, grant } = await previewPath('docs/site/index.html')
    expect(page.pathname).toBe(`/workspace-preview/${grant}/index.html`)

    // The sandboxed frame sends no cookie: the grant in the path is the authority.
    const html = await s.get(page.pathname)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html.headers.get('x-frame-options')).toBeNull()
    expect(html.headers.get('access-control-allow-origin')).toBeNull()
    expect(await html.text()).toContain('app.js')
    const js = await s.get(new URL('app.js', page).pathname)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript')
    expect(await js.text()).toBe('document.body.dataset.ran = "1"')
    expect((await s.get(new URL('img/a.png', page).pathname)).status).toBe(200)

    // Encoded so the request reaches the route rather than being normalized by the URL parser.
    for (const escape of ['..%2F..%2F.env', '%2e%2e%2Fsecret.txt', '..%2Fother%2Fx.txt', '..%2F..%2Fsecret.txt', '..%2F..%2Findex.html', 'escape/outside.txt']) {
      expect((await s.get(`/workspace-preview/${grant}/${escape}`)).status, escape).toBe(404)
    }
    const forged = grant.slice(0, -1) + (grant.endsWith('0') ? '1' : '0')
    expect((await s.get(`/workspace-preview/${forged}/index.html`)).status).toBe(404)
    expect((await s.get('/workspace-preview/index.html')).status).toBe(404)
  })

  it('answers 404 for any dot-prefixed path, including under a workspace-root grant', async () => {
    const { grant: siteGrant } = await previewPath('docs/site/index.html')
    const { page, grant: rootGrant } = await previewPath('index.html')
    expect((await s.get(page.pathname)).status).toBe(200)
    expect((await s.get(`/workspace-preview/${rootGrant}/secret.txt`)).status).toBe(200)
    for (const [grant, rel] of [[rootGrant, '.env'], [rootGrant, '.git/config'], [rootGrant, 'docs/site/.env'], [siteGrant, '.env'], [siteGrant, '.git/config'], [siteGrant, 'env-link']] as const) {
      expect((await s.get(`/workspace-preview/${grant}/${rel}`)).status, rel).toBe(404)
    }
  })

  it('every preview response denies the network, sandbox escapes and referrers', async () => {
    const { page, grant } = await previewPath('docs/site/index.html')
    for (const path of [page.pathname, new URL('app.js', page).pathname]) {
      const res = await s.get(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
    const missing = await s.get(`/workspace-preview/${grant}/.env`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-security-policy') ?? '').not.toContain('allow-popups-to-escape-sandbox')
  })

  it('grants name only the folder they were signed for, and expire', () => {
    const key = Buffer.alloc(32, 7)
    const now = Date.UTC(2026, 9, 6, 12, 30)
    const dir = realpathSync(ws)
    const url = previewUrl(key, dir, 'docs/site/index.html', now)
    expect(url).toMatch(/^workspace-preview\/[A-Za-z0-9_-]+\.\d+\.[0-9a-f]{64}\/index\.html$/)
    const grant = url.split('/')[1] ?? ''
    expect(previewGrantRoot(key, grant, now)).toBe(join(dir, 'docs', 'site'))
    // The HMAC covers the folder: naming another folder under the same signature fails.
    const [, exp, sig] = grant.split('.')
    expect(previewGrantRoot(key, `${Buffer.from(join(dir, 'docs', 'other')).toString('base64url')}.${exp ?? ''}.${sig ?? ''}`, now)).toBeNull()
    expect(previewGrantRoot(key, grant, now + 2 * 3600_000 + 1)).toBeNull()
    expect(previewGrantRoot(Buffer.alloc(32, 8), grant, now)).toBeNull()
    // Within one hour the URL is stable, so a refetch does not reload the frame.
    expect(previewUrl(key, dir, 'docs/site/index.html', now + 60_000)).toBe(url)
  })
})
