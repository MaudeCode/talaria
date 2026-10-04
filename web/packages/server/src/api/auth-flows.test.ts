import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { cborDecode } from '../auth/passkeys.js'
import { canonicalJson, OidcService, safeNextPath } from '../auth/oidc.js'
import { validatedRequestHost } from './auth-raw.js'
import { SidecarClient } from '../sidecar/client.js'

type Json = Record<string, unknown>
const b64u = (b: Buffer): string => b.toString('base64url')
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json
const cookieOf = (res: Response, name: string): string | null => res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '').find((c) => c.startsWith(name + '='))?.slice(name.length + 1) ?? null

// ── fake identity provider ────────────────────────────────────────────────

const ISSUER = 'https://idp.example'
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = rsa.publicKey.export({ format: 'jwk' })

function idToken(claims: Json): string {
  const header = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })))
  const payload = b64u(Buffer.from(JSON.stringify(claims)))
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), rsa.privateKey)
  return `${header}.${payload}.${b64u(sig)}`
}

interface Idp { tokens: Json[]; claimsFor: (nonce: string) => Json; fetch: typeof fetch }
function fakeIdp(now: () => number): Idp {
  const idp: Idp = {
    tokens: [],
    claimsFor: (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: 'user-1', email: 'kim@example.com', groups: ['admins'], exp: now() + 300, iat: now(), nonce }),
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === `${ISSUER}/.well-known/openid-configuration`) return Promise.resolve(Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` }))
      if (url === `${ISSUER}/jwks`) return Promise.resolve(Response.json({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] }))
      if (url === `${ISSUER}/token`) {
        const form = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''))
        idp.tokens.push(form)
        const nonce = (form.code ?? '').split(':')[1] ?? ''
        return Promise.resolve(Response.json({ id_token: idToken(idp.claimsFor(nonce)), token_type: 'Bearer' }))
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    },
  }
  return idp
}

/** Follow the start redirect, pull the nonce from the provider URL, and return a code the fake token endpoint accepts. */
function providerCode(location: string): { state: string; code: string } {
  const u = new URL(location)
  expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`)
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  return { state: u.searchParams.get('state') ?? '', code: `code:${u.searchParams.get('nonce') ?? ''}` }
}

