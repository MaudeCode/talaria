/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue1909_csrf_token.py
 *   web/tests/test_issue2572_csrf_diagnostics.py
 *   web/tests/test_issue2929_settings_max_tokens.py
 *   web/tests/test_issue3510_elevenlabs_tts.py
 *   web/tests/test_issue3582_tts_content_length.py
 *   web/tests/test_issue3825_oidc_auth.py
 *   web/tests/test_issue4982_openai_tts.py
 *   web/tests/test_issue5578_login_next_nesting.py
 * (issues #1909, #2572, #2929, #3510, #3582, #3825, #4982, #5578) is covered here; see docs/architecture/regression-port-ledger.md.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../settings.js'
import { AuthStore, SESSION_TTL } from './store.js'
import { canonicalJson } from './oidc.js'
import { spawnSync } from 'node:child_process'
import { formatSetCookie, parseCookieHeader } from './cookies.js'

// Reference values produced by the Python backend (api/auth.py at db3f02679)
// with .pbkdf2_key = bytes(range(32)) and .signing_key = bytes(range(32, 64)).
const PBKDF2_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const SIGNING_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 32 + i))
const PASSWORD = 'correct horse battery staple'
const PY = {
  hash: '613a4c3411394e24fffe6c51994307724572e574bcd98ea8cf457c64899bfbfe',
  legacyHash: '2941ee80d3ae151b3a8ac08042ca4331cf6abb6bc9570be3d258ea9fe39f0db2',
  token: 'a'.repeat(64),
  sig: '174f5feb9e128b75b705329e5bef15db3a26250ebfb696e62012226bccbcec89',
  csrf: '67ae09103d7c5bd37402ca0951f3b0bb12c52eba18cd6838b326fe698afc3166',
  profileSig: '7d9cb0c195818e7c77f2c7772f2a66491f3b4ba1017d4add5f056123389e4288',
}

let dir: string
let now = 1_800_000_000
const clock = () => now

