import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AssetCache, baseHrefFor, isPublicSpaPath, isSpaPath, quoteAll, SpaShell } from './spa.js'
import { WEB_ROOT } from './test/harness.js'

describe('SPA allowlist', () => {
  it.each(['/', '/index.html', '/session/abc123', '/tasks', '/tasks/job-1', '/kanban', '/skills', '/skills/foo', '/memory', '/workspaces', '/profiles', '/todos', '/insights', '/logs', '/settings', '/settings/providers', '/ext/desktop-companion', '/onboarding', '/login', '/share', '/share/tok'])('%s receives the shell', (path) => {
    expect(isSpaPath(path)).toBe(true)
  })

  it.each(['/api/sessions', '/api/', '/api/bootstrap', '/health', '/static/style.css', '/static/dist/assets/x.js', '/assets/x.js', '/session/static/style.css', '/session/manifest.json', '/sw.js', '/manifest.json', '/manifest.webmanifest', '/extensions/app.js', '/plugins/foo/index.js', '/dashboard-plugins/x', '/favicon.ico', '/search', '/nope', '/settingsx', '/tasksy', '/random/path'])('%s never gets the shell', (path) => {
    expect(isSpaPath(path)).toBe(false)
  })

  it.each([['/', './'], ['/index.html', './'], ['/settings', './'], ['/settings/providers', '../'], ['/session/abc', '../'], ['/ext/foo', '../'], ['/share/tok', '../'], ['/tasks/a/b', '../../']])('base href for %s is %s', (path, expected) => {
    expect(baseHrefFor(path)).toBe(expected)
  })

  it('knows the public shell paths', () => {
    expect(isPublicSpaPath('/login')).toBe(true)
    expect(isPublicSpaPath('/share/abc')).toBe(true)
    expect(isPublicSpaPath('/settings')).toBe(false)
  })
})

describe('shell rendering', () => {
  const shell = new SpaShell(resolve(WEB_ROOT, 'static/dist'))

  it.skipIf(!shell.available())('substitutes every placeholder and keeps the build inline-free', () => {
    const html = shell.renderShell('/session/abc', { lang: 'de', version: 'v1.2.3' })
    expect(html).not.toMatch(/__BASE_HREF__|__LANG__|__WEBUI_VERSION__/)
    expect(html).toContain('<base href="../">')
    expect(html).toContain('<html lang="de"')
    expect(html).not.toContain('<script>')
    expect(html).not.toMatch(/onload=|onclick=/)
    expect(html).toContain('type="module"')
    expect(html).toContain('src="./assets/')
  })

  it.skipIf(!shell.available())('rejects a bogus lang', () => {
    expect(shell.renderShell('/', { lang: '"><script>', version: 'v1' })).toContain('<html lang="en"')
  })

  it('percent-encodes versions like urllib.parse.quote(safe="")', () => {
    expect(quoteAll('web-v1.2.3-dirty/x y')).toBe('web-v1.2.3-dirty%2Fx%20y')
    expect(quoteAll("a'b(c)*d~")).toBe('a%27b%28c%29%2Ad~')
  })

  it('reads the stamped frontend build and fails closed without one', () => {
    const root = mkdtempSync(join(tmpdir(), 'talaria-spa-'))
    try {
      const dist = new SpaShell(root)
      expect(dist.buildId()).toBeNull()
      writeFileSync(join(root, 'index.html'), `<html><head><base href="__BASE_HREF__"><meta name="talaria-build" content="${'e'.repeat(64)}"></head></html>`)
      expect(dist.buildId()).toBe('e'.repeat(64))
      writeFileSync(join(root, 'index.html'), '<html><head><meta name="talaria-build" content="web-v1.2.3"></head></html>')
      expect(dist.buildId()).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses paths that escape the dist root', async () => {
    expect(await shell.asset('../server.py')).toBeNull()
    expect(await shell.asset('/etc/passwd')).toBeNull()
    expect(await shell.asset('')).toBeNull()
  })
})

describe('AssetCache', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'talaria-assets-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('lets the event loop progress while a cold asset is read and compressed', async () => {
    writeFileSync(join(root, 'big.js'), 'console.log("cold");\n'.repeat(50_000))
    const cache = new AssetCache(root)
    const order: string[] = []
    setImmediate(() => order.push('immediate'))
    await Promise.resolve(cache.get('big.js')).then(() => order.push('loaded'))
    await new Promise((done) => setImmediate(done))
    expect(order).toEqual(['immediate', 'loaded'])
  })

  it('shares one load between concurrent cold requests and reuses it warm', async () => {
    writeFileSync(join(root, 'big.js'), 'x'.repeat(4096))
    const cache = new AssetCache(root)
    const [a, b] = await Promise.all([cache.get('big.js'), cache.get('big.js')])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(await cache.get('big.js')).toBe(a)
  })

  it.skipIf(process.getuid?.() === 0)('does not cache a failed load and retries it', async () => {
    const file = join(root, 'locked.css')
    writeFileSync(file, 'body{}')
    chmodSync(file, 0o000)
    const cache = new AssetCache(root)
    await expect(cache.get('locked.css')).rejects.toThrow(/EACCES/)
    chmodSync(file, 0o644)
    expect((await cache.get('locked.css'))?.body.toString()).toBe('body{}')
  })

  it('reloads a replaced file and keeps MIME, ETag and gzip rules', async () => {
    writeFileSync(join(root, 'app.js'), 'a'.repeat(2048))
    const cache = new AssetCache(root)
    const first = await cache.get('app.js')
    expect(first?.contentType).toBe('application/javascript; charset=utf-8')
    expect(first?.etag).toMatch(/^W\/"800-[0-9a-f]+"$/)
    expect(first?.gz).not.toBeNull()
    writeFileSync(join(root, 'app.js'), 'b'.repeat(16))
    const second = await cache.get('app.js')
    expect(second?.body.toString()).toBe('b'.repeat(16))
    expect(second?.etag).toMatch(/^W\/"10-[0-9a-f]+"$/)
    expect(second?.gz).toBeNull()
    writeFileSync(join(root, 'icon.png'), Buffer.alloc(4096))
    writeFileSync(join(root, 'blob.bin'), 'z')
    expect(await cache.get('icon.png')).toMatchObject({ contentType: 'image/png', gz: null })
    expect((await cache.get('blob.bin'))?.contentType).toBe('application/octet-stream')
  })

  it('returns null for missing files, directories, and paths outside the root', async () => {
    mkdirSync(join(root, 'dir'))
    const cache = new AssetCache(join(root, 'dir'))
    writeFileSync(join(root, 'outside.js'), 'secret')
    expect(await cache.get('missing.js')).toBeNull()
    expect(await cache.get('.')).toBeNull()
    expect(await cache.get('../outside.js')).toBeNull()
    expect(await cache.get(join(root, 'outside.js'))).toBeNull()
  })
})