describe('OIDC browser login', () => {
  let s: TestServer
  let idp: Idp
  const now = () => Date.now() / 1000
  beforeAll(async () => {
    s = await bootTestServer({
      env: { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'web-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'groups', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'admins', HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS: 'idp.example', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'owners' },
    })
    idp = fakeIdp(now)
    s.deps.fetch = idp.fetch
  })
  afterAll(() => s.close())

  it('reports OIDC as the enabled auth method and gates the API', async () => {
    const status = await json(await s.get('/api/auth/status'))
    expect(status).toMatchObject({ auth_enabled: true, oidc_enabled: true, oidc_native_handoff_enabled: true, logged_in: false, password_auth_enabled: false })
    expect((await s.get('/api/sessions')).status).toBe(401)
  })

  it('start → provider → callback establishes a typed oidc session', async () => {
    const start = await s.get('/api/auth/oidc/start?next=%2Fsettings')
    expect(start.status).toBe(302)
    expect(start.headers.get('cache-control')).toBe('no-store')
    const { state, code } = providerCode(start.headers.get('location') ?? '')
    const cb = await s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe('/settings')
    const cookie = cookieOf(cb, s.deps.auth.cookieName())
    expect(cookie).toBeTruthy()
    expect(s.deps.auth.getSessionInfo(cookie)).toMatchObject({ oidc_issuer: ISSUER, oidc_subject: 'user-1' })
    expect(idp.tokens.at(-1)).toMatchObject({ grant_type: 'authorization_code', client_id: 'web-client', redirect_uri: `http://127.0.0.1:${String(s.running.port)}/api/auth/oidc/callback` })
    const status = await json(await s.get('/api/auth/status', { headers: { cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } }))
    expect(status).toMatchObject({ logged_in: true, auth_type: 'oidc', user: 'kim@example.com', bound_profile: null, can_manage_server: false })
    expect((await s.get('/api/sessions', { headers: { cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } })).status).toBe(200)
    // TAL-279: link-safety settings apply to every user, so only an owner may change them.
    for (const patch of [{ auto_apply_updates: true }, { update_channel: 'experimental' }, { agent_update_channel: 'experimental' }, { check_for_updates: false }, { confirm_external_links: false }, { trusted_link_hosts: ['attacker.test'] }]) {
      expect((await s.get('/api/settings', { method: 'POST', body: JSON.stringify(patch), headers: { 'content-type': 'application/json', cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } })).status).toBe(403)
    }
  })

  it('grants owner authority only from the owner allowlist and revokes it when the policy fingerprint changes', async () => {
    idp.claimsFor = (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: 'user-2', email: 'own@example.com', groups: ['admins', 'owners'], exp: now() + 300, nonce })
    const start = await s.get('/api/auth/oidc/start')
    const { state, code } = providerCode(start.headers.get('location') ?? '')
    const cb = await s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
    const cookie = `${s.deps.auth.cookieName()}=${cookieOf(cb, s.deps.auth.cookieName()) ?? ''}`
    expect((await json(await s.get('/api/auth/status', { headers: { cookie } }))).can_manage_server).toBe(true)
    const saved = await s.get('/api/settings', { method: 'POST', body: JSON.stringify({ trusted_link_hosts: ['docs.example.com'] }), headers: { 'content-type': 'application/json', cookie } })
    expect(saved.status).toBe(200)
    expect((await json(saved)).trusted_link_hosts).toEqual(['docs.example.com'])
    // A policy change invalidates the stored binding on the next request.
    s.deps.config.env.HERMES_WEBUI_OIDC_OWNER_VALUES = 'someone-else'
    await new Promise((r) => setTimeout(r, 5100))
    expect((await json(await s.get('/api/auth/status', { headers: { cookie } }))).logged_in).toBe(false)
    s.deps.config.env.HERMES_WEBUI_OIDC_OWNER_VALUES = 'owners'
  }, 15_000)

  it('isolates notification history and mutations between OIDC owners sharing an email and profile', async () => {
    const isolated = await bootTestServer({
      env: { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'web-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'groups', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'admins', HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS: 'idp.example', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'owners' },
    })
    const isolatedIdp = fakeIdp(now)
    isolated.deps.fetch = isolatedIdp.fetch
    const origin = `http://127.0.0.1:${String(isolated.running.port)}`
    const login = async (subject: string): Promise<{ cookie: string; headers: Record<string, string> }> => {
      isolatedIdp.claimsFor = (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: subject, email: 'shared@example.com', groups: ['admins', 'owners'], exp: now() + 300, nonce })
      const start = await isolated.get('/api/auth/oidc/start')
      const { state, code } = providerCode(start.headers.get('location') ?? '')
      const callback = await isolated.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
      const value = cookieOf(callback, isolated.deps.auth.cookieName()) ?? ''
      const cookie = `${isolated.deps.auth.cookieName()}=${value}`
      return { cookie, headers: { cookie, origin, 'x-csrf-token': isolated.deps.auth.csrfTokenForSession(value) ?? '' } }
    }
    try {
      const first = await login('principal-a')
      const applied = await json(await post(isolated, '/api/updates/apply', { target: 'webui' }, first.headers))
      const notificationID = String(applied.notification_id)
      expect(notificationID).toMatch(/^[0-9a-f-]{36}$/)
      const firstList = await json(await isolated.get('/api/update-notifications', { headers: { cookie: first.cookie } }))
      expect((firstList.notifications as Json[]).some((row) => row.id === notificationID)).toBe(true)

      const second = await login('principal-b')
      expect((await post(isolated, `/api/update-notifications/${notificationID}/read`, { read: true }, second.headers)).status).toBe(404)
      const secondList = await json(await isolated.get('/api/update-notifications', { headers: { cookie: second.cookie } }))
      expect((secondList.notifications as Json[]).some((row) => row.id === notificationID)).toBe(false)
    } finally {
      await isolated.close()
    }
  })

  it('rejects identities outside the allowlist, bad state, and provider errors', async () => {
    idp.claimsFor = (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: 'user-3', groups: ['guests'], exp: now() + 300, nonce })
    const start = await s.get('/api/auth/oidc/start')
    const { state, code } = providerCode(start.headers.get('location') ?? '')
    const denied = await s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
    expect(denied.status).toBe(403)
    expect((await json(denied)).error).toBe('OIDC identity is not allowed')
    expect((await s.get('/api/auth/oidc/callback?state=nope&code=x')).status).toBe(401)
    expect((await s.get('/api/auth/oidc/callback?state=nope')).status).toBe(400)
    const errored = await s.get('/api/auth/oidc/callback?state=x&error=access_denied&error_description=Nope')
    expect(errored.status).toBe(401)
    expect((await json(errored)).error).toBe('Nope')
  })

  it('native handoff: start → browser flow → app callback → exchange with PKCE', async () => {
    idp.claimsFor = (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: 'user-4', email: 'app@example.com', groups: ['admins'], exp: now() + 300, nonce })
    const verifier = b64u(randomBytes(48))
    const challenge = b64u(createHash('sha256').update(verifier, 'ascii').digest())
    const clientState = b64u(randomBytes(24))
    const bad = await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria://oidc-callback', state: clientState, code_challenge: challenge, code_challenge_method: 'plain' })
    expect(bad.status).toBe(400)
    const started = await json(await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria://oidc-callback', state: clientState, code_challenge: challenge, code_challenge_method: 'S256' }))
    expect(started).toMatchObject({ expires_in: 600 })
    const authz = new URL(String(started.authorization_url))
    expect(authz.pathname).toBe('/api/auth/oidc/start')
    const start = await s.get(authz.pathname + authz.search)
    const { state, code } = providerCode(start.headers.get('location') ?? '')
    const cb = await s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
    expect(cb.status).toBe(302)
    expect(cb.headers.getSetCookie()).toEqual([])
    const app = new URL(cb.headers.get('location') ?? '')
    expect(`${app.protocol}//${app.host}`).toBe('talaria://oidc-callback')
    expect(app.searchParams.get('state')).toBe(clientState)
    expect(app.searchParams.get('server_id')).toBe(started.server_id)
    const wrongVerifier = await post(s, '/api/auth/oidc/native/exchange', { flow_id: started.flow_id, code: app.searchParams.get('code'), state: clientState, code_verifier: b64u(randomBytes(48)) })
    expect(wrongVerifier.status).toBe(401)
    // The code is single-use: mint a fresh one for the successful exchange.
    const again = await json(await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria://oidc-callback', state: clientState, code_challenge: challenge, code_challenge_method: 'S256' }))
    const start2 = await s.get(new URL(String(again.authorization_url)).search ? `/api/auth/oidc/start${new URL(String(again.authorization_url)).search}` : '')
    const p2 = providerCode(start2.headers.get('location') ?? '')
    const cb2 = await s.get(`/api/auth/oidc/callback?state=${p2.state}&code=${p2.code}`)
    const app2 = new URL(cb2.headers.get('location') ?? '')
    const exchanged = await post(s, '/api/auth/oidc/native/exchange', { flow_id: again.flow_id, code: app2.searchParams.get('code'), state: clientState, code_verifier: verifier })
    expect(exchanged.status).toBe(200)
    const cookie = cookieOf(exchanged, s.deps.auth.cookieName())
    expect(cookie).toBeTruthy()
    const status = await json(await s.get('/api/auth/status', { headers: { cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } }))
    expect(status).toMatchObject({ logged_in: true, auth_type: 'oidc', user: 'app@example.com' })
    expect((await json(await post(s, '/api/auth/oidc/native/cancel', { flow_id: again.flow_id, state: clientState }))).ok).toBe(false)
  })

  it('native cancel drops a pending flow and provider errors bounce back to the app', async () => {
    const challenge = b64u(createHash('sha256').update(b64u(randomBytes(48)), 'ascii').digest())
    const clientState = b64u(randomBytes(24))
    const started = await json(await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria-branch://oidc-callback/', state: clientState, code_challenge: challenge, code_challenge_method: 'S256' }))
    expect((await json(await post(s, '/api/auth/oidc/native/cancel', { flow_id: started.flow_id, state: 'wrong-state-value-1' }))).ok).toBe(false)
    expect((await json(await post(s, '/api/auth/oidc/native/cancel', { flow_id: started.flow_id, state: clientState }))).ok).toBe(true)
    expect((await s.get(`/api/auth/oidc/start?native_flow=${String(started.flow_id)}`)).status).toBe(401)
    const second = await json(await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria://oidc-callback', state: clientState, code_challenge: challenge, code_challenge_method: 'S256' }))
    const start = await s.get(`/api/auth/oidc/start?native_flow=${String(second.flow_id)}`)
    const { state } = providerCode(start.headers.get('location') ?? '')
    const failed = await s.get(`/api/auth/oidc/callback?state=${state}&error=access_denied`)
    expect(failed.status).toBe(302)
    const app = new URL(failed.headers.get('location') ?? '')
    expect(app.searchParams.get('error')).toBe('provider_error')
    expect(app.searchParams.get('flow_id')).toBe(second.flow_id)
  })

  it('rate limits native starts per client IP', async () => {
    const challenge = b64u(createHash('sha256').update(b64u(randomBytes(48)), 'ascii').digest())
    let last = 200
    for (let i = 0; i < 12 && last !== 429; i += 1) {
      last = (await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria://oidc-callback', state: b64u(randomBytes(24)), code_challenge: challenge, code_challenge_method: 'S256' })).status
    }
    expect(last).toBe(429)
  })
})

describe('OIDC unconfigured', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('answers 404 on every OIDC entry point and leaves auth disabled', async () => {
    expect((await json(await s.get('/api/auth/status'))).oidc_enabled).toBe(false)
    expect((await s.get('/api/auth/oidc/start')).status).toBe(404)
    expect((await post(s, '/api/auth/oidc/native/start', { callback_url: 'talaria://oidc-callback', state: b64u(randomBytes(24)), code_challenge: b64u(randomBytes(32)), code_challenge_method: 'S256' })).status).toBe(404)
  })
})

// ── passkeys ──────────────────────────────────────────────────────────────

function cborEncode(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') { const b = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, b.length), b]) }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value.entries()].flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])])
  throw new Error('unsupported')
}

class FakeAuthenticator {
  readonly key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly credentialId = randomBytes(16)
  counter = 0
  private authData(rpId: string, flags: number, extra: Buffer): Buffer {
    const head = Buffer.alloc(37)
    createHash('sha256').update(rpId, 'ascii').digest().copy(head, 0)
    head[32] = flags
    head.writeUInt32BE(this.counter, 33)
    return Buffer.concat([head, extra])
  }
  register(options: Json, origin: string): Json {
    const rp = options.rp as Json
    const pub = this.key.publicKey.export({ format: 'jwk' })
    const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(String(pub.x), 'base64url')], [-3, Buffer.from(String(pub.y), 'base64url')]])
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credentialId.length)
    const credData = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cborEncode(cose)])
    const authData = this.authData(String(rp.id), 0x41, credData)
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }))
    const attestation = cborEncode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation) } }
  }
  assert(options: Json, origin: string, opts: { advance?: boolean } = {}): Json {
    if (opts.advance !== false) this.counter += 1
    const authData = this.authData(String(options.rpId), 0x01, Buffer.alloc(0))
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }))
    const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), this.key.privateKey)
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } }
  }
}

