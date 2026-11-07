import { useJsonStorage } from '../test/storage.js'
import type * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

useJsonStorage()

/** Counts descriptor reads that return bytes holding `marker`, whichever sync or async API serves them. */
const io = vi.hoisted(() => ({ marker: '', reads: 0 }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof fs>()
  const note = (bytes: unknown): void => { if (io.marker && Buffer.isBuffer(bytes) && bytes.includes(io.marker)) io.reads += 1 }
  return {
    ...real,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => { const out = real.readFileSync(...args); note(out); return out }) as typeof fs.readFileSync,
    read: ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null, done: (error: NodeJS.ErrnoException | null, bytes: number, buffer: Buffer) => void) => {
      real.read(fd, buffer, offset, length, position, (error, bytes, out) => { if (!error) note(out.subarray(offset, offset + bytes)); done(error, bytes, out) })
    }) as typeof fs.read,
  }
})

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
    put('spa/dashboard/dist/assets/chunk.js', 'chunk()')
    put('spa/dashboard/dist/.env', 'SECRET=1')
    put('spa/dashboard/dist/tool.py', 'print(1)')
    put('spa/dashboard/plugin_api.py', 'print(1)')
    put('outside.js', 'leak()')
    symlinkSync(join(s.state, 'plugins', 'outside.js'), join(s.state, 'plugins', 'spa/dashboard/dist/link.js'))
    // A legacy IIFE bundle with a stylesheet and the default tab path.
    put('iife/dashboard/manifest.json', JSON.stringify({ label: 'IIFE <Plugin>', css: 'dist/style.css' }))
    put('iife/dashboard/dist/index.js', 'window.iife = 1')
    put('iife/dashboard/dist/style.css', 'body{}')
    // A trailing slash on the tab path still matches the canonical request path.
    put('slash/dashboard/manifest.json', JSON.stringify({ tab: { path: '/reports/' } }))
    put('slash/dashboard/dist/index.html', '<!doctype html><html><head><title>slash</title></head><body></body></html>')
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
    expect(plugins.map((m) => m.id)).toEqual(['iife', 'slash', 'spa'])
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
    // The tab page resolves the document's relative URLs against the panel directory.
    expect(await res.text()).toBe('<!doctype html><head><base href="./dashboard-plugins/spa/"></head><title>spa own</title>')
    // The panel document's relative URLs (`./assets/chunk.js`) resolve inside `dist/`.
    res = await s.get('/dashboard-plugins/spa/assets/chunk.js')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('chunk()')
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

  it('reads each manifest once across 50 asset requests until its signature changes (TAL-1733)', async () => {
    put('cached/dashboard/manifest.json', JSON.stringify({ label: 'Cached one' }))
    put('cached/dashboard/dist/app.js', 'cached()')
    await enable({ cached: true })
    const parses = vi.spyOn(JSON, 'parse')
    onTestFinished(() => { parses.mockRestore() })
    const parsed = (needle: string): number => parses.mock.calls.filter(([raw]) => typeof raw === 'string' && raw.includes(needle)).length
    const responses = await Promise.all(Array.from({ length: 50 }, () => s.get('/dashboard-plugins/cached/dist/app.js')))
    expect(responses.map((res) => res.status)).toEqual(Array.from({ length: 50 }, () => 200))
    expect(parsed('"label":"Cached one"')).toBe(1)
    expect(parsed('"label":"SPA Plugin"')).toBe(1)
    put('cached/dashboard/manifest.json', JSON.stringify({ label: 'Cached second' }))
    expect(await (await s.get('/api/extensions/manifests')).text()).toContain('"name":"Cached second"')
    expect(parsed('"label":"Cached second"')).toBe(1)
    // Removing only the manifest leaves the plugins directory's own signature untouched.
    unlinkSync(join(s.state, 'plugins', 'cached/dashboard/manifest.json'))
    expect((await s.get('/dashboard-plugins/cached/dist/app.js')).status).toBe(404)
  })

  it('revalidates an extension static without rereading it, and rechecks containment on every request (TAL-1733)', async () => {
    const file = join(extensionDir, 'demo', 'cached.html')
    io.marker = 'TAL1733-static'
    onTestFinished(() => { io.marker = ''; io.reads = 0 })
    writeFileSync(file, '<!doctype html><title>TAL1733-static</title>')
    const first = await s.get('/extensions/demo/cached.html')
    expect(await first.text()).toContain('TAL1733-static')
    const second = await s.get('/extensions/demo/cached.html')
    expect(await second.text()).toContain('TAL1733-static')
    expect(io.reads).toBe(1)

    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    const revalidated = await s.get('/extensions/demo/cached.html', { headers: { 'if-none-match': etag ?? '' } })
    expect(revalidated.status).toBe(304)
    expect(await revalidated.text()).toBe('')
    expect(io.reads).toBe(1)
    // The sandbox headers match the unchanged plugin panel path, on the 200 and on the 304.
    await enable({ spa: true })
    const plugin = await s.get('/dashboard-plugins/spa/dist/app.js')
    expect(plugin.status).toBe(200)
    for (const res of [first, revalidated]) {
      expect(res.headers.get('etag')).toBe(etag)
      expect(res.headers.get('content-security-policy')).toBe(plugin.headers.get('content-security-policy'))
      expect(sandboxed(res)).toBe(true)
      frameable(res)
    }
    expect(plugin.headers.get('cache-control')).toBe('no-store')

    writeFileSync(file, '<!doctype html><title>TAL1733-static changed</title>')
    const changed = await s.get('/extensions/demo/cached.html', { headers: { 'if-none-match': etag ?? '' } })
    expect(changed.status).toBe(200)
    expect(await changed.text()).toContain('changed')
    expect(changed.headers.get('etag')).not.toBe(etag)

    // A cached file swapped for a link out of the root stops serving, whatever the cache holds.
    unlinkSync(file)
    symlinkSync(join(s.state, 'plugins', 'outside.js'), file)
    expect((await s.get('/extensions/demo/cached.html')).status).toBe(404)
    unlinkSync(file)
  })

  it('serves a tab page whose manifest path has a trailing slash', async () => {
    await enable({ slash: true })
    for (const path of ['/reports', '/reports/']) {
      const res = await s.get(path)
      expect(res.status, path).toBe(200)
      expect(await res.text()).toContain('<head><base href="./dashboard-plugins/slash/"><title>slash</title>')
    }
  })

  it('toggles a plugin from Settings > Extensions through the extensions toggle, without a restart (TAL-685)', async () => {
    await enable({ spa: false, iife: true })
    const toggle = (id: string, enabled: unknown): Promise<Response> => s.get('/api/extensions/toggle', { method: 'POST', body: JSON.stringify({ id, enabled }), headers: { 'content-type': 'application/json' } })
    const row = async (): Promise<{ enabled: boolean; can_toggle: boolean } | undefined> =>
      ((await (await s.get('/api/extensions/manifests')).json()) as { manifests: { id: string; enabled: boolean; can_toggle: boolean }[] }).manifests.find((m) => m.id === 'spa')
    const prefs = (): unknown => (JSON.parse(readFileSync(join(s.state, 'settings.json'), 'utf8')) as { dashboard_plugins: unknown }).dashboard_plugins
    expect(await row()).toMatchObject({ enabled: false })

    expect((await toggle('spa', true)).status).toBe(200)
    expect(prefs()).toMatchObject({ spa: true, iife: true })
    expect(await row()).toMatchObject({ enabled: true, can_toggle: true })
    for (const path of ['/dashboard-plugins/spa/index.html', '/dashboard-plugins/spa/dist/app.js', '/spa-board']) expect((await s.get(path)).status, path).toBe(200)

    expect((await toggle('spa', false)).status).toBe(200)
    expect(prefs()).toMatchObject({ spa: false, iife: true })
    expect(await row()).toMatchObject({ enabled: false, can_toggle: true })
    for (const path of ['/dashboard-plugins/spa/index.html', '/dashboard-plugins/spa/dist/app.js', '/spa-board']) expect((await s.get(path)).status, path).toBe(404)

    expect((await toggle('spa', 'yes')).status).toBe(400)
    expect((await toggle('ghost', true)).status).toBeGreaterThanOrEqual(400)
    expect(prefs()).toMatchObject({ spa: false, iife: true })
  })

  it('never lets a plugin tab path shadow the app or the API', async () => {
    await enable({ shadow: true, apishadow: true })
    expect((await s.get('/api/sessions')).headers.get('content-type')).toContain('application/json')
    const body = await (await s.get('/api/extensions/manifests')).json() as { manifests: { id: string }[] }
    expect(body.manifests.map((m) => m.id)).not.toContain('shadow')
    expect(body.manifests.map((m) => m.id)).not.toContain('apishadow')
  })
})
