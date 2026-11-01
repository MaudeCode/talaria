import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PinnedInit } from '../../http/pinned.js'
import { bootTestServer, cookieHeader, type TestServer } from '../../test/harness.js'

type Json = Record<string, unknown>
const ENDPOINT = 'https://push.example/send/subscription-1'
const PUBLIC = '93.184.216.34'
const PUSH_PATH = '/api/notifications/web-push/subscriptions'

const send = (s: TestServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  s.get(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

/** A synthetic browser subscription whose private key stays in the test, so it can open every push. */
function browserKeys(): { p256dh: string; auth: string; decrypt: (body: Buffer) => Json } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    // RFC 8291 / RFC 8188 aes128gcm, one record.
    decrypt: (body) => {
      const salt = body.subarray(0, 16)
      const idlen = body[20]!
      const serverKey = body.subarray(21, 21 + idlen)
      const record = body.subarray(21 + idlen)
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey])
      const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverKey), auth, keyInfo, 32))
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(record.subarray(record.length - 16))
      const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
      const end = padded.lastIndexOf(2)
      return JSON.parse(padded.subarray(0, end).toString('utf8')) as Json
    },
  }
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` signed by the key the server advertised. */
function verifyVapid(header: string, publicKey: string): Json {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
  expect(match?.[2]).toBe(publicKey)
  const [head, claims, signature] = match![1]!.split('.') as [string, string, string]
  const raw = Buffer.from(publicKey, 'base64url')
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' })
  expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Json
}

interface Push { url: string; init: PinnedInit; addresses: string[] }

function stubPushService(s: TestServer): { pushes: Push[]; statuses: number[] } {
  const pushes: Push[] = []
  const statuses: number[] = []
  s.deps.dnsLookup = (host) => Promise.resolve(host === 'push.example' ? [{ address: PUBLIC, family: 4 }] : host === 'private.example' ? [{ address: '10.0.0.5', family: 4 }] : [])
  s.deps.pinnedFetch = (url, init, addresses) => { pushes.push({ url, init, addresses }); return Promise.resolve(new Response(null, { status: statuses.shift() ?? 201 })) }
  return { pushes, statuses }
}

describe('Web Push channel', () => {
  let s: TestServer
  let push: ReturnType<typeof stubPushService>
  const keys = browserKeys()
  const settle = async (): Promise<void> => { s.deps.notifications.changed(); await s.deps.webPush.idle() }

  beforeAll(async () => {
    s = await bootTestServer()
    push = stubPushService(s)
  })
  afterAll(() => s.close())

  it('refuses an http endpoint and one that resolves to a private address', async () => {
    for (const endpoint of ['http://push.example/send/x', 'https://private.example/send/x', 'https://10.0.0.7/send/x']) {
      const res = await send(s, 'POST', PUSH_PATH, { endpoint, keys })
      expect(res.status, endpoint).toBe(400)
    }
    expect(push.pushes).toHaveLength(0)
  })

  it('sends one encrypted, VAPID-signed alert when a run starts waiting for approval with no Talaria tab open', async () => {
    const status = await json(await s.get(`/api/notifications/web-push?endpoint=${encodeURIComponent(ENDPOINT)}`))
    expect(status.subscription).toBeNull()
    const publicKey = String(status.public_key)
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65)
    expect(await json(await send(s, 'POST', PUSH_PATH, { endpoint: ENDPOINT, keys: { p256dh: keys.p256dh, auth: keys.auth } }))).toEqual({ ok: true, preferences: { notify_on_approval: true, notify_on_input: true, notify_on_completion: true, notify_on_failure: true } })

    const sid = String(((await json(await send(s, 'POST', '/api/session/new', {}))).session as Json).session_id)
    ;(await s.deps.sessionStore.get(sid)).title = 'Deploy review'
    s.deps.registry.activeRuns.set('stream-push', { stream_id: 'stream-push', session_id: sid, started_at: 1, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    await settle()
    expect(push.pushes).toHaveLength(0)

    s.deps.pending.submitApproval(sid, { request_id: 'r1', tool: 'shell' })
    await settle()
    expect(push.pushes).toHaveLength(1)
    const [sent] = push.pushes as [Push]
    expect(sent.url).toBe(ENDPOINT)
    expect(sent.addresses).toEqual([PUBLIC])
    expect(sent.init.method).toBe('POST')
    expect(sent.init.headers).toMatchObject({ TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm' })
    expect(verifyVapid(sent.init.headers!.Authorization!, publicKey)).toMatchObject({ aud: 'https://push.example' })
    expect(keys.decrypt(Buffer.from(sent.init.body as Uint8Array))).toEqual({ title: 'Deploy review', body: 'Approval needed', tag: sid, url: `/session/${sid}` })

    // The same phase published again sends nothing.
    await settle()
    expect(push.pushes).toHaveLength(1)

    // A Talaria tab open for the profile mutes the next alert.
    s.deps.pending.resolveApproval(sid, 'r1')
    await settle()
    expect((await send(s, 'POST', '/api/talaria/presence', { tab_id: 'tab_00000001', active: true, seq: 1 })).status).toBe(200)
    s.deps.pending.submitApproval(sid, { request_id: 'r2', tool: 'shell' })
    await settle()
    expect(push.pushes).toHaveLength(1)
    expect((await send(s, 'POST', '/api/talaria/presence', { tab_id: 'tab_00000001', active: false, seq: 2 })).status).toBe(200)
    s.deps.pending.resolveApproval(sid, 'r2')
    await settle()

    // A disabled preference sends nothing; the kinds left on still alert.
    const off = { notify_on_approval: true, notify_on_input: true, notify_on_completion: false, notify_on_failure: true }
    expect(await json(await send(s, 'PATCH', PUSH_PATH, { endpoint: ENDPOINT, preferences: off }))).toEqual({ ok: true, preferences: off })
    expect((await json(await s.get(`/api/notifications/web-push?endpoint=${encodeURIComponent(ENDPOINT)}`))).subscription).toEqual({ preferences: off })
    s.deps.notifications.noteTerminal('stream-push', 'completed')
    s.deps.registry.activeRuns.delete('stream-push')
    await settle()
    expect(push.pushes).toHaveLength(1)
    s.deps.registry.activeRuns.set('stream-push-2', { stream_id: 'stream-push-2', session_id: sid, started_at: 2, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    await settle()
    s.deps.notifications.noteTerminal('stream-push-2', 'failed')
    s.deps.registry.activeRuns.delete('stream-push-2')
    await settle()
    expect(push.pushes).toHaveLength(2)
    expect(push.pushes[1]!.init.headers).toMatchObject({ Urgency: 'normal' })
    expect(keys.decrypt(Buffer.from(push.pushes[1]!.init.body as Uint8Array))).toMatchObject({ body: 'Failed', tag: sid })
  })

  it("sends nothing for another profile's session", async () => {
    const before = push.pushes.length
    const sid = String(((await json(await send(s, 'POST', '/api/session/new', { title: 'Other profile' }))).session as Json).session_id)
    ;(await s.deps.sessionStore.get(sid)).profile = 'work'
    s.deps.registry.activeRuns.set('stream-other', { stream_id: 'stream-other', session_id: sid, started_at: 3, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    await settle()
    s.deps.pending.submitApproval(sid, { request_id: 'r3', tool: 'shell' })
    await settle()
    expect(push.pushes).toHaveLength(before)
    s.deps.pending.resolveApproval(sid, 'r3')
    s.deps.registry.activeRuns.delete('stream-other')
  })

  it('deletes a subscription the push service reports gone (410)', async () => {
    const sid = String(((await json(await send(s, 'POST', '/api/session/new', { title: 'Gone' }))).session as Json).session_id)
    s.deps.registry.activeRuns.set('stream-gone', { stream_id: 'stream-gone', session_id: sid, started_at: 4, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    await settle()
    const before = push.pushes.length
    push.statuses.push(410)
    s.deps.pending.submitApproval(sid, { request_id: 'r4', tool: 'shell' })
    await settle()
    expect(push.pushes).toHaveLength(before + 1)
    expect((await json(await s.get(`/api/notifications/web-push?endpoint=${encodeURIComponent(ENDPOINT)}`))).subscription).toBeNull()
    s.deps.pending.resolveApproval(sid, 'r4')
    s.deps.registry.activeRuns.delete('stream-gone')
  })

  it('unsubscribes this browser', async () => {
    expect((await send(s, 'POST', PUSH_PATH, { endpoint: ENDPOINT, keys: { p256dh: keys.p256dh, auth: keys.auth } })).status).toBe(200)
    expect(await json(await send(s, 'DELETE', PUSH_PATH, { endpoint: ENDPOINT }))).toEqual({ ok: true })
    expect((await json(await s.get(`/api/notifications/web-push?endpoint=${encodeURIComponent(ENDPOINT)}`))).subscription).toBeNull()
  })
})

describe('Web Push and login sessions', () => {
  const PASSWORD = 'synthetic-push-pw'
  let s: TestServer
  beforeAll(async () => {
    s = await bootTestServer({ env: { HERMES_WEBUI_PASSWORD: PASSWORD } })
    stubPushService(s)
  })
  afterAll(() => s.close())

  const login = async (): Promise<string> => cookieHeader((await send(s, 'POST', '/api/auth/login', { password: PASSWORD })).headers.getSetCookie(), 'hermes_session')!

  it('deletes the subscriptions a login created when that login logs out', async () => {
    const keys = browserKeys()
    const first = await login()
    const second = await login()
    const mine = 'https://push.example/send/first-login'
    const theirs = 'https://push.example/send/second-login'
    expect((await send(s, 'POST', PUSH_PATH, { endpoint: mine, keys: { p256dh: keys.p256dh, auth: keys.auth } }, { cookie: first })).status).toBe(200)
    expect((await send(s, 'POST', PUSH_PATH, { endpoint: theirs, keys: { p256dh: keys.p256dh, auth: keys.auth } }, { cookie: second })).status).toBe(200)
    expect((await send(s, 'POST', '/api/auth/logout', undefined, { cookie: first })).status).toBe(200)
    const status = async (endpoint: string) => (await json(await s.get(`/api/notifications/web-push?endpoint=${encodeURIComponent(endpoint)}`, { headers: { cookie: second } }))).subscription
    expect(await status(mine)).toBeNull()
    expect(await status(theirs)).not.toBeNull()
  })

  it('stops retrying an alert once its login logs out', async () => {
    const keys = browserKeys()
    const cookie = await login()
    const push = stubPushService(s)
    const endpoint = 'https://push.example/send/retrying-login'
    expect((await send(s, 'POST', PUSH_PATH, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, { cookie })).status).toBe(200)
    const sid = String(((await json(await send(s, 'POST', '/api/session/new', {}, { cookie }))).session as Json).session_id)
    s.deps.registry.activeRuns.set('stream-retry', { stream_id: 'stream-retry', session_id: sid, started_at: 5, phase: 'running', workspace: s.state, model: null, provider: null, ephemeral: false })
    s.deps.notifications.changed()
    await s.deps.webPush.idle()
    push.statuses.push(503)
    s.deps.pending.submitApproval(sid, { request_id: 'r5', tool: 'shell' })
    s.deps.notifications.changed()
    await expect.poll(() => push.pushes.filter((p) => p.url === endpoint).length).toBe(1)
    expect((await send(s, 'POST', '/api/auth/logout', undefined, { cookie })).status).toBe(200)
    await s.deps.webPush.idle()
    expect(push.pushes.filter((p) => p.url === endpoint)).toHaveLength(1)
  })
})