describe('passkeys', () => {
  let s: TestServer
  let origin: string
  const authenticator = new FakeAuthenticator()
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_PASSKEY: '1' } })
    origin = s.base
  })
  afterAll(() => s.close())

  it('lists nothing and refuses login options until a passkey exists', async () => {
    expect(await json(await s.get('/api/auth/passkeys'))).toEqual({ credentials: [] })
    expect((await json(await s.get('/api/auth/status'))).passkey_feature_flag).toBe(true)
    expect((await post(s, '/api/auth/passkey/options', {})).status).toBe(400)
  })

  it('registers the first passkey through the local bootstrap gate, then logs in with it', async () => {
    const optRes = await post(s, '/api/auth/passkey/register/options', {}, { origin })
    expect(optRes.status).toBe(200)
    const options = (await json(optRes)).publicKey as Json
    expect(options).toMatchObject({ rp: { id: '127.0.0.1' }, attestation: 'none' })
    const reg = await post(s, '/api/auth/passkey/register', { ...authenticator.register(options, origin), label: 'Laptop' }, { origin })
    expect(reg.status).toBe(200)
    const regBody = await json(reg)
    expect(regBody).toMatchObject({ ok: true, credential: { id: b64u(authenticator.credentialId), label: 'Laptop' } })
    expect((regBody.credentials as Json[]).length).toBe(1)
    const stored = JSON.parse(readFileSync(join(s.state, 'passkeys.json'), 'utf8')) as Json[]
    expect(stored[0]).toMatchObject({ id: b64u(authenticator.credentialId), label: 'Laptop', sign_count: 0 })
    expect(statSync(join(s.state, 'passkeys.json')).mode & 0o777).toBe(0o600)
    expect(await json(await s.get('/api/auth/status'))).toMatchObject({ auth_enabled: true, passkeys_enabled: true, passkeys_count: 1, passwordless_enabled: true, logged_in: false })
    expect((await s.get('/api/sessions')).status).toBe(401)

    const loginOptions = (await json(await post(s, '/api/auth/passkey/options', {}, { origin }))).publicKey as Json
    expect(loginOptions.allowCredentials).toEqual([{ type: 'public-key', id: b64u(authenticator.credentialId) }])
    const login = await post(s, '/api/auth/passkey/login', authenticator.assert(loginOptions, origin), { origin })
    expect(login.status).toBe(200)
    const cookie = cookieOf(login, s.deps.auth.cookieName())
    expect(cookie).toBeTruthy()
    const status = await json(await s.get('/api/auth/status', { headers: { cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } }))
    expect(status).toMatchObject({ logged_in: true, can_manage_server: true })
    expect((await s.get('/api/sessions', { headers: { cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } })).status).toBe(200)
  })

  it('rejects replayed challenges, stale counters, and wrong origins', async () => {
    const opts = (await json(await post(s, '/api/auth/passkey/options', {}, { origin }))).publicKey as Json
    const assertion = authenticator.assert(opts, origin)
    expect((await post(s, '/api/auth/passkey/login', assertion, { origin })).status).toBe(200)
    const replay = await post(s, '/api/auth/passkey/login', assertion, { origin })
    expect(replay.status).toBe(401)
    expect((await json(replay)).error).toBe('Passkey challenge expired. Try again.')
    const stale = (await json(await post(s, '/api/auth/passkey/options', {}, { origin }))).publicKey as Json
    const staleRes = await post(s, '/api/auth/passkey/login', { ...authenticator.assert(stale, origin, { advance: false }), response: { ...(authenticator.assert(stale, origin, { advance: false }).response as Json) } }, { origin })
    expect(staleRes.status).toBe(401)
    const other = (await json(await post(s, '/api/auth/passkey/options', {}, { origin }))).publicKey as Json
    const mismatch = await post(s, '/api/auth/passkey/login', authenticator.assert(other, 'https://evil.example'), { origin })
    expect(mismatch.status).toBe(401)
    expect((await json(mismatch)).error).toBe('Passkey origin mismatch')
  })

  it('requires an owner session to manage passkeys once auth is on and keeps the last passkey without a password', async () => {
    expect((await post(s, '/api/auth/passkey/register/options', {}, { origin })).status).toBe(401)
    const opts = (await json(await post(s, '/api/auth/passkey/options', {}, { origin }))).publicKey as Json
    const login = await post(s, '/api/auth/passkey/login', authenticator.assert(opts, origin), { origin })
    const cookie = `${s.deps.auth.cookieName()}=${cookieOf(login, s.deps.auth.cookieName()) ?? ''}`
    const csrf = s.deps.auth.csrfTokenForSession(cookieOf(login, s.deps.auth.cookieName()) ?? '') ?? ''
    const headers = { cookie, origin, 'x-csrf-token': csrf }
    const id = b64u(authenticator.credentialId)
    const last = await post(s, '/api/auth/passkey/delete', { id }, headers)
    expect(last.status).toBe(409)
    expect((await post(s, '/api/auth/passkey/delete', { id: 'missing' }, headers)).status).toBe(404)
    // A second passkey makes the first deletable.
    const second = new FakeAuthenticator()
    const regOpts = (await json(await post(s, '/api/auth/passkey/register/options', {}, headers))).publicKey as Json
    expect((regOpts.excludeCredentials as Json[]).map((c) => c.id)).toEqual([id])
    expect((await post(s, '/api/auth/passkey/register', second.register(regOpts, origin), headers)).status).toBe(200)
    const deleted = await json(await post(s, '/api/auth/passkey/delete', { id }, headers))
    expect((deleted.credentials as Json[]).map((c) => c.id)).toEqual([b64u(second.credentialId)])
    expect((await json(await s.get('/api/auth/passkeys', { headers }))).credentials).toHaveLength(1)
  })

  it('clearing passwords through settings also clears passkeys', () => {
    s.deps.clearPasskeys()
    expect(JSON.parse(readFileSync(join(s.state, 'passkeys.json'), 'utf8'))).toEqual([])
    expect(existsSync(join(s.state, '.passkey_challenges.json'))).toBe(true)
  })
})

