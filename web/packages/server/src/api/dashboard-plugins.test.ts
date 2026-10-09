import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

/** TAL-267: WebUI dashboard plugins under `<plugins>/<name>/dashboard/` (Python `api/plugins.py`). */
describe('dashboard plugin routes', () => {
  let s: TestServer
  const extensionDir = mkdtempSync(join(tmpdir(), 'talaria-extension-dir-'))
  const put = (rel: string, body: string): void => {
    const file = join(s.state, 'plugins', rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  const sandboxed = (res: Response): boolean => (res.headers.get('content-security-policy') ?? '').includes('sandbox allow-scripts')
  /** The app frames the panel itself: no `frame-ancestors 'none'` (enforced or report-only), same-origin framing allowed. */
  const frameable = (res: Response): void => {
    expect(res.headers.get('content-security-policy')).not.toContain("frame-ancestors 'none'")
    expect(res.headers.get('content-security-policy-report-only')).toBeNull()
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  }
  const enable = (prefs: Record<string, boolean>): Promise<unknown> => s.deps.settings.save({ dashboard_plugins: prefs })

  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_EXTENSION_DIR: extensionDir } })
    mkdirSync(join(extensionDir, 'demo'))
    writeFileSync(join(extensionDir, 'demo', 'index.html'), '<!doctype html><title>demo</title>')
    put('plugin.css', '.shared{}')
    put('secret.css', '.nope{}')
    // A full SPA build with its own document and a custom tab path.
    put('spa/dashboard/manifest.json', JSON.stringify({ name: 'spa', label: 'SPA Plugin', version: '1.2.0', tab: { path: '/spa-board', name: 'Board' } }))
    put('spa/dashboard/dist/index.html', '<!doctype html><title>spa own</title>')
    put('spa/dashboard/dist/app.js', 'console.log(1)')
    put('spa/dashboard/dist/.env', 'SECRET=1')
    put('spa/dashboard/dist/tool.py', 'print(1)')
    put('spa/dashboard/plugin_api.py', 'print(1)')
    put('outside.js', 'leak()')
    symlinkSync(join(s.state, 'plugins', 'outside.js'), join(s.state, 'plugins', 'spa/dashboard/dist/link.js'))
    // A legacy IIFE bundle with a stylesheet and the default tab path.
    put('iife/dashboard/manifest.json', JSON.stringify({ label: 'IIFE <Plugin>', css: 'dist/style.css' }))
    put('iife/dashboard/dist/index.js', 'window.iife = 1')
    put('iife/dashboard/dist/style.css', 'body{}')
    // Manifests that would shadow the app, collide, or are unsafe are skipped.
    put('shadow/dashboard/manifest.json', JSON.stringify({ tab: { path: '/settings' } }))
    put('apishadow/dashboard/manifest.json', JSON.stringify({ tab: { path: '/api/sessions' } }))
    put('zdupe/dashboard/manifest.json', JSON.stringify({ name: 'spa' }))
    put('bad/dashboard/manifest.json', JSON.stringify({ name: '../bad' }))
    put('broken/dashboard/manifest.json', '{')
  })
  afterAll(async () => { await s.close(); rmSync(extensionDir, { recursive: true, force: true }) })

  it('serves only the shared plugin.css from the plugin base', async () => {
    const res = await s.get('/plugins/plugin.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await res.text()).toBe('.shared{}')
    expect((await s.get('/plugins/secret.css')).status).toBe(404)
    expect(await s.rawStatus('/plugins/../plugins/secret.css')).toBe(404)
  })

  it('lists every valid plugin in the extension manifests, disabled by default', async () => {
    await enable({})
    const body = await (await s.get('/api/extensions/manifests')).json() as { manifests: { id: string; source: string; enabled: boolean; panel: string; nav: { label: string }; name: string }[] }
    const plugins = body.manifests.filter((m) => m.source === 'plugin')
    expect(plugins.map((m) => m.id)).toEqual(['iife', 'spa'])
    expect(plugins.find((m) => m.id === 'spa')).toMatchObject({ name: 'SPA Plugin', enabled: false, panel: 'dashboard-plugins/spa/index.html', nav: { label: 'Board' } })
  })

  it('answers 404 on every surface of a disabled plugin', async () => {
    await enable({ spa: false })
    for (const path of ['/dashboard-plugins/spa/index.html', '/dashboard-plugins/spa/dist/app.js', '/spa-board', '/dashboard-plugins/iife/index.html', '/iife']) expect((await s.get(path)).status, path).toBe(404)
  })

  it('serves an enabled SPA-build plugin panel, tab page, and assets under the sandbox CSP', async () => {
    await enable({ spa: true, iife: true })
    let res = await s.get('/dashboard-plugins/spa/index.html')
    expect(res.status).toBe(200)
    expect(sandboxed(res)).toBe(true)
    frameable(res)
    expect(await res.text()).toBe('<!doctype html><title>spa own</title>')
    res = await s.get('/spa-board')
    expect(res.status).toBe(200)
    expect(sandboxed(res)).toBe(true)
    expect(await res.text()).toContain('spa own')
    res = await s.get('/dashboard-plugins/spa/dist/app.js')
    expect(res.status).toBe(200)
    expect(sandboxed(res)).toBe(true)
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
  })

  it('keeps plugin source, config, dotfiles, and escapes out of the asset route', async () => {
    await enable({ spa: true })
    for (const path of ['/dashboard-plugins/spa/manifest.json', '/dashboard-plugins/spa/plugin_api.py', '/dashboard-plugins/spa/dist/.env', '/dashboard-plugins/spa/dist/tool.py', '/dashboard-plugins/spa/dist/link.js', '/dashboard-plugins/nope/dist/app.js']) expect((await s.get(path)).status, path).toBe(404)
    expect(await s.rawStatus('/dashboard-plugins/spa/dist/../manifest.json')).toBe(404)
    expect(await s.rawStatus('/dashboard-plugins/spa/dist/../../../outside.js')).toBe(404)
  })

  it('wraps a legacy IIFE plugin in a panel that loads the SDK and in a tab page at the default path', async () => {
    await enable({ iife: true })
    let res = await s.get('/dashboard-plugins/iife/index.html')
    expect(res.status).toBe(200)
    expect(sandboxed(res)).toBe(true)
    frameable(res)
    const panel = await res.text()
    expect(panel).toContain('<title>IIFE &lt;Plugin&gt;</title>')
    expect(panel).toContain('<link rel="stylesheet" href="dist/style.css">')
    expect(panel).toContain('<script src="../../static/dist/extension-sdk.js"></script><script src="dist/index.js"></script>')
    res = await s.get('/iife')
    expect(res.status).toBe(200)
    expect(sandboxed(res)).toBe(true)
    const page = await res.text()
    expect(page).toContain('<link rel="stylesheet" href="/dashboard-plugins/iife/dist/style.css">')
    expect(page).toContain('<script src="/dashboard-plugins/iife/dist/index.js"></script>')
  })

  it('lets the app frame an extension panel document under the same sandbox', async () => {
    const res = await s.get('/extensions/demo/index.html')
    expect(res.status).toBe(200)
    expect(sandboxed(res)).toBe(true)
    frameable(res)
  })

  it('never lets a plugin tab path shadow the app or the API', async () => {
    await enable({ shadow: true, apishadow: true })
    expect((await s.get('/api/sessions')).headers.get('content-type')).toContain('application/json')
    const body = await (await s.get('/api/extensions/manifests')).json() as { manifests: { id: string }[] }
    expect(body.manifests.map((m) => m.id)).not.toContain('shadow')
    expect(body.manifests.map((m) => m.id)).not.toContain('apishadow')
  })
})