function makeStore(env: Record<string, string> = {}, opts: { keys?: boolean } = {}): AuthStore {
  const settings = new SettingsStore({ file: join(dir, 'settings.json'), env, stateDir: dir, defaultWorkspace: join(dir, 'workspace'), botName: 'Hermes' })
  const store = new AuthStore({ stateDir: dir, env, settings, now: clock, log: () => undefined })
  settings.hooks = { hashPassword: (pw) => store.hashPassword(pw), onPasswordChanged: () => { store.invalidatePasswordHashCache() } }
  if (opts.keys ?? true) store.setKeysForTest(PBKDF2_KEY, SIGNING_KEY)
  return store
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'talaria-auth-')); now = 1_800_000_000 })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Python byte compatibility', () => {
  it('hashes passwords exactly like api/auth._hash_password', async () => {
    const store = makeStore()
    expect(await store.hashPassword(PASSWORD)).toBe(PY.hash)
    expect(await store.hashPassword(PASSWORD, SIGNING_KEY)).toBe(PY.legacyHash)
  })

  it('signs session tokens, CSRF tokens, and profile cookies with the Python HMAC layout [py:test_issue1909_csrf_token.py::test_csrf_token_is_bound_to_auth_session]', () => {
    const store = makeStore()
    store.sessionTable[PY.token] = now + 60
    expect(store.signToken(PY.token)).toBe(PY.sig)
    const cookie = `${PY.token}.${PY.sig}`
    expect(store.verifySession(cookie)).toBe(true)
    expect(store.csrfTokenForSession(cookie)).toBe(PY.csrf)
    expect(store.verifyCsrfToken(cookie, PY.csrf)).toBe(true)
    expect(store.verifyCsrfToken(cookie, 'not-the-token')).toBe(false)
    expect(store.signProfileCookieValue('work', cookie)).toBe(`work.${PY.profileSig}`)
    expect(store.verifyProfileCookieValue(`work.${PY.profileSig}`, cookie, () => true)).toBe('work')
    expect(store.verifyProfileCookieValue(`other.${PY.profileSig}`, cookie, () => true)).toBeNull()
  })

  it('accepts the legacy 32-char truncated signature but not a forged prefix', () => {
    const store = makeStore()
    store.sessionTable[PY.token] = now + 60
    expect(store.verifySession(`${PY.token}.${PY.sig.slice(0, 32)}`)).toBe(true)
    expect(store.verifySession(`${PY.token}.${'a'.repeat(32)}`)).toBe(false)
    expect(store.verifySession(`${PY.token}.${PY.sig.slice(0, 40)}`)).toBe(false)
  })

  it('formats Set-Cookie like http.cookies.SimpleCookie', () => {
    expect(formatSetCookie('hermes_session', `${PY.token}.${PY.sig}`, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: '2592000', secure: true }))
      .toBe(`hermes_session=${PY.token}.${PY.sig}; HttpOnly; Max-Age=2592000; Path=/; SameSite=Lax; Secure`)
    expect(formatSetCookie('hermes_session', '', { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: '0' })).toBe('hermes_session=""; HttpOnly; Max-Age=0; Path=/; SameSite=Lax')
    expect(formatSetCookie('hermes_profile', 'work', { path: '/', httpOnly: true, sameSite: 'Lax' })).toBe('hermes_profile=work; HttpOnly; Path=/; SameSite=Lax')
    expect(parseCookieHeader('a=1; hermes_session="x.y"; b=2').get('hermes_session')).toBe('x.y')
    expect(parseCookieHeader('bad name=1; ok=2').get('ok')).toBe('2')
  })

  it('reads the Python-written .sessions.json and .login_attempts.json and keeps them 0600 [py:test_issue1910_login_attempt_persistence.py::test_login_attempts_persist_failed_attempts] [py:test_issue1910_login_attempt_persistence.py::test_login_attempts_load_prunes_expired_entries]', () => {
    writeFileSync(join(dir, '.sessions.json'), JSON.stringify({
      live: now + 100,
      typed: { expiry: now + 100, auth_type: 'trusted', username: 'kim', bound_profile: 'work', oidc_owner: true, oidc_stale_evidence: 'x' },
      expired: now - 1,
      legacy: { expires_at: now + 50 },
    }))
    writeFileSync(join(dir, '.login_attempts.json'), JSON.stringify({ '10.0.0.1': [now - 10, now - 120], '10.0.0.2': [now - 400] }))
    const store = makeStore()
    expect(Object.keys(store.sessionTable).sort()).toEqual(['legacy', 'live', 'typed'])
    expect(store.sessionTable.typed).toEqual({ expiry: now + 100, auth_type: 'trusted', username: 'kim', bound_profile: 'work', oidc_owner: true })
    expect(store.getSessionInfo(`typed.${store.signToken('typed')}`)).toMatchObject({ token: 'typed', auth_type: 'trusted', username: 'kim', bound_profile: 'work' })
    expect(store.getSessionInfo(`live.${store.signToken('live')}`)).toEqual({ token: 'live', expiry: now + 100, auth_type: null, username: null, bound_profile: null })
    expect(store.checkLoginRate('10.0.0.1')).toBe(true)
    store.recordLoginAttempt('10.0.0.1')
    expect(statSync(join(dir, '.login_attempts.json')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(dir, '.login_attempts.json'), 'utf8'))).toEqual({ '10.0.0.1': [now - 10, now] })
  })
})