describe('passkey flag off', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())
  it('hides the surface', async () => {
    expect(await json(await s.get('/api/auth/passkeys'))).toEqual({ credentials: [], disabled: true })
    expect((await post(s, '/api/auth/passkey/options', {})).status).toBe(404)
    expect((await post(s, '/api/auth/passkey/register/options', {})).status).toBe(404)
  })
})

describe('auth helpers', () => {
  it('cborDecode round-trips the encoder used by the fake authenticator', () => {
    const value = new Map<unknown, unknown>([[1, 2], [-2, Buffer.from('ab')], ['s', 'x']])
    const decoded = cborDecode(cborEncode(value)) as Map<unknown, unknown>
    expect(decoded.get(1)).toBe(2)
    expect(decoded.get(-2)).toEqual(Buffer.from('ab'))
    expect(decoded.get('s')).toBe('x')
  })
  it('safeNextPath and validatedRequestHost mirror the Python guards', () => {
    expect(safeNextPath('/x')).toBe('/x')
    expect(safeNextPath('//evil')).toBe('/')
    expect(safeNextPath('/a b')).toBe('/')
    expect(validatedRequestHost('example.com:8787')).toBe('example.com:8787')
    expect(validatedRequestHost('user@example.com')).toBeNull()
    expect(validatedRequestHost('example.com/x')).toBeNull()
    expect(validatedRequestHost('example.com:')).toBeNull()
  })
  it('canonicalJson sorts keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}')
  })
  it('signature helper sanity: a P-256 assertion verifies with the SPKI export', () => {
    const a = new FakeAuthenticator()
    const pem = a.key.publicKey.export({ type: 'spki', format: 'pem' })
    expect(createPublicKey(pem).asymmetricKeyType).toBe('ec')
    expect(createPrivateKey(a.key.privateKey.export({ type: 'pkcs8', format: 'pem' })).asymmetricKeyType).toBe('ec')
  })
})

