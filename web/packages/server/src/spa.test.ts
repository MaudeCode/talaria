import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { baseHrefFor, isPublicSpaPath, isSpaPath, quoteAll, SpaShell } from './spa.js'
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

  it('refuses paths that escape the dist root', () => {
    expect(shell.asset('../server.py')).toBeNull()
    expect(shell.asset('/etc/passwd')).toBeNull()
    expect(shell.asset('')).toBeNull()
  })
})