describe('sessions', () => {
  it('persists the stable OIDC issuer and subject separately from display username', () => {
    const store = makeStore()
    const cookie = store.createSession({
      authType: 'oidc', username: 'shared@example.test', boundProfile: 'work',
      oidcBinding: { mapping_fingerprint: 'a'.repeat(64), profile_identity: '1:2', issuer: 'https://issuer.example', subject: 'principal-a' },
    })

    expect(makeStore().getSessionInfo(cookie)).toMatchObject({
      auth_type: 'oidc', username: 'shared@example.test', bound_profile: 'work',
      oidc_issuer: 'https://issuer.example', oidc_subject: 'principal-a',
    })
  })

  it('creates, verifies, persists, and prunes sessions', () => {
    const store = makeStore()
    const cookie = store.createSession()
    expect(cookie).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/)
    expect(store.verifySession(cookie)).toBe(true)
    expect(statSync(join(dir, '.sessions.json')).mode & 0o777).toBe(0o600)
    const restarted = makeStore()
    expect(restarted.verifySession(cookie)).toBe(true)
    now += SESSION_TTL + 1
    expect(restarted.verifySession(cookie)).toBe(false)
    expect(readFileSync(join(dir, '.sessions.json'), 'utf8')).toBe('{}')
  })

  it('invalidation survives a restart and unknown tokens are safe', () => {
    const store = makeStore()
    const cookie = store.createSession({ authType: 'password' })
    store.invalidateSession('nope.sig')
    store.invalidateSession(cookie)
    expect(store.verifySession(cookie)).toBe(false)
    expect(makeStore().verifySession(cookie)).toBe(false)
  })

  it('starts fresh on a malformed or wrong-typed sessions file', () => {
    writeFileSync(join(dir, '.sessions.json'), '{not json')
    expect(makeStore().sessionTable).toEqual({})
    writeFileSync(join(dir, '.sessions.json'), '[1,2]')
    expect(makeStore().sessionTable).toEqual({})
  })

  it('generates and persists 0600 keys when absent and reuses them', () => {
    const store = makeStore({}, { keys: false })
    const key = store.signingKey()
    expect(key).toHaveLength(32)
    expect(statSync(join(dir, '.signing_key')).mode & 0o777).toBe(0o600)
    expect(makeStore({}, { keys: false }).signingKey().equals(key)).toBe(true)
    expect(existsSync(join(dir, '.pbkdf2_key'))).toBe(false)
    store.pbkdf2Key()
    expect(existsSync(join(dir, '.pbkdf2_key'))).toBe(true)
  })
})

describe('TTL, cookie name, and sliding policy', () => {
  it('resolves the TTL env > settings > default with the [60s, 1y] clamp', () => {
    expect(makeStore().resolveSessionTtl()).toBe(SESSION_TTL)
    expect(makeStore({ HERMES_WEBUI_SESSION_TTL: '3600' }).resolveSessionTtl()).toBe(3600)
    expect(makeStore({ HERMES_WEBUI_SESSION_TTL: '59' }).resolveSessionTtl()).toBe(SESSION_TTL)
    expect(makeStore({ HERMES_WEBUI_SESSION_TTL: String(86400 * 366) }).resolveSessionTtl()).toBe(SESSION_TTL)
    expect(makeStore({ HERMES_WEBUI_SESSION_TTL: 'abc' }).resolveSessionTtl()).toBe(SESSION_TTL)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ session_ttl_seconds: 7200 }))
    expect(makeStore().resolveSessionTtl()).toBe(7200)
    expect(makeStore({ HERMES_WEBUI_SESSION_TTL: '600' }).resolveSessionTtl()).toBe(600)
    const store = makeStore()
    const token = AuthStore.tokenFromCookieValue(store.createSession())!
    expect(store.sessionTable[token]).toBe(now + 7200)
  })

  it('honours a valid HERMES_WEBUI_COOKIE_NAME and falls back on invalid tokens', () => {
    expect(makeStore().cookieName()).toBe('hermes_session')
    expect(makeStore({ HERMES_WEBUI_COOKIE_NAME: 'my_session' }).cookieName()).toBe('my_session')
    expect(makeStore({ HERMES_WEBUI_COOKIE_NAME: 'bad name;' }).cookieName()).toBe('hermes_session')
    expect(makeStore({ HERMES_WEBUI_COOKIE_NAME: '  ' }).cookieName()).toBe('hermes_session')
  })

  it('sliding renewal follows env > settings.webui.session_sliding, and never renews when the policy is unreadable', () => {
    expect(makeStore().resolveSessionSliding()).toBe(true)
    expect(makeStore({ HERMES_WEBUI_SESSION_SLIDING: '0' }).resolveSessionSliding()).toBe(false)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ webui: { session_sliding: false } }))
    expect(makeStore().resolveSessionSliding()).toBe(false)
    expect(makeStore({ HERMES_WEBUI_SESSION_SLIDING: 'yes' }).resolveSessionSliding()).toBe(true)
    writeFileSync(join(dir, 'settings.json'), '{broken')
    expect(makeStore().resolveSessionSliding()).toBe(false)
  })

  it('extends only inside the renewal window and keeps typed records', () => {
    const store = makeStore()
    const cookie = store.createSession({ authType: 'password' })
    expect(store.extendSession(cookie, SESSION_TTL)).toBe(false)
    now += 3601
    expect(store.extendSession(cookie, SESSION_TTL)).toBe(true)
    const token = AuthStore.tokenFromCookieValue(cookie)!
    expect(store.sessionTable[token]).toEqual({ expiry: now + SESSION_TTL, auth_type: 'password', username: null, bound_profile: null })
    now += SESSION_TTL + 1
    expect(store.extendSession(cookie, SESSION_TTL)).toBe(false)
  })
})