describe('OIDC profile binding', () => {
  let s: TestServer
  let idp: Idp
  const now = () => Date.now() / 1000
  beforeAll(async () => {
    s = await bootTestServer({
      env: { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'web-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'groups', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'admins', HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS: 'idp.example', HERMES_WEBUI_OIDC_PROFILE_CLAIM: 'email', HERMES_WEBUI_OIDC_PROFILE_MAP: '{"kim@example.com":"work","ghost@example.com":"ghost"}' },
    })
    idp = fakeIdp(now)
    s.deps.fetch = idp.fetch
    mkdirSync(join(s.state, 'profiles', 'work'), { recursive: true })
  })
  afterAll(() => s.close())
  const callback = async (): Promise<Response> => {
    const start = await s.get('/api/auth/oidc/start')
    const { state, code } = providerCode(start.headers.get('location') ?? '')
    return s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
  }

  it('a mapped identity gets a session bound to its profile and a signed profile cookie', async () => {
    const cb = await callback()
    expect(cb.status).toBe(302)
    const cookies = cb.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith('hermes_session='))).toBe(true)
    expect(cookies.some((c) => /^hermes_profile=work\.[0-9a-f]{64}/.test(c))).toBe(true)
    const session = cookies.find((c) => c.startsWith('hermes_session='))?.split(';')[0] ?? ''
    expect(await json(await s.get('/api/auth/status', { headers: { cookie: session } }))).toMatchObject({ logged_in: true, auth_type: 'oidc', bound_profile: 'work' })
  })

  it('a request carrying only the bound session cookie re-issues the profile cookie', async () => {
    const cb = await callback()
    const session = cb.headers.getSetCookie().find((c) => c.startsWith('hermes_session='))?.split(';')[0] ?? ''
    const res = await s.get('/api/bootstrap', { headers: { cookie: session } })
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().some((c) => c.startsWith("hermes_profile=work."))).toBe(true)
    expect(((await json(res)).profile as Json).name).toBe('work')
  })

  it('an identity outside the map is refused', async () => {
    idp.claimsFor = (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: 'user-9', email: 'nobody@example.com', groups: ['admins'], exp: now() + 300, iat: now(), nonce })
    const cb = await callback()
    expect(cb.status).toBe(403)
    expect(await cb.text()).toContain('not assigned to a profile')
  })

  it('a map target whose home does not exist is a configuration error', async () => {
    idp.claimsFor = (nonce) => ({ iss: ISSUER, aud: 'web-client', sub: 'user-8', email: 'ghost@example.com', groups: ['admins'], exp: now() + 300, iat: now(), nonce })
    const cb = await callback()
    expect(cb.status).toBeGreaterThanOrEqual(400)
    expect(await cb.text()).toContain('does not exist')
  })
})

