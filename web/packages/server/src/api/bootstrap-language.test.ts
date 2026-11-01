/** TAL-1031: bootstrap ships the request's negotiated `browser_language` beside the explicit saved `language`. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootstrapSchema } from '@maudecode/talaria-web-contracts'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'

const FR_CA = 'fr-CA,fr;q=0.9,en;q=0.1'

async function bootstrap(s: TestServer, headers: Record<string, string> = {}) {
  return BootstrapSchema.parse(await (await s.get('/api/bootstrap', { headers })).json())
}

describe('bootstrap language on an open server', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('a fresh state has no saved language and negotiates the browser preference', async () => {
    const boot = await bootstrap(s, { 'accept-language': FR_CA })
    expect(boot.language).toBe('')
    expect(boot.browser_language).toBe('fr')
  })

  it('falls back to English for a missing, unsupported or hostile header', async () => {
    expect((await bootstrap(s)).browser_language).toBe('en')
    expect((await bootstrap(s, { 'accept-language': 'xx-YY, tlh' })).browser_language).toBe('en')
    expect((await bootstrap(s, { 'accept-language': '"><script>alert(1)</script>' })).browser_language).toBe('en')
    expect((await bootstrap(s, { 'accept-language': 'ja;q=0, de;q=0.5' })).browser_language).toBe('de')
  })

  it('saving an unrelated setting keeps the language unset', async () => {
    const saved = await s.get('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sound_enabled: true }) })
    expect(saved.status).toBe(200)
    expect((await s.deps.settings.readRaw()).sound_enabled).toBe(true)
    expect((await s.deps.settings.readRaw()).language).toBeUndefined()
    expect((await bootstrap(s, { 'accept-language': FR_CA })).language).toBe('')
    expect((await s.deps.settings.load()).language).toBe('en')
  })

  it('an explicit saved language is reported as the choice, the negotiated one alongside', async () => {
    const saved = await s.get('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'de' }) })
    expect(saved.status).toBe(200)
    const boot = await bootstrap(s, { 'accept-language': FR_CA })
    expect(boot.language).toBe('de')
    expect(boot.browser_language).toBe('fr')
  })
})

describe('bootstrap language behind password auth', () => {
  let s: TestServer
  const PASSWORD = 'correct horse battery staple'
  beforeAll(async () => { s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD } }) })
  afterAll(() => s.close())

  it('the sign-in page gets the browser preference without reading operator settings', async () => {
    const boot = await bootstrap(s, { 'accept-language': FR_CA })
    expect(boot.auth.logged_in).toBe(false)
    expect(boot.language).toBe('')
    expect(boot.csrf_token).toBe('')
    expect(boot.profile).toBeNull()
    expect(boot.browser_language).toBe('fr')
  })

  it('signing in does not turn the fallback into a saved choice', async () => {
    const res = await s.get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })
    const cookie = cookieHeader(res.headers.getSetCookie(), 'hermes_session')!
    const boot = await bootstrap(s, { cookie, 'accept-language': FR_CA })
    expect(boot.auth.logged_in).toBe(true)
    expect(boot.csrf_token).toMatch(/^[0-9a-f]{64}$/)
    expect(boot.language).toBe('')
    expect(boot.browser_language).toBe('fr')
    expect((await s.deps.settings.readRaw()).language).toBeUndefined()
  })
})