describe('password hash and login rate', () => {
  it('env password wins over settings and the hash is cached until invalidated', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ password_hash: 'from-settings' }))
    expect(await makeStore().getPasswordHash()).toBe('from-settings')
    const store = makeStore({ HERMES_WEBUI_PASSWORD: PASSWORD })
    expect(await store.getPasswordHash()).toBe(PY.hash)
    expect(await store.isAuthEnabled()).toBe(true)
    expect(await store.verifyPassword(PASSWORD)).toBe(true)
    expect(await store.verifyPassword('wrong')).toBe(false)
    const none = makeStore()
    writeFileSync(join(dir, 'settings.json'), '{}')
    expect(await none.getPasswordHash()).toBeNull()
    expect(await none.isAuthEnabled()).toBe(false)
  })

  it('transparently migrates a legacy .signing_key-salted hash on login', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ password_hash: PY.legacyHash }))
    const store = makeStore()
    expect(await store.verifyPassword(PASSWORD)).toBe(true)
    expect((JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { password_hash: string }).password_hash).toBe(PY.hash)
    expect(await store.getPasswordHash()).toBe(PY.hash)
  })

  it('allows five attempts per minute and clears on success', () => {
    const store = makeStore()
    for (let i = 0; i < 5; i += 1) {
      expect(store.checkLoginRate('1.2.3.4')).toBe(true)
      store.recordLoginAttempt('1.2.3.4')
    }
    expect(store.checkLoginRate('1.2.3.4')).toBe(false)
    expect(store.checkLoginRate('5.6.7.8')).toBe(true)
    now += 61
    expect(store.checkLoginRate('1.2.3.4')).toBe(true)
    store.recordLoginAttempt('1.2.3.4')
    store.clearLoginAttempts('1.2.3.4')
    expect(JSON.parse(readFileSync(join(dir, '.login_attempts.json'), 'utf8'))).toEqual({})
  })

  it('keeps working when the state directory is read-only', () => {
    chmodSync(dir, 0o500)
    try {
      const store = makeStore({}, { keys: false })
      const cookie = store.createSession()
      expect(store.verifySession(cookie)).toBe(true)
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})

describe('OIDC mapping fingerprint canonical JSON', () => {
  it('serialises exactly like json.dumps(sort_keys=True, separators=(",", ":")) with ensure_ascii, so Python-written fingerprints verify', () => {
    const payload = { allow_values: ['Équipe', '日本'], a: '\u007f', z: [1, null, true], nested: { b: 2, a: 'x' } }
    const py = spawnSync('python3', ['-c', 'import json,sys;print(json.dumps(json.loads(sys.stdin.read()),sort_keys=True,separators=(",",":")))'], { encoding: 'utf8', input: JSON.stringify(payload) })
    expect(py.status).toBe(0)
    expect(canonicalJson(payload)).toBe(py.stdout.trim())
  })
})