describe('OIDC enablement', () => {
  const OIDC_ENV = { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'web-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'groups', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'admins', HERMES_WEBUI_OIDC_TRUSTED_PRIVATE_HOSTS: 'idp.example' }
  const modes: Record<string, { env: Record<string, string>; setup?: (s: TestServer) => void }> = {
    password: { env: { HERMES_WEBUI_PASSWORD: 'hunter22' } },
    passkey: { env: { HERMES_WEBUI_PASSKEY: '1' }, setup: (s) => { s.deps.auth.passkeysEnabled = () => true } },
    'trusted header': { env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User' } },
  }
  const firstAuth: Record<string, (s: TestServer) => Promise<Json>> = {
    'auth/status': async (s) => json(await s.get('/api/auth/status')),
    bootstrap: async (s) => (await json(await s.get('/api/bootstrap'))).auth as Json,
  }
  for (const [mode, { env, setup }] of Object.entries(modes)) {
    for (const [endpoint, read] of Object.entries(firstAuth)) {
      it(`advertises OIDC alongside ${mode} auth on a cold server's first ${endpoint}`, async () => {
        const s = await bootTestServer({ env: { ...OIDC_ENV, ...env } })
        try {
          setup?.(s)
          expect(await read(s)).toMatchObject({ auth_enabled: true, oidc_enabled: true, oidc_native_handoff_enabled: true })
        } finally { await s.close() }
      })
    }
  }

  it('password auth with OIDC still gates the API and starts SSO', async () => {
    const s = await bootTestServer({ env: { ...OIDC_ENV, HERMES_WEBUI_PASSWORD: 'hunter22' } })
    try {
      s.deps.fetch = fakeIdp(() => Date.now() / 1000).fetch
      expect(await json(await s.get('/api/auth/status'))).toMatchObject({ password_auth_enabled: true, oidc_enabled: true })
      expect((await s.get('/api/sessions')).status).toBe(401)
      const start = await s.get('/api/auth/oidc/start?next=%2F')
      expect(start.status).toBe(302)
      providerCode(start.headers.get('location') ?? '')
    } finally { await s.close() }
  })

  it('concurrent cold probes share one operator config read', async () => {
    let reads = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const oidc = new OidcService({
      env: OIDC_ENV, operatorConfig: async () => { reads += 1; await gate; return {} }, profileHome: () => '', fetch: () => fetch,
      pinned: () => { throw new Error('unused') }, now: () => Date.now() / 1000, log: () => undefined,
    })
    const probes = Promise.all(Array.from({ length: 5 }, () => oidc.enabled()))
    release()
    expect(await probes).toEqual([true, true, true, true, true])
    expect(reads).toBe(1)
  })

  it('password-only auth keeps the OIDC flags false', async () => {
    const s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: 'hunter22' } })
    try {
      expect(await json(await s.get('/api/auth/status'))).toMatchObject({ auth_enabled: true, password_auth_enabled: true, oidc_enabled: false, oidc_native_handoff_enabled: false })
    } finally { await s.close() }
  })

  it('issuer and client id alone do not enable OIDC', async () => {
    const s = await bootTestServer({ env: { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'web-client' } })
    try {
      expect(await json(await s.get('/api/auth/status'))).toMatchObject({ oidc_enabled: false })
    } finally { await s.close() }
  })
})

describe('OIDC outbound vetting', () => {
  const now = () => Date.now() / 1000
  const env = { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'web-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'groups', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'admins' }

  it('an untrusted issuer is resolved, checked, and reached only through the pinned connection', async () => {
    const s = await bootTestServer({ env })
    try {
      const idp = fakeIdp(now)
      const pinnedTo: string[][] = []
      s.deps.fetch = () => Promise.reject(new Error('plain fetch must not be used for an untrusted host'))
      s.deps.dnsLookup = (h) => Promise.resolve(h === 'idp.example' ? [{ address: '93.184.216.34', family: 4 }] : [])
      s.deps.pinnedFetch = (url, init, addresses) => { pinnedTo.push(addresses); return idp.fetch(url, init) }
      const start = await s.get('/api/auth/oidc/start')
      expect(start.status).toBe(302)
      const { state, code } = providerCode(start.headers.get('location') ?? '')
      const cb = await s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
      expect(cb.status).toBe(302)
      expect(pinnedTo.length).toBeGreaterThanOrEqual(2)
      expect(pinnedTo.every((a) => a.length === 1 && a[0] === '93.184.216.34')).toBe(true)
    } finally { await s.close() }
  })

  it('an issuer whose DNS answers include a private address is refused before any request carries the client credentials', async () => {
    const s = await bootTestServer({ env })
    try {
      const requests: string[] = []
      s.deps.fetch = () => { requests.push('plain'); return Promise.reject(new Error('no')) }
      s.deps.pinnedFetch = (url) => { requests.push(url); return Promise.reject(new Error('no')) }
      s.deps.dnsLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])
      const start = await s.get('/api/auth/oidc/start')
      expect(start.status).toBe(502)
      expect(requests).toEqual([])
      s.deps.dnsLookup = () => Promise.reject(new Error('ENOTFOUND'))
      expect((await s.get('/api/auth/oidc/start')).status).toBe(502)
      expect(requests).toEqual([])
    } finally { await s.close() }
  })
})

describe('auth gate fails closed on unknown or unreadable auth state', () => {
  it('passkey-only auth keeps the API gated while the operator config flag cannot be read', async () => {
    const s = await bootTestServer()
    try {
      // A registered credential with the flag only in config.yaml: the flag is unknown while the snapshot is cold.
      s.deps.auth.passkeysEnabled = () => true
      s.deps.auth.passkeyConfigFlag = () => null
      expect(s.deps.auth.passkeysAvailable()).toBe(true)
      expect(await s.deps.auth.isAuthEnabled()).toBe(true)
      expect((await s.get('/api/sessions')).status).toBe(401)
      // The flag read back as false: passkeys are off and the gate opens.
      s.deps.auth.passkeyConfigFlag = () => false
      expect(s.deps.auth.passkeysAvailable()).toBe(false)
    } finally { await s.close() }
  })

  it('an unreadable settings.json keeps password auth enabled and refuses every password', async () => {
    const s = await bootTestServer()
    try {
      await s.deps.settings.save({ _set_password: 'hunter22' })
      s.deps.auth.invalidatePasswordHashCache()
      chmodSync(join(s.state, 'settings.json'), 0o000)
      try {
        expect((await s.get('/api/sessions')).status).toBe(401)
        expect(await s.deps.auth.verifyPassword('hunter22')).toBe(false)
      } finally {
        chmodSync(join(s.state, 'settings.json'), 0o600)
      }
      // The failure was not cached: once readable the real hash is used again.
      expect(await s.deps.auth.verifyPassword('hunter22')).toBe(true)
    } finally { await s.close() }
  })
})

describe('OIDC operator config availability', () => {
  it('SSO reads operator config through the real transport while Agent imports are unavailable', async () => {
    const sidecar = new SidecarClient({
      python: process.execPath, agentDir: '', sidecarDir: process.cwd(), hermesHome: '', log: () => undefined,
      command: [process.execPath, '-e', `
        const fs = require('fs');
        const fixture = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))['runtime.handshake'][0].result;
        require('readline').createInterface({input: process.stdin}).on('line', line => {
          const req = JSON.parse(line);
          let result;
          if (req.method === 'runtime.handshake') result = {...fixture, compatible: false, import_error: 'synthetic missing dependency'};
          else if (req.method === 'config.get') result = {path: req.params.config_path, exists: true, config: JSON.parse(fs.readFileSync(req.params.config_path, 'utf8'))};
          else if (req.method === 'config.set') { fs.writeFileSync(req.params.config_path, JSON.stringify(req.params.config)); result = {ok: true, path: req.params.config_path}; }
          else return;
          process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, result}) + '\\n');
        });`, resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/runtime.json')],
    })
    await sidecar.start()
    const s = await bootTestServer({ sidecar, deps: (deps) => {
      writeFileSync(join(deps.config.hermesHome, 'config.yaml'), JSON.stringify({ webui_oidc: {
        issuer: ISSUER, client_id: 'web-client', allow_claim: 'groups', allow_values: ['admins'], trusted_private_hosts: ['idp.example'],
        owner_claim: 'groups', owner_values: ['owners'],
      } }))
    } })
    try {
      s.deps.fetch = fakeIdp(() => Date.now() / 1000).fetch
      expect(sidecar.status).toBe('incompatible')
      expect((await s.get('/api/sessions')).status).toBe(401)
      const start = await s.get('/api/auth/oidc/start')
      expect(start.status).toBe(302)
      const { state, code } = providerCode(start.headers.get('location') ?? '')
      const callback = await s.get(`/api/auth/oidc/callback?state=${state}&code=${code}`)
      expect(callback.status).toBe(302)
      const cookie = cookieOf(callback, s.deps.auth.cookieName())
      expect(cookie).toBeTruthy()
      expect(await json(await s.get('/api/auth/status', { headers: { cookie: `${s.deps.auth.cookieName()}=${cookie ?? ''}` } }))).toMatchObject({ logged_in: true, can_manage_server: false })
      expect((await sidecar.call('config.set', { profile_home: s.state, config_path: join(s.state, 'recovery.yaml'), config: {} })).ok).toBe(true)
    } finally { await s.close(); await sidecar.close() }
  })

  it('an unreadable operator config with no last-known policy keeps the API gated until it can be read', async () => {
    let clock = 1_700_000_000
    // config.yaml exists at boot but no sidecar can read it: the auth policy inside is unknown from the first request.
    const s = await bootTestServer({ now: () => clock, deps: (deps) => { writeFileSync(join(deps.config.hermesHome, 'config.yaml'), 'webui_oidc: {}\n') } })
    try {
      expect((await s.get('/api/sessions')).status).toBe(401)
      expect(await json(await s.get('/api/auth/status'))).toMatchObject({ auth_enabled: true, oidc_enabled: true })
      const start = await s.get('/api/auth/oidc/start')
      expect(start.status).toBe(404)
      expect(String((await json(start)).error)).toContain('operator config could not be resolved')
      // Once the config is readable again (here: gone) the gate reopens after the resolve cache expires.
      rmSync(join(s.state, 'config.yaml'))
      s.deps.agentConfig.invalidate()
      clock += 10
      expect((await s.get('/api/sessions')).status).toBe(200)
    } finally { await s.close() }
  })
})
